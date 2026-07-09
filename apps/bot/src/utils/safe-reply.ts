import { errorMessage } from "@zedbot/shared";
import type { InlineKeyboard } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";

/** Replies without ever throwing (blocked users, closed chats, ...). */
export async function safeReply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.reply(text, keyboard === undefined ? undefined : { reply_markup: keyboard });
  } catch (err) {
    logger.debug("reply failed", { error: errorMessage(err) });
  }
}

/** Answers a callback query without throwing (stops the loading spinner). */
export async function safeAnswerCallback(ctx: BotContext, text?: string): Promise<void> {
  if (ctx.callbackQuery === undefined) {
    return;
  }
  try {
    await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
  } catch (err) {
    logger.debug("answerCallbackQuery failed", { error: errorMessage(err) });
  }
}

/**
 * For callback interactions: edits the message in place when possible and
 * falls back to a fresh reply ("message is not modified", deleted messages,
 * media messages, ...). For plain messages it always replies.
 */
export async function safeEditOrReply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const markup = keyboard === undefined ? undefined : { reply_markup: keyboard };
  if (ctx.callbackQuery?.message !== undefined) {
    try {
      await ctx.editMessageText(text, markup);
      return;
    } catch (err) {
      logger.debug("editMessageText failed, falling back to reply", {
        error: errorMessage(err),
      });
    }
  }
  await safeReply(ctx, text, keyboard);
}
