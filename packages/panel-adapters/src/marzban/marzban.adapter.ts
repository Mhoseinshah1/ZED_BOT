import { randomBytes } from "node:crypto";

import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import {
  deriveExpiry,
  deriveServiceStatus,
  deriveSubscriptionInfo,
  deriveTrafficUsage,
} from "../core/derived-reads.js";
import { bigintToSafeNumber, joinSubscriptionUrl } from "../core/http.js";
import type {
  AddServiceTimeInput,
  AddServiceTimeResult,
  AddServiceVolumeInput,
  AddServiceVolumeResult,
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  GetServiceAccountInput,
  GetServiceAccountResult,
  NormalizedAccountStatus,
  PanelCapability,
  PanelDiagnostic,
  PanelDiagnosticCode,
  PanelHealthResult,
  PanelOutcomeCertainty,
  ProvisioningReadinessInput,
  ProvisioningReadinessResult,
  ReadinessCheck,
  RegenerateSubscriptionInput,
  RegenerateSubscriptionResult,
  RenewServiceAccountInput,
  RenewServiceAccountResult,
  ServiceSubscriptionInfo,
  ServiceTrafficUsage,
  SetServiceStatusInput,
  SetServiceStatusResult,
} from "../core/panel.types.js";
import { MarzbanClient } from "./marzban.client.js";
import type { MarzbanUser, MarzbanUserResult } from "./marzban.types.js";

const RESET_STRATEGIES = new Set(["no_reset", "day", "week", "month", "year"]);

/**
 * Per-user secrets that must NOT be copied from a template user's proxies
 * (or from operator-pasted explicit settings): Marzban generates fresh ones
 * for every created user. Only reusable protocol configuration (flow,
 * method, ...) may pass through.
 */
const PER_USER_PROXY_SECRETS = new Set(["id", "password"]);

/** Marzban create/read/mutate surface is fully implemented and tested. */
export const MARZBAN_CAPABILITIES: readonly PanelCapability[] = [
  "authenticatedHealth",
  "createService",
  "readService",
  "renewService",
  "addVolume",
  "addTime",
  "toggleService",
  "regenerateSubscription",
  "reconciliation",
];

function resolveResetStrategy(input: CreateServiceAccountInput): string {
  const explicit = input.dataLimitResetStrategy?.toLowerCase();
  if (explicit !== undefined && RESET_STRATEGIES.has(explicit)) {
    return explicit;
  }
  const cycle = input.trafficResetCycle?.toLowerCase();
  if (cycle !== undefined && RESET_STRATEGIES.has(cycle)) {
    return cycle;
  }
  return "no_reset";
}

const STATUS_MAP: Record<string, NormalizedAccountStatus> = {
  active: "active",
  disabled: "disabled",
  limited: "limited",
  expired: "expired",
};

/** Marzban status string -> normalized status ("unknown" keeps caller state). */
function normalizeStatus(status: string | undefined): NormalizedAccountStatus {
  return STATUS_MAP[status?.toLowerCase() ?? ""] ?? "unknown";
}

/** Defensive timestamp parse; undefined when missing or unparseable. */
function parseTimestamp(value: string | null | undefined): Date | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nonNegativeBigInt(value: number): bigint {
  return BigInt(Math.max(0, Math.trunc(value)));
}

/** Fields shared by every result that reports back a Marzban user object. */
interface MarzbanAccountFields {
  username?: string;
  status?: NormalizedAccountStatus;
  usedBytes?: bigint;
  totalBytes?: bigint | null;
  remainingBytes?: bigint | null;
  expiresAt?: Date | null;
  subscriptionUrl?: string;
  subscriptionToken?: string;
  configLinks?: string[];
  lastConnectedAt?: Date | null;
}

/**
 * Extracts the subscription token from Marzban's documented subscription
 * path shape (`.../sub/<token>[/...]`). Conservative by design: any other
 * shape yields undefined - a token is never guessed (service-live-sync
 * phase; lets sync refresh the stored token alongside the URL).
 */
function subscriptionTokenFromUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url === "") {
    return undefined;
  }
  const match = /\/sub\/([^/?#]+)/.exec(url);
  return match === null || match[1] === "" ? undefined : match[1];
}

/**
 * Maps one Marzban user object onto the shared result fields. Missing panel
 * fields are OMITTED - callers must never treat missing as zero.
 */
function mapUserFields(user: MarzbanUser, subscriptionBase: string): MarzbanAccountFields {
  const result: MarzbanAccountFields = {
    username: user.username,
    status: normalizeStatus(user.status),
  };
  if (typeof user.used_traffic === "number") {
    result.usedBytes = nonNegativeBigInt(user.used_traffic);
  }
  if (user.data_limit !== undefined) {
    // 0/null = unlimited (explicit), >0 = the limit in bytes.
    result.totalBytes =
      typeof user.data_limit === "number" && user.data_limit > 0
        ? nonNegativeBigInt(user.data_limit)
        : null;
    if (result.totalBytes === null) {
      result.remainingBytes = null;
    } else {
      const used = result.usedBytes ?? 0n;
      result.remainingBytes = result.totalBytes > used ? result.totalBytes - used : 0n;
    }
  }
  if (user.expire !== undefined) {
    // 0/null = never expires (explicit).
    result.expiresAt =
      typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
  }
  const subscriptionUrl = joinSubscriptionUrl(subscriptionBase, user.subscription_url);
  if (subscriptionUrl !== undefined) {
    result.subscriptionUrl = subscriptionUrl;
    const token = subscriptionTokenFromUrl(user.subscription_url ?? subscriptionUrl);
    if (token !== undefined) {
      result.subscriptionToken = token;
    }
  }
  if (Array.isArray(user.links)) {
    const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
    if (links.length > 0) {
      result.configLinks = links;
    }
  }
  const lastConnected =
    parseTimestamp(user.online_at) ??
    parseTimestamp(user.last_online) ??
    parseTimestamp(user.last_connected_at);
  if (lastConnected !== undefined) {
    result.lastConnectedAt = lastConnected;
  }
  return result;
}

/** Strips per-user secrets from a proxies map, keeping reusable settings. */
function sanitizeProxies(
  proxies: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const clean: Record<string, Record<string, unknown>> = {};
  for (const [protocol, settings] of Object.entries(proxies)) {
    clean[protocol] = Object.fromEntries(
      Object.entries(settings ?? {}).filter(([key]) => !PER_USER_PROXY_SECRETS.has(key)),
    );
  }
  return clean;
}

type ExplicitProxyConfig = {
  proxies: Record<string, Record<string, unknown>>;
  inbounds: Record<string, string[]>;
};

/**
 * Parses the operator's explicit (template-free) proxy configuration from
 * the panel's protocolSettings JSON. Two shapes are accepted:
 *   1. { "proxies": { "vless": {...} }, "inbounds": { "vless": ["TAG"] } }
 *   2. a direct protocol map: { "vless": {...}, "vmess": {...} }
 * Returns null when nothing is configured; a string = validation error.
 * Per-user secrets (id/password) are stripped even if pasted by the admin.
 */
function parseExplicitProxyConfig(
  settings: Record<string, unknown> | null | undefined,
): ExplicitProxyConfig | string | null {
  if (settings === null || settings === undefined || Object.keys(settings).length === 0) {
    return null;
  }
  let rawProxies: unknown = settings;
  let rawInbounds: unknown = undefined;
  if ("proxies" in settings) {
    rawProxies = settings["proxies"];
    rawInbounds = settings["inbounds"];
  }
  if (typeof rawProxies !== "object" || rawProxies === null || Array.isArray(rawProxies)) {
    return "protocolSettings.proxies must be an object mapping protocol -> settings";
  }
  const proxies: Record<string, Record<string, unknown>> = {};
  for (const [protocol, value] of Object.entries(rawProxies as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `protocol "${protocol}" settings must be an object`;
    }
    proxies[protocol] = value as Record<string, unknown>;
  }
  if (Object.keys(proxies).length === 0) {
    return "protocolSettings contains no protocols";
  }
  const inbounds: Record<string, string[]> = {};
  if (rawInbounds !== undefined) {
    if (typeof rawInbounds !== "object" || rawInbounds === null || Array.isArray(rawInbounds)) {
      return "protocolSettings.inbounds must be an object mapping protocol -> tag list";
    }
    for (const [protocol, tags] of Object.entries(rawInbounds as Record<string, unknown>)) {
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
        return `inbounds for protocol "${protocol}" must be an array of tag strings`;
      }
      inbounds[protocol] = tags as string[];
    }
  }
  return { proxies: sanitizeProxies(proxies), inbounds };
}

