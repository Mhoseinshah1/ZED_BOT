import {
  AUTO_RENEWAL_JOB_NAMES,
  DEFAULT_WALLET_AUTO_RENEWAL_CONFIG,
  autoRenewalExecuteJobId,
  autoRenewalIdempotencyKey,
  buildAutoRenewalCycleFingerprint,
  isAutoRenewalDue,
  isValidCeiling,
  isWithinAutoRenewalGrace,
  parseRetryIntervals,
  resolveAutoRenewalCharge,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// PURE wallet auto-renewal contract tests (no DB): expiry-cycle fingerprint,
// due/grace evaluation, price-ceiling resolution, ceiling validation, retry
// interval parsing and idempotency keys. This is the single source of truth the
// scan, execute consumer, dry-run preview and tests all call.
// =============================================================================

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("expiry-cycle fingerprint", () => {
  it("is stable for the same inputs and NOT null for a finite expiry", () => {
    const a = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p1" });
    const b = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p1" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("changes when the expiry moves (a renewal extends the Service → new cycle)", () => {
    const before = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p1" });
    const after = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 5000, productId: "p1" });
    expect(before).not.toBe(after);
  });

  it("changes when the selected Product changes", () => {
    const p1 = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p1" });
    const p2 = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p2" });
    expect(p1).not.toBe(p2);
  });

  it("returns null for an unlimited (no-expiry) Service — never auto-renewed", () => {
    expect(buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: null, productId: "p1" })).toBeNull();
  });

  it("derives a stable idempotency key that varies by mandate + cycle", () => {
    const fp = buildAutoRenewalCycleFingerprint({ serviceId: "s1", expiresAtEpoch: 1000, productId: "p1" })!;
    expect(autoRenewalIdempotencyKey("m1", fp)).toBe(`wallet-auto-renew:m1:${fp}`);
    expect(autoRenewalIdempotencyKey("m1", fp)).not.toBe(autoRenewalIdempotencyKey("m2", fp));
  });
});

describe("due + grace evaluation", () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);

  it("is due when expiry is inside the charge-lead window", () => {
    expect(isAutoRenewalDue({ expiresAtEpoch: now + 2 * HOUR, nowEpoch: now, chargeLeadMinutes: 180 })).toBe(true);
  });

  it("is NOT due when expiry is beyond the charge-lead window", () => {
    expect(isAutoRenewalDue({ expiresAtEpoch: now + 10 * HOUR, nowEpoch: now, chargeLeadMinutes: 180 })).toBe(false);
  });

  it("is due (past expiry) but only within the grace window", () => {
    expect(isAutoRenewalDue({ expiresAtEpoch: now - 1 * HOUR, nowEpoch: now, chargeLeadMinutes: 180 })).toBe(true);
    expect(isWithinAutoRenewalGrace({ expiresAtEpoch: now - 12 * HOUR, nowEpoch: now, graceHours: 48 })).toBe(true);
    expect(isWithinAutoRenewalGrace({ expiresAtEpoch: now - 3 * DAY, nowEpoch: now, graceHours: 48 })).toBe(false);
  });

  it("is never due for an unlimited Service", () => {
    expect(isAutoRenewalDue({ expiresAtEpoch: null, nowEpoch: now, chargeLeadMinutes: 180 })).toBe(false);
  });
});

describe("price ceiling resolution", () => {
  it("charges the live price when at/under the ceiling", () => {
    expect(resolveAutoRenewalCharge(80_000, 100_000)).toEqual({ eligible: true, chargeToman: 80_000, reason: "ok" });
    expect(resolveAutoRenewalCharge(100_000, 100_000)).toEqual({ eligible: true, chargeToman: 100_000, reason: "ok" });
  });

  it("does NOT charge when the live price exceeds the ceiling", () => {
    expect(resolveAutoRenewalCharge(120_000, 100_000)).toEqual({
      eligible: false,
      chargeToman: 0,
      reason: "price-above-limit",
    });
  });

  it("rejects a non-positive / invalid live price", () => {
    expect(resolveAutoRenewalCharge(0, 100_000).eligible).toBe(false);
    expect(resolveAutoRenewalCharge(-1, 100_000).reason).toBe("invalid-price");
  });

  it("validates a user ceiling (in range and covering the current price)", () => {
    expect(isValidCeiling(150_000, 100_000)).toBe(true);
    expect(isValidCeiling(90_000, 100_000)).toBe(false); // below current price
    expect(isValidCeiling(500, 100)).toBe(false); // below the min ceiling
    expect(isValidCeiling(1.5, 1)).toBe(false); // not an integer
  });
});

describe("retry interval parser (sentinel fallback)", () => {
  const fb = DEFAULT_WALLET_AUTO_RENEWAL_CONFIG.insufficientRetryIntervalsMinutes;
  it("accepts a valid ascending schedule", () => {
    expect(parseRetryIntervals("[0,360,1440]", fb)).toEqual([0, 360, 1440]);
  });
  it("returns the fallback for invalid input", () => {
    expect(parseRetryIntervals("nope", fb)).toEqual(fb);
    expect(parseRetryIntervals("[]", fb)).toEqual(fb);
    expect(parseRetryIntervals("[10,5]", fb)).toEqual(fb); // not ascending
    expect(parseRetryIntervals("[5,5]", fb)).toEqual(fb); // not strictly ascending
    expect(parseRetryIntervals("[-1,5]", fb)).toEqual(fb); // negative
    expect(parseRetryIntervals([1, 2, 3, 4, 5, 6, 7], fb)).toEqual(fb); // too long
  });
});

describe("job identifiers", () => {
  it("has the four job names and a per-attempt execute job id", () => {
    expect(AUTO_RENEWAL_JOB_NAMES.EXECUTE_WALLET_AUTO_RENEWAL).toBe("EXECUTE_WALLET_AUTO_RENEWAL");
    expect(autoRenewalExecuteJobId("a1")).toBe("war-exec-a1");
  });
});
