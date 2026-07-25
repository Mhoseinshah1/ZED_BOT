import { randomUUID } from "node:crypto";

import { prisma, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CheckoutDraft } from "../src/core/session.js";
import { preInvoiceKeyboard } from "../src/handlers/user-checkout/checkout-views.js";
import { paymentMethodsText } from "../src/handlers/user-checkout/payment-views.js";
import {
  DEFAULT_TOPUP_MAX_TOMAN,
  DEFAULT_TOPUP_MIN_TOMAN,
  isWalletPaymentEnabled,
  isWalletTopupEnabled,
  PAYMENT_PAGE_NOTICE_KEY,
  paymentPageNotice,
  SETTING_TEXT_TOO_LONG,
  setPaymentPageNotice,
  setWalletPaymentEnabled,
  setWalletTopupEnabled,
  setWalletTopupInstruction,
  setWalletTopupMaxToman,
  setWalletTopupMinToman,
  WALLET_PAYMENT_DISABLED_TEXT,
  WALLET_PAYMENT_ENABLED_KEY,
  WALLET_TOPUP_ENABLED_KEY,
  WALLET_TOPUP_INSTRUCTION_KEY,
  WALLET_TOPUP_MAX_KEY,
  WALLET_TOPUP_MIN_KEY,
  walletTopupInstruction,
} from "../src/services/payment-settings.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";
import {
  createWalletTopupCheckout,
  walletTopupLimits,
} from "../src/services/wallet-topup.service.js";
import { armServiceDraft } from "./helpers/service-checkout-fixture.js";

// =============================================================================
// Phase 22 wallet/payment settings integration tests. These mutate GLOBAL
// Setting rows, so vitest runs test files sequentially (fileParallelism:
// false) and this suite restores the defaults in afterAll. Requires the
// shared disposable PostgreSQL (docs/testing.md); skips without it.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const SETTING_KEYS = [
  WALLET_TOPUP_ENABLED_KEY,
  WALLET_PAYMENT_ENABLED_KEY,
  WALLET_TOPUP_MIN_KEY,
  WALLET_TOPUP_MAX_KEY,
  WALLET_TOPUP_INSTRUCTION_KEY,
  PAYMENT_PAGE_NOTICE_KEY,
];

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const PRICE = 80_000;

async function resetSettings(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: { in: SETTING_KEYS } } });
  clearSettingsCache();
}

