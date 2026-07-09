import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import { acceptTerms, registerOrUpdateUser } from "../services/user.service.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

/**
 * "accept_terms" placeholder: stamps termsAcceptedAt, then re-runs the access
 * gates (force-join may still apply) before showing the menu.
 */
export const termsHandler = new Composer<BotContext>();

termsHandler.callbackQuery(CB.TERMS_ACCEPT, async (ctx) => {
  const from = ctx.from;
  if (from === undefined) {
    return;
  }
  try {
    if (ctx.dbUser === null) {
      ctx.dbUser = await registerOrUpdateUser(from);
    }
    ctx.dbUser = await acceptTerms(ctx.dbUser.id);
    await safeAnswerCallback(ctx, "قوانین تایید شد ✅");
  } catch (err) {
    logger.error("accepting terms failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
    return;
  }
  if (await ensureUserAccess(ctx)) {
    await showUserMenu(ctx);
  }
});
