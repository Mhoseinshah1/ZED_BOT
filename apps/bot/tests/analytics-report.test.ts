import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  prisma,
  type User,
} from "@zedbot/database";
import { NOTIF_ANALYTICS_ENABLED_KEY, NOTIF_ANALYTICS_STARTED_AT_KEY } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "analytics-report-tests-secret-0123456789";

import {
  buildAnalyticsCsv,
  csvCell,
  getAnalyticsReport,
} from "../src/services/notification/analytics-report.service.js";

// =============================================================================
// Analytics reporting against a REAL DB, isolated in a per-run FUTURE date window
// (so accumulated rows from other suites/runs never pollute exact counts). Covers
// the funnel counts, CTR, direct/assisted conversions, gross/reversed/net revenue,
// the cohort vs conversion anchor, the bounded-range guard, plus the PURE CSV
// (formula-injection defence + PII-free aggregate output).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 86_400_000;
const HOUR = 3_600_000;

// A distinct future day per run: noon UTC sits safely inside the Tehran local day.
const dayOffset = Number(runTag % 4000n) + 10;
const anchor = new Date(Date.UTC(2100, 0, 1) + dayOffset * DAY + 12 * HOUR);
const DAY_STR = anchor.toISOString().slice(0, 10);

async function enableAnalyticsAt(started: Date): Promise<void> {
  await prisma.setting.upsert({
    where: { key: NOTIF_ANALYTICS_ENABLED_KEY },
    create: { key: NOTIF_ANALYTICS_ENABLED_KEY, value: "true", type: "BOOLEAN" },
    update: { value: "true" },
  });
  await prisma.setting.upsert({
    where: { key: NOTIF_ANALYTICS_STARTED_AT_KEY },
    create: { key: NOTIF_ANALYTICS_STARTED_AT_KEY, value: started.toISOString(), type: "STRING" },
    update: { value: started.toISOString() },
  });
}

d("analytics reporting", () => {
  let user: User;
  let seq = 0;

  beforeAll(async () => {
    await enableAnalyticsAt(new Date(Date.UTC(2099, 0, 1)));
    user = await prisma.user.create({
      data: { telegramId: runTag, status: "ACTIVE", group: "F" },
    });

    // --- delivery funnel: 3 SENT (2 clicked), 1 FAILED, 1 DEAD_LETTER --------
    const sentIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seq += 1;
      const n = await prisma.automatedNotification.create({
        data: {
          type: "SERVICE_EXPIRY",
          category: AutomatedNotificationCategory.SERVICE,
          status: AutomatedNotificationStatus.SENT,
          userId: user.id,
          dedupeKey: `arep-${runTag}-${seq}`,
          scheduledFor: anchor,
          sentAt: anchor,
          createdAt: anchor,
          payloadSnapshot: {},
        },
        select: { id: true },
      });
      sentIds.push(n.id);
    }
    // 2 of the 3 sent get a recorded click.
    for (const nid of sentIds.slice(0, 2)) {
      await prisma.notificationInteraction.create({
        data: { notificationId: nid, userId: user.id, type: "RENEW_SERVICE", createdAt: anchor },
      });
    }
    seq += 1;
    await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.FAILED, userId: user.id, dedupeKey: `arep-${runTag}-${seq}`,
        scheduledFor: anchor, failedAt: anchor, createdAt: anchor, payloadSnapshot: {},
      },
    });
    seq += 1;
    await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.DEAD_LETTER, userId: user.id, dedupeKey: `arep-${runTag}-${seq}`,
        scheduledFor: anchor, updatedAt: anchor, createdAt: anchor, payloadSnapshot: {},
      },
    });

    // --- conversions: 1 DIRECT_SERVICE (100k), 1 DIRECT_CHECKOUT (50k, reversed) --
    await prisma.notificationConversionAttribution.create({
      data: {
        kind: "DIRECT_SERVICE", orderId: `arep-o1-${runTag}`, notificationId: sentIds[0],
        interactionId: `arep-i1-${runTag}`, userId: user.id,
        notificationType: "SERVICE_EXPIRY", interactionType: "RENEW_SERVICE",
        grossRevenueToman: 100000, reversedRevenueToman: 0, netRevenueToman: 100000,
        notificationSentAt: anchor, interactionAt: anchor, orderCompletedAt: anchor,
        windowSeconds: 3600, evidenceSnapshot: {},
      },
    });
    await prisma.notificationConversionAttribution.create({
      data: {
        kind: "DIRECT_CHECKOUT", orderId: `arep-o2-${runTag}`, notificationId: sentIds[1],
        interactionId: `arep-i2-${runTag}`, userId: user.id,
        notificationType: "ABANDONED_CHECKOUT", interactionType: "CONTINUE_CHECKOUT",
        grossRevenueToman: 50000, reversedRevenueToman: 50000, netRevenueToman: 0,
        status: "REVERSED",
        notificationSentAt: anchor, interactionAt: anchor, orderCompletedAt: anchor,
        windowSeconds: 3600, evidenceSnapshot: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("aggregates the delivery funnel, CTR, conversions and revenue (cohort view)", async () => {
    const result = await getAnalyticsReport(DAY_STR, DAY_STR, "cohort");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.report.metrics;
    expect(m.generated).toBe(5);
    expect(m.sent).toBe(3);
    expect(m.failed).toBe(1);
    expect(m.deadLetter).toBe(1);
    expect(m.deliverySuccessRate).toBeCloseTo(3 / 5);
    expect(m.sentWithInteraction).toBe(2);
    expect(m.clickThroughRate).toBeCloseTo(2 / 3);
    expect(m.directServiceConversions).toBe(1);
    expect(m.directCheckoutConversions).toBe(1);
    expect(m.totalConversions).toBe(2);
    expect(m.grossRevenueToman).toBe(150000);
    expect(m.reversedRevenueToman).toBe(50000);
    expect(m.netRevenueToman).toBe(100000);
  });

  it("produces the same conversions under the conversion-timeline view (same anchor day)", async () => {
    const result = await getAnalyticsReport(DAY_STR, DAY_STR, "conversion");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.metrics.totalConversions).toBe(2);
    expect(result.report.metrics.netRevenueToman).toBe(100000);
    expect(result.report.byKind.DIRECT_CHECKOUT.reversedRevenueToman).toBe(50000);
  });

  it("breaks conversions down by notification type", async () => {
    const result = await getAnalyticsReport(DAY_STR, DAY_STR, "cohort");
    if (!result.ok) return;
    const expiry = result.report.byType.find((r) => r.type === "SERVICE_EXPIRY");
    expect(expiry?.sent).toBe(3);
    expect(expiry?.clicked).toBe(2);
    expect(expiry?.conversions).toBe(1);
    expect(expiry?.netRevenueToman).toBe(100000);
  });

  it("rejects a malformed / inverted / over-long range", async () => {
    expect((await getAnalyticsReport("2100-13-40", DAY_STR, "cohort")).ok).toBe(false);
    expect((await getAnalyticsReport("2100-06-10", "2100-06-01", "cohort")).ok).toBe(false);
    expect((await getAnalyticsReport("2000-01-01", "2100-01-01", "cohort")).ok).toBe(false);
  });

  it("excludes activity outside the requested window", async () => {
    // A single day one week earlier has none of our fixtures.
    const otherDay = new Date(anchor.getTime() - 7 * DAY).toISOString().slice(0, 10);
    const result = await getAnalyticsReport(otherDay, otherDay, "cohort");
    if (!result.ok) return;
    expect(result.report.metrics.sent).toBe(0);
    expect(result.report.metrics.totalConversions).toBe(0);
  });
});

