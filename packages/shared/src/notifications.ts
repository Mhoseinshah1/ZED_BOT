import { createHash } from "node:crypto";

// =============================================================================
// Automated notification / retention engine — the ONE dependency-free contract
// (no prisma, no bullmq) shared by the bot, the worker and tests: queue/job/
// lock/redis names, Setting keys + typed defaults, the notification-type ->
// category map, threshold definitions + parsing, the dedupe-key fingerprints,
// BigInt-safe traffic percentage, the allowlisted IANA timezone registry and
// the quiet-hours math. Pure functions only, so every rule is unit-testable
// without a database, Redis or Telegram.
//
// PHASE 1 (feat/notification-retention-engine): Service + trial notifications
// only. The enums/types below intentionally carry the future ABANDONED_CHECKOUT
// / PAYMENT_RETRY / CUSTOMER_WINBACK kinds so the schema and contract are
// stable, but Phase 1 code never SCHEDULES or DELIVERS them.
// =============================================================================

// --- queues / jobs -----------------------------------------------------------

export const SERVICE_STATE_SYNC_QUEUE_NAME = "service-state-sync";
export const NOTIFICATION_SCAN_QUEUE_NAME = "automated-notification-scan";
export const NOTIFICATION_DELIVERY_QUEUE_NAME = "automated-notification-delivery";
export const NOTIFICATION_MAINTENANCE_QUEUE_NAME = "automated-notification-maintenance";

export const NOTIFICATION_JOB_NAMES = {
  SYNC_PANEL_SERVICES: "SYNC_PANEL_SERVICES",
  SCAN_SERVICE_NOTIFICATIONS: "SCAN_SERVICE_NOTIFICATIONS",
  SCAN_CHECKOUT_NOTIFICATIONS: "SCAN_CHECKOUT_NOTIFICATIONS",
  SCAN_RETENTION_NOTIFICATIONS: "SCAN_RETENTION_NOTIFICATIONS",
  DELIVER_AUTOMATED_NOTIFICATION: "DELIVER_AUTOMATED_NOTIFICATION",
  CLEANUP_NOTIFICATION_HISTORY: "CLEANUP_NOTIFICATION_HISTORY",
  RECONCILE_FAILED_NOTIFICATIONS: "RECONCILE_FAILED_NOTIFICATIONS",
  // Analytics phase (Phase 4). Attribution jobs run on the maintenance queue:
  //   RECONCILE_..._ATTRIBUTION        - one completed Order (after-commit hook), data { orderId }
  //   RECONCILE_..._ATTRIBUTION_BATCH  - periodic sweep of recently-completed Orders (catch-all)
  //   RECONCILE_..._ATTRIBUTION_REVERSALS - flip attributions whose Order was refunded/voided
  //   CLEANUP_..._ATTRIBUTION          - prune attributions past the retention window
  RECONCILE_NOTIFICATION_ATTRIBUTION: "RECONCILE_NOTIFICATION_ATTRIBUTION",
  RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH: "RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH",
  RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS: "RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS",
  CLEANUP_NOTIFICATION_ATTRIBUTION: "CLEANUP_NOTIFICATION_ATTRIBUTION",
} as const;
export type NotificationJobName =
  (typeof NOTIFICATION_JOB_NAMES)[keyof typeof NOTIFICATION_JOB_NAMES];

/** Repeatable-job ids (one per installation, replaced idempotently on reconcile). */
export const NOTIFICATION_SCHEDULER_IDS = {
  serviceSync: "notif-sched-service-sync",
  serviceScan: "notif-sched-service-scan",
  checkoutScan: "notif-sched-checkout-scan",
  retentionScan: "notif-sched-retention-scan",
  reconcile: "notif-sched-reconcile",
  cleanup: "notif-sched-cleanup",
  // Analytics phase (Phase 4): the recurring attribution sweeps (only registered
  // while analytics is enabled). The per-order after-commit hook is on demand.
  attributionBatch: "notif-sched-attribution-batch",
  attributionReversals: "notif-sched-attribution-reversals",
  attributionCleanup: "notif-sched-attribution-cleanup",
} as const;

/**
 * BullMQ per-order attribution job id (idempotent enqueue): the after-commit hook
 * and any retry collapse onto ONE job per Order, and the `orderId @unique`
 * attribution constraint is the durable convergence anchor regardless.
 */
export function attributionReconcileJobId(orderId: string): string {
  return `ntfattr-${orderId}`;
}

/** BullMQ delivery job id derived from the notification id (idempotent enqueue). */
export function notificationDeliveryJobId(notificationId: string): string {
  return `ntfdel-${notificationId}`;
}

