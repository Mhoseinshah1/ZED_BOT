import type { NotificationCategory, NotificationType } from "./notifications.js";
import { NOTIFICATION_TYPE_CATEGORY } from "./notifications.js";

// =============================================================================
// Notification analytics & EVIDENCE-BASED conversion attribution (Phase 4) — the
// ONE dependency-free (no prisma / bullmq) contract shared by the after-commit
// completion hook, the worker reconciler, the reversal reconciler, the admin
// reporting service and the tests. Every decision here is pure and unit-testable
// without a database.
//
// TRUST DISCIPLINE (never fabricate a conversion):
//   - An attribution requires a PERSISTED click (a NotificationInteraction row)
//     recorded strictly BEFORE the Order completed and AFTER the notification was
//     sent: sentAt < interactionAt < orderCompletedAt.
//   - DIRECT conversions require HARD entity equality — the completed Order's
//     checkoutSession (DIRECT_CHECKOUT) or service (DIRECT_SERVICE) equals the one
//     the notification pointed at. ASSISTED_WINBACK has NO entity link (a win-back
//     message advertises the storefront, not one service) — it is a same-user new
//     purchase after a recorded win-back click within a longer window, hence
//     "assisted", never "direct".
//   - We never assert the notification CAUSED the purchase, never infer a
//     conversion from temporal proximity ALONE (a click is always required), and
//     never count revenue as profit. gross/net are ATTRIBUTED REVENUE from the
//     Order's finalPriceToman only.
//   - Attribution begins at `analyticsStartedAt` and is never back-filled: an
//     Order completed before analytics was enabled is out of scope.
// =============================================================================

// --- enums (string-literal unions; shared carries no prisma dep) -------------

export const ATTRIBUTION_KINDS = ["DIRECT_CHECKOUT", "DIRECT_SERVICE", "ASSISTED_WINBACK"] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

export const ATTRIBUTION_STATUSES = ["ACTIVE", "REVERSED"] as const;
export type AttributionStatusValue = (typeof ATTRIBUTION_STATUSES)[number];

/** Reporting super-category: DIRECT_* are "direct conversions", winback "assisted". */
export function attributionKindClass(kind: AttributionKind): "direct" | "assisted" {
  return kind === "ASSISTED_WINBACK" ? "assisted" : "direct";
}

/** Deterministic precedence: LOWER = stronger evidence, wins ties. */
export const ATTRIBUTION_KIND_PRECEDENCE: Record<AttributionKind, number> = {
  DIRECT_CHECKOUT: 1,
  DIRECT_SERVICE: 2,
  ASSISTED_WINBACK: 3,
};

/** The stable click actions (NotificationInteractionType literals; no prisma dep). */
export type NotificationInteractionTypeValue =
  | "OPEN_SERVICE"
  | "RENEW_SERVICE"
  | "BUY_EXTRA_VOLUME"
  | "CONTINUE_CHECKOUT"
  | "VIEW_PRODUCTS"
  | "DISMISS"
  | "VIEW_WALLET"
  | "SNOOZE_WINBACK"
  | "MARKETING_OPT_OUT";

/** The paid Order types (OrderType literals; no prisma dep). */
export type OrderTypeValue =
  | "SERVICE_PURCHASE"
  | "SERVICE_RENEWAL"
  | "EXTRA_VOLUME"
  | "EXTRA_TIME"
  | "LOCATION_CHANGE"
  | "OTHER_PRODUCT";

// --- settings keys (exactly the 8 Phase-4 analytics settings) ----------------

/** MASTER analytics switch. False for every install until the OWNER enables it. */
export const NOTIF_ANALYTICS_ENABLED_KEY = "notification_analytics_enabled";
/** ISO instant analytics was first enabled — stamped ONCE, never back-filled. */
export const NOTIF_ANALYTICS_STARTED_AT_KEY = "notification_analytics_started_at";
/** OWNER-only CSV export switch (independent of the analytics master switch). */
export const NOTIF_ANALYTICS_CSV_EXPORT_ENABLED_KEY = "notification_analytics_csv_export_enabled";
/** Validated JSON attribution windows. */
export const NOTIF_ATTRIBUTION_CONFIG_KEY = "notification_attribution_config";
/** Allowlisted IANA timezone the admin reports render date ranges in. */
export const NOTIF_ANALYTICS_REPORTING_TIMEZONE_KEY = "notification_analytics_reporting_timezone";
/** Per-order/batch attribution sweep cadence (minutes). */
export const NOTIF_ATTRIBUTION_RECONCILE_MINUTES_KEY =
  "notification_schedule_attribution_reconcile_minutes";
