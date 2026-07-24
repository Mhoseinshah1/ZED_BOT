import type { BotContext } from "../../core/context.js";

/**
 * The checkout/payment INPUT flows that are safe to abandon when the user
 * deliberately navigates away (e.g. presses the Pricing button): discount
 * entry, the card-to-card receipt upload, the wallet top-up amount, the
 * renewal / extra-volume / extra-time discount entries, and the two SERVICE
 * username/note input steps (feat/service-checkout-username-note).
 * `clearCheckoutState` resets exactly these, and the Pricing reply-keyboard
 * escape route (fix/pricing-reply-keyboard-flow-escape) may interrupt ONLY
 * these. Support, representative-application, customer-input-form, admin and
 * every other conversational flow are deliberately NOT here — they keep their
 * priority.
 */
export const INTERRUPTIBLE_CHECKOUT_FLOWS = [
  "checkout:discount",
  "checkout:service_username",
  "checkout:service_note",
  "renew:discount",
  "extra_volume:discount",
  "extra_time:discount",
  "wallet:topup:amount",
  "payment:receipt",
] as const;

const INTERRUPTIBLE_CHECKOUT_FLOW_SET: ReadonlySet<string> = new Set(INTERRUPTIBLE_CHECKOUT_FLOWS);

/** True when `flow` is one of the six interruptible checkout/payment flows. */
export function isInterruptibleCheckoutFlow(flow: string | null): boolean {
  return flow !== null && INTERRUPTIBLE_CHECKOUT_FLOW_SET.has(flow);
}

/**
 * Clears the user checkout state (pre-invoice draft + discount-entry flow).
 *
 * Called wherever the user leaves the checkout surface: /start, /menu, the
 * main-menu callback, /admin, and the checkout handler's own navigation.
 * It only touches checkout state - admin panel/product wizard flows are
 * never cleared here (their own handlers/commands manage that).
 */
export function clearCheckoutState(ctx: BotContext): void {
  if (isInterruptibleCheckoutFlow(ctx.session.currentFlow)) {
    ctx.session.currentFlow = null;
  }
  ctx.session.temp.checkoutDraft = undefined;
  ctx.session.temp.renewalDraft = undefined;
  ctx.session.temp.extraVolumeDraft = undefined;
  ctx.session.temp.extraTimeDraft = undefined;
  ctx.session.temp.walletTopupDraft = undefined;
  ctx.session.temp.paymentDraft = undefined;
}
