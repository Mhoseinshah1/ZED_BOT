import { randomBytes, randomUUID } from "node:crypto";

import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import { bigintToSafeNumber, normalizeBaseUrl } from "../core/http.js";
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
  SetServiceStatusInput,
  SetServiceStatusResult,
} from "../core/panel.types.js";
import { XuiClient } from "./xui.client.js";
import type {
  XuiClientEntry,
  XuiClientStat,
  XuiInbound,
  XuiLoginResult,
  XuiRequestResult,
} from "./xui.types.js";

/**
 * Implemented and tested XUI surface: authenticated health, client creation
 * and read/reconciliation. Renewal, extras, toggle and subscription
 * regeneration are NOT implemented - the capability model blocks them before
 * payment; the methods below still fail safely if reached.
 */
export const XUI_CAPABILITIES: readonly PanelCapability[] = [
  "authenticatedHealth",
  "createService",
  "readService",
  "reconciliation",
];

/** Protocols this adapter can provision clients into. */
const SUPPORTED_PROTOCOLS = new Set(["vless", "vmess", "trojan"]);

/**
 * Deterministic client label per (service username, inbound). 3x-ui enforces
 * panel-wide unique client "emails", so multi-inbound provisioning needs a
 * distinct label per inbound; the shared username prefix keeps every client
 * of one service discoverable, and the shared subId groups them into one
 * subscription.
 */
function clientEmail(username: string, inboundId: number): string {
  return `${username}-${inboundId}`;
}

/** Parsed view of one inbound relevant for provisioning. */
interface ParsedInbound {
  inbound: XuiInbound;
  protocol: string;
  clients: XuiClientEntry[];
}

/**
 * Parses the JSON string stored in an inbound's settings field. XUI stores
 * client lists as JSON-encoded text inside a JSON document - malformed
 * content must surface as a structured error, never as a crash.
 */
function parseInboundSettings(inbound: XuiInbound): ParsedInbound | string {
  const protocol = (inbound.protocol ?? "").toLowerCase();
  let parsed: unknown;
  try {
    parsed = JSON.parse(inbound.settings ?? "");
  } catch {
    return `inbound ${inbound.id} has malformed settings JSON`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `inbound ${inbound.id} settings are not a JSON object`;
  }
  const clientsRaw = (parsed as { clients?: unknown }).clients;
  const clients = Array.isArray(clientsRaw)
    ? clientsRaw.filter(
        (c): c is XuiClientEntry => typeof c === "object" && c !== null && !Array.isArray(c),
      )
    : [];
  return { inbound, protocol, clients };
}

/** The credential identifier 3x-ui uses to address a client (delClient etc.). */
function clientIdentifier(client: XuiClientEntry): string | undefined {
  if (typeof client.id === "string" && client.id !== "") {
    return client.id;
  }
  if (typeof client.password === "string" && client.password !== "") {
    return client.password;
  }
  return undefined;
}

/**
 * XUI / Sanaei 3X-UI panel adapter (SANAEI variant). Session-cookie
 * authenticated; provisions one secure client identity per configured
 * inbound. Never logs cookies, passwords or client UUIDs.
 */
export class XuiAdapter implements PanelAdapter {
  readonly name = "xui" as const;
  readonly capabilities = XUI_CAPABILITIES;

