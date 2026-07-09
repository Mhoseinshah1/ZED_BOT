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
