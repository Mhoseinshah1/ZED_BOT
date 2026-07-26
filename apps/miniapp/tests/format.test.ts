import { describe, expect, it } from "vitest";

import {
  daysUntil,
  displayName,
  formatBytes,
  formatDate,
  formatNumber,
  formatSignedToman,
  formatToman,
  toPersianDigits,
  usagePercent,
} from "../src/format";

// =============================================================================
// Display formatting (F01-F10).
//
// These functions run on data that arrived over the network, inside components
// that have no error boundary. A formatter that throws on a malformed date
// takes the whole screen down, so every one of them is asserted against garbage
// as well as against good input.
// =============================================================================

describe("mini app formatting", () => {
  it("F01 renders Persian digits and thousands separators", () => {
    expect(toPersianDigits("2024")).toBe("۲۰۲۴");
    expect(formatNumber(1234567)).toBe("۱٬۲۳۴٬۵۶۷");
    expect(formatToman(250000)).toBe("۲۵۰٬۰۰۰ تومان");
  });

  it("F02 survives non-finite and negative numbers", () => {
    expect(formatNumber(Number.NaN)).toBe("۰");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("۰");
    expect(formatNumber(-1500)).toContain("۱٬۵۰۰");
  });

  it("F03 signs wallet amounts so a debit reads as one", () => {
    expect(formatSignedToman(5000).startsWith("+")).toBe(true);
    expect(formatSignedToman(-5000).startsWith("+")).toBe(false);
    expect(formatSignedToman(-5000)).toContain("۵٬۰۰۰");
  });

  it("F04 formats byte volumes without going through a double", () => {
    expect(formatBytes("0")).toBe("۰ بایت");
    expect(formatBytes((50n * 1024n ** 3n).toString())).toBe("۵۰ گیگابایت");
    expect(formatBytes((1536n * 1024n ** 2n).toString())).toBe("۱٫۵ گیگابایت");
  });

  it("F05 keeps a volume above 2^53 exact", () => {
    // 2^53 + 1 is the smallest integer a double cannot represent. Multiplied
    // into the petabyte range it stays exact here because the UNIT is chosen by
    // integer division on the BigInt - only the last, already-rounded display
    // step touches a double.
    const huge = (9_007_199_254_740_993n * 1024n).toString();
    expect(formatBytes(huge)).toContain("پتابایت");
    expect(formatBytes(huge)).not.toBe("—");
    // A plain `Number()` round-trip would have lost the low bits before the
    // unit was even chosen.
    expect(BigInt(huge)).toBe(9_223_372_036_854_776_832n);
  });

  it("F06 reports malformed byte strings instead of throwing", () => {
    for (const bad of ["", "abc", "1.5", "-1", "1e10", "٣"]) {
      expect(formatBytes(bad), bad).toBe("—");
    }
  });

  it("F07 clamps usage into a drawable range", () => {
    expect(usagePercent("0", "100")).toBe(0);
    expect(usagePercent("50", "100")).toBe(50);
    // More used than bought is possible when a panel reports late.
    expect(usagePercent("300", "100")).toBe(100);
    // An unlimited plan has no percentage to draw.
    expect(usagePercent("50", "0")).toBe(0);
    expect(usagePercent("x", "100")).toBe(0);
  });

  it("F08 formats dates and refuses malformed ones", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    const rendered = formatDate("2026-03-21T00:00:00.000Z");
    expect(rendered).not.toBe("—");
    // Persian calendar, Persian digits - never a Latin-numeral Gregorian date
    // dropped into an RTL layout.
    expect(rendered).toMatch(/[۰-۹]/);
  });

  it("F09 counts days to expiry with a fixed clock", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(daysUntil("2026-01-08T00:00:00.000Z", now)).toBe(7);
    expect(daysUntil("2025-12-30T00:00:00.000Z", now)).toBe(-2);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("nonsense", now)).toBeNull();
  });

  it("F10 falls back through the name fields it actually has", () => {
    expect(displayName({ firstName: "Ali", lastName: "R", username: "ali" })).toBe("Ali R");
    expect(displayName({ firstName: "Ali", lastName: null, username: "ali" })).toBe("Ali");
    expect(displayName({ firstName: null, lastName: null, username: "ali" })).toBe("@ali");
    expect(displayName({ firstName: "  ", lastName: null, username: null })).toBe("کاربر");
  });
});