/** Refund-reversal sweep cadence (minutes). */
export const NOTIF_ATTRIBUTION_REVERSALS_MINUTES_KEY =
  "notification_schedule_attribution_reversals_minutes";
/** How long attribution rows are retained before cleanup (days). */
export const NOTIF_ATTRIBUTION_RETENTION_DAYS_KEY = "notification_attribution_retention_days";

// --- config ------------------------------------------------------------------

export interface AttributionConfig {
  /** Max hours from a CONTINUE_CHECKOUT click to the completed Order (direct). */
  directCheckoutWindowHours: number;
  /** Max hours from a service-action click to the completed lifecycle Order (direct). */
  directServiceWindowHours: number;
  /** Max days from a win-back click to a new SERVICE_PURCHASE (assisted). */
  assistedWinbackWindowDays: number;
  /**
   * Batch sweep look-back (hours): the periodic batch reconciler re-examines
   * Orders completed within this window so a hook lost to a Redis flush is still
   * attributed. Bounded so the sweep never scans unbounded history.
   */
  batchLookbackHours: number;
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  directCheckoutWindowHours: 72,
  directServiceWindowHours: 72,
  assistedWinbackWindowDays: 14,
  batchLookbackHours: 48,
};

export const DEFAULT_ATTRIBUTION_RECONCILE_MINUTES = 15;
export const DEFAULT_ATTRIBUTION_REVERSALS_MINUTES = 60;
/** Analytics history is kept long (2 years) so year-over-year reports work. */
export const DEFAULT_ATTRIBUTION_RETENTION_DAYS = 730;

const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 30; // 30 days
const MIN_WINBACK_DAYS = 1;
const MAX_WINBACK_DAYS = 120;
const MIN_LOOKBACK_HOURS = 1;
const MAX_LOOKBACK_HOURS = 24 * 14; // 14 days

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Parses the stored attribution-config JSON. Config-parser-with-sentinel-fallback:
 * on ANY invalid field it returns the WHOLE fallback (never a partial/unbounded
 * config), and never throws. Mirrors parseWinbackConfig.
 */
export function parseAttributionConfig(raw: unknown, fallback: AttributionConfig): AttributionConfig {
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
  if (!isIntInRange(rec.directCheckoutWindowHours, MIN_WINDOW_HOURS, MAX_WINDOW_HOURS)) {
    return fallback;
  }
  if (!isIntInRange(rec.directServiceWindowHours, MIN_WINDOW_HOURS, MAX_WINDOW_HOURS)) {
    return fallback;
  }
  if (!isIntInRange(rec.assistedWinbackWindowDays, MIN_WINBACK_DAYS, MAX_WINBACK_DAYS)) {
    return fallback;
  }
  if (!isIntInRange(rec.batchLookbackHours, MIN_LOOKBACK_HOURS, MAX_LOOKBACK_HOURS)) {
    return fallback;
  }
  return {
    directCheckoutWindowHours: rec.directCheckoutWindowHours,
    directServiceWindowHours: rec.directServiceWindowHours,
    assistedWinbackWindowDays: rec.assistedWinbackWindowDays,
    batchLookbackHours: rec.batchLookbackHours,
  };
}

// --- evaluation inputs -------------------------------------------------------

/** One recorded click on one of THIS user's SENT notifications. Epoch ms. */
export interface AttributionInteractionInput {
  interactionId: string;
  notificationId: string;
  notificationType: NotificationType;
  interactionType: NotificationInteractionTypeValue;
  /** notification.sentAt (a click can only back a notification that was SENT). */
  notificationSentAt: number;
  interactionAt: number;
  /** Soft entity links captured from the source notification (for DIRECT equality). */
  notificationCheckoutSessionId: string | null;
  notificationServiceId: string | null;
}

/** The completed paid Order being evaluated. Epoch ms. */
export interface AttributionOrderInput {
  orderId: string;
  userId: string;
  orderType: OrderTypeValue;
  orderCompletedAt: number;
  finalPriceToman: number;
  checkoutSessionId: string | null;
  serviceId: string | null;
  /** True when the Order is no longer a valid completed sale (refunded/voided). */
  isRefunded: boolean;
  /** Analytics enable instant (epoch ms); null => analytics not enabled. */
  analyticsStartedAt: number | null;
}

/** Safe, non-PII evidence persisted with the attribution and used to re-verify it. */
export interface AttributionEvidence {
  kind: AttributionKind;
  notificationType: NotificationType;
  notificationCategory: NotificationCategory;
  interactionType: NotificationInteractionTypeValue;
  orderType: OrderTypeValue;
  checkoutMatched: boolean;
  serviceMatched: boolean;
  sameUser: true;
  sentToClickSeconds: number;
  clickToOrderSeconds: number;
  windowSeconds: number;
  windowLimitSeconds: number;
}

