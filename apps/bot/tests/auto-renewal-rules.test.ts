import {
  AUTO_RENEWAL_JOB_NAMES,
  DEFAULT_WALLET_AUTO_RENEWAL_CONFIG,
  autoRenewalExecuteJobId,
  autoRenewalIdempotencyKey,
  autoRenewalUpcomingDedupeKey,
  buildAutoRenewalCycleFingerprint,
  isAutoRenewalDue,
  isValidCeiling,
  isWithinAutoRenewalGrace,
  parseRetryIntervals,
  resolveAutoRenewalCharge,
  resolveAutoRenewalExpectedChargeAt,
  resolveAutoRenewalNoticeSchedule,
  resolveAutoRenewalPrechargeNoticeAt,
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

// =============================================================================
// Corrective Phase — pre-charge notice timing (Part A). Pure + deterministic:
// expectedChargeAt = expiresAt − chargeLead; prechargeNoticeAt = expectedChargeAt
// − noticeMinutes; the schedule classifier drives scheduled/catch-up/missed/disabled.
// =============================================================================

describe("pre-charge expected charge instant", () => {
  it("A1: expectedChargeAt = expiresAt − chargeLeadMinutes", () => {
    const expiresAtEpoch = 10 * DAY;
    expect(resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch, chargeLeadMinutes: 180 })).toBe(
      expiresAtEpoch - 180 * 60_000,
    );
  });
  it("A2: is null for a non-finite / unlimited expiry", () => {
    expect(resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: null, chargeLeadMinutes: 180 })).toBeNull();
    expect(
      resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: Number.POSITIVE_INFINITY, chargeLeadMinutes: 180 }),
    ).toBeNull();
  });
});

describe("pre-charge notice instant", () => {
  it("A3: prechargeNoticeAt = expectedChargeAt − noticeMinutes", () => {
    const expiresAtEpoch = 10 * DAY;
    const got = resolveAutoRenewalPrechargeNoticeAt({ expiresAtEpoch, chargeLeadMinutes: 180, prechargeNoticeMinutes: 1440 });
    expect(got).toBe(expiresAtEpoch - 180 * 60_000 - 1440 * 60_000);
  });
  it("A4: is null when the advance notice is disabled (0) or expiry non-finite", () => {
    const expiresAtEpoch = 10 * DAY;
    expect(
      resolveAutoRenewalPrechargeNoticeAt({ expiresAtEpoch, chargeLeadMinutes: 180, prechargeNoticeMinutes: 0 }),
    ).toBeNull();
    expect(
      resolveAutoRenewalPrechargeNoticeAt({ expiresAtEpoch: null, chargeLeadMinutes: 180, prechargeNoticeMinutes: 1440 }),
    ).toBeNull();
  });
});

