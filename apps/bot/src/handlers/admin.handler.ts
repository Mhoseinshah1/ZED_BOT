import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildAdminMainKeyboard } from "../keyboards/admin-main.keyboard.js";
import { buildAdminMainReplyKeyboard } from "../keyboards/admin-menu-definition.js";
import { getAdminMenuMode } from "../services/menu-mode.service.js";
import {
  safeAnswerCallback,
  safeEditOrReply,
  safeReply,
  safeReplyWithMarkup,
} from "../utils/safe-reply.js";
import { MENU_MODE_CHANGED_TEXT } from "./menu.handler.js";
import { clearAdminBroadcastState } from "./admin-broadcast/broadcast.handler.js";
import { clearAdminPaymentState } from "./admin-finance/admin-finance.handler.js";
import { clearManualOrderState } from "./admin-manual-orders/manual-orders.handler.js";
import { clearAdminTextSettingsState } from "./admin-settings/text-settings.handler.js";
import { clearAdminStockState } from "./admin-stock/stock.handler.js";
import { clearAdminSupportState } from "./admin-support/support-admin.handler.js";
import { clearAdminUsersState } from "./admin-users/admin-users.handler.js";
import { clearCheckoutState } from "./user-checkout/checkout-state.js";
import { clearSupportState } from "./user-support/support.handler.js";

export const ADMIN_MENU_TEXT = "پنل مدیریت 🛠\n\nیک بخش را انتخاب کنید:";

/**
 * Renders the admin main menu in the configured admin keyboard mode
 * (admin-menu-keyboard-mode phase). Callers must already be behind admin
 * auth. INLINE keeps the historical behavior exactly; REPLY sends the same
 * approved menu as a persistent reply keyboard (always a fresh message -
 * Telegram cannot attach reply keyboards via edit), REPLACING whatever
 * persistent keyboard (user or admin) is on screen. Rendering INLINE while
 * a stale persistent keyboard is up removes it exactly once, quietly.
 */
export async function showAdminMenu(ctx: BotContext): Promise<void> {
  const mode = await getAdminMenuMode();
  if (mode === "REPLY") {
    if (ctx.callbackQuery !== undefined) {
      await safeAnswerCallback(ctx);
    }
    await safeReplyWithMarkup(ctx, ADMIN_MENU_TEXT, await buildAdminMainReplyKeyboard(ctx.admin));
    ctx.session.adminReplyMenuKeyboardActive = true;
    ctx.session.replyMenuKeyboardActive = false;
  } else {
    if (
      ctx.session.adminReplyMenuKeyboardActive === true ||
      ctx.session.replyMenuKeyboardActive === true
    ) {
      await safeReplyWithMarkup(ctx, MENU_MODE_CHANGED_TEXT, { remove_keyboard: true });
      ctx.session.adminReplyMenuKeyboardActive = false;
      ctx.session.replyMenuKeyboardActive = false;
    }
    const keyboard = await buildAdminMainKeyboard(ctx.admin);
    if (ctx.callbackQuery !== undefined) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, ADMIN_MENU_TEXT, keyboard);
    } else {
      await safeReply(ctx, ADMIN_MENU_TEXT, keyboard);
    }
  }
  // Entering admin mode abandons any user checkout draft (separate surface),
  // any Phase 20 admin-users state (wallet draft + stored search query),
  // any Phase 21 payment-method configuration draft and any Phase 23
  // manual-order delivery draft.
  clearCheckoutState(ctx);
  clearAdminUsersState(ctx);
  clearAdminPaymentState(ctx);
  clearManualOrderState(ctx);
  clearAdminStockState(ctx);
  clearSupportState(ctx);
  clearAdminSupportState(ctx);
  clearAdminBroadcastState(ctx);
  clearAdminTextSettingsState(ctx);
  ctx.session.currentFlow = null;
  ctx.session.lastMenu = "admin_main";
}

// /admin command + admin menu callback. Runs behind adminAuthMiddleware.
export const adminHandler = new Composer<BotContext>();

adminHandler.command("admin", showAdminMenu);
adminHandler.callbackQuery(CB.ADMIN_MENU, showAdminMenu);
