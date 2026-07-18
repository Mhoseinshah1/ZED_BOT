import { createHash } from "node:crypto";

// =============================================================================
// Customer win-back (Phase 3) — the ONE dependency-free (no prisma / bullmq)
// contract shared by the worker scan, the delivery re-validation and the admin
// dry-run preview. It holds: settings keys + validated config, the pure paid-
// service disposition classifier (effective-end precedence), the customer
// lifecycle segment resolver, the win-back eligibility evaluator (stage +
// catch-up), the lapse-cycle fingerprint and the dedupe key. Every rule is unit-
// testable without a database.
//
// CUSTOMER_WINBACK is a MARKETING notification: it is DISABLED by default and no
// message is ever produced unless the global master switch AND the win-back rule
// AND the user's cron AND marketing category switches are all on. It targets ONLY
// genuine previous PAYING VPN customers who currently have NO usable paid service.
// =============================================================================

// --- settings keys -----------------------------------------------------------

export const NOTIF_WINBACK_ENABLED_KEY = "notification_customer_winback_enabled";
export const NOTIF_WINBACK_CONFIG_KEY = "notification_winback_config";
export const NOTIF_RETENTION_SCAN_MINUTES_KEY = "notification_schedule_retention_scan_minutes";

/** Retention (win-back) scan cadence — once a day by default. */
export const DEFAULT_RETENTION_SCAN_MINUTES = 1440;

// --- config ------------------------------------------------------------------

export interface WinbackConfig {
  /** Days-inactive threshold for each stage (ascending, unique). Stage N = index N-1. */
  stageDays: number[];
  /** UserGroup values eligible for win-back (default only normal users "F"). */
  allowedUserGroups: string[];
  /** Minimum completed paid Service orders to count as a previous paying customer. */
  minimumCompletedPaidOrders: number;
  /** Minimum lifetime paid Service spend (Toman) to qualify (0 = no floor). */
  minimumLifetimeSpendToman: number;
  /** Default snooze length (days) applied by the «فعلاً یادآوری نکن» button. */
  snoozeDays: number;
  /** Max win-back notifications generated across one lapse cycle. */
  maximumNotificationsPerLapseCycle: number;
  /** A paid service state older than this is treated as UNCERTAIN (needs sync). */
  serviceStateMaxAgeMinutes: number;
}

export const DEFAULT_WINBACK_CONFIG: WinbackConfig = {
  stageDays: [30, 60, 90],
  allowedUserGroups: ["F"],
  minimumCompletedPaidOrders: 1,
  minimumLifetimeSpendToman: 0,
  snoozeDays: 30,
  maximumNotificationsPerLapseCycle: 3,
  serviceStateMaxAgeMinutes: 20,
};

/** Real UserGroup enum values (kept as literals so shared has no prisma dep). */
export const WINBACK_USER_GROUP_VALUES = ["F", "N", "N2"] as const;

const MIN_STAGE_DAYS = 7;
const MAX_STAGE_DAYS = 730;
const MAX_STAGE_COUNT = 6;
const MAX_SNOOZE_DAYS = 365;
const MAX_MIN_ORDERS = 100;
const MAX_SPEND_TOMAN = Number.MAX_SAFE_INTEGER;
const MAX_SERVICE_STATE_AGE_MINUTES = 7 * 24 * 60; // 7 days

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Parses + validates the win-back config JSON; ANY invalid field -> the supplied
 * fallback (never throws, never yields an unbounded campaign). Enforces: unique
 * ascending stage days (>=7, <=730, <=6 of them), allowed groups drawn only from
 * the real UserGroup enum, minimum orders 1..100, non-negative safe spend, snooze
 * 1..365, max-per-cycle <= stage count, bounded service-state age.
 */