/** A validated attribution decision the worker persists verbatim. */
export interface AttributionDecision {
  kind: AttributionKind;
  interactionId: string;
  notificationId: string;
  notificationType: NotificationType;
  interactionType: NotificationInteractionTypeValue;
  grossRevenueToman: number;
  notificationSentAt: number;
  interactionAt: number;
  orderCompletedAt: number;
  /** orderCompletedAt - notificationSentAt, in seconds (never negative). */
  windowSeconds: number;
  evidence: AttributionEvidence;
}

export type AttributionSkipReason =
  | "order-refunded"
  | "before-analytics-start"
  | "analytics-not-started"
  | "no-eligible-interaction";

export type AttributionEvaluation =
  | { attributed: true; decision: AttributionDecision; candidates: AttributionDecision[] }
  | { attributed: false; reason: AttributionSkipReason; candidates: AttributionDecision[] };

// --- per-kind eligible click actions ----------------------------------------

const DIRECT_CHECKOUT_SOURCE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "ABANDONED_CHECKOUT",
  "PAYMENT_RETRY",
]);
const DIRECT_CHECKOUT_ACTIONS: ReadonlySet<NotificationInteractionTypeValue> =
  new Set<NotificationInteractionTypeValue>(["CONTINUE_CHECKOUT"]);

const DIRECT_SERVICE_SOURCE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "SERVICE_EXPIRY",
  "SERVICE_EXPIRED",
  "SERVICE_TRAFFIC",
  "SERVICE_LIMITED",
  "TRIAL_NEAR_EXPIRY",
  "TRIAL_EXPIRED",
]);
const DIRECT_SERVICE_ACTIONS: ReadonlySet<NotificationInteractionTypeValue> =
  new Set<NotificationInteractionTypeValue>(["RENEW_SERVICE", "BUY_EXTRA_VOLUME", "OPEN_SERVICE"]);
const DIRECT_SERVICE_ORDER_TYPES: ReadonlySet<OrderTypeValue> = new Set<OrderTypeValue>([
  "SERVICE_RENEWAL",
  "EXTRA_VOLUME",
  "EXTRA_TIME",
]);

const WINBACK_ACTIONS: ReadonlySet<NotificationInteractionTypeValue> =
  new Set<NotificationInteractionTypeValue>(["VIEW_PRODUCTS", "VIEW_WALLET", "OPEN_SERVICE"]);

/** Classifies one (order, interaction) pair, returning a decision when evidence holds. */
function classifyPair(
  order: AttributionOrderInput,
  it: AttributionInteractionInput,
  config: AttributionConfig,
): AttributionDecision | null {
  // Strict evidence ordering: sent < click < order-completed (all increasing).
  if (!(it.notificationSentAt < it.interactionAt && it.interactionAt < order.orderCompletedAt)) {
    return null;
  }
  const clickToOrderMs = order.orderCompletedAt - it.interactionAt;

  let kind: AttributionKind | null = null;
  let checkoutMatched = false;
  let serviceMatched = false;
  let windowLimitMs = 0;

  // DIRECT_CHECKOUT — hard checkout-session equality.
  if (
    DIRECT_CHECKOUT_SOURCE_TYPES.has(it.notificationType) &&
    DIRECT_CHECKOUT_ACTIONS.has(it.interactionType) &&
    it.notificationCheckoutSessionId !== null &&
    order.checkoutSessionId !== null &&
    it.notificationCheckoutSessionId === order.checkoutSessionId
  ) {
    windowLimitMs = config.directCheckoutWindowHours * 3_600_000;
    if (clickToOrderMs <= windowLimitMs) {
      kind = "DIRECT_CHECKOUT";
      checkoutMatched = true;
    }
  }

  // DIRECT_SERVICE — hard service equality + a paid lifecycle Order on that service.
  if (
    kind === null &&
    DIRECT_SERVICE_SOURCE_TYPES.has(it.notificationType) &&
    DIRECT_SERVICE_ACTIONS.has(it.interactionType) &&
    DIRECT_SERVICE_ORDER_TYPES.has(order.orderType) &&
    it.notificationServiceId !== null &&
    order.serviceId !== null &&
    it.notificationServiceId === order.serviceId
  ) {
    windowLimitMs = config.directServiceWindowHours * 3_600_000;
    if (clickToOrderMs <= windowLimitMs) {
      kind = "DIRECT_SERVICE";
      serviceMatched = true;
    }
  }

  // ASSISTED_WINBACK — NO entity link; a same-user new purchase after a win-back click.
  if (
    kind === null &&
    it.notificationType === "CUSTOMER_WINBACK" &&
    WINBACK_ACTIONS.has(it.interactionType) &&
    order.orderType === "SERVICE_PURCHASE"
  ) {
    windowLimitMs = config.assistedWinbackWindowDays * 86_400_000;
    if (clickToOrderMs <= windowLimitMs) {
      kind = "ASSISTED_WINBACK";
    }
  }

  if (kind === null) {
    return null;
  }

  const windowSeconds = Math.max(0, Math.round((order.orderCompletedAt - it.notificationSentAt) / 1000));
  const evidence: AttributionEvidence = {
    kind,
    notificationType: it.notificationType,
    notificationCategory: NOTIFICATION_TYPE_CATEGORY[it.notificationType],
    interactionType: it.interactionType,
    orderType: order.orderType,
    checkoutMatched,
    serviceMatched,
    sameUser: true,
    sentToClickSeconds: Math.round((it.interactionAt - it.notificationSentAt) / 1000),
    clickToOrderSeconds: Math.round(clickToOrderMs / 1000),
    windowSeconds,
    windowLimitSeconds: Math.round(windowLimitMs / 1000),
  };
  return {
    kind,
    interactionId: it.interactionId,
    notificationId: it.notificationId,
    notificationType: it.notificationType,
    interactionType: it.interactionType,
    grossRevenueToman: Math.max(0, Math.trunc(order.finalPriceToman)),
    notificationSentAt: it.notificationSentAt,
    interactionAt: it.interactionAt,
    orderCompletedAt: order.orderCompletedAt,
    windowSeconds,
    evidence,
  };
}