/** BullMQ per-panel sync job id (one in-flight sync per panel). */
export function panelSyncJobId(panelId: string): string {
  return `psync-${panelId}`;
}

// --- locks / redis keys ------------------------------------------------------

/** Per-panel service-sync lock (only one sync per panel at a time). */
export function panelSyncLockKey(panelId: string): string {
  return `zedbot:panel-sync:${panelId}`;
}

/** Per-panel circuit-breaker failure counter (INCR + EXPIRE window). */
export function panelBreakerKey(panelId: string): string {
  return `zedbot:panel-breaker:${panelId}`;
}

/** Only one instance of a given notification scan runs at a time. */
export function notificationScanLockKey(scan: string): string {
  return `zedbot:notif-scan:${scan}`;
}

/** Worker-published notification-engine status snapshot (JSON, heartbeat TTL). */
export const NOTIFICATION_WORKER_STATUS_KEY = "zedbot:notif:worker-status";

/** The live worker view of the notification engine (bot admin page reads it). */
export interface NotificationWorkerStatus {
  schedulerActive: boolean;
  lastServiceSyncAt: string | null;
  lastServiceScanAt: string | null;
  deliveryWaiting: number;
  deliveryFailed: number;
  deadLetter: number;
  checkedAt: string;
  // Checkout-payment reminders phase (Phase 2). Optional so a Phase-1 worker's
  // snapshot still parses; the admin page renders "نامشخص" when absent.
  lastCheckoutScanAt?: string | null;
  abandonedCheckoutCandidates?: number;
  paymentRetryCandidates?: number;
  // Customer win-back phase (Phase 3). Optional for rolling upgrades.
  lastRetentionScanAt?: string | null;
  winbackCandidates?: number;
  winbackScheduled?: number;
  winbackExcludedUncertainService?: number;
  retentionScanFailures?: number;
  // Analytics phase (Phase 4). Optional for rolling upgrades; the admin analytics
  // health panel renders "نامشخص" when absent. Counts + timestamps only — never a
  // user id, order id, revenue figure or message body.
  analyticsEnabled?: boolean;
  lastAttributionBatchAt?: string | null;
  lastAttributionReversalsAt?: string | null;
  attributionsActive?: number;
  attributionsReversed?: number;
  attributionReconcileFailures?: number;
  // Wallet auto-renewal phase (Phase 1 auto-renewal). Optional for rolling
  // upgrades; counts + timestamps only, never a user/service/order id or balance.
  walletAutoRenewalEnabled?: boolean;
  lastWalletAutoRenewalScanAt?: string | null;
  autoRenewalDueCount?: number;
  autoRenewalCompletedCount?: number;
  autoRenewalInsufficientBalanceCount?: number;
  autoRenewalRequiresActionCount?: number;
  autoRenewalFailureCount?: number;
  // Telegram Stars subscriptions phase (Phase 2). Optional for rolling upgrades;
  // counts + timestamps only, never a user/charge id.
  starsSubscriptionsEnabled?: boolean;
  lastStarsSubscriptionReconcileAt?: string | null;
  starsSubscriptionsActive?: number;
  starsSubscriptionChargesProcessed?: number;
  starsSubscriptionChargesRefunded?: number;
  starsSubscriptionPastDue?: number;
  starsSubscriptionRequiresAction?: number;
  starsSubscriptionFailures?: number;
}

// --- Setting keys ------------------------------------------------------------

/** MASTER switch. Existing installs default false; operator enables explicitly. */
export const NOTIF_ENABLED_KEY = "automated_notifications_enabled";

/** Per-rule enable flags (all default false until the operator turns them on). */
export const NOTIF_RULE_ENABLED_KEYS = {
  expiry: "notification_rule_expiry_enabled",
  traffic: "notification_rule_traffic_enabled",
  trial: "notification_rule_trial_enabled",
} as const;
export type NotificationRuleKey = keyof typeof NOTIF_RULE_ENABLED_KEYS;

export const NOTIF_DEFAULT_TIMEZONE_KEY = "notification_default_timezone";
export const NOTIF_SERVICE_STATE_MAX_AGE_MINUTES_KEY =
  "notification_service_state_max_age_minutes";
