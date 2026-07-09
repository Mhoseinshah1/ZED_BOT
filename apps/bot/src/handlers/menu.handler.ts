import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildUserMainKeyboard } from "../keyboards/user-main.keyboard.js";
import { getMessageTemplate } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../utils/safe-reply.js";

/** Renders the main user menu (start_text + inline keyboard). */
export async function showUserMenu(ctx: BotContext): Promise<void> {
  const text = await getMessageTemplate("start_text");
  const keyboard = await buildUserMainKeyboard();
  if (ctx.callbackQuery !== undefined) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, text, keyboard);
  } else {
    await safeReply(ctx, text, keyboard);
  }
  ctx.session.currentFlow = null;
  ctx.session.lastMenu = "user_main";
}

// /menu command + menu/back callbacks. Runs behind the user access guard.
export const menuHandler = new Composer<BotContext>();

menuHandler.command("menu", showUserMenu);
menuHandler.callbackQuery([CB.USER_MENU, CB.COMMON_BACK], showUserMenu);
