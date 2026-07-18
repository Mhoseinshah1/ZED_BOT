import {
  DEFAULT_ABANDONED_CHECKOUT_CONFIG,
  DEFAULT_FAILED_PAYMENT_CONFIG,
  PAYMENT_RETRY_PROVIDERS,
  checkoutAbandonedDedupeKey,
  evaluateAbandonedCheckoutEligibility,
  evaluateFailedPaymentEligibility,
  isRetryEligibleProvider,
  parseAbandonedCheckoutConfig,
  parseFailedPaymentConfig,
  paymentRetryDedupeKey,
  resolveCheckoutLastActivity,
  type AbandonedCheckoutSnapshot,
  type FailedPaymentSnapshot,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// Pure Phase-2 eligibility logic (no DB / Redis / Telegram). Covers the config
// parsers, the safe activity resolver, and every abandoned-checkout + failed-
// payment eligibility reason, stage and provider - the SAME functions the scan,
// the delivery re-validation and the admin preview all call.
// =============================================================================

const NOW = new Date("2026-07-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function abandoned(overrides: Partial<AbandonedCheckoutSnapshot> = {}): AbandonedCheckoutSnapshot {
  return {
    status: "PENDING",
    settled: false,
    hasOrder: false,
    hasPendingReviewPayment: false,
    hasApprovedReceipt: false,
    hasSettledPayment: false,
    hasDuplicateSuccessReview: false,
    reconciliationOpen: false,
    expiresAt: new Date(NOW.getTime() + 6 * HOUR),
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    lastActivityAt: new Date(NOW.getTime() - 40 * MIN),
    suppressedAt: null,
    existingReminderCount: 0,
    ...overrides,
  };
}

function failed(overrides: Partial<FailedPaymentSnapshot> = {}): FailedPaymentSnapshot {
  return {
    paymentStatus: "FAILED",
    provider: "ZARINPAL",
    paymentSettlementStatus: "UNSETTLED",
    failedAt: new Date(NOW.getTime() - 20 * MIN),
    checkoutSettled: false,
    hasOrder: false,
    hasPendingReviewPayment: false,
    reconciliationOpen: false,
    competingSuccess: false,
    checkoutExpired: false,
    suppressedAt: null,
    existingRetryCount: 0,
    checkoutRetryCountToday: 0,
    ...overrides,
  };
}

describe("config parsing", () => {
  it("accepts a valid abandoned config and sorts thresholds", () => {
    const cfg = parseAbandonedCheckoutConfig(
      JSON.stringify({ thresholdMinutes: [360, 30], maximumRemindersPerCheckout: 2, maximumCheckoutAgeHours: 24 }),
      DEFAULT_ABANDONED_CHECKOUT_CONFIG,
    );
    expect(cfg.thresholdMinutes).toEqual([30, 360]);
    expect(cfg.maximumRemindersPerCheckout).toBe(2);
  });
  it("falls back on invalid abandoned config (dup threshold / negative / zero counts)", () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ thresholdMinutes: [30, 30], maximumRemindersPerCheckout: 2, maximumCheckoutAgeHours: 24 }),
      JSON.stringify({ thresholdMinutes: [30], maximumRemindersPerCheckout: 0, maximumCheckoutAgeHours: 24 }),
      JSON.stringify({ thresholdMinutes: [-1], maximumRemindersPerCheckout: 2, maximumCheckoutAgeHours: 24 }),
      JSON.stringify({ thresholdMinutes: [], maximumRemindersPerCheckout: 2, maximumCheckoutAgeHours: 24 }),
    ]) {
      expect(parseAbandonedCheckoutConfig(bad, DEFAULT_ABANDONED_CHECKOUT_CONFIG)).toBe(
        DEFAULT_ABANDONED_CHECKOUT_CONFIG,
      );
    }
  });
  it("accepts a valid failed-payment config and rejects invalid", () => {
    expect(
      parseFailedPaymentConfig(
        JSON.stringify({ delayMinutes: 15, maximumRemindersPerPayment: 1, maximumRemindersPerCheckoutPerDay: 3 }),
        DEFAULT_FAILED_PAYMENT_CONFIG,
      ).delayMinutes,
    ).toBe(15);
    expect(
      parseFailedPaymentConfig(
        JSON.stringify({ delayMinutes: 0, maximumRemindersPerPayment: 1, maximumRemindersPerCheckoutPerDay: 3 }),
        DEFAULT_FAILED_PAYMENT_CONFIG,
      ),
    ).toBe(DEFAULT_FAILED_PAYMENT_CONFIG);
  });
});

