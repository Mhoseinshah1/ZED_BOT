import { randomBytes } from "node:crypto";

// =============================================================================
// Telegram Stars service subscriptions (Automatic Renewal Phase 2) — the ONE
// dependency-free (no prisma / bullmq / grammy) contract shared by the payments
// adapter, the bot enrollment/handler/settlement services, the worker recovery
// engine and the tests. It holds: the official protocol constants, the
// non-enumerable invoice-payload scheme (`zedbot:sub:<publicPayloadId>`, kept
// STRICTLY separate from the one-time `zedbot:pay:` scheme), the settings keys +
// validated config, the amount/period validators, and the queue/job identifiers.
//
// The whole system is DISABLED by default and funds renewals ONLY from a Telegram
// Stars subscription — never the internal wallet.
// =============================================================================

// --- official Telegram protocol constants (hard requirements) ----------------

/** The ONLY period Telegram supports for bot Star subscriptions (30 days). */
export const STARS_SUBSCRIPTION_PERIOD_SECONDS = 2592000;
/** Telegram invoice currency for Stars. */
export const STARS_CURRENCY = "XTR";
/** Telegram Star subscription amount bounds (inclusive). */
export const MIN_SUBSCRIPTION_STARS = 1;
export const MAX_SUBSCRIPTION_STARS = 10000;

/** True when a Stars subscription amount is within the official bounds. */
export function isValidStarsSubscriptionAmount(stars: unknown): stars is number {
  return (
    typeof stars === "number" &&
    Number.isInteger(stars) &&
    stars >= MIN_SUBSCRIPTION_STARS &&
    stars <= MAX_SUBSCRIPTION_STARS
  );
}

// --- non-enumerable invoice payload (kept separate from one-time zedbot:pay:) -

/** Subscription invoice payload prefix. NEVER reuse the one-time `zedbot:pay:`. */
export const STARS_SUBSCRIPTION_PAYLOAD_PREFIX = "zedbot:sub:";

/**
 * A cryptographically-random, non-enumerable public identifier (24 bytes →
 * 32 base64url chars). Carries NO user/service/product id, no price, no secret.
 * The `zedbot:sub:<publicPayloadId>` payload stays well under Telegram's 128-byte
 * limit (11 + 32 = 43 bytes).
 */
export function generateStarsSubscriptionPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

/** Builds the subscription invoice payload. */
export function buildStarsSubscriptionPayload(publicPayloadId: string): string {
  return `${STARS_SUBSCRIPTION_PAYLOAD_PREFIX}${publicPayloadId}`;
}

/**
 * Extracts the public payload id from a subscription invoice payload, or null.
 * A `zedbot:pay:` (one-time) or foreign payload returns null — the handler
 * dispatches strictly by prefix and never confuses the two schemes.
 */
export function parseStarsSubscriptionPayload(payload: string): string | null {
  if (!payload.startsWith(STARS_SUBSCRIPTION_PAYLOAD_PREFIX)) {
    return null;
  }
  const id = payload.slice(STARS_SUBSCRIPTION_PAYLOAD_PREFIX.length);
  // Base64url of 24 bytes is exactly 32 chars; accept a safe bounded shape only.
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}

// --- settings keys (8 Phase-2 settings, Part Z) ------------------------------

export const TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY = "telegram_stars_subscriptions_enabled";
export const TELEGRAM_STARS_SUBSCRIPTION_GRACE_MINUTES_KEY =
  "telegram_stars_subscription_grace_minutes";
export const TELEGRAM_STARS_SUBSCRIPTION_RECONCILE_MINUTES_KEY =
  "telegram_stars_subscription_reconcile_minutes";
export const TELEGRAM_STARS_SUBSCRIPTION_TRANSACTION_LOOKBACK_HOURS_KEY =
  "telegram_stars_subscription_transaction_lookback_hours";
export const TELEGRAM_STARS_SUBSCRIPTION_REFUND_MAX_ATTEMPTS_KEY =
  "telegram_stars_subscription_refund_max_attempts";
export const TELEGRAM_STARS_SUBSCRIPTION_PENDING_ENROLLMENT_MINUTES_KEY =
  "telegram_stars_subscription_pending_enrollment_minutes";
export const TELEGRAM_STARS_SUBSCRIPTION_CHARGE_RETENTION_DAYS_KEY =
  "telegram_stars_subscription_charge_retention_days";
