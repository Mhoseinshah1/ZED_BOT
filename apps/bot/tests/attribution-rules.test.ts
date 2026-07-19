import {
  DEFAULT_ATTRIBUTION_CONFIG,
  attributionKindClass,
  calculateFunnelMetrics,
  evaluateNotificationAttributionCandidate,
  localDayStartUtc,
  parseAttributionConfig,
  rankAttributionCandidates,
  resolveReportDateRange,
  selectAttributionWinner,
  zoneOffsetMinutes,
  type AttributionInteractionInput,
  type AttributionOrderInput,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// PURE attribution contract tests (no DB). The evidence-based evaluator, the
// precedence ranker, the funnel-metric calculator, the config parser and the
// timezone-aware half-open date-range helpers. This is the single source of
// truth the after-commit hook, the reconciler, the preview and the reports all
// call — so it is exhaustively unit-tested here.
// =============================================================================

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0); // a fixed base instant

function order(overrides: Partial<AttributionOrderInput> = {}): AttributionOrderInput {
  return {
    orderId: "order-1",
    userId: "user-1",
    orderType: "SERVICE_RENEWAL",
    orderCompletedAt: T0 + 3 * HOUR,
    finalPriceToman: 120000,
    checkoutSessionId: null,
    serviceId: "svc-1",
    isRefunded: false,
    analyticsStartedAt: T0 - 30 * DAY,
    ...overrides,
  };
}

function click(overrides: Partial<AttributionInteractionInput> = {}): AttributionInteractionInput {
  return {
    interactionId: "int-1",
    notificationId: "ntf-1",
    notificationType: "SERVICE_EXPIRY",
    interactionType: "RENEW_SERVICE",
    notificationSentAt: T0,
    interactionAt: T0 + 1 * HOUR,
    notificationCheckoutSessionId: null,
    notificationServiceId: "svc-1",
    ...overrides,
  };
}

describe("evaluateNotificationAttributionCandidate — trust guards", () => {
  it("attributes nothing when analytics was never started", () => {
    const r = evaluateNotificationAttributionCandidate(order({ analyticsStartedAt: null }), [click()]);
    expect(r).toMatchObject({ attributed: false, reason: "analytics-not-started" });
  });

  it("never back-fills an order completed before analytics started", () => {
    const r = evaluateNotificationAttributionCandidate(
      order({ analyticsStartedAt: T0 + 10 * HOUR, orderCompletedAt: T0 + 3 * HOUR }),
      [click()],
    );
    expect(r).toMatchObject({ attributed: false, reason: "before-analytics-start" });
  });

  it("attributes nothing for a refunded order", () => {
    const r = evaluateNotificationAttributionCandidate(order({ isRefunded: true }), [click()]);
    expect(r).toMatchObject({ attributed: false, reason: "order-refunded" });
  });

  it("requires a recorded click — temporal proximity alone is never enough", () => {
    const r = evaluateNotificationAttributionCandidate(order(), []);
    expect(r).toMatchObject({ attributed: false, reason: "no-eligible-interaction" });
  });

  it("rejects a click that happened AFTER the order completed", () => {
    const r = evaluateNotificationAttributionCandidate(order(), [
      click({ interactionAt: T0 + 4 * HOUR }),
    ]);
    expect(r.attributed).toBe(false);
  });

  it("rejects a click recorded BEFORE the notification was sent", () => {
    const r = evaluateNotificationAttributionCandidate(order(), [
      click({ notificationSentAt: T0 + 2 * HOUR, interactionAt: T0 + 1 * HOUR }),
    ]);
    expect(r.attributed).toBe(false);
  });
});

describe("evaluateNotificationAttributionCandidate — DIRECT_SERVICE", () => {
  it("attributes a renewal to a same-service expiry notice click within the window", () => {
    const r = evaluateNotificationAttributionCandidate(order(), [click()]);
    expect(r.attributed).toBe(true);
    if (r.attributed) {
      expect(r.decision.kind).toBe("DIRECT_SERVICE");
      expect(r.decision.grossRevenueToman).toBe(120000);
      expect(r.decision.evidence.serviceMatched).toBe(true);
      expect(r.decision.windowSeconds).toBe((3 * HOUR) / 1000);
    }
  });

  it("does NOT attribute when the order's service differs from the notice's service", () => {
    const r = evaluateNotificationAttributionCandidate(order({ serviceId: "svc-OTHER" }), [click()]);
    expect(r.attributed).toBe(false);
  });

  it("does NOT attribute past the direct-service window", () => {
    const r = evaluateNotificationAttributionCandidate(
      order({ orderCompletedAt: T0 + 100 * HOUR }),
      [click({ interactionAt: T0 + 1 * HOUR })],
    );
    expect(r.attributed).toBe(false);
  });

  it("does NOT attribute a non-lifecycle order type to a service notice", () => {
    const r = evaluateNotificationAttributionCandidate(order({ orderType: "OTHER_PRODUCT" }), [click()]);
    expect(r.attributed).toBe(false);
  });
});

