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
  | "ACCESS_CHECK_UNAVAILABLE"
  // support-centre writes. The mutation gate speaks the first one; the rest
  // come from the support domain, which refuses in codes rather than prose.
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_SUBJECT"
  | "INVALID_MESSAGE"
  | "INVALID_CATEGORY"
  | "INVALID_SERVICE"
  | "INVALID_REQUEST_ID"
  | "INVALID_TICKET_ID"
  | "TICKET_NOT_FOUND"
  | "TICKET_CLOSED"
  | "IDEMPOTENCY_CONFLICT"
  // commerce (miniapp-commerce-parity). Stable machine codes from the
  // commerce routes; every one has Persian copy in i18n.FAILURE_TEXT.
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "PRODUCT_UNAVAILABLE"
  | "OPTION_UNAVAILABLE"
  | "DISCOUNT_INVALID"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE"
  | "CHECKOUT_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "SERVICE_NOT_ELIGIBLE"
  | "WALLET_DISABLED";

export interface ApiFailure {
  ok: false;
  code: ApiFailureCode;
  /** True when the gate can only be cleared inside the bot. */
  requiresBot: boolean;
  status: number;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

/**
 * Every code this client is willing to believe from the server.
 *
 * Exported and typed as `ApiFailureCode[]` for two reasons. The compiler
 * rejects a code that is not in the union, so the list cannot drift from the
 * type; and a test can walk it to prove every one of them has Persian text
 * waiting in `FAILURE_TEXT` — a code with no text renders `undefined` and takes
 * the screen down, which is the worst possible way to report an error.
 *
 * Anything NOT in this list collapses to `INTERNAL`. The frontend never renders
 * a string it did not author, so an unrecognised code is not a code at all.
 */
export const SERVER_FAILURE_CODES: readonly ApiFailureCode[] = [
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
  "UNSUPPORTED_MEDIA_TYPE",
  "INVALID_SUBJECT",
  "INVALID_MESSAGE",
  "INVALID_CATEGORY",
  "INVALID_SERVICE",
  "INVALID_REQUEST_ID",
  "INVALID_TICKET_ID",
  "TICKET_NOT_FOUND",
  "TICKET_CLOSED",
  "IDEMPOTENCY_CONFLICT",
  "FEATURE_DISABLED",
  "FEATURE_UNAVAILABLE",
  "PRODUCT_UNAVAILABLE",
  "OPTION_UNAVAILABLE",
  "DISCOUNT_INVALID",
  "QUOTE_EXPIRED",
  "QUOTE_STALE",
  "CHECKOUT_UNAVAILABLE",
  "INSUFFICIENT_BALANCE",
  "SERVICE_NOT_ELIGIBLE",
  "WALLET_DISABLED",
];

const KNOWN_CODES = new Set<string>(SERVER_FAILURE_CODES);

function failure(code: ApiFailureCode, status = 0, requiresBot = false): ApiFailure {
  return { ok: false, code, requiresBot, status };
}

export { request };

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

// --- support tickets ---------------------------------------------------------
//
// The ONE part of this client that writes. Two endpoints create something — a
// ticket and a reply — and both are idempotent on a `clientRequestId` the
// CALLER mints. That key is the only reason a retry after a timeout is safe:
// the request may well have been applied already, and replaying the same key
// returns the original outcome instead of opening a second ticket.
//
// TEXT ONLY. `hasAttachments` says a file exists somewhere in the thread; there
// is no file id, no name, no size and no download route, because a Mini App
// that cannot show a file has no use for its metadata.

export interface SupportSummaryDto {
  total: number;
  /** Waiting on the team. */
  waitingSupport: number;
  /** Waiting on the user — the count that should draw the eye. */
  waitingUser: number;
  closed: number;
}

/** The linked service on a ticket: a public id to open it by, and a name. */
export interface TicketServiceDto {
  id: string;
  label: string;
}

export interface TicketSummaryDto {
  /**
   * The PUBLIC ticket id — 8 hex characters, the same value the bot shows.
   * Never the database uuid; the detail route resolves this back, owner-scoped.
   */
  id: string;
  subject: string | null;
  status: string;
  /** A category CODE, never a label. Persian text is chosen in `i18n.ts`. */
  category: string | null;
  /**
   * Who the conversation is waiting on. The SERVER decides this from the stored
   * status, legacy values included, so this app renders it rather than mapping
   * statuses a second time and eventually disagreeing.
   */
  waitingParty: "USER" | "SUPPORT" | null;
  service: TicketServiceDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDetailDto extends TicketSummaryDto {
  /** Where the ticket was raised. Detail only — a list row does not show it. */
  origin: string | null;
  closedAt: string | null;
  /** The SERVER decides whether a reply box may exist at all. */
  canReply: boolean;
  /** True when some message in the thread carries a file. Presence only. */
  hasAttachments: boolean;
}

/**
 * One message in a thread.
 *
 * IT HAS NO IDENTIFIER, on purpose. An earlier version carried a "display key"
 * cut from the message's database uuid; it was only ever used as a React key,
 * but a uuid prefix on the wire is still part of a primary key, and it is
 * stable enough to correlate one response against another. Nothing in this app
 * addresses a single message, so there is nothing for an id to be for. React
 * keys are minted in memory as a page is ingested (`support.tsx`), which is all
 * a key has ever needed to be.
 */
export interface MessageDto {
  senderType: string;
  text: string | null;
  hasAttachment: boolean;
  createdAt: string;
}

export interface CreateTicketBody {
  subject: string;
  message: string;
  /** One of the shared category codes; the server re-validates it. */
  category: string;
  /** Public id of a related service, when the ticket is about one. */
  serviceId?: string | null;
  clientRequestId: string;
}

export interface ReplyBody {
  message: string;
  clientRequestId: string;
}

/**
 * The landing screen in one round trip: the counts AND the newest few tickets.
 *
 * Two requests to paint one screen is two chances to show a half-loaded page,
 * and the two halves could disagree — a count taken before a ticket the list
 * already shows.
 */
export function fetchSupportSummary(): Promise<
  ApiResult<{ summary: SupportSummaryDto; recentTickets: TicketSummaryDto[] }>
> {
  return request("/support/summary");
}

export function fetchSupportTickets(
  cursor: string | null,
): Promise<ApiResult<PageDto<TicketSummaryDto>>> {
  return request(`/support/tickets${cursorQuery(cursor)}`);
}

export function fetchSupportTicket(id: string): Promise<ApiResult<{ ticket: TicketDetailDto }>> {
  return request(`/support/tickets/${encodeURIComponent(id)}`);
}

/**
 * One page of a thread.
 *
 * Messages arrive OLDEST-FIRST within a page, and `nextCursor` walks BACKWARDS
 * — the next page is older still. A thread is therefore assembled by prepending
 * each page, not appending it.
 */
export function fetchSupportMessages(
  id: string,
  cursor: string | null,
): Promise<ApiResult<PageDto<MessageDto>>> {
  return request(`/support/tickets/${encodeURIComponent(id)}/messages${cursorQuery(cursor)}`);
}

export function createSupportTicket(
  body: CreateTicketBody,
): Promise<ApiResult<{ ticket: TicketDetailDto }>> {
  return request("/support/tickets", { method: "POST", body });
}

export function replySupportTicket(
  id: string,
  body: ReplyBody,
): Promise<ApiResult<{ ticket: TicketDetailDto }>> {
  return request(`/support/tickets/${encodeURIComponent(id)}/replies`, {
    method: "POST",
    body,
  });
}

/**
 * A fresh idempotency key.
 *
 * `crypto.getRandomValues`, never `Math.random`: this value is what stops a
 * retried submission from opening a second ticket, so two users (or two tabs)
 * minting the same one would be a collision with a visible, wrong outcome. The
 * PRNG behind `Math.random` is seeded per context and is not required to be
 * unpredictable or well-distributed across contexts.
 *
 * 24 base64url characters over 18 random bytes — 144 bits, comfortably inside
 * the server's `/^[A-Za-z0-9_-]{16,64}$/` and with no padding to strip.
 *
 * NOT STORED. The key lives in React state for exactly as long as the draft it
 * belongs to; nothing writes it to `localStorage`, and a reload legitimately
 * starts a new draft.
 */
export function newClientRequestId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) {
    text += REQUEST_ID_ALPHABET[byte % REQUEST_ID_ALPHABET.length];
  }
  return text;
}

/**
 * The 64 characters the server's pattern accepts.
 *
 * A power of two, so `byte % 64` is an exact, unbiased fold of a uniform byte —
 * a non-power-of-two alphabet would make the first few symbols slightly more
 * likely, which is a needless dent in the entropy of a collision-critical value.
 */
const REQUEST_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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
