// =============================================================================
// Checkout-payment reminders (Phase 2) — the ONE dependency-free contract (no
// prisma / bullmq) shared by the bot, the worker and tests: settings keys +
// validated config, the safe checkout-activity resolver, the abandoned-checkout
// and failed-payment ELIGIBILITY evaluators (pure — the scan, the delivery
// re-validation and the admin dry-run preview all call the SAME function), and
// the dedupe-key fingerprints. Every rule is unit-testable without a database.
//
// Both new rules are DISABLED by default; no reminder is ever produced unless
// the global master switch AND the specific rule AND the user's cron + payment
// category switches are all on (the category gate lives in notifications.ts).
// =============================================================================

// --- settings keys -----------------------------------------------------------

export const NOTIF_ABANDONED_ENABLED_KEY = "notification_abandoned_checkout_enabled";
export const NOTIF_PAYMENT_RETRY_ENABLED_KEY = "notification_payment_retry_enabled";
export const NOTIF_ABANDONED_CONFIG_KEY = "notification_abandoned_checkout_config";
export const NOTIF_PAYMENT_RETRY_CONFIG_KEY = "notification_payment_retry_config";
export const NOTIF_CHECKOUT_SCAN_MINUTES_KEY = "notification_schedule_checkout_scan_minutes";

/** Per-rule enable flags (both default false until an operator turns them on). */
export const NOTIF_CHECKOUT_RULE_ENABLED_KEYS = {
  abandoned: NOTIF_ABANDONED_ENABLED_KEY,
  payment: NOTIF_PAYMENT_RETRY_ENABLED_KEY,
} as const;
export type CheckoutNotificationRuleKey = keyof typeof NOTIF_CHECKOUT_RULE_ENABLED_KEYS;

/** Checkout scan cadence (minutes). */
export const DEFAULT_CHECKOUT_SCAN_MINUTES = 10;

// --- config ------------------------------------------------------------------

export interface AbandonedCheckoutConfig {
  /** Inactivity minutes before each stage (ascending, unique). Stage N uses index N-1. */
  thresholdMinutes: number[];
  /** Max abandoned reminders across a checkout's whole life. */
  maximumRemindersPerCheckout: number;
  /** A checkout older than this is never reminded (hours). */
  maximumCheckoutAgeHours: number;
}

export const DEFAULT_ABANDONED_CHECKOUT_CONFIG: AbandonedCheckoutConfig = {
  thresholdMinutes: [30, 360],
  maximumRemindersPerCheckout: 2,
  maximumCheckoutAgeHours: 24,
};

export interface FailedPaymentConfig {
  /** Minimum minutes after a definitive failure before a retry reminder. */
  delayMinutes: number;
  /** Max retry reminders for one failed Payment. */
  maximumRemindersPerPayment: number;
  /** Max retry reminders per checkout inside a rolling 24h window. */
  maximumRemindersPerCheckoutPerDay: number;
}

export const DEFAULT_FAILED_PAYMENT_CONFIG: FailedPaymentConfig = {
  delayMinutes: 10,
  maximumRemindersPerPayment: 1,
  maximumRemindersPerCheckoutPerDay: 2,
};

const MAX_THRESHOLD_MINUTES = 30 * 24 * 60; // 30 days
const MAX_THRESHOLD_COUNT = 6;

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
}

/** Parses + validates the abandoned-checkout config JSON; invalid -> fallback (never throws). */
export function parseAbandonedCheckoutConfig(
  raw: unknown,
  fallback: AbandonedCheckoutConfig,
): AbandonedCheckoutConfig {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  const rec = parsed as Record<string, unknown>;
  const thresholds = rec.thresholdMinutes;
  if (
    !Array.isArray(thresholds) ||
    thresholds.length === 0 ||
    thresholds.length > MAX_THRESHOLD_COUNT
  ) {
    return fallback;
  }
  const seen = new Set<number>();
  for (const t of thresholds) {
    if (!isPositiveInt(t, MAX_THRESHOLD_MINUTES) || seen.has(t)) {
      return fallback;
    }
    seen.add(t);
  }
  const sorted = [...(thresholds as number[])].sort((a, b) => a - b);
  if (!isPositiveInt(rec.maximumRemindersPerCheckout, MAX_THRESHOLD_COUNT)) {
    return fallback;
  }
  if (!isPositiveInt(rec.maximumCheckoutAgeHours, 30 * 24)) {
    return fallback;
  }
  return {
    thresholdMinutes: sorted,
    maximumRemindersPerCheckout: rec.maximumRemindersPerCheckout,
    maximumCheckoutAgeHours: rec.maximumCheckoutAgeHours,
  };
}