// --- pure CSV tests (no DB) ---------------------------------------------------

describe("analytics CSV — formula injection + PII-free", () => {
  it("neutralises formula-trigger prefixes", () => {
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+49")).toBe("'+49");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("safe")).toBe("safe");
  });

  it("RFC-4180 quotes cells with commas / quotes / newlines", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("renders an aggregate CSV with no user/order/notification ids", () => {
    const csv = buildAnalyticsCsv({
      view: "cohort",
      timezone: "Asia/Tehran",
      startDay: "2026-06-01",
      endDay: "2026-06-30",
      range: { startInclusive: new Date(), endExclusive: new Date() },
      metrics: {
        generated: 10, sent: 8, failed: 1, deadLetter: 1, sentWithInteraction: 4,
        directCheckoutConversions: 2, directServiceConversions: 1, assistedWinbackConversions: 1,
        grossRevenueToman: 500000, reversedRevenueToman: 100000,
        deliverySuccessRate: 0.8, clickThroughRate: 0.5, directConversions: 3, assistedConversions: 1,
        totalConversions: 4, netRevenueToman: 400000, conversionRate: 0.5,
      },
      byKind: {
        DIRECT_CHECKOUT: { conversions: 2, grossRevenueToman: 200000, reversedRevenueToman: 0, netRevenueToman: 200000 },
        DIRECT_SERVICE: { conversions: 1, grossRevenueToman: 100000, reversedRevenueToman: 0, netRevenueToman: 100000 },
        ASSISTED_WINBACK: { conversions: 1, grossRevenueToman: 200000, reversedRevenueToman: 100000, netRevenueToman: 100000 },
      },
      byType: [
        { type: "SERVICE_EXPIRY", sent: 5, clicked: 3, conversions: 1, grossRevenueToman: 100000, netRevenueToman: 100000 },
      ],
    });
    expect(csv).toContain("attributed_net_toman,400000");
    expect(csv).toContain("SERVICE_EXPIRY,5,3,1,100000,100000");
    // No PII markers.
    expect(csv).not.toMatch(/telegram|userId|orderId|@/i);
  });
});