/**
 * Ranks candidate decisions by deterministic precedence: kind precedence
 * (checkout > service > winback), then the MOST-PROXIMATE click (latest
 * interactionAt before the order), then interactionId for a total order. Pure;
 * returns a new sorted array.
 */
export function rankAttributionCandidates(candidates: AttributionDecision[]): AttributionDecision[] {
  return [...candidates].sort((a, b) => {
    const pa = ATTRIBUTION_KIND_PRECEDENCE[a.kind];
    const pb = ATTRIBUTION_KIND_PRECEDENCE[b.kind];
    if (pa !== pb) return pa - pb;
    if (a.interactionAt !== b.interactionAt) return b.interactionAt - a.interactionAt;
    return a.interactionId < b.interactionId ? -1 : a.interactionId > b.interactionId ? 1 : 0;
  });
}

/** Picks the single winning decision (or null when there are no candidates). */
export function selectAttributionWinner(candidates: AttributionDecision[]): AttributionDecision | null {
  const ranked = rankAttributionCandidates(candidates);
  return ranked.length > 0 ? ranked[0] : null;
}

/**
 * THE evaluator. Given a completed paid Order and every recorded click on this
 * user's SENT notifications, returns the single winning evidence-backed
 * attribution (or a skip reason). Pure and deterministic — the after-commit hook,
 * the batch reconciler, the preview and the tests all call it identically.
 */
export function evaluateNotificationAttributionCandidate(
  order: AttributionOrderInput,
  interactions: AttributionInteractionInput[],
  config: AttributionConfig = DEFAULT_ATTRIBUTION_CONFIG,
): AttributionEvaluation {
  if (order.analyticsStartedAt === null) {
    return { attributed: false, reason: "analytics-not-started", candidates: [] };
  }
  // No historical back-fill: an Order completed before analytics was enabled is
  // out of scope (we never retroactively attribute pre-analytics conversions).
  if (order.orderCompletedAt < order.analyticsStartedAt) {
    return { attributed: false, reason: "before-analytics-start", candidates: [] };
  }
  if (order.isRefunded) {
    return { attributed: false, reason: "order-refunded", candidates: [] };
  }
  const candidates: AttributionDecision[] = [];
  for (const it of interactions) {
    const decision = classifyPair(order, it, config);
    if (decision !== null) {
      candidates.push(decision);
    }
  }
  const winner = selectAttributionWinner(candidates);
  if (winner === null) {
    return { attributed: false, reason: "no-eligible-interaction", candidates };
  }
  return { attributed: true, decision: winner, candidates };
}

// --- funnel metrics ----------------------------------------------------------