describe("checkout activity resolver", () => {
  it("uses createdAt when there is no later activity", () => {
    const created = new Date(NOW.getTime() - 3 * HOUR);
    const a = resolveCheckoutLastActivity({
      checkoutCreatedAt: created,
      checkoutUpdatedAt: created,
      latestPaymentAt: null,
      latestReceiptAt: null,
      latestCustomerInputAt: null,
    });
    expect(a.lastActivityAt.getTime()).toBe(created.getTime());
    expect(a.reason).toBe("checkout_created");
  });
  it("picks the latest safe activity (payment/receipt/customer-input)", () => {
    const created = new Date(NOW.getTime() - 3 * HOUR);
    const latestReceipt = new Date(NOW.getTime() - 10 * MIN);
    const a = resolveCheckoutLastActivity({
      checkoutCreatedAt: created,
      checkoutUpdatedAt: new Date(NOW.getTime() - 1 * HOUR),
      latestPaymentAt: new Date(NOW.getTime() - 30 * MIN),
      latestReceiptAt: latestReceipt,
      latestCustomerInputAt: new Date(NOW.getTime() - 50 * MIN),
    });
    expect(a.lastActivityAt.getTime()).toBe(latestReceipt.getTime());
    expect(a.reason).toBe("receipt_submitted");
  });
});

describe("abandoned checkout eligibility — stages", () => {
  const cfg = DEFAULT_ABANDONED_CHECKOUT_CONFIG; // [30, 360], max 2, age 24h
  it("stage 1 when inactive >= 30m and no prior reminder", () => {
    const r = evaluateAbandonedCheckoutEligibility(abandoned({ lastActivityAt: new Date(NOW.getTime() - 31 * MIN) }), cfg, NOW);
    expect(r).toEqual({ eligible: true, stage: 1, thresholdMinutes: 30 });
  });
  it("too-early when inactive < 30m", () => {
    const r = evaluateAbandonedCheckoutEligibility(abandoned({ lastActivityAt: new Date(NOW.getTime() - 10 * MIN) }), cfg, NOW);
    expect(r).toEqual({ eligible: false, reason: "too-early" });
  });
  it("stage 2 when one reminder sent and inactive >= 360m", () => {
    const r = evaluateAbandonedCheckoutEligibility(
      abandoned({ existingReminderCount: 1, lastActivityAt: new Date(NOW.getTime() - 361 * MIN), createdAt: new Date(NOW.getTime() - 7 * HOUR) }),
      cfg,
      NOW,
    );
    expect(r).toEqual({ eligible: true, stage: 2, thresholdMinutes: 360 });
  });
  it("stage 2 too-early when inactive < 360m", () => {
    const r = evaluateAbandonedCheckoutEligibility(
      abandoned({ existingReminderCount: 1, lastActivityAt: new Date(NOW.getTime() - 60 * MIN) }),
      cfg,
      NOW,
    );
    expect(r).toEqual({ eligible: false, reason: "too-early" });
  });
  it("max-reached after two reminders", () => {
    const r = evaluateAbandonedCheckoutEligibility(abandoned({ existingReminderCount: 2 }), cfg, NOW);
    expect(r).toEqual({ eligible: false, reason: "max-reached" });
  });
});