export const NOTIF_EXPIRY_THRESHOLDS_KEY = "notification_expiry_thresholds";
export const NOTIF_TRAFFIC_THRESHOLDS_KEY = "notification_traffic_thresholds";
export const NOTIF_TRIAL_THRESHOLDS_KEY = "notification_trial_thresholds";
export const NOTIF_QUIET_HOURS_DEFAULT_KEY = "notification_quiet_hours_default";
export const NOTIF_DAILY_LIMIT_DEFAULT_KEY = "notification_daily_limit_default";
export const NOTIF_SYNC_CONCURRENCY_KEY = "notification_sync_concurrency";
export const NOTIF_HISTORY_RETENTION_DAYS_KEY = "notification_history_retention_days";
export const NOTIF_FAILED_RETENTION_DAYS_KEY = "notification_failed_retention_days";
export const NOTIF_DEAD_LETTER_RETENTION_DAYS_KEY = "notification_dead_letter_retention_days";

/** Recurring-scan cadences (minutes), operator-configurable via Settings. */
export const NOTIF_SCHEDULE_KEYS = {
  serviceSyncMinutes: "notification_schedule_service_sync_minutes",
  serviceScanMinutes: "notification_schedule_service_scan_minutes",
  reconcileMinutes: "notification_schedule_reconcile_minutes",
  cleanupMinutes: "notification_schedule_cleanup_minutes",
} as const;

// --- defaults ----------------------------------------------------------------

export const DEFAULT_TIMEZONE = "Asia/Tehran";
export const DEFAULT_SERVICE_STATE_MAX_AGE_MINUTES = 20;
export const DEFAULT_DAILY_LIMIT = 3;
export const DEFAULT_SYNC_CONCURRENCY = 3;
export const DEFAULT_HISTORY_RETENTION_DAYS = 90;
export const DEFAULT_FAILED_RETENTION_DAYS = 30;
export const DEFAULT_DEAD_LETTER_RETENTION_DAYS = 180;

export const DEFAULT_SCHEDULE_MINUTES = {
  serviceSync: 15,
  serviceScan: 5,
  reconcile: 5,
  cleanup: 24 * 60,
} as const;

// --- notification type -> category (Phase-1 aware) ---------------------------

export type NotificationType =
  | "SERVICE_EXPIRY"
  | "SERVICE_TRAFFIC"
  | "SERVICE_EXPIRED"
  | "SERVICE_LIMITED"
  | "TRIAL_NEAR_EXPIRY"
  | "TRIAL_EXPIRED"
  | "ABANDONED_CHECKOUT"
  | "PAYMENT_RETRY"
  | "CUSTOMER_WINBACK";

export type NotificationCategory = "SERVICE" | "PAYMENT" | "MARKETING";

/** Category (=> which user preference gates the type). Trials are SERVICE. */
export const NOTIFICATION_TYPE_CATEGORY: Record<NotificationType, NotificationCategory> = {
  SERVICE_EXPIRY: "SERVICE",
  SERVICE_TRAFFIC: "SERVICE",
  SERVICE_EXPIRED: "SERVICE",
  SERVICE_LIMITED: "SERVICE",
  TRIAL_NEAR_EXPIRY: "SERVICE",
  TRIAL_EXPIRED: "SERVICE",
  ABANDONED_CHECKOUT: "PAYMENT",
  PAYMENT_RETRY: "PAYMENT",
  CUSTOMER_WINBACK: "MARKETING",
};

/** The notification types Phase 1 actually schedules + delivers. */
export const PHASE1_NOTIFICATION_TYPES: readonly NotificationType[] = [
  "SERVICE_EXPIRY",
  "SERVICE_TRAFFIC",
  "SERVICE_EXPIRED",
  "SERVICE_LIMITED",
  "TRIAL_NEAR_EXPIRY",
  "TRIAL_EXPIRED",
];

/**
 * Daily-limit priority: LOWER number = higher priority (delivered/kept first
 * when a user's daily cap is reached). Matches the spec priority ladder;
 * out-of-Phase-1 types sit at the bottom.
 */
export const NOTIFICATION_TYPE_PRIORITY: Record<NotificationType, number> = {
  SERVICE_EXPIRED: 1,
  SERVICE_TRAFFIC: 1,
  SERVICE_LIMITED: 1,
  SERVICE_EXPIRY: 2,
  TRIAL_EXPIRED: 2,
  TRIAL_NEAR_EXPIRY: 2,
  PAYMENT_RETRY: 3,
  ABANDONED_CHECKOUT: 4,
  CUSTOMER_WINBACK: 5,
};

// --- expiry thresholds -------------------------------------------------------

/** One expiry threshold: fire `minutes` before expiry, or on `expired`. */
export interface ExpiryThreshold {
  /** Stable key used in the dedupe key + template family (e.g. "7d", "expired"). */
  key: string;
  /** Minutes-before-expiry; null means the "already expired" threshold. */
  minutesBefore: number | null;
}

