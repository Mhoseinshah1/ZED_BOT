// Shared types for VPN panel integrations.

export type PanelType = "marzban" | "xui";

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

/** XUI / Sanaei / 3X-UI connects with an API token. */
export interface XuiCredentials {
  baseUrl: string;
  token: string;
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
  /** Username as the panel stored it. */
  username?: string;
  subscriptionUrl?: string;
  subscriptionToken?: string;
  configLinks?: string[];
  /** Safe internal diagnostic (no credentials); for logs/admin only. */
  errorMessage?: string;
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
 * Result of getServiceAccount. Optional fields are OMITTED (undefined) when
 * the panel did not report them - callers must not treat missing as zero.
 * `null` carries explicit meaning: totalBytes/remainingBytes null =
 * unlimited, expiresAt null = never expires.
 */
export interface GetServiceAccountResult {
  ok: boolean;
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
  /** Credential-free raw payload for debugging; never shown to users. */
  raw?: Record<string, unknown>;
  /** Safe internal diagnostic (no credentials); for logs/admin only. */
  errorMessage?: string;
}