export const TELEGRAM_STARS_SUBSCRIPTION_CONSENT_VERSION_KEY =
  "telegram_stars_subscription_consent_version";

// --- config ------------------------------------------------------------------

export interface StarsSubscriptionConfig {
  /** How long after currentPeriodEndsAt to wait before marking PAST_DUE (min). */
  graceMinutes: number;
  /** Worker reconcile cadence (minutes). */
  reconcileMinutes: number;
  /** Bounded getStarTransactions recovery lookback window (hours). */
  transactionLookbackHours: number;
  /** Bounded refund retries on a failed refund call. */
  refundMaxAttempts: number;
  /** How long a PENDING_PAYMENT enrollment lives before it is abandoned (min). */
  pendingEnrollmentMinutes: number;
  /** How long terminal charges are retained before cleanup (days). */
  chargeRetentionDays: number;
  /** Current consent version; a bump requires fresh consent to keep renewing. */
  consentVersion: number;
}

export const DEFAULT_STARS_SUBSCRIPTION_CONFIG: StarsSubscriptionConfig = {
  graceMinutes: 180,
  reconcileMinutes: 15,
  transactionLookbackHours: 72,
  refundMaxAttempts: 5,
  pendingEnrollmentMinutes: 60,
  chargeRetentionDays: 730,
  consentVersion: 1,
};

// bounds (each value validated + clamped; an invalid stored value → the default)
export const STARS_SUB_MIN_GRACE_MINUTES = 0;
export const STARS_SUB_MAX_GRACE_MINUTES = 30 * 24 * 60;
export const STARS_SUB_MIN_RECONCILE_MINUTES = 1;
export const STARS_SUB_MAX_RECONCILE_MINUTES = 24 * 60;
export const STARS_SUB_MIN_LOOKBACK_HOURS = 1;
export const STARS_SUB_MAX_LOOKBACK_HOURS = 30 * 24;
export const STARS_SUB_MIN_REFUND_ATTEMPTS = 1;
export const STARS_SUB_MAX_REFUND_ATTEMPTS = 20;
export const STARS_SUB_MIN_PENDING_MINUTES = 5;
export const STARS_SUB_MAX_PENDING_MINUTES = 24 * 60;
export const STARS_SUB_MIN_RETENTION_DAYS = 90;
export const STARS_SUB_MAX_RETENTION_DAYS = 3650;

export function clampStarsSubInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

// --- queue / job identifiers (worker recovery engine) ------------------------

/** Worker-owned queue: subscription reconcile / expiration / refund / cleanup. */
export const STARS_SUBSCRIPTION_QUEUE_NAME = "stars-subscription";

export const STARS_SUBSCRIPTION_JOB_NAMES = {
  RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS: "RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS",
  RECONCILE_STARS_SUBSCRIPTION_EXPIRATIONS: "RECONCILE_STARS_SUBSCRIPTION_EXPIRATIONS",
  RECONCILE_STARS_SUBSCRIPTION_REFUNDS: "RECONCILE_STARS_SUBSCRIPTION_REFUNDS",
  CLEANUP_STARS_SUBSCRIPTION_CHARGES: "CLEANUP_STARS_SUBSCRIPTION_CHARGES",
} as const;
export type StarsSubscriptionJobName =
  (typeof STARS_SUBSCRIPTION_JOB_NAMES)[keyof typeof STARS_SUBSCRIPTION_JOB_NAMES];

export const STARS_SUBSCRIPTION_SCHEDULER_IDS = {
  transactions: "stars-sub-sched-tx",
  expirations: "stars-sub-sched-exp",
  refunds: "stars-sub-sched-refund",
  cleanup: "stars-sub-sched-cleanup",
} as const;

/** Redis lock: only one subscription reconcile runs at a time across copies. */
export const STARS_SUBSCRIPTION_RECONCILE_LOCK_KEY = "zedbot:stars-sub-reconcile-lock";

// --- worker status fields (rolling-upgrade-safe, counts + timestamps only) ----

export interface StarsSubscriptionStatusFields {
  starsSubscriptionsEnabled?: boolean;
  lastStarsSubscriptionReconcileAt?: string | null;
  starsSubscriptionsActive?: number;
  starsSubscriptionChargesProcessed?: number;
  starsSubscriptionChargesRefunded?: number;
  starsSubscriptionPastDue?: number;
  starsSubscriptionRequiresAction?: number;
  starsSubscriptionFailures?: number;
}
