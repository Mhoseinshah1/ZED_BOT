import { describe, expect, it } from "vitest";

import {
  DEFAULT_WINBACK_CONFIG,
  buildCustomerLapseCycleFingerprint,
  buildCustomerWinbackDedupeKey,
  classifyPaidServiceForWinback,
  evaluateCustomerWinbackEligibility,
  parseWinbackConfig,
  resolveCustomerLifecycleSegment,
  selectWinbackStage,
  type CustomerLifecycleSnapshot,
  type PaidServiceView,
  type WinbackConfig,
} from "@zedbot/shared";

// =============================================================================
// Customer win-back PURE resolver tests (Phase 3, no DB): config parsing +
// validation, the paid-service disposition classifier (effective-end +
// freshness), the lifecycle segment resolver, the eligibility evaluator, the
// catch-up stage selection and the lapse-cycle fingerprint / dedupe key.
// =============================================================================

const NOW = new Date("2026-07-18T12:00:00.000Z");
const DAY = 24 * 3_600_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function cfg(overrides: Partial<WinbackConfig> = {}): WinbackConfig {
  return { ...DEFAULT_WINBACK_CONFIG, ...overrides };
}

/** A paying, cleanly-lapsed customer snapshot (eligible by default). */
function snapshot(overrides: Partial<CustomerLifecycleSnapshot> = {}): CustomerLifecycleSnapshot {
  return {
    userStatus: "ACTIVE",
    userGroup: "F",
    cronNotificationsEnabled: true,
    marketingMessagesEnabled: true,
    completedPaidServiceOrderCount: 1,
    lifetimePaidServiceSpendToman: 120000,
    hasUsablePaidService: false,
    hasUncertainPaidService: false,
    hasProvisioningService: false,
    latestPaidServiceEffectiveEndAt: daysAgo(40),
    latestCompletedPaidServiceOrderId: "order-1",
    hasActiveTrial: false,
    hasTrialProvisioning: false,
    hasResumableCheckout: false,
    hasPendingReceiptReview: false,
    hasOpenFinancialReconciliation: false,
    hasUnresolvedProvisioningOrder: false,
    winbackSnoozedUntil: null,
    existingCycleNotificationCount: 0,
    sentStageDaysThisCycle: [],
    ...overrides,
  };
}

function paidService(overrides: Partial<PaidServiceView> = {}): PaidServiceView {
  return {
    status: "EXPIRED",
    source: "PAID",
    expiresAt: daysAgo(40),
    deletedAt: null,
    lastSubscriptionUpdateAt: daysAgo(1),
    panelBacked: true,
    financiallySettled: true,
    ...overrides,
  };
}

// --- config parsing ----------------------------------------------------------

describe("winback config parsing", () => {
  it("accepts a valid config and sorts stage days", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [90, 30, 60] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed.stageDays).toEqual([30, 60, 90]);
  });

  it("rejects duplicate stage days -> fallback", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [30, 30] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects a stage day below the 7-day floor", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [3, 60] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects a stage day above the 730-day ceiling", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [30, 800] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects more than 6 stages", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [7, 14, 21, 28, 35, 42, 49] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects an empty allowed-group list", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, allowedUserGroups: [] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects an unknown group value", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, allowedUserGroups: ["F", "ZZ"] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("accepts representative groups only when explicitly configured", () => {
    const parsed = parseWinbackConfig(
      JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, allowedUserGroups: ["F", "N", "N2"] }),
      DEFAULT_WINBACK_CONFIG,
    );
    expect(parsed.allowedUserGroups.sort()).toEqual(["F", "N", "N2"]);
  });

  it("defaults to only group F", () => {
    expect(DEFAULT_WINBACK_CONFIG.allowedUserGroups).toEqual(["F"]);
  });

  it("rejects min orders out of range", () => {
    expect(parseWinbackConfig(JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, minimumCompletedPaidOrders: 0 }), DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
    expect(parseWinbackConfig(JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, minimumCompletedPaidOrders: 101 }), DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects a negative lifetime-spend threshold", () => {
    expect(parseWinbackConfig(JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, minimumLifetimeSpendToman: -1 }), DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects snooze days out of range", () => {
    expect(parseWinbackConfig(JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, snoozeDays: 0 }), DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
    expect(parseWinbackConfig(JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, snoozeDays: 400 }), DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("rejects max-per-cycle greater than the stage count", () => {
    expect(
      parseWinbackConfig(
        JSON.stringify({ ...DEFAULT_WINBACK_CONFIG, stageDays: [30, 60], maximumNotificationsPerLapseCycle: 3 }),
        DEFAULT_WINBACK_CONFIG,
      ),
    ).toEqual(DEFAULT_WINBACK_CONFIG);
  });

  it("returns fallback on malformed JSON", () => {
    expect(parseWinbackConfig("{not json", DEFAULT_WINBACK_CONFIG)).toEqual(DEFAULT_WINBACK_CONFIG);
  });
});

