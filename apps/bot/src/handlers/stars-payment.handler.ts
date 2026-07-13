import {
  PaymentGatewayType,
  PaymentStatus,
  prisma,
  type Payment,
  type User,
} from "@zedbot/database";
import { parseStarsPayload } from "@zedbot/payments";
import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";
import {
  fulfillSettledGatewayOrder,
  recordProviderSuccessFromBot,
  settleGatewayPayment,
  storedStarsAmount,
} from "../services/gateway-payment.service.js";
import { getMessageTemplate } from "../services/text.service.js";
import { safeReply } from "../utils/safe-reply.js";

// =============================================================================
// Telegram Stars payment updates. Registered BEFORE the access gates and the
// flow router in app.ts: a user who already paid at Telegram must always be
// able to complete checkout, and a successful_payment message must never be
// swallowed by an unrelated text flow.
//
// pre_checkout_query is the LAST veto point - after answering true, Telegram
// charges the Stars. Validation is strict (payment row, owner, live status,
// expiry, currency, exact Stars amount). successful_payment then records the
// provider SUCCESS (charge id only - never the full payload) and funnels
// into the CAS-gated settlement, so Telegram's replays settle exactly once.
// =============================================================================

const INVALID_PRECHECKOUT_TEXT = "این پرداخت معتبر نیست یا منقضی شده است.";

/** The pre_checkout_query fields the validator needs (grammY-shaped). */
export interface StarsPreCheckoutQuery {
  from: { id: number };
  currency: string;
  total_amount: number;
}

/** The Payment fields (plus owner) the validator needs. */
export type StarsPreCheckoutPayment = Pick<
  Payment,
  "status" | "expiresAt" | "callbackPayload"
> & { user: Pick<User, "telegramId"> };

/**
 * The LAST veto point before Telegram charges Stars, as a pure function:
 * the payment row must exist, belong to the paying Telegram user, still be
 * live (PENDING/PROCESSING and unexpired), and the query must carry XTR with
 * EXACTLY the Stars amount stored on the payment at creation. Anything else
 * - including a payment whose stored stars amount is missing/invalid - is
 * rejected.
 */
export function validateStarsPreCheckout(
  payment: StarsPreCheckoutPayment | null,
  query: StarsPreCheckoutQuery,
): boolean {
  if (payment === null) {
    return false;
  }
  const stars = storedStarsAmount(payment);
  return (
    payment.user.telegramId === BigInt(query.from.id) &&
    (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.PROCESSING) &&
    (payment.expiresAt === null || payment.expiresAt.getTime() > Date.now()) &&
    query.currency === "XTR" &&
    stars !== null &&
    query.total_amount === stars
  );
}

export const starsPaymentHandler = new Composer<BotContext>();

starsPaymentHandler.on("pre_checkout_query", async (ctx) => {
  const query = ctx.preCheckoutQuery;
  try {
    const paymentId = parseStarsPayload(query.invoice_payload);
    const payment =
      paymentId === null
        ? null
        : await prisma.payment.findFirst({
            where: { id: paymentId, provider: PaymentGatewayType.TELEGRAM_STARS },
            include: { user: true },
          });
    if (validateStarsPreCheckout(payment, query)) {
      await ctx.answerPreCheckoutQuery(true);
      return;
    }
    logger.warn("stars pre-checkout rejected", {
      paymentFound: payment !== null,
      currency: query.currency,
    });
    await ctx.answerPreCheckoutQuery(false, { error_message: INVALID_PRECHECKOUT_TEXT });
  } catch (err) {
    logger.error("stars pre-checkout handling failed", { error: errorMessage(err) });
    try {
      await ctx.answerPreCheckoutQuery(false, { error_message: INVALID_PRECHECKOUT_TEXT });
    } catch {
      // Already answered or Telegram unreachable - the query simply expires.
    }
  }
});

starsPaymentHandler.on("message:successful_payment", async (ctx) => {
  const sp = ctx.message.successful_payment;
  try {
    if (sp.currency !== "XTR") {
      return;
    }
    const paymentId = parseStarsPayload(sp.invoice_payload);
    if (paymentId === null) {
      logger.warn("stars successful_payment with foreign payload");
      return;
    }
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, provider: PaymentGatewayType.TELEGRAM_STARS },
      include: { user: true },
    });
    if (payment === null || payment.user.telegramId !== BigInt(ctx.from.id)) {
      logger.error("stars successful_payment did not match an owned payment", {
        matched: payment !== null,
      });
      return;
    }
    // Charge id + currency + amount only - never the full payload.
    await recordProviderSuccessFromBot(payment.id, {
      transactionId: sp.telegram_payment_charge_id,
      sanitizedPayload: { currency: sp.currency, total_amount: sp.total_amount },
    });
    const outcome = await settleGatewayPayment(payment.id);
    if (outcome.kind === "settled" || outcome.kind === "already") {
      // Duplicate updates land here as "already" - replying success again is
      // harmless and honest.
      await fulfillSettledGatewayOrder(ctx.api, outcome);
      await safeReply(ctx, await getMessageTemplate("payment_success_text"));
      return;
    }
    logger.error("stars successful_payment settlement did not settle", {
      paymentId: payment.id,
      kind: outcome.kind,
    });
    await safeReply(ctx, await getMessageTemplate("payment_pending_text"));
  } catch (err) {
    logger.error("stars successful_payment handling failed", { error: errorMessage(err) });
  }
});
