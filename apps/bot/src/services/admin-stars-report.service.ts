import { prisma } from "@zedbot/database";

import {
  reportRangeStart,
  type ReportRange,
} from "./admin-financial-report.service.js";

// =============================================================================
// «گزارش مالی اشتراک‌های Stars ⭐» — admin-only READ-ONLY financial reporting for
// Telegram Stars subscriptions, kept STRICTLY SEPARATE from the Toman reports.
// All amounts are in STARS and are NEVER converted to / mixed into Toman totals,
// and the net figure is deliberately NOT called "profit". One groupBy over the
// charge rows (bucketed by their receivedAt using the shared ReportRange window)
// plus one live subscription-state count feed the aggregate below; nothing here
// mutates any financial row and no PII / entity id is ever emitted.
//
// Amount definitions (documented so the numbers are unambiguous):
//   gross_stars    = SUM(starsAmount) over charges whose status represents money
//                    that was actually RECEIVED — i.e. status ∈
//                    { COMPLETED, REFUND_PENDING, REFUNDED }. In-flight states
//                    (RECEIVED / SETTLING / FULFILLING) and dead states
//                    (RECONCILIATION_REQUIRED / FAILED / IGNORED) are excluded.
//   refunded_stars = SUM(starsAmount) over status = REFUNDED only (CONFIRMED
//                    refunds). REFUND_PENDING is a requested-not-yet-confirmed
//                    refund and is NEVER counted as refunded here.
//   net_stars      = gross_stars − refunded_stars.
// =============================================================================

export interface StarsSubscriptionReport {
  range: ReportRange;
  from: Date | null;
  /** COMPLETED charges with isFirstRecurring = true (first payment of a sub). */
  initialCount: number;
  /** COMPLETED charges with isFirstRecurring = false (recurring renewals). */
  recurringCount: number;
  /** SUM(starsAmount) over COMPLETED | REFUND_PENDING | REFUNDED charges. */
  grossStars: number;
  /** SUM(starsAmount) over REFUNDED charges (confirmed refunds only). */
  refundedStars: number;
  /** grossStars − refundedStars. NOT profit. */
  netStars: number;
  /** Count of all COMPLETED charges (initial + recurring). */
  completedRenewals: number;
  /**
   * Live subscription-state count of REQUIRES_ACTION subscriptions. Subscriptions
   * have no receivedAt to bucket by, so this is intentionally NOT range-scoped.
   */
  requiresAction: number;
  /** Count of REFUND_PENDING charges (== refundRequested). */
  refundPending: number;
  /** Count of REFUND_PENDING charges (refunds requested, not yet confirmed). */
  refundRequested: number;
  /** Count of REFUNDED charges (refunds confirmed). */
  refundConfirmed: number;
}

/**
 * Aggregates the Stars-subscription charge rows for the given range (bucketed by
 * receivedAt; all-time when the range start is null) plus the live count of
 * REQUIRES_ACTION subscriptions. One groupBy + one count; all other math is
 * in-memory. Stars are never converted to Toman.
 */
export async function getStarsSubscriptionReport(
  range: ReportRange,
): Promise<StarsSubscriptionReport> {
  const from = reportRangeStart(range);
  const receivedFilter = from === null ? {} : { receivedAt: { gte: from } };

  const [chargeGroups, requiresAction] = await Promise.all([
    prisma.telegramStarsSubscriptionCharge.groupBy({
      by: ["status", "isFirstRecurring"],
      where: receivedFilter,
      _count: { _all: true },
      _sum: { starsAmount: true },
    }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "REQUIRES_ACTION" } }),
  ]);

  let initialCount = 0;
  let recurringCount = 0;
  let grossStars = 0;
  let refundedStars = 0;
  let completedRenewals = 0;
  let refundRequested = 0;
  let refundConfirmed = 0;

  for (const group of chargeGroups) {
    const count = group._count._all;
    const stars = group._sum.starsAmount ?? 0;

    if (group.status === "COMPLETED") {
      completedRenewals += count;
      if (group.isFirstRecurring) {
        initialCount += count;
      } else {
        recurringCount += count;
      }
    }

    // gross = money actually received (see header): COMPLETED | REFUND_PENDING | REFUNDED.
    if (
      group.status === "COMPLETED" ||
      group.status === "REFUND_PENDING" ||
      group.status === "REFUNDED"
    ) {
      grossStars += stars;
    }

    // refunded = CONFIRMED refunds only; REFUND_PENDING is never counted as refunded.
    if (group.status === "REFUNDED") {
      refundedStars += stars;
      refundConfirmed += count;
    }

    if (group.status === "REFUND_PENDING") {
      refundRequested += count;
    }
  }

  return {
    range,
    from,
    initialCount,
    recurringCount,
    grossStars,
    refundedStars,
    netStars: grossStars - refundedStars,
    completedRenewals,
    requiresAction,
    refundPending: refundRequested,
    refundRequested,
    refundConfirmed,
  };
}

// --- CSV export --------------------------------------------------------------

// csvCell / csvRow copied from
// apps/bot/src/services/notification/analytics-report.service.ts (csvRow is not
// exported there). RFC-4180 quoting PLUS formula-injection defence — a value
// beginning with = + - @ or a control char is prefixed with a single quote so a
// spreadsheet never executes it.
function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(",");
}

/**
 * Renders an AGGREGATE-ONLY CSV (metric,value rows). Contains NO PII — no user
 * id, charge id, subscription id, telegram id or service name ever appears; only
 * the range label and Stars counts/sums. Safe to hand to a spreadsheet (see
 * csvCell). Stars are never converted to Toman.
 */
export function buildStarsReportCsv(
  report: StarsSubscriptionReport,
  rangeLabel: string,
): string {
  const lines: string[] = [];
  lines.push(csvRow(["metric", "value"]));
  lines.push(csvRow(["range", rangeLabel]));
  lines.push(csvRow(["initial_charge_count", report.initialCount]));
  lines.push(csvRow(["recurring_charge_count", report.recurringCount]));
  lines.push(csvRow(["gross_stars", report.grossStars]));
  lines.push(csvRow(["refunded_stars", report.refundedStars]));
  lines.push(csvRow(["net_stars", report.netStars]));
  lines.push(csvRow(["completed_renewals", report.completedRenewals]));
  lines.push(csvRow(["refund_pending", report.refundPending]));
  lines.push(csvRow(["requires_action", report.requiresAction]));
  return lines.join("\n") + "\n";
}
