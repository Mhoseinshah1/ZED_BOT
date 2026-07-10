import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildAdminMainKeyboard } from "../keyboards/admin-main.keyboard.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../utils/safe-reply.js";
import { clearAdminPaymentState } from "./admin-finance/admin-finance.handler.js";
import { clearManualOrderState } from "./admin-manual-orders/manual-orders.handler.js";
import { clearAdminUsersState } from "./admin-users/admin-users.handler.js";
import { clearCheckoutState } from "./user-checkout/checkout-state.js";

const ADMIN_MENU_TEXT = "پنل مدیریت 🛠\n\nیک بخش را انتخاب کنید:";

/** Renders the admin main menu. Callers must already be behind admin auth. */
export async function showAdminMenu(ctx: BotContext): Promise<void> {
  const keyboard = buildAdminMainKeyboard();
  if (ctx.callbackQuery !== undefined) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, ADMIN_MENU_TEXT, keyboard);
  } else {
    await safeReply(ctx, ADMIN_MENU_TEXT, keyboard);
  }
  // Entering admin mode abandons any user checkout draft (separate surface),
  // any Phase 20 admin-users state (wallet draft + stored search query),
  // any Phase 21 payment-method configuration draft and any Phase 23
  // manual-order delivery draft.
  clearCheckoutState(ctx);
  clearAdminUsersState(ctx);
  clearAdminPaymentState(ctx);
  clearManualOrderState(ctx);
  ctx.session.currentFlow = null;
  ctx.session.lastMenu = "admin_main";
}

// /admin command + admin menu callback. Runs behind adminAuthMiddleware.
export const adminHandler = new Composer<BotContext>();

adminHandler.command("admin", showAdminMenu);
adminHandler.callbackQuery(CB.ADMIN_MENU, showAdminMenu);