  constructor(readonly client: XuiClient) {}

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
      panelType: "xui",
      code,
      ...(extra.endpointPath !== undefined ? { endpointPath: extra.endpointPath } : {}),
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      retryable: extra.retryable ?? false,
      certainty: extra.certainty ?? "definite",
    };
  }

  private loginFailureCode(login: XuiLoginResult): PanelDiagnosticCode {
    if (login.timedOut === true) {
      return "timeout";
    }
    if (login.transportError === true) {
      return "unreachable";
    }
    if (login.malformedBody === true || login.status === 404) {
      return "unsupported-variant";
    }
    return "auth-failed";
  }

  private requestFailureCode(result: XuiRequestResult): PanelDiagnosticCode {
    if (result.timedOut === true) {
      return "timeout";
    }
    if (result.transportError === true) {
      return "unreachable";
    }
    if (result.malformedBody === true || result.status === 404) {
      return "unsupported-variant";
    }
    if (result.status !== undefined && result.status >= 300 && result.status < 400) {
      return "auth-failed";
    }
    return "panel-rejected";
  }

  /** Real authenticated connection test (no more reachability-only probing). */
  async testConnection(): Promise<PanelHealthResult> {
    const login = await this.client.login();
    if (!login.ok) {
      return { ok: false, message: login.message };
    }
    return { ok: true, message: "Authentication succeeded." };
  }

  /** Fetches and minimally validates the inbound list. */
  private async fetchInbounds(
    cookie: string,
  ): Promise<{ ok: true; inbounds: XuiInbound[] } | { ok: false; result: XuiRequestResult }> {
    const list = await this.client.listInbounds(cookie);
    if (!list.ok) {
      return { ok: false, result: list };
    }
    const obj = list.envelope?.obj;
    if (!Array.isArray(obj)) {
      return {
        ok: false,
        result: { ...list, ok: false, malformedBody: true, message: "Inbound list has an unexpected shape." },
      };
    }
    const inbounds = obj.filter(
      (i): i is XuiInbound =>
        typeof i === "object" && i !== null && typeof (i as { id?: unknown }).id === "number",
    );
    return { ok: true, inbounds };
  }

  /**
   * Full authenticated readiness: login, inbound-list access, and validation
   * of every configured inbound id (exists, enabled, supported protocol,
   * parseable settings). A reachable login page is NOT readiness; neither is
   * a successful login alone.
   */
  async checkProvisioningReadiness(
    input: ProvisioningReadinessInput,
  ): Promise<ProvisioningReadinessResult> {
    const checks: ReadinessCheck[] = [];
    const done = (ready: boolean, diagnostic?: PanelDiagnostic): ProvisioningReadinessResult => ({
      ready,
      checks,
      capabilities: XUI_CAPABILITIES,
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    });

    const login = await this.client.login();
    if (!login.ok) {
      const code = this.loginFailureCode(login);
      checks.push({
        key: "reachable",
        ok: code === "timeout" || code === "unreachable" ? false : true,
        detail: login.message,
      });
      checks.push({ key: "auth", ok: false, detail: login.message });
      return done(
        false,
        this.diag("readiness", code, {
          endpointPath: "/login",
          httpStatus: login.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      );
    }
    checks.push({ key: "reachable", ok: true });
    checks.push({ key: "auth", ok: true });

    const listed = await this.fetchInbounds(login.cookie ?? "");
    if (!listed.ok) {
      checks.push({ key: "read-endpoint", ok: false, detail: listed.result.message });
      return done(
        false,
        this.diag("readiness", this.requestFailureCode(listed.result), {
          endpointPath: "/panel/api/inbounds/list",
          httpStatus: listed.result.status,
          retryable: listed.result.transportError === true,
        }),
      );
    }
    checks.push({ key: "read-endpoint", ok: true });

    const inboundIds = (input.inboundIds ?? []).filter((id) => Number.isInteger(id));
    if (inboundIds.length === 0) {
      checks.push({ key: "config", ok: false, detail: "no inbound ids configured" });
      checks.push({ key: "inbounds", ok: null });
      return done(false, this.diag("readiness", "config-incomplete"));
    }
    checks.push({ key: "config", ok: true });

    const byId = new Map(listed.inbounds.map((i) => [i.id, i]));
    for (const id of inboundIds) {
      const inbound = byId.get(id);
      const problem = this.validateInbound(inbound, id);
      if (problem !== null) {
        checks.push({ key: "inbounds", ok: false, detail: problem.detail });
        return done(false, this.diag("readiness", problem.code, { detail: problem.detail }));
      }
    }
    checks.push({
      key: "inbounds",
      ok: true,
      detail: `inbounds ${inboundIds.join(", ")} valid`,
    });
    return done(true);
  }

  /** Validates one configured inbound; null = usable for provisioning. */
  private validateInbound(
    inbound: XuiInbound | undefined,
    id: number,
  ): { code: PanelDiagnosticCode; detail: string } | null {
    if (inbound === undefined) {
      return { code: "inbound-missing", detail: `inbound ${id} does not exist on the panel` };
    }
    if (inbound.enable === false) {
      return { code: "inbound-disabled", detail: `inbound ${id} is disabled` };
    }
    const protocol = (inbound.protocol ?? "").toLowerCase();
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      return {
        code: "unsupported-protocol",
        detail: `inbound ${id} protocol "${protocol}" is not supported (vless/vmess/trojan only)`,
      };
    }
    const parsed = parseInboundSettings(inbound);
    if (typeof parsed === "string") {
      return { code: "inbound-malformed", detail: parsed };
    }
    return null;
  }

  private subscriptionUrlFor(
    subscriptionBaseUrl: string | null | undefined,
    subId: string,
  ): string | undefined {
    // XUI's API does not report a subscription URL; one is returned ONLY
    // when the operator explicitly configured the subscription base (the
    // 3x-ui subscription service URL). Nothing is fabricated.
    if (subscriptionBaseUrl === null || subscriptionBaseUrl === undefined || subscriptionBaseUrl === "") {
      return undefined;
    }
    return `${normalizeBaseUrl(subscriptionBaseUrl)}/${encodeURIComponent(subId)}`;
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

    const inboundIds = (input.inboundIds ?? []).filter((id) => Number.isInteger(id));
    if (inboundIds.length === 0) {
      return fail(
        "XUI inbound ids are not configured.",
        this.diag(op, "config-incomplete"),
      );
    }

    // totalGB is bytes in the 3x-ui contract; 0 = unlimited. Refuse lossy
    // bigint conversion instead of silently corrupting the quota.
    let totalBytes = 0;
    if (input.volumeBytes !== null) {
      const safe = bigintToSafeNumber(input.volumeBytes);
      if (safe === null) {
        return fail(
          "Volume exceeds the safe integer range; refusing lossy conversion.",
          this.diag(op, "unsafe-volume"),
        );
      }
      totalBytes = safe;
    }
    const expiryTime = input.expiresAt === null ? 0 : input.expiresAt.getTime();
    const subId = input.username;

    const login = await this.client.login();
    if (!login.ok || login.cookie === undefined) {
      const code = this.loginFailureCode(login);
      return fail(
        `XUI authentication failed: ${login.message}`,
        this.diag(op, code, {
          endpointPath: "/login",
          httpStatus: login.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      );
    }
    const cookie = login.cookie;

    const listed = await this.fetchInbounds(cookie);
    if (!listed.ok) {
      return fail(
        `XUI inbound list failed: ${listed.result.message}`,
        this.diag(op, this.requestFailureCode(listed.result), {
          endpointPath: "/panel/api/inbounds/list",
          httpStatus: listed.result.status,
          retryable: listed.result.transportError === true,
        }),
      );
    }
    const byId = new Map(listed.inbounds.map((i) => [i.id, i]));

    // Validate every configured inbound BEFORE any mutation.
    const targets: Array<{ id: number; parsed: ParsedInbound; email: string }> = [];
    for (const id of inboundIds) {
      const problem = this.validateInbound(byId.get(id), id);
      if (problem !== null) {
        return fail(`XUI ${problem.detail}.`, this.diag(op, problem.code, { detail: problem.detail }));
      }
      const parsed = parseInboundSettings(byId.get(id) as XuiInbound) as ParsedInbound;
      targets.push({ id, parsed, email: clientEmail(input.username, id) });
    }

    // Idempotency: recover clients a previous attempt already created. A
    // client with our deterministic email but a FOREIGN subId is a conflict,
    // never adopted and never recreated.
    const flowSetting =
      typeof input.protocolSettings?.["flow"] === "string"
        ? (input.protocolSettings["flow"] as string)
        : undefined;
    const finalClients: Array<{ inboundId: number; email: string; identifier: string }> = [];
    const toCreate: Array<{ inboundId: number; email: string; protocol: string; client: Record<string, unknown>; identifier: string }> = [];
    for (const target of targets) {
      const existing = target.parsed.clients.find((c) => c.email === target.email);
      if (existing !== undefined) {
        if (typeof existing.subId === "string" && existing.subId !== "" && existing.subId !== subId) {
          return fail(
            `XUI inbound ${target.id} already has a client with this label but a different subscription id.`,
            this.diag(op, "conflict", { detail: `inbound ${target.id} client label conflict` }),
          );
        }
        const identifier = clientIdentifier(existing);
        if (identifier === undefined) {
          return fail(
            `XUI inbound ${target.id} has a conflicting client entry without a usable identifier.`,
            this.diag(op, "conflict", { detail: `inbound ${target.id} client entry malformed` }),
          );
        }
        finalClients.push({ inboundId: target.id, email: target.email, identifier });
        continue;
      }
      // Fresh cryptographically-secure per-service identity - never copied
      // from any other client.
      const protocol = target.parsed.protocol;
      const base: Record<string, unknown> = {
        email: target.email,
        limitIp: 0,
        totalGB: totalBytes,
        expiryTime,
        enable: true,
        tgId: "",
        subId,
        reset: 0,
      };
      let identifier: string;
      if (protocol === "trojan") {
        identifier = randomBytes(16).toString("hex");
        base["password"] = identifier;
      } else {
        identifier = randomUUID();
        base["id"] = identifier;
        if (protocol === "vless") {
          // Flow only when explicitly configured - it must match the
          // inbound's security settings and is never guessed.
          base["flow"] = flowSetting ?? "";
        }
      }
      toCreate.push({ inboundId: target.id, email: target.email, protocol, client: base, identifier });
    }

    // Add the missing clients one inbound at a time.
    const createdThisCall: Array<{ inboundId: number; email: string; identifier: string }> = [];
    for (const entry of toCreate) {
      const added = await this.client.addClient(cookie, entry.inboundId, entry.client);
      if (added.ok) {
        createdThisCall.push({ inboundId: entry.inboundId, email: entry.email, identifier: entry.identifier });
        finalClients.push({ inboundId: entry.inboundId, email: entry.email, identifier: entry.identifier });
        continue;
      }
      // Failure mid-plan. A timeout/transport error may still have landed
      // on the panel, so that attempt is part of the cleanup set too.
      const maybeLanded = added.transportError === true;
      const cleanupSet = [...createdThisCall, ...(maybeLanded ? [entry] : [])];
      const cleanedUp = await this.cleanupCreatedClients(cookie, cleanupSet, inboundIds, input.username);
      // Definite failure requires BOTH a confirmed-clean re-read AND a real
      // panel response for the failed call: after a timeout the hung
      // request may still be in flight and could land AFTER the
      // verification read, so no immediate read can prove absence.
      if (cleanedUp && !maybeLanded) {
        return fail(
          `XUI add client failed on inbound ${entry.inboundId}: ${added.message} (compensating cleanup confirmed).`,
          this.diag(op, this.requestFailureCode(added), {
            endpointPath: "/panel/api/inbounds/addClient",
            httpStatus: added.status,
            retryable: true,
          }),
        );
      }
      return fail(
        `XUI add client failed on inbound ${entry.inboundId}: ${added.message}; compensating cleanup could NOT be confirmed - remote state is partial/unknown.`,
        this.diag(op, "partial-state", {
          endpointPath: "/panel/api/inbounds/addClient",
          httpStatus: added.status,
          retryable: true,
          certainty: "unknown",
        }),
        true,
      );
    }

    const primary = finalClients.find((c) => c.inboundId === inboundIds[0]) ?? finalClients[0];
    const subscriptionUrl = this.subscriptionUrlFor(input.subscriptionBaseUrl, subId);
    return {
      ok: true,
      username: input.username,
      ...(subscriptionUrl !== undefined ? { subscriptionUrl } : {}),
      subscriptionToken: subId,
      remoteClientId: primary.identifier,
      remoteInboundIds: finalClients.map((c) => c.inboundId),
      remoteMetadata: {
        subId,
        clients: finalClients.map((c) => ({ inboundId: c.inboundId, email: c.email })),
      },
    };
  }

  /**
   * Bounded compensating cleanup: deletes the clients created during THIS
   * call, then re-reads the inbound list to verify none of this service's
   * client labels remain. Returns true ONLY when the panel positively shows
   * a clean state - anything unverifiable returns false and the caller
   * reports an UNKNOWN/partial outcome for reconciliation.
   */
  private async cleanupCreatedClients(
    cookie: string,
    created: Array<{ inboundId: number; email: string; identifier: string }>,
    configuredInboundIds: number[],
    username: string,
  ): Promise<boolean> {
    for (const entry of created) {
      // Best-effort delete; the verification read below is authoritative.
      await this.client.deleteClient(cookie, entry.inboundId, entry.identifier);
    }
    const listed = await this.fetchInbounds(cookie);
    if (!listed.ok) {
      return false;
    }
    for (const id of configuredInboundIds) {
      const inbound = listed.inbounds.find((i) => i.id === id);
      if (inbound === undefined) {
        return false;
      }
      const parsed = parseInboundSettings(inbound);
      if (typeof parsed === "string") {
        return false;
      }
      const email = clientEmail(username, id);
      if (parsed.clients.some((c) => c.email === email)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Read-only reconciliation/sync: finds every client of this service across
   * ALL panel inbounds (deterministic label prefix), aggregates traffic from
   * the panel's client stats. notFound is set ONLY when the full inbound
   * inventory was readable and parseable and no client matched - "could not
   * check" is never reported as "does not exist".
   */
  async getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    const op = "read-service";
    const login = await this.client.login();
    if (!login.ok || login.cookie === undefined) {
      const code = this.loginFailureCode(login);
      return {
        ok: false,
        errorMessage: `XUI authentication failed: ${login.message}`,
        diagnostic: this.diag(op, code, {
          endpointPath: "/login",
          httpStatus: login.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      };
    }
    const listed = await this.fetchInbounds(login.cookie);
    if (!listed.ok) {
      return {
        ok: false,
        errorMessage: `XUI inbound list failed: ${listed.result.message}`,
        diagnostic: this.diag(op, this.requestFailureCode(listed.result), {
          endpointPath: "/panel/api/inbounds/list",
          httpStatus: listed.result.status,
          retryable: listed.result.transportError === true,
        }),
      };
    }

    const matches: Array<{ inboundId: number; client: XuiClientEntry; stat?: XuiClientStat }> = [];
    let fullyParsed = true;
    const isOurs = (email: unknown): boolean =>
      typeof email === "string" &&
      (email === input.username || email.startsWith(`${input.username}-`));
    for (const inbound of listed.inbounds) {
      const parsed = parseInboundSettings(inbound);
      if (typeof parsed === "string") {
        // An unreadable inbound removes the proof of absence.
        fullyParsed = false;
        continue;
      }
      const stats = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
      for (const client of parsed.clients) {
        if (isOurs(client.email)) {
          matches.push({
            inboundId: inbound.id,
            client,
            stat: stats.find((s) => s.email === client.email),
          });
        }
      }
    }

    if (matches.length === 0) {
      if (!fullyParsed) {
        return {
          ok: false,
          errorMessage:
            "XUI account not visible, but some inbound settings were unreadable - absence cannot be proven.",
          diagnostic: this.diag(op, "inbound-malformed", { retryable: false }),
        };
      }
      return {
        ok: false,
        notFound: true,
        errorMessage: "Panel client not found.",
        diagnostic: this.diag(op, "not-found", { endpointPath: "/panel/api/inbounds/list" }),
      };
    }

    const first = matches[0];
    const result: GetServiceAccountResult = { ok: true, username: input.username };

    // Quota semantics: the same limit is written to every inbound's client,
    // so the first client's configuration is authoritative. 0 = unlimited.
    const totalRaw = typeof first.client.totalGB === "number" ? first.client.totalGB : undefined;
    if (totalRaw !== undefined) {
      result.totalBytes = totalRaw > 0 ? BigInt(Math.trunc(totalRaw)) : null;
    }
    let used = 0n;
    let sawStat = false;
    for (const match of matches) {
      if (match.stat !== undefined) {
        sawStat = true;
        const up = typeof match.stat.up === "number" ? match.stat.up : 0;
        const down = typeof match.stat.down === "number" ? match.stat.down : 0;
        used += BigInt(Math.max(0, Math.trunc(up))) + BigInt(Math.max(0, Math.trunc(down)));
      }
    }
    if (sawStat) {
      result.usedBytes = used;
    }
    if (result.totalBytes !== undefined) {
      result.remainingBytes =
        result.totalBytes === null
          ? null
          : result.totalBytes > (result.usedBytes ?? 0n)
            ? result.totalBytes - (result.usedBytes ?? 0n)
            : 0n;
    }
    const expiryRaw = typeof first.client.expiryTime === "number" ? first.client.expiryTime : undefined;
    if (expiryRaw !== undefined) {
      result.expiresAt = expiryRaw > 0 ? new Date(expiryRaw) : null;
    }

    let status: NormalizedAccountStatus = "active";
    if (matches.some((m) => m.client.enable === false)) {
      status = "disabled";
    } else if (result.expiresAt instanceof Date && result.expiresAt.getTime() <= Date.now()) {
      status = "expired";
    } else if (
      result.totalBytes !== undefined &&
      result.totalBytes !== null &&
      (result.usedBytes ?? 0n) >= result.totalBytes
    ) {
      status = "limited";
    }
    result.status = status;

    const subId = typeof first.client.subId === "string" && first.client.subId !== "" ? first.client.subId : undefined;
    if (subId !== undefined) {
      result.subscriptionToken = subId;
      const subscriptionUrl = this.subscriptionUrlFor(input.subscriptionBaseUrl, subId);
      if (subscriptionUrl !== undefined) {
        result.subscriptionUrl = subscriptionUrl;
      }
    }
    result.remoteMetadata = {
      ...(subId !== undefined ? { subId } : {}),
      clients: matches.map((m) => ({ inboundId: m.inboundId, email: m.client.email ?? "" })),
    };
    return result;
  }

  /**
   * NOT implemented: the 3x-ui updateClient contract for quota/expiry
   * mutation is not covered by tests yet. The capability model blocks
   * renewals before payment; this safety net never fakes success.
   */
  async renewServiceAccount(_input: RenewServiceAccountInput): Promise<RenewServiceAccountResult> {
    return { ok: false, errorMessage: "XUI renewal is not implemented; blocked by the capability model." };
  }

  /** NOT implemented - see renewServiceAccount. */
  async addServiceVolume(_input: AddServiceVolumeInput): Promise<AddServiceVolumeResult> {
    return { ok: false, errorMessage: "XUI extra volume is not implemented; blocked by the capability model." };
  }

  /** NOT implemented - see renewServiceAccount. */
  async addServiceTime(_input: AddServiceTimeInput): Promise<AddServiceTimeResult> {
    return { ok: false, errorMessage: "XUI extra time is not implemented; blocked by the capability model." };
  }

  /** NOT implemented - see renewServiceAccount. */
  async setServiceStatus(_input: SetServiceStatusInput): Promise<SetServiceStatusResult> {
    return { ok: false, errorMessage: "XUI service status change is not implemented; blocked by the capability model." };
  }

  /**
   * NOT implemented: 3x-ui has no documented endpoint that revokes and
   * reissues a client subscription; returning the old link as "new" would
   * be a fake success.
   */
  async regenerateSubscription(
    _input: RegenerateSubscriptionInput,
  ): Promise<RegenerateSubscriptionResult> {
    return { ok: false, errorMessage: "XUI subscription regeneration is not implemented; blocked by the capability model." };
  }
}
