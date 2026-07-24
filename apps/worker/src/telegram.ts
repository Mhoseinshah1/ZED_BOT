import { createLogger, intEnv } from "@zedbot/shared";

// =============================================================================
// Minimal Telegram Bot API client (sendMessage + createForumTopic) used by the
// notification, log-delivery and log-group-setup consumers. The bot token is
// embedded only in the request URL and is NEVER included in errors, logs or
// return values - every failure is collapsed to a short safe error code. Every
// call is bounded by an AbortController timeout so a hung Telegram/proxy
// connection can never stall a worker forever, and NOTHING sensitive (token,
// request URL, chat id, topic id, raw response body/description) is ever logged
// - only a fixed safe category.
// =============================================================================

const logger = createLogger("worker:telegram");

/**
 * Bounded per-request timeout for every Telegram Bot API call
 * (TELEGRAM_API_TIMEOUT_MS, default 20s, clamped to 5s..60s). Beyond this the
 * AbortController fires and the call returns the safe "telegram-timeout" code.
 */
export const TELEGRAM_API_TIMEOUT_DEFAULT_MS = 20_000;
const TELEGRAM_API_TIMEOUT_MIN_MS = 5_000;
const TELEGRAM_API_TIMEOUT_MAX_MS = 60_000;

export function telegramApiTimeoutMs(): number {
  const raw = intEnv("TELEGRAM_API_TIMEOUT_MS", TELEGRAM_API_TIMEOUT_DEFAULT_MS);
  return Math.min(TELEGRAM_API_TIMEOUT_MAX_MS, Math.max(TELEGRAM_API_TIMEOUT_MIN_MS, raw));
}

/**
 * Documented safe maximum for an honoured Telegram 429 retry-after. Telegram
 * normally returns a few seconds; a hostile/buggy huge value must never stall
 * the setup or delivery queue for minutes, so it is capped here (the value
 * flows unchanged through provisionStagedTopics -> the setup worker's
 * queue.rateLimit()).
 */
export const TELEGRAM_MAX_RETRY_AFTER_MS = 60_000;

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; safeErrorCode: string; retryable: boolean; retryAfterMs?: number };

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