export const DEFAULT_EXPIRY_THRESHOLDS: ExpiryThreshold[] = [
  { key: "7d", minutesBefore: 7 * 24 * 60 },
  { key: "3d", minutesBefore: 3 * 24 * 60 },
  { key: "1d", minutesBefore: 24 * 60 },
  { key: "12h", minutesBefore: 12 * 60 },
  { key: "3h", minutesBefore: 3 * 60 },
  { key: "expired", minutesBefore: null },
];

export const DEFAULT_TRIAL_THRESHOLDS: ExpiryThreshold[] = [
  { key: "30m", minutesBefore: 30 },
  { key: "10m", minutesBefore: 10 },
  { key: "expired", minutesBefore: null },
];

/** Bounds so an operator cannot configure absurd thresholds. */
const MAX_THRESHOLD_MINUTES = 400 * 24 * 60; // ~400 days
const MAX_THRESHOLD_COUNT = 12;

/**
 * Parses a stored expiry/trial-threshold JSON setting into a validated,
 * sorted (largest-minutesBefore first, `expired` last) list. Returns the
 * provided fallback when the value is missing/invalid — never throws.
 */
export function parseExpiryThresholds(
  raw: unknown,
  fallback: ExpiryThreshold[],
): ExpiryThreshold[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_THRESHOLD_COUNT) {
    return fallback;
  }
  const seen = new Set<string>();
  const out: ExpiryThreshold[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      return fallback;
    }
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === "string" ? rec.key.trim() : "";
    if (key === "" || key.length > 16 || seen.has(key)) {
      return fallback;
    }
    let minutesBefore: number | null;
    if (rec.minutesBefore === null || rec.minutesBefore === undefined) {
      minutesBefore = null;
    } else if (
      typeof rec.minutesBefore === "number" &&
      Number.isInteger(rec.minutesBefore) &&
      rec.minutesBefore > 0 &&
      rec.minutesBefore <= MAX_THRESHOLD_MINUTES
    ) {
      minutesBefore = rec.minutesBefore;
    } else {
      return fallback;
    }
    seen.add(key);
    out.push({ key, minutesBefore });
  }
  out.sort((a, b) => {
    if (a.minutesBefore === null) return 1;
    if (b.minutesBefore === null) return -1;
    return b.minutesBefore - a.minutesBefore;
  });
  return out;
}

// --- traffic thresholds ------------------------------------------------------

export const DEFAULT_TRAFFIC_THRESHOLDS: number[] = [80, 90, 100];

/** Validated ascending list of integer percentages in (0,100]. */
export function parseTrafficThresholds(raw: unknown, fallback: number[]): number[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_THRESHOLD_COUNT) {
    return fallback;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0 || item > 100) {
      return fallback;
    }
    if (seen.has(item)) {
      return fallback;
    }
    seen.add(item);
    out.push(item);
  }
  out.sort((a, b) => a - b);
  return out;
}

// --- BigInt-safe traffic percentage -----------------------------------------

export interface TrafficUsage {
  /** Integer 0..100, clamped for display (never > 100). */
  displayPercent: number;
  /** True integer percent (can exceed 100 on inconsistent remote data). */
  rawPercent: number;
  /** volumeBytes <= 0 means unlimited — no percentage applies. */
  unlimited: boolean;
}

/**
 * Computes usage percentage with BigInt math ONLY — the byte values are never
 * coerced to a JS Number before the division (a multi-TB quota would lose
 * precision as a float). The division result (a small percentage) is the only
 * value converted to Number, after the BigInt divide.
 */
export function computeTrafficUsage(usedBytes: bigint, volumeBytes: bigint): TrafficUsage {
  if (volumeBytes <= 0n) {
    return { displayPercent: 0, rawPercent: 0, unlimited: true };
  }
  const used = usedBytes < 0n ? 0n : usedBytes;
  const rawBig = (used * 100n) / volumeBytes; // BigInt floor division
  const raw = Number(rawBig);
  return {
    displayPercent: raw > 100 ? 100 : raw,
    rawPercent: raw,
    unlimited: false,
  };
}

// --- dedupe fingerprints -----------------------------------------------------

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Expiry-cycle fingerprint: changes whenever the service's expiry instant
 * changes (i.e. after a successful renewal or extra-time), so a NEW cycle can
 * re-alert while a repeated scan within the same cycle stays deduped.
 */
