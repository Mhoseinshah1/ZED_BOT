import { randomUUID } from "node:crypto";

import { prisma, type Admin, type DiscountCode, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "discount-atomic-secret-discount-atomic-1";

import type { CheckoutDraft } from "../src/core/session.js";
import { DISCOUNT_CLAIM_FAILED_TEXT } from "../src/services/discount.service.js";
import { approveReceiptPayment } from "../src/services/receipt-review.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";
import { armServiceDraft } from "./helpers/service-checkout-fixture.js";

// =============================================================================
// Atomic discount consumption integration tests.
//
// Requires a REAL PostgreSQL (DATABASE_URL against a migrated disposable
// database, docs/testing.md) - these guarantees are about row locks and
// transaction rollback and can only be proven against real transactions.
//
// The pre-payment validateDiscountCode() is UX only. claimDiscountUsage()
// inside the payment transaction is the single source of truth: it locks
// the DiscountCode row (SELECT ... FOR NO KEY UPDATE), re-validates every limit
// and claims the usage together with the payment. These tests race real
// payments to prove totalUsageLimit / perUserUsageLimit can never be
// exceeded and that failed or retried payments never consume usage.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 50_000;
const DISCOUNT = 10_000;
const FINAL = PRICE - DISCOUNT;
const BALANCE = 500_000;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let codeSeq = 0;

let panelId: string;
let categoryId: string;
let productId: string;

// Shared purchasable-product fixture for BOTH describes below. A
// SERVICE_PRODUCT is only visible (and therefore only payable) when it is
// linked to an ACTIVE, visible panel - without one, payPurchaseDraftWithWallet
// rejects the draft before the transaction is ever reached.
beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `atomic-discount-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
      // Sellability gate: complete provisioning config (never decrypted here).
      username: "admin",
      passwordEncrypted: "enc",
      templateUsername: "tpl",
    },
  });
  panelId = panel.id;
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `atomic-discount-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId,
      name: `atomic-discount-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { id: productId } }).catch(() => undefined);
  await prisma.productCategory.deleteMany({ where: { id: categoryId } }).catch(() => undefined);
  await prisma.panel.deleteMany({ where: { id: panelId } }).catch(() => undefined);
});

function draftFor(discountCode: string, draftNonce = randomUUID()): CheckoutDraft {
  return {
    productId,
    categoryId,
    flowType: "SERVICE_PRODUCT",
    // Informational only - the service recomputes prices and re-validates.
    originalPriceToman: PRICE,
    discountAmountToman: DISCOUNT,
    finalPriceToman: FINAL,
    discountCode,
    draftNonce,
  };
}

/**
 * A panel-backed SERVICE draft (keeping its discountCode) armed with the completed
 * customization + HELD reservation the wallet guard requires (§4). Same-draft
 * idempotency tests reuse the ONE object this returns; distinct-draft tests call
 * it again for a distinct reservation.
 */
async function armedDraft(
  userId: string,
  discountCode: string,
  nonce?: string,
): Promise<CheckoutDraft> {
  return armServiceDraft(draftFor(discountCode, nonce), { userId, panelId });
}

async function createUser(balanceToman = BALANCE): Promise<User> {
  return prisma.user.create({
    data: {
      telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)),
      balanceToman,
    },
  });
}

async function createCode(overrides: {
  totalUsageLimit?: number | null;
  totalUsedCount?: number;
  perUserUsageLimit?: number | null;
}): Promise<DiscountCode> {
  codeSeq += 1;
  return prisma.discountCode.create({
    data: {
      code: `ATOM${runTag}X${codeSeq}`,
      type: "FIXED_AMOUNT",
      value: DISCOUNT,
      isActive: true,
      totalUsageLimit: overrides.totalUsageLimit ?? null,
      totalUsedCount: overrides.totalUsedCount ?? 0,
      perUserUsageLimit: overrides.perUserUsageLimit ?? null,
    },
  });
}

async function codeState(codeId: string): Promise<{ usedCount: number; usages: number }> {
  const [code, usages] = await Promise.all([
    prisma.discountCode.findUniqueOrThrow({ where: { id: codeId } }),
    prisma.discountCodeUsage.count({ where: { discountCodeId: codeId } }),
  ]);
  return { usedCount: code.totalUsedCount, usages };
}

describe.runIf(hasDb)("atomic discount consumption (wallet payments)", () => {
  it("total limit 1: two users paying concurrently -> exactly one succeeds", async () => {
    const code = await createCode({ totalUsageLimit: 1 });
    const [userA, userB] = await Promise.all([createUser(), createUser()]);

    // Two different users, two DISTINCT armed drafts racing the same code.
    const [draftA, draftB] = await Promise.all([
      armedDraft(userA.id, code.code),
      armedDraft(userB.id, code.code),
    ]);
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(userA, draftA),
      payPurchaseDraftWithWallet(userB, draftB),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok ? loser.error : "").toBe(DISCOUNT_CLAIM_FAILED_TEXT);

    const state = await codeState(code.id);
    expect(state.usedCount).toBe(1); // NEVER 2
    expect(state.usages).toBe(1);

    // The losing payment rolled back completely: no order, wallet untouched.
    const [freshA, freshB] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userA.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: userB.id } }),
    ]);
    const balances = [freshA.balanceToman, freshB.balanceToman].sort((x, y) => x - y);
    expect(balances).toEqual([BALANCE - FINAL, BALANCE]);
    const orders = await prisma.order.count({
      where: { userId: { in: [userA.id, userB.id] }, discountCodeId: code.id },
    });
    expect(orders).toBe(1);
  });

  it("per-user limit 1: the same user racing two payments -> only one usage", async () => {
    const code = await createCode({ perUserUsageLimit: 1 });
    const user = await createUser();

    // Same user racing two DISTINCT armed drafts (distinct reservations).
    const [draftA, draftB] = await Promise.all([
      armedDraft(user.id, code.code),
      armedDraft(user.id, code.code),
    ]);
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(user, draftA),
      payPurchaseDraftWithWallet(user, draftB),
    ]);

    expect([a, b].filter((r) => r.ok).length).toBe(1);
    const usages = await prisma.discountCodeUsage.count({
      where: { discountCodeId: code.id, userId: user.id },
    });
    expect(usages).toBe(1);
    expect((await codeState(code.id)).usedCount).toBe(1);
  });

  it("remaining usage 1 (limit 2, one already used): exactly one of two users wins", async () => {
    const code = await createCode({ totalUsageLimit: 2, totalUsedCount: 1 });
    const [userA, userB] = await Promise.all([createUser(), createUser()]);

    const [draftA, draftB] = await Promise.all([
      armedDraft(userA.id, code.code),
      armedDraft(userB.id, code.code),
    ]);
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(userA, draftA),
      payPurchaseDraftWithWallet(userB, draftB),
    ]);

    expect([a, b].filter((r) => r.ok).length).toBe(1);
    const state = await codeState(code.id);
    expect(state.usedCount).toBe(2); // NEVER 3
    expect(state.usages).toBe(1);
  });

  it("failed payment consumes no usage (rolls back with the claim)", async () => {
    const code = await createCode({ totalUsageLimit: 5 });
    // The passed user object claims a big balance, but the committed row has
    // nothing - the atomic deduction fails INSIDE the transaction, after the
    // discount rows would have been written.
    const broke = await createUser(0);
    const outcome = await payPurchaseDraftWithWallet(
      { ...broke, balanceToman: BALANCE },
      await armedDraft(broke.id, code.code),
    );
    expect(outcome.ok).toBe(false);

    const state = await codeState(code.id);
    expect(state.usedCount).toBe(0);
    expect(state.usages).toBe(0);
  });

  it("retried payment (same draft) never claims twice", async () => {
    const code = await createCode({ totalUsageLimit: 5 });
    const user = await createUser();
    const nonce = randomUUID();

    // Same draft retried: ONE reservation shared so the retry resolves via the
    // idempotency key, not a second claim.
    const draft = await armedDraft(user.id, code.code, nonce);
    const first = await payPurchaseDraftWithWallet(user, draft);
    expect(first.ok).toBe(true);
    const retry = await payPurchaseDraftWithWallet(user, draft);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.alreadyPaid).toBe(true);

    const state = await codeState(code.id);
    expect(state.usedCount).toBe(1);
    expect(state.usages).toBe(1);
  });

  it("concurrent idempotent duplicates (same draft) claim exactly once", async () => {
    const code = await createCode({ totalUsageLimit: 5 });
    const user = await createUser();
    const nonce = randomUUID();

    // Same draft fired concurrently: ONE shared armed draft (one reservation).
    const draft = await armedDraft(user.id, code.code, nonce);
    const [a, b] = await Promise.all([
      payPurchaseDraftWithWallet(user, draft),
      payPurchaseDraftWithWallet(user, draft),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const state = await codeState(code.id);
    expect(state.usedCount).toBe(1);
    expect(state.usages).toBe(1);
  });
});

describe.runIf(hasDb)("atomic discount consumption (receipt approval)", () => {
  let admin: Admin;

  beforeAll(async () => {
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 500_000n, role: "OWNER", isActive: true },
    });
  });

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { id: admin.id } }).catch(() => undefined);
  });

  async function createPendingReceiptPayment(
    user: User,
    discountCodeId: string,
  ): Promise<string> {
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        productId,
        orderType: "SERVICE_PURCHASE",
        productSnapshot: { productName: `atomic-discount-product-${runTag}` },
        originalPriceToman: PRICE,
        discountAmountToman: DISCOUNT,
        finalPriceToman: FINAL,
        discountCodeId,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        status: "PENDING_REVIEW",
        amountToman: FINAL,
        payableAmountToman: FINAL,
        receipts: {
          create: { userId: user.id, text: "receipt", status: "PENDING_REVIEW" },
        },
      },
    });
    return payment.id;
  }

  it("total limit 1: two concurrent approvals -> exactly one approves and claims", async () => {
    const code = await prisma.discountCode.create({
      data: {
        code: `ATOMR${runTag}`,
        type: "FIXED_AMOUNT",
        value: DISCOUNT,
        isActive: true,
        totalUsageLimit: 1,
      },
    });
    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { telegramId: runTag + 600_000n } }),
      prisma.user.create({ data: { telegramId: runTag + 600_001n } }),
    ]);
    const [paymentA, paymentB] = await Promise.all([
      createPendingReceiptPayment(userA, code.id),
      createPendingReceiptPayment(userB, code.id),
    ]);

    const [a, b] = await Promise.all([
      approveReceiptPayment(paymentA, admin),
      approveReceiptPayment(paymentB, admin),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok ? loser.error : "").toContain("کد تخفیف");

    const [freshCode, usages] = await Promise.all([
      prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } }),
      prisma.discountCodeUsage.count({ where: { discountCodeId: code.id } }),
    ]);
    expect(freshCode.totalUsedCount).toBe(1); // NEVER 2
    expect(usages).toBe(1);

    // The losing approval rolled back completely: its payment is still
    // PENDING_REVIEW so the admin can reject it with a reason.
    const loserPaymentId = a.ok ? paymentB : paymentA;
    const loserPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: loserPaymentId },
    });
    expect(loserPayment.status).toBe("PENDING_REVIEW");
  });

  it("double-approving the same payment keeps a single usage (idempotency)", async () => {
    const code = await prisma.discountCode.create({
      data: {
        code: `ATOMR2${runTag}`,
        type: "FIXED_AMOUNT",
        value: DISCOUNT,
        isActive: true,
        totalUsageLimit: 5,
      },
    });
    const user = await prisma.user.create({ data: { telegramId: runTag + 600_002n } });
    const paymentId = await createPendingReceiptPayment(user, code.id);

    const first = await approveReceiptPayment(paymentId, admin);
    expect(first.ok).toBe(true);
    const second = await approveReceiptPayment(paymentId, admin);
    expect(second.ok).toBe(false);

    const [freshCode, usages] = await Promise.all([
      prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } }),
      prisma.discountCodeUsage.count({ where: { discountCodeId: code.id } }),
    ]);
    expect(freshCode.totalUsedCount).toBe(1);
    expect(usages).toBe(1);
  });
});

describe.skipIf(hasDb)("atomic discount consumption (skipped)", () => {
  it("integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
