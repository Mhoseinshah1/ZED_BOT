import type { BotContext } from "../../core/context.js";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../../core/logger.js";
import { releaseHeldReservationForDraft } from "../../services/service-username-selection.service.js";

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

/**
 * THE authoritative checkout abandonment (hotfix §8). Unlike the synchronous
 * {@link clearCheckoutState} — which only forgets the Telegram-side draft and
 * leaves a HELD username reservation stranded in the database until the cleanup
 * worker eventually reclaims it — this releases the draft's EXACT held username
 * slot NOW, then clears the session state. It:
 *   • releases ONLY the draft's own HELD reservation, matched on the full identity
 *     (userId + draftNonce + reservationId), so it never touches a BOUND / CONSUMED
 *     reservation protected by a durable checkout / order / service;
 *   • is safe on failure (a release error is logged and swallowed — the sweep is
 *     the backstop — and the session state is cleared regardless);
 *   • logs only a safe category string (the `reason`), never a username or note.
 *
 * Wire this into EVERY deliberate exit from the checkout surface (menu, buy hub,
 * Pricing escape, selecting another product / panel, explicit cancel, a command
 * typed mid username/note entry). Do NOT scatter raw releaseReservation(id) calls.
 */
export async function abandonCheckoutDraft(ctx: BotContext, reason: string): Promise<void> {
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  const reservationId = draft?.serviceCustomization?.reservationId;
  if (draft !== undefined && user !== null && reservationId !== undefined) {
    try {
      await releaseHeldReservationForDraft({
        userId: user.id,
        draftNonce: draft.draftNonce ?? null,
        reservationId,
      });
    } catch (err) {
      // Never block navigation on a release failure — the cleanup sweep reclaims
      // any HELD slot left behind. Log a SAFE category only (no username / note).
      logger.warn("abandon checkout draft: reservation release failed", {
        reason,
        error: errorMessage(err),
      });
    }
  }
  clearCheckoutState(ctx);
}