/** Parses + validates the failed-payment config JSON; invalid -> fallback (never throws). */
export function parseFailedPaymentConfig(
  raw: unknown,
  fallback: FailedPaymentConfig,
): FailedPaymentConfig {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  const rec = parsed as Record<string, unknown>;
  if (!isPositiveInt(rec.delayMinutes, 7 * 24 * 60)) {
    return fallback;
  }
  if (!isPositiveInt(rec.maximumRemindersPerPayment, 5)) {
    return fallback;
  }
  if (!isPositiveInt(rec.maximumRemindersPerCheckoutPerDay, 10)) {
    return fallback;
  }
  return {
    delayMinutes: rec.delayMinutes,
    maximumRemindersPerPayment: rec.maximumRemindersPerPayment,
    maximumRemindersPerCheckoutPerDay: rec.maximumRemindersPerCheckoutPerDay,
  };
}

// --- checkout activity resolver (Part C) -------------------------------------

/**
 * The safe reason for the resolved last-activity instant. Stored for diagnostics
 * only - it NEVER carries receipt text, customer-form answers, provider payloads,
 * card data or credentials.
 */
export type SafeCheckoutActivityReason =
  | "checkout_created"
  | "checkout_updated"
  | "payment_attempt"
  | "receipt_submitted"
  | "customer_input_progress";

/** Safe user-activity timestamps a caller loads for one checkout. */
export interface CheckoutActivityView {
  checkoutCreatedAt: Date;
  checkoutUpdatedAt: Date | null;
  latestPaymentAt: Date | null;
  latestReceiptAt: Date | null;
  latestCustomerInputAt: Date | null;
}

export interface CheckoutActivity {
  lastActivityAt: Date;
  reason: SafeCheckoutActivityReason;
}

/**
 * The latest MEANINGFUL customer activity on a checkout - abandonment is measured
 * from THIS, never from createdAt alone. Only user-driven timestamps are
 * considered; no background-worker timestamp is passed in by callers.
 */
export function resolveCheckoutLastActivity(view: CheckoutActivityView): CheckoutActivity {
  const candidates: Array<{ at: Date; reason: SafeCheckoutActivityReason }> = [
    { at: view.checkoutCreatedAt, reason: "checkout_created" },
  ];
  if (view.checkoutUpdatedAt !== null) {
    candidates.push({ at: view.checkoutUpdatedAt, reason: "checkout_updated" });
  }
  if (view.latestPaymentAt !== null) {
    candidates.push({ at: view.latestPaymentAt, reason: "payment_attempt" });
  }
  if (view.latestReceiptAt !== null) {
    candidates.push({ at: view.latestReceiptAt, reason: "receipt_submitted" });
  }
  if (view.latestCustomerInputAt !== null) {
    candidates.push({ at: view.latestCustomerInputAt, reason: "customer_input_progress" });
  }
  let best = candidates[0];
  for (const c of candidates) {
    if (c.at.getTime() > best.at.getTime()) {
      best = c;
    }
  }
  return { lastActivityAt: best.at, reason: best.reason };
}

// --- abandoned-checkout eligibility (Part D) ---------------------------------

/** The authoritative live checkout state the evaluator reads (loaded by the caller). */
export interface AbandonedCheckoutSnapshot {
  /** CheckoutStatus string. */
  status: string;
  /** settledByPaymentId != null. */
  settled: boolean;
  /** An Order already exists for the checkout. */
  hasOrder: boolean;
  /** getPendingReviewPayment != null (a card-to-card receipt awaits review). */
  hasPendingReviewPayment: boolean;
  /** Any ManualReceipt on the checkout's payments is APPROVED. */
  hasApprovedReceipt: boolean;
  /** Any Payment has settlementStatus SETTLED. */
  hasSettledPayment: boolean;
  /** Any Payment has settlementStatus DUPLICATE_SUCCESS_REVIEW (provider success awaiting reconcile). */
  hasDuplicateSuccessReview: boolean;
  /** An open/in-review FinancialReconciliationCase references the checkout. */
  reconciliationOpen: boolean;
  expiresAt: Date;
  createdAt: Date;
  lastActivityAt: Date;
  /** CheckoutNotificationPreference.abandonedReminderSuppressedAt. */
  suppressedAt: Date | null;
  /** Count of ABANDONED_CHECKOUT notification rows already created for this checkout. */
  existingReminderCount: number;
}

