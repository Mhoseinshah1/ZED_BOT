import { prisma } from "@zedbot/database";
import {
  STARS_CURRENCY,
  STARS_SUBSCRIPTION_LOG_EVENTS,
  STARS_SUBSCRIPTION_PAYLOAD_PREFIX,
  errorMessage,
  parseStarsSubscriptionPayload,
} from "@zedbot/shared";
import { Composer } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { getSubscriptionByPayloadId } from "../../services/stars-subscription.service.js";
import { createStarsSubscriptionNotification } from "../../services/stars-subscription-notify.service.js";
import { writeSystemLog } from "../../services/system-log.service.js";

// =============================================================================
// Bot API 10.2 subscription-state Update + RefundedPayment handlers (Parts B/C).
// Both are HIGH-PRIORITY, ownership-validated, and process ONLY `zedbot:sub:`
// payloads (one-time `zedbot:pay:` is untouched). They persist ONLY safe state +
// timestamps (never raw Update data), create NO Payment/Checkout/Order, and never
// touch the wallet. Registered pre-gate in app.ts so a state/refund Update always
// reaches this handler before access/maintenance gates and the text-flow router.
// =============================================================================

// --- Bot API 10.2 compat shim ------------------------------------------------
// The installed @grammyjs/types (3.28.0) predates Bot API 10.2, so Update.subscription
// / BotSubscriptionUpdated are not yet typed. This minimal, LOCAL guard reads the
// raw update defensively (no `any` leaks past it). Remove once upstream types add
// the `subscription` update.
interface BotSubscriptionUpdatedCompat {
  user: { id: number };
  invoice_payload: string;
  state: "canceled" | "active" | "failed";
}

function extractSubscriptionUpdate(update: unknown): BotSubscriptionUpdatedCompat | null {
  if (typeof update !== "object" || update === null) return null;
  const sub = (update as Record<string, unknown>).subscription;
  if (typeof sub !== "object" || sub === null) return null;
  const s = sub as Record<string, unknown>;
  const state = s.state;
  const payload = s.invoice_payload;
  const user = s.user;
  if (state !== "canceled" && state !== "active" && state !== "failed") return null;
  if (typeof payload !== "string") return null;
  if (typeof user !== "object" || user === null || typeof (user as Record<string, unknown>).id !== "number") {
    return null;
  }
  return { user: { id: (user as Record<string, number>).id }, invoice_payload: payload, state };
}

function frozenProductName(entitlementSnapshot: unknown): string {
  if (typeof entitlementSnapshot === "object" && entitlementSnapshot !== null && !Array.isArray(entitlementSnapshot)) {
    const name = (entitlementSnapshot as Record<string, unknown>).productName;
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return "-";
}

function isoDay(date: Date | null | undefined): string {
  return date === null || date === undefined ? "-" : date.toISOString().slice(0, 10);
}

// --- subscription-state Update handler (Part B) ------------------------------

export const starsSubscriptionUpdateHandler = new Composer<BotContext>();

starsSubscriptionUpdateHandler.use(async (ctx, next) => {
  const update = extractSubscriptionUpdate(ctx.update);
  if (update === null) {
    return next(); // not a subscription Update — defer
  }
  try {
    await handleSubscriptionUpdate(update);
  } catch (err) {
    logger.error("stars subscription update failed", { error: errorMessage(err) });
  }
  // Consumed: a subscription Update carries no user-facing message to route on.
});

export async function handleSubscriptionUpdate(update: BotSubscriptionUpdatedCompat): Promise<void> {
  const payloadId = parseStarsSubscriptionPayload(update.invoice_payload);
  if (payloadId === null) return; // foreign payload — ignore
  const sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { publicPayloadId: payloadId } });
  if (sub === null) return; // unknown subscription — never fabricate
  const user = await prisma.user.findUnique({ where: { id: sub.userId } });
  if (user === null || user.telegramId !== BigInt(update.user.id)) {
    logger.warn("stars subscription update ownership mismatch");
    return; // wrong Telegram user — never cross-apply
  }
  const now = new Date();

  if (update.state === "canceled") {
    // Cancel at period end: stop future extension, preserve the paid period. No
    // refund, no Payment, no Order, no immediate Service expiry.
    await prisma.telegramStarsServiceSubscription.updateMany({
      where: { id: sub.id, status: { notIn: ["CANCELLED", "EXPIRED", "REQUIRES_ACTION"] } },
      data: {
        status: "CANCEL_AT_PERIOD_END",
        telegramExtensionCanceled: true,
        lastSubscriptionUpdateState: "canceled",
        subscriptionUpdateAt: now,
        cancellationRequestedAt: sub.cancellationRequestedAt ?? now,
      },
    });
    await createStarsSubscriptionNotification({
      subscriptionId: sub.id,
      userId: sub.userId,
      type: "STARS_SUBSCRIPTION_CANCELLED",
      cycleKey: `update-canceled:${isoDay(sub.currentPeriodEndsAt)}`,
      serviceName: frozenProductName(sub.entitlementSnapshot),
      starsAmount: sub.starsAmount,
      currentPeriodEnd: isoDay(sub.currentPeriodEndsAt),
    }).catch(() => undefined);
  } else if (update.state === "active") {
    // Telegram will bill again. Do NOT claim a payment or extend the Service —
    // only record that extension is allowed and wait for the next charge.
    const mandate = await prisma.serviceAutoRenewalMandate.findUnique({ where: { serviceId: sub.serviceId } });
    const walletConflict = mandate !== null && mandate.fundingMethod === "WALLET" && mandate.status === "ACTIVE";
    if (sub.initialTelegramPaymentChargeId !== null && !walletConflict) {
      await prisma.telegramStarsServiceSubscription.updateMany({
        where: { id: sub.id, status: { in: ["CANCEL_AT_PERIOD_END", "PAST_DUE", "PENDING_PAYMENT"] } },
        data: {
          status: "REACTIVATION_ALLOWED",
          telegramExtensionCanceled: false,
          lastSubscriptionUpdateState: "active",
          subscriptionUpdateAt: now,
        },
      });
    } else {
      // Record the safe state marker even when we cannot flip status.
      await prisma.telegramStarsServiceSubscription.updateMany({
        where: { id: sub.id },
        data: { lastSubscriptionUpdateState: "active", subscriptionUpdateAt: now },
      });
    }
  } else {
    // "failed": Telegram could not bill the new period. Mark PAST_DUE, preserve the
    // Service, create no local financial records.
    await prisma.telegramStarsServiceSubscription.updateMany({
      where: { id: sub.id, status: { in: ["ACTIVE", "REACTIVATION_ALLOWED", "CANCEL_AT_PERIOD_END"] } },
      data: {
        status: "PAST_DUE",
        pastDueMarkedAt: now,
        lastSubscriptionUpdateState: "failed",
        subscriptionUpdateAt: now,
        safeLastErrorCode: "subscription-failed",
      },
    });
    await createStarsSubscriptionNotification({
      subscriptionId: sub.id,
      userId: sub.userId,
      type: "STARS_SUBSCRIPTION_PAST_DUE",
      cycleKey: isoDay(sub.currentPeriodEndsAt),
      serviceName: frozenProductName(sub.entitlementSnapshot),
      starsAmount: sub.starsAmount,
      currentPeriodEnd: isoDay(sub.currentPeriodEndsAt),
    }).catch(() => undefined);
  }

  await writeSystemLog({
    level: "INFO",
    eventType: STARS_SUBSCRIPTION_LOG_EVENTS.SUBSCRIPTION_UPDATE_RECEIVED,
    message: "stars subscription state update",
    metadata: { state: update.state },
  }).catch(() => undefined);
}