interface ClassifiedTelegramError {
  safeErrorCode: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Bounded, capped 429 retry-after in ms (never below 1s, never above the cap). */
function retryAfterMsFrom(body: TelegramApiResponse): number {
  const retryAfter = body.parameters?.retry_after;
  const ms = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : 5_000;
  return Math.min(TELEGRAM_MAX_RETRY_AFTER_MS, Math.max(1_000, ms));
}

/**
 * Status-level classification shared by every operation (429/403/5xx). Returns
 * null for a 400 (and any other status), which the operation-aware classifier
 * must interpret from the description - a "topic not found" is meaningful for
 * sendMessage but never for createForumTopic, and a rights error needs a
 * different safe code per operation.
 */
function classifyCommonTelegramError(
  status: number,
  body: TelegramApiResponse,
): ClassifiedTelegramError | null {
  const description = (body.description ?? "").toLowerCase();
  if (status === 429) {
    return { safeErrorCode: "rate-limited", retryable: true, retryAfterMs: retryAfterMsFrom(body) };
  }
  if (status >= 500) {
    return { safeErrorCode: "telegram-server-error", retryable: true };
  }
  if (status === 403) {
    if (
      description.includes("bot was kicked") ||
      description.includes("bot is not a member") ||
      description.includes("not a member") ||
      description.includes("chat member status")
    ) {
      return { safeErrorCode: "bot-not-member", retryable: false };
    }
    return { safeErrorCode: "forbidden", retryable: false };
  }
  return null;
}

/**
 * sendMessage-aware classification: a missing/closed topic is a real,
 * per-topic delivery signal (the caller may invalidate that exact mapping).
 */
export function classifySendMessageError(
  status: number,
  body: TelegramApiResponse,
): ClassifiedTelegramError {
  const common = classifyCommonTelegramError(status, body);
  if (common !== null) {
    return common;
  }
  const d = (body.description ?? "").toLowerCase();
  if (status === 400) {
    if (d.includes("chat not found")) {
      return { safeErrorCode: "chat-not-found", retryable: false };
    }
    if (
      d.includes("message thread not found") ||
      d.includes("thread not found") ||
      d.includes("topic_deleted")
    ) {
      return { safeErrorCode: "topic-missing", retryable: false };
    }
    if (d.includes("topic_closed") || d.includes("topic is closed")) {
      return { safeErrorCode: "topic-closed", retryable: false };
    }
    if (
      d.includes("not enough rights") ||
      d.includes("chat_admin_required") ||
      d.includes("need administrator") ||
      d.includes("have no rights to send")
    ) {
      return { safeErrorCode: "bot-not-admin", retryable: false };
    }
    return { safeErrorCode: "bad-request", retryable: false };
  }
  return { safeErrorCode: "bad-request", retryable: false };
}

/**
 * createForumTopic-aware classification: a "topic" word here is about the
 * FORUM feature (disabled) or the manage-topics permission, NEVER a missing
 * topic - creation cannot fail because a topic is missing. Forum-disabled and
 * manage-topics permission errors get distinct safe codes.
 */
export function classifyCreateForumTopicError(
  status: number,
  body: TelegramApiResponse,
): ClassifiedTelegramError {
  const common = classifyCommonTelegramError(status, body);
  if (common !== null) {
    return common;
  }
  const d = (body.description ?? "").toLowerCase();
  if (status === 400) {
    if (d.includes("chat not found")) {
      return { safeErrorCode: "chat-not-found", retryable: false };
    }
    // Permission patterns are checked BEFORE any broad forum/topic wording
    // (fix/worker-telegram-token-env-contract §9): Telegram phrases a
    // missing-permission error as "not enough rights to create a forum topic",
    // which contains "forum" — so a bare `includes("forum")` mislabels a real
    // permission error as `topics-disabled`. An administrator who simply lacks
    // the Manage Topics right must map to `manage-topics-required`, never
    // `topics-disabled`.
    if (
      d.includes("not enough rights") ||
      d.includes("chat_admin_required") ||
      d.includes("manage topics") ||
      d.includes("manage_topics") ||
      d.includes("need administrator") ||
      d.includes("need to be an administrator")
    ) {
      return { safeErrorCode: "manage-topics-required", retryable: false };
    }
    // Only now (after permission wording is excluded) does broad forum/topic
    // wording mean the forum feature itself is off / the chat is not a forum.
    if (
      d.includes("not a forum") ||
      d.includes("is not a forum") ||
      d.includes("topics_disabled") ||
      d.includes("forum")
    ) {
      return { safeErrorCode: "topics-disabled", retryable: false };
    }
    return { safeErrorCode: "bad-request", retryable: false };
  }
  return { safeErrorCode: "bad-request", retryable: false };
}

/** Generic classification for transaction/read calls (no chat/topic context). */
function classifyGenericTelegramError(
  status: number,
  body: TelegramApiResponse,
): ClassifiedTelegramError {
  const common = classifyCommonTelegramError(status, body);
  if (common !== null) {
    return common;
  }
  const d = (body.description ?? "").toLowerCase();
  if (status === 400 && d.includes("chat not found")) {
    return { safeErrorCode: "chat-not-found", retryable: false };
  }
  return { safeErrorCode: "bad-request", retryable: false };
}

/** Distinguishes an AbortController timeout from any other fetch failure. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Sends a plain-text message (no parse_mode - operator text may contain
 * characters that would break Markdown/HTML entity parsing).
 */
/**
 * A minimal inline keyboard (rows of {text, callback_data}). Passed through to
 * Telegram's reply_markup verbatim - the caller builds only safe callback data
 * (never a secret / full entity id). Plain-text messages, no parse_mode, so the
 * label + callback are the only surface.
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export async function sendTelegramMessage(input: {
  token: string;
  chatId: string;
  text: string;
  messageThreadId?: number;
  replyMarkup?: InlineKeyboardMarkup;
}): Promise<TelegramSendResult> {
  const payload: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text.slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (input.messageThreadId !== undefined) {
    payload.message_thread_id = input.messageThreadId;
  }
  if (input.replyMarkup !== undefined) {
    payload.reply_markup = input.replyMarkup;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), telegramApiTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // A timeout (AbortController) and any other network failure are the only
    // things logged, and ONLY as a fixed safe category - never the error text,
    // token URL, chat id or topic id.
    if (isAbortError(err)) {
      logger.warn("telegram sendMessage failed", { category: "telegram-timeout" });
      return { ok: false, safeErrorCode: "telegram-timeout", retryable: true };
    }
    logger.warn("telegram sendMessage failed", { category: "network-error" });
    return { ok: false, safeErrorCode: "network-error", retryable: true };
  } finally {
    clearTimeout(timer);
  }
  let body: TelegramApiResponse = {};
  try {
    body = (await response.json()) as TelegramApiResponse;
  } catch {
    // Non-JSON body (proxy error page, ...) - fall through to status handling.
  }
  if (response.ok && body.ok === true) {
    const messageId = body.result?.message_id;
    return { ok: true, messageId: typeof messageId === "number" ? messageId : 0 };
  }
  return { ok: false, ...classifySendMessageError(response.status, body) };
}

export type TelegramForumTopicResult =
  | { ok: true; messageThreadId: number }
  | { ok: false; safeErrorCode: string; retryable: boolean; retryAfterMs?: number };

/**
 * Creates a forum topic in the target supergroup for the direct-log-group
 * setup provisioning. Same token-scrubbing + safe-code classification as
 * sendTelegramMessage - the token appears only in the request URL, never in
 * an error, log or return value.
 */
export async function createTelegramForumTopic(input: {
  token: string;
  chatId: string;
  name: string;
}): Promise<TelegramForumTopicResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), telegramApiTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/createForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: input.chatId, name: input.name.slice(0, 128) }),
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      logger.warn("telegram createForumTopic failed", { category: "telegram-timeout" });
      return { ok: false, safeErrorCode: "telegram-timeout", retryable: true };
    }
    logger.warn("telegram createForumTopic failed", { category: "network-error" });
    return { ok: false, safeErrorCode: "network-error", retryable: true };
  } finally {
    clearTimeout(timer);
  }
  let body: (TelegramApiResponse & { result?: { message_thread_id?: number } }) = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON body - fall through to status handling.
  }
  if (response.ok && body.ok === true) {
    const threadId = body.result?.message_thread_id;
    // A message_thread_id must be a positive, safe-range integer before it is
    // ever persisted as a delivery target; anything else is a bad response.
    if (
      typeof threadId === "number" &&
      Number.isInteger(threadId) &&
      threadId > 0 &&
      Number.isSafeInteger(threadId)
    ) {
      return { ok: true, messageThreadId: threadId };
    }
    return { ok: false, safeErrorCode: "bad-response", retryable: true };
  }
  return { ok: false, ...classifyCreateForumTopicError(response.status, body) };
}

