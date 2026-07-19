import { createLogger, errorMessage } from "@zedbot/shared";

// =============================================================================
// Minimal Telegram Bot API client (sendMessage only) used by the notification
// and log-delivery consumers. The bot token is embedded only in the request
// URL and is NEVER included in errors, logs or return values - every failure
// is collapsed to a short safe error code.
// =============================================================================

const logger = createLogger("worker:telegram");

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; safeErrorCode: string; retryable: boolean; retryAfterMs?: number };

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

/** Maps a Telegram error response to a short safe code + retryability. */
function classifyTelegramError(status: number, body: TelegramApiResponse): TelegramSendResult {
  const description = (body.description ?? "").toLowerCase();
  if (status === 429) {
    const retryAfter = body.parameters?.retry_after;
    return {
      ok: false,
      safeErrorCode: "rate-limited",
      retryable: true,
      retryAfterMs: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : 5_000,
    };
  }
  if (status === 403) {
    return { ok: false, safeErrorCode: "forbidden", retryable: false };
  }
  if (status === 400) {
    if (description.includes("chat not found")) {
      return { ok: false, safeErrorCode: "chat-not-found", retryable: false };
    }
    if (description.includes("thread not found") || description.includes("topic")) {
      return { ok: false, safeErrorCode: "topic-missing", retryable: false };
    }
    return { ok: false, safeErrorCode: "bad-request", retryable: false };
  }
  return { ok: false, safeErrorCode: `telegram-${status}`, retryable: status >= 500 };
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
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure; the error object cannot contain the token URL
    // in a form we log - we only emit the generic classification.
    logger.warn("telegram sendMessage network error", { error: errorMessage(err).slice(0, 120) });
    return { ok: false, safeErrorCode: "network-error", retryable: true };
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
  return classifyTelegramError(response.status, body);
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
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/createForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: input.chatId, name: input.name.slice(0, 128) }),
    });
  } catch (err) {
    logger.warn("telegram createForumTopic network error", {
      error: errorMessage(err).slice(0, 120),
    });
    return { ok: false, safeErrorCode: "network-error", retryable: true };
  }
  let body: (TelegramApiResponse & { result?: { message_thread_id?: number } }) = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON body - fall through to status handling.
  }
  if (response.ok && body.ok === true) {
    const threadId = body.result?.message_thread_id;
    if (typeof threadId === "number") {
      return { ok: true, messageThreadId: threadId };
    }
    return { ok: false, safeErrorCode: "bad-response", retryable: true };
  }
  const classified = classifyTelegramError(response.status, body);
  // classifyTelegramError returns a send-shaped failure; reshape to the topic
  // result (identical fields).
  return classified as TelegramForumTopicResult;
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
    // Token lives only in the request URL and is never present in the error we log.
    logger.warn("getStarTransactions network error", { error: errorMessage(err).slice(0, 120) });
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
  return classifyTelegramError(response.status, body) as GetStarTransactionsResult;
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