// --- paid-service disposition ------------------------------------------------

describe("paid-service classification", () => {
  it("USABLE for an active service with a future expiry", () => {
    const c = classifyPaidServiceForWinback(paidService({ status: "ACTIVE", expiresAt: daysAgo(-10) }), 20, NOW);
    expect(c.disposition).toBe("USABLE");
  });

  it("USABLE (unlimited) for a null expiry", () => {
    const c = classifyPaidServiceForWinback(paidService({ status: "ACTIVE", expiresAt: null }), 20, NOW);
    expect(c.disposition).toBe("USABLE");
  });

  it("USABLE for a DISABLED service with remaining time", () => {
    const c = classifyPaidServiceForWinback(paidService({ status: "DISABLED", expiresAt: daysAgo(-5) }), 20, NOW);
    expect(c.disposition).toBe("USABLE");
  });

  it("PROVISIONING for a CREATING service", () => {
    const c = classifyPaidServiceForWinback(paidService({ status: "CREATING", expiresAt: null }), 20, NOW);
    expect(c.disposition).toBe("PROVISIONING");
  });

  it("IGNORE for a FAILED service", () => {
    const c = classifyPaidServiceForWinback(paidService({ status: "FAILED" }), 20, NOW);
    expect(c.disposition).toBe("IGNORE");
  });

  it("LAPSED for a fresh EXPIRED service, using expiresAt", () => {
    const end = daysAgo(40);
    const c = classifyPaidServiceForWinback(paidService({ status: "EXPIRED", expiresAt: end, lastSubscriptionUpdateAt: daysAgo(0.001) }), 20, NOW);
    expect(c.disposition).toBe("LAPSED");
    expect(c.effectiveEnd).toEqual(end);
  });

  it("UNCERTAIN for a stale panel-backed EXPIRED service (never guesses inactive)", () => {
    const c = classifyPaidServiceForWinback(
      paidService({ status: "EXPIRED", lastSubscriptionUpdateAt: daysAgo(1) }),
      20,
      NOW,
    );
    expect(c.disposition).toBe("UNCERTAIN");
    expect(c.needsSync).toBe(true);
  });

  it("UNCERTAIN for an active-status service whose expiry passed but state is stale", () => {
    const c = classifyPaidServiceForWinback(
      paidService({ status: "ACTIVE", expiresAt: daysAgo(2), lastSubscriptionUpdateAt: daysAgo(1) }),
      20,
      NOW,
    );
    expect(c.disposition).toBe("UNCERTAIN");
  });

  it("LAPSED for a settled DELETED service", () => {
    const c = classifyPaidServiceForWinback(
      paidService({ status: "DELETED", expiresAt: daysAgo(50), deletedAt: daysAgo(45), financiallySettled: true }),
      20,
      NOW,
    );
    expect(c.disposition).toBe("LAPSED");
  });

  it("IGNORE for an unsettled DELETED service (does not guess)", () => {
    const c = classifyPaidServiceForWinback(
      paidService({ status: "DELETED", financiallySettled: false }),
      20,
      NOW,
    );
    expect(c.disposition).toBe("IGNORE");
  });

  it("IGNORE for a non-paid (trial) service", () => {
    const c = classifyPaidServiceForWinback(paidService({ source: "FREE_TRIAL" }), 20, NOW);
    expect(c.disposition).toBe("IGNORE");
  });
});

// --- lifecycle segments ------------------------------------------------------