describe("pre-charge notice schedule classifier", () => {
  const expiresAtEpoch = 100 * DAY;
  const chargeLeadMinutes = 180; // 3h
  const prechargeNoticeMinutes = 1440; // 24h
  const expectedChargeAt = expiresAtEpoch - chargeLeadMinutes * 60_000;
  const prechargeNoticeAt = expectedChargeAt - prechargeNoticeMinutes * 60_000;

  it("A5: scheduled — notice still in the future", () => {
    const nowEpoch = prechargeNoticeAt - HOUR;
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch });
    expect(s.kind).toBe("scheduled");
    expect(s.expectedChargeAtEpoch).toBe(expectedChargeAt);
    expect(s.scheduledForEpoch).toBe(prechargeNoticeAt);
    expect(s.availableUntilEpoch).toBe(expectedChargeAt);
  });

  it("A6: catch-up — notice window open but charge still ahead → deliver now", () => {
    const nowEpoch = prechargeNoticeAt + HOUR;
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch });
    expect(s.kind).toBe("catch-up");
    expect(s.scheduledForEpoch).toBe(nowEpoch);
    expect(s.availableUntilEpoch).toBe(expectedChargeAt);
  });

  it("A7: missed — charge instant already reached → no upcoming notice", () => {
    const s = resolveAutoRenewalNoticeSchedule({
      expiresAtEpoch,
      chargeLeadMinutes,
      prechargeNoticeMinutes,
      nowEpoch: expectedChargeAt,
    });
    expect(s.kind).toBe("missed");
    expect(s.scheduledForEpoch).toBeNull();
    expect(s.expectedChargeAtEpoch).toBe(expectedChargeAt);
  });

  it("A8: missed — charge instant in the past", () => {
    const s = resolveAutoRenewalNoticeSchedule({
      expiresAtEpoch,
      chargeLeadMinutes,
      prechargeNoticeMinutes,
      nowEpoch: expectedChargeAt + 5 * HOUR,
    });
    expect(s.kind).toBe("missed");
  });

  it("A9: disabled — noticeMinutes 0 (charge unaffected, expectedChargeAt still set)", () => {
    const s = resolveAutoRenewalNoticeSchedule({
      expiresAtEpoch,
      chargeLeadMinutes,
      prechargeNoticeMinutes: 0,
      nowEpoch: prechargeNoticeAt - HOUR,
    });
    expect(s.kind).toBe("disabled");
    expect(s.scheduledForEpoch).toBeNull();
    expect(s.expectedChargeAtEpoch).toBe(expectedChargeAt);
  });

  it("A10: disabled — no finite expiry (all epochs null)", () => {
    const s = resolveAutoRenewalNoticeSchedule({
      expiresAtEpoch: null,
      chargeLeadMinutes,
      prechargeNoticeMinutes,
      nowEpoch: 0,
    });
    expect(s.kind).toBe("disabled");
    expect(s.expectedChargeAtEpoch).toBeNull();
    expect(s.scheduledForEpoch).toBeNull();
    expect(s.availableUntilEpoch).toBeNull();
  });

  it("A11: availableUntil never exceeds expectedChargeAt (notice EXPIRES, never sent post-charge)", () => {
    for (const nowEpoch of [prechargeNoticeAt - HOUR, prechargeNoticeAt + HOUR]) {
      const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch });
      expect(s.availableUntilEpoch).toBe(expectedChargeAt);
      expect(s.scheduledForEpoch! <= s.availableUntilEpoch!).toBe(true);
    }
  });
});

describe("pre-charge upcoming dedupe key", () => {
  it("A12: is cycle-scoped and version-suffixed (distinct from the settlement key)", () => {
    expect(autoRenewalUpcomingDedupeKey("m1", "cyc1")).toBe("wallet-auto-renewal:m1:cyc1:upcoming:v1");
    expect(autoRenewalUpcomingDedupeKey("m1", "cyc1")).not.toBe(autoRenewalIdempotencyKey("m1", "cyc1"));
  });
  it("A13: a different cycle → a different upcoming key (a stale cycle can never re-notify)", () => {
    expect(autoRenewalUpcomingDedupeKey("m1", "cycA")).not.toBe(autoRenewalUpcomingDedupeKey("m1", "cycB"));
  });
});

describe("pre-charge timing edge cases", () => {
  const expiresAtEpoch = 100 * DAY;
  const chargeLeadMinutes = 180;
  const prechargeNoticeMinutes = 1440;
  const expectedChargeAt = expiresAtEpoch - chargeLeadMinutes * 60_000;
  const prechargeNoticeAt = expectedChargeAt - prechargeNoticeMinutes * 60_000;

  it("A14: a 0 charge-lead makes the expected charge the expiry itself", () => {
    expect(resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch, chargeLeadMinutes: 0 })).toBe(expiresAtEpoch);
  });

  it("A15: exactly at prechargeNoticeAt is a catch-up (the notice window has just opened)", () => {
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch: prechargeNoticeAt });
    expect(s.kind).toBe("catch-up");
  });

  it("A16: one ms before prechargeNoticeAt is still scheduled", () => {
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch: prechargeNoticeAt - 1 });
    expect(s.kind).toBe("scheduled");
  });

  it("A17: exactly at expectedChargeAt is missed (the charge window has arrived)", () => {
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes, nowEpoch: expectedChargeAt });
    expect(s.kind).toBe("missed");
  });

  it("A18: a fractional expiry epoch is truncated deterministically", () => {
    expect(resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: expiresAtEpoch + 0.9, chargeLeadMinutes: 0 })).toBe(expiresAtEpoch);
  });

  it("A19: a negative noticeMinutes is treated as disabled", () => {
    const s = resolveAutoRenewalNoticeSchedule({ expiresAtEpoch, chargeLeadMinutes, prechargeNoticeMinutes: -5, nowEpoch: prechargeNoticeAt });
    expect(s.kind).toBe("disabled");
  });
});
