import {
  FinancialReconciliationStatus,
  PaymentSettlementStatus,
  PaymentStatus,
  prisma,
  type PaymentGatewayType,
} from "@zedbot/database";
import {
  PAYMENT_RETRY_PROVIDERS,
  evaluateAbandonedCheckoutEligibility,
  evaluateFailedPaymentEligibility,
  resolveCheckoutLastActivity,
  type AbandonedCheckoutConfig,
  type AbandonedCheckoutSnapshot,
  type AbandonedEligibility,
  type FailedPaymentConfig,
  type FailedPaymentSnapshot,
  type PaymentRetryEligibility,
} from "@zedbot/shared";

import { toFaDigits } from "./rules.js";

// =============================================================================
// Checkout-payment ELIGIBILITY loaders (Phase 2). Assemble the SAFE snapshot the
// pure @zedbot/shared evaluators consume, from authoritative live financial
// state - the SAME code path for the scan, the delivery re-validation and the
// admin dry-run preview (one resolver, no divergence). Loaders read only; they
// NEVER mutate a Payment / CheckoutSession / Order / receipt / reconciliation
// row, and they never read financial truth from a notification snapshot.
// =============================================================================

/** Safe, non-secret display fields the scan renders (no ids, providers, payloads). */
export interface CheckoutDisplay {
  productName: string;
  payableAmount: string;
  checkoutReference: string;
  expiresIn: string;
  paymentMethod?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  ZARINPAL: "زرین‌پال",
  NOWPAYMENTS: "پرداخت ارزی",
  TELEGRAM_STARS: "تلگرام استارز",
  AGHAYEPARDAKHT: "آقای پرداخت",
  PLISIO: "پرداخت ارزی",
  CUSTOM: "درگاه پرداخت",
  CARD_TO_CARD: "کارت به کارت",
};

/** Toman with Persian digits + thousands separators. */
function formatToman(amount: number): string {
  const grouped = Math.max(0, Math.trunc(amount))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return `${toFaDigits(grouped)} تومان`;
}

