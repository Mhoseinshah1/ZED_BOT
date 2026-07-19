import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PaymentGatewayType,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  prisma,
  type TelegramStarsServiceSubscription,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { FrozenEntitlement } from "./stars-subscription.service.js";
import {
  dispatchPaidOrderFulfillment,
  type DispatchResult,
} from "./order-fulfillment.service.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// Telegram Stars subscription — CENTRAL charge settlement (Phase 2). ONE service
// turns an accepted recurring Telegram charge into the local financial chain and
// an in-place renewal. The idempotency spine is the charge's
// `telegramPaymentChargeId @unique`: one charge id → one charge row → at most one
// Payment / Checkout / Order (all @unique) → at most one applied renewal. A
// duplicate Telegram update returns the existing charge's result without moving
// anything. The Order carries 0 Toman (revenue is in Stars, tracked on the charge)
// so Stars never inflates Toman reports and the reused wallet-refund path is a
// no-op — the actual Stars refund is a separate flow (see the refund service).
// =============================================================================

export interface StarsChargeInput {
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string | null;
  starsAmount: number;
  isFirstRecurring: boolean;
  subscriptionExpirationDate: Date;
}

export type SettleChargeResult =
  | { kind: "renewed"; orderId: string }
  | { kind: "already-completed" }
  | { kind: "in-progress" }
  | { kind: "refund-required"; chargeId: string }
  | { kind: "reconciliation-required" }
  | { kind: "ignored"; reason: string };

function parseFrozen(sub: TelegramStarsServiceSubscription): FrozenEntitlement | null {
  const raw = sub.entitlementSnapshot;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.durationDays !== "number" || typeof v.starsAmount !== "number") {
    return null;
  }
  return v as unknown as FrozenEntitlement;
}

/**
 * Settles one accepted Telegram Stars subscription charge end-to-end. `api` is the
 * bot's send surface (used for the best-effort success/failure notices — a send
 * failure never rolls back the settlement). Safe to call repeatedly and across
 * restarts; every money move is idempotent on the charge id.
 */
