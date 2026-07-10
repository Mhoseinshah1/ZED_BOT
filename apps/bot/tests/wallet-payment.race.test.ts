import { randomUUID } from "node:crypto";

import { prisma } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CheckoutDraft } from "../src/core/session.js";
import {
  INSUFFICIENT_BALANCE_TEXT,
  payPurchaseDraftWithWallet,
  WALLET_ORDER_PAYMENT_REASON,
} from "../src/services/wallet-payment.service.js";

// =============================================================================
// Wallet payment race-condition integration tests.
//
// Requires a REAL PostgreSQL: point DATABASE_URL at a migrated, DISPOSABLE
// database (`prisma migrate deploy`) before running, e.g.
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5490/zedbot_test pnpm test
// Without DATABASE_URL the whole suite skips itself - these guarantees can
// only be proven against real transactions, not mocks.
//
// 1. Two DIFFERENT drafts racing on one wallet must not overspend: the
//    deduction is a conditional updateMany (balanceToman >= amount), so
//    exactly one wins and the loser rolls back with insufficient balance.
// 2. The SAME draft (one draftNonce) double-clicked concurrently stays
//    idempotent via Payment.idempotencyKey: one Payment/Order/SPEND, one
//    deduction, both calls resolve ok.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 80_000;
const BALANCE = 100_000;

let panelId: string;
let categoryId: string;
let productAId: string;
let productBId: string;

// Unique per run so reruns against the same database never collide.
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

function draftFor(productId: string, draftNonce: string): CheckoutDraft {
  return {
    productId,
    categoryId,
    panelId,
    flowType: "SERVICE_PRODUCT",
    // Informational only - payPurchaseDraftWithWallet recomputes prices
    // from the product row and never trusts the session draft.
    originalPriceToman: PRICE,
    discountAmountToman: 0,
    finalPriceToman: PRICE,
    draftNonce,
  };
}

async function createUserWithBalance(balanceToman: number) {
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)), balanceToman },
  });
}

describe.runIf(hasDb)("wallet payment balance race", () => {
  beforeAll(async () => {
    const panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `race-test-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
      },
    });
    panelId = panel.id;
    const category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `race-test-category-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    const [productA, productB] = await Promise.all([
      prisma.product.create({
        data: {
          type: "SERVICE_PRODUCT",
          categoryId,
          panelId,
          name: `race-test-product-a-${runTag}`,
          priceToman: PRICE,
          volumeGb: 10,
          durationDays: 30,
          isActive: true,
        },
      }),
      prisma.product.create({
        data: {
          type: "SERVICE_PRODUCT",
          categoryId,
          panelId,
          name: `race-test-product-b-${runTag}`,
          priceToman: PRICE,
          volumeGb: 20,
          durationDays: 30,
          isActive: true,
        },
      }),
    ]);
    productAId = productA.id;
    productBId = productB.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("concurrent DIFFERENT drafts cannot overspend the balance", async () => {
    const user = await createUserWithBalance(BALANCE);

    // Two independent pre-invoices (different products, different nonces)
    // priced 80k each against a 100k balance - only one may settle.
    const [r1, r2] = await Promise.all([
      payPurchaseDraftWithWallet(user, draftFor(productAId, randomUUID())),
      payPurchaseDraftWithWallet(user, draftFor(productBId, randomUUID())),
    ]);

    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r): r is { ok: false; error: string } => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(fails[0].error).toBe(INSUFFICIENT_BALANCE_TEXT);

    const finalUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalUser.balanceToman).toBe(BALANCE - PRICE); // 20000
    expect(finalUser.balanceToman).toBeGreaterThanOrEqual(0);

    const spends = await prisma.walletTransaction.findMany({
      where: { userId: user.id, type: "SPEND", reason: WALLET_ORDER_PAYMENT_REASON },
    });
    expect(spends).toHaveLength(1);
    expect(spends[0].amountToman).toBe(PRICE);
    expect(spends[0].balanceBeforeToman).toBe(BALANCE);
    expect(spends[0].balanceAfterToman).toBe(BALANCE - PRICE);

    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("PAID");
    expect(orders[0].finalPriceToman).toBe(PRICE);

    // The losing draft must have left NOTHING behind (full rollback).
    const payments = await prisma.payment.findMany({ where: { userId: user.id } });
    expect(payments).toHaveLength(1);
    const checkouts = await prisma.checkoutSession.findMany({ where: { userId: user.id } });
    expect(checkouts).toHaveLength(1);
  });

  it("same draft double-clicked concurrently stays idempotent", async () => {
    const user = await createUserWithBalance(BALANCE);
    const draft = draftFor(productAId, randomUUID());

    const [r1, r2] = await Promise.all([
      payPurchaseDraftWithWallet(user, draft),
      payPurchaseDraftWithWallet(user, draft),
    ]);

    // Both calls resolve safely; the loser gets the winner's settled result.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.order.id).toBe(r2.order.id);
      expect(r1.payment.id).toBe(r2.payment.id);
      expect(r1.newBalanceToman).toBe(BALANCE - PRICE);
      expect(r2.newBalanceToman).toBe(BALANCE - PRICE);
      // Depending on interleaving 0 or 1 of them reports alreadyPaid.
      expect([r1, r2].filter((r) => r.alreadyPaid).length).toBeLessThanOrEqual(1);
      // Exactly one Payment carries this draft's idempotency key.
      const key = r1.payment.idempotencyKey;
      expect(key).not.toBeNull();
      if (key !== null) {
        expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
      }
    }

    // Exactly one of everything - the balance moved exactly once.
    const finalUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalUser.balanceToman).toBe(BALANCE - PRICE);
    expect(
      await prisma.payment.count({ where: { userId: user.id } }),
    ).toBe(1);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, type: "SPEND", reason: WALLET_ORDER_PAYMENT_REASON },
      }),
    ).toBe(1);
  });
});

describe.skipIf(hasDb)("wallet payment balance race (skipped)", () => {
  it("wallet payment integration tests require DATABASE_URL - see file header / docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
