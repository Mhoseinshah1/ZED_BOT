import {
  DEFAULT_REFERRAL_CONFIG,
  clampReferralInt,
  referralDeepLink,
  resolveReferralCommission,
  type ReferralConfig,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// PURE referral affiliate-commission contract tests (no DB): the commission
// calculator (percent of the order, floored, never over-credited; below-minimum /
// zero-percent / invalid guards), the config clamp, and the deep-link builder.
// This is the single source of truth the bot service, admin dry-run and tests call.
// =============================================================================

const cfg = (over: Partial<ReferralConfig> = {}): ReferralConfig => ({ ...DEFAULT_REFERRAL_CONFIG, ...over });

describe("resolveReferralCommission", () => {
  it("R1: credits floor(percent% of the order)", () => {
    const d = resolveReferralCommission({ orderAmountToman: 100_000, config: cfg({ commissionPercent: 10 }) });
    expect(d).toEqual({ eligible: true, commissionToman: 10_000, percent: 10, reason: "ok" });
  });

  it("R2: FLOORS the commission — never over-credits on a fractional result", () => {
    const d = resolveReferralCommission({ orderAmountToman: 12_345, config: cfg({ commissionPercent: 10 }) });
    // 1234.5 -> 1234, never 1235.
    expect(d.commissionToman).toBe(1234);
  });

  it("R3: never exceeds the configured percent of the order", () => {
    const d = resolveReferralCommission({ orderAmountToman: 500_000, config: cfg({ commissionPercent: 25 }) });
    expect(d.commissionToman).toBeLessThanOrEqual(Math.floor(500_000 * 0.25));
    expect(d.commissionToman).toBe(125_000);
  });

  it("R4: an order below the minimum earns nothing", () => {
    const d = resolveReferralCommission({ orderAmountToman: 5_000, config: cfg({ commissionPercent: 10, minPurchaseToman: 10_000 }) });
    expect(d).toMatchObject({ eligible: false, commissionToman: 0, reason: "below-minimum" });
  });

  it("R5: a zero / negative / non-integer order amount earns nothing", () => {
    expect(resolveReferralCommission({ orderAmountToman: 0, config: cfg() }).eligible).toBe(false);
    expect(resolveReferralCommission({ orderAmountToman: -1, config: cfg() }).reason).toBe("invalid-amount");
    expect(resolveReferralCommission({ orderAmountToman: 10.5, config: cfg() }).reason).toBe("invalid-amount");
  });

  it("R6: a zero percent earns nothing", () => {
    const d = resolveReferralCommission({ orderAmountToman: 100_000, config: cfg({ commissionPercent: 0 }) });
    expect(d).toMatchObject({ eligible: false, reason: "zero-percent" });
  });

  it("R7: a sub-1-Toman result earns nothing (never a 0-Toman credit)", () => {
    const d = resolveReferralCommission({ orderAmountToman: 5, config: cfg({ commissionPercent: 10 }) });
    // 0.5 -> floor 0 -> no commission.
    expect(d).toMatchObject({ eligible: false, commissionToman: 0, reason: "zero-commission" });
  });

  it("R8: snapshots the percent applied onto the decision", () => {
    expect(resolveReferralCommission({ orderAmountToman: 100_000, config: cfg({ commissionPercent: 7 }) }).percent).toBe(7);
  });
});

describe("clampReferralInt", () => {
  it("R9: returns the value when in range, else the fallback", () => {
    expect(clampReferralInt(15, 0, 100, 10)).toBe(15);
    expect(clampReferralInt(150, 0, 100, 10)).toBe(10);
    expect(clampReferralInt(-1, 0, 100, 10)).toBe(10);
    expect(clampReferralInt(10.5, 0, 100, 10)).toBe(10);
    expect(clampReferralInt("x", 0, 100, 10)).toBe(10);
  });
});

describe("referralDeepLink", () => {
  it("R10: builds a t.me start deep link from the bot username + referral code", () => {
    expect(referralDeepLink("MyBot", "12345")).toBe("https://t.me/MyBot?start=12345");
  });
});