describe("abandoned checkout eligibility — exclusions", () => {
  const cfg = DEFAULT_ABANDONED_CHECKOUT_CONFIG;
  const cases: Array<[string, Partial<AbandonedCheckoutSnapshot>]> = [
    ["cancelled", { status: "CANCELLED" }],
    ["cancelled", { status: "FAILED_REFUNDED" }],
    ["expired", { status: "EXPIRED" }],
    ["expired", { expiresAt: new Date(NOW.getTime() - 1 * MIN) }],
    ["settled", { status: "PAID", settled: true }],
    ["settled", { settled: true }],
    ["settled", { hasSettledPayment: true }],
    ["order-exists", { hasOrder: true }],
    ["receipt-pending", { hasPendingReviewPayment: true }],
    ["receipt-approved", { hasApprovedReceipt: true }],
    ["duplicate-success", { hasDuplicateSuccessReview: true }],
    ["reconciliation", { reconciliationOpen: true }],
    ["suppressed", { suppressedAt: new Date() }],
    ["too-old", { createdAt: new Date(NOW.getTime() - 30 * HOUR) }],
  ];
  it.each(cases)("excludes with reason %s", (reason, overrides) => {
    const r = evaluateAbandonedCheckoutEligibility(abandoned(overrides), cfg, NOW);
    expect(r).toEqual({ eligible: false, reason });
  });
});

describe("failed payment eligibility", () => {
  const cfg = DEFAULT_FAILED_PAYMENT_CONFIG; // delay 10, perPayment 1, perCheckoutDay 2
  it("eligible for a definitively FAILED online payment past the delay", () => {
    expect(evaluateFailedPaymentEligibility(failed(), cfg, NOW)).toEqual({ eligible: true });
  });
  it("eligible for EXPIRED", () => {
    expect(evaluateFailedPaymentEligibility(failed({ paymentStatus: "EXPIRED" }), cfg, NOW)).toEqual({ eligible: true });
  });
  const cases: Array<[string, Partial<FailedPaymentSnapshot>]> = [
    ["not-failed", { paymentStatus: "PROCESSING" }],
    ["not-failed", { paymentStatus: "APPROVED" }],
    ["excluded-provider", { provider: "CARD_TO_CARD" }],
    ["excluded-provider", { provider: null }],
    ["settled-locally", { paymentSettlementStatus: "SETTLED" }],
    ["settled", { checkoutSettled: true }],
    ["order-exists", { hasOrder: true }],
    ["receipt-pending", { hasPendingReviewPayment: true }],
    ["reconciliation", { reconciliationOpen: true }],
    ["competing-success", { competingSuccess: true }],
    ["expired", { checkoutExpired: true }],
    ["suppressed", { suppressedAt: new Date() }],
    ["too-early", { failedAt: new Date(NOW.getTime() - 5 * MIN) }],
    ["max-per-payment", { existingRetryCount: 1 }],
    ["max-per-checkout-day", { checkoutRetryCountToday: 2 }],
  ];
  it.each(cases)("excludes with reason %s", (reason, overrides) => {
    expect(evaluateFailedPaymentEligibility(failed(overrides), cfg, NOW)).toEqual({ eligible: false, reason });
  });
  it("recognizes exactly the online retry providers", () => {
    for (const p of ["ZARINPAL", "NOWPAYMENTS", "TELEGRAM_STARS", "AGHAYEPARDAKHT", "PLISIO", "CUSTOM"]) {
      expect(isRetryEligibleProvider(p)).toBe(true);
      expect(PAYMENT_RETRY_PROVIDERS).toContain(p);
    }
    expect(isRetryEligibleProvider("CARD_TO_CARD")).toBe(false);
    expect(isRetryEligibleProvider(null)).toBe(false);
  });
});

describe("dedupe keys", () => {
  it("abandoned key is per checkout + stage", () => {
    expect(checkoutAbandonedDedupeKey("co1", 1)).toBe("checkout:co1:abandoned:v1:1");
    expect(checkoutAbandonedDedupeKey("co1", 1)).not.toBe(checkoutAbandonedDedupeKey("co1", 2));
  });
  it("payment retry key is per payment", () => {
    expect(paymentRetryDedupeKey("p1")).toBe("payment:p1:retry:v1");
    expect(paymentRetryDedupeKey("p1")).not.toBe(paymentRetryDedupeKey("p2"));
  });
});