export function expiryCycleFingerprint(expiresAt: Date | null): string {
  return shortHash(`expiry|${expiresAt === null ? "never" : expiresAt.getTime()}`);
}

/**
 * Quota-cycle fingerprint: derived from the quota (volumeBytes) AND the expiry
 * instant. A renewal advances the expiry -> new cycle (re-alert allowed); an
 * extra-volume purchase raises volumeBytes -> new cycle; a repeated scan within
 * the same quota period stays deduped (so 100% is not re-sent every scan). A
 * pure usage reset without a renewal is a documented rare admin-only edge that
 * does not re-open the cycle.
 */
export function quotaCycleFingerprint(volumeBytes: bigint, expiresAt: Date | null): string {
  return shortHash(`quota|${volumeBytes.toString()}|${expiresAt === null ? "never" : expiresAt.getTime()}`);
}

/** service:<id>:expiry:<thresholdKey>:<expiryCycle> */
export function expiryDedupeKey(
  serviceId: string,
  thresholdKey: string,
  expiresAt: Date | null,
  trial: boolean,
): string {
  const kind = trial ? "trial" : "expiry";
  return `service:${serviceId}:${kind}:${thresholdKey}:${expiryCycleFingerprint(expiresAt)}`;
}

/** service:<id>:traffic:<pct>:<quotaCycle> */
export function trafficDedupeKey(
  serviceId: string,
  percent: number,
  volumeBytes: bigint,
  expiresAt: Date | null,
): string {
  return `service:${serviceId}:traffic:${percent}:${quotaCycleFingerprint(volumeBytes, expiresAt)}`;
}

/** service:<id>:status:<statusToken>:<expiryCycle> (SERVICE_LIMITED / status). */
export function statusDedupeKey(
  serviceId: string,
  statusToken: string,
  expiresAt: Date | null,
): string {
  return `service:${serviceId}:status:${statusToken}:${expiryCycleFingerprint(expiresAt)}`;
}

// --- allowlisted IANA timezones ---------------------------------------------

/**
 * Curated IANA timezone allowlist (never accept an arbitrary string). Focused
 * on Iran + neighbours + the common diaspora/world zones; the operator default
 * is Asia/Tehran.
 */
export const ALLOWED_TIMEZONES: readonly string[] = [
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Baghdad",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Riyadh",
  "Asia/Muscat",
  "Asia/Baku",
  "Asia/Yerevan",
  "Asia/Tbilisi",
  "Asia/Istanbul",
  "Europe/Istanbul",
  "Asia/Kabul",
  "Asia/Karachi",
  "Asia/Tashkent",
  "Asia/Ashgabat",
  "Asia/Kolkata",
  "Europe/Moscow",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Madrid",
  "Europe/Rome",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "Australia/Sydney",
  "UTC",
];

const ALLOWED_TIMEZONE_SET = new Set(ALLOWED_TIMEZONES);

export function isAllowedTimezone(tz: unknown): tz is string {
  return typeof tz === "string" && ALLOWED_TIMEZONE_SET.has(tz);
}

/** Returns the timezone if allowlisted, else the provided fallback. */
export function resolveTimezone(tz: unknown, fallback = DEFAULT_TIMEZONE): string {
  return isAllowedTimezone(tz) ? tz : fallback;
}

// --- quiet hours -------------------------------------------------------------

export interface QuietHoursConfig {
  enabled: boolean;
  startMinutes: number;
  endMinutes: number;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: false,
  startMinutes: 23 * 60, // 23:00
  endMinutes: 9 * 60, // 09:00
};

/** Parses a stored quiet-hours JSON setting; invalid -> fallback (never throws). */
export function parseQuietHours(raw: unknown, fallback: QuietHoursConfig): QuietHoursConfig {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (parsed === null || typeof parsed !== "object") {
    return fallback;
  }
  const rec = parsed as Record<string, unknown>;
  const start = rec.startMinutes;
  const end = rec.endMinutes;
  if (!isValidMinute(start) || !isValidMinute(end)) {
    return fallback;
  }
  return {
    enabled: rec.enabled === true,
    startMinutes: start,
    endMinutes: end,
  };
}

function isValidMinute(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 24 * 60;
}

/** Minutes since local midnight for `date` in the given allowlisted timezone. */
export function localMinutesInZone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return hour * 60 + minute;
}

