import { UserStatus } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { InlineKeyboard, type MiddlewareFn } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { getBooleanSetting } from "../services/settings.service.js";
import { getMessageTemplate } from "../services/text.service.js";
import { registerOrUpdateUser } from "../services/user.service.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";

export const ACCESS_DENIED_TEXT =
  "حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید.";
const TERMS_TEXT_FALLBACK = "برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید.";
const FORCE_JOIN_TEXT_FALLBACK = "برای ادامه، ابتدا در کانال‌های مشخص‌شده عضو شوید.";

/**
 * User access gate, in spec order:
 *   1. bot disabled (maintenance_mode)      -> bot_off_text
 *   2. user status BLOCKED/DISABLED/DELETED -> access denied
 *   3. terms placeholder (terms_required)   -> accept button
 *   4. force-join placeholder               -> check button
 *
 * Returns true when the user may proceed. Sends the blocking message itself
 * otherwise. Also guarantees ctx.dbUser is set for downstream handlers.
 */
export async function ensureUserAccess(ctx: BotContext): Promise<boolean> {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    return false;
  }

  // Callbacks arriving before the user ever sent /start (fresh database,
  // old chat keyboards): register on the fly.
  if (ctx.dbUser === null) {
    try {
      ctx.dbUser = await registerOrUpdateUser(from);
    } catch (err) {
      logger.error("user registration failed", { error: errorMessage(err) });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, GENERIC_ERROR_TEXT);
      return false;
    }
  }
  const user = ctx.dbUser;
  const callbackData = ctx.callbackQuery?.data;

  // 1. Bot disabled
  if (await getBooleanSetting("maintenance_mode", false)) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("bot_off_text"));
    return false;
  }

  // 2. Blocked / disabled / deleted users never reach the user menu.
  if (user.status !== UserStatus.ACTIVE) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("blocked_text", ACCESS_DENIED_TEXT));
    return false;
  }

  // 3. Terms placeholder (skipped for the accept action itself).
  if (
    callbackData !== CB.TERMS_ACCEPT &&
    user.termsAcceptedAt === null &&
    (await getBooleanSetting("terms_required", false))
  ) {
    await safeAnswerCallback(ctx);
    const text = await getMessageTemplate("terms_text", TERMS_TEXT_FALLBACK);
    await safeReply(ctx, text, new InlineKeyboard().text("تایید قوانین ✅", CB.TERMS_ACCEPT));
    return false;
  }

  // 4. Force-join placeholder (skipped for the check action itself).
  if (
    callbackData !== CB.FORCE_JOIN_CHECK &&
    !user.forceJoinBypass &&
    (await getBooleanSetting("force_join_enabled", false))
  ) {
    await safeAnswerCallback(ctx);
    const text = await getMessageTemplate("force_join_text", FORCE_JOIN_TEXT_FALLBACK);
    await safeReply(ctx, text, new InlineKeyboard().text("عضو شدم ✅", CB.FORCE_JOIN_CHECK));
    return false;
  }

  return true;
}

/** Middleware form of ensureUserAccess for user-facing composers. */
export function userAccessMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (await ensureUserAccess(ctx)) {
      await next();
    }
  };
}