export function parseWinbackConfig(raw: unknown, fallback: WinbackConfig): WinbackConfig {
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

  // stageDays: unique, in range, count-bounded; sorted ascending.
  const stages = rec.stageDays;
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > MAX_STAGE_COUNT) {
    return fallback;
  }
  const seen = new Set<number>();
  for (const s of stages) {
    if (!isIntInRange(s, MIN_STAGE_DAYS, MAX_STAGE_DAYS) || seen.has(s)) {
      return fallback;
    }
    seen.add(s);
  }
  const stageDays = [...(stages as number[])].sort((a, b) => a - b);

  // allowedUserGroups: non-empty subset of the real enum.
  const groups = rec.allowedUserGroups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return fallback;
  }
  const groupSeen = new Set<string>();
  for (const g of groups) {
    if (
      typeof g !== "string" ||
      !(WINBACK_USER_GROUP_VALUES as readonly string[]).includes(g) ||
      groupSeen.has(g)
    ) {
      return fallback;
    }
    groupSeen.add(g);
  }
  const allowedUserGroups = [...groupSeen];

  if (!isIntInRange(rec.minimumCompletedPaidOrders, 1, MAX_MIN_ORDERS)) {
    return fallback;
  }
  if (!isIntInRange(rec.minimumLifetimeSpendToman, 0, MAX_SPEND_TOMAN)) {
    return fallback;
  }
  if (!isIntInRange(rec.snoozeDays, 1, MAX_SNOOZE_DAYS)) {
    return fallback;
  }
  // Max-per-cycle cannot exceed the number of configured stages.
  if (!isIntInRange(rec.maximumNotificationsPerLapseCycle, 1, stageDays.length)) {
    return fallback;
  }
  if (!isIntInRange(rec.serviceStateMaxAgeMinutes, 1, MAX_SERVICE_STATE_AGE_MINUTES)) {
    return fallback;
  }
  return {
    stageDays,
    allowedUserGroups,
    minimumCompletedPaidOrders: rec.minimumCompletedPaidOrders,
    minimumLifetimeSpendToman: rec.minimumLifetimeSpendToman,
    snoozeDays: rec.snoozeDays,
    maximumNotificationsPerLapseCycle: rec.maximumNotificationsPerLapseCycle,
    serviceStateMaxAgeMinutes: rec.serviceStateMaxAgeMinutes,
  };
}

// --- paid-service disposition (Part E/F/H) -----------------------------------

/**
 * How a single PAID service affects win-back eligibility.
 * - USABLE: active/limited/disabled with future or unlimited expiry -> the
 *   customer still owns a recoverable service -> NOT lapsed (blocks win-back).
 * - PROVISIONING: CREATING -> a purchase is being provisioned -> defer.
 * - UNCERTAIN: could still be active but local state is stale -> defer + sync.
 * - LAPSED: expired / deleted-and-settled -> contributes an effective-end date.
 * - IGNORE: FAILED / deleted-unsettled / non-paid -> no signal either way.
 */
export type PaidServiceDisposition =
  | "USABLE"
  | "PROVISIONING"
  | "UNCERTAIN"
  | "LAPSED"
  | "IGNORE";

export interface PaidServiceView {
  /** ServiceStatus enum value. */
  status: string;
  /** ServiceSource enum value (only PAID contributes; others -> IGNORE). */
  source: string;
  /** null == unlimited time (never expires). */
  expiresAt: Date | null;
  deletedAt: Date | null;
  /** Freshness anchor; null == never synced. */
  lastSubscriptionUpdateAt: Date | null;
  /** True when the service is backed by a real panel (freshness applies). */
  panelBacked: boolean;
  /** For DELETED: the associated financial/provisioning state is settled. */
  financiallySettled: boolean;
}

export interface PaidServiceClassification {
  disposition: PaidServiceDisposition;
  /** Effective inactivity-since date when disposition === "LAPSED", else null. */
  effectiveEnd: Date | null;
  /** True when a priority state sync should be enqueued (UNCERTAIN). */
  needsSync: boolean;
}

function isFresh(at: Date | null, maxAgeMinutes: number, now: Date): boolean {
  if (at === null) {
    return false;
  }
  return now.getTime() - at.getTime() < maxAgeMinutes * 60_000;
}

/**
 * Classifies ONE paid service. Win-back is a negative assertion ("no usable
 * service"), so a service that could still be active but whose local state is
 * stale is UNCERTAIN (never guessed inactive). Unlimited time (`expiresAt`
 * null) or a future expiry always blocks, regardless of freshness.
 */