/** True when `nowMinutes` (local) falls inside the quiet window (wrap-aware). */
export function isWithinQuietWindow(nowMinutes: number, quiet: QuietHoursConfig): boolean {
  if (!quiet.enabled || quiet.startMinutes === quiet.endMinutes) {
    return false;
  }
  if (quiet.startMinutes < quiet.endMinutes) {
    return nowMinutes >= quiet.startMinutes && nowMinutes < quiet.endMinutes;
  }
  // Wraps midnight (e.g. 23:00 -> 09:00).
  return nowMinutes >= quiet.startMinutes || nowMinutes < quiet.endMinutes;
}

export interface QuietHoursDecision {
  quiet: boolean;
  /** When quiet, the UTC instant delivery should be postponed to. */
  nextAllowedAt: Date | null;
}

/**
 * Decides whether `now` is inside the user's quiet window and, if so, the UTC
 * instant delivery resumes (the local end boundary). The delta is computed in
 * local minutes and added to `now`; within a quiet window the offset is
 * constant (Tehran has no DST), so this is exact for the supported zones.
 */
export function evaluateQuietHours(
  now: Date,
  quiet: QuietHoursConfig,
  timezone: string,
): QuietHoursDecision {
  if (!quiet.enabled || quiet.startMinutes === quiet.endMinutes) {
    return { quiet: false, nextAllowedAt: null };
  }
  const nowMinutes = localMinutesInZone(now, timezone);
  if (!isWithinQuietWindow(nowMinutes, quiet)) {
    return { quiet: false, nextAllowedAt: null };
  }
  let deltaMinutes = quiet.endMinutes - nowMinutes;
  if (deltaMinutes <= 0) {
    deltaMinutes += 24 * 60;
  }
  return {
    quiet: true,
    nextAllowedAt: new Date(now.getTime() + deltaMinutes * 60_000),
  };
}

// --- preference gates (pure; bot + worker share one decision) ----------------

/**
 * The authoritative per-user notification switches, as plain booleans (the bot
 * maps User.status === ACTIVE to `active`; the worker reads the same columns).
 * cronNotificationsEnabled is the master gate for EVERY automated notification
 * from this engine - direct transactional replies never flow through here.
 */
export interface NotificationUserGates {
  active: boolean;
  cronNotificationsEnabled: boolean;
  serviceNotificationsEnabled: boolean;
  paymentNotificationsEnabled: boolean;
  marketingMessagesEnabled: boolean;
}

function categoryGateBoolean(gates: NotificationUserGates, category: NotificationCategory): boolean {
  switch (category) {
    case "SERVICE":
      return gates.serviceNotificationsEnabled;
    case "PAYMENT":
      return gates.paymentNotificationsEnabled;
    case "MARKETING":
      return gates.marketingMessagesEnabled;
    default:
      return false;
  }
}

/**
 * Whether the user may receive an automated notification of `category`: ACTIVE
 * user + cron master switch + the category-specific opt-in. Never looks at
 * quiet hours / daily limits (those are delivery-time concerns).
 */
export function isUserGateOpenForCategory(
  gates: NotificationUserGates,
  category: NotificationCategory,
): boolean {
  if (!gates.active || !gates.cronNotificationsEnabled) {
    return false;
  }
  return categoryGateBoolean(gates, category);
}

export function isUserGateOpenForType(
  gates: NotificationUserGates,
  type: NotificationType,
): boolean {
  return isUserGateOpenForCategory(gates, NOTIFICATION_TYPE_CATEGORY[type]);
}

export type ServiceNotificationKind = "expiry" | "traffic" | "status";

/** Per-service override view (null field = inherit the user's SERVICE opt-in). */
export interface ServiceKindOverrides {
  expiryEnabled: boolean | null;
  trafficEnabled: boolean | null;
  statusEnabled: boolean | null;
}

/**
 * Effective per-service enable for one kind: the user's global SERVICE opt-in
 * AND (the per-service override, or inherit when null). A service override can
 * only ever TIGHTEN the user's global setting, never loosen it.
 */
export function isServiceKindGateOpen(
  gates: NotificationUserGates,
  kind: ServiceNotificationKind,
  override: ServiceKindOverrides | null,
): boolean {
  if (!isUserGateOpenForCategory(gates, "SERVICE")) {
    return false;
  }
  if (override === null) {
    return true;
  }
  const value =
    kind === "expiry"
      ? override.expiryEnabled
      : kind === "traffic"
        ? override.trafficEnabled
        : override.statusEnabled;
  return value === null || value === undefined ? true : value;
}

// --- effective delivery preferences (timezone / quiet hours / daily limit) ---

export interface EffectiveDeliveryPreferences {
  timezone: string;
  quietHours: QuietHoursConfig;
  dailyLimit: number;
}