// =============================================================================
// getStarTransactions (Phase 2.1) — the WORKER's read side of the centralized Bot
// API client, used ONLY for transaction recovery. Bounded timeout, one transient
// retry, 429 retry-after honoured, response shape validated, token never logged,
// raw Telegram response never returned or persisted (only the safe subset below).
// The bot process performs refundStarPayment/editUserStarSubscription via its
// native grammY Api — this client never mutates money.
// =============================================================================

/** The safe subset of a StarTransaction the worker keeps (never the raw object). */
export interface WorkerStarTransaction {
  id: string;
  amount: number;
  /** Unix seconds. */
  date: number;
  /** Present on incoming (payment) transactions. */
  source?: WorkerStarTransactionPartner;
  /** Present on outgoing (refund/withdrawal) transactions. */
  receiver?: WorkerStarTransactionPartner;
}

export interface WorkerStarTransactionPartner {
  type?: string;
  transaction_type?: string;
  user?: { id?: number };
  invoice_payload?: string;
  subscription_period?: number;
}

export type GetStarTransactionsResult =
  | { ok: true; transactions: WorkerStarTransaction[] }
  | { ok: false; safeErrorCode: string; retryable: boolean; retryAfterMs?: number };

const STAR_TX_TIMEOUT_MS = 20_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps ONLY the safe partner subset; drops anything unexpected. */
function normalizePartner(raw: unknown): WorkerStarTransactionPartner | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  const partner: WorkerStarTransactionPartner = {};
  if (typeof raw.type === "string") partner.type = raw.type;
  if (typeof raw.transaction_type === "string") partner.transaction_type = raw.transaction_type;
  if (isPlainRecord(raw.user) && typeof raw.user.id === "number") partner.user = { id: raw.user.id };
  if (typeof raw.invoice_payload === "string") partner.invoice_payload = raw.invoice_payload;
  if (typeof raw.subscription_period === "number") partner.subscription_period = raw.subscription_period;
  return partner;
}