/** Humanized "time left" until expiry (Persian); empty when already past. */
function formatExpiresIn(expiresAt: Date, now: Date): string {
  const minutes = Math.floor((expiresAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) {
    return "";
  }
  if (minutes % (24 * 60) === 0) {
    return `${toFaDigits(minutes / (24 * 60))} روز`;
  }
  if (minutes >= 60) {
    return `${toFaDigits(Math.round(minutes / 60))} ساعت`;
  }
  return `${toFaDigits(minutes)} دقیقه`;
}

/** Safe product/purpose display name from the immutable checkout snapshot. */
function checkoutProductName(purpose: string, productSnapshot: unknown): string {
  if (purpose === "WALLET_CHARGE") {
    return "شارژ کیف پول";
  }
  if (productSnapshot !== null && typeof productSnapshot === "object") {
    const name = (productSnapshot as Record<string, unknown>).productName;
    if (typeof name === "string" && name.trim() !== "") {
      return name.trim();
    }
  }
  return "سفارش شما";
}

// --- shared snapshot assembly ------------------------------------------------

/** The checkout + its payments/receipts/orders/customerInput the loaders select. */
const CHECKOUT_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  productSnapshot: true,
  finalPriceToman: true,
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

type LoadedCheckout = {
  id: string;
  userId: string;
  purpose: string;
  productSnapshot: unknown;
  finalPriceToman: number;
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
};

/** Whether an open/in-review reconciliation case references each checkout id. */
async function reconciliationOpenSet(checkoutIds: string[]): Promise<Set<string>> {
  if (checkoutIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.financialReconciliationCase.findMany({
    where: {
      checkoutSessionId: { in: checkoutIds },
      status: { in: [FinancialReconciliationStatus.OPEN, FinancialReconciliationStatus.IN_REVIEW] },
    },
    select: { checkoutSessionId: true },
  });
  return new Set(rows.map((r) => r.checkoutSessionId));
}

/** Per-checkout suppression instants. */
async function suppressionMap(
  checkoutIds: string[],
): Promise<Map<string, { abandonedReminderSuppressedAt: Date | null; paymentRetrySuppressedAt: Date | null }>> {
  const map = new Map<string, { abandonedReminderSuppressedAt: Date | null; paymentRetrySuppressedAt: Date | null }>();
  if (checkoutIds.length === 0) {
    return map;
  }
  const rows = await prisma.checkoutNotificationPreference.findMany({
    where: { checkoutSessionId: { in: checkoutIds } },
    select: { checkoutSessionId: true, abandonedReminderSuppressedAt: true, paymentRetrySuppressedAt: true },
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

/** Latest safe user-activity instant across payments/receipts (customerInput separate). */
function latestPaymentAndReceipt(checkout: LoadedCheckout): { payment: Date | null; receipt: Date | null } {
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

export interface AbandonedCandidate {
  checkoutId: string;
  userId: string;
  eligibility: AbandonedEligibility;
  display: CheckoutDisplay;
  /** Conflict policy (Part S): a retry-eligible failed online payment exists on
   * this checkout, so the payment-retry rule (if on) owns it - the scan skips
   * the equivalent abandoned reminder. */
  hasRetryableFailedPayment: boolean;
}

/** A retry-eligible (online, definitively-failed, unsettled) payment on the checkout. */
function hasRetryableFailedPayment(checkout: LoadedCheckout): boolean {
  return checkout.payments.some(
    (p) =>
      (p.status === PaymentStatus.FAILED || p.status === PaymentStatus.EXPIRED) &&
      p.settlementStatus !== PaymentSettlementStatus.SETTLED &&
      p.provider !== null &&
      (PAYMENT_RETRY_PROVIDERS as string[]).includes(p.provider),
  );
}

/**
 * Loads + evaluates one page of abandoned-checkout candidates. Returns every
 * scanned checkout's eligibility (the caller acts on `eligible`, and the preview
 * counts the exclusion reasons). `cursor` is the last checkout id of the prior
 * page.
 */
export async function loadAbandonedCandidatePage(
  config: AbandonedCheckoutConfig,
  now: Date,
  batchSize: number,
  cursor?: string,
): Promise<AbandonedCandidate[]> {
  const maxAgeCutoff = new Date(now.getTime() - config.maximumCheckoutAgeHours * 3_600_000);
  const checkouts = (await prisma.checkoutSession.findMany({
    where: {
      status: "PENDING",
      settledByPaymentId: null,
      expiresAt: { gt: now },
      createdAt: { gte: maxAgeCutoff },
    },
    orderBy: { id: "asc" },
    take: batchSize,
    ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
    select: CHECKOUT_SELECT,
  })) as unknown as LoadedCheckout[];
  if (checkouts.length === 0) {
    return [];
  }
  const ids = checkouts.map((c) => c.id);
  const [reconSet, suppress, counts] = await Promise.all([
    reconciliationOpenSet(ids),
    suppressionMap(ids),
    abandonedReminderCounts(ids),
  ]);
  return checkouts.map((checkout) => {
    const snapshot = buildAbandonedSnapshot(
      checkout,
      reconSet.has(checkout.id),
      suppress.get(checkout.id)?.abandonedReminderSuppressedAt ?? null,
      counts.get(checkout.id) ?? 0,
    );
    return {
      checkoutId: checkout.id,
      userId: checkout.userId,
      eligibility: evaluateAbandonedCheckoutEligibility(snapshot, config, now),
      hasRetryableFailedPayment: hasRetryableFailedPayment(checkout),
      display: {
        productName: checkoutProductName(checkout.purpose, checkout.productSnapshot),
        payableAmount: formatToman(checkout.finalPriceToman),
        checkoutReference: toFaDigits(checkout.id.slice(0, 8)),
        expiresIn: formatExpiresIn(checkout.expiresAt, now),
      },
    };
  });
}

/** ABANDONED_CHECKOUT notification counts per checkout (any status - lifetime cap). */
async function abandonedReminderCounts(checkoutIds: string[]): Promise<Map<string, number>> {
  const rows = await prisma.automatedNotification.groupBy({
    by: ["checkoutSessionId"],
    where: { checkoutSessionId: { in: checkoutIds }, type: "ABANDONED_CHECKOUT" },
    _count: { _all: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.checkoutSessionId !== null) {
      map.set(r.checkoutSessionId, r._count._all);
    }
  }
  return map;
}

/**
 * Re-evaluates ONE checkout for delivery of a stage-`stage` abandoned reminder.
 * Reuses the SAME evaluator by pretending `stage-1` reminders exist, so the
 * result is `eligible` iff the checkout is still abandonable AND the user has not
 * re-engaged (recent activity fails the stage threshold). Null when the checkout
 * is gone.
 */
export async function revalidateAbandonedForDelivery(
  checkoutId: string,
  stage: number,
  config: AbandonedCheckoutConfig,
  now: Date,
): Promise<{ eligibility: AbandonedEligibility } | null> {
  const checkout = (await prisma.checkoutSession.findUnique({
    where: { id: checkoutId },
    select: CHECKOUT_SELECT,
  })) as unknown as LoadedCheckout | null;
  if (checkout === null) {
    return null;
  }
  const [reconSet, suppress] = await Promise.all([
    reconciliationOpenSet([checkoutId]),
    suppressionMap([checkoutId]),
  ]);
  const snapshot = buildAbandonedSnapshot(
    checkout,
    reconSet.has(checkoutId),
    suppress.get(checkoutId)?.abandonedReminderSuppressedAt ?? null,
    Math.max(0, stage - 1),
  );
  return { eligibility: evaluateAbandonedCheckoutEligibility(snapshot, config, now) };
}

// --- failed payment ----------------------------------------------------------

export interface FailedPaymentCandidate {
  paymentId: string;
  checkoutId: string;
  userId: string;
  eligibility: PaymentRetryEligibility;
  display: CheckoutDisplay;
}

type LoadedFailedPayment = {
  id: string;
  userId: string;
  checkoutSessionId: string | null;
  provider: string | null;
  status: string;
  settlementStatus: string;
  updatedAt: Date;
  checkoutSession: LoadedCheckout | null;
};

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

/** PAYMENT_RETRY counts per payment id and per checkout (last 24h). */
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
 * Loads + evaluates one page of failed/expired online-payment retry candidates.
 * The `updatedAt` floor bounds the scan to recently-failed payments (older ones
 * whose checkout has expired are excluded anyway).
 */
export async function loadFailedPaymentCandidatePage(
  config: FailedPaymentConfig,
  now: Date,
  batchSize: number,
  cursor?: string,
): Promise<FailedPaymentCandidate[]> {
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
    orderBy: { id: "asc" },
    take: batchSize,
    ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
    select: FAILED_PAYMENT_SELECT,
  })) as unknown as LoadedFailedPayment[];
  if (payments.length === 0) {
    return [];
  }
  const withCheckout = payments.filter((p) => p.checkoutSession !== null);
  const paymentIds = withCheckout.map((p) => p.id);
  const checkoutIds = withCheckout.map((p) => p.checkoutSessionId as string);
  const [reconSet, suppress, counts] = await Promise.all([
    reconciliationOpenSet(checkoutIds),
    suppressionMap(checkoutIds),
    retryCounts(paymentIds, checkoutIds, now),
  ]);
  return withCheckout.map((payment) => {
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
    return {
      paymentId: payment.id,
      checkoutId: checkout.id,
      userId: payment.userId,
      eligibility: evaluateFailedPaymentEligibility(snapshot, config, now),
      display: {
        productName: checkoutProductName(checkout.purpose, checkout.productSnapshot),
        payableAmount: formatToman(checkout.finalPriceToman),
        checkoutReference: toFaDigits(checkout.id.slice(0, 8)),
        expiresIn: formatExpiresIn(checkout.expiresAt, now),
        paymentMethod: PROVIDER_LABELS[payment.provider ?? ""] ?? "درگاه پرداخت",
      },
    };
  });
}

/**
 * Re-evaluates ONE failed payment for delivery. Reuses the SAME evaluator with
 * the count caps zeroed (the row already exists), so it only re-checks the live
 * financial exclusions + the delay. Null when the payment or its checkout is gone.
 */
export async function revalidateFailedPaymentForDelivery(
  paymentId: string,
  config: FailedPaymentConfig,
  now: Date,
): Promise<{ eligibility: PaymentRetryEligibility } | null> {
  const payment = (await prisma.payment.findUnique({
    where: { id: paymentId },
    select: FAILED_PAYMENT_SELECT,
  })) as unknown as LoadedFailedPayment | null;
  if (payment === null || payment.checkoutSession === null) {
    return null;
  }
  const checkout = payment.checkoutSession;
  const [reconSet, suppress] = await Promise.all([
    reconciliationOpenSet([checkout.id]),
    suppressionMap([checkout.id]),
  ]);
  const snapshot = buildFailedPaymentSnapshot(
    payment,
    checkout,
    reconSet.has(checkout.id),
    suppress.get(checkout.id)?.paymentRetrySuppressedAt ?? null,
    0,
    0,
    now,
  );
  return { eligibility: evaluateFailedPaymentEligibility(snapshot, config, now) };
}