/**
 * Marzban panel adapter: authenticated provisioning against the documented
 * Marzban API. Supports template-based provisioning (protocol/inbound
 * selection copied from an existing user with per-user secrets stripped) and
 * explicit template-free configuration via protocolSettings.
 */
export class MarzbanAdapter implements PanelAdapter {
  readonly name = "marzban" as const;
  readonly capabilities = MARZBAN_CAPABILITIES;

  constructor(readonly client: MarzbanClient) {}

  private diag(
    operation: string,
    code: PanelDiagnosticCode,
    extra: {
      endpointPath?: string;
      httpStatus?: number;
      detail?: string;
      retryable?: boolean;
      certainty?: PanelOutcomeCertainty;
    } = {},
  ): PanelDiagnostic {
    return {
      operation,
      panelType: "marzban",
      code,
      ...(extra.endpointPath !== undefined ? { endpointPath: extra.endpointPath } : {}),
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      retryable: extra.retryable ?? false,
      certainty: extra.certainty ?? "definite",
    };
  }

  /** Maps a failed client result to a transport/auth/panel diagnostic code. */
  private failureCode(result: MarzbanUserResult): PanelDiagnosticCode {
    if (result.timedOut === true) {
      return "timeout";
    }
    if (result.transportError === true) {
      return "unreachable";
    }
    if (result.malformedBody === true) {
      return "malformed-response";
    }
    if (result.status === 401 || result.status === 403) {
      return "auth-failed";
    }
    return "panel-rejected";
  }

  async testConnection(): Promise<PanelHealthResult> {
    return this.client.authenticate();
  }

  private subscriptionBase(subscriptionBaseUrl: string | null | undefined): string {
    return subscriptionBaseUrl !== null &&
      subscriptionBaseUrl !== undefined &&
      subscriptionBaseUrl !== ""
      ? subscriptionBaseUrl
      : this.client.baseUrl;
  }

  /**
   * Full authenticated readiness: token auth, user-endpoint readability
   * (probed with a random nonexistent username - a documented 404 proves
   * the endpoint is reachable AND authorized), and provisioning
   * configuration (readable template with proxies, or valid explicit
   * protocolSettings). Read-only; never mutates panel state.
   */
  async checkProvisioningReadiness(
    input: ProvisioningReadinessInput,
  ): Promise<ProvisioningReadinessResult> {
    const checks: ReadinessCheck[] = [];
    const done = (ready: boolean, diagnostic?: PanelDiagnostic): ProvisioningReadinessResult => ({
      ready,
      checks,
      capabilities: MARZBAN_CAPABILITIES,
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    });

    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      const authFailed = auth.status === 401 || auth.status === 403;
      checks.push({ key: "reachable", ok: authFailed ? true : false, detail: auth.message });
      checks.push({ key: "auth", ok: false, detail: auth.message });
      return done(
        false,
        this.diag("readiness", authFailed ? "auth-failed" : auth.timedOut === true ? "timeout" : "unreachable", {
          endpointPath: "/api/admin/token",
          httpStatus: auth.status,
          retryable: !authFailed,
        }),
      );
    }
    checks.push({ key: "reachable", ok: true });
    checks.push({ key: "auth", ok: true });

    // Probe the user endpoint with a random username that cannot exist: a
    // clean 404 proves read access; 401/403/transport failures do not.
    const probe = await this.client.getUser(auth.token, `zedbot_probe_${randomBytes(4).toString("hex")}`);
    const readable = probe.ok || probe.status === 404;
    checks.push({ key: "read-endpoint", ok: readable, ...(readable ? {} : { detail: probe.message }) });
    if (!readable) {
      return done(
        false,
        this.diag("readiness", this.failureCode(probe), {
          endpointPath: "/api/user/{username}",
          httpStatus: probe.status,
          retryable: probe.status === undefined,
        }),
      );
    }

