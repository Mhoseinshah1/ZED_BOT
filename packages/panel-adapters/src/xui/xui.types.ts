// XUI / Sanaei 3X-UI API types (SANAEI variant: MHSanaei 3x-ui). Clients are
// FIRST-CLASS entities under {basePath}/panel/api/clients - one global client
// row (unique email, one subId/quota/expiry/traffic record) attached to one
// or more inbounds. Field names follow the upstream contract pinned at
// MHSanaei/3x-ui commit 4e928a1ce0945a6e956aa63365034ec24d2b1387
// (internal/database/model/model.go, internal/web/service/client_crud.go,
// docs/public/openapi.json).

/** Standard 3x-ui response envelope: {"success": bool, "msg": "...", "obj": ...}. */
export interface XuiApiEnvelope {
  success?: boolean;
  msg?: string;
  obj?: unknown;
}

/**
 * Universal client fields for POST /panel/api/clients/add (model.Client).
 * Per-protocol secrets (id for VLESS/VMess, password for Trojan, auth for
 * Hysteria) are generated SERVER-side when omitted - callers send only the
 * universal fields. NOTE: totalGB is the upstream field name but its unit
 * is BYTES (the UI converts, the API does not). tgId is an int64 upstream
 * and must be omitted, never sent as a string.
 */
export interface XuiClientPayload {
  email: string;
  /** Subscription identifier; UNIQUE per client panel-wide. */
  subId: string;
  /** Traffic limit in BYTES despite the name; 0 = unlimited. */
  totalGB: number;
  /** Unix milliseconds; 0 = never expires. */
  expiryTime: number;
  enable: boolean;
  limitIp: number;
  reset: number;
  comment?: string;
  /** Only when explicitly configured (must match the inbound security). */
  flow?: string;
}

/**
 * One client row as returned by GET /panel/api/clients/list and
 * /get/{email} (model.ClientRecord). The UUID field is named `uuid` here -
 * unlike the create payload where it is `id`.
 */
export interface XuiClientRecord {
  id?: number;
  email?: string;
  subId?: string;
  /** VLESS/VMess client UUID (per-client secret, server-generated). */
  uuid?: string;
  /** Trojan/Shadowsocks password (per-client secret, server-generated). */
  password?: string;
  auth?: string;
  flow?: string;
  /** Traffic limit in BYTES despite the name; 0 = unlimited. */
  totalGB?: number;
  /** Unix milliseconds; 0 = never expires. */
  expiryTime?: number;
  enable?: boolean;
  comment?: string;
  reset?: number;
}

/** GET /panel/api/clients/list item: client row + attachments + traffic. */
export interface XuiClientWithAttachments extends XuiClientRecord {
  inboundIds?: number[];
  traffic?: XuiClientStat | null;
}

/** GET /panel/api/clients/get/{email} payload. */
export interface XuiClientDetails {
  client?: XuiClientRecord;
  inboundIds?: number[];
  usedTraffic?: number;
}

/** Per-client traffic record (xray.ClientTraffic). One row per client. */
export interface XuiClientStat {
  id?: number;
  inboundId?: number;
  enable?: boolean;
  email?: string;
  up?: number;
  down?: number;
  /** Traffic limit in bytes; 0 = unlimited. */
  total?: number;
  /** Unix milliseconds; 0 = never expires. */
  expiryTime?: number;
  lastOnline?: number;
}

/** One inbound as returned by GET {base}/panel/api/inbounds/list. */
export interface XuiInbound {
  id: number;
  enable?: boolean;
  protocol?: string;
  remark?: string;
  port?: number;
}

/** Result of the login call. The cookie value is a secret - never logged. */
export interface XuiLoginResult {
  ok: boolean;
  /** Cookie header value for subsequent requests (secret). */
  cookie?: string;
  status?: number;
  timedOut?: boolean;
  transportError?: boolean;
  /** true when the endpoint did not answer with the expected JSON envelope. */
  malformedBody?: boolean;
  /** Safe short message (never contains credentials or cookies). */
  message: string;
}

/**
 * In-memory authentication context for one adapter operation. Carries the
 * session cookie or the bearer token - a secret either way: never logged,
 * never returned in messages, never persisted.
 */
export type XuiAuthContext =
  | { kind: "cookie"; cookie: string }
  | { kind: "token"; token: string };

/** Result of establishing the authentication context for the configured mode. */
export interface XuiAuthResult {
  ok: boolean;
  auth?: XuiAuthContext;
  status?: number;
  timedOut?: boolean;
  transportError?: boolean;
  malformedBody?: boolean;
  /**
   * The configured mode's credentials are missing (no network request was
   * attempted) - a configuration error, not a panel failure.
   */
  configIncomplete?: boolean;
  /** Safe short message (never contains credentials, cookies or tokens). */
  message: string;
}

/** Result of an authenticated API request. */
export interface XuiRequestResult {
  ok: boolean;
  status?: number;
  envelope?: XuiApiEnvelope;
  timedOut?: boolean;
  transportError?: boolean;
  malformedBody?: boolean;
  /** Safe short message (never contains credentials or cookies). */
  message: string;
}