/** Raw counts (from DB aggregates) fed into the pure metric calculator. */
export interface FunnelCounts {
  generated: number;
  sent: number;
  failed: number;
  deadLetter: number;
  /** Sent notifications with >= 1 recorded interaction. */
  sentWithInteraction: number;
  directCheckoutConversions: number;
  directServiceConversions: number;
  assistedWinbackConversions: number;
  grossRevenueToman: number;
  reversedRevenueToman: number;
}

export interface FunnelMetrics extends FunnelCounts {
  /** SENT / (SENT + FAILED + DEAD_LETTER); 0 when the denominator is 0. */
  deliverySuccessRate: number;
  /** (sent notifications with >=1 interaction) / (sent notifications); 0 when denom 0. */
  clickThroughRate: number;
  directConversions: number;
  assistedConversions: number;
  totalConversions: number;
  /** gross - reversed (never negative in practice; floored at 0). */
  netRevenueToman: number;
  /** totalConversions / sent; 0 when denom 0. */
  conversionRate: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Computes the funnel metrics from raw counts. PURE — every rate guards against a
 * zero denominator (returns 0, never NaN/Infinity). Definitions are fixed by the
 * spec: Sent counts only status=SENT & sentAt set; delivery success excludes
 * pre-terminal rows; CTR is per-notification (unique), not per-click.
 */
export function calculateFunnelMetrics(counts: FunnelCounts): FunnelMetrics {
  const directConversions = counts.directCheckoutConversions + counts.directServiceConversions;
  const assistedConversions = counts.assistedWinbackConversions;
  const totalConversions = directConversions + assistedConversions;
  const netRevenueToman = Math.max(0, counts.grossRevenueToman - counts.reversedRevenueToman);
  return {
    ...counts,
    deliverySuccessRate: ratio(counts.sent, counts.sent + counts.failed + counts.deadLetter),
    clickThroughRate: ratio(counts.sentWithInteraction, counts.sent),
    directConversions,
    assistedConversions,
    totalConversions,
    netRevenueToman,
    conversionRate: ratio(totalConversions, counts.sent),
  };
}

// --- reporting date range (half-open, timezone-aware) ------------------------

export interface ReportDateRange {
  /** Inclusive UTC start. */
  startInclusive: Date;
  /** Exclusive UTC end (half-open [start, end)). */
  endExclusive: Date;
}

/** Max span a single report/export may cover, so a query is always bounded. */
export const MAX_REPORT_RANGE_DAYS = 366;

/**
 * Resolves a half-open [start, end) UTC range for a local calendar-day span in an
 * allowlisted timezone. `startDay`/`endDay` are inclusive local calendar days
 * (YYYY-MM-DD); the returned endExclusive is local-midnight AFTER `endDay`. Uses
 * the zone's own offset at each boundary (correct across the supported zones,
 * none of which the reports need sub-day precision for). Returns null on an
 * invalid date, inverted range, or a span exceeding MAX_REPORT_RANGE_DAYS.
 */
export function resolveReportDateRange(
  startDay: string,
  endDay: string,
  timezone: string,
): ReportDateRange | null {
  const start = localDayStartUtc(startDay, timezone);
  const endInclusiveStart = localDayStartUtc(endDay, timezone);
  if (start === null || endInclusiveStart === null) {
    return null;
  }
  const endExclusive = new Date(endInclusiveStart.getTime() + 86_400_000);
  if (endExclusive.getTime() <= start.getTime()) {
    return null;
  }
  const spanDays = Math.round((endExclusive.getTime() - start.getTime()) / 86_400_000);
  if (spanDays > MAX_REPORT_RANGE_DAYS) {
    return null;
  }
  return { startInclusive: start, endExclusive };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC instant of local midnight starting `day` (YYYY-MM-DD) in `timezone`; null if invalid. */
export function localDayStartUtc(day: string, timezone: string): Date | null {
  const m = DATE_RE.exec(day);
  if (m === null) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) {
    return null;
  }
  // Guess midnight UTC, then correct by the zone's offset at that instant so the
  // result is local midnight. One correction is exact for fixed-offset zones and
  // within a day for DST zones (reports are day-grained, so this is sufficient).
  const guess = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0);
  const offsetMinutes = zoneOffsetMinutes(new Date(guess), timezone);
  const corrected = guess - offsetMinutes * 60_000;
  // Reject a malformed calendar date (e.g. 2026-02-31 rolled over by Date.UTC).
  const check = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(corrected));
  return check === day ? new Date(corrected) : null;
}

/** Signed minutes the zone is ahead of UTC at `date` (e.g. Asia/Tehran = +210). */
export function zoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = Number(p.value);
    }
  }
  const asUtc = Date.UTC(
    map.year,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    (map.hour ?? 0) % 24,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}
