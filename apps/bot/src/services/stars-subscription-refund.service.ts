import { prisma, type TelegramStarsServiceSubscription } from "@zedbot/database";
import { clampStarsSubInt, DEFAULT_STARS_SUBSCRIPTION_CONFIG, errorMessage, TELEGRAM_STARS_SUBSCRIPTION_REFUND_MAX_ATTEMPTS_KEY, STARS_SUB_MAX_REFUND_ATTEMPTS, STARS_SUB_MIN_REFUND_ATTEMPTS } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { getSetting } from "./settings.service.js";
import { createStarsSubscriptionNotification } from "./stars-subscription-notify.service.js";

/** Frozen plan name from a subscription's entitlement snapshot (safe). */
function frozenProductName(entitlementSnapshot: unknown): string {
  if (typeof entitlementSnapshot === "object" && entitlementSnapshot !== null && !Array.isArray(entitlementSnapshot)) {
    const name = (entitlementSnapshot as Record<string, unknown>).productName;
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return "-";
}

// =============================================================================
// Telegram Stars subscription — refund + Telegram subscription-edit (Phase 2).
//
// A refund uses `refundStarPayment(user_id, telegram_payment_charge_id)` for the
// EXACT failed charge's id (never a different cycle's). Cancellation/reactivation
// use `editUserStarSubscription(user_id, initial_charge_id, is_canceled)` with the
// AUTHORITATIVE first charge id Telegram requires. Refunds are idempotent
// (compare-and-set on the charge status) and bounded-retry; NO WalletTransaction
// is ever created for a Stars refund, and the raw Telegram response is never
// stored. Recovers after a worker restart from the durable charge/subscription
// rows.
// =============================================================================

/** The Telegram Bot API surface used by the subscription refund/edit flows. */
export interface StarsBotApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  refundStarPayment(userId: number, telegramPaymentChargeId: string): Promise<unknown>;
  editUserStarSubscription(
    userId: number,
    telegramPaymentChargeId: string,
    isCanceled: boolean,
  ): Promise<unknown>;
}

export const REFUND_FAILED_USER_TEXT =
  "تمدید سرویس انجام نشد و مبلغ استاری این دوره بازپرداخت شد ⚠️\n\nتمدید خودکار دوره‌های بعدی نیز متوقف شده است.";

async function getRefundMaxAttempts(): Promise<number> {
  const raw = await getSetting(TELEGRAM_STARS_SUBSCRIPTION_REFUND_MAX_ATTEMPTS_KEY, "");
  return clampStarsSubInt(
    Number.parseInt(raw, 10),
    STARS_SUB_MIN_REFUND_ATTEMPTS,
    STARS_SUB_MAX_REFUND_ATTEMPTS,
    DEFAULT_STARS_SUBSCRIPTION_CONFIG.refundMaxAttempts,
  );
}

export type RefundOutcome =
  | { status: "refunded" }
  | { status: "already-refunded" }
  | { status: "retry-scheduled"; attempts: number }
  | { status: "exhausted"; attempts: number }
  | { status: "skipped"; reason: string };

/**
 * Refunds ONE failed subscription charge through Telegram for its exact charge id.
 * Compare-and-set on the charge status makes it idempotent (a confirmed REFUNDED
 * charge is never re-called); on API failure it bounded-retries. On success it
 * also cancels future Telegram extension and marks the subscription REQUIRES_ACTION.
 */
