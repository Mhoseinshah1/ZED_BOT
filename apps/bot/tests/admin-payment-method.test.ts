import { prisma, type CheckoutSession } from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, describe, expect, it } from "vitest";

// encryptSecret/decryptSecret read APP_SECRET at call time.
process.env.APP_SECRET ??= "phase21-test-secret-phase21-test-secret";

import {
  createCardAccount,
  createCardGatewayIfMissing,
  maskCardNumber,
  normalizeCardNumber,
  parseDisplayOrder,
  parseLimitInput,
  setGatewayInstruction,
  setGatewayLimit,
  toggleCardAccount,
  toggleGatewayEnabled,
} from "../src/services/admin-payment-method.service.js";
import { getAvailablePaymentMethods } from "../src/services/payment-method.service.js";

// =============================================================================
// Admin card-to-card configuration integration tests (Phase 21). Same DB
// requirements as the other suites (docs/testing.md): DATABASE_URL must
// point at a migrated, DISPOSABLE PostgreSQL; without it the suite skips.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const fakeCheckout = (finalPriceToman: number): CheckoutSession =>
  ({ finalPriceToman }) as CheckoutSession;

describe.runIf(hasDb)("admin card-to-card configuration", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("pure helpers: card normalization, masking, limit/order parsing", () => {
    expect(normalizeCardNumber("6037-9911 2233 4455")).toBe("6037991122334455");
    expect(normalizeCardNumber("۶۰۳۷۹۹۱۱۲۲۳۳۴۴۵۵")).toBe("6037991122334455");
    expect(normalizeCardNumber("123")).toBeNull();
    expect(normalizeCardNumber("60379911223344556")).toBeNull();
    const masked = maskCardNumber("6037991122334455");
    expect(masked).toBe("6037 99** **** 4455");
    expect(masked).not.toContain("1122");
    expect(parseLimitInput("0")).toEqual({ ok: true, value: null });
    expect(parseLimitInput("۵۰۰۰۰")).toEqual({ ok: true, value: 50_000 });
    expect(parseLimitInput("-5").ok).toBe(false);
    expect(parseLimitInput("abc").ok).toBe(false);
    expect(parseDisplayOrder("")).toBe(0);
    expect(parseDisplayOrder("۱۲")).toBe(12);
    expect(parseDisplayOrder("10000")).toBeNull();
  });

  it("creates the gateway once, configures it, manages cards, and feeds checkout", async () => {
    // A parallel-safe baseline: other suites never create CARD_TO_CARD rows.
    await prisma.cardToCardAccount.deleteMany();
    await prisma.paymentGateway.deleteMany({ where: { type: "CARD_TO_CARD" } });

    const first = await createCardGatewayIfMissing();
    expect(first.created).toBe(true);
    const second = await createCardGatewayIfMissing();
    expect(second.created).toBe(false);
    expect(second.gateway.id).toBe(first.gateway.id);
    expect(await prisma.paymentGateway.count({ where: { type: "CARD_TO_CARD" } })).toBe(1);
    const gateway = first.gateway;
    expect(gateway.isEnabled).toBe(true);
    expect(gateway.isHidden).toBe(false);

    // Limits: min > max rejected; 0 clears.
    expect((await setGatewayLimit(gateway.id, "minAmountToman", 10_000)).ok).toBe(true);
    expect((await setGatewayLimit(gateway.id, "maxAmountToman", 5_000)).ok).toBe(false);
    expect((await setGatewayLimit(gateway.id, "maxAmountToman", 900_000)).ok).toBe(true);
    expect((await setGatewayInstruction(gateway.id, "فقط از کارت خودتان واریز کنید.")).ok).toBe(true);

    // Card account: stored ENCRYPTED, decrypts back, invalid input rejected.
    const badCard = await createCardAccount({
      gatewayId: gateway.id,
      cardNumber: "123",
      ownerName: "علی رضایی",
      displayOrder: 0,
    });
    expect(badCard.ok).toBe(false);
    const created = await createCardAccount({
      gatewayId: gateway.id,
      cardNumber: "6037991122334455",
      ownerName: "علی رضایی",
      displayOrder: 1,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.account.cardNumberEncrypted).not.toContain("6037991122334455");
      expect(decryptSecret(created.account.cardNumberEncrypted)).toBe("6037991122334455");
      expect(created.account.isActive).toBe(true);
    }

    // Checkout selection: visible with an active card + amount in range...
    const user = await prisma.user.create({ data: { telegramId: runTag } });
    const visible = await getAvailablePaymentMethods(user, fakeCheckout(50_000));
    expect(visible.some((g) => g.id === gateway.id)).toBe(true);
    // ...hidden below min / above max...
    expect(
      (await getAvailablePaymentMethods(user, fakeCheckout(5_000))).some((g) => g.id === gateway.id),
    ).toBe(false);
    expect(
      (await getAvailablePaymentMethods(user, fakeCheckout(1_000_000))).some((g) => g.id === gateway.id),
    ).toBe(false);

    // ...hidden when the ONLY card is deactivated (Phase 21 filter)...
    if (created.ok) {
      const toggled = await toggleCardAccount(created.account.id);
      expect(toggled?.isActive).toBe(false);
      expect(
        (await getAvailablePaymentMethods(user, fakeCheckout(50_000))).some((g) => g.id === gateway.id),
      ).toBe(false);
      // ...and visible again after re-activation.
      expect((await toggleCardAccount(created.account.id))?.isActive).toBe(true);
      expect(
        (await getAvailablePaymentMethods(user, fakeCheckout(50_000))).some((g) => g.id === gateway.id),
      ).toBe(true);
    }

    // ...hidden when the gateway itself is disabled.
    expect((await toggleGatewayEnabled(gateway.id))?.isEnabled).toBe(false);
    expect(
      (await getAvailablePaymentMethods(user, fakeCheckout(50_000))).some((g) => g.id === gateway.id),
    ).toBe(false);
    expect((await toggleGatewayEnabled(gateway.id))?.isEnabled).toBe(true);

    // Admin configuration created NO payment-side rows.
    expect(await prisma.payment.count({ where: { gatewayId: gateway.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe.skipIf(hasDb)("admin card-to-card configuration (skipped)", () => {
  it("card-to-card admin integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