export async function settleTelegramStarsSubscriptionCharge(
  api: DeliverySendApi,
  subscription: TelegramStarsServiceSubscription,
  input: StarsChargeInput,
): Promise<SettleChargeResult> {
  const frozen = parseFrozen(subscription);
  if (frozen === null) {
    return { kind: "ignored", reason: "bad-entitlement-snapshot" };
  }
  // The charge amount MUST match the frozen contract (Telegram charges the fixed
  // amount). A mismatch is never silently settled.
  if (input.starsAmount !== subscription.starsAmount) {
    logger.error("stars charge amount mismatch", {
      subscriptionId: subscription.id.slice(0, 8),
      expected: subscription.starsAmount,
    });
    return { kind: "ignored", reason: "amount-mismatch" };
  }

  // 1) Create-or-load the charge row keyed on the unique Telegram charge id.
  let chargeId: string;
  try {
    const charge = await prisma.telegramStarsSubscriptionCharge.create({
      data: {
        subscriptionId: subscription.id,
        telegramPaymentChargeId: input.telegramPaymentChargeId,
        providerPaymentChargeId: input.providerPaymentChargeId ?? null,
        starsAmount: input.starsAmount,
        isFirstRecurring: input.isFirstRecurring,
        subscriptionExpirationDate: input.subscriptionExpirationDate,
        status: "RECEIVED",
      },
      select: { id: true },
    });
    chargeId = charge.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.telegramStarsSubscriptionCharge.findUnique({
        where: { telegramPaymentChargeId: input.telegramPaymentChargeId },
      });
      if (existing === null) {
        return { kind: "in-progress" };
      }
      if (existing.status === "COMPLETED") {
        return { kind: "already-completed" };
      }
      if (existing.orderId !== null) {
        // A financial chain exists; re-drive fulfillment (idempotent) if not done.
        return finishAfterOrder(api, subscription, existing.id, existing.orderId);
      }
      // Another delivery is mid-settlement, or a prior attempt left it RECEIVED.
      chargeId = existing.id;
    } else {
      throw err;
    }
  }

  // 2) CAS-claim the charge (RECEIVED → SETTLING) so only one caller settles it.
  const claimed = await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: { id: chargeId, status: "RECEIVED" },
    data: { status: "SETTLING", settlementStartedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { kind: "in-progress" };
  }

  // 3) The all-or-nothing financial chain (checkout + payment + order + link).
  const now = new Date();
  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  if (user === null) {
    await failCharge(chargeId, "user-missing");
    return { kind: "ignored", reason: "user-missing" };
  }

  let orderId: string;
  try {
    const purpose = input.isFirstRecurring
      ? PaymentPurpose.SERVICE_SUBSCRIPTION_INITIAL
      : PaymentPurpose.SERVICE_SUBSCRIPTION_RECURRING;
    const snapshot: Prisma.InputJsonObject = {
      productName: frozen.productName,
      invoiceDescription: `اشتراک ماهانه ${frozen.productName}`,
      originalPriceToman: 0,
      durationDays: frozen.durationDays,
      volumeGb: frozen.volumeGb,
      panelName: frozen.panelName ?? "",
      categoryName: frozen.categoryName ?? "",
      renewalTargetServiceId: subscription.serviceId,
      renewalMethod: "ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD",
      starsAmount: input.starsAmount,
    };
    const order = await prisma.$transaction(async (tx) => {
      const checkout = await tx.checkoutSession.create({
        data: {
          userId: user.id,
          purpose: "ORDER_PAYMENT",
          productId: subscription.productId,
          serviceId: subscription.serviceId,
          orderType: OrderType.SERVICE_RENEWAL,
          productSnapshot: snapshot,
          originalPriceToman: 0,
          discountAmountToman: 0,
          finalPriceToman: 0,
          status: CheckoutStatus.PAID,
          paidAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        },
      });
      const payment = await tx.payment.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          purpose,
          status: PaymentStatus.APPROVED,
          provider: PaymentGatewayType.TELEGRAM_STARS,
          amountToman: 0,
          payableAmountToman: 0,
          externalTransactionId: input.telegramPaymentChargeId,
          authority: subscription.publicPayloadId,
          callbackPayload: { method: "TELEGRAM_STARS", stars: input.starsAmount, kind: "subscription-charge" },
          idempotencyKey: `stars-sub-charge:${input.telegramPaymentChargeId}`,
          settlementStatus: "SETTLED",
          settledAt: now,
          paidAt: now,
        },
      });
      await tx.checkoutSession.update({
        where: { id: checkout.id },
        data: { settledByPaymentId: payment.id },
      });
      const createdOrder = await tx.order.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          type: OrderType.SERVICE_RENEWAL,
          status: OrderStatus.PAID,
          productId: subscription.productId,
          serviceId: subscription.serviceId,
          paymentId: payment.id,
          originalPriceToman: 0,
          discountAmountToman: 0,
          finalPriceToman: 0,
          productNameSnapshot: frozen.productName,
          productPriceSnapshot: 0,
          durationDaysSnapshot: frozen.durationDays,
          volumeGbSnapshot: frozen.volumeGb,
          panelNameSnapshot: frozen.panelName,
          categorySnapshot: frozen.categoryName,
          paidAt: now,
        },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { orderId: createdOrder.id } });
      await tx.telegramStarsSubscriptionCharge.update({
        where: { id: chargeId },
        data: {
          status: "FULFILLING",
          fulfillmentStartedAt: now,
          paymentId: payment.id,
          checkoutSessionId: checkout.id,
          orderId: createdOrder.id,
        },
      });
      // Record the authoritative first charge id + move the period forward.
      await tx.telegramStarsServiceSubscription.update({
        where: { id: subscription.id },
        data: {
          ...(input.isFirstRecurring
            ? { initialTelegramPaymentChargeId: input.telegramPaymentChargeId, initialPaymentId: payment.id }
            : {}),
          lastChargeAt: now,
          currentPeriodStartedAt: now,
          currentPeriodEndsAt: input.subscriptionExpirationDate,
          nextExpectedChargeAt: input.subscriptionExpirationDate,
        },
      });
      return createdOrder;
    });
    orderId = order.id;
  } catch (err) {
    // A racing duplicate that won the Payment/charge unique keys, or a transient
    // failure. Leave the charge for reconciliation — the money is collected.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn("stars charge settlement lost a unique race", { chargeId: chargeId.slice(0, 8) });
      return { kind: "in-progress" };
    }
    logger.error("stars charge settlement transaction failed", { error: errorMessage(err) });
    await prisma.telegramStarsSubscriptionCharge.updateMany({
      where: { id: chargeId, status: "SETTLING" },
      data: { status: "RECONCILIATION_REQUIRED", safeErrorCode: "settlement-failed" },
    });
    return { kind: "reconciliation-required" };
  }

  return finishAfterOrder(api, subscription, chargeId, orderId);
}

