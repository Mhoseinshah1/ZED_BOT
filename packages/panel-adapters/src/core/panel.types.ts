// Shared types for VPN panel integrations.

export type PanelType = "marzban" | "xui";

// =============================================================================
// Capabilities
// =============================================================================

/**
 * Explicit operation support per adapter. Anything NOT listed by an adapter
 * is blocked BEFORE payment - a paid order must never discover an
 * unimplemented operation after the money moved.
 */
export type PanelCapability =
  | "authenticatedHealth"
  | "createService"
  | "readService"
  | "renewService"
  | "addVolume"
  | "addTime"
  | "toggleService"
  | "regenerateSubscription"
  | "deleteService"
  | "reconciliation";

// =============================================================================
// Sanitized diagnostics
// =============================================================================

/**
 * How certain the adapter is that the remote mutation did NOT happen.
 * "definite" = the panel state is untouched by this call (refund-safe).
 * "unknown"  = the mutation may have (partially) landed - callers must NOT
 *              refund and must defer to reconciliation.
 */
export type PanelOutcomeCertainty = "definite" | "unknown";

/** Stable machine-readable failure codes (mapped to Persian admin texts upstream). */
export type PanelDiagnosticCode =
  | "unreachable"
  | "timeout"
  | "auth-failed"
  | "not-found"
  | "template-not-found"
  | "template-invalid"
  | "config-incomplete"
  | "config-invalid"
  | "unsafe-volume"
  | "unsupported-variant"
  | "unsupported-protocol"
  | "unsupported-operation"
  | "inbound-missing"
  | "inbound-disabled"
  | "inbound-malformed"
  | "malformed-response"
  | "conflict"
  | "panel-rejected"
  | "partial-state";

/**
 * Centralized sanitized panel error/diagnostic. Carries ONLY safe fields:
 * never passwords, tokens, cookies, session ids, authorization headers,
 * subscription URLs, client UUIDs/passwords or raw response bodies.
 * endpointPath is a path TEMPLATE (e.g. "/api/user/{username}") - no host,
 * no query string, no secrets.
 */
export interface PanelDiagnostic {
  operation: string;
  panelType: PanelType;
  code: PanelDiagnosticCode;
  endpointPath?: string;
  httpStatus?: number;
  /** Short sanitized panel message (length-capped, secret-free). */
  detail?: string;
  /** true when retrying the identical call later may succeed. */
  retryable: boolean;
  certainty: PanelOutcomeCertainty;
}

// =============================================================================
// Provisioning readiness
// =============================================================================

/** Ordered readiness steps; keys are stable for UI mapping. */
export type ReadinessCheckKey =
  | "reachable"
  | "auth"
  | "read-endpoint"
  | "template"
  | "inbounds"
  | "config";

/** One readiness step result. ok=null means the step was skipped/not reached. */
export interface ReadinessCheck {
  key: ReadinessCheckKey;
  ok: boolean | null;
  /** Safe short detail for the admin (English, mapped to Persian upstream). */
  detail?: string;
}

/** Panel-row configuration relevant to provisioning readiness. */
export interface ProvisioningReadinessInput {
  templateUsername?: string | null;
  inboundIds?: number[] | null;
  protocolSettings?: Record<string, unknown> | null;
  subscriptionBaseUrl?: string | null;
}

/**
 * Result of the authenticated provisioning-readiness check. `ready` is true
 * ONLY when every required step for createService passed - a reachable
 * login page or a successful authentication alone is NOT readiness.
 */
export interface ProvisioningReadinessResult {
  ready: boolean;
  checks: ReadinessCheck[];
  capabilities: readonly PanelCapability[];
  diagnostic?: PanelDiagnostic;
}

/** Connection settings every panel needs. */
export interface PanelCredentials {
  /** Panel base URL, e.g. https://panel.example.com:8443 */
  baseUrl: string;
  username: string;
  password: string;
}

/** Marzban connects with username + password (token flow). */
export interface MarzbanCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

/** Supported XUI API families. SANAEI = MHSanaei 3X-UI (/panel/api routes). */
export type XuiApiVariant = "SANAEI";

/**
 * How an XUI-compatible deployment authenticates API requests.
 *
 * - "SESSION_COOKIE": the stock Sanaei 3X-UI mechanism - form login on
 *   {base}/login, session cookie on subsequent requests.
 * - "API_TOKEN": deployments that require a pre-issued API token instead of
 *   an interactive login. The token is sent as `Authorization: Bearer` on
 *   every request against the same SANAEI-shaped API routes; no /login call
 *   is ever made. Token formats/endpoints differ between forks - only this
 *   documented bearer convention is implemented; other schemes surface as
 *   authentication/variant failures, never as guesses.
 */
export type XuiAuthMode = "SESSION_COOKIE" | "API_TOKEN";

/**
 * XUI / Sanaei / 3X-UI credentials. The base URL may carry a secret web
 * base path (https://host:port/secretpath); it is used verbatim after
 * normalization. Exactly one credential set is required, selected by
 * authMode (default SESSION_COOKIE): username+password, or token.
 */
