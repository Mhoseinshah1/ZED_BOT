import { randomUUID } from "node:crypto";

import {
  prisma,
  type Admin,
  type User,
  type WalletTransaction,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "wallet-ledger-secret-wallet-ledger-11";

import type { CheckoutDraft } from "../src/core/session.js";
import { adjustUserWallet } from "../src/services/admin-user-wallet.service.js";
import {
  failOrderWithRefund,
  REFUND_PROVISIONING_REASON,
  type OrderForProvisioning,
} from "../src/services/provisioning.service.js";
import { approveReceiptPayment } from "../src/services/receipt-review.service.js";
import {
  INSUFFICIENT_BALANCE_TEXT,
  payPurchaseDraftWithWallet,
  WALLET_ORDER_PAYMENT_REASON,
} from "../src/services/wallet-payment.service.js";
import { WALLET_TOPUP_REASON } from "../src/services/wallet-topup.service.js";

// =============================================================================
// Wallet ledger integrity integration tests.
//
// Requires a REAL PostgreSQL (DATABASE_URL against a migrated disposable
// database, docs/testing.md) - the guarantees under test are about row locks,
// transaction rollback and concurrent commits.
//
// Invariants exercised here (docs/wallet-ledger-integrity.md):
//   - every balance mutation writes exactly ONE immutable WalletTransaction
//     in the SAME transaction;
//   - balanceAfter - balanceBefore == +/- amount by type;
//   - Wallet.balance is fully reconstructable from the ledger alone;
//   - retries and concurrent duplicates never write a second ledger row;
//   - failed operations write nothing and move no money;
//   - the balance can never go negative under concurrency.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 50_000;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let tgSeq = 0;

let panelId: string;
let categoryId: string;
let productId: string;
let admin: Admin;

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `wallet-ledger-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
    },
  });
  panelId = panel.id;
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `wallet-ledger-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId,
      name: `wallet-ledger-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
  admin = await prisma.admin.create({
    data: { telegramId: runTag + 900_000n, role: "OWNER", isActive: true },
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.admin.deleteMany({ where: { id: admin.id } }).catch(() => undefined);
});

async function createUser(balanceToman = 0): Promise<User> {
  tgSeq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(tgSeq), balanceToman },
  });
}

function draftFor(draftNonce = randomUUID()): CheckoutDraft {
  return {
    productId,
    categoryId,
    flowType: "SERVICE_PRODUCT",
    originalPriceToman: PRICE,
    discountAmountToman: 0,
    finalPriceToman: PRICE,
    draftNonce,
  };
}

/** A PENDING_REVIEW wallet top-up (checkout + payment + receipt), approvable. */
async function createTopupPayment(user: User, amountToman: number): Promise<string> {
  const checkout = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "WALLET_CHARGE",
      productSnapshot: {
        flowType: "WALLET_TOPUP",
        walletTopupAmountToman: amountToman,
        title: "شارژ کیف پول",
      },
      originalPriceToman: amountToman,
      discountAmountToman: 0,
      finalPriceToman: amountToman,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose: "WALLET_CHARGE",
      status: "PENDING_REVIEW",
      amountToman,
      payableAmountToman: amountToman,
      receipts: {
        create: { userId: user.id, text: "topup receipt", status: "PENDING_REVIEW" },
      },
    },
  });
  return payment.id;
}

/** A PAID SERVICE_PURCHASE order shaped for failOrderWithRefund. */
async function createPaidOrder(user: User, amountToman: number): Promise<OrderForProvisioning> {
  return prisma.order.create({
    data: {
      userId: user.id,
      type: "SERVICE_PURCHASE",
      status: "PAID",
      productId,
      originalPriceToman: amountToman,
      discountAmountToman: 0,
      finalPriceToman: amountToman,
      paidAt: new Date(),
    },
    include: { user: true, product: { include: { panel: true } } },
  });
}

async function ledgerRows(userId: string): Promise<WalletTransaction[]> {
  return prisma.walletTransaction.findMany({ where: { userId } });
}

const CREDIT_TYPES = new Set(["CHARGE", "REFUND", "CASHBACK", "COMMISSION", "MANUAL_ADD"]);
const DEBIT_TYPES = new Set(["SPEND", "MANUAL_DEDUCT"]);

function signedAmount(row: WalletTransaction): number {
  if (CREDIT_TYPES.has(row.type)) return row.amountToman;
  if (DEBIT_TYPES.has(row.type)) return -row.amountToman;
  throw new Error(`unexpected wallet transaction type: ${row.type}`);
}

/** Invariant 3: each row's before/after arithmetic must match its type. */
function expectRowArithmetic(rows: WalletTransaction[]): void {
  for (const row of rows) {
    expect(row.balanceAfterToman - row.balanceBeforeToman).toBe(signedAmount(row));
    expect(row.amountToman).toBeGreaterThan(0);
  }
}

/**
 * Reconstructs the balance from the ledger alone (invariant 10) and asserts
 * the rows form ONE gapless before->after chain starting at the user's
 * starting balance. Chain order is discovered by matching balances, not by
 * createdAt (createdAt is the transaction start time, so under concurrency
 * it may not match the commit/serialization order).
 */
function expectLedgerReconstructs(
  rows: WalletTransaction[],
  startingBalance: number,
  finalBalance: number,
): void {
  expectRowArithmetic(rows);
  const sum = rows.reduce((acc, row) => acc + signedAmount(row), 0);
  expect(startingBalance + sum).toBe(finalBalance);

  const remaining = [...rows];
  let expected = startingBalance;
  while (remaining.length > 0) {
    const idx = remaining.findIndex((row) => row.balanceBeforeToman === expected);
    expect(idx, `no ledger row continues the chain at balance ${expected}`).toBeGreaterThanOrEqual(0);
    expected = remaining[idx]!.balanceAfterToman;
    remaining.splice(idx, 1);
  }
  expect(expected).toBe(finalBalance);
}

async function freshBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.balanceToman;
}

describe.runIf(hasDb)("wallet ledger integrity", () => {
  it("1. wallet payment success writes exactly one SPEND row with a business reason", async () => {
    const user = await createUser(100_000);
    const outcome = await payPurchaseDraftWithWallet(user, draftFor());
    expect(outcome.ok).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.type).toBe("SPEND");
    expect(row.reason).toBe(WALLET_ORDER_PAYMENT_REASON);
    expect(row.balanceBeforeToman).toBe(100_000);
    expect(row.balanceAfterToman).toBe(100_000 - PRICE);
    expect(row.relatedOrderId).not.toBeNull();
    expect(row.relatedPaymentId).not.toBeNull();
    expect(await freshBalance(user.id)).toBe(100_000 - PRICE);
  });

  it("2. failed wallet payment rolls back completely and writes no ledger row", async () => {
    // The committed row has 0 - the stale object sneaks past the UX pre-check
    // and the atomic conditional deduction inside the transaction must fail.
    const broke = await createUser(0);
    const outcome = await payPurchaseDraftWithWallet(
      { ...broke, balanceToman: 100_000 },
      draftFor(),
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe(INSUFFICIENT_BALANCE_TEXT);

    expect(await ledgerRows(broke.id)).toEqual([]);
    expect(await freshBalance(broke.id)).toBe(0);
    // The whole transaction rolled back: no orphan order/payment/checkout.
    expect(await prisma.order.count({ where: { userId: broke.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: broke.id } })).toBe(0);
  });

  it("3. duplicate wallet payment (same draft, sequential and concurrent) settles once", async () => {
    const user = await createUser(200_000);
    const nonce = randomUUID();

    const first = await payPurchaseDraftWithWallet(user, draftFor(nonce));
    expect(first.ok).toBe(true);
    const retry = await payPurchaseDraftWithWallet(user, draftFor(nonce));
    expect(retry.ok && retry.alreadyPaid).toBe(true);

    const concurrentNonce = randomUUID();
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(fresh, draftFor(concurrentNonce)),
      payPurchaseDraftWithWallet(fresh, draftFor(concurrentNonce)),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(2); // one per DISTINCT draft, never per attempt
    expect(await freshBalance(user.id)).toBe(200_000 - 2 * PRICE);
  });

  it("4. refund is idempotent: sequential retries and concurrent calls write one REFUND row", async () => {
    const user = await createUser(0);
    const order = await createPaidOrder(user, 30_000);

    expect(await failOrderWithRefund(order, "test failure")).toBe(true);
    expect(await failOrderWithRefund(order, "test failure retry")).toBe(true);

    const orderRows = await prisma.walletTransaction.findMany({
      where: { relatedOrderId: order.id },
    });
    expect(orderRows.length).toBe(1);
    expect(orderRows[0]!.type).toBe("REFUND");
    expect(orderRows[0]!.reason).toBe(REFUND_PROVISIONING_REASON);
    expect(await freshBalance(user.id)).toBe(30_000);

    const order2 = await createPaidOrder(user, 20_000);
    const results = await Promise.all([
      failOrderWithRefund(order2, "race a"),
      failOrderWithRefund(order2, "race b"),
    ]);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const order2Rows = await prisma.walletTransaction.findMany({
      where: { relatedOrderId: order2.id },
    });
    expect(order2Rows.length).toBe(1); // NEVER a second refund
    expect(await freshBalance(user.id)).toBe(50_000);

    const failedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order2.id } });
    expect(failedOrder.status).toBe("FAILED"); // one business state transition
  });

  it("5. manual add writes one MANUAL_ADD row and creates no order/payment/service", async () => {
    const user = await createUser(10_000);
    const outcome = await adjustUserWallet({
      targetUserId: user.id,
      adminId: admin.id,
      action: "INCREASE",
      amountToman: 30_000,
      reason: "ledger test manual add",
    });
    expect(outcome.ok).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.type).toBe("MANUAL_ADD");
    expect(row.adminId).toBe(admin.id);
    expect(row.reason).toBe("ledger test manual add");
    expect(row.balanceBeforeToman).toBe(10_000);
    expect(row.balanceAfterToman).toBe(40_000);
    expect(await freshBalance(user.id)).toBe(40_000);

    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);
  });

  it("6. manual deduct writes one MANUAL_DEDUCT row; insufficient balance writes nothing", async () => {
    const user = await createUser(20_000);
    const ok = await adjustUserWallet({
      targetUserId: user.id,
      adminId: admin.id,
      action: "DECREASE",
      amountToman: 5_000,
      reason: "ledger test manual deduct",
    });
    expect(ok.ok).toBe(true);
    expect(await freshBalance(user.id)).toBe(15_000);

    const rejected = await adjustUserWallet({
      targetUserId: user.id,
      adminId: admin.id,
      action: "DECREASE",
      amountToman: 1_000_000,
      reason: "ledger test overdraft",
    });
    expect(rejected.ok).toBe(false);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("MANUAL_DEDUCT");
    expect(rows[0]!.balanceBeforeToman).toBe(20_000);
    expect(rows[0]!.balanceAfterToman).toBe(15_000);
    expect(await freshBalance(user.id)).toBe(15_000);

    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);
  });

  it("7. concurrent debits: funds covering one payment settle exactly one", async () => {
    const user = await createUser(PRICE); // covers exactly one purchase
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(user, draftFor()),
      payPurchaseDraftWithWallet(user, draftFor()),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok ? loser.error : "").toBe(INSUFFICIENT_BALANCE_TEXT);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(1);
    const balance = await freshBalance(user.id);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
    expectLedgerReconstructs(rows, PRICE, balance);
  });

  it("8. concurrent credits: double-approval charges once, distinct top-ups both land", async () => {
    const user = await createUser(0);
    const paymentId = await createTopupPayment(user, 40_000);
    const [a, b] = await Promise.all([
      approveReceiptPayment(paymentId, admin),
      approveReceiptPayment(paymentId, admin),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1); // CAS flip: one winner
    expect(await freshBalance(user.id)).toBe(40_000);
    expect((await ledgerRows(user.id)).length).toBe(1);

    const [p1, p2] = await Promise.all([
      createTopupPayment(user, 10_000),
      createTopupPayment(user, 15_000),
    ]);
    const [c, d] = await Promise.all([
      approveReceiptPayment(p1, admin),
      approveReceiptPayment(p2, admin),
    ]);
    expect(c.ok).toBe(true);
    expect(d.ok).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.type === "CHARGE")).toBe(true);
    const balance = await freshBalance(user.id);
    expect(balance).toBe(65_000);
    expectLedgerReconstructs(rows, 0, balance);
  });

  it("9. concurrent credit + debit keep the ledger chain gapless", async () => {
    // Repeated because interleaving is timing-dependent: a top-up approval
    // racing a wallet payment on the SAME user must still record real
    // before/after transitions (this is the exact scenario that corrupts the
    // ledger when balanceBefore comes from a stale pre-read).
    for (let i = 0; i < 5; i += 1) {
      const user = await createUser(PRICE);
      const paymentId = await createTopupPayment(user, 70_000);
      const [credit, debit] = await Promise.all([
        approveReceiptPayment(paymentId, admin),
        payPurchaseDraftWithWallet(user, draftFor()),
      ]);
      expect(credit.ok).toBe(true);
      expect(debit.ok).toBe(true);

      const rows = await ledgerRows(user.id);
      expect(rows.length).toBe(2);
      const balance = await freshBalance(user.id);
      expect(balance).toBe(70_000);
      expectLedgerReconstructs(rows, PRICE, balance);
    }
  });

  it("10. the ledger alone reconstructs the final balance after a mixed history", async () => {
    const user = await createUser(0);

    // top-up +100k
    const topup = await createTopupPayment(user, 100_000);
    expect((await approveReceiptPayment(topup, admin)).ok).toBe(true);
    // wallet purchase -PRICE
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect((await payPurchaseDraftWithWallet(fresh, draftFor())).ok).toBe(true);
    // provisioning refund +20k
    const order = await createPaidOrder(user, 20_000);
    expect(await failOrderWithRefund(order, "ledger test")).toBe(true);
    // manual add +10k, manual deduct -5k
    expect(
      (
        await adjustUserWallet({
          targetUserId: user.id,
          adminId: admin.id,
          action: "INCREASE",
          amountToman: 10_000,
          reason: "ledger test add",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await adjustUserWallet({
          targetUserId: user.id,
          adminId: admin.id,
          action: "DECREASE",
          amountToman: 5_000,
          reason: "ledger test deduct",
        })
      ).ok,
    ).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(5);
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set(["CHARGE", "SPEND", "REFUND", "MANUAL_ADD", "MANUAL_DEDUCT"]),
    );
    // Invariant 7: every row carries its business reason.
    expect(rows.every((r) => typeof r.reason === "string" && r.reason.length > 0)).toBe(true);
    expect(rows.find((r) => r.type === "CHARGE")?.reason).toBe(WALLET_TOPUP_REASON);
    expect(rows.find((r) => r.type === "SPEND")?.reason).toBe(WALLET_ORDER_PAYMENT_REASON);
    expect(rows.find((r) => r.type === "REFUND")?.reason).toBe(REFUND_PROVISIONING_REASON);

    const balance = await freshBalance(user.id);
    expect(balance).toBe(100_000 - PRICE + 20_000 + 10_000 - 5_000);
    expectLedgerReconstructs(rows, 0, balance);
  });

  it("11. retries never write duplicate ledger rows", async () => {
    const user = await createUser(0);

    const topup = await createTopupPayment(user, 60_000);
    expect((await approveReceiptPayment(topup, admin)).ok).toBe(true);
    const reApprove = await approveReceiptPayment(topup, admin);
    expect(reApprove.ok).toBe(false); // already reviewed - refused, not repeated

    const nonce = randomUUID();
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect((await payPurchaseDraftWithWallet(fresh, draftFor(nonce))).ok).toBe(true);
    const replay = await payPurchaseDraftWithWallet(fresh, draftFor(nonce));
    expect(replay.ok && replay.alreadyPaid).toBe(true);

    const order = await createPaidOrder(user, 5_000);
    expect(await failOrderWithRefund(order, "first")).toBe(true);
    expect(await failOrderWithRefund(order, "second")).toBe(true);

    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(3); // CHARGE + SPEND + REFUND, despite 6 attempts
    const balance = await freshBalance(user.id);
    expect(balance).toBe(60_000 - PRICE + 5_000);
    expectLedgerReconstructs(rows, 0, balance);
  });

  it("12. concurrent overdraft attempts can never drive the balance negative", async () => {
    const user = await createUser(30_000);
    const outcomes = await Promise.all([
      payPurchaseDraftWithWallet({ ...user, balanceToman: PRICE }, draftFor()),
      payPurchaseDraftWithWallet({ ...user, balanceToman: PRICE }, draftFor()),
      adjustUserWallet({
        targetUserId: user.id,
        adminId: admin.id,
        action: "DECREASE",
        amountToman: 30_000,
        reason: "ledger overdraft race",
      }),
      adjustUserWallet({
        targetUserId: user.id,
        adminId: admin.id,
        action: "DECREASE",
        amountToman: 30_000,
        reason: "ledger overdraft race",
      }),
    ]);
    // 30k cannot cover a 50k purchase at all, and only ONE 30k deduction.
    const wins = outcomes.filter((o) => o.ok);
    expect(wins.length).toBe(1);

    const balance = await freshBalance(user.id);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
    const rows = await ledgerRows(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("MANUAL_DEDUCT");
    expectLedgerReconstructs(rows, 30_000, balance);
  });
});

describe.runIf(!hasDb)("wallet ledger integrity (skipped)", () => {
  it("integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
