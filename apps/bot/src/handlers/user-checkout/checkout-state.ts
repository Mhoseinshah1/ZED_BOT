import type { BotContext } from "../../core/context.js";

/**
 * Clears the user checkout state (pre-invoice draft + discount-entry flow).
 *
 * Called wherever the user leaves the checkout surface: /start, /menu, the
 * main-menu callback, /admin, and the checkout handler's own navigation.
 * It only touches checkout state - admin panel/product wizard flows are
 * never cleared here (their own handlers/commands manage that).
 */
export function clearCheckoutState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow === "checkout:discount" ||
    ctx.session.currentFlow === "renew:discount" ||
    ctx.session.currentFlow === "wallet:topup:amount" ||
    ctx.session.currentFlow === "payment:receipt"
  ) {
    ctx.session.currentFlow = null;
  }
  ctx.session.temp.checkoutDraft = undefined;
  ctx.session.temp.renewalDraft = undefined;
  ctx.session.temp.walletTopupDraft = undefined;
  ctx.session.temp.paymentDraft = undefined;
}
