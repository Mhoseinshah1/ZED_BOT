import { createHash } from "node:crypto";

// =============================================================================
// Wallet auto-renewal (Phase 1) — the ONE dependency-free (no prisma / bullmq)
// contract shared by the worker scan/reconcile, the execute consumer, the admin
// dry-run preview and the tests. It holds: settings keys + validated config, the
// stable expiry-cycle fingerprint, the due-evaluation and price-ceiling
// evaluators, the queue/job identifiers and the worker-status fields. Every rule
// here is pure and unit-testable without a database.
//
// The whole system is DISABLED by default and funds renewals ONLY from the user's
// internal wallet (AutoRenewalFundingMethod = WALLET). No mandate is created
// without explicit versioned consent; no charge exceeds the user's ceiling; no
// charge uses a stale Service expiry cycle.
// =============================================================================

/** Phase-1 funding method — wallet only (Telegram Stars subscriptions are next). */
export const AUTO_RENEWAL_FUNDING_METHOD_WALLET = "WALLET" as const;

// --- settings keys (the 9 Phase-1 settings, Part G) --------------------------

export const WALLET_AUTO_RENEWAL_ENABLED_KEY = "wallet_auto_renewal_enabled";
export const WALLET_AUTO_RENEWAL_SCAN_MINUTES_KEY = "wallet_auto_renewal_scan_minutes";
export const WALLET_AUTO_RENEWAL_DEFAULT_CHARGE_LEAD_MINUTES_KEY =
  "wallet_auto_renewal_default_charge_lead_minutes";
export const WALLET_AUTO_RENEWAL_PRECHARGE_NOTICE_MINUTES_KEY =
  "wallet_auto_renewal_precharge_notice_minutes";
export const WALLET_AUTO_RENEWAL_INSUFFICIENT_RETRY_INTERVALS_KEY =
  "wallet_auto_renewal_insufficient_retry_intervals_minutes";
export const WALLET_AUTO_RENEWAL_GRACE_HOURS_KEY = "wallet_auto_renewal_grace_hours";
export const WALLET_AUTO_RENEWAL_MAX_ATTEMPTS_PER_CYCLE_KEY =
  "wallet_auto_renewal_max_attempts_per_cycle";
export const WALLET_AUTO_RENEWAL_ATTEMPT_RETENTION_DAYS_KEY =
  "wallet_auto_renewal_attempt_retention_days";
export const WALLET_AUTO_RENEWAL_CONSENT_VERSION_KEY = "wallet_auto_renewal_consent_version";

// --- config ------------------------------------------------------------------

export interface WalletAutoRenewalConfig {
  /** How often the worker scan runs (minutes). */
  scanMinutes: number;
  /** Default lead time before expiry to attempt the charge (minutes). */
  defaultChargeLeadMinutes: number;
  /** How long before the expected charge to send the pre-charge notice (minutes). */
  prechargeNoticeMinutes: number;
  /** Bounded retry offsets (minutes) after an insufficient-balance result. */
  insufficientRetryIntervalsMinutes: number[];
  /** How long after expiry a cycle may still be renewed before giving up (hours). */
  graceHours: number;
  /** Max attempts generated across one expiry cycle. */
  maxAttemptsPerCycle: number;
  /** How long terminal attempts are retained before cleanup (days). */
  attemptRetentionDays: number;
  /** The current consent version — a bump requires fresh consent to keep renewing. */
  consentVersion: number;
}

export const DEFAULT_WALLET_AUTO_RENEWAL_CONFIG: WalletAutoRenewalConfig = {
  scanMinutes: 5,
  defaultChargeLeadMinutes: 180,
  prechargeNoticeMinutes: 1440,
  insufficientRetryIntervalsMinutes: [0, 360, 1440],
  graceHours: 48,
  maxAttemptsPerCycle: 3,
  attemptRetentionDays: 365,
  consentVersion: 1,
};

