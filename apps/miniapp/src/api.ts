// =============================================================================
// The API client.
//
// There is NO token in this file, and no place to put one. Authentication is a
// cookie the server sets `HttpOnly`, so this code cannot read it, cannot log
// it, and cannot copy it into `localStorage` or `sessionStorage` - a stored
// token is readable by any script that ever runs on the page, which is exactly
// what makes XSS escalate from "defaced UI" to "stolen account". `credentials:
// "same-origin"` is the whole of the authentication logic here.
//
// Requests go to relative paths only. No absolute URL, no configurable API
// host: the Mini App and the API share an origin by construction, which is also
// why there is no CORS to satisfy.
//
// Errors are CODES. The server never sends a human message, so nothing
// server-authored is ever rendered; the Persian text lives in the frontend and
// is chosen by a switch over a closed set.
// =============================================================================

const API_BASE = "/api/miniapp";

/** Requests that hang must not hang the UI forever. */
const REQUEST_TIMEOUT_MS = 15_000;

export type ApiFailureCode =
  // transport / client
  | "NETWORK"
  | "TIMEOUT"
  | "UNEXPECTED"
  // authentication
  | "INVALID_INIT_DATA"
  | "NOT_REGISTERED"
  | "NOT_AUTHENTICATED"
  | "FORBIDDEN_ORIGIN"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NOT_CONFIGURED"
  | "INSECURE_TRANSPORT"
  | "INTERNAL"
  // access gates
  | "MAINTENANCE"
  | "USER_BLOCKED"
  | "USER_DISABLED"
  | "USER_UNAVAILABLE"
  | "TERMS_REQUIRED"
  | "FORCE_JOIN_REQUIRED"
  | "ACCESS_CHECK_UNAVAILABLE";

export interface ApiFailure {
  ok: false;
  code: ApiFailureCode;
  /** True when the gate can only be cleared inside the bot. */
  requiresBot: boolean;
  status: number;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

const KNOWN_CODES = new Set<string>([
  "INVALID_INIT_DATA",
  "NOT_REGISTERED",
  "NOT_AUTHENTICATED",
  "FORBIDDEN_ORIGIN",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "NOT_FOUND",
  "NOT_CONFIGURED",
  "INSECURE_TRANSPORT",
  "INTERNAL",
  "MAINTENANCE",
  "USER_BLOCKED",
  "USER_DISABLED",
  "USER_UNAVAILABLE",
  "TERMS_REQUIRED",
  "FORCE_JOIN_REQUIRED",
  "ACCESS_CHECK_UNAVAILABLE",
]);

function failure(code: ApiFailureCode, status = 0, requiresBot = false): ApiFailure {
  return { ok: false, code, requiresBot, status };
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      // Same-origin, so the HttpOnly session cookie rides along and nothing
      // else has to be managed. "include" would be wrong: it would also send
      // credentials cross-origin, which this app must never do.
      credentials: "same-origin",
      cache: "no-store",
      headers:
        init.body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (err) {
    return failure(
      err instanceof DOMException && err.name === "AbortError" ? "TIMEOUT" : "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure("UNEXPECTED", response.status);
  }
  if (typeof payload !== "object" || payload === null) {
    return failure("UNEXPECTED", response.status);
  }
  const body = payload as Record<string, unknown>;
  if (response.ok && body.ok === true) {
    return body as { ok: true } & T;
  }
  const code = typeof body.code === "string" && KNOWN_CODES.has(body.code) ? body.code : "INTERNAL";
  return failure(code as ApiFailureCode, response.status, body.requiresBot === true);
}

// --- response shapes ---------------------------------------------------------

export interface UserDto {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  status: string;
  group: string;
  balanceToman: number;
  joinedAt: string;
}

export interface ServiceSummaryDto {
  /**
   * The PUBLIC service id — the same short value the bot shows. It is NOT the
   * database uuid, and the app has no way to obtain one: this is what goes in
   * the detail URL and what the user sees.
   */
  id: string;
  username: string;
  status: string;
  productName: string | null;
  panelName: string | null;
  /** Location set the plan covers — an enum label, never an address. */
  location: string;
  volumeBytes: string;
  usedBytes: string;
  remainingBytes: string;
  durationDays: number;
  /** Whole days left; `null` when the service never expires. */
  remainingDays: number | null;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  /** When the row was last written in OUR database — not panel freshness. */
  lastSyncedAt: string;
}

export interface ServiceDetailDto extends ServiceSummaryDto {
  userNote: string | null;
  source: string;
  firstConnectedAt: string | null;
  lastConnectedAt: string | null;
  lastSubscriptionUpdateAt: string | null;
}

/**
 * One wallet ledger row. Deliberately has NO id: nothing addresses a single
 * transaction in this read-only surface, so the server does not send one.
 */
export interface TransactionDto {
  amountToman: number;
  type: string;
  source: string;
  balanceAfterToman: number;
  createdAt: string;
}

export interface DashboardDto {
  /** When the server built this response. */
  serverTimestamp: string;
  /**
   * The OLDEST database write among the services in this response, so
   * "everything here is at least this fresh" is true of every row. Database
   * freshness only — nothing in this app knows when a panel last changed.
   */
  dataFreshnessTimestamp: string;
  user: UserDto;
  services: {
    total: number;
    byStatus: Record<string, number>;
    expiringWithin7Days: number;
    recent: ServiceSummaryDto[];
  };
  wallet: { balanceToman: number; recentTransactions: TransactionDto[] };
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

// --- endpoints ---------------------------------------------------------------

/** Exchanges the signed Telegram payload for a session cookie. */
export function authenticate(initData: string): Promise<ApiResult<{ user: UserDto }>> {
  return request("/auth", { method: "POST", body: { initData } });
}

export function logout(): Promise<ApiResult<Record<string, never>>> {
  return request("/logout", { method: "POST" });
}

/** Counts come from the database and honour the same visibility rules as `/services`. */
export interface ProfileDto {
  user: UserDto;
  services: { active: number; total: number };
}

export function fetchMe(): Promise<ApiResult<ProfileDto>> {
  return request("/me");
}

export function fetchDashboard(): Promise<ApiResult<DashboardDto>> {
  return request("/dashboard");
}

export function fetchServices(cursor: string | null): Promise<ApiResult<PageDto<ServiceSummaryDto>>> {
  return request(`/services${cursorQuery(cursor)}`);
}

export function fetchService(id: string): Promise<ApiResult<{ service: ServiceDetailDto }>> {
  return request(`/services/${encodeURIComponent(id)}`);
}

export function fetchTransactions(
  cursor: string | null,
): Promise<ApiResult<PageDto<TransactionDto> & { balanceToman: number }>> {
  return request(`/wallet/transactions${cursorQuery(cursor)}`);
}

/** Cursors are opaque server-minted strings; they are echoed, never built. */
function cursorQuery(cursor: string | null): string {
  return cursor === null || cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`;
}