export interface XuiCredentials {
  baseUrl: string;
  /** Defaults to "SESSION_COOKIE" - the stock 3X-UI mechanism. */
  authMode?: XuiAuthMode;
  /** SESSION_COOKIE mode. */
  username?: string;
  /** SESSION_COOKIE mode. */
  password?: string;
  /** API_TOKEN mode: bearer token sent on every API request. */
  token?: string;
  /** Defaults to "SANAEI" - the only variant implemented and tested. */
  apiVariant?: XuiApiVariant;
}

/** Result of a panel connectivity/authentication test. */
export interface PanelHealthResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Input for creating ONE service account on a panel (Phase 9).
 *
 * Deliberately plain values only - this package never depends on the
 * database layer, so the bot maps Prisma rows (order/user/product/panel)
 * into this shape before calling the adapter.
 */
export interface CreateServiceAccountInput {
  /** Already-sanitized panel username (lowercase, [a-z0-9_], deterministic per order). */
  username: string;
  /** Free-text note stored on the panel account (never secret). */
  note?: string | null;
  /** Traffic limit in bytes; null = unlimited. */
  volumeBytes: bigint | null;
  /** Sold duration in days; 0 = unlimited (informational - expiresAt is authoritative). */
  durationDays: number;
  /** Account expiry; null = never expires. */
  expiresAt: Date | null;
  /** Marzban: existing panel user whose proxies/inbounds are copied (secrets stripped). */
  templateUsername?: string | null;
  /** Marzban data_limit_reset_strategy: no_reset / day / week / month / year. */
  dataLimitResetStrategy?: string | null;
  /** Base URL used to absolutize relative subscription URLs (falls back to the panel baseUrl). */
  subscriptionBaseUrl?: string | null;
  /** XUI: inbound ids the client must be added to. */
  inboundIds?: number[] | null;
  /** XUI: fork-specific protocol settings. */
  protocolSettings?: Record<string, unknown> | null;
  /** Raw product traffic reset cycle (NO_RESET/DAY/WEEK/MONTH/YEAR) for adapters that map it themselves. */
  trafficResetCycle?: string | null;
}

/** Result of createServiceAccount. Internal-only fields must never reach end users. */
export interface CreateServiceAccountResult {
  ok: boolean;
  /**
   * Set ONLY with ok=false: the remote outcome is UNKNOWN or PARTIAL (e.g.
   * timeout after the request may have landed, or a multi-inbound cleanup
   * that could not be confirmed). Callers must NOT refund and must leave the
   * order for reconciliation. Unset/false with ok=false = definite failure,
   * the panel state is untouched.
   */
  uncertain?: boolean;
  /** Username as the panel stored it. */
  username?: string;
  subscriptionUrl?: string;
  subscriptionToken?: string;
  configLinks?: string[];
  /**
   * Primary remote client identifier for client-addressed panels (XUI:
   * VLESS/VMess UUID or Trojan password). Sensitive like subscriptionToken -
   * persisted, never logged.
   */
  remoteClientId?: string;
  /** Inbound ids the client was actually added to (XUI). */
  remoteInboundIds?: number[];
  /** Non-secret structured identifiers (client emails, subscription id). */
  remoteMetadata?: Record<string, unknown>;
  /** Safe internal diagnostic (no credentials); for logs/admin only. */
  errorMessage?: string;
  /** Structured sanitized diagnostic for admin display and logs. */
  diagnostic?: PanelDiagnostic;
  /** Credential-free raw payload for debugging; never shown to users. */
  raw?: Record<string, unknown>;
}

/** Panel-agnostic account status. "unknown" = caller keeps its current state. */
export type NormalizedAccountStatus = "active" | "disabled" | "expired" | "limited" | "unknown";

/** Input for reading ONE service account from a panel (Phase 11 sync). */
export interface GetServiceAccountInput {
  username: string;
  /** Base URL used to absolutize relative subscription URLs (falls back to the panel baseUrl). */
  subscriptionBaseUrl?: string | null;
}

/**
 * Input for renewing ONE existing service account on a panel (Phase 12).
 * The username is never changed and the account is never deleted/recreated.
 */
export interface RenewServiceAccountInput {
  username: string;
  /** New total traffic limit in bytes; null = unlimited. */
  totalBytes: bigint | null;
  /** New expiry; null = never expires. */
  expiresAt: Date | null;
  note?: string | null;
  /** Base URL used to absolutize relative subscription URLs (falls back to the panel baseUrl). */
  subscriptionBaseUrl?: string | null;
}

/**
 * Input for adding purchased volume to ONE existing account (Phase 16).
 * totalBytes is the NEW total quota (never null - extra volume is only sold
 * for finite-volume services); expiresAt is passed through UNCHANGED.
 */
export interface AddServiceVolumeInput {
  username: string;
  totalBytes: bigint;
  expiresAt: Date | null;
  note?: string | null;
  subscriptionBaseUrl?: string | null;
}