/** Plain view of a NotificationPreference row (bot + worker map to this). */
export interface NotificationPreferenceView {
  timezone: string | null;
  quietHoursEnabled: boolean;
  quietHoursStartMinutes: number | null;
  quietHoursEndMinutes: number | null;
  dailyAutomatedLimit: number | null;
}

/** Pure layering (unit-testable): the user row over the provided global defaults. */
export function buildEffectiveDeliveryPreferences(
  pref: NotificationPreferenceView | null,
  defaults: EffectiveDeliveryPreferences,
): EffectiveDeliveryPreferences {
  if (pref === null) {
    return defaults;
  }
  const timezone = resolveTimezone(pref.timezone, defaults.timezone);
  const hasUserQuiet =
    pref.quietHoursStartMinutes !== null && pref.quietHoursEndMinutes !== null;
  const quietHours: QuietHoursConfig = hasUserQuiet
    ? {
        enabled: pref.quietHoursEnabled,
        startMinutes: pref.quietHoursStartMinutes as number,
        endMinutes: pref.quietHoursEndMinutes as number,
      }
    : defaults.quietHours;
  const dailyLimit =
    pref.dailyAutomatedLimit !== null && pref.dailyAutomatedLimit > 0
      ? pref.dailyAutomatedLimit
      : defaults.dailyLimit;
  return { timezone, quietHours, dailyLimit };
}

// --- payload snapshot contract (scan -> delivery -> bot) ---------------------

/** Short, stable callback action codes (kept out of the enum so callback data
 * stays tiny; never derived from the Persian label). */
export const NTF_ACTION_CODES = {
  OPEN_SERVICE: "s",
  RENEW_SERVICE: "r",
  BUY_EXTRA_VOLUME: "v",
  CONTINUE_CHECKOUT: "c",
  VIEW_PRODUCTS: "p",
  DISMISS: "x",
  // Checkout-payment reminders phase (Phase 2). d = open the checkout detail
  // page; n = suppress this ONE checkout's future reminders (not a global
  // preference change).
  VIEW_CHECKOUT: "d",
  SUPPRESS_CHECKOUT: "n",
  // Customer win-back phase (Phase 3, MARKETING). g = view plans/storefront;
  // w = open wallet; z = snooze win-back reminders (temporary); o = permanent
  // marketing opt-out. Routed by the CUSTOMER_WINBACK notification type; none
  // creates a payment/checkout/order. ("p"/VIEW_PRODUCTS is reserved for the
  // service flow, so win-back "view plans" gets its own code.)
  VIEW_PLANS: "g",
  VIEW_WALLET: "w",
  SNOOZE_WINBACK: "z",
  MARKETING_OPT_OUT: "o",
} as const;
export type NtfActionCode = (typeof NTF_ACTION_CODES)[keyof typeof NTF_ACTION_CODES];

/** A button the delivery worker renders: label from ButtonText, callback from
 * the action code + the notification short id. */
export interface NotificationButtonSpec {
  action: NtfActionCode;
  buttonTextKey: string;
}

/**
 * The SAFE render contract the scan produces and the delivery worker consumes.
 * Contains ONLY the MessageTemplate key, allowlisted display variables and the
 * eligible button specs - never a subscription URL/token, panel data, provider
 * payload, price or raw user input.
 */
export interface NotificationPayloadSnapshot {
  templateKey: string;
  variables: Record<string, string | number>;
  buttons: NotificationButtonSpec[];
  /** Non-rendered safe diagnostics (e.g. the true raw percentage). */
  meta?: Record<string, string | number>;
}

/** notification callback data: ntf:<shortId>:<action> (< 64 bytes). */
export function notificationCallbackData(shortId: string, action: NtfActionCode): string {
  return `ntf:${shortId}:${action}`;
}

// --- MessageTemplate / ButtonText key registry (Phase 1) ---------------------
// The stable keys the scan puts in a payload snapshot and the delivery worker
// renders. Default Persian content lives in the seed registry
// (packages/database seed-data.ts) under the SAME literal keys - duplicated
// there on purpose because @zedbot/database carries no workspace deps (a test
// asserts the two lists stay in sync).

export const NOTIF_TEMPLATE_KEYS: Record<
  "SERVICE_EXPIRY" | "SERVICE_EXPIRED" | "SERVICE_TRAFFIC" | "SERVICE_LIMITED" | "TRIAL_NEAR_EXPIRY" | "TRIAL_EXPIRED",
  string
