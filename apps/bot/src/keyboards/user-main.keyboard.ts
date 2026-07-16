import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { isFreeTrialVisible } from "../services/free-trial.service.js";
import { getButtonText } from "../services/text.service.js";

/**
 * Main user menu - button texts come from the database (operator-editable
 * ButtonText rows; Phase 34 admin editing).
 *
 * Only IMPLEMENTED sections are visible. The unfinished placeholder
 * sections (referral, lucky_wheel, tutorials, pricing,
 * representative_request) are HIDDEN from the menu until their real flows
 * land - their callbacks stay registered in user-placeholders.handler.ts so
 * buttons on old Telegram messages keep answering instead of dead-ending.
 *
 * Free-trial phase: «اکانت تست رایگان 🎁» (ButtonText free_test) renders
 * ONLY when the feature is globally enabled AND at least one trial-ready
 * panel exists - a fully operational section or no button at all, never a
 * visible placeholder.
 *
 * LOCKED layout decisions:
 *  - «خرید اشتراک» opens the existing subscription purchase flow
 *    (CB.USER_BUY) - unchanged.
 *  - «محصولات دیگر» stays a SEPARATE section (CB.USER_OTHER_PRODUCTS) -
 *    never merged into the subscription purchase.
 */
export async function buildUserMainKeyboard(): Promise<InlineKeyboard> {
  const [buy, renew, services, wallet, otherProducts, myOrders, support, trialVisible] =
    await Promise.all([
      getButtonText("buy_subscription"),
      getButtonText("renew_service"),
      getButtonText("my_services"),
      getButtonText("wallet"),
      getButtonText("other_products"),
      getButtonText("my_orders"),
      getButtonText("support"),
      isFreeTrialVisible(),
    ]);

  const kb = new InlineKeyboard()
    .text(buy, CB.USER_BUY)
    .text(renew, CB.USER_RENEW)
    .row()
    .text(services, CB.USER_SERVICES)
    .text(wallet, CB.USER_WALLET)
    .row()
    .text(otherProducts, CB.USER_OTHER_PRODUCTS)
    .text(myOrders, CB.USER_ORDERS)
    .row();
  if (trialVisible) {
    kb.text(await getButtonText("free_test"), CB.USER_FREE_TEST).row();
  }
  return kb.text(support, CB.USER_SUPPORT);
}
