import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { getButtonText } from "../services/text.service.js";

/** Main user menu - button texts come from the database (operator-editable). */
export async function buildUserMainKeyboard(): Promise<InlineKeyboard> {
  const [
    buy,
    renew,
    extraVolume,
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
    getButtonText("extra_volume"),
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
    .text(extraVolume, CB.USER_EXTRA_VOLUME)
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
