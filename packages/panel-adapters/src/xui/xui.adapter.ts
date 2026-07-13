import { bigintToSafeNumber, normalizeBaseUrl } from "../core/http.js";
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
  XuiAuthContext,
  XuiAuthResult,
  XuiClientDetails,
  XuiClientPayload,
  XuiClientWithAttachments,
  XuiInbound,
  XuiRequestResult,
} from "./xui.types.js";

/**
 * Implemented and tested XUI surface: authenticated health, client creation
 * and read/reconciliation against the GLOBAL client API (one first-class
 * Client attached to multiple inbounds - upstream contract pinned at
 * MHSanaei/3x-ui commit 4e928a1ce0945a6e956aa63365034ec24d2b1387).
 * Renewal, extras, toggle and subscription regeneration are NOT implemented
 * - the capability model blocks them before payment; the methods below
 * still fail safely if reached.
 */
export const XUI_CAPABILITIES: readonly PanelCapability[] = [
  "authenticatedHealth",
  "createService",
  "readService",
  "reconciliation",
];

/** Inbound protocols this adapter provisions into (tested set). */
const SUPPORTED_PROTOCOLS = new Set(["vless", "vmess", "trojan"]);

/**
 * XUI / Sanaei 3X-UI panel adapter (SANAEI variant, global client model).
 * ONE client per service: email = the deterministic service username,
 * subId = the same username (unique per client panel-wide), one shared
 * quota/expiry/traffic record, attached to every configured inbound. The
 * legacy one-client-per-inbound model (email suffixed with the inbound id)
 * is never created anymore, but reads still recognize it so services
 * provisioned before this migration keep syncing/reconciling.
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

  private authFailureCode(auth: XuiAuthResult): PanelDiagnosticCode {
    if (auth.configIncomplete === true) {
      return "config-incomplete";
    }
    if (auth.timedOut === true) {
      return "timeout";
    }
    if (auth.transportError === true) {
      return "unreachable";
    }
    if (auth.malformedBody === true || auth.status === 404) {
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
      // A missing/HTML endpoint under /panel/api = a panel version without
      // this API surface (e.g. pre-global-client 3x-ui) or a wrong base path.
      return "unsupported-variant";
    }
    if (result.status === 401 || result.status === 403) {
      // Rejected bearer token (API_TOKEN mode) or revoked session.
      return "auth-failed";
    }
    if (result.status !== undefined && result.status >= 300 && result.status < 400) {
      return "auth-failed";
    }
    return "panel-rejected";
  }

  /**
   * Real authenticated connection test (no reachability-only probing).
   * SESSION_COOKIE: the login round-trip proves the credentials.
   * API_TOKEN: the token is proven by an authenticated read of the global
   * client list - a rejected token is an auth failure, never a success.
   */
  async testConnection(): Promise<PanelHealthResult> {
    const session = await this.client.authenticate();
    if (!session.ok || session.auth === undefined) {
      return { ok: false, message: session.message };
    }
    if (session.auth.kind === "token") {
      const listed = await this.client.listClients(session.auth);
      if (!listed.ok) {
        return { ok: false, message: listed.message };
      }
    }
    return { ok: true, message: "Authentication succeeded." };
  }

  /** Fetches and minimally validates the inbound list (validation only). */
  private async fetchInbounds(
    auth: XuiAuthContext,
  ): Promise<{ ok: true; inbounds: XuiInbound[] } | { ok: false; result: XuiRequestResult }> {
    const list = await this.client.listInbounds(auth);
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

  /** Fetches the complete global client inventory. */
  private async fetchClients(
    auth: XuiAuthContext,
  ): Promise<
    { ok: true; clients: XuiClientWithAttachments[] } | { ok: false; result: XuiRequestResult }
  > {
    const list = await this.client.listClients(auth);
    if (!list.ok) {
      return { ok: false, result: list };
    }
    const obj = list.envelope?.obj;
    if (!Array.isArray(obj)) {
      return {
        ok: false,
        result: { ...list, ok: false, malformedBody: true, message: "Client list has an unexpected shape." },
      };
    }
    const clients = obj.filter(
      (c): c is XuiClientWithAttachments => typeof c === "object" && c !== null && !Array.isArray(c),
    );
    return { ok: true, clients };
  }

  /**
   * Full authenticated readiness: login/token, global-client API access
   * (missing = an unsupported pre-global-client panel version), and
   * validation of every configured inbound id. A reachable login page is
   * NOT readiness; neither is a successful login alone.
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

    const session = await this.client.authenticate();
    if (!session.ok || session.auth === undefined) {
      const code = this.authFailureCode(session);
      checks.push({
        key: "reachable",
        ok:
          code === "timeout" || code === "unreachable"
            ? false
            : code === "config-incomplete"
              ? null
              : true,
        detail: session.message,
      });
      checks.push({ key: "auth", ok: false, detail: session.message });
      return done(
        false,
        this.diag("readiness", code, {
          ...(this.client.authMode === "SESSION_COOKIE" ? { endpointPath: "/login" } : {}),
          httpStatus: session.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      );
    }
    const tokenMode = session.auth.kind === "token";
    if (!tokenMode) {
      checks.push({ key: "reachable", ok: true });
      checks.push({ key: "auth", ok: true });
    }

    // The global client API is the surface every operation depends on: a
    // panel version without it is unsupported regardless of login success.
    const clientsListed = await this.fetchClients(session.auth);
    if (!clientsListed.ok) {
      const code = this.requestFailureCode(clientsListed.result);
      if (tokenMode) {
        const unreachable = code === "timeout" || code === "unreachable";
        checks.push({
          key: "reachable",
          ok: unreachable ? false : true,
          ...(unreachable ? { detail: clientsListed.result.message } : {}),
        });
        checks.push({
          key: "auth",
          ok: code === "auth-failed" ? false : null,
          ...(code === "auth-failed" ? { detail: clientsListed.result.message } : {}),
        });
      }
      checks.push({ key: "read-endpoint", ok: false, detail: clientsListed.result.message });
      return done(
        false,
        this.diag("readiness", code, {
          endpointPath: "/panel/api/clients/list",
          httpStatus: clientsListed.result.status,
          retryable: clientsListed.result.transportError === true,
        }),
      );
    }
    if (tokenMode) {
      checks.push({ key: "reachable", ok: true });
      checks.push({ key: "auth", ok: true });
    }
    checks.push({ key: "read-endpoint", ok: true });

    const inboundIds = (input.inboundIds ?? []).filter((id) => Number.isInteger(id));
    if (inboundIds.length === 0) {
      checks.push({ key: "config", ok: false, detail: "no inbound ids configured" });
      checks.push({ key: "inbounds", ok: null });
      return done(false, this.diag("readiness", "config-incomplete"));
    }
    checks.push({ key: "config", ok: true });

    const listed = await this.fetchInbounds(session.auth);
    if (!listed.ok) {
      checks.push({ key: "inbounds", ok: false, detail: listed.result.message });
      return done(
        false,
        this.diag("readiness", this.requestFailureCode(listed.result), {
          endpointPath: "/panel/api/inbounds/list",
          httpStatus: listed.result.status,
          retryable: listed.result.transportError === true,
        }),
      );
    }
    const byId = new Map(listed.inbounds.map((i) => [i.id, i]));
    for (const id of inboundIds) {
      const problem = this.validateInbound(byId.get(id), id);
      if (problem !== null) {
        checks.push({ key: "inbounds", ok: false, detail: problem.detail });
        return done(false, this.diag("readiness", problem.code, { detail: problem.detail }));
      }
    }
    checks.push({ key: "inbounds", ok: true, detail: `inbounds ${inboundIds.join(", ")} valid` });
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
    return null;
  }

  private subscriptionUrlFor(
    subscriptionBaseUrl: string | null | undefined,
    subId: string,
  ): string | undefined {
    // The API does not report a subscription URL; one is returned ONLY when
    // the operator explicitly configured the subscription base. Nothing is
    // fabricated.
    if (subscriptionBaseUrl === null || subscriptionBaseUrl === undefined || subscriptionBaseUrl === "") {
      return undefined;
    }
    return `${normalizeBaseUrl(subscriptionBaseUrl)}/${encodeURIComponent(subId)}`;
  }

  /** Primary per-client secret identifier from a client row. */
  private recordIdentifier(record: XuiClientDetails["client"]): string | undefined {
    if (record === undefined) {
      return undefined;
    }
    for (const value of [record.uuid, record.password, record.auth]) {
      if (typeof value === "string" && value !== "") {
        return value;
      }
    }
    return undefined;
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
      return fail("XUI inbound ids are not configured.", this.diag(op, "config-incomplete"));
    }

    // totalGB is bytes in the upstream contract; 0 = unlimited. Refuse lossy
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

    // ONE global client per service: email = deterministic username,
    // subId = the same username (unique per client panel-wide).
    const email = input.username;
    const subId = input.username;

    const session = await this.client.authenticate();
    if (!session.ok || session.auth === undefined) {
      const code = this.authFailureCode(session);
      return fail(
        `XUI authentication failed: ${session.message}`,
        this.diag(op, code, {
          ...(this.client.authMode === "SESSION_COOKIE" ? { endpointPath: "/login" } : {}),
          httpStatus: session.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      );
    }
    const auth = session.auth;

    // Validate every configured inbound BEFORE any mutation.
    const listed = await this.fetchInbounds(auth);
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
    for (const id of inboundIds) {
      const problem = this.validateInbound(byId.get(id), id);
      if (problem !== null) {
        return fail(`XUI ${problem.detail}.`, this.diag(op, problem.code, { detail: problem.detail }));
      }
    }

    // Idempotency pre-check on the full inventory: an existing client with
    // our email but a FOREIGN subId belongs to someone else - a conflict,
    // never adopted, never recreated over. (The server enforces the same
    // rule; checking first yields a clean diagnostic without a mutation
    // attempt.)
    const preRead = await this.fetchClients(auth);
    if (!preRead.ok) {
      return fail(
        `XUI client list failed: ${preRead.result.message}`,
        this.diag(op, this.requestFailureCode(preRead.result), {
          endpointPath: "/panel/api/clients/list",
          httpStatus: preRead.result.status,
          retryable: preRead.result.transportError === true,
        }),
      );
    }
    const existing = preRead.clients.find((c) => c.email === email);
    if (existing !== undefined && typeof existing.subId === "string" && existing.subId !== "" && existing.subId !== subId) {
      return fail(
        "XUI email conflict: a client with this email exists but carries a different subscription id.",
        this.diag(op, "conflict", { detail: "existing client has a foreign subId" }),
      );
    }

    // Universal fields only - per-protocol secrets (UUID/password/auth) are
    // generated SERVER-side per the documented contract. tgId is an int64
    // upstream and is deliberately omitted. Re-adding the same email+subId
    // is idempotent upstream (credentials reused, attachments deduped).
    const flowSetting =
      typeof input.protocolSettings?.["flow"] === "string"
        ? (input.protocolSettings["flow"] as string)
        : undefined;
    const payload: XuiClientPayload = {
      email,
      subId,
      totalGB: totalBytes,
      expiryTime: input.expiresAt === null ? 0 : input.expiresAt.getTime(),
      enable: true,
      limitIp: 0,
      reset: 0,
      ...(input.note !== null && input.note !== undefined && input.note !== ""
        ? { comment: input.note }
        : {}),
      ...(flowSetting !== undefined ? { flow: flowSetting } : {}),
    };
    const added = await this.client.addClient(auth, payload as unknown as Record<string, unknown>, inboundIds);

    if (!added.ok) {
      const lowerMsg = added.message.toLowerCase();
      if (added.status === 200 && lowerMsg.includes("already in use")) {
        // Server-side conflict (foreign email/subId): nothing was mutated.
        return fail(
          `XUI create client conflict: ${added.message}`,
          this.diag(op, "conflict", {
            endpointPath: "/panel/api/clients/add",
            httpStatus: added.status,
          }),
        );
      }
      // The server attaches inbounds in a loop, so a mid-call failure can
      // leave the client attached to a subset. Compensating cleanup is ONE
      // bounded call (del/{email} removes every attachment + the traffic
      // record), verified by a re-read of the inventory.
      const maybeLanded = added.transportError === true;
      const cleanedUp = await this.cleanupGlobalClient(auth, email);
      // Definite failure requires BOTH a confirmed-clean re-read AND a real
      // panel response for the failed call: after a timeout the hung
      // request may still be in flight and could land AFTER the
      // verification read, so no immediate read can prove absence.
      if (cleanedUp && !maybeLanded) {
        return fail(
          `XUI create client failed: ${added.message} (compensating cleanup confirmed).`,
          this.diag(op, this.requestFailureCode(added), {
            endpointPath: "/panel/api/clients/add",
            httpStatus: added.status,
            retryable: true,
          }),
        );
      }
      return fail(
        `XUI create client failed: ${added.message}; compensating cleanup could NOT be confirmed - remote state is partial/unknown.`,
        this.diag(op, "partial-state", {
          endpointPath: "/panel/api/clients/add",
          httpStatus: added.status,
          retryable: true,
          certainty: "unknown",
        }),
        true,
      );
    }

    // Read back the created client for the server-generated identifiers and
    // the final attachment list. The client DEFINITELY exists at this point,
    // so a read-back failure never fails the order - identifiers are
    // backfilled later by sync/reconciliation.
    let identifier: string | undefined;
    let attachedIds: number[] = inboundIds;
    const readBack = await this.client.getClient(auth, email);
    if (readBack.ok) {
      const details = readBack.envelope?.obj as XuiClientDetails | undefined;
      identifier = this.recordIdentifier(details?.client);
      if (Array.isArray(details?.inboundIds) && details.inboundIds.length > 0) {
        attachedIds = details.inboundIds.filter((id): id is number => Number.isInteger(id));
      }
    }

    // Real config links from the panel's own link builder - best effort.
    let configLinks: string[] | undefined;
    const links = await this.client.getClientLinks(auth, email);
    if (links.ok && Array.isArray(links.envelope?.obj)) {
      const urls = (links.envelope.obj as unknown[]).filter(
        (l): l is string => typeof l === "string" && l !== "",
      );
      if (urls.length > 0) {
        configLinks = urls;
      }
    }

    const subscriptionUrl = this.subscriptionUrlFor(input.subscriptionBaseUrl, subId);
    return {
      ok: true,
      username: input.username,
      ...(subscriptionUrl !== undefined ? { subscriptionUrl } : {}),
      subscriptionToken: subId,
      ...(configLinks !== undefined ? { configLinks } : {}),
      ...(identifier !== undefined ? { remoteClientId: identifier } : {}),
      remoteInboundIds: attachedIds,
      remoteMetadata: {
        subId,
        email,
        inboundIds: attachedIds,
        ...(identifier === undefined ? { readback: false } : {}),
      },
    };
  }

  /**
   * Bounded compensating cleanup: ONE del/{email} call removes the global
   * client from every attached inbound and drops its traffic record, then a
   * re-read of the inventory verifies the email is gone. Returns true ONLY
   * when the panel positively shows a clean state.
   */
  private async cleanupGlobalClient(auth: XuiAuthContext, email: string): Promise<boolean> {
    await this.client.deleteClient(auth, email);
    const listed = await this.fetchClients(auth);
    if (!listed.ok) {
      return false;
    }
    return !listed.clients.some((c) => c.email === email);
  }

  /**
   * Read-only reconciliation/sync against the global client inventory.
   * Matches the service's client by exact email (global model) and, for
   * services provisioned before this migration, the legacy per-inbound
   * labels (`username-<inboundId>`). notFound is set ONLY when the full
   * inventory was readable and no client matched - "could not check" is
   * never reported as "does not exist".
   */
  async getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    const op = "read-service";
    const session = await this.client.authenticate();
    if (!session.ok || session.auth === undefined) {
      const code = this.authFailureCode(session);
      return {
        ok: false,
        errorMessage: `XUI authentication failed: ${session.message}`,
        diagnostic: this.diag(op, code, {
          ...(this.client.authMode === "SESSION_COOKIE" ? { endpointPath: "/login" } : {}),
          httpStatus: session.status,
          retryable: code === "timeout" || code === "unreachable",
        }),
      };
    }
    const listed = await this.fetchClients(session.auth);
    if (!listed.ok) {
      return {
        ok: false,
        errorMessage: `XUI client list failed: ${listed.result.message}`,
        diagnostic: this.diag(op, this.requestFailureCode(listed.result), {
          endpointPath: "/panel/api/clients/list",
          httpStatus: listed.result.status,
          retryable: listed.result.transportError === true,
        }),
      };
    }

    const isOurs = (email: unknown): boolean =>
      typeof email === "string" &&
      (email === input.username || email.startsWith(`${input.username}-`));
    const matches = listed.clients.filter((c) => isOurs(c.email));
    if (matches.length === 0) {
      return {
        ok: false,
        notFound: true,
        errorMessage: "Panel client not found.",
        diagnostic: this.diag(op, "not-found", { endpointPath: "/panel/api/clients/list" }),
      };
    }

    // Global model: exactly one client carries the truth. Legacy services
    // (pre-migration per-inbound clients) aggregate across their labels.
    const primary = matches.find((c) => c.email === input.username) ?? matches[0];
    const result: GetServiceAccountResult = { ok: true, username: input.username };

    const totalRaw = typeof primary.totalGB === "number" ? primary.totalGB : undefined;
    if (totalRaw !== undefined) {
      result.totalBytes = totalRaw > 0 ? BigInt(Math.trunc(totalRaw)) : null;
    }
    let used = 0n;
    let sawTraffic = false;
    let lastOnline = 0;
    for (const match of matches) {
      const traffic = match.traffic;
      if (traffic !== undefined && traffic !== null) {
        sawTraffic = true;
        const up = typeof traffic.up === "number" ? traffic.up : 0;
        const down = typeof traffic.down === "number" ? traffic.down : 0;
        used += BigInt(Math.max(0, Math.trunc(up))) + BigInt(Math.max(0, Math.trunc(down)));
        if (typeof traffic.lastOnline === "number" && traffic.lastOnline > lastOnline) {
          lastOnline = traffic.lastOnline;
        }
      }
    }
    if (sawTraffic) {
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
    const expiryRaw = typeof primary.expiryTime === "number" ? primary.expiryTime : undefined;
    if (expiryRaw !== undefined) {
      result.expiresAt = expiryRaw > 0 ? new Date(expiryRaw) : null;
    }
    if (lastOnline > 0) {
      result.lastConnectedAt = new Date(lastOnline);
    }

    let status: NormalizedAccountStatus = "active";
    if (matches.some((m) => m.enable === false)) {
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

    const subId = typeof primary.subId === "string" && primary.subId !== "" ? primary.subId : undefined;
    if (subId !== undefined) {
      result.subscriptionToken = subId;
      const subscriptionUrl = this.subscriptionUrlFor(input.subscriptionBaseUrl, subId);
      if (subscriptionUrl !== undefined) {
        result.subscriptionUrl = subscriptionUrl;
      }
    }
    result.remoteMetadata = {
      ...(subId !== undefined ? { subId } : {}),
      clients: matches.map((m) => ({
        email: m.email ?? "",
        inboundIds: Array.isArray(m.inboundIds) ? m.inboundIds : [],
      })),
    };
    return result;
  }

  /**
   * NOT implemented: quota/expiry mutation via POST /clients/update/{email}
   * is not covered by tests yet. The capability model blocks renewals
   * before payment; this safety net never fakes success.
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
   * NOT implemented: 3x-ui has no endpoint that revokes and reissues a
   * client subscription id in place; returning the old link as "new" would
   * be a fake success.
   */
  async regenerateSubscription(
    _input: RegenerateSubscriptionInput,
  ): Promise<RegenerateSubscriptionResult> {
    return { ok: false, errorMessage: "XUI subscription regeneration is not implemented; blocked by the capability model." };
  }
}
