import {
  closeReferralPayoutWindow,
  isWithinReferralPayoutWindows,
  openReferralPayoutWindow,
  parseReferralPayoutWindows,
  parseReferralPayoutWindowsStrict,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// §2 — payout-window parsing must FAIL CLOSED. `to === null` is the only open
// representation; any malformed / reversed interval, a second open window, or
// corrupt JSON must never resolve to "everything is eligible". These are pure
// (no DB / clock), so they run everywhere.
// =============================================================================

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";
const T3 = "2026-04-01T00:00:00.000Z";
const ms = (iso: string): number => Date.parse(iso);

describe("referral payout windows — strict, fail-closed parsing", () => {
  it("a blank / unset value is VALID and empty (payouts never configured)", () => {
    for (const raw of [null, undefined, "", "   "]) {
      const p = parseReferralPayoutWindowsStrict(raw);
      expect(p).toEqual({ windows: [], valid: true, issues: [] });
    }
  });

  it("corrupt JSON → no windows + integrity warning (fail closed)", () => {
    const p = parseReferralPayoutWindowsStrict("{not json");
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("corrupt-json");
  });

  it("a non-array JSON value → no windows + integrity warning", () => {
    const p = parseReferralPayoutWindowsStrict(JSON.stringify({ from: T0, to: null }));
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("not-an-array");
  });

  it("an invalid `from` invalidates the window (dropped, set flagged)", () => {
    const p = parseReferralPayoutWindowsStrict(JSON.stringify([{ from: "not-a-date", to: null }]));
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("invalid-from");
  });

  it("a NON-NULL malformed `to` NEVER becomes an open window (the P2 bug)", () => {
    const p = parseReferralPayoutWindowsStrict(JSON.stringify([{ from: T0, to: "garbage" }]));
    // The malformed interval is dropped — NOT reclassified as open.
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("malformed-to");
    // And nothing later than `from` is eligible.
    expect(isWithinReferralPayoutWindows(ms(T3), p.windows)).toBe(false);
  });

  it("a reversed interval (to < from) invalidates the window", () => {
    const p = parseReferralPayoutWindowsStrict(JSON.stringify([{ from: T2, to: T1 }]));
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("reversed-interval");
  });

  it("a zero-length interval (to == from) invalidates the window", () => {
    const p = parseReferralPayoutWindowsStrict(JSON.stringify([{ from: T1, to: T1 }]));
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("reversed-interval");
  });

  it("TWO open windows is a structural violation → rejected entirely (fail closed)", () => {
    const p = parseReferralPayoutWindowsStrict(
      JSON.stringify([
        { from: T0, to: null },
        { from: T2, to: null },
      ]),
    );
    expect(p.windows).toEqual([]);
    expect(p.valid).toBe(false);
    expect(p.issues).toContain("multiple-open-windows");
  });

  it("overlapping valid windows are safely NORMALIZED (merged into their union)", () => {
    const p = parseReferralPayoutWindowsStrict(
      JSON.stringify([
        { from: T0, to: T2 },
        { from: T1, to: T3 }, // overlaps [T0,T2]
      ]),
    );
    expect(p.issues).toContain("overlapping-windows");
    expect(p.windows).toHaveLength(1);
    expect(ms(p.windows[0].from)).toBe(ms(T0));
    expect(ms(p.windows[0].to ?? "")).toBe(ms(T3));
    // A point inside the merged union is eligible; a point before is not.
    expect(isWithinReferralPayoutWindows(ms(T2), p.windows)).toBe(true);
    expect(isWithinReferralPayoutWindows(ms("2025-12-01T00:00:00.000Z"), p.windows)).toBe(false);
  });

  it("a malformed entry is dropped but the trustworthy windows still work", () => {
    const p = parseReferralPayoutWindowsStrict(
      JSON.stringify([
        { from: T0, to: T1 }, // good, closed
        { from: T2, to: "garbage" }, // malformed → dropped
      ]),
    );
    expect(p.valid).toBe(false); // owner is warned
    expect(p.windows).toHaveLength(1);
    // In the good closed window:
    expect(isWithinReferralPayoutWindows(ms("2026-01-15T00:00:00.000Z"), p.windows)).toBe(true);
    // In the dropped (malformed) region: NOT eligible.
    expect(isWithinReferralPayoutWindows(ms(T3), p.windows)).toBe(false);
  });

  it("a well-formed closed + open pair parses valid and gates correctly", () => {
    const p = parseReferralPayoutWindowsStrict(
      JSON.stringify([
        { from: T0, to: T1 },
        { from: T2, to: null },
      ]),
    );
    expect(p.valid).toBe(true);
    expect(p.issues).toEqual([]);
    expect(isWithinReferralPayoutWindows(ms("2026-01-10T00:00:00.000Z"), p.windows)).toBe(true); // in closed
    expect(isWithinReferralPayoutWindows(ms(T1) + 60_000, p.windows)).toBe(false); // in the pause gap
    expect(isWithinReferralPayoutWindows(ms(T3), p.windows)).toBe(true); // in open window
  });

  it("isWithinReferralPayoutWindows fails closed on a malformed closing bound", () => {
    // Defence-in-depth: even if a malformed `to` reached the eligibility check, it
    // must be skipped, never treated as open.
    expect(isWithinReferralPayoutWindows(ms(T3), [{ from: T0, to: "garbage" }])).toBe(false);
    expect(isWithinReferralPayoutWindows(ms(T3), [])).toBe(false);
  });

  it("the compatibility wrapper returns the fail-closed subset", () => {
    // Corrupt store → [] (never an open window synthesised from garbage).
    expect(parseReferralPayoutWindows("{bad")).toEqual([]);
    expect(parseReferralPayoutWindows(JSON.stringify([{ from: T0, to: "x" }]))).toEqual([]);
  });

  it("open/close helpers round-trip through the strict parser and stay valid", () => {
    let w = openReferralPayoutWindow([], T0);
    expect(w).toEqual([{ from: T0, to: null }]);
    // opening again while one is open is idempotent (no second open window)
    w = openReferralPayoutWindow(w, T1);
    expect(w).toEqual([{ from: T0, to: null }]);
    w = closeReferralPayoutWindow(w, T2);
    expect(w).toEqual([{ from: T0, to: T2 }]);
    w = openReferralPayoutWindow(w, T3);
    const p = parseReferralPayoutWindowsStrict(JSON.stringify(w));
    expect(p.valid).toBe(true);
    expect(p.windows).toHaveLength(2);
  });
});