describe("lifecycle segment resolver", () => {
  it("INELIGIBLE_USER_STATUS for a non-active user", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ userStatus: "BLOCKED" }), cfg(), NOW)).toBe("INELIGIBLE_USER_STATUS");
  });

  it("INELIGIBLE_USER_GROUP for a disallowed group", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ userGroup: "N" }), cfg(), NOW)).toBe("INELIGIBLE_USER_GROUP");
  });

  it("NEVER_PAID for a user with no completed paid order", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ completedPaidServiceOrderCount: 0, lifetimePaidServiceSpendToman: 0 }), cfg(), NOW)).toBe("NEVER_PAID");
  });

  it("TRIAL_ONLY for a never-paid user with a live trial", () => {
    expect(
      resolveCustomerLifecycleSegment(snapshot({ completedPaidServiceOrderCount: 0, lifetimePaidServiceSpendToman: 0, hasActiveTrial: true }), cfg(), NOW),
    ).toBe("TRIAL_ONLY");
  });

  it("ACTIVE_CUSTOMER for a paying user with a usable service", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasUsablePaidService: true }), cfg(), NOW)).toBe("ACTIVE_CUSTOMER");
  });

  it("PURCHASE_IN_PROGRESS for a provisioning service", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasProvisioningService: true }), cfg(), NOW)).toBe("PURCHASE_IN_PROGRESS");
  });

  it("PURCHASE_IN_PROGRESS for a resumable checkout", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasResumableCheckout: true }), cfg(), NOW)).toBe("PURCHASE_IN_PROGRESS");
  });

  it("PURCHASE_IN_PROGRESS when a former paying customer has a live trial", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasActiveTrial: true }), cfg(), NOW)).toBe("PURCHASE_IN_PROGRESS");
  });

  it("FINANCIAL_HOLD for an open reconciliation", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasOpenFinancialReconciliation: true }), cfg(), NOW)).toBe("FINANCIAL_HOLD");
  });

  it("FINANCIAL_HOLD for a pending receipt", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasPendingReceiptReview: true }), cfg(), NOW)).toBe("FINANCIAL_HOLD");
  });

  it("SERVICE_STATE_UNCERTAIN when only an uncertain service exists", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ hasUncertainPaidService: true, latestPaidServiceEffectiveEndAt: null }), cfg(), NOW)).toBe("SERVICE_STATE_UNCERTAIN");
  });

  it("MARKETING_OPT_OUT for a paying customer who opted out", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ marketingMessagesEnabled: false }), cfg(), NOW)).toBe("MARKETING_OPT_OUT");
  });

  it("WINBACK_SNOOZED while snoozed", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ winbackSnoozedUntil: daysAgo(-5) }), cfg(), NOW)).toBe("WINBACK_SNOOZED");
  });

  it("RECENTLY_LAPSED before the first stage", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(10) }), cfg(), NOW)).toBe("RECENTLY_LAPSED");
  });

  it("LAPSED_STAGE_1 at 30-59 days", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(45) }), cfg(), NOW)).toBe("LAPSED_STAGE_1");
  });

  it("LAPSED_STAGE_3 at 90+ days", () => {
    expect(resolveCustomerLifecycleSegment(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(120) }), cfg(), NOW)).toBe("LAPSED_STAGE_3");
  });
});

// --- eligibility -------------------------------------------------------------

describe("winback eligibility", () => {
  it("eligible for a cleanly-lapsed paying customer past stage 1", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot(), cfg(), NOW);
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.stageDays).toBe(30);
    }
  });

  it("excludes never-paid", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ completedPaidServiceOrderCount: 0, lifetimePaidServiceSpendToman: 0 }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "never-paid" });
  });

  it("excludes trial-only", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ completedPaidServiceOrderCount: 0, lifetimePaidServiceSpendToman: 0, hasActiveTrial: true }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "trial-only" });
  });

  it("excludes an active service", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ hasUsablePaidService: true }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "active-service" });
  });

  it("excludes an uncertain service (defers)", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ hasUncertainPaidService: true, latestPaidServiceEffectiveEndAt: null }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "service-uncertain" });
  });

  it("excludes a resumable checkout (purchase-in-progress)", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ hasResumableCheckout: true }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "purchase-in-progress" });
  });

  it("excludes a pending receipt (financial-hold)", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ hasPendingReceiptReview: true }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "financial-hold" });
  });

  it("excludes an opted-out customer", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ marketingMessagesEnabled: false }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "marketing-opt-out" });
  });

  it("excludes a snoozed customer", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ winbackSnoozedUntil: daysAgo(-5) }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "snoozed" });
  });

  it("excludes when cron notifications are disabled", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ cronNotificationsEnabled: false }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "cron-disabled" });
  });

  it("excludes when the lifetime-spend threshold is not met", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ lifetimePaidServiceSpendToman: 5000 }), cfg({ minimumLifetimeSpendToman: 100000 }), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "never-paid" });
  });

  it("excludes when the minimum order count is not met", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ completedPaidServiceOrderCount: 1 }), cfg({ minimumCompletedPaidOrders: 2 }), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "never-paid" });
  });

  it("excludes too-early (recently lapsed)", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(10) }), cfg(), NOW);
    expect(e).toMatchObject({ eligible: false, reason: "too-early" });
  });

  it("excludes when the max-per-cycle cap is reached", () => {
    const e = evaluateCustomerWinbackEligibility(
      snapshot({ existingCycleNotificationCount: 3, sentStageDaysThisCycle: [30, 60, 90] }),
      cfg(),
      NOW,
    );
    expect(e).toMatchObject({ eligible: false, reason: "max-cycle-reached" });
  });
});

