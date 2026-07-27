import { createLogger, getTelegramBotToken, intEnv } from "@zedbot/shared";

import type { ForceJoinMembershipApi } from "./membership.js";

// =============================================================================
// A minimal `getChatMember` client for processes that do not run grammY.
//
// The API must evaluate the same Force Join gate as the bot, and the gate is
// only meaningful if membership is read LIVE from Telegram. grammY cannot be
// imported here (it carries the whole bot runtime), so this is the one call the
// checker needs, over plain `fetch`.
//
// It throws errors in grammY's shape — `{ error_code, description }` — so
// `classifyMemberCheckError` sees exactly what it sees in the bot and both
// processes reach the same verdict on the same failure. That shape is the
// contract; a network failure or timeout deliberately carries NO `error_code`,
// which the classifier reads as transient and fails closed on.
//
// The bot token appears only in the request URL. It is never logged, never
// returned, and never part of an error.
// =============================================================================

const logger = createLogger("force-join:telegram");

/** Bounded per-request timeout (FORCE_JOIN_TELEGRAM_TIMEOUT_MS, 5s, 1s..15s). */
const TIMEOUT_DEFAULT_MS = 5_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 15_000;

export function forceJoinTelegramTimeoutMs(): number {
  const raw = intEnv("FORCE_JOIN_TELEGRAM_TIMEOUT_MS", TIMEOUT_DEFAULT_MS);
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, raw));
}

/**
 * An error shaped like grammY's `GrammyError`, so one classifier serves both.
 *
 * `error_code` is present ONLY when Telegram actually answered with one. A
 * timeout or socket failure leaves it undefined on purpose — the classifier
 * treats a code-less failure as TEMP and the gate fails closed, which is the
 * correct reading of "we do not know whether this user is a member".
 */
export class ForceJoinTelegramError extends Error {
  readonly error_code?: number;
  readonly description: string;

  constructor(description: string, errorCode?: number) {
    super(description);
    this.name = "ForceJoinTelegramError";
    this.description = description;
    if (errorCode !== undefined) {
      this.error_code = errorCode;
    }
  }
}

interface GetChatMemberResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
  result?: { status?: string; is_member?: boolean };
}

/**
 * Builds a `getChatMember` surface bound to a bot token.
 *
 * Returns null when no token is configured: the caller must then treat
 * membership as unknown and fail closed rather than silently pass everyone.
 */
export function httpForceJoinMembershipApi(
  token: string | null = getTelegramBotToken(),
): ForceJoinMembershipApi | null {
  if (token === null || token === "") {
    return null;
  }
  return {
    async getChatMember(chatId, userId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), forceJoinTelegramTimeoutMs());
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, user_id: userId }),
          signal: controller.signal,
        });
      } catch (err) {
        // Only a fixed safe category is logged — never the URL (it carries the
        // token), the chat id or the user id.
        const timedOut =
          err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        logger.warn("force-join getChatMember failed", {
          category: timedOut ? "timeout" : "network-error",
        });
        // No error_code → classified TEMP → the gate fails closed.
        throw new ForceJoinTelegramError(timedOut ? "request timed out" : "network error");
      } finally {
        clearTimeout(timer);
      }

      let body: GetChatMemberResponse = {};
      try {
        body = (await response.json()) as GetChatMemberResponse;
      } catch {
        // Non-JSON body (proxy error page, …) — fall through to status handling.
      }

      if (response.ok && body.ok === true && typeof body.result?.status === "string") {
        return { status: body.result.status, is_member: body.result.is_member };
      }
      // Telegram's own code when it gave one, else the HTTP status. The
      // description is passed through verbatim because the classifier matches on
      // it; it never contains the token and is not user-facing.
      throw new ForceJoinTelegramError(
        body.description ?? `unexpected response (${response.status})`,
        body.error_code ?? response.status,
      );
    },
  };
}
