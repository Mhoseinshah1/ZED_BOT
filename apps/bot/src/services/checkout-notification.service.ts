import {
  FinancialReconciliationStatus,
  PaymentSettlementStatus,
  PaymentStatus,
  Prisma,
  prisma,
  type PaymentGatewayType,
} from "@zedbot/database";
import {
  PAYMENT_RETRY_PROVIDERS,
  evaluateAbandonedCheckoutEligibility,
  evaluateFailedPaymentEligibility,
  resolveCheckoutLastActivity,
  type AbandonedCheckoutSnapshot,
  type AbandonedExclusionReason,
  type FailedPaymentSnapshot,
  type PaymentRetryExclusionReason,
} from "@zedbot/shared";

import {
  getAbandonedCheckoutConfig,
  getFailedPaymentConfig,
} from "./notification/notification-settings.service.js";

// =============================================================================
// Checkout-payment reminder BOT service (Phase 2):
//   1. Per-checkout suppression (the `n` notification button) - an idempotent,
//      history-preserving stamp on CheckoutNotificationPreference that touches
//      ONLY this checkout and NEVER the user's global preference.
//   2. A read-only, dry-run audience PREVIEW for the admin rule pages. It mirrors
//      the worker scan's WHERE filters, assembles the SAME safe snapshot shape and
//      calls the SAME pure @zedbot/shared evaluators, so the admin estimate can
//      never diverge from what the worker would actually schedule. It creates NO
//      notification rows and enqueues nothing.
// Both paths read only; neither mutates a Payment / CheckoutSession / Order /
// receipt / reconciliation row, and neither reads financial truth from a
// notification snapshot.
// =============================================================================

// --- suppression -------------------------------------------------------------

/**
 * Stamps this ONE checkout's abandoned- or payment-retry-reminder suppression.
 * Idempotent: the timestamp is written only while currently null (history is
 * never overwritten), and a concurrent first-write loses harmlessly on the unique
 * checkoutSessionId. Never touches the other kind's stamp, another checkout, or
 * the user's global notification preference.
 */
