import { errorMessage } from "@zedbot/shared";
import { GrammyError, HttpError, type Bot } from "grammy";

import { logger } from "./logger.js";
import type { BotContext } from "./context.js";

export const GENERIC_ERROR_TEXT = "خطایی رخ داد. لطفاً دوباره تلاش کنید.";

/**
 * Central error boundary: the bot must never crash on a handler error.
 * Errors are logged safely (never the token, never full payload dumps) and
 * the user gets a generic Persian message when a reply is possible.
 */
export function registerErrorHandler(bot: Bot<BotContext>): void {
  bot.catch(async (err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      logger.error("telegram api error", {
        method: e.method,
        error_code: e.error_code,
        description: e.description,
      });
    } else if (e instanceof HttpError) {
      logger.error("network error while contacting telegram", { error: errorMessage(e.error) });
    } else {
      logger.error("unhandled bot error", { error: errorMessage(e) });
    }

    // Best-effort user feedback; never throw from the error handler itself.
    try {
      const ctx = err.ctx;
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery({ text: GENERIC_ERROR_TEXT });
      } else if (ctx.chat !== undefined) {
        await ctx.reply(GENERIC_ERROR_TEXT);
      }
    } catch {
      // Ignore - reporting the error must not cause another error loop.
    }
  });
}
