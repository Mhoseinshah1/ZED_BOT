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
export async function sendTelegramMessage(input: {
  token: string;
  chatId: string;
  text: string;
  messageThreadId?: number;
}): Promise<TelegramSendResult> {
  const payload: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text.slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (input.messageThreadId !== undefined) {
    payload.message_thread_id = input.messageThreadId;
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