> = {
  SERVICE_EXPIRY: "notif_service_expiry",
  SERVICE_EXPIRED: "notif_service_expired",
  SERVICE_TRAFFIC: "notif_service_traffic",
  SERVICE_LIMITED: "notif_service_limited",
  TRIAL_NEAR_EXPIRY: "notif_trial_near_expiry",
  TRIAL_EXPIRED: "notif_trial_expired",
};

/** Template key for a Phase-1 notification type (undefined for out-of-phase types). */
export function notificationTemplateKey(type: NotificationType): string | undefined {
  return (NOTIF_TEMPLATE_KEYS as Record<string, string | undefined>)[type];
}

export const NOTIF_BUTTON_KEYS = {
  OPEN_SERVICE: "notif_btn_open_service",
  RENEW_SERVICE: "notif_btn_renew_service",
  BUY_EXTRA_VOLUME: "notif_btn_buy_extra_volume",
  DISMISS: "notif_btn_dismiss",
  // Checkout-payment reminders phase (Phase 2).
  CONTINUE_CHECKOUT: "notif_btn_continue_checkout",
  CHECKOUT_DETAILS: "notif_btn_checkout_details",
  STOP_CHECKOUT_REMINDERS: "notif_btn_stop_checkout_reminders",
  RESELECT_PAYMENT: "notif_btn_reselect_payment",
  VIEW_ORDER: "notif_btn_view_order",
  STOP_PAYMENT_REMINDERS: "notif_btn_stop_payment_reminders",
  // Customer win-back phase (Phase 3).
  WINBACK_VIEW_PLANS: "notif_btn_winback_view_plans",
  WINBACK_WALLET: "notif_btn_winback_wallet",
  WINBACK_SNOOZE: "notif_btn_winback_snooze",
  WINBACK_OPT_OUT: "notif_btn_winback_opt_out",
} as const;

/** Action code -> the DEFAULT ButtonText key (fallback when a button spec omits
 * its own key). A notification's own button spec key wins - the abandoned and
 * payment-retry messages carry different labels for the same action codes. */
export const NTF_ACTION_BUTTON_KEY: Record<NtfActionCode, string> = {
  [NTF_ACTION_CODES.OPEN_SERVICE]: NOTIF_BUTTON_KEYS.OPEN_SERVICE,
  [NTF_ACTION_CODES.RENEW_SERVICE]: NOTIF_BUTTON_KEYS.RENEW_SERVICE,
  [NTF_ACTION_CODES.BUY_EXTRA_VOLUME]: NOTIF_BUTTON_KEYS.BUY_EXTRA_VOLUME,
  [NTF_ACTION_CODES.CONTINUE_CHECKOUT]: NOTIF_BUTTON_KEYS.CONTINUE_CHECKOUT,
  [NTF_ACTION_CODES.VIEW_CHECKOUT]: NOTIF_BUTTON_KEYS.CHECKOUT_DETAILS,
  [NTF_ACTION_CODES.SUPPRESS_CHECKOUT]: NOTIF_BUTTON_KEYS.STOP_CHECKOUT_REMINDERS,
  [NTF_ACTION_CODES.VIEW_PRODUCTS]: NOTIF_BUTTON_KEYS.OPEN_SERVICE,
  [NTF_ACTION_CODES.DISMISS]: NOTIF_BUTTON_KEYS.DISMISS,
  [NTF_ACTION_CODES.VIEW_PLANS]: NOTIF_BUTTON_KEYS.WINBACK_VIEW_PLANS,
  [NTF_ACTION_CODES.VIEW_WALLET]: NOTIF_BUTTON_KEYS.WINBACK_WALLET,
  [NTF_ACTION_CODES.SNOOZE_WINBACK]: NOTIF_BUTTON_KEYS.WINBACK_SNOOZE,
  [NTF_ACTION_CODES.MARKETING_OPT_OUT]: NOTIF_BUTTON_KEYS.WINBACK_OPT_OUT,
};

/** Template keys for the Phase-2 checkout/payment reminder messages. */
export const NOTIF_CHECKOUT_TEMPLATE_KEYS = {
  ABANDONED_CHECKOUT: "notification_abandoned_checkout",
  PAYMENT_RETRY: "notification_payment_retry",
} as const;

/** Template key for the Phase-3 customer win-back message (MARKETING). */
export const NOTIF_WINBACK_TEMPLATE_KEY = "notification_customer_winback";

// --- misc safety -------------------------------------------------------------

/** Masks a service display name for snapshots/logs (keeps a short readable head). */
export function maskServiceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 4) {
    return trimmed;
  }
  return `${trimmed.slice(0, 4)}…`;
}