describe("evaluateNotificationAttributionCandidate — DIRECT_CHECKOUT", () => {
  const checkoutOrder = order({
    orderType: "SERVICE_PURCHASE",
    serviceId: null,
    checkoutSessionId: "co-1",
  });
  const checkoutClick = click({
    notificationType: "ABANDONED_CHECKOUT",
    interactionType: "CONTINUE_CHECKOUT",
    notificationServiceId: null,
    notificationCheckoutSessionId: "co-1",
  });

  it("attributes a completed checkout to its abandoned-checkout notice", () => {
    const r = evaluateNotificationAttributionCandidate(checkoutOrder, [checkoutClick]);
    expect(r.attributed).toBe(true);
    if (r.attributed) {
      expect(r.decision.kind).toBe("DIRECT_CHECKOUT");
      expect(r.decision.evidence.checkoutMatched).toBe(true);
    }
  });

  it("does NOT attribute when the checkout session differs", () => {
    const r = evaluateNotificationAttributionCandidate(checkoutOrder, [
      { ...checkoutClick, notificationCheckoutSessionId: "co-OTHER" },
    ]);
    expect(r.attributed).toBe(false);
  });
});

describe("evaluateNotificationAttributionCandidate — ASSISTED_WINBACK", () => {
  const winbackOrder = order({ orderType: "SERVICE_PURCHASE", serviceId: null, checkoutSessionId: null });
  const winbackClick = click({
    notificationType: "CUSTOMER_WINBACK",
    interactionType: "VIEW_PRODUCTS",
    notificationServiceId: null,
    interactionAt: T0 + 2 * DAY,
  });

  it("attributes a new purchase after a win-back click within the (longer) window", () => {
    const o = winbackOrder;
    o.orderCompletedAt = T0 + 3 * DAY;
    const r = evaluateNotificationAttributionCandidate(o, [winbackClick]);
    expect(r.attributed).toBe(true);
    if (r.attributed) {
      expect(r.decision.kind).toBe("ASSISTED_WINBACK");
      expect(attributionKindClass(r.decision.kind)).toBe("assisted");
      expect(r.decision.evidence.checkoutMatched).toBe(false);
      expect(r.decision.evidence.serviceMatched).toBe(false);
    }
  });

  it("does NOT attribute a win-back click past the assisted window", () => {
    const o = order({ orderType: "SERVICE_PURCHASE", serviceId: null, orderCompletedAt: T0 + 30 * DAY });
    const r = evaluateNotificationAttributionCandidate(o, [winbackClick]);
    expect(r.attributed).toBe(false);
  });
});

describe("precedence + single-attribution guarantee", () => {
  it("prefers DIRECT_CHECKOUT over DIRECT_SERVICE over ASSISTED_WINBACK", () => {
    const o = order({ orderType: "SERVICE_PURCHASE", serviceId: "svc-1", checkoutSessionId: "co-1" });
    o.orderCompletedAt = T0 + 5 * HOUR;
    const winback = click({
      interactionId: "int-wb",
      notificationType: "CUSTOMER_WINBACK",
      interactionType: "VIEW_PRODUCTS",
      notificationServiceId: null,
      interactionAt: T0 + 1 * HOUR,
    });
    const service = click({
      interactionId: "int-svc",
      notificationType: "SERVICE_EXPIRY",
      interactionType: "RENEW_SERVICE",
      notificationServiceId: "svc-1",
      interactionAt: T0 + 2 * HOUR,
    });
    // A SERVICE_PURCHASE order type won't match DIRECT_SERVICE (needs lifecycle),
    // so use a lifecycle order to exercise the full ladder.
    const lifecycle = order({ orderType: "SERVICE_RENEWAL", serviceId: "svc-1", checkoutSessionId: "co-1" });
    lifecycle.orderCompletedAt = T0 + 5 * HOUR;
    const checkout = click({
      interactionId: "int-co",
      notificationType: "ABANDONED_CHECKOUT",
      interactionType: "CONTINUE_CHECKOUT",
      notificationServiceId: null,
      notificationCheckoutSessionId: "co-1",
      interactionAt: T0 + 3 * HOUR,
    });
    const r = evaluateNotificationAttributionCandidate(lifecycle, [winback, service, checkout]);
    expect(r.attributed).toBe(true);
    if (r.attributed) {
      expect(r.decision.kind).toBe("DIRECT_CHECKOUT");
      expect(r.decision.interactionId).toBe("int-co");
    }
  });

  it("ranks within a kind by the most-proximate click, deterministically", () => {
    const early = click({ interactionId: "a", interactionAt: T0 + 1 * HOUR });
    const late = click({ interactionId: "b", interactionAt: T0 + 2 * HOUR });
    const ranked = rankAttributionCandidates(
      [early, late].map((c) => ({
        kind: "DIRECT_SERVICE" as const,
        interactionId: c.interactionId,
        notificationId: c.notificationId,
        notificationType: c.notificationType,
        interactionType: c.interactionType,
        grossRevenueToman: 1,
        notificationSentAt: c.notificationSentAt,
        interactionAt: c.interactionAt,
        orderCompletedAt: T0 + 3 * HOUR,
        windowSeconds: 0,
        evidence: {} as never,
      })),
    );
    expect(ranked[0].interactionId).toBe("b"); // latest click wins
    expect(selectAttributionWinner([])).toBeNull();
  });
});