describe.runIf(hasDb)("payment/wallet settings (Phase 22)", () => {
  beforeAll(resetSettings);
  afterAll(async () => {
    // Leave the GLOBAL settings at defaults for whatever runs next.
    await resetSettings();
    await prisma.$disconnect();
  });

  it("returns safe defaults when no Setting rows exist", async () => {
    await resetSettings();
    expect(await isWalletTopupEnabled()).toBe(true);
    expect(await isWalletPaymentEnabled()).toBe(true);
    const limits = await walletTopupLimits();
    expect(limits.minToman).toBe(DEFAULT_TOPUP_MIN_TOMAN);
    expect(limits.maxToman).toBe(DEFAULT_TOPUP_MAX_TOMAN);
    expect(await walletTopupInstruction()).toBeNull();
    expect(await paymentPageNotice()).toBeNull();
  });

  it("toggles booleans and sets/validates min/max/texts", async () => {
    await setWalletTopupEnabled(false);
    expect(await isWalletTopupEnabled()).toBe(false);
    await setWalletTopupEnabled(true);
    expect(await isWalletTopupEnabled()).toBe(true);

    await setWalletPaymentEnabled(false);
    expect(await isWalletPaymentEnabled()).toBe(false);
    await setWalletPaymentEnabled(true);

    // min/max feed the Phase 14 reader; min > max is rejected.
    expect((await setWalletTopupMinToman(20_000)).ok).toBe(true);
    expect((await setWalletTopupMaxToman(1_000_000)).ok).toBe(true);
    expect((await walletTopupLimits()).minToman).toBe(20_000);
    expect((await walletTopupLimits()).maxToman).toBe(1_000_000);
    expect((await setWalletTopupMinToman(2_000_000)).ok).toBe(false);
    expect((await setWalletTopupMaxToman(10_000)).ok).toBe(false);
    // 0 resets to the built-in defaults.
    expect((await setWalletTopupMinToman(0)).ok).toBe(true);
    expect((await setWalletTopupMaxToman(0)).ok).toBe(true);
    expect((await walletTopupLimits()).minToman).toBe(DEFAULT_TOPUP_MIN_TOMAN);
    expect((await walletTopupLimits()).maxToman).toBe(DEFAULT_TOPUP_MAX_TOMAN);

    expect((await setWalletTopupInstruction("  فقط از کارت خودتان  ")).ok).toBe(true);
    expect(await walletTopupInstruction()).toBe("فقط از کارت خودتان");
    expect((await setWalletTopupInstruction(null)).ok).toBe(true);
    expect(await walletTopupInstruction()).toBeNull();
    const tooLong = await setPaymentPageNotice("x".repeat(1001));
    expect(!tooLong.ok && tooLong.safeMessage === SETTING_TEXT_TOO_LONG).toBe(true);
    expect((await setPaymentPageNotice("پرداخت‌ها بین ۹ تا ۱۷ بررسی می‌شوند.")).ok).toBe(true);
    expect(await paymentPageNotice()).toBe("پرداخت‌ها بین ۹ تا ۱۷ بررسی می‌شوند.");
    await setPaymentPageNotice(null);
  });

  it("disabled top-up refuses to create a WALLET_CHARGE checkout", async () => {
    const user = await prisma.user.create({ data: { telegramId: runTag + 1n } });
    await setWalletTopupEnabled(false);
    await expect(createWalletTopupCheckout(user, 50_000)).rejects.toThrow();
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
    await setWalletTopupEnabled(true);
    const checkout = await createWalletTopupCheckout(user, 50_000);
    expect(checkout.purpose).toBe("WALLET_CHARGE");
  });

  it("disabled wallet payment blocks the service before any writes", async () => {
    const panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `p22-panel-${runTag}`, baseUrl: "http://127.0.0.1:1", status: "ACTIVE", username: "admin", passwordEncrypted: "enc", templateUsername: "tpl" },
    });
    const category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `p22-cat-${runTag}`, isActive: true },
    });
    const product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `p22-prod-${runTag}`,
        priceToman: PRICE,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
      },
    });
    const user = await prisma.user.create({
      data: { telegramId: runTag + 2n, balanceToman: 200_000 },
    });
    const draft = (): CheckoutDraft => ({
      productId: product.id,
      categoryId: category.id,
      panelId: panel.id,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      draftNonce: randomUUID(),
    });

    await setWalletPaymentEnabled(false);
    // The wallet-disabled guard is DOWNSTREAM of the reservation guard, so the
    // draft must be armed (completed customization + HELD reservation) to reach it.
    const blocked = await payPurchaseDraftWithWallet(
      user,
      await armServiceDraft(draft(), { userId: user.id, panelId: panel.id }),
    );
    expect(!blocked.ok && blocked.error === WALLET_PAYMENT_DISABLED_TEXT).toBe(true);
    // No financial rows were written while disabled.
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(200_000);

    // Re-enabling restores the untouched Phase 15 path (atomic fix intact).
    await setWalletPaymentEnabled(true);
    const paid = await payPurchaseDraftWithWallet(
      user,
      await armServiceDraft(draft(), { userId: user.id, panelId: panel.id }),
    );
    expect(paid.ok).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(200_000 - PRICE);
  });
});

// --- pure view tests (no DB) ------------------------------------------------------------

describe("wallet payment button visibility (Phase 22)", () => {
  const draft = {
    productId: "p",
    categoryId: "c",
    flowType: "SERVICE_PRODUCT",
    originalPriceToman: 50_000,
    discountAmountToman: 0,
    finalPriceToman: 50_000,
  } as CheckoutDraft;
  const user = { balanceToman: 100_000 } as User;
  const texts = (enabled: boolean) =>
    preInvoiceKeyboard(draft, user, enabled).inline_keyboard.flat().map((b) => b.text);

  it("hides «پرداخت با کیف پول 🏦» when disabled, shows it when enabled", () => {
    expect(texts(true)).toContain("پرداخت با کیف پول 🏦");
    expect(texts(false)).not.toContain("پرداخت با کیف پول 🏦");
  });
});

describe("payment methods notice (Phase 22)", () => {
  it("appends the escaped notice only when set", () => {
    const base = paymentMethodsText(false, 50_000);
    expect(paymentMethodsText(false, 50_000, null)).toBe(base);
    const withNotice = paymentMethodsText(false, 50_000, "بعد از پرداخت <رسید> بفرستید");
    expect(withNotice).toContain("بعد از پرداخت &lt;رسید&gt; بفرستید");
    expect(withNotice.startsWith(base)).toBe(true);
  });
});

describe.skipIf(hasDb)("payment/wallet settings (skipped)", () => {
  it("payment settings integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
