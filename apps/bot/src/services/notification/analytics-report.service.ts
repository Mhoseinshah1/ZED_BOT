import { AutomatedNotificationStatus, prisma } from "@zedbot/database";
import {
  calculateFunnelMetrics,
  resolveReportDateRange,
  type AttributionKind,
  type FunnelMetrics,
  type ReportDateRange,
} from "@zedbot/shared";

import { getAnalyticsReportingTimezone } from "./analytics-settings.service.js";

// =============================================================================
// Analytics REPORTING (Phase 4). Bounded, timezone-aware, DB-AGGREGATED reports
// over a half-open [start, end) local-day range. Two labelled views:
//   - cohort     (default): conversions anchored on the notification's sentAt —
//                 "of the messages sent in this window, how many converted".
//   - conversion (timeline): conversions anchored on the Order's completedAt —
//                 "revenue booked in this window, whenever the message was sent".
// The delivery funnel (generated/sent/failed/dead-letter/clicked) is always
// anchored on the notification's own timestamps in the window. Every figure is a
// COUNT or a SUM of Order.finalPriceToman — never a fabricated metric, never an
// impression/open/read, never profit.
// =============================================================================

export type AnalyticsView = "cohort" | "conversion";

export const NOTIFICATION_TYPES = [
  "SERVICE_EXPIRY",
  "SERVICE_TRAFFIC",
  "SERVICE_EXPIRED",
  "SERVICE_LIMITED",
  "TRIAL_NEAR_EXPIRY",
  "TRIAL_EXPIRED",
  "ABANDONED_CHECKOUT",
  "PAYMENT_RETRY",
  "CUSTOMER_WINBACK",
] as const;

export interface KindRevenue {
  conversions: number;
  grossRevenueToman: number;
  reversedRevenueToman: number;
  netRevenueToman: number;
}

export interface TypeBreakdownRow {
  type: string;
  sent: number;
  clicked: number;
  conversions: number;
  grossRevenueToman: number;
  netRevenueToman: number;
}

export interface AnalyticsReport {
  view: AnalyticsView;
  timezone: string;
  startDay: string;
  endDay: string;
  range: ReportDateRange;
  metrics: FunnelMetrics;
  byKind: Record<AttributionKind, KindRevenue>;
  byType: TypeBreakdownRow[];
}

export type AnalyticsReportResult =
  | { ok: true; report: AnalyticsReport }
  | { ok: false; reason: "invalid-range" };

function emptyKindRevenue(): KindRevenue {
  return { conversions: 0, grossRevenueToman: 0, reversedRevenueToman: 0, netRevenueToman: 0 };
}

/** The attribution anchor column for the selected view. */
function anchorField(view: AnalyticsView): "notificationSentAt" | "orderCompletedAt" {
  return view === "cohort" ? "notificationSentAt" : "orderCompletedAt";
}

/**
 * Builds the analytics report for a local-day range. Returns invalid-range for a
 * malformed / inverted / over-long span (the shared resolver bounds it to
 * MAX_REPORT_RANGE_DAYS). All aggregation runs in the database.
 */