/** Validates one transaction; returns null when the shape is not usable. */
function normalizeTransaction(raw: unknown): WorkerStarTransaction | null {
  if (!isPlainRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.amount !== "number" || typeof raw.date !== "number") return null;
  return {
    id: raw.id,
    amount: raw.amount,
    date: raw.date,
    source: normalizePartner(raw.source),
    receiver: normalizePartner(raw.receiver),
  };
}

async function callGetStarTransactionsOnce(input: {
  token: string;
  offset: number;
  limit: number;
}): Promise<GetStarTransactionsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAR_TX_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/getStarTransactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: input.offset, limit: input.limit }),
      signal: controller.signal,
    });
  } catch (err) {
    // Token lives only in the request URL and is never logged - only a fixed
    // safe category (timeout vs any other network failure).
    if (isAbortError(err)) {
      logger.warn("getStarTransactions failed", { category: "telegram-timeout" });
      return { ok: false, safeErrorCode: "telegram-timeout", retryable: true };
    }
    logger.warn("getStarTransactions failed", { category: "network-error" });
    return { ok: false, safeErrorCode: "network-error", retryable: true };
  } finally {
    clearTimeout(timer);
  }
  let body: (TelegramApiResponse & { result?: { transactions?: unknown } }) = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON — fall through to status classification.
  }
  if (response.ok && body.ok === true) {
    const rawList = body.result?.transactions;
    if (!Array.isArray(rawList)) {
      return { ok: false, safeErrorCode: "bad-response", retryable: false };
    }
    const transactions: WorkerStarTransaction[] = [];
    for (const item of rawList) {
      const tx = normalizeTransaction(item);
      if (tx !== null) transactions.push(tx);
    }
    return { ok: true, transactions };
  }
  return { ok: false, ...classifyGenericTelegramError(response.status, body) };
}

/**
 * Fetches one bounded page of Star transactions (offset pagination). `limit` is
 * clamped to Telegram's 1..100; `offset` is floored at 0. One transient-failure
 * retry (honouring a 429 retry-after) then gives up — the caller does not advance
 * its persistent cursor on failure.
 */
export async function getStarTransactions(input: {
  token: string;
  offset?: number;
  limit?: number;
}): Promise<GetStarTransactionsResult> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 100)));
  const first = await callGetStarTransactionsOnce({ token: input.token, offset, limit });
  if (first.ok || !first.retryable) {
    return first;
  }
  // One bounded retry for a transient failure. Respect a 429 retry-after (capped).
  const waitMs = Math.min(first.retryAfterMs ?? 1_000, 10_000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return callGetStarTransactionsOnce({ token: input.token, offset, limit });
}
