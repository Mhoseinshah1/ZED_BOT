// XUI / Sanaei 3X-UI API types (SANAEI variant: MHSanaei 3x-ui, routes under
// {basePath}/panel/api/inbounds). Field names follow the 3x-ui API contract.

/** Standard 3x-ui response envelope: {"success": bool, "msg": "...", "obj": ...}. */
export interface XuiApiEnvelope {
  success?: boolean;
  msg?: string;
  obj?: unknown;
}

/**
 * One client entry inside an inbound's settings JSON. NOTE: totalGB is the
 * 3x-ui field name but its unit is BYTES (the UI converts, the API does not).
 */
export interface XuiClientEntry {
  /** VLESS/VMess client UUID (per-client secret). */
  id?: string;
  /** Trojan client password (per-client secret). */
  password?: string;
  /** Client label; must be unique panel-wide in 3x-ui. Not a real e-mail. */
  email?: string;
  flow?: string;
  /** Traffic limit in BYTES despite the name; 0 = unlimited. */
  totalGB?: number;
  /** Unix milliseconds; 0 = never expires. */
  expiryTime?: number;
  enable?: boolean;
  limitIp?: number;
  tgId?: string | number;
  /** Subscription identifier; shared subIds group clients into one subscription. */
  subId?: string;
  reset?: number;
}

/** Per-client traffic accounting reported on each inbound (client_traffics). */
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
}

/** One inbound as returned by GET {base}/panel/api/inbounds/list. */
export interface XuiInbound {
  id: number;
  enable?: boolean;
  protocol?: string;
  remark?: string;
  port?: number;
  /** JSON string: {"clients": [XuiClientEntry, ...], ...}. */
  settings?: string;
  streamSettings?: string;
  clientStats?: XuiClientStat[] | null;
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