export type AbandonedExclusionReason =
  | "not-pending"
  | "cancelled"
  | "expired"
  | "settled"
  | "order-exists"
  | "receipt-pending"
  | "receipt-approved"
  | "duplicate-success"
  | "reconciliation"
  | "suppressed"
  | "too-old"
  | "max-reached"
  | "too-early";

export type AbandonedEligibility =
  | { eligible: true; stage: number; thresholdMinutes: number }
  | { eligible: false; reason: AbandonedExclusionReason };

/**
 * Whether a checkout should get its NEXT abandoned-checkout reminder now. The
 * caller has already checked the master + rule + user gates. Returns the single
 * applicable stage (1-based) or the first exclusion reason. One reminder per
 * stage, in order; a checkout only advances to stage N once it has exactly N-1
 * reminders and the stage-N inactivity threshold has passed.
 */
export function evaluateAbandonedCheckoutEligibility(
  snap: AbandonedCheckoutSnapshot,
  config: AbandonedCheckoutConfig,
  now: Date,
): AbandonedEligibility {
  if (snap.status === "CANCELLED" || snap.status === "FAILED_REFUNDED") {
    return { eligible: false, reason: "cancelled" };
  }
  if (snap.status === "EXPIRED" || now.getTime() >= snap.expiresAt.getTime()) {
    return { eligible: false, reason: "expired" };
  }
  if (snap.status !== "PENDING") {
    // PAID / COMPLETED and any other non-resumable status.
    return { eligible: false, reason: snap.settled ? "settled" : "not-pending" };
  }
  if (snap.settled || snap.hasSettledPayment) {
    return { eligible: false, reason: "settled" };
  }
  if (snap.hasOrder) {
    return { eligible: false, reason: "order-exists" };
  }
  if (snap.hasPendingReviewPayment) {
    return { eligible: false, reason: "receipt-pending" };
  }
  if (snap.hasApprovedReceipt) {
    return { eligible: false, reason: "receipt-approved" };
  }
  if (snap.hasDuplicateSuccessReview) {
    return { eligible: false, reason: "duplicate-success" };
  }
  if (snap.reconciliationOpen) {
    return { eligible: false, reason: "reconciliation" };
  }
  if (snap.suppressedAt !== null) {
    return { eligible: false, reason: "suppressed" };
  }
  const ageHours = (now.getTime() - snap.createdAt.getTime()) / 3_600_000;
  if (ageHours > config.maximumCheckoutAgeHours) {
    return { eligible: false, reason: "too-old" };
  }
  const nextStage = snap.existingReminderCount + 1;
  if (nextStage > config.maximumRemindersPerCheckout || nextStage > config.thresholdMinutes.length) {
    return { eligible: false, reason: "max-reached" };
  }
  const threshold = config.thresholdMinutes[nextStage - 1];
  const inactiveMinutes = (now.getTime() - snap.lastActivityAt.getTime()) / 60_000;
  if (inactiveMinutes < threshold) {
    return { eligible: false, reason: "too-early" };
  }
  return { eligible: true, stage: nextStage, thresholdMinutes: threshold };
}

// --- failed-payment eligibility (Part J) -------------------------------------

/** Online providers where a fresh payment attempt is meaningful (retry-eligible). */
export const PAYMENT_RETRY_PROVIDERS: readonly string[] = [
  "ZARINPAL",
  "NOWPAYMENTS",
  "TELEGRAM_STARS",
  "AGHAYEPARDAKHT",
  "PLISIO",
  "CUSTOM",
];
const PAYMENT_RETRY_PROVIDER_SET = new Set(PAYMENT_RETRY_PROVIDERS);

export function isRetryEligibleProvider(provider: string | null): boolean {
  return provider !== null && PAYMENT_RETRY_PROVIDER_SET.has(provider);
}

