// Marzban API types - minimal Phase 9 surface (token auth, read user,
// create user). Field names follow the Marzban API reference.

/** Subset of the Marzban user object used for provisioning and sync. */
export interface MarzbanUser {
  username: string;
  status?: string;
  /** protocol -> per-user settings (id/password are per-user secrets). */
  proxies?: Record<string, Record<string, unknown>>;
  /** protocol -> inbound tags. */
  inbounds?: Record<string, string[]>;
  data_limit?: number | null;
  data_limit_reset_strategy?: string;
  /** Unix seconds; 0/null = never. */
  expire?: number | null;
  note?: string | null;
  subscription_url?: string;
  links?: unknown[];
  /** Bytes used (sync). */
  used_traffic?: number | null;
  /** Last-online timestamp; API shape varies, parsed defensively. */
  online_at?: string | null;
  last_online?: string | null;
  last_connected_at?: string | null;
}

/** Payload for POST /api/user. */
export interface MarzbanCreateUserPayload {
  username: string;
  proxies: Record<string, Record<string, unknown>>;
  inbounds: Record<string, string[]>;
  /** Bytes; 0 = unlimited. */
  data_limit: number;
  data_limit_reset_strategy: string;
  /** Unix seconds; 0 = never. */
  expire: number;
  status: string;
  note: string;
}

export interface MarzbanTokenResult {
  ok: boolean;
  token?: string;
  status?: number;
  /** true when the request timed out (the panel may have processed it). */
  timedOut?: boolean;
  message: string;
}

export interface MarzbanUserResult {
  ok: boolean;
  user?: MarzbanUser;
  status?: number;
  /** true when no HTTP response arrived (DNS/conn/TLS failure or timeout). */
  transportError?: boolean;
  /** true when the request timed out (the panel may have processed it). */
  timedOut?: boolean;
  /** true when the panel answered 2xx with a non-JSON body. */
  malformedBody?: boolean;
  message: string;
}