export function classifyPaidServiceForWinback(
  svc: PaidServiceView,
  maxAgeMinutes: number,
  now: Date,
): PaidServiceClassification {
  if (svc.source !== "PAID") {
    return { disposition: "IGNORE", effectiveEnd: null, needsSync: false };
  }
  switch (svc.status) {
    case "CREATING":
      return { disposition: "PROVISIONING", effectiveEnd: null, needsSync: false };
    case "FAILED":
      // A failed service never became usable and provides no lapse anchor; any
      // deferral for a still-unresolved order is handled at the snapshot level.
      return { disposition: "IGNORE", effectiveEnd: null, needsSync: false };
    case "DELETED": {
      if (!svc.financiallySettled) {
        // Deleted but financially unsettled -> don't guess; the financial gate
        // (reconciliation / pending receipt) handles the real risk.
        return { disposition: "IGNORE", effectiveEnd: null, needsSync: false };
      }
      const end = svc.expiresAt ?? svc.deletedAt ?? null;
      if (end === null) {
        return { disposition: "IGNORE", effectiveEnd: null, needsSync: false };
      }
      return { disposition: "LAPSED", effectiveEnd: end, needsSync: false };
    }
    case "ACTIVE":
    case "LIMITED":
    case "DISABLED": {
      // Unlimited time or a future expiry: owned & recoverable -> blocks.
      if (svc.expiresAt === null || svc.expiresAt.getTime() > now.getTime()) {
        return { disposition: "USABLE", effectiveEnd: null, needsSync: false };
      }
      // Local state says active-ish but the expiry has passed. Trust it only when
      // fresh (or not panel-backed); otherwise the panel might show it renewed.
      if (svc.panelBacked && !isFresh(svc.lastSubscriptionUpdateAt, maxAgeMinutes, now)) {
        return { disposition: "UNCERTAIN", effectiveEnd: null, needsSync: true };
      }
      return { disposition: "LAPSED", effectiveEnd: svc.expiresAt, needsSync: false };
    }
    case "EXPIRED": {
      // Definitive local expiry. Its authoritative end is expiresAt, but a stale
      // panel-backed row could hide a remote renewal -> UNCERTAIN when stale.
      if (svc.panelBacked && !isFresh(svc.lastSubscriptionUpdateAt, maxAgeMinutes, now)) {
        return { disposition: "UNCERTAIN", effectiveEnd: null, needsSync: true };
      }
      const end = svc.expiresAt ?? svc.deletedAt ?? null;
      if (end === null) {
        return { disposition: "UNCERTAIN", effectiveEnd: null, needsSync: true };
      }
      return { disposition: "LAPSED", effectiveEnd: end, needsSync: false };
    }
    default:
      return { disposition: "IGNORE", effectiveEnd: null, needsSync: false };
  }
}

// --- lifecycle snapshot + segments -------------------------------------------

export type CustomerLifecycleSegment =
  | "ACTIVE_CUSTOMER"
  | "RECENTLY_LAPSED"
  | "LAPSED_STAGE_1"
  | "LAPSED_STAGE_2"
  | "LAPSED_STAGE_3"
  | "NEVER_PAID"
  | "TRIAL_ONLY"
  | "PURCHASE_IN_PROGRESS"
  | "FINANCIAL_HOLD"
  | "SERVICE_STATE_UNCERTAIN"
  | "MARKETING_OPT_OUT"
  | "WINBACK_SNOOZED"
  | "INELIGIBLE_USER_GROUP"
  | "INELIGIBLE_USER_STATUS";

export interface CustomerLifecycleSnapshot {
  userStatus: string;
  userGroup: string;

  cronNotificationsEnabled: boolean;
  marketingMessagesEnabled: boolean;

  /** Definitively completed paid Service purchases (authoritative). */
  completedPaidServiceOrderCount: number;
  lifetimePaidServiceSpendToman: number;

  hasUsablePaidService: boolean;
  hasUncertainPaidService: boolean;
  hasProvisioningService: boolean;

  /** Latest effective-end across LAPSED paid services (the inactive-since anchor). */
  latestPaidServiceEffectiveEndAt: Date | null;
  latestCompletedPaidServiceOrderId: string | null;

  /** Trial state (a live trial defers a former paying customer). */
  hasActiveTrial: boolean;
  hasTrialProvisioning: boolean;

  /** Purchase / financial in-progress signals (defer, never lapsed). */
  hasResumableCheckout: boolean;
  hasPendingReceiptReview: boolean;
  hasOpenFinancialReconciliation: boolean;
  hasUnresolvedProvisioningOrder: boolean;

  winbackSnoozedUntil: Date | null;

  /** Win-back notifications already generated in the CURRENT lapse cycle. */
  existingCycleNotificationCount: number;
  /** Stage-day values already notified in the current lapse cycle. */
  sentStageDaysThisCycle: number[];
}

const DAY_MS = 24 * 3_600_000;