export interface FailedPaymentSnapshot {
  /** PaymentStatus string (must be FAILED or EXPIRED to qualify). */
  paymentStatus: string;
  /** PaymentGatewayType string or null. */
  provider: string | null;
  /** PaymentSettlementStatus of THIS payment. */
  paymentSettlementStatus: string;
  /** When the payment became definitively FAILED/EXPIRED (its updatedAt). */
  failedAt: Date;
  // --- checkout-level (whole-checkout inspection, Part K) ---
  /** settledByPaymentId != null OR checkout status != PENDING. */
  checkoutSettled: boolean;
  hasOrder: boolean;
  hasPendingReviewPayment: boolean;
  reconciliationOpen: boolean;
  /** Any OTHER payment on the checkout succeeded (SETTLED / DUPLICATE_SUCCESS_REVIEW / provider SUCCESS). */
  competingSuccess: boolean;
  checkoutExpired: boolean;
  /** CheckoutNotificationPreference.paymentRetrySuppressedAt. */
  suppressedAt: Date | null;
  /** PAYMENT_RETRY notifications already created for THIS payment. */
  existingRetryCount: number;
  /** PAYMENT_RETRY notifications created for the whole checkout in the last 24h. */
  checkoutRetryCountToday: number;
}

export type PaymentRetryExclusionReason =
  | "not-failed"
  | "excluded-provider"
  | "settled-locally"
  | "settled"
  | "order-exists"
  | "receipt-pending"
  | "reconciliation"
  | "competing-success"
  | "expired"
  | "suppressed"
  | "too-early"
  | "max-per-payment"
  | "max-per-checkout-day";

export type PaymentRetryEligibility =
  | { eligible: true }
  | { eligible: false; reason: PaymentRetryExclusionReason };

/**
 * Whether a definitively-failed online Payment should get a retry reminder now.
 * The caller has already checked the master + rule + user gates. Inspects the
 * WHOLE checkout (not just the one Payment) so a competing success, an open
 * reconciliation, a pending receipt or an existing settlement suppresses it.
 */
export function evaluateFailedPaymentEligibility(
  snap: FailedPaymentSnapshot,
  config: FailedPaymentConfig,
  now: Date,
): PaymentRetryEligibility {
  if (snap.paymentStatus !== "FAILED" && snap.paymentStatus !== "EXPIRED") {
    return { eligible: false, reason: "not-failed" };
  }
  if (!isRetryEligibleProvider(snap.provider)) {
    return { eligible: false, reason: "excluded-provider" };
  }
  if (snap.paymentSettlementStatus === "SETTLED") {
    return { eligible: false, reason: "settled-locally" };
  }
  if (snap.checkoutSettled) {
    return { eligible: false, reason: "settled" };
  }
  if (snap.hasOrder) {
    return { eligible: false, reason: "order-exists" };
  }
  if (snap.hasPendingReviewPayment) {
    return { eligible: false, reason: "receipt-pending" };
  }
  if (snap.reconciliationOpen) {
    return { eligible: false, reason: "reconciliation" };
  }
  if (snap.competingSuccess) {
    return { eligible: false, reason: "competing-success" };
  }
  if (snap.checkoutExpired) {
    return { eligible: false, reason: "expired" };
  }
  if (snap.suppressedAt !== null) {
    return { eligible: false, reason: "suppressed" };
  }
  const elapsedMinutes = (now.getTime() - snap.failedAt.getTime()) / 60_000;
  if (elapsedMinutes < config.delayMinutes) {
    return { eligible: false, reason: "too-early" };
  }
  if (snap.existingRetryCount >= config.maximumRemindersPerPayment) {
    return { eligible: false, reason: "max-per-payment" };
  }
  if (snap.checkoutRetryCountToday >= config.maximumRemindersPerCheckoutPerDay) {
    return { eligible: false, reason: "max-per-checkout-day" };
  }
  return { eligible: true };
}

// --- dedupe fingerprints -----------------------------------------------------

/** checkout:<id>:abandoned:v1:<stage> — one row per checkout per abandoned stage. */
export function checkoutAbandonedDedupeKey(checkoutId: string, stage: number): string {
  return `checkout:${checkoutId}:abandoned:v1:${stage}`;
}

/** payment:<id>:retry:v1 — one row per definitively failed Payment. */
export function paymentRetryDedupeKey(paymentId: string): string {
  return `payment:${paymentId}:retry:v1`;
}
