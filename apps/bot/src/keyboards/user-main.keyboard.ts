import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { getButtonText } from "../services/text.service.js";

/**
 * Main user menu - button texts come from the database (operator-editable).
 * Phase 18.1: «خرید حجم اضافه ➕»/«خرید زمان اضافه ⏳» moved OFF the main
 * menu into the service detail page («سرویس‌های من 🛍» → select a service) -
 * they act on one existing service, so they live next to it. The old
 * CB.USER_EXTRA_VOLUME / CB.USER_EXTRA_TIME handlers stay registered for
 * old Telegram messages that still show the removed buttons.
 */
export async function buildUserMainKeyboard(): Promise<InlineKeyboard> {
  const [
    buy,
    renew,
    services,
    wallet,
    referral,
    freeTest,
    wheel,
    tutorials,
    support,
    pricing,
    representative,
    otherProducts,
  ] = await Promise.all([
    getButtonText("buy_subscription"),
    getButtonText("renew_service"),
    getButtonText("my_services"),
    getButtonText("wallet"),
    getButtonText("referral"),
    getButtonText("free_test"),
    getButtonText("lucky_wheel"),
    getButtonText("tutorials"),
    getButtonText("support"),
    getButtonText("pricing"),
    getButtonText("representative_request"),
    getButtonText("other_products"),
  ]);

  return new InlineKeyboard()
    .text(buy, CB.USER_BUY)
    .text(renew, CB.USER_RENEW)
    .row()
    .text(services, CB.USER_SERVICES)
    .text(wallet, CB.USER_WALLET)
    .row()
    .text(referral, CB.USER_REFERRAL)
    .text(freeTest, CB.USER_FREE_TEST)
    .row()
    .text(wheel, CB.USER_WHEEL)
    .text(tutorials, CB.USER_TUTORIALS)
    .row()
    .text(support, CB.USER_SUPPORT)
    .text(pricing, CB.USER_PRICING)
    .row()
    .text(representative, CB.USER_REPRESENTATIVE)
    .text(otherProducts, CB.USER_OTHER_PRODUCTS);
}
