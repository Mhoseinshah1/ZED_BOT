import type { PanelAdapter } from "../core/panel-adapter.interface.js";
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
  PanelHealthResult,
  RegenerateSubscriptionInput,
  RegenerateSubscriptionResult,
  RenewServiceAccountInput,
  RenewServiceAccountResult,
  SetServiceStatusInput,
  SetServiceStatusResult,
} from "../core/panel.types.js";
import { MarzbanClient } from "./marzban.client.js";
import type { MarzbanUser } from "./marzban.types.js";

const RESET_STRATEGIES = new Set(["no_reset", "day", "week", "month", "year"]);

/** Per-user secrets that must NOT be copied from a template user's proxies. */
const PER_USER_PROXY_SECRETS = new Set(["id", "password"]);

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

/** Absolutizes Marzban's (often relative) subscription_url. */
function resolveSubscriptionUrl(url: string | undefined, base: string): string | undefined {
  if (url === undefined || url === "") {
    return undefined;
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${base.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
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

function toResult(user: MarzbanUser, subscriptionBase: string): CreateServiceAccountResult {
  const links = Array.isArray(user.links)
    ? user.links.filter((l): l is string => typeof l === "string" && l !== "")
    : [];
  return {
    ok: true,
    username: user.username,
    subscriptionUrl: resolveSubscriptionUrl(user.subscription_url, subscriptionBase),
    ...(links.length > 0 ? { configLinks: links } : {}),
  };
}

/**
 * Marzban panel adapter. Phase 4: connection testing. Phase 9: minimal user
 * creation via the documented POST /api/user endpoint, copying protocol/
 * inbound selection from a configured template user (per-user secrets like
 * proxy id/password are stripped so Marzban generates fresh ones).
 */
export class MarzbanAdapter implements PanelAdapter {
  readonly name = "marzban" as const;

  constructor(readonly client: MarzbanClient) {}

  async testConnection(): Promise<PanelHealthResult> {
    return this.client.authenticate();
  }

  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<CreateServiceAccountResult> {
    const templateUsername = input.templateUsername?.trim() ?? "";
    if (templateUsername === "") {
      // Proxies/inbounds must come from operator configuration - never guessed.
      return { ok: false, errorMessage: "Marzban template/inbound settings are not configured." };
    }

    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }

    const template = await this.client.getUser(auth.token, templateUsername);
    if (!template.ok || template.user === undefined) {
      return {
        ok: false,
        errorMessage: `Marzban template user "${templateUsername}" is not readable: ${template.message}`,
      };
    }
    const templateProxies = template.user.proxies ?? {};
    const protocols = Object.keys(templateProxies);
    if (protocols.length === 0) {
      return {
        ok: false,
        errorMessage: `Marzban template user "${templateUsername}" has no proxies configured.`,
      };
    }
    // Copy protocol settings minus per-user secrets; Marzban generates new ones.
    const proxies: Record<string, Record<string, unknown>> = {};
    for (const protocol of protocols) {
      const settings = templateProxies[protocol] ?? {};
      proxies[protocol] = Object.fromEntries(
        Object.entries(settings).filter(([key]) => !PER_USER_PROXY_SECRETS.has(key)),
      );
    }

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;

    const created = await this.client.createUser(auth.token, {
      username: input.username,
      proxies,
      inbounds: template.user.inbounds ?? {},
      data_limit: input.volumeBytes === null ? 0 : Number(input.volumeBytes),
      data_limit_reset_strategy: resolveResetStrategy(input),
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      note: input.note ?? "",
    });
    if (created.ok && created.user !== undefined) {
      return toResult(created.user, subscriptionBase);
    }

    // 409 = username already exists. Usernames are deterministic per order,
    // so this means a previous attempt created the account but the caller
    // crashed before recording it - recover it instead of failing.
    if (created.status === 409) {
      const existing = await this.client.getUser(auth.token, input.username);
      if (existing.ok && existing.user !== undefined) {
        return toResult(existing.user, subscriptionBase);
      }
    }

    return { ok: false, errorMessage: `Marzban create user failed: ${created.message}` };
  }

  /** Read-only sync via the documented GET /api/user/{username} endpoint. */
  async getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    const auth = await this.client.getToken();
    if (!auth.ok || auth.token === undefined) {
      return { ok: false, errorMessage: `Marzban authentication failed: ${auth.message}` };
    }
    const fetched = await this.client.getUser(auth.token, input.username);
    if (!fetched.ok || fetched.user === undefined) {
      if (fetched.status === 404) {
        return { ok: false, errorMessage: "Panel account not found." };
      }
      return { ok: false, errorMessage: `Marzban read user failed: ${fetched.message}` };
    }
    const user = fetched.user;

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;

    // Every optional field is mapped defensively - missing panel fields are
    // OMITTED, never coerced to zero.
    const result: GetServiceAccountResult = {
      ok: true,
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
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
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

  /**
   * Extra volume (Phase 16) uses the exact same documented endpoints and
   * semantics as renewal - reset usage, then PUT the new data_limit while
   * passing the UNCHANGED expiry - so it delegates to renewServiceAccount.
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
   * Extra time (Phase 17) via documented endpoints: GET the user, then PUT
   * the NEW expire while sending data_limit and proxies/inbounds back
   * UNCHANGED. Usage is deliberately NOT reset (no /reset call) - extra
   * time must never wipe traffic accounting. Username never changes.
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

    const modified = await this.client.modifyUser(auth.token, input.username, {
      proxies: existing.user.proxies ?? {},
      inbounds: existing.user.inbounds ?? {},
      data_limit: input.totalBytes === null ? 0 : Number(input.totalBytes),
      expire: Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
    });
    if (!modified.ok || modified.user === undefined) {
      return { ok: false, errorMessage: `Marzban modify user failed: ${modified.message}` };
    }

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;
    const user = modified.user;
    const result: AddServiceTimeResult = {
      ok: true,
      username: user.username,
      status: normalizeStatus(user.status),
    };
    if (typeof user.used_traffic === "number") {
      result.usedBytes = nonNegativeBigInt(user.used_traffic);
    }
    if (user.data_limit !== undefined) {
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
      result.expiresAt =
        typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
    }
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
    }
    if (Array.isArray(user.links)) {
      const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
      if (links.length > 0) {
        result.configLinks = links;
      }
    }
    return result;
  }

  /**
   * Enable/disable (Phase 18) via documented endpoints: GET the user, then
   * PUT ONLY a new status ("active"/"disabled") while sending proxies,
   * inbounds, data_limit and expire back UNCHANGED. Usage is deliberately
   * NOT reset (no /reset call) and the username never changes - a toggle
   * must never touch quota, expiry or traffic accounting.
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

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;
    const user = modified.user;
    const result: SetServiceStatusResult = {
      ok: true,
      username: user.username,
      status: normalizeStatus(user.status),
    };
    if (typeof user.used_traffic === "number") {
      result.usedBytes = nonNegativeBigInt(user.used_traffic);
    }
    if (user.data_limit !== undefined) {
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
      result.expiresAt =
        typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
    }
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
    }
    if (Array.isArray(user.links)) {
      const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
      if (links.length > 0) {
        result.configLinks = links;
      }
    }
    return result;
  }

  /**
   * Subscription regeneration (Phase 19) via the documented
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

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;
    const user = revoked.user;
    const result: RegenerateSubscriptionResult = {
      ok: true,
      username: user.username,
      status: normalizeStatus(user.status),
    };
    if (typeof user.used_traffic === "number") {
      result.usedBytes = nonNegativeBigInt(user.used_traffic);
    }
    if (user.data_limit !== undefined) {
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
      result.expiresAt =
        typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
    }
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
    }
    if (Array.isArray(user.links)) {
      const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
      if (links.length > 0) {
        result.configLinks = links;
      }
    }
    return result;
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

    const reset = await this.client.resetUserUsage(auth.token, input.username);
    if (!reset.ok) {
      return { ok: false, errorMessage: `Marzban usage reset failed: ${reset.message}` };
    }

    const modified = await this.client.modifyUser(auth.token, input.username, {
      proxies: existing.user.proxies ?? {},
      inbounds: existing.user.inbounds ?? {},
      data_limit: input.totalBytes === null ? 0 : Number(input.totalBytes),
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      status: "active",
      ...(input.note !== null && input.note !== undefined ? { note: input.note } : {}),
    });
    if (!modified.ok || modified.user === undefined) {
      return { ok: false, errorMessage: `Marzban modify user failed: ${modified.message}` };
    }

    const subscriptionBase =
      input.subscriptionBaseUrl !== null &&
      input.subscriptionBaseUrl !== undefined &&
      input.subscriptionBaseUrl !== ""
        ? input.subscriptionBaseUrl
        : this.client.credentials.baseUrl;
    const user = modified.user;
    const result: RenewServiceAccountResult = {
      ok: true,
      username: user.username,
      status: normalizeStatus(user.status),
    };
    if (typeof user.used_traffic === "number") {
      result.usedBytes = nonNegativeBigInt(user.used_traffic);
    }
    if (user.data_limit !== undefined) {
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
      result.expiresAt =
        typeof user.expire === "number" && user.expire > 0 ? new Date(user.expire * 1000) : null;
    }
    const subscriptionUrl = resolveSubscriptionUrl(user.subscription_url, subscriptionBase);
    if (subscriptionUrl !== undefined) {
      result.subscriptionUrl = subscriptionUrl;
    }
    if (Array.isArray(user.links)) {
      const links = user.links.filter((l): l is string => typeof l === "string" && l !== "");
      if (links.length > 0) {
        result.configLinks = links;
      }
    }
    return result;
  }
}
