import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import { boundPlainText } from "../user-pricing/pricing-bounds.js";
import { clearCheckoutState } from "../user-checkout/checkout-state.js";

// =============================================================================
// Purchase hub (feat/admin-controlled-unified-purchase-menu, §7/§8). The
// COMBINED-mode landing page that replaces the two separate purchase buttons.
// It is a NAVIGATION surface only: opening it is read-only and enters NO
// business flow. The two choices dispatch to the EXISTING entry points
// (CB.USER_BUY → subscription flow, CB.USER_OTHER_PRODUCTS → Other Products) via
// their already-registered callbacks — no checkout engine / catalog / pricing /
// payment / order code is duplicated here. It is reachable even in SPLIT mode
// from an old inline keyboard, because the setting controls rendering only and
// never gates a flow.
// =============================================================================

/** Static page title (never operator-editable, so it can't break the layout). */
const HUB_TITLE = "🛒 خرید محصولات";

/** Safe default when the operator-editable intro template is blank. */
const HUB_INTRO_FALLBACK = "نوع محصول موردنظر خود را انتخاب کنید.";

const BACK_TO_MENU = "بازگشت به منوی اصلی";

/**
 * Conservative single-message budget: the completed payload (static title +
 * editable intro) stays well within Telegram's text limit while the buttons
 * always render. The editable intro is bounded so no operator edit can push the
 * page past the sink limit; the stored template is untouched.
 */
const HUB_SAFE_LIMIT = 3900;

/**
 * Pure, exported body composer: static title + bounded editable intro. A blank
 * template falls back to the safe default. Plain-text sink (no parse mode), so
 * no HTML escaping is required and operator text can never make Telegram reject
 * the page.
 */
export function purchaseHubBody(intro: string): string {
  const header = `${HUB_TITLE}\n\n`;
  const source = intro.trim() === "" ? HUB_INTRO_FALLBACK : intro;
  return header + boundPlainText(source, Math.max(0, HUB_SAFE_LIMIT - header.length));
}

/**
 * Renders the purchase hub. Entry for BOTH the inline callback
 * (CB.USER_PURCHASE_HUB) and the combined-mode reply-keyboard menu action.
 * Opening the hub is READ-ONLY: it calls the authoritative `clearCheckoutState`
 * so a stale discount / receipt / wallet-topup / renewal / extra-volume /
 * extra-time input flow can never remain armed behind the hub, and it creates no
 * CheckoutSession / Payment / Order / WalletTransaction / Service / stock
 * reservation. Selecting one of the two choices then enters the existing flow.
 */
export async function renderPurchaseHub(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearCheckoutState(ctx);
  await safeAnswerCallback(ctx);
  const [intro, vpnLabel, otherLabel] = await Promise.all([
    getMessageTemplate("purchase_hub_intro"),
    // Reuse the EXISTING editable main-menu labels so an operator edit applies
    // here too; no new inner-button labels are introduced (§7).
    getButtonText("buy_subscription"),
    getButtonText("other_products"),
  ]);
  const kb = new InlineKeyboard()
    .text(vpnLabel, CB.USER_BUY)
    .row()
    .text(otherLabel, CB.USER_OTHER_PRODUCTS)
    .row()
    .text(BACK_TO_MENU, CB.USER_MENU);
  await safeEditOrReply(ctx, purchaseHubBody(intro), kb);
  ctx.session.lastMenu = CB.USER_PURCHASE_HUB;
}

export const purchaseHubHandler = new Composer<BotContext>();

// Old `user:purchase` keyboards keep working forever: the hub opens regardless
// of the current layout (split or combined). The two in-hub buttons emit the
// existing CB.USER_BUY / CB.USER_OTHER_PRODUCTS routes, handled by the checkout
// handler exactly as the split-mode main-menu buttons do.
purchaseHubHandler.callbackQuery(CB.USER_PURCHASE_HUB, renderPurchaseHub);
