import { buildStarsSubscriptionInvoice, parseStarsPayload } from "@zedbot/payments";
import {
  buildStarsSubscriptionPayload,
  generateStarsSubscriptionPayloadId,
  isValidStarsSubscriptionAmount,
  parseStarsSubscriptionPayload,
  STARS_SUBSCRIPTION_PAYLOAD_PREFIX,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// Telegram Stars subscription — PROTOCOL tests (Phase 2, pure/no DB). Assert the
// official Bot API constraints and the strict payload separation from one-time
// payments.
// =============================================================================

describe("stars subscription invoice protocol", () => {
  const base = {
    title: "اشتراک ماهانه",
    description: "تمدید خودکار ماهانه",
    payload: buildStarsSubscriptionPayload(generateStarsSubscriptionPayloadId()),
  };

  it("builds a createInvoiceLink-shaped invoice with XTR + one price", () => {
    const r = buildStarsSubscriptionInvoice({ ...base, starsAmount: 150 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.currency).toBe("XTR");
      expect(r.params.subscriptionPeriod).toBe(2592000);
      expect(r.params.prices).toHaveLength(1);
      expect(r.params.prices[0].amount).toBe(150);
    }
  });

  it("uses the ONLY supported period (2592000)", () => {
    expect(STARS_SUBSCRIPTION_PERIOD_SECONDS).toBe(2592000);
  });

  it("rejects an amount below 1", () => {
    expect(buildStarsSubscriptionInvoice({ ...base, starsAmount: 0 }).ok).toBe(false);
    expect(isValidStarsSubscriptionAmount(0)).toBe(false);
  });

  it("rejects an amount above 10000", () => {
    expect(buildStarsSubscriptionInvoice({ ...base, starsAmount: 10001 }).ok).toBe(false);
    expect(isValidStarsSubscriptionAmount(10001)).toBe(false);
  });

  it("accepts the amount bounds", () => {
    expect(isValidStarsSubscriptionAmount(1)).toBe(true);
    expect(isValidStarsSubscriptionAmount(10000)).toBe(true);
    expect(isValidStarsSubscriptionAmount(1.5)).toBe(false);
  });

  it("rejects a non-subscription payload", () => {
    const r = buildStarsSubscriptionInvoice({ ...base, payload: "zedbot:pay:abc", starsAmount: 100 });
    expect(r.ok).toBe(false);
  });
});

describe("stars subscription payload separation", () => {
  it("round-trips the subscription payload", () => {
    const id = generateStarsSubscriptionPayloadId();
    const payload = buildStarsSubscriptionPayload(id);
    expect(payload.startsWith(STARS_SUBSCRIPTION_PAYLOAD_PREFIX)).toBe(true);
    expect(parseStarsSubscriptionPayload(payload)).toBe(id);
  });

  it("stays well under Telegram's 128-byte payload limit", () => {
    const payload = buildStarsSubscriptionPayload(generateStarsSubscriptionPayloadId());
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(128);
  });

  it("the subscription parser rejects a one-time (zedbot:pay:) payload", () => {
    expect(parseStarsSubscriptionPayload("zedbot:pay:some-payment-id")).toBeNull();
  });

  it("the subscription parser rejects foreign data", () => {
    expect(parseStarsSubscriptionPayload("random")).toBeNull();
    expect(parseStarsSubscriptionPayload("zedbot:sub:")).toBeNull();
    expect(parseStarsSubscriptionPayload("zedbot:sub:!!bad!!")).toBeNull();
  });

  it("the one-time parser is unchanged and rejects a subscription payload", () => {
    expect(parseStarsPayload("zedbot:pay:pmt-123")).toBe("pmt-123");
    expect(parseStarsPayload(buildStarsSubscriptionPayload("abcd1234abcd1234"))).toBeNull();
  });
});
