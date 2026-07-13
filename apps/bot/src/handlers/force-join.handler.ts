import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import { safeAnswerCallback } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

/**
 * "check_join" placeholder: real getChatMember verification arrives in a
 * later phase. For now the check always "passes" and shows the menu (the
 * remaining gates still run).
 */
export const forceJoinHandler = new Composer<BotContext>();

forceJoinHandler.callbackQuery(CB.FORCE_JOIN_CHECK, async (ctx) => {
  await safeAnswerCallback(ctx, "عضویت شما ثبت شد ✅");
  if (await ensureUserAccess(ctx)) {
    await showUserMenu(ctx);
  }
});