export async function getAnalyticsReport(
  startDay: string,
  endDay: string,
  view: AnalyticsView,
): Promise<AnalyticsReportResult> {
  const timezone = await getAnalyticsReportingTimezone();
  const range = resolveReportDateRange(startDay, endDay, timezone);
  if (range === null) {
    return { ok: false, reason: "invalid-range" };
  }
  const { startInclusive: start, endExclusive: end } = range;
  const anchor = anchorField(view);
  const anchorRange = { [anchor]: { gte: start, lt: end } };

  // --- delivery funnel (anchored on the notification timestamps) -------------
  const [generated, sent, failed, deadLetter, sentWithInteraction] = await Promise.all([
    prisma.automatedNotification.count({ where: { createdAt: { gte: start, lt: end } } }),
    prisma.automatedNotification.count({
      where: { status: AutomatedNotificationStatus.SENT, sentAt: { gte: start, lt: end } },
    }),
    prisma.automatedNotification.count({
      where: { status: AutomatedNotificationStatus.FAILED, failedAt: { gte: start, lt: end } },
    }),
    prisma.automatedNotification.count({
      where: { status: AutomatedNotificationStatus.DEAD_LETTER, updatedAt: { gte: start, lt: end } },
    }),
    prisma.automatedNotification.count({
      where: {
        status: AutomatedNotificationStatus.SENT,
        sentAt: { gte: start, lt: end },
        interactions: { some: {} },
      },
    }),
  ]);

  // --- conversions + revenue by kind (anchored per the selected view) --------
  const kindGroups = await prisma.notificationConversionAttribution.groupBy({
    by: ["kind"],
    where: anchorRange,
    _count: { _all: true },
    _sum: { grossRevenueToman: true, reversedRevenueToman: true },
  });
  const byKind: Record<AttributionKind, KindRevenue> = {
    DIRECT_CHECKOUT: emptyKindRevenue(),
    DIRECT_SERVICE: emptyKindRevenue(),
    ASSISTED_WINBACK: emptyKindRevenue(),
  };
  for (const g of kindGroups) {
    const gross = g._sum.grossRevenueToman ?? 0;
    const reversed = g._sum.reversedRevenueToman ?? 0;
    byKind[g.kind as AttributionKind] = {
      conversions: g._count._all,
      grossRevenueToman: gross,
      reversedRevenueToman: reversed,
      netRevenueToman: Math.max(0, gross - reversed),
    };
  }

  const metrics = calculateFunnelMetrics({
    generated,
    sent,
    failed,
    deadLetter,
    sentWithInteraction,
    directCheckoutConversions: byKind.DIRECT_CHECKOUT.conversions,
    directServiceConversions: byKind.DIRECT_SERVICE.conversions,
    assistedWinbackConversions: byKind.ASSISTED_WINBACK.conversions,
    grossRevenueToman:
      byKind.DIRECT_CHECKOUT.grossRevenueToman +
      byKind.DIRECT_SERVICE.grossRevenueToman +
      byKind.ASSISTED_WINBACK.grossRevenueToman,
    reversedRevenueToman:
      byKind.DIRECT_CHECKOUT.reversedRevenueToman +
      byKind.DIRECT_SERVICE.reversedRevenueToman +
      byKind.ASSISTED_WINBACK.reversedRevenueToman,
  });

  const byType = await buildTypeBreakdown(start, end, anchor);

  return {
    ok: true,
    report: { view, timezone, startDay, endDay, range, metrics, byKind, byType },
  };
}

