import { errorMessage } from "@zedbot/shared";
import type { InlineKeyboard, InputFile, Keyboard } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";

export interface ReplyOptions {
  /**
   * Telegram parse mode. Only set this when the text is guaranteed valid
   * for that mode (dynamic values escaped, e.g. with escapeHtml for "HTML").
   * There is deliberately no global default - plain text stays plain.
   */
  parseMode?: "HTML" | "MarkdownV2";
}

function buildOther(
  keyboard?: InlineKeyboard,
  options?: ReplyOptions,
): { reply_markup?: InlineKeyboard; parse_mode?: "HTML" | "MarkdownV2" } | undefined {
  if (keyboard === undefined && options?.parseMode === undefined) {
    return undefined;
  }
  return {
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    ...(options?.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
  };
}

/** Replies without ever throwing (blocked users, closed chats, ...). */
export async function safeReply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
  options?: ReplyOptions,
): Promise<void> {
  try {
    await ctx.reply(text, buildOther(keyboard, options));
  } catch (err) {
    logger.debug("reply failed", { error: errorMessage(err) });
  }
}

/**
 * Replies with an arbitrary reply markup (reply keyboards, keyboard
 * removal) without ever throwing. Reply keyboards cannot be applied via
 * editMessageText, so menu-keyboard-mode sends always go through a fresh
 * reply - this is the one helper that accepts non-inline markup.
 */
export async function safeReplyWithMarkup(
  ctx: BotContext,
  text: string,
  replyMarkup: Keyboard | InlineKeyboard | { remove_keyboard: true },
): Promise<void> {
  try {
    await ctx.reply(text, { reply_markup: replyMarkup });
  } catch (err) {
    logger.debug("reply with markup failed", { error: errorMessage(err) });
  }
}

/**
 * Sends a photo (an in-memory InputFile) without ever throwing - a blocked user
 * or deleted chat resolves to `false`, a success to `true`. The caller stays
 * fail-soft (falls back to the copyable text link). Only the safe Telegram error
 * class is logged; the caption/keyboard/image bytes never appear in the log.
 */
export async function safeReplyWithPhoto(
  ctx: BotContext,
  photo: InputFile,
  opts: { caption: string; keyboard?: InlineKeyboard },
): Promise<boolean> {
  try {
    await ctx.replyWithPhoto(photo, {
      caption: opts.caption,
      ...(opts.keyboard === undefined ? {} : { reply_markup: opts.keyboard }),
    });
    return true;
  } catch (err) {
    logger.debug("reply with photo failed", { error: errorMessage(err) });
    return false;
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
  options?: ReplyOptions,
): Promise<void> {
  if (ctx.callbackQuery?.message !== undefined) {
    try {
      await ctx.editMessageText(text, buildOther(keyboard, options));
      return;
    } catch (err) {
      logger.debug("editMessageText failed, falling back to reply", {
        error: errorMessage(err),
      });
    }
  }
  await safeReply(ctx, text, keyboard, options);
}