// --- RefundedPayment Update handler (Part C) ---------------------------------

export const starsRefundedPaymentHandler = new Composer<BotContext>();

starsRefundedPaymentHandler.on("message:refunded_payment", async (ctx, next) => {
  const rp = ctx.message.refunded_payment;
  // Ours only: XTR + zedbot:sub: payload. Anything else defers untouched.
  if (rp.currency !== STARS_CURRENCY || !rp.invoice_payload.startsWith(STARS_SUBSCRIPTION_PAYLOAD_PREFIX)) {
    return next();
  }
  try {
    await handleRefundedPayment(BigInt(ctx.from.id), rp);
  } catch (err) {
    logger.error("stars refunded_payment handling failed", { error: errorMessage(err) });
  }
  // Consumed.
});

export interface RefundedPaymentLike {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
}

export async function handleRefundedPayment(fromTelegramId: bigint, rp: RefundedPaymentLike): Promise<void> {
  const payloadId = parseStarsSubscriptionPayload(rp.invoice_payload);
  if (payloadId === null) {
    logger.warn("stars refunded_payment: unresolvable payload");
    return;
  }
  const sub = await getSubscriptionByPayloadId(payloadId);
  if (sub === null) {
    logger.warn("stars refunded_payment: unknown subscription");
    return;
  }
  const charge = await prisma.telegramStarsSubscriptionCharge.findUnique({
    where: { telegramPaymentChargeId: rp.telegram_payment_charge_id },
  });
  if (charge === null || charge.subscriptionId !== sub.id) {
    logger.warn("stars refunded_payment: no matching charge");
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: sub.userId } });
  if (user === null || user.telegramId !== fromTelegramId) {
    logger.warn("stars refunded_payment: ownership mismatch");
    return;
  }
  if (rp.total_amount !== charge.starsAmount) {
    logger.warn("stars refunded_payment: amount mismatch");
    return; // never refund a different charge amount
  }
  // Refundable/refunded-compatible states. Idempotent: an already-REFUNDED charge
  // makes this harmless. Never create a WalletTransaction, never call
  // refundStarPayment again (Telegram already refunded).
  const claimed = await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: {
      id: charge.id,
      status: { in: ["COMPLETED", "FULFILLING", "REFUND_PENDING", "RECONCILIATION_REQUIRED"] },
    },
    data: { status: "REFUNDED", refundedAt: new Date(), safeErrorCode: null },
  });
  // Stop future billing + surface the subscription (only on the first transition).
  if (claimed.count > 0) {
    await prisma.telegramStarsServiceSubscription.updateMany({
      where: { id: sub.id, status: { notIn: ["CANCELLED", "EXPIRED"] } },
      data: { status: "REQUIRES_ACTION", telegramExtensionCanceled: true, safeLastErrorCode: "externally-refunded" },
    });
    await createStarsSubscriptionNotification({
      subscriptionId: sub.id,
      userId: sub.userId,
      type: "STARS_SUBSCRIPTION_REFUNDED",
      cycleKey: charge.id.slice(0, 12),
      serviceName: frozenProductName(sub.entitlementSnapshot),
      starsAmount: charge.starsAmount,
      currentPeriodEnd: "-",
    }).catch(() => undefined);
  }
  await writeSystemLog({
    level: "INFO",
    eventType: STARS_SUBSCRIPTION_LOG_EVENTS.REFUND_UPDATE_RECEIVED,
    message: "stars refunded_payment processed",
    metadata: { firstTransition: claimed.count > 0 },
  }).catch(() => undefined);
}