async function buildTypeBreakdown(
  start: Date,
  end: Date,
  anchor: "notificationSentAt" | "orderCompletedAt",
): Promise<TypeBreakdownRow[]> {
  // Per-type sent + clicked (notification-anchored) and conversions + revenue
  // (view-anchored), grouped in the DB.
  const [sentByType, clickedByType, convByType] = await Promise.all([
    prisma.automatedNotification.groupBy({
      by: ["type"],
      where: { status: AutomatedNotificationStatus.SENT, sentAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prisma.automatedNotification.groupBy({
      by: ["type"],
      where: {
        status: AutomatedNotificationStatus.SENT,
        sentAt: { gte: start, lt: end },
        interactions: { some: {} },
      },
      _count: { _all: true },
    }),
    prisma.notificationConversionAttribution.groupBy({
      by: ["notificationType"],
      where: { [anchor]: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { grossRevenueToman: true, reversedRevenueToman: true },
    }),
  ]);

  const sentMap = new Map(sentByType.map((r) => [r.type, r._count._all]));
  const clickedMap = new Map(clickedByType.map((r) => [r.type, r._count._all]));
  const convMap = new Map(
    convByType.map((r) => [
      r.notificationType,
      {
        conversions: r._count._all,
        gross: r._sum.grossRevenueToman ?? 0,
        reversed: r._sum.reversedRevenueToman ?? 0,
      },
    ]),
  );

  const rows: TypeBreakdownRow[] = [];
  for (const type of NOTIFICATION_TYPES) {
    const sent = sentMap.get(type) ?? 0;
    const clicked = clickedMap.get(type) ?? 0;
    const conv = convMap.get(type);
    // Only include a row that has some activity, to keep the report compact.
    if (sent === 0 && clicked === 0 && (conv?.conversions ?? 0) === 0) {
      continue;
    }
    rows.push({
      type,
      sent,
      clicked,
      conversions: conv?.conversions ?? 0,
      grossRevenueToman: conv?.gross ?? 0,
      netRevenueToman: Math.max(0, (conv?.gross ?? 0) - (conv?.reversed ?? 0)),
    });
  }
  return rows;
}

// --- CSV export --------------------------------------------------------------

/**
 * Escapes ONE CSV cell: RFC-4180 quoting (double up quotes; wrap on comma / quote
 * / newline) PLUS formula-injection defence — a value beginning with = + - @ or a
 * control char is prefixed with a single quote so a spreadsheet never executes it.
 */
export function csvCell(value: string | number): string {
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
 * Renders an AGGREGATE-ONLY CSV: overview funnel, per-kind revenue and per-type
 * breakdown. Contains NO PII — no user id, order id, notification id, service
 * name or telegram id ever appears; only counts, type/kind labels and Toman
 * sums. Safe to hand to a spreadsheet (see csvCell).
 */
export function buildAnalyticsCsv(report: AnalyticsReport): string {
  const m = report.metrics;
  const lines: string[] = [];
  lines.push(csvRow(["section", "metric", "value"]));
  lines.push(csvRow(["meta", "view", report.view]));
  lines.push(csvRow(["meta", "timezone", report.timezone]));
  lines.push(csvRow(["meta", "start_day", report.startDay]));
  lines.push(csvRow(["meta", "end_day", report.endDay]));
  lines.push(csvRow(["funnel", "generated", m.generated]));
  lines.push(csvRow(["funnel", "sent", m.sent]));
  lines.push(csvRow(["funnel", "failed", m.failed]));
  lines.push(csvRow(["funnel", "dead_letter", m.deadLetter]));
  lines.push(csvRow(["funnel", "delivery_success_rate", m.deliverySuccessRate.toFixed(4)]));
  lines.push(csvRow(["funnel", "sent_with_interaction", m.sentWithInteraction]));
  lines.push(csvRow(["funnel", "click_through_rate", m.clickThroughRate.toFixed(4)]));
  lines.push(csvRow(["conversions", "direct_checkout", m.directCheckoutConversions]));
  lines.push(csvRow(["conversions", "direct_service", m.directServiceConversions]));
  lines.push(csvRow(["conversions", "assisted_winback", m.assistedWinbackConversions]));
  lines.push(csvRow(["conversions", "total", m.totalConversions]));
  lines.push(csvRow(["conversions", "conversion_rate", m.conversionRate.toFixed(4)]));
  lines.push(csvRow(["revenue", "attributed_gross_toman", m.grossRevenueToman]));
  lines.push(csvRow(["revenue", "reversed_toman", m.reversedRevenueToman]));
  lines.push(csvRow(["revenue", "attributed_net_toman", m.netRevenueToman]));
  lines.push("");
  lines.push(csvRow(["kind", "conversions", "gross_toman", "reversed_toman", "net_toman"]));
  for (const kind of ["DIRECT_CHECKOUT", "DIRECT_SERVICE", "ASSISTED_WINBACK"] as const) {
    const k = report.byKind[kind];
    lines.push(csvRow([kind, k.conversions, k.grossRevenueToman, k.reversedRevenueToman, k.netRevenueToman]));
  }
  lines.push("");
  lines.push(csvRow(["notification_type", "sent", "clicked", "conversions", "gross_toman", "net_toman"]));
  for (const row of report.byType) {
    lines.push(
      csvRow([row.type, row.sent, row.clicked, row.conversions, row.grossRevenueToman, row.netRevenueToman]),
    );
  }
  return lines.join("\n") + "\n";
}