/** The inactive-since anchor: the latest LAPSED paid-service effective end. */
export function resolveCustomerInactiveSince(snapshot: CustomerLifecycleSnapshot): Date | null {
  return snapshot.latestPaidServiceEffectiveEndAt;
}

/** Whole days of inactivity since the anchor (floored); null anchor -> null. */
export function resolveCustomerInactiveDays(
  snapshot: CustomerLifecycleSnapshot,
  now: Date,
): number | null {
  const since = resolveCustomerInactiveSince(snapshot);
  if (since === null) {
    return null;
  }
  return Math.floor((now.getTime() - since.getTime()) / DAY_MS);
}

function isPayingCustomer(snapshot: CustomerLifecycleSnapshot, config: WinbackConfig): boolean {
  return (
    snapshot.completedPaidServiceOrderCount >= config.minimumCompletedPaidOrders &&
    snapshot.lifetimePaidServiceSpendToman >= config.minimumLifetimeSpendToman
  );
}

/**
 * Classifies a customer into a single lifecycle segment (pure). Precedence is
 * most-blocking first, so a segment is never optimistic. Used both for the win-
 * back decision and for the admin preview grouping.
 */
export function resolveCustomerLifecycleSegment(
  snapshot: CustomerLifecycleSnapshot,
  config: WinbackConfig,
  now: Date,
): CustomerLifecycleSegment {
  if (snapshot.userStatus !== "ACTIVE") {
    return "INELIGIBLE_USER_STATUS";
  }
  if (!config.allowedUserGroups.includes(snapshot.userGroup)) {
    return "INELIGIBLE_USER_GROUP";
  }
  if (!isPayingCustomer(snapshot, config)) {
    // Never a paying customer: distinguish trial-only from never-paid.
    if (snapshot.hasActiveTrial || snapshot.hasTrialProvisioning) {
      return "TRIAL_ONLY";
    }
    return "NEVER_PAID";
  }
  // Previous paying customer from here down.
  if (!snapshot.marketingMessagesEnabled) {
    return "MARKETING_OPT_OUT";
  }
  if (snapshot.winbackSnoozedUntil !== null && snapshot.winbackSnoozedUntil.getTime() > now.getTime()) {
    return "WINBACK_SNOOZED";
  }
  if (snapshot.hasOpenFinancialReconciliation || snapshot.hasPendingReceiptReview) {
    return "FINANCIAL_HOLD";
  }
  if (
    snapshot.hasResumableCheckout ||
    snapshot.hasProvisioningService ||
    snapshot.hasUnresolvedProvisioningOrder ||
    snapshot.hasActiveTrial ||
    snapshot.hasTrialProvisioning
  ) {
    return "PURCHASE_IN_PROGRESS";
  }
  if (snapshot.hasUsablePaidService) {
    return "ACTIVE_CUSTOMER";
  }
  if (snapshot.hasUncertainPaidService) {
    return "SERVICE_STATE_UNCERTAIN";
  }
  const inactiveDays = resolveCustomerInactiveDays(snapshot, now);
  if (inactiveDays === null) {
    // Paid but no lapse anchor and no usable service: no evidence of a lapse.
    return "ACTIVE_CUSTOMER";
  }
  if (inactiveDays < config.stageDays[0]) {
    return "RECENTLY_LAPSED";
  }
  // Highest applicable stage index -> a coarse 1/2/3 display label.
  let index = 0;
  for (let i = 0; i < config.stageDays.length; i += 1) {
    if (inactiveDays >= config.stageDays[i]) {
      index = i;
    }
  }
  if (index <= 0) {
    return "LAPSED_STAGE_1";
  }
  if (index === 1) {
    return "LAPSED_STAGE_2";
  }
  return "LAPSED_STAGE_3";
}

// --- eligibility (Part K/L) --------------------------------------------------

export type WinbackExclusionReason =
  | "ineligible-status"
  | "ineligible-group"
  | "never-paid"
  | "trial-only"
  | "marketing-opt-out"
  | "snoozed"
  | "financial-hold"
  | "purchase-in-progress"
  | "active-service"
  | "service-uncertain"
  | "too-early"
  | "cron-disabled"
  | "max-cycle-reached"
  | "no-stage-due";

export type WinbackEligibility =
  | {
      eligible: true;
      segment: CustomerLifecycleSegment;
      /** The single stage-day value to send now (catch-up: highest unsent applicable). */
      stageDays: number;
      inactiveDays: number;
    }
  | { eligible: false; segment: CustomerLifecycleSegment; reason: WinbackExclusionReason };