// --- stage catch-up ----------------------------------------------------------

describe("stage catch-up selection", () => {
  it("picks stage 30 on first eligibility", () => {
    expect(selectWinbackStage([30, 60, 90], 45, [])).toBe(30);
  });

  it("advances to stage 60 after stage 30 was sent", () => {
    expect(selectWinbackStage([30, 60, 90], 65, [30])).toBe(60);
  });

  it("catch-up: a 200-day-lapsed user with nothing sent gets ONLY stage 90", () => {
    expect(selectWinbackStage([30, 60, 90], 200, [])).toBe(90);
  });

  it("never backfills a lower stage after a higher one was sent", () => {
    expect(selectWinbackStage([30, 60, 90], 200, [90])).toBeNull();
  });

  it("returns null when no stage is yet due", () => {
    expect(selectWinbackStage([30, 60, 90], 10, [])).toBeNull();
  });

  it("catch-up via the full evaluator sends only the highest stage for a 200-day lapse", () => {
    const e = evaluateCustomerWinbackEligibility(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(200) }), cfg(), NOW);
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.stageDays).toBe(90);
    }
  });

  it("no-stage-due after the highest stage was already sent this cycle", () => {
    const e = evaluateCustomerWinbackEligibility(
      snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(200), existingCycleNotificationCount: 1, sentStageDaysThisCycle: [90] }),
      cfg(),
      NOW,
    );
    expect(e).toMatchObject({ eligible: false, reason: "no-stage-due" });
  });
});

// --- lapse-cycle fingerprint + dedupe ----------------------------------------

describe("lapse-cycle fingerprint + dedupe", () => {
  it("is stable for the same order + end", () => {
    const a = buildCustomerLapseCycleFingerprint(snapshot());
    const b = buildCustomerLapseCycleFingerprint(snapshot());
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("changes when the anchoring order changes (a new purchase)", () => {
    const a = buildCustomerLapseCycleFingerprint(snapshot({ latestCompletedPaidServiceOrderId: "order-1" }));
    const b = buildCustomerLapseCycleFingerprint(snapshot({ latestCompletedPaidServiceOrderId: "order-2" }));
    expect(a).not.toBe(b);
  });

  it("changes when the effective end changes (a renewal)", () => {
    const a = buildCustomerLapseCycleFingerprint(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(40) }));
    const b = buildCustomerLapseCycleFingerprint(snapshot({ latestPaidServiceEffectiveEndAt: daysAgo(10) }));
    expect(a).not.toBe(b);
  });

  it("is null when there is no lapse anchor", () => {
    expect(buildCustomerLapseCycleFingerprint(snapshot({ latestCompletedPaidServiceOrderId: null }))).toBeNull();
    expect(buildCustomerLapseCycleFingerprint(snapshot({ latestPaidServiceEffectiveEndAt: null }))).toBeNull();
  });

  it("does not contain a raw order id (hashed)", () => {
    const fp = buildCustomerLapseCycleFingerprint(snapshot({ latestCompletedPaidServiceOrderId: "SECRET-ORDER-ID-123" }));
    expect(fp).not.toContain("SECRET-ORDER-ID-123");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("builds a per-stage dedupe key from the fingerprint", () => {
    const key = buildCustomerWinbackDedupeKey("user-1", "abc123", 30);
    expect(key).toBe("user:user-1:winback:abc123:s30");
  });

  it("dedupe keys differ per stage", () => {
    expect(buildCustomerWinbackDedupeKey("u", "fp", 30)).not.toBe(buildCustomerWinbackDedupeKey("u", "fp", 60));
  });
});
