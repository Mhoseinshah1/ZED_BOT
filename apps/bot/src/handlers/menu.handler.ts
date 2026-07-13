import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildUserMainKeyboard } from "../keyboards/user-main.keyboard.js";
import { getBooleanSetting, getSetting } from "../services/settings.service.js";
import { getMessageTemplateOmitMissing } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../utils/safe-reply.js";
import { clearCheckoutState } from "./user-checkout/checkout-state.js";

/** Persian sales-status values for the start template (U-MENU-001). */
export const SALES_STATUS_OPEN_TEXT = "فعال ✅";
export const SALES_STATUS_CLOSED_TEXT = "موقتاً غیرفعال";

/** Renders the main user menu (start_text + inline keyboard). */
export async function showUserMenu(ctx: BotContext): Promise<void> {
  // start_text variables (U-MENU-001): missing values (e.g. no telegram
  // username) cleanly REMOVE their lines - never an empty placeholder. The
  // menu is sent as plain text, so no HTML escaping applies here.
  const [botName, maintenance] = await Promise.all([
    getSetting("bot_name", "ZED_BOT"),
    getBooleanSetting("maintenance_mode", false),
  ]);
  const firstName = ctx.from?.first_name?.trim();
  const username = ctx.from?.username?.trim();
  const text = await getMessageTemplateOmitMissing("start_text", {
    first_name: firstName !== undefined && firstName !== "" ? firstName : "کاربر",
    username: username !== undefined && username !== "" ? `@${username}` : undefined,
    bot_name: botName,
    sales_status: maintenance ? SALES_STATUS_CLOSED_TEXT : SALES_STATUS_OPEN_TEXT,
  });
  const keyboard = await buildUserMainKeyboard();
  if (ctx.callbackQuery !== undefined) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, text, keyboard);
  } else {
    await safeReply(ctx, text, keyboard);
  }
  clearCheckoutState(ctx);
  ctx.session.currentFlow = null;
  ctx.session.lastMenu = "user_main";
}

// /menu command + menu/back callbacks. Runs behind the user access guard.
export const menuHandler = new Composer<BotContext>();

menuHandler.command("menu", showUserMenu);
menuHandler.callbackQuery([CB.USER_MENU, CB.COMMON_BACK], showUserMenu);