const SEGMENT_REASON: Partial<Record<CustomerLifecycleSegment, WinbackExclusionReason>> = {
  INELIGIBLE_USER_STATUS: "ineligible-status",
  INELIGIBLE_USER_GROUP: "ineligible-group",
  NEVER_PAID: "never-paid",
  TRIAL_ONLY: "trial-only",
  MARKETING_OPT_OUT: "marketing-opt-out",
  WINBACK_SNOOZED: "snoozed",
  FINANCIAL_HOLD: "financial-hold",
  PURCHASE_IN_PROGRESS: "purchase-in-progress",
  ACTIVE_CUSTOMER: "active-service",
  SERVICE_STATE_UNCERTAIN: "service-uncertain",
  RECENTLY_LAPSED: "too-early",
};

/**
 * Catch-up stage selection: the highest APPLICABLE stage (inactiveDays past it)
 * that is strictly greater than the largest stage already sent this cycle. This
 * sends only the highest overdue stage on first enable (no Stage-1/2/3 burst) and
 * never backfills a lower stage after a higher one has fired. Returns null when
 * nothing new is due.
 */
export function selectWinbackStage(
  stageDays: number[],
  inactiveDays: number,
  sentStageDaysThisCycle: number[],
): number | null {
  const maxSent = sentStageDaysThisCycle.length > 0 ? Math.max(...sentStageDaysThisCycle) : -1;
  let target: number | null = null;
  for (const d of stageDays) {
    if (d <= inactiveDays && d > maxSent) {
      target = target === null ? d : Math.max(target, d);
    }
  }
  return target;
}

/**
 * The single win-back eligibility evaluator — called identically by the worker
 * scan, the delivery re-validation and the admin preview. Pure: no I/O.
 */
export function evaluateCustomerWinbackEligibility(
  snapshot: CustomerLifecycleSnapshot,
  config: WinbackConfig,
  now: Date,
): WinbackEligibility {
  const segment = resolveCustomerLifecycleSegment(snapshot, config, now);
  const blocked = SEGMENT_REASON[segment];
  if (blocked !== undefined) {
    return { eligible: false, segment, reason: blocked };
  }
  // Only LAPSED_STAGE_* segments reach here. Apply the remaining gates.
  if (!snapshot.cronNotificationsEnabled) {
    return { eligible: false, segment, reason: "cron-disabled" };
  }
  if (snapshot.existingCycleNotificationCount >= config.maximumNotificationsPerLapseCycle) {
    return { eligible: false, segment, reason: "max-cycle-reached" };
  }
  const inactiveDays = resolveCustomerInactiveDays(snapshot, now);
  if (inactiveDays === null) {
    return { eligible: false, segment, reason: "no-stage-due" };
  }
  const stage = selectWinbackStage(config.stageDays, inactiveDays, snapshot.sentStageDaysThisCycle);
  if (stage === null) {
    return { eligible: false, segment, reason: "no-stage-due" };
  }
  return { eligible: true, segment, stageDays: stage, inactiveDays };
}

// --- lapse-cycle fingerprint + dedupe (Part L) -------------------------------

/**
 * A stable fingerprint of the CURRENT lapse cycle: a hash of the anchoring paid-
 * service order identity + the effective-end epoch. A new completed paid purchase
 * (new order id / later end) yields a new fingerprint -> a fresh future cycle,
 * while old-cycle pending notifications cancel at delivery re-validation. The
 * value is HASHED so no raw order id ever enters the dedupe key, payload meta or
 * logs. Returns null when there is no lapse anchor (not a win-back candidate).
 */
export function buildCustomerLapseCycleFingerprint(
  snapshot: CustomerLifecycleSnapshot,
): string | null {
  const end = snapshot.latestPaidServiceEffectiveEndAt;
  const orderId = snapshot.latestCompletedPaidServiceOrderId;
  if (end === null || orderId === null) {
    return null;
  }
  const material = `${orderId}|${end.getTime()}`;
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/** The stable per-stage dedupe key. Unique constraint -> concurrent scans converge. */
export function buildCustomerWinbackDedupeKey(
  userId: string,
  lapseCycleFingerprint: string,
  stageDays: number,
): string {
  return `user:${userId}:winback:${lapseCycleFingerprint}:s${stageDays}`;
}

/** Short, safe stage identifier for payload meta / logs (never raw days-of-life). */
export function winbackStageKey(stageDays: number): string {
  return `s${stageDays}`;
}