/** Result of renewServiceAccount - same field semantics as GetServiceAccountResult. */
export interface RenewServiceAccountResult {
  ok: boolean;
  /**
   * Set ONLY with ok=false: the remote outcome is UNKNOWN (timeout after
   * the mutation may have landed, or an unverifiable post-mutation state).
   * Callers must NOT refund and must leave the order for reconciliation.
   * Unset/false with ok=false = definite failure, panel state untouched.
   */
  uncertain?: boolean;
  username?: string;
  status?: NormalizedAccountStatus;
  usedBytes?: bigint;
  totalBytes?: bigint | null;
  remainingBytes?: bigint | null;
  expiresAt?: Date | null;
  subscriptionUrl?: string;
  subscriptionToken?: string;
  configLinks?: string[];
  /** Credential-free raw payload for debugging; never shown to users. */
  raw?: Record<string, unknown>;
  /** Safe internal diagnostic (no credentials); for logs/admin only. */
  errorMessage?: string;
}

/** Result of addServiceVolume - identical shape/semantics to a renewal result. */
export type AddServiceVolumeResult = RenewServiceAccountResult;

/**
 * Input for extending ONE existing account's expiry (Phase 17). totalBytes
 * is the CURRENT quota passed through unchanged (null = unlimited);
 * expiresAt is the NEW expiry (never null - extra time is only sold for
 * services with a finite expiry). Usage is NEVER reset for extra time.
 */
export interface AddServiceTimeInput {
  username: string;
  totalBytes: bigint | null;
  expiresAt: Date;
  note?: string | null;
  subscriptionBaseUrl?: string | null;
}

/** Result of addServiceTime - identical shape/semantics to a renewal result. */
export type AddServiceTimeResult = RenewServiceAccountResult;

/**
 * Input for enabling/disabling ONE existing account (Phase 18). Nothing
 * else changes: no quota, no expiry, no usage reset, no username change.
 */
export interface SetServiceStatusInput {
  username: string;
  enabled: boolean;
  subscriptionBaseUrl?: string | null;
}

/** Result of setServiceStatus - identical shape/semantics to a renewal result. */
export type SetServiceStatusResult = RenewServiceAccountResult;

/**
 * Input for regenerating ONE existing account's subscription link/token
 * (Phase 19). The account itself is untouched: no username change, no
 * quota/expiry change, no usage reset, never delete/recreate.
 */
export interface RegenerateSubscriptionInput {
  username: string;
  subscriptionBaseUrl?: string | null;
}

/** Result of regenerateSubscription - identical shape/semantics to a renewal result. */
export type RegenerateSubscriptionResult = RenewServiceAccountResult;

/**
 * Traffic usage snapshot derived from one panel read (service-live-sync
 * phase). `null` fields = the panel did not report that value (never
 * invented); totalBytes/remainingBytes null while usedBytes is set can also
 * mean unlimited - consumers needing the distinction use the full
 * GetServiceAccountResult where omitted-vs-null is preserved.
 */
export interface ServiceTrafficUsage {
  usedBytes: bigint | null;
  totalBytes: bigint | null;
  remainingBytes: bigint | null;
}

/**
 * Subscription snapshot derived from one panel read (service-live-sync
 * phase). `null`/empty = not reported by the panel - never invented.
 */
export interface ServiceSubscriptionInfo {
  subscriptionUrl: string | null;
  subscriptionToken: string | null;
  configLinks: string[];
}

/**
 * Result of getServiceAccount. Optional fields are OMITTED (undefined) when
 * the panel did not report them - callers must not treat missing as zero.
 * `null` carries explicit meaning: totalBytes/remainingBytes null =
 * unlimited, expiresAt null = never expires.
 */
export interface GetServiceAccountResult {
  ok: boolean;
  /**
   * true ONLY when the panel POSITIVELY reported that no account with this
   * username exists (e.g. a documented 404). Reconciliation treats this as
   * proof the mutation never happened; transport errors, auth failures and
   * unimplemented adapters must leave it unset - "could not check" is NOT
   * "does not exist".
   */
  notFound?: boolean;
  username?: string;
  status?: NormalizedAccountStatus;
  usedBytes?: bigint;
  totalBytes?: bigint | null;
  remainingBytes?: bigint | null;
  expiresAt?: Date | null;
  subscriptionUrl?: string;
  subscriptionToken?: string;
  configLinks?: string[];
  firstConnectedAt?: Date | null;
  lastConnectedAt?: Date | null;
  /** Non-secret structured identifiers (XUI: client emails, inbound ids). */
  remoteMetadata?: Record<string, unknown>;
  /** Credential-free raw payload for debugging; never shown to users. */
  raw?: Record<string, unknown>;
  /** Safe internal diagnostic (no credentials); for logs/admin only. */
  errorMessage?: string;
  /** Structured sanitized diagnostic for admin display and logs. */
  diagnostic?: PanelDiagnostic;
}
