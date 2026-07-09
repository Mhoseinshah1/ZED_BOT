import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import { applyReferralIfEligible } from "../services/referral.service.js";
import { registerOrUpdateUser } from "../services/user.service.js";
import { getStartPayload } from "../utils/telegram.js";
import { safeReply } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

/**
 * /start flow, in spec order:
 *   1. register or refresh the user (referralCode = telegramId when missing)
 *   2. apply the referral payload when eligible (never fails /start)
 *   3. access gates (bot off / status / terms / force join)
 *   4. main menu
 */
export const startHandler = new Composer<BotContext>();

startHandler.command("start", async (ctx) => {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    return;
  }

  try {
    ctx.dbUser = await registerOrUpdateUser(from);
  } catch (err) {
    logger.error("user registration failed on /start", { error: errorMessage(err) });
    await safeReply(ctx, GENERIC_ERROR_TEXT);
    return;
  }

  const payload = getStartPayload(ctx);
  if (payload !== null) {
    await applyReferralIfEligible(ctx.dbUser, payload);
    // The referral may have updated the user row; keep the context fresh.
    ctx.dbUser = { ...ctx.dbUser };
  }

  if (await ensureUserAccess(ctx)) {
    await showUserMenu(ctx);
  }
});