export async function refundStarsSubscriptionCharge(
  api: StarsBotApi,
  chargeId: string,
): Promise<RefundOutcome> {
  const charge = await prisma.telegramStarsSubscriptionCharge.findUnique({
    where: { id: chargeId },
    include: { subscription: true },
  });
  if (charge === null) {
    return { status: "skipped", reason: "charge-missing" };
  }
  if (charge.status === "REFUNDED") {
    return { status: "already-refunded" };
  }
  if (charge.status !== "REFUND_PENDING") {
    return { status: "skipped", reason: `not-refundable:${charge.status}` };
  }
  const user = await prisma.user.findUnique({ where: { id: charge.subscription.userId } });
  if (user === null) {
    return { status: "skipped", reason: "user-missing" };
  }

  const maxAttempts = await getRefundMaxAttempts();
  try {
    await api.refundStarPayment(Number(user.telegramId), charge.telegramPaymentChargeId);
  } catch (err) {
    const attempts = charge.refundAttempts + 1;
    await prisma.telegramStarsSubscriptionCharge.updateMany({
      where: { id: chargeId, status: "REFUND_PENDING" },
      data: { refundAttempts: attempts, safeErrorCode: "refund-api-error" },
    });
    logger.warn("stars refund api call failed", { chargeId: chargeId.slice(0, 8), attempts, error: errorMessage(err) });
    return attempts >= maxAttempts
      ? { status: "exhausted", attempts }
      : { status: "retry-scheduled", attempts };
  }

  // Idempotent claim: only the caller that flips REFUND_PENDING → REFUNDED wins.
  const now = new Date();
  const claimed = await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: { id: chargeId, status: "REFUND_PENDING" },
    data: { status: "REFUNDED", refundedAt: now, safeErrorCode: null },
  });
  if (claimed.count === 0) {
    return { status: "already-refunded" };
  }

  // Stop future billing and surface the subscription for the user.
  await cancelTelegramExtension(api, charge.subscription).catch(() => undefined);
  await prisma.telegramStarsServiceSubscription.updateMany({
    where: { id: charge.subscription.id, status: { notIn: ["CANCELLED", "EXPIRED"] } },
    data: { status: "REQUIRES_ACTION", telegramExtensionCanceled: true, safeLastErrorCode: "charge-refunded" },
  });
  // Durable REFUNDED notification (idempotent per charge). NEVER a WalletTransaction.
  await createStarsSubscriptionNotification({
    subscriptionId: charge.subscription.id,
    userId: charge.subscription.userId,
    type: "STARS_SUBSCRIPTION_REFUNDED",
    cycleKey: chargeId.slice(0, 12),
    serviceName: frozenProductName(charge.subscription.entitlementSnapshot),
    starsAmount: charge.starsAmount,
    currentPeriodEnd: "-",
  }).catch(() => undefined);
  logger.info("stars subscription charge refunded", { chargeId: chargeId.slice(0, 8) });
  return { status: "refunded" };
}

/**
 * Cancels future Telegram extension of a subscription via its AUTHORITATIVE first
 * charge id. Safe to call repeatedly. Returns false when there is no first charge
 * id yet (nothing to cancel) or the API rejects.
 */
export async function cancelTelegramExtension(
  api: StarsBotApi,
  subscription: TelegramStarsServiceSubscription,
): Promise<boolean> {
  if (subscription.initialTelegramPaymentChargeId === null) {
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  if (user === null) {
    return false;
  }
  try {
    await api.editUserStarSubscription(
      Number(user.telegramId),
      subscription.initialTelegramPaymentChargeId,
      true,
    );
    return true;
  } catch (err) {
    logger.warn("editUserStarSubscription(cancel) failed", { error: errorMessage(err) });
    return false;
  }
}

/** Re-enables Telegram extension (reactivation). Requires the first charge id. */
export async function reactivateTelegramExtension(
  api: StarsBotApi,
  subscription: TelegramStarsServiceSubscription,
): Promise<boolean> {
  if (subscription.initialTelegramPaymentChargeId === null) {
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: subscription.userId } });
  if (user === null) {
    return false;
  }
  try {
    await api.editUserStarSubscription(
      Number(user.telegramId),
      subscription.initialTelegramPaymentChargeId,
      false,
    );
    return true;
  } catch (err) {
    logger.warn("editUserStarSubscription(reactivate) failed", { error: errorMessage(err) });
    return false;
  }
}