export async function suppressCheckoutReminders(
  checkoutId: string,
  kind: "abandoned" | "payment",
  notificationId: string,
): Promise<void> {
  const field =
    kind === "abandoned" ? "abandonedReminderSuppressedAt" : "paymentRetrySuppressedAt";
  const now = new Date();

  // Stamp the field only when it is still null - a repeated click (or a click
  // after the worker already suppressed) is a no-op that preserves the original
  // instant + the notification that first suppressed it.
  const updated = await prisma.checkoutNotificationPreference.updateMany({
    where: { checkoutSessionId: checkoutId, [field]: null },
    data: { [field]: now, suppressedByNotificationId: notificationId },
  });
  if (updated.count > 0) {
    return;
  }

  // count === 0 means either the row is absent, or the field is already stamped.
  // Try to create it; a racing create (or a pre-existing row with the field set)
  // collapses to an idempotent no-op.
  try {
    await prisma.checkoutNotificationPreference.create({
      data: {
        checkoutSessionId: checkoutId,
        [field]: now,
        suppressedByNotificationId: notificationId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return; // row already exists - the field is already stamped (idempotent).
    }
    throw err;
  }
}

// --- dry-run audience preview ------------------------------------------------

/** Hard bound on a single preview sweep; counts above it are labelled تخمینی. */
const PREVIEW_LIMIT = 2000;

export interface AbandonedAudiencePreview {
  scanned: number;
  eligible: number;
  capped: boolean;
  exclusions: Partial<Record<AbandonedExclusionReason, number>>;
}

export interface PaymentAudiencePreview {
  scanned: number;
  eligible: number;
  capped: boolean;
  exclusions: Partial<Record<PaymentRetryExclusionReason, number>>;
}

/** The checkout shape the preview loads (same fields the worker's snapshot needs). */
const CHECKOUT_SELECT = {
  id: true,
  status: true,
  settledByPaymentId: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  orders: { select: { id: true }, take: 1 },
  customerInput: { select: { updatedAt: true } },
  payments: {
    select: {
      id: true,
      status: true,
      settlementStatus: true,
      providerStatus: true,
      provider: true,
      createdAt: true,
      updatedAt: true,
      receipts: { select: { status: true, createdAt: true } },
    },
  },
} as const;

interface LoadedCheckout {
  id: string;
  status: string;
  settledByPaymentId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  orders: Array<{ id: string }>;
  customerInput: { updatedAt: Date } | null;
  payments: Array<{
    id: string;
    status: string;
    settlementStatus: string;
    providerStatus: string | null;
    provider: string | null;
    createdAt: Date;
    updatedAt: Date;
    receipts: Array<{ status: string; createdAt: Date }>;
  }>;
}

async function reconciliationOpenSet(checkoutIds: string[]): Promise<Set<string>> {
  if (checkoutIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.financialReconciliationCase.findMany({
    where: {
      checkoutSessionId: { in: checkoutIds },
      status: {
        in: [FinancialReconciliationStatus.OPEN, FinancialReconciliationStatus.IN_REVIEW],
      },
    },
    select: { checkoutSessionId: true },
  });
  return new Set(rows.map((r) => r.checkoutSessionId));
}

interface SuppressionInstants {
  abandonedReminderSuppressedAt: Date | null;
  paymentRetrySuppressedAt: Date | null;
}

async function suppressionMap(checkoutIds: string[]): Promise<Map<string, SuppressionInstants>> {
  const map = new Map<string, SuppressionInstants>();
  if (checkoutIds.length === 0) {
    return map;
  }
  const rows = await prisma.checkoutNotificationPreference.findMany({
    where: { checkoutSessionId: { in: checkoutIds } },
    select: {
      checkoutSessionId: true,
      abandonedReminderSuppressedAt: true,
      paymentRetrySuppressedAt: true,
    },
  });
  for (const r of rows) {
    map.set(r.checkoutSessionId, {
      abandonedReminderSuppressedAt: r.abandonedReminderSuppressedAt,
      paymentRetrySuppressedAt: r.paymentRetrySuppressedAt,
    });
  }
  return map;
}

function hasApprovedReceipt(checkout: LoadedCheckout): boolean {
  return checkout.payments.some((p) => p.receipts.some((r) => r.status === PaymentStatus.APPROVED));
}

function hasPendingReviewPayment(checkout: LoadedCheckout): boolean {
  return checkout.payments.some((p) => p.status === PaymentStatus.PENDING_REVIEW);
}

function hasSettledPayment(checkout: LoadedCheckout): boolean {
  return checkout.payments.some((p) => p.settlementStatus === PaymentSettlementStatus.SETTLED);
}

function hasDuplicateSuccessReview(checkout: LoadedCheckout): boolean {
  return checkout.payments.some(
    (p) => p.settlementStatus === PaymentSettlementStatus.DUPLICATE_SUCCESS_REVIEW,
  );
}

function latestPaymentAndReceipt(checkout: LoadedCheckout): {
  payment: Date | null;
  receipt: Date | null;
} {
  let payment: Date | null = null;
  let receipt: Date | null = null;
  for (const p of checkout.payments) {
    const at = p.updatedAt.getTime() >= p.createdAt.getTime() ? p.updatedAt : p.createdAt;
    if (payment === null || at.getTime() > payment.getTime()) {
      payment = at;
    }
    for (const r of p.receipts) {
      if (receipt === null || r.createdAt.getTime() > receipt.getTime()) {
        receipt = r.createdAt;
      }
    }
  }
  return { payment, receipt };
}

function buildAbandonedSnapshot(
  checkout: LoadedCheckout,
  reconciliationOpen: boolean,
  suppressedAt: Date | null,
  existingReminderCount: number,
): AbandonedCheckoutSnapshot {
  const activityTimes = latestPaymentAndReceipt(checkout);
  const activity = resolveCheckoutLastActivity({
    checkoutCreatedAt: checkout.createdAt,
    checkoutUpdatedAt: checkout.updatedAt,
    latestPaymentAt: activityTimes.payment,
    latestReceiptAt: activityTimes.receipt,
    latestCustomerInputAt: checkout.customerInput?.updatedAt ?? null,
  });
  return {
    status: checkout.status,
    settled: checkout.settledByPaymentId !== null,
    hasOrder: checkout.orders.length > 0,
    hasPendingReviewPayment: hasPendingReviewPayment(checkout),
    hasApprovedReceipt: hasApprovedReceipt(checkout),
    hasSettledPayment: hasSettledPayment(checkout),
    hasDuplicateSuccessReview: hasDuplicateSuccessReview(checkout),
    reconciliationOpen,
    expiresAt: checkout.expiresAt,
    createdAt: checkout.createdAt,
    lastActivityAt: activity.lastActivityAt,
    suppressedAt,
    existingReminderCount,
  };
}

/** ABANDONED_CHECKOUT notification counts per checkout (any status - lifetime cap). */
async function abandonedReminderCounts(checkoutIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (checkoutIds.length === 0) {
    return map;
  }
  const rows = await prisma.automatedNotification.groupBy({
    by: ["checkoutSessionId"],
    where: { checkoutSessionId: { in: checkoutIds }, type: "ABANDONED_CHECKOUT" },
    _count: { _all: true },
  });
  for (const r of rows) {
    if (r.checkoutSessionId !== null) {
      map.set(r.checkoutSessionId, r._count._all);
    }
  }
  return map;
}

/**
 * Read-only dry-run of the abandoned-checkout audience. Mirrors the worker scan's
 * WHERE filters (PENDING, unsettled, unexpired, within max age), assembles the
 * SAME snapshot and calls the SAME evaluator, tallying eligible + each exclusion
 * reason. Bounded to PREVIEW_LIMIT rows (capped=true when the bound is hit). No
 * writes, no enqueues.
 */
export async function previewAbandonedAudience(): Promise<AbandonedAudiencePreview> {
  const config = await getAbandonedCheckoutConfig();
  const now = new Date();
  const maxAgeCutoff = new Date(now.getTime() - config.maximumCheckoutAgeHours * 3_600_000);
  const checkouts = (await prisma.checkoutSession.findMany({
    where: {
      status: "PENDING",
      settledByPaymentId: null,
      expiresAt: { gt: now },
      createdAt: { gte: maxAgeCutoff },
    },
    orderBy: { createdAt: "desc" },
    take: PREVIEW_LIMIT,
    select: CHECKOUT_SELECT,
  })) as unknown as LoadedCheckout[];

  const preview: AbandonedAudiencePreview = {
    scanned: checkouts.length,
    eligible: 0,
    capped: checkouts.length >= PREVIEW_LIMIT,
    exclusions: {},
  };
  if (checkouts.length === 0) {
    return preview;
  }

  const ids = checkouts.map((c) => c.id);
  const [reconSet, suppress, counts] = await Promise.all([
    reconciliationOpenSet(ids),
    suppressionMap(ids),
    abandonedReminderCounts(ids),
  ]);
  for (const checkout of checkouts) {
    const snapshot = buildAbandonedSnapshot(
      checkout,
      reconSet.has(checkout.id),
      suppress.get(checkout.id)?.abandonedReminderSuppressedAt ?? null,
      counts.get(checkout.id) ?? 0,
    );
    const eligibility = evaluateAbandonedCheckoutEligibility(snapshot, config, now);
    if (eligibility.eligible) {
      preview.eligible += 1;
    } else {
      preview.exclusions[eligibility.reason] = (preview.exclusions[eligibility.reason] ?? 0) + 1;
    }
  }
  return preview;
}

// --- failed-payment preview --------------------------------------------------

interface LoadedFailedPayment {
  id: string;
  userId: string;
  checkoutSessionId: string | null;
  provider: string | null;
  status: string;
  settlementStatus: string;
  updatedAt: Date;
  checkoutSession: LoadedCheckout | null;
}

const FAILED_PAYMENT_SELECT = {
  id: true,
  userId: true,
  checkoutSessionId: true,
  provider: true,
  status: true,
  settlementStatus: true,
  updatedAt: true,
  checkoutSession: { select: CHECKOUT_SELECT },
} as const;

async function retryCounts(
  paymentIds: string[],
  checkoutIds: string[],
  now: Date,
): Promise<{ perPayment: Map<string, number>; perCheckoutToday: Map<string, number> }> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const [byPayment, byCheckout] = await Promise.all([
    paymentIds.length === 0
      ? []
      : prisma.automatedNotification.groupBy({
          by: ["paymentId"],
          where: { paymentId: { in: paymentIds }, type: "PAYMENT_RETRY" },
          _count: { _all: true },
        }),
    checkoutIds.length === 0
      ? []
      : prisma.automatedNotification.groupBy({
          by: ["checkoutSessionId"],
          where: {
            checkoutSessionId: { in: checkoutIds },
            type: "PAYMENT_RETRY",
            createdAt: { gte: dayAgo },
          },
          _count: { _all: true },
        }),
  ]);
  const perPayment = new Map<string, number>();
  for (const r of byPayment) {
    if (r.paymentId !== null) {
      perPayment.set(r.paymentId, r._count._all);
    }
  }
  const perCheckoutToday = new Map<string, number>();
  for (const r of byCheckout) {
    if (r.checkoutSessionId !== null) {
      perCheckoutToday.set(r.checkoutSessionId, r._count._all);
    }
  }
  return { perPayment, perCheckoutToday };
}

function competingSuccess(checkout: LoadedCheckout, failedPaymentId: string): boolean {
  return checkout.payments.some(
    (p) =>
      p.id !== failedPaymentId &&
      (p.settlementStatus === PaymentSettlementStatus.SETTLED ||
        p.settlementStatus === PaymentSettlementStatus.DUPLICATE_SUCCESS_REVIEW ||
        p.providerStatus === "SUCCESS"),
  );
}

function buildFailedPaymentSnapshot(
  payment: LoadedFailedPayment,
  checkout: LoadedCheckout,
  reconciliationOpen: boolean,
  suppressedAt: Date | null,
  existingRetryCount: number,
  checkoutRetryCountToday: number,
  now: Date,
): FailedPaymentSnapshot {
  return {
    paymentStatus: payment.status,
    provider: payment.provider,
    paymentSettlementStatus: payment.settlementStatus,
    failedAt: payment.updatedAt,
    checkoutSettled: checkout.settledByPaymentId !== null || checkout.status !== "PENDING",
    hasOrder: checkout.orders.length > 0,
    hasPendingReviewPayment: hasPendingReviewPayment(checkout),
    reconciliationOpen,
    competingSuccess: competingSuccess(checkout, payment.id),
    checkoutExpired: now.getTime() >= checkout.expiresAt.getTime(),
    suppressedAt,
    existingRetryCount,
    checkoutRetryCountToday,
  };
}

/**
 * Read-only dry-run of the failed-payment retry audience. Mirrors the worker
 * scan's WHERE filters (FAILED/EXPIRED, retry-eligible provider, checkout
 * attached, not locally settled, within the delay/floor window), assembles the
 * SAME snapshot and calls the SAME evaluator, tallying eligible + each exclusion
 * reason. Bounded to PREVIEW_LIMIT rows. No writes, no enqueues.
 */
export async function previewPaymentAudience(): Promise<PaymentAudiencePreview> {
  const config = await getFailedPaymentConfig();
  const now = new Date();
  const delayCutoff = new Date(now.getTime() - config.delayMinutes * 60_000);
  const scanFloor = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const payments = (await prisma.payment.findMany({
    where: {
      status: { in: [PaymentStatus.FAILED, PaymentStatus.EXPIRED] },
      provider: { in: PAYMENT_RETRY_PROVIDERS as unknown as PaymentGatewayType[] },
      checkoutSessionId: { not: null },
      settlementStatus: { not: PaymentSettlementStatus.SETTLED },
      updatedAt: { gte: scanFloor, lte: delayCutoff },
    },
    orderBy: { updatedAt: "desc" },
    take: PREVIEW_LIMIT,
    select: FAILED_PAYMENT_SELECT,
  })) as unknown as LoadedFailedPayment[];

  const preview: PaymentAudiencePreview = {
    scanned: payments.length,
    eligible: 0,
    capped: payments.length >= PREVIEW_LIMIT,
    exclusions: {},
  };
  if (payments.length === 0) {
    return preview;
  }

  const withCheckout = payments.filter((p) => p.checkoutSession !== null);
  const paymentIds = withCheckout.map((p) => p.id);
  const checkoutIds = withCheckout.map((p) => p.checkoutSessionId as string);
  const [reconSet, suppress, counts] = await Promise.all([
    reconciliationOpenSet(checkoutIds),
    suppressionMap(checkoutIds),
    retryCounts(paymentIds, checkoutIds, now),
  ]);
  for (const payment of withCheckout) {
    const checkout = payment.checkoutSession as LoadedCheckout;
    const snapshot = buildFailedPaymentSnapshot(
      payment,
      checkout,
      reconSet.has(checkout.id),
      suppress.get(checkout.id)?.paymentRetrySuppressedAt ?? null,
      counts.perPayment.get(payment.id) ?? 0,
      counts.perCheckoutToday.get(checkout.id) ?? 0,
      now,
    );
    const eligibility = evaluateFailedPaymentEligibility(snapshot, config, now);
    if (eligibility.eligible) {
      preview.eligible += 1;
    } else {
      preview.exclusions[eligibility.reason] = (preview.exclusions[eligibility.reason] ?? 0) + 1;
    }
  }
  return preview;
}