// bounds (all values validated + clamped; an invalid stored value → the default)
export const AUTO_RENEWAL_MIN_SCAN_MINUTES = 1;
export const AUTO_RENEWAL_MAX_SCAN_MINUTES = 24 * 60;
export const AUTO_RENEWAL_MIN_CHARGE_LEAD_MINUTES = 5;
export const AUTO_RENEWAL_MAX_CHARGE_LEAD_MINUTES = 30 * 24 * 60; // 30 days
export const AUTO_RENEWAL_MIN_PRECHARGE_NOTICE_MINUTES = 0;
export const AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES = 30 * 24 * 60;
export const AUTO_RENEWAL_MIN_GRACE_HOURS = 0;
export const AUTO_RENEWAL_MAX_GRACE_HOURS = 30 * 24; // 30 days
export const AUTO_RENEWAL_MIN_MAX_ATTEMPTS = 1;
export const AUTO_RENEWAL_MAX_MAX_ATTEMPTS = 10;
export const AUTO_RENEWAL_MIN_RETENTION_DAYS = 30;
export const AUTO_RENEWAL_MAX_RETENTION_DAYS = 3650;
export const AUTO_RENEWAL_MIN_RETRY_INTERVALS = 1;
export const AUTO_RENEWAL_MAX_RETRY_INTERVALS = 6;
export const AUTO_RENEWAL_MAX_RETRY_INTERVAL_MINUTES = 30 * 24 * 60;

/** Wallet-charge ceiling bounds: a mandate ceiling must sit in a sane range. */
export const AUTO_RENEWAL_MIN_CEILING_TOMAN = 1_000;
export const AUTO_RENEWAL_MAX_CEILING_TOMAN = 100_000_000;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

/**
 * Parses the stored insufficient-balance retry intervals (minutes). Config-parser-
 * with-sentinel-fallback: a non-array, wrong-length, non-integer, negative,
 * out-of-range or non-ascending value returns the WHOLE fallback (never a partial
 * or unbounded schedule); never throws.
 */
export function parseRetryIntervals(raw: unknown, fallback: number[]): number[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < AUTO_RENEWAL_MIN_RETRY_INTERVALS ||
    parsed.length > AUTO_RENEWAL_MAX_RETRY_INTERVALS
  ) {
    return fallback;
  }
  // Strictly ascending, non-negative, bounded integers (the first may be 0).
  let previous = -1;
  for (const v of parsed) {
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < 0 ||
      v > AUTO_RENEWAL_MAX_RETRY_INTERVAL_MINUTES ||
      v <= previous
    ) {
      return fallback;
    }
    previous = v;
  }
  return [...(parsed as number[])];
}

// --- expiry-cycle fingerprint ------------------------------------------------

export interface AutoRenewalCycleInput {
  serviceId: string;
  /** The authoritative Service.expiresAt as epoch ms (must be finite). */
  expiresAtEpoch: number | null;
  productId: string;
  /** Renewal entitlement version — bump to invalidate all in-flight cycles. */
  entitlementVersion?: number;
}

/**
 * Stable expiry-cycle fingerprint. Changes after a successful renewal extends the
 * Service (new expiresAt) OR the selected Product changes OR the entitlement
 * version bumps — so a later valid cycle is always a NEW attempt, and a stale
 * cycle can never re-activate. Returns null when there is no finite expiry (an
 * unlimited-time Service is ineligible and must never be auto-renewed). The raw
 * inputs (serviceId, expiresAt) never enter Telegram callbacks — this is an
 * internal key only.
 */
