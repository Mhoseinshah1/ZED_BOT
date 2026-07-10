import { prisma } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adjustUserWallet,
  INSUFFICIENT_USER_BALANCE_TEXT,
  INVALID_AMOUNT_TEXT,
  INVALID_REASON_TEXT,
  MAX_MANUAL_ADJUST_TOMAN,
} from "../src/services/admin-user-wallet.service.js";

// =============================================================================
// Admin manual wallet adjustment integration tests (Phase 20).
//
// Same requirements as the wallet race suite: point DATABASE_URL at a
// migrated, DISPOSABLE PostgreSQL (see docs/testing.md). Without
// DATABASE_URL the suite skips itself.
//
// Proves: concurrent decreases can never drive a balance negative (atomic
// conditional updateMany), both directions write accurate before/after
// ledger rows, and a manual adjustment never creates Payment/Order/
// CheckoutSession rows.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let adminId: string;

async function createUserWithBalance(balanceToman: number) {
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)), balanceToman },
  });
}

describe.runIf(hasDb)("admin manual wallet adjustment", () => {
  beforeAll(async () => {
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 999_999_999n, role: "OWNER" },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("concurrent decreases cannot make the balance negative", async () => {
    const user = await createUserWithBalance(100_000);

    const [r1, r2] = await Promise.all([
      adjustUserWallet({
        targetUserId: user.id,
        adminId,
        action: "DECREASE",
        amountToman: 80_000,
        reason: "concurrent test A",
      }),
      adjustUserWallet({
        targetUserId: user.id,
        adminId,
        action: "DECREASE",
        amountToman: 80_000,
        reason: "concurrent test B",
      }),
    ]);

    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r): r is { ok: false; error: string; safeMessage: string } => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(fails[0].safeMessage).toBe(INSUFFICIENT_USER_BALANCE_TEXT);

    const finalUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalUser.balanceToman).toBe(20_000);
    expect(finalUser.balanceToman).toBeGreaterThanOrEqual(0);
    expect(finalUser.totalManualDeductedToman).toBe(80_000);

    const deducts = await prisma.walletTransaction.findMany({
      where: { userId: user.id, type: "MANUAL_DEDUCT" },
    });
    expect(deducts).toHaveLength(1);
    expect(deducts[0].balanceBeforeToman).toBe(100_000);
    expect(deducts[0].balanceAfterToman).toBe(20_000);
  });

  it("increase writes an accurate MANUAL_ADD ledger row", async () => {
    const user = await createUserWithBalance(5_000);
    const outcome = await adjustUserWallet({
      targetUserId: user.id,
      adminId,
      action: "INCREASE",
      amountToman: 40_000,
      reason: "  جبران خطای سرویس  ",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.user.balanceToman).toBe(45_000);
      expect(outcome.user.totalManualAddedToman).toBe(40_000);
      // totalChargedToman is user-payment territory - untouched by manual add.
      expect(outcome.user.totalChargedToman).toBe(0);
      const tx = outcome.walletTransaction;
      expect(tx.type).toBe("MANUAL_ADD");
      expect(tx.source).toBe("ADMIN");
      expect(tx.adminId).toBe(adminId);
      expect(tx.reason).toBe("جبران خطای سرویس"); // trimmed
      expect(tx.balanceBeforeToman).toBe(5_000);
      expect(tx.balanceAfterToman).toBe(45_000);
    }
  });

  it("decrease writes an accurate MANUAL_DEDUCT ledger row", async () => {
    const user = await createUserWithBalance(90_000);
    const outcome = await adjustUserWallet({
      targetUserId: user.id,
      adminId,
      action: "DECREASE",
      amountToman: 30_000,
      reason: "اصلاح شارژ اشتباه",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.user.balanceToman).toBe(60_000);
      expect(outcome.user.totalManualDeductedToman).toBe(30_000);
      const tx = outcome.walletTransaction;
      expect(tx.type).toBe("MANUAL_DEDUCT");
      expect(tx.source).toBe("ADMIN");
      expect(tx.adminId).toBe(adminId);
      expect(tx.balanceBeforeToman).toBe(90_000);
      expect(tx.balanceAfterToman).toBe(60_000);
    }
  });

  it("rejects invalid amounts and reasons, exact-balance decrease hits zero", async () => {
    const user = await createUserWithBalance(10_000);

    const zero = await adjustUserWallet({ targetUserId: user.id, adminId, action: "INCREASE", amountToman: 0, reason: "valid reason" });
    expect(!zero.ok && zero.safeMessage === INVALID_AMOUNT_TEXT).toBe(true);
    const over = await adjustUserWallet({ targetUserId: user.id, adminId, action: "INCREASE", amountToman: MAX_MANUAL_ADJUST_TOMAN + 1, reason: "valid reason" });
    expect(!over.ok && over.safeMessage === INVALID_AMOUNT_TEXT).toBe(true);
    const shortReason = await adjustUserWallet({ targetUserId: user.id, adminId, action: "INCREASE", amountToman: 1_000, reason: "ab" });
    expect(!shortReason.ok && shortReason.safeMessage === INVALID_REASON_TEXT).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman).toBe(10_000);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);

    // Exactly-equal balance may be deducted to zero, never below.
    const exact = await adjustUserWallet({ targetUserId: user.id, adminId, action: "DECREASE", amountToman: 10_000, reason: "کسر کامل موجودی" });
    expect(exact.ok).toBe(true);
    const again = await adjustUserWallet({ targetUserId: user.id, adminId, action: "DECREASE", amountToman: 1, reason: "باید رد شود" });
    expect(!again.ok && again.safeMessage === INSUFFICIENT_USER_BALANCE_TEXT).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman).toBe(0);
  });

  it("manual adjustments never create Payment/Order/CheckoutSession rows", async () => {
    const user = await createUserWithBalance(50_000);
    await adjustUserWallet({ targetUserId: user.id, adminId, action: "INCREASE", amountToman: 10_000, reason: "بدون رکورد پرداخت" });
    await adjustUserWallet({ targetUserId: user.id, adminId, action: "DECREASE", amountToman: 5_000, reason: "بدون رکورد سفارش" });

    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman).toBe(55_000);
  });
});

describe.skipIf(hasDb)("admin manual wallet adjustment (skipped)", () => {
  it("admin wallet integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
