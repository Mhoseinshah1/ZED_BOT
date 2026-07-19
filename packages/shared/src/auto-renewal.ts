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

/**
 * The dedupe key for the ONE advance pre-charge notice of a mandate + expiry cycle
 * (Corrective Phase, Part D). Keyed on the cycle fingerprint — NOT the serviceId —
 * so a later valid cycle gets its own notice and a stale cycle can never re-notify.
 * Version-suffixed (`:upcoming:v1`) so a future template revision can mint a new key
 * without colliding with historical rows. Distinct from the settlement idempotency
 * key above: one cycle owns exactly one upcoming notice AND one deduction.
 */
export function autoRenewalUpcomingDedupeKey(mandateId: string, cycleFingerprint: string): string {
  return `wallet-auto-renewal:${mandateId}:${cycleFingerprint}:upcoming:v1`;
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

// --- pre-charge notice scheduling (Corrective Phase, Part A) ------------------
//
// The timing contract for the durable advance notice normally delivered ~24h
// before the wallet deduction:
//   expectedChargeAt  = Service.expiresAt − chargeLeadMinutes
//   prechargeNoticeAt = expectedChargeAt  − prechargeNoticeMinutes
// Every helper here is pure and deterministic in its inputs (no clock, no I/O) so
// the scan, the admin dry-run preview and the unit tests all agree by construction.

/**
 * The expected wallet-deduction instant for a cycle: the Service expiry minus the
 * mandate's charge-lead window. Null when the Service has no finite expiry (an
 * unlimited-time Service is never auto-renewed). This is the SAME instant the scan
 * targets for the charge — the pre-charge notice is scheduled relative to it, so the
 * notice and the deduction can never drift apart.
 */
export function resolveAutoRenewalExpectedChargeAt(input: {
  expiresAtEpoch: number | null;
  chargeLeadMinutes: number;
}): number | null {
  if (input.expiresAtEpoch === null || !Number.isFinite(input.expiresAtEpoch)) {
    return null;
  }
  return Math.trunc(input.expiresAtEpoch) - input.chargeLeadMinutes * 60_000;
}

/**
 * The instant the advance pre-charge notice should normally be delivered: the
 * expected charge time minus the configured advance-notice window. Null when there
 * is no finite expiry OR the advance notice is disabled (noticeMinutes <= 0) — in
 * both cases no advance notice is scheduled and the charge itself is unaffected.
 */
export function resolveAutoRenewalPrechargeNoticeAt(input: {
  expiresAtEpoch: number | null;
  chargeLeadMinutes: number;
  prechargeNoticeMinutes: number;
}): number | null {
  if (input.prechargeNoticeMinutes <= 0) {
    return null;
  }
  const expectedChargeAt = resolveAutoRenewalExpectedChargeAt(input);
  if (expectedChargeAt === null) {
    return null;
  }
  return expectedChargeAt - input.prechargeNoticeMinutes * 60_000;
}

export type AutoRenewalNoticeScheduleKind = "scheduled" | "catch-up" | "missed" | "disabled";

export interface AutoRenewalNoticeSchedule {
  /**
   * - `scheduled` : the advance-notice instant is still in the future → create the
   *                 durable notice with scheduledFor = prechargeNoticeAt.
   * - `catch-up`  : the advance-notice instant already passed but the charge is
   *                 still in the future → deliver now (scheduledFor = now) with
   *                 truthful "renewal nears" wording, never a false "24h" claim.
   * - `missed`    : the charge is already due/past → do NOT create a misleading
   *                 upcoming notice; the caller records `precharge-window-missed`
   *                 and continues the existing charge behaviour unchanged.
   * - `disabled`  : the operator disabled the advance notice (noticeMinutes 0), or
   *                 the Service has no finite expiry → no notice; charge unaffected.
   */
  kind: AutoRenewalNoticeScheduleKind;
  /** The expected wallet-deduction instant (null only when there is no finite expiry). */
  expectedChargeAtEpoch: number | null;
  /** When to deliver the notice (null for `missed`/`disabled`). */
  scheduledForEpoch: number | null;
  /** After this instant the notice is stale and must be EXPIRED, never delivered. */
  availableUntilEpoch: number | null;
}

/**
 * Pure classifier deciding whether — and when — an advance pre-charge notice is
 * created for a cycle. Deterministic in (expiresAt, chargeLead, noticeMinutes, now);
 * no clock and no I/O. The worker scan turns a `scheduled`/`catch-up` result into a
 * durable AutomatedNotification and leaves `missed`/`disabled` cycles to charge
 * exactly as before. The availableUntil is always the expected charge instant, so a
 * notice that could not be delivered before the deduction is EXPIRED rather than sent
 * after the money already moved.
 */
export function resolveAutoRenewalNoticeSchedule(input: {
  expiresAtEpoch: number | null;
  chargeLeadMinutes: number;
  prechargeNoticeMinutes: number;
  nowEpoch: number;
}): AutoRenewalNoticeSchedule {
  const expectedChargeAtEpoch = resolveAutoRenewalExpectedChargeAt(input);
  // No finite expiry → ineligible; the charge path never runs, so no notice.
  if (expectedChargeAtEpoch === null) {
    return {
      kind: "disabled",
      expectedChargeAtEpoch: null,
      scheduledForEpoch: null,
      availableUntilEpoch: null,
    };
  }
  // Advance notice switched off globally — the charge is unaffected.
  if (input.prechargeNoticeMinutes <= 0) {
    return {
      kind: "disabled",
      expectedChargeAtEpoch,
      scheduledForEpoch: null,
      availableUntilEpoch: expectedChargeAtEpoch,
    };
  }
  // The charge window has already arrived → an "upcoming" message would be untruthful.
  if (input.nowEpoch >= expectedChargeAtEpoch) {
    return {
      kind: "missed",
      expectedChargeAtEpoch,
      scheduledForEpoch: null,
      availableUntilEpoch: expectedChargeAtEpoch,
    };
  }
  const prechargeNoticeAtEpoch = expectedChargeAtEpoch - input.prechargeNoticeMinutes * 60_000;
  if (input.nowEpoch < prechargeNoticeAtEpoch) {
    // Normal path: the notice instant is still in the future.
    return {
      kind: "scheduled",
      expectedChargeAtEpoch,
      scheduledForEpoch: prechargeNoticeAtEpoch,
      availableUntilEpoch: expectedChargeAtEpoch,
    };
  }
  // The notice instant passed but the charge is still ahead → deliver now.
  return {
    kind: "catch-up",
    expectedChargeAtEpoch,
    scheduledForEpoch: input.nowEpoch,
    availableUntilEpoch: expectedChargeAtEpoch,
  };
}

/**
 * Charge-race gate tuning (Corrective Phase, Part J). When the cycle's upcoming
 * notice is mid-flight (READY/SENDING) the scan briefly defers the charge in small
 * steps rather than blocking indefinitely; past the hard cap it proceeds anyway and
 * records `precharge-delivery-unconfirmed` (a Telegram outage must never freeze a
 * consented charge). The cap is derivable from the expected charge instant — no new
 * persistent state is introduced.
 */
export const AUTO_RENEWAL_PRECHARGE_GATE_STEP_MS = 5 * 60_000;
export const AUTO_RENEWAL_PRECHARGE_GATE_MAX_DEFER_MS = 30 * 60_000;

/** Reason codes recorded on the Attempt when the notice window/ delivery was atypical. */
export const AUTO_RENEWAL_PRECHARGE_WINDOW_MISSED_REASON = "precharge-window-missed";
export const AUTO_RENEWAL_PRECHARGE_DELIVERY_UNCONFIRMED_REASON = "precharge-delivery-unconfirmed";

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
  // --- pre-charge notice heartbeat (Corrective Phase, Part R) ---------------
  /** When the scan last evaluated the pre-charge notice schedule. */
  lastWalletPrechargeScheduleAt?: string | null;
  /** Advance notices created for a future scheduledFor in the last scan. */
  walletPrechargeScheduledCount?: number;
  /** Catch-up notices created for immediate delivery (notice window already open). */
  walletPrechargeCatchUpCount?: number;
  /** Upcoming notices confirmed delivered (status SENT) since the counter reset. */
  walletPrechargeSentCount?: number;
  /** Upcoming notices that failed delivery (FAILED/DEAD_LETTER) — charge still guarded. */
  walletPrechargeFailedCount?: number;
  /** Upcoming notices EXPIRED because the charge instant arrived before delivery. */
  walletPrechargeExpiredCount?: number;
}

// --- SystemLog event names (Corrective Phase, Part S) ------------------------
//
// PII-free structured event names for the Telegram log group / SystemLog. Payloads
// carry counts + safe fingerprints only — never a user id, telegram id, service id,
// mandate id, wallet balance or message body.
export const WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS = {
  prechargeScheduled: "wallet_auto_renewal.precharge_scheduled",
  prechargeCatchUp: "wallet_auto_renewal.precharge_catch_up",
  prechargeCancelled: "wallet_auto_renewal.precharge_cancelled",
  prechargeExpired: "wallet_auto_renewal.precharge_expired",
  prechargeDeliveryUnconfirmed: "wallet_auto_renewal.precharge_delivery_unconfirmed",
  prechargeSettingChanged: "wallet_auto_renewal.precharge_setting_changed",
} as const;
export type WalletAutoRenewalSystemLogEvent =
  (typeof WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS)[keyof typeof WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS];
