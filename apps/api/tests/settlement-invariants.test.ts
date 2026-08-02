import { settlementPayloadFingerprint, settleWalletOrder, type WalletSettlementArgs } from "@zedbot/service-renewal";
import { describe, expect, it, vi } from "vitest";

const valid = (): WalletSettlementArgs => ({
  userId: "user-1",
  orderType: "SERVICE_RENEWAL",
  productId: "product-1",
  serviceId: "service-1",
  snapshot: {
    originalPriceToman: 100_000,
    discountAmountToman: 10_000,
    finalPriceToman: 90_000,
  },
  originalPriceToman: 100_000,
  discountAmountToman: 10_000,
  finalPriceToman: 90_000,
  discountCodeId: "discount-1",
  idempotencyKey: "financial-invariant-test-key",
  isWalletEnabled: vi.fn(async () => true),
});

describe("settlement financial invariants", () => {
  it("pins the payload fingerprint produced by the escaped NUL separator", () => {
    const input = valid();
    expect(settlementPayloadFingerprint(input)).toBe(
      "yy_27xgce3D2uRMkIO7fkoHr0JP2yVwMhAmwH8IqPzk",
    );
  });

  it.each([
    ["negative", { finalPriceToman: -1 }],
    ["zero", { finalPriceToman: 0 }],
    ["decimal", { finalPriceToman: 89_999.5 }],
    ["overflow", { originalPriceToman: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative discount", { discountAmountToman: -1 }],
    ["discount exceeds original", { discountAmountToman: 100_001 }],
    ["unbalanced total", { finalPriceToman: 89_999 }],
  ])("rejects %s monetary input before feature callbacks", async (_name, patch) => {
    const input = { ...valid(), ...patch };
    const result = await settleWalletOrder(input);
    expect(result).toEqual({ ok: false, code: "INVALID_FINANCIAL_INPUT" });
    expect(input.isWalletEnabled).not.toHaveBeenCalled();
  });

  it.each(["originalPriceToman", "discountAmountToman", "finalPriceToman"])(
    "rejects a snapshot with an inconsistent %s",
    async (field) => {
      const input = valid();
      input.snapshot = { ...input.snapshot, [field]: 1 };
      await expect(settleWalletOrder(input)).resolves.toEqual({
        ok: false,
        code: "INVALID_FINANCIAL_INPUT",
      });
      expect(input.isWalletEnabled).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed snapshot money", async () => {
    const input = valid();
    input.snapshot = { ...input.snapshot, finalPriceToman: "90000" };
    await expect(settleWalletOrder(input)).resolves.toEqual({
      ok: false,
      code: "INVALID_FINANCIAL_INPUT",
    });
  });
});