export function buildAutoRenewalCycleFingerprint(input: AutoRenewalCycleInput): string | null {
  if (input.expiresAtEpoch === null || !Number.isFinite(input.expiresAtEpoch)) {
    return null;
  }
  const version = input.entitlementVersion ?? 1;
  const material = `${input.serviceId}|${Math.trunc(input.expiresAtEpoch)}|${input.productId}|v${version}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** The wallet-settlement idempotency key for one mandate + cycle (one deduction). */
export function autoRenewalIdempotencyKey(mandateId: string, cycleFingerprint: string): string {
  return `wallet-auto-renew:${mandateId}:${cycleFingerprint}`;
}

// --- due evaluation + price ceiling ------------------------------------------

/** True when the Service is inside the configured charge lead window (or past). */
export function isAutoRenewalDue(input: {
  expiresAtEpoch: number | null;
  nowEpoch: number;
  chargeLeadMinutes: number;
}): boolean {
  if (input.expiresAtEpoch === null || !Number.isFinite(input.expiresAtEpoch)) {
    return false;
  }
  return input.expiresAtEpoch - input.nowEpoch <= input.chargeLeadMinutes * 60_000;
}

/**
 * True when the cycle is still within the post-expiry grace window (a very-late
 * cycle is abandoned rather than renewed against a long-dead expiry).
 */
export function isWithinAutoRenewalGrace(input: {
  expiresAtEpoch: number | null;
  nowEpoch: number;
  graceHours: number;
}): boolean {
  if (input.expiresAtEpoch === null || !Number.isFinite(input.expiresAtEpoch)) {
    return false;
  }
  return input.nowEpoch - input.expiresAtEpoch <= input.graceHours * 3_600_000;
}

export interface AutoRenewalChargeDecision {
  /** True when the live price is at/under the ceiling and a charge may proceed. */
  eligible: boolean;
  /** The amount to charge = the LIVE price (the lower of live vs ceiling is live). */
  chargeToman: number;
  reason: "ok" | "price-above-limit" | "invalid-price";
}

/**
 * Resolves the charge for the LIVE product price against the user's ceiling.
 * Never charges an unexpected amount: a live price above the ceiling yields NO
 * charge (price-above-limit → pause); a live price at/under the ceiling charges
 * the live (possibly lower) price, never the stored higher one.
 */
export function resolveAutoRenewalCharge(
  livePriceToman: number,
  maximumChargeToman: number,
): AutoRenewalChargeDecision {
  if (!Number.isInteger(livePriceToman) || livePriceToman <= 0) {
    return { eligible: false, chargeToman: 0, reason: "invalid-price" };
  }
  if (livePriceToman > maximumChargeToman) {
    return { eligible: false, chargeToman: 0, reason: "price-above-limit" };
  }
  return { eligible: true, chargeToman: livePriceToman, reason: "ok" };
}

/** Validates a user-entered ceiling (Toman), which must cover the current price. */
export function isValidCeiling(ceilingToman: unknown, currentPriceToman: number): boolean {
  return (
    typeof ceilingToman === "number" &&
    Number.isInteger(ceilingToman) &&
    ceilingToman >= AUTO_RENEWAL_MIN_CEILING_TOMAN &&
    ceilingToman <= AUTO_RENEWAL_MAX_CEILING_TOMAN &&
    ceilingToman >= currentPriceToman
  );
}

// --- queue / job identifiers -------------------------------------------------

/** Worker-owned queue: scan / reconcile / cleanup. */
export const AUTO_RENEWAL_QUEUE_NAME = "service-auto-renewal";
/** The EXECUTE queue consumed by the bot process (co-located with fulfillment). */
export const AUTO_RENEWAL_EXECUTE_QUEUE_NAME = "service-auto-renewal-execute";

export const AUTO_RENEWAL_JOB_NAMES = {
  SCAN_WALLET_AUTO_RENEWALS: "SCAN_WALLET_AUTO_RENEWALS",
  EXECUTE_WALLET_AUTO_RENEWAL: "EXECUTE_WALLET_AUTO_RENEWAL",
  RECONCILE_WALLET_AUTO_RENEWALS: "RECONCILE_WALLET_AUTO_RENEWALS",
  CLEANUP_WALLET_AUTO_RENEWAL_ATTEMPTS: "CLEANUP_WALLET_AUTO_RENEWAL_ATTEMPTS",
} as const;
export type AutoRenewalJobName =
  (typeof AUTO_RENEWAL_JOB_NAMES)[keyof typeof AUTO_RENEWAL_JOB_NAMES];

export const AUTO_RENEWAL_SCHEDULER_IDS = {
  scan: "war-sched-scan",
  reconcile: "war-sched-reconcile",
  cleanup: "war-sched-cleanup",
} as const;

/** Redis lock: only one auto-renewal scan runs at a time across scheduler copies. */
export const AUTO_RENEWAL_SCAN_LOCK_KEY = "zedbot:war-scan-lock";

/** Idempotent per-attempt execute job id (retry/duplicate collapse onto one). */
export function autoRenewalExecuteJobId(attemptId: string): string {
  return `war-exec-${attemptId}`;
}

// --- worker status fields ----------------------------------------------------

/**
 * Auto-renewal fields added to the worker status snapshot (all optional for
 * rolling upgrades; the admin page renders "نامشخص" when absent). Counts +
 * timestamps only — never a user id, service id, order id or balance.
 */
export interface WalletAutoRenewalStatusFields {
  walletAutoRenewalEnabled?: boolean;
  lastWalletAutoRenewalScanAt?: string | null;
  autoRenewalDueCount?: number;
  autoRenewalCompletedCount?: number;
  autoRenewalInsufficientBalanceCount?: number;
  autoRenewalRequiresActionCount?: number;
  autoRenewalFailureCount?: number;
}