    const templateUsername = input.templateUsername?.trim() ?? "";
    let templateOk: boolean | null = null;
    let templateDetail: string | undefined;
    if (templateUsername !== "") {
      const template = await this.client.getUser(auth.token, templateUsername);
      if (!template.ok || template.user === undefined) {
        templateOk = false;
        templateDetail = template.status === 404 ? "template user not found" : template.message;
      } else if (Object.keys(template.user.proxies ?? {}).length === 0) {
        templateOk = false;
        templateDetail = "template user has no proxies";
      } else {
        templateOk = true;
      }
    }
    checks.push({ key: "template", ok: templateOk, ...(templateDetail !== undefined ? { detail: templateDetail } : {}) });

    const explicit = parseExplicitProxyConfig(input.protocolSettings);
    const explicitOk = explicit !== null && typeof explicit !== "string";
    const configOk = templateOk === true || explicitOk;
    checks.push({
      key: "config",
      ok: configOk,
      detail: configOk
        ? templateOk === true
          ? "template-based provisioning"
          : "explicit protocol configuration"
        : typeof explicit === "string"
          ? explicit
          : templateOk === false
            ? "configured template is not usable"
            : "no template user and no explicit protocol settings configured",
    });
    if (!configOk) {
      return done(
        false,
        this.diag(
          "readiness",
          templateOk === false
            ? templateDetail === "template user not found"
              ? "template-not-found"
              : "template-invalid"
            : typeof explicit === "string"
              ? "config-invalid"
              : "config-incomplete",
        ),
      );
    }
    return done(true);
  }

  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<CreateServiceAccountResult> {
    const op = "create-service";
    const fail = (
      errorMessage: string,
      diagnostic: PanelDiagnostic,
      uncertain = false,
    ): CreateServiceAccountResult => ({
      ok: false,
      errorMessage,
      diagnostic,
      ...(uncertain ? { uncertain: true } : {}),
    });

    // Unlimited volume = 0 in the Marzban contract; a finite volume must fit
    // the JS safe-integer range or the payload would silently lose precision.
    let dataLimit = 0;
    if (input.volumeBytes !== null) {
      const safe = bigintToSafeNumber(input.volumeBytes);
      if (safe === null) {
        return fail(
          "Volume exceeds the safe integer range; refusing lossy conversion.",
          this.diag(op, "unsafe-volume"),
        );
      }
      dataLimit = safe;
    }

    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return fail(
        `Marzban authentication failed: ${auth.message}`,
        this.diag(op, auth.status === 401 || auth.status === 403 ? "auth-failed" : auth.timedOut === true ? "timeout" : "unreachable", {
          endpointPath: "/api/admin/token",
          httpStatus: auth.status,
          retryable: auth.status === undefined,
        }),
      );
    }

    // Resolve proxies/inbounds: template mode first, explicit config second.
    let proxies: Record<string, Record<string, unknown>>;
    let inbounds: Record<string, string[]>;
    const templateUsername = input.templateUsername?.trim() ?? "";
    if (templateUsername !== "") {
      const template = await this.client.getUser(auth.token, templateUsername);
      if (!template.ok || template.user === undefined) {
        const notFound = template.status === 404;
        return fail(
          `Marzban template user "${templateUsername}" is not readable: ${template.message}`,
          this.diag(op, notFound ? "template-not-found" : this.failureCode(template), {
            endpointPath: "/api/user/{username}",
            httpStatus: template.status,
            retryable: !notFound && template.status === undefined,
          }),
        );
      }
      const templateProxies = template.user.proxies ?? {};
      if (Object.keys(templateProxies).length === 0) {
        return fail(
          `Marzban template user "${templateUsername}" has no proxies configured.`,
          this.diag(op, "template-invalid"),
        );
      }
      // Copy protocol settings minus per-user secrets (proxy id/password,
      // i.e. UUIDs and Trojan/Shadowsocks passwords) - Marzban generates
      // fresh ones. Subscription tokens live outside proxies and are never
      // copied.
      proxies = sanitizeProxies(templateProxies);
      inbounds = template.user.inbounds ?? {};
    } else {
      const explicit = parseExplicitProxyConfig(input.protocolSettings);
      if (explicit === null) {
        return fail(
          "Marzban provisioning is not configured: set a template user or explicit protocol settings.",
          this.diag(op, "config-incomplete"),
        );
      }
      if (typeof explicit === "string") {
        return fail(
          `Marzban explicit protocol settings are invalid: ${explicit}`,
          this.diag(op, "config-invalid"),
        );
      }
      proxies = explicit.proxies;
      inbounds = explicit.inbounds;
    }

    const subscriptionBase = this.subscriptionBase(input.subscriptionBaseUrl);
    const toResult = (user: MarzbanUser): CreateServiceAccountResult => {
      const fields = mapUserFields(user, subscriptionBase);
      return {
        ok: true,
        username: user.username,
        ...(fields.subscriptionUrl !== undefined ? { subscriptionUrl: fields.subscriptionUrl } : {}),
        ...(fields.configLinks !== undefined ? { configLinks: fields.configLinks } : {}),
      };
    };

    const created = await this.client.createUser(auth.token, {
      username: input.username,
      proxies,
      inbounds,
      data_limit: dataLimit,
      data_limit_reset_strategy: resolveResetStrategy(input),
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      note: input.note ?? "",
    });
    if (created.ok && created.user !== undefined) {
      return toResult(created.user);
    }

    // 409 = username already exists. Usernames are deterministic per order,
    // so this normally means a previous attempt created the account and the
    // caller crashed before recording it. Verify the provisioning context
    // via the account note before adopting - an account carrying a DIFFERENT
    // order's note is never adopted.
    if (created.status === 409) {
      const existing = await this.client.getUser(auth.token, input.username);
      if (existing.ok && existing.user !== undefined) {
        const existingNote = typeof existing.user.note === "string" ? existing.user.note.trim() : "";
        const expectedNote = input.note?.trim() ?? "";
        if (existingNote !== "" && expectedNote !== "" && existingNote !== expectedNote) {
          return fail(
            "Marzban username conflict: an account with this username exists but belongs to a different context.",
            this.diag(op, "conflict", { endpointPath: "/api/user", httpStatus: 409 }),
          );
        }
        return toResult(existing.user);
      }
      // Exists but cannot be read back - outcome tied to remote state we
      // could not verify.
      return fail(
        `Marzban create returned 409 but the existing account is not readable: ${existing.message}`,
        this.diag(op, this.failureCode(existing), {
          endpointPath: "/api/user/{username}",
          httpStatus: existing.status,
          retryable: true,
          certainty: "unknown",
        }),
        true,
      );
    }

    // Transport failure / timeout / 5xx during CREATE: the request may have
    // landed. Probe the deterministic username read-only: found -> the
    // account exists (recover it). A 404 probe is proof of absence ONLY
    // when the panel actually RESPONDED to the create (5xx) - after a
    // timeout/transport error the hung request may still be in flight and
    // could land AFTER the probe, so the outcome stays UNKNOWN and
    // reconciliation re-checks once every in-flight window has passed.
    const maybeLanded =
      created.transportError === true || (created.status !== undefined && created.status >= 500);
    if (maybeLanded) {
      const probe = await this.client.getUser(auth.token, input.username);
      if (probe.ok && probe.user !== undefined) {
        return toResult(probe.user);
      }
      const panelResponded = created.status !== undefined;
      if (probe.status === 404 && panelResponded) {
        return fail(
          `Marzban create user failed: ${created.message}`,
          this.diag(op, this.failureCode(created), {
            endpointPath: "/api/user",
            httpStatus: created.status,
            retryable: true,
          }),
        );
      }
      return fail(
        `Marzban create user outcome is unknown: ${created.message}`,
        this.diag(op, created.timedOut === true ? "timeout" : this.failureCode(created), {
          endpointPath: "/api/user",
          httpStatus: created.status,
          retryable: true,
          certainty: "unknown",
        }),
        true,
      );
    }

    // The panel answered with a definite rejection (4xx) - nothing was created.
    return fail(
      `Marzban create user failed: ${created.message}`,
      this.diag(op, this.failureCode(created), {
        endpointPath: "/api/user",
        httpStatus: created.status,
      }),
    );
  }

  /** Read-only sync via the documented GET /api/user/{username} endpoint. */
  async getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    const op = "read-service";
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return {
        ok: false,
        errorMessage: `Marzban authentication failed: ${auth.message}`,
        diagnostic: this.diag(op, auth.status === 401 || auth.status === 403 ? "auth-failed" : auth.timedOut === true ? "timeout" : "unreachable", {
          endpointPath: "/api/admin/token",
          httpStatus: auth.status,
          retryable: auth.status === undefined,
        }),
      };
    }
    const fetched = await this.client.getUser(auth.token, input.username);
    if (!fetched.ok || fetched.user === undefined) {
      if (fetched.status === 404) {
        // Documented 404 = the panel positively confirmed the account does
        // not exist (distinct from "could not check" transport/auth errors).
        return {
          ok: false,
          notFound: true,
          errorMessage: "Panel account not found.",
          diagnostic: this.diag(op, "not-found", {
            endpointPath: "/api/user/{username}",
            httpStatus: 404,
          }),
        };
      }
      return {
        ok: false,
        errorMessage: `Marzban read user failed: ${fetched.message}`,
        diagnostic: this.diag(op, this.failureCode(fetched), {
          endpointPath: "/api/user/{username}",
          httpStatus: fetched.status,
          retryable: fetched.status === undefined,
        }),
      };
    }
    const fields = mapUserFields(fetched.user, this.subscriptionBase(input.subscriptionBaseUrl));
    return { ok: true, ...fields };
  }

  // --- unified sync surface (service-live-sync phase) -------------------------
  // One read path: every targeted accessor is a projection of the same
  // getServiceAccount snapshot via the shared derive* helpers.

  async syncService(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    return this.getServiceAccount(input);
  }

  async getServiceStatus(input: GetServiceAccountInput): Promise<NormalizedAccountStatus | null> {
    return deriveServiceStatus(await this.getServiceAccount(input));
  }

  async getTrafficUsage(input: GetServiceAccountInput): Promise<ServiceTrafficUsage | null> {
    return deriveTrafficUsage(await this.getServiceAccount(input));
  }

  async getExpiry(input: GetServiceAccountInput): Promise<Date | null> {
    return deriveExpiry(await this.getServiceAccount(input));
  }

  async getSubscriptionInfo(input: GetServiceAccountInput): Promise<ServiceSubscriptionInfo | null> {
    return deriveSubscriptionInfo(await this.getServiceAccount(input));
  }

  /**
   * Extra volume uses the exact same documented endpoints and semantics as
   * renewal - reset usage, then PUT the new data_limit while passing the
   * UNCHANGED expiry - so it delegates to renewServiceAccount.
   */
  async addServiceVolume(input: AddServiceVolumeInput): Promise<AddServiceVolumeResult> {
    return this.renewServiceAccount({
      username: input.username,
      totalBytes: input.totalBytes,
      expiresAt: input.expiresAt,
      note: input.note,
      subscriptionBaseUrl: input.subscriptionBaseUrl,
    });
  }

  /**
   * Extra time via documented endpoints: GET the user, then PUT the NEW
   * expire while sending data_limit and proxies/inbounds back UNCHANGED.
   * Usage is deliberately NOT reset (no /reset call) - extra time must never
   * wipe traffic accounting. Username never changes.
   */
  async addServiceTime(input: AddServiceTimeInput): Promise<AddServiceTimeResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const existing = await this.client.getUser(auth.token, input.username);
    if (!existing.ok || existing.user === undefined) {
      if (existing.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban read user failed: ${existing.message}` };
    }

    let dataLimit = 0;
    if (input.totalBytes !== null) {
      const safe = bigintToSafeNumber(input.totalBytes);
      if (safe === null) {
        return { ok: false, errorMessage: "Volume exceeds the safe integer range; refusing lossy conversion." };
      }
      dataLimit = safe;
    }
    const modified = await this.client.modifyUser(auth.token, input.username, {
      proxies: existing.user.proxies ?? {},
      inbounds: existing.user.inbounds ?? {},
      data_limit: dataLimit,
      expire: Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
    });
    if (!modified.ok || modified.user === undefined) {
      return { ok: false, errorMessage: `Marzban modify user failed: ${modified.message}` };
    }
    const fields = mapUserFields(modified.user, this.subscriptionBase(input.subscriptionBaseUrl));
    return { ok: true, ...fields };
  }

  /**
   * Enable/disable via documented endpoints: GET the user, then PUT ONLY a
   * new status ("active"/"disabled") while sending proxies, inbounds,
   * data_limit and expire back UNCHANGED. Usage is deliberately NOT reset
   * and the username never changes - a toggle must never touch quota,
   * expiry or traffic accounting.
   */
  async setServiceStatus(input: SetServiceStatusInput): Promise<SetServiceStatusResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const existing = await this.client.getUser(auth.token, input.username);
    if (!existing.ok || existing.user === undefined) {
      if (existing.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban read user failed: ${existing.message}` };
    }

    const modified = await this.client.modifyUser(auth.token, input.username, {
      proxies: existing.user.proxies ?? {},
      inbounds: existing.user.inbounds ?? {},
      data_limit: typeof existing.user.data_limit === "number" ? existing.user.data_limit : 0,
      expire: typeof existing.user.expire === "number" ? existing.user.expire : 0,
      status: input.enabled ? "active" : "disabled",
    });
    if (!modified.ok || modified.user === undefined) {
      return { ok: false, errorMessage: `Marzban modify user failed: ${modified.message}` };
    }
    const fields = mapUserFields(modified.user, this.subscriptionBase(input.subscriptionBaseUrl));
    return { ok: true, ...fields };
  }

  /**
   * Subscription regeneration via the documented
   * POST /api/user/{username}/revoke_sub endpoint: Marzban revokes the
   * subscription (old link/tokens stop working) and returns the user with
   * the NEW subscription_url/links. Nothing else is sent - no PUT, no
   * reset, no rename - so quota, expiry and usage stay untouched.
   */
  async regenerateSubscription(
    input: RegenerateSubscriptionInput,
  ): Promise<RegenerateSubscriptionResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const revoked = await this.client.revokeUserSubscription(auth.token, input.username);
    if (!revoked.ok || revoked.user === undefined) {
      if (revoked.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban revoke subscription failed: ${revoked.message}` };
    }
    const fields = mapUserFields(revoked.user, this.subscriptionBase(input.subscriptionBaseUrl));
    return { ok: true, ...fields };
  }

  /**
   * Renewal via documented endpoints: usage is reset first
   * (POST /api/user/{username}/reset), then the new limits land with
   * PUT /api/user/{username} (data_limit, expire, status active). The
   * existing proxies/inbounds are sent back unchanged and the username is
   * never touched. If the reset succeeds but the PUT fails, nothing was
   * upgraded (the caller fails the order and refunds) - the account merely
   * has zeroed usage, which is logged upstream, never charged.
   */
  async renewServiceAccount(input: RenewServiceAccountInput): Promise<RenewServiceAccountResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const existing = await this.client.getUser(auth.token, input.username);
    if (!existing.ok || existing.user === undefined) {
      if (existing.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban read user failed: ${existing.message}` };
    }

    let dataLimit = 0;
    if (input.totalBytes !== null) {
      const safe = bigintToSafeNumber(input.totalBytes);
      if (safe === null) {
        return { ok: false, errorMessage: "Volume exceeds the safe integer range; refusing lossy conversion." };
      }
      dataLimit = safe;
    }

    const reset = await this.client.resetUserUsage(auth.token, input.username);
    if (!reset.ok) {
      return { ok: false, errorMessage: `Marzban usage reset failed: ${reset.message}` };
    }

    const modified = await this.client.modifyUser(auth.token, input.username, {
      proxies: existing.user.proxies ?? {},
      inbounds: existing.user.inbounds ?? {},
      data_limit: dataLimit,
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
    });
    if (!modified.ok || modified.user === undefined) {
      return { ok: false, errorMessage: `Marzban modify user failed: ${modified.message}` };
    }
    const fields = mapUserFields(modified.user, this.subscriptionBase(input.subscriptionBaseUrl));
    return { ok: true, ...fields };
  }
}