describe("calculateFunnelMetrics", () => {
  it("computes the fixed-definition rates and guards zero denominators", () => {
    const m = calculateFunnelMetrics({
      generated: 100,
      sent: 80,
      failed: 15,
      deadLetter: 5,
      sentWithInteraction: 20,
      directCheckoutConversions: 4,
      directServiceConversions: 6,
      assistedWinbackConversions: 2,
      grossRevenueToman: 1000000,
      reversedRevenueToman: 150000,
    });
    expect(m.deliverySuccessRate).toBeCloseTo(80 / 100);
    expect(m.clickThroughRate).toBeCloseTo(20 / 80);
    expect(m.directConversions).toBe(10);
    expect(m.assistedConversions).toBe(2);
    expect(m.totalConversions).toBe(12);
    expect(m.netRevenueToman).toBe(850000);
    expect(m.conversionRate).toBeCloseTo(12 / 80);
  });

  it("returns 0 rates (never NaN) for an empty funnel", () => {
    const m = calculateFunnelMetrics({
      generated: 0, sent: 0, failed: 0, deadLetter: 0, sentWithInteraction: 0,
      directCheckoutConversions: 0, directServiceConversions: 0, assistedWinbackConversions: 0,
      grossRevenueToman: 0, reversedRevenueToman: 0,
    });
    expect(m.deliverySuccessRate).toBe(0);
    expect(m.clickThroughRate).toBe(0);
    expect(m.conversionRate).toBe(0);
    expect(m.netRevenueToman).toBe(0);
  });

  it("floors net revenue at 0 when reversed exceeds gross", () => {
    const m = calculateFunnelMetrics({
      generated: 1, sent: 1, failed: 0, deadLetter: 0, sentWithInteraction: 1,
      directCheckoutConversions: 1, directServiceConversions: 0, assistedWinbackConversions: 0,
      grossRevenueToman: 100, reversedRevenueToman: 200,
    });
    expect(m.netRevenueToman).toBe(0);
  });
});

describe("parseAttributionConfig", () => {
  it("returns the whole fallback on any invalid field", () => {
    expect(parseAttributionConfig("not json", DEFAULT_ATTRIBUTION_CONFIG)).toEqual(DEFAULT_ATTRIBUTION_CONFIG);
    expect(parseAttributionConfig({ directCheckoutWindowHours: 0 }, DEFAULT_ATTRIBUTION_CONFIG)).toEqual(
      DEFAULT_ATTRIBUTION_CONFIG,
    );
    expect(
      parseAttributionConfig({ directCheckoutWindowHours: 99999 }, DEFAULT_ATTRIBUTION_CONFIG),
    ).toEqual(DEFAULT_ATTRIBUTION_CONFIG);
  });

  it("accepts a valid config verbatim", () => {
    const cfg = { directCheckoutWindowHours: 24, directServiceWindowHours: 48, assistedWinbackWindowDays: 7, batchLookbackHours: 12 };
    expect(parseAttributionConfig(JSON.stringify(cfg), DEFAULT_ATTRIBUTION_CONFIG)).toEqual(cfg);
  });
});

describe("timezone-aware half-open date range", () => {
  it("Asia/Tehran midnight maps to the correct UTC instant (+03:30)", () => {
    expect(zoneOffsetMinutes(new Date(Date.UTC(2026, 0, 10, 12, 0, 0)), "Asia/Tehran")).toBe(210);
    const start = localDayStartUtc("2026-01-10", "Asia/Tehran");
    expect(start).not.toBeNull();
    // Local midnight 2026-01-10 in Tehran is 2026-01-09T20:30:00Z.
    expect(start?.toISOString()).toBe("2026-01-09T20:30:00.000Z");
  });

  it("builds a half-open [start, end) spanning inclusive local days", () => {
    const range = resolveReportDateRange("2026-01-10", "2026-01-12", "Asia/Tehran");
    expect(range).not.toBeNull();
    if (range !== null) {
      expect(range.startInclusive.toISOString()).toBe("2026-01-09T20:30:00.000Z");
      // endExclusive = local midnight after 2026-01-12 = 2026-01-12T20:30:00Z.
      expect(range.endExclusive.toISOString()).toBe("2026-01-12T20:30:00.000Z");
    }
  });

  it("rejects an inverted range, a malformed date, and an over-long span", () => {
    expect(resolveReportDateRange("2026-01-12", "2026-01-10", "Asia/Tehran")).toBeNull();
    expect(resolveReportDateRange("2026-02-31", "2026-03-01", "Asia/Tehran")).toBeNull();
    expect(resolveReportDateRange("2020-01-01", "2026-01-01", "Asia/Tehran")).toBeNull();
  });
});