/**
 * Drives fulfillment for a settled charge's Order and maps the outcome. Reused by
 * the idempotent replay path (a charge that already has an Order).
 */
async function finishAfterOrder(
  api: DeliverySendApi,
  subscription: TelegramStarsServiceSubscription,
  chargeId: string,
  orderId: string,
): Promise<SettleChargeResult> {
  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  const dispatch: DispatchResult = await dispatchPaidOrderFulfillment(api, orderId, {
    source: "GATEWAY",
    user: user ?? undefined,
  });
  const renewed = dispatch.kind === "SERVICE" && dispatch.op === "renew";

  if (renewed && dispatch.ok) {
    const now = new Date();
    await prisma.telegramStarsSubscriptionCharge.updateMany({
      where: { id: chargeId },
      data: { status: "COMPLETED", completedAt: now, safeErrorCode: null },
    });
    await prisma.telegramStarsServiceSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["PENDING_PAYMENT", "ACTIVE", "PAST_DUE"] } },
      data: { status: "ACTIVE", lastSuccessfulOrderId: orderId, safeLastErrorCode: null },
    });
    const service = await prisma.service.findUnique({ where: { id: subscription.serviceId } });
    if (user !== null) {
      await sendSafe(api, user.telegramId.toString(), buildRenewedNotice(subscription, service?.expiresAt ?? null));
    }
    logger.info("stars subscription renewal completed", { subscriptionId: subscription.id.slice(0, 8), orderId });
    return { kind: "renewed", orderId };
  }

  if (renewed && !dispatch.ok && dispatch.refunded) {
    // Definite failure — the 0-Toman order FAILED with NO wallet movement. The
    // Stars amount must be refunded through Telegram (separate flow).
    await prisma.telegramStarsSubscriptionCharge.updateMany({
      where: { id: chargeId },
      data: { status: "REFUND_PENDING", refundRequestedAt: new Date(), safeErrorCode: "fulfillment-failed" },
    });
    return { kind: "refund-required", chargeId };
  }

  // Uncertain outcome (refunded=false): the Order stays PAID/PROVISIONING for the
  // existing reconciliation to complete or refund on proof. NEVER refund yet.
  await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: { id: chargeId },
    data: { status: "RECONCILIATION_REQUIRED", safeErrorCode: "outcome-uncertain" },
  });
  return { kind: "reconciliation-required" };
}

async function failCharge(chargeId: string, code: string): Promise<void> {
  await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: { id: chargeId },
    data: { status: "FAILED", safeErrorCode: code },
  });
}

/** Best-effort Telegram send; a delivery failure never rolls back a settlement. */
async function sendSafe(api: DeliverySendApi, chatId: string, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn("stars subscription notice failed", { error: errorMessage(err) });
  }
}

function buildRenewedNotice(
  subscription: TelegramStarsServiceSubscription,
  newExpiry: Date | null,
): string {
  return [
    "اشتراک ماهانه با موفقیت تمدید شد ⭐",
    "",
    `مبلغ: ${subscription.starsAmount} استار`,
    `پایان دوره جدید: ${newExpiry === null ? "-" : newExpiry.toISOString().slice(0, 10)}`,
  ].join("\n");
}
