import {
  CheckoutStatus,
  OrderStatus,
  PanelStatus,
  PaymentStatus,
  prisma,
  ServiceStatus,
  UserStatus,
} from "@zedbot/database";
import {
  settleWalletOrder,
  settlementPayloadFingerprint,
  WALLET_ORDER_PAYMENT_REASON,
  type WalletSettlementArgs,
} from "@zedbot/service-renewal";
import {
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
} from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// WS — the one atomic wallet settlement.
//
// EVERY CASE HERE IS ABOUT MONEY BEING WRONG IN A WAY NOBODY NOTICES. Not
// "does the happy path work" — that is one test — but: can two clicks charge
// twice, can a retry after a price change turn a completed purchase into a
// failure, can a rolled-back settlement leave a debited balance with no order,
// can a suspended account still spend, can one checkout be paid for twice.
//
// THE CONCURRENCY CASES USE REAL PARALLEL TRANSACTIONS against real PostgreSQL.
// A mock cannot exhibit a lost update, a unique-index race or a row-lock
// ordering, and those are the only failure modes worth writing these tests for.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;
let seq = 0;

let panelId = "";
let categoryId = "";
let productId = "";

const userIds: string[] = [];
const serviceIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];
const panelIds: string[] = [];
const discountIds: string[] = [];

const enabled = async (): Promise<boolean> => true;
const disabled = async (): Promise<boolean> => false;

async function makeUser(balanceToman: number, overrides: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(`6${runTag}${(seq += 1)}`),
      firstName: `ws-${seq}`,
      balanceToman,
      group: "F",
      ...overrides,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeService(userId: string, label: string) {
  const service = await prisma.service.create({
    data: {
      userId,
      panelId,
      panelType: "MARZBAN",
      username: `ws-${runTag}-${label}`,
      status: ServiceStatus.ACTIVE,
      volumeBytes: 1_000_000n,
      usedBytes: 0n,
      remainingBytes: 1_000_000n,
      durationDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  serviceIds.push(service.id);
  return service;
}

/** A settlement request with everything the money depends on stated explicitly. */
function args(
  userId: string,
  overrides: Partial<WalletSettlementArgs> = {},
): WalletSettlementArgs {
  const finalPriceToman = overrides.finalPriceToman ?? 100_000;
  const discountAmountToman = overrides.discountAmountToman ?? 0;
  const originalPriceToman = overrides.originalPriceToman ?? finalPriceToman + discountAmountToman;
  return {
    userId,
    orderType: "SERVICE_RENEWAL",
    productId,
    serviceId: null,
    snapshot: {
      productId,
      productName: "ws-product",
      originalPriceToman,
      discountAmountToman,
      finalPriceToman,
    },
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
    discountCodeId: null,
    idempotencyKey: `ws-${runTag}-${(seq += 1)}-${Math.random().toString(36).slice(2, 10)}`,
    isWalletEnabled: enabled,
    ...overrides,
  };
}

async function ledgerFor(userId: string) {
  const [payments, orders, transactions] = await Promise.all([
    prisma.payment.count({ where: { userId } }),
    prisma.order.count({ where: { userId } }),
    prisma.walletTransaction.count({ where: { userId, reason: WALLET_ORDER_PAYMENT_REASON } }),
  ]);
  return { payments, orders, transactions };
}

async function balanceOf(userId: string): Promise<number> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { balanceToman: true },
  });
  return row.balanceToman;
}

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `ws-${runTag}`,
      baseUrl: `https://ws-${runTag}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      templateUsername: "template-user",
    },
  });
  panelIds.push(panel.id);
  panelId = panel.id;

  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `ws-${runTag}-cat`, isActive: true, displayOrder: 1 },
  });
  categoryIds.push(category.id);
  categoryId = category.id;

  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      name: `ws-${runTag}-product`,
      categoryId,
      panelId,
      priceToman: 100_000,
      durationDays: 30,
      volumeGb: 40,
      isActive: true,
      displayGroups: ["ALL"],
    },
  });
  productIds.push(product.id);
  productId = product.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.discountCodeUsage.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.checkoutSession.deleteMany({ where: { userId: { in: userIds } } });
  if (discountIds.length > 0) {
    await prisma.discountCode.deleteMany({ where: { id: { in: discountIds } } });
  }
  await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.productCategory.deleteMany({ where: { id: { in: categoryIds } } });
  await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe.skipIf(!hasDb)("shared wallet settlement", () => {
  // --- the money moves, exactly once ----------------------------------------

  // WS-1 ----------------------------------------------------------------------
  it("WS-1: sufficient balance settles and writes exactly one of each row", async () => {
    const user = await makeUser(500_000);
    const result = await settleWalletOrder(args(user.id, { finalPriceToman: 120_000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.alreadyPaid).toBe(false);
    expect(result.newBalanceToman).toBe(380_000);
    expect(await balanceOf(user.id)).toBe(380_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });

    // The ledger row states the exact before/after pair, not a recomputation.
    expect(result.walletTransaction.balanceBeforeToman).toBe(500_000);
    expect(result.walletTransaction.balanceAfterToman).toBe(380_000);
    expect(result.payment.status).toBe(PaymentStatus.APPROVED);
    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(result.checkout.status).toBe(CheckoutStatus.PAID);
    // The checkout records WHICH payment settled it, so a later gateway success
    // against the same checkout is a duplicate rather than a re-settle.
    expect(result.checkout.id).toBe(result.payment.checkoutSessionId);
  });

  // WS-2 ----------------------------------------------------------------------
  it("WS-2: an exact balance settles and lands on zero, never below", async () => {
    const user = await makeUser(75_000);
    const result = await settleWalletOrder(args(user.id, { finalPriceToman: 75_000 }));
    expect(result.ok).toBe(true);
    expect(await balanceOf(user.id)).toBe(0);
  });

  // WS-3 ----------------------------------------------------------------------
  it("WS-3: insufficient balance writes absolutely nothing", async () => {
    const user = await makeUser(9_999);
    const result = await settleWalletOrder(args(user.id, { finalPriceToman: 10_000 }));
    expect(result).toEqual({ ok: false, code: "INSUFFICIENT_BALANCE" });

    // The whole transaction rolled back: no checkout, no payment, no order, no
    // ledger row, and the balance untouched. A partial failure here is a user
    // whose money left without an order.
    expect(await balanceOf(user.id)).toBe(9_999);
    expect(await ledgerFor(user.id)).toEqual({ payments: 0, orders: 0, transactions: 0 });
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
  });

  // WS-4 ----------------------------------------------------------------------
  it("WS-4: a suspended account cannot spend, and nothing is written", async () => {
    const user = await makeUser(500_000, { status: UserStatus.BLOCKED });
    const result = await settleWalletOrder(args(user.id));
    expect(result).toEqual({ ok: false, code: "USER_NOT_ACTIVE" });
    expect(await balanceOf(user.id)).toBe(500_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 0, orders: 0, transactions: 0 });
  });

  // WS-5 ----------------------------------------------------------------------
  it("WS-5: the wallet kill switch stops a NEW settlement and writes nothing", async () => {
    const user = await makeUser(500_000);
    const result = await settleWalletOrder(args(user.id, { isWalletEnabled: disabled }));
    expect(result).toEqual({ ok: false, code: "WALLET_DISABLED" });
    expect(await balanceOf(user.id)).toBe(500_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 0, orders: 0, transactions: 0 });
  });

  // --- idempotency -----------------------------------------------------------

  // WS-6 ----------------------------------------------------------------------
  it("WS-6: a sequential identical retry returns the original result", async () => {
    const user = await makeUser(500_000);
    const request = args(user.id, { finalPriceToman: 60_000 });
    const first = await settleWalletOrder(request);
    const second = await settleWalletOrder(request);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.alreadyPaid).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.newBalanceToman).toBe(first.newBalanceToman);
    // One intent, one financial effect — not two.
    expect(await balanceOf(user.id)).toBe(440_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });
  });

  // WS-7 ----------------------------------------------------------------------
  it("WS-7: a replay still succeeds after balance, price and rollout change", async () => {
    const user = await makeUser(200_000);
    const request = args(user.id, { finalPriceToman: 150_000 });
    const first = await settleWalletOrder(request);
    expect(first.ok).toBe(true);

    // The world moves on, in all three ways that would break a naive
    // implementation that re-checked preconditions before resolving the replay.
    await prisma.user.update({ where: { id: user.id }, data: { balanceToman: 0 } });
    await prisma.product.update({ where: { id: productId }, data: { priceToman: 999_999 } });

    const replay = await settleWalletOrder({ ...request, isWalletEnabled: disabled });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    // A user whose network dropped mid-confirmation must not be told their
    // completed purchase failed — that is how they end up clicking again.
    expect(replay.alreadyPaid).toBe(true);
    expect(replay.order.id).toBe(first.order.id);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });

    await prisma.product.update({ where: { id: productId }, data: { priceToman: 100_000 } });
  });

  // WS-8 ----------------------------------------------------------------------
  it("WS-8: the same key with a DIFFERENT payload is a conflict, not a result", async () => {
    const user = await makeUser(500_000);
    const key = `ws-conflict-${runTag}-${(seq += 1)}`;
    const first = await settleWalletOrder(
      args(user.id, { idempotencyKey: key, finalPriceToman: 50_000 }),
    );
    expect(first.ok).toBe(true);

    // Same key, different amount. Returning the first result would hand the
    // caller a purchase they did not ask for; settling would charge twice for
    // one key.
    const conflicting = await settleWalletOrder(
      args(user.id, { idempotencyKey: key, finalPriceToman: 90_000 }),
    );
    expect(conflicting).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });
    expect(await balanceOf(user.id)).toBe(450_000);
  });

  // WS-9 ----------------------------------------------------------------------
  it("WS-9: the fingerprint moves with every field the money depends on", async () => {
    const base = {
      userId: "u",
      orderType: "SERVICE_RENEWAL" as const,
      productId: "p",
      serviceId: null,
      originalPriceToman: 100,
      discountAmountToman: 0,
      finalPriceToman: 100,
      discountCodeId: null,
    };
    const original = settlementPayloadFingerprint(base);
    const mutations: Array<Partial<typeof base>> = [
      { userId: "u2" },
      { orderType: "EXTRA_TIME" as const },
      { productId: "p2" },
      { serviceId: "s" },
      { originalPriceToman: 101 },
      { discountAmountToman: 1 },
      { finalPriceToman: 99 },
      { discountCodeId: "d" },
    ];
    for (const mutation of mutations) {
      expect(settlementPayloadFingerprint({ ...base, ...mutation })).not.toBe(original);
    }
    // ...and an identical request digests identically, or every honest retry
    // would read as a conflict.
    expect(settlementPayloadFingerprint(base)).toBe(original);
  });

  // WS-10 ---------------------------------------------------------------------
  it("WS-10: concurrent identical confirmations produce ONE financial effect", async () => {
    const user = await makeUser(1_000_000);
    const request = args(user.id, { finalPriceToman: 200_000 });

    // Six genuinely parallel calls with the same key. One wins the unique index;
    // the others must resolve to its result rather than failing or charging.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => settleWalletOrder({ ...request })),
    );
    for (const result of results) {
      expect(result.ok).toBe(true);
    }
    const orderIds = new Set(results.map((r) => (r.ok ? r.order.id : "x")));
    expect(orderIds.size).toBe(1);

    expect(await balanceOf(user.id)).toBe(800_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });
  });

  // WS-11 ---------------------------------------------------------------------
  it("WS-11: concurrent DIFFERENT intents cannot overspend one wallet", async () => {
    // The balance covers exactly one of the two. This is the case a
    // read-then-write deduction gets wrong: both read 150_000, both think they
    // can afford 150_000, and the account ends at -150_000.
    const user = await makeUser(150_000);
    const [a, b] = await Promise.all([
      settleWalletOrder(args(user.id, { finalPriceToman: 150_000 })),
      settleWalletOrder(args(user.id, { finalPriceToman: 150_000 })),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ ok: false, code: "INSUFFICIENT_BALANCE" });

    expect(await balanceOf(user.id)).toBe(0);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });
  });

  // WS-12 ---------------------------------------------------------------------
  it("WS-12: a balance can never go negative under heavy contention", async () => {
    const user = await makeUser(300_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => settleWalletOrder(args(user.id, { finalPriceToman: 100_000 }))),
    );
    const settled = results.filter((r) => r.ok).length;
    // Ten different intents, funds for three.
    expect(settled).toBe(3);
    const balance = await balanceOf(user.id);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await ledgerFor(user.id)).toEqual({ payments: 3, orders: 3, transactions: 3 });
  });

  // --- one checkout, one payment --------------------------------------------

  // WS-13 ---------------------------------------------------------------------
  it("WS-13: two different keys cannot settle one existing checkout twice", async () => {
    const user = await makeUser(1_000_000);
    const service = await makeService(user.id, "twice");
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        productId,
        serviceId: service.id,
        orderType: "SERVICE_RENEWAL",
        productSnapshot: { productId, productName: "ws" },
        originalPriceToman: 80_000,
        discountAmountToman: 0,
        finalPriceToman: 80_000,
        status: CheckoutStatus.PENDING,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const base = args(user.id, {
      finalPriceToman: 80_000,
      serviceId: service.id,
      existingCheckoutId: checkout.id,
    });
    const first = await settleWalletOrder({ ...base, idempotencyKey: `${base.idempotencyKey}-a` });
    expect(first.ok).toBe(true);

    // A second, genuinely different intent against the SAME checkout. The CAS
    // guard requires status PENDING and settledByPaymentId null, both of which
    // the first settlement consumed.
    const second = await settleWalletOrder({ ...base, idempotencyKey: `${base.idempotencyKey}-b` });
    expect(second).toEqual({ ok: false, code: "DRAFT_STALE" });

    expect(await balanceOf(user.id)).toBe(920_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 1, orders: 1, transactions: 1 });
  });

  // WS-14 ---------------------------------------------------------------------
  it("WS-14: an expired checkout cannot be settled, but a settled one still replays", async () => {
    const user = await makeUser(1_000_000);
    const expired = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        productId,
        orderType: "SERVICE_RENEWAL",
        productSnapshot: { productId },
        originalPriceToman: 10_000,
        discountAmountToman: 0,
        finalPriceToman: 10_000,
        status: CheckoutStatus.PENDING,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const stale = await settleWalletOrder(
      args(user.id, { finalPriceToman: 10_000, existingCheckoutId: expired.id }),
    );
    expect(stale).toEqual({ ok: false, code: "DRAFT_STALE" });
    expect(await balanceOf(user.id)).toBe(1_000_000);

    // A checkout that DID settle keeps replaying even once its own expiry has
    // passed — the money moved, and the expiry describes the offer, not the
    // receipt.
    const request = args(user.id, { finalPriceToman: 30_000 });
    const settled = await settleWalletOrder(request);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    await prisma.checkoutSession.update({
      where: { id: settled.checkout.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const replay = await settleWalletOrder(request);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.alreadyPaid).toBe(true);
      expect(replay.order.id).toBe(settled.order.id);
    }
  });

  // WS-15 ---------------------------------------------------------------------
  it("WS-15: a rejected reservation aborts everything before the money moves", async () => {
    const user = await makeUser(400_000);
    const result = await settleWalletOrder(
      args(user.id, {
        finalPriceToman: 100_000,
        claimReservation: async () => false,
      }),
    );
    expect(result).toEqual({ ok: false, code: "RESERVATION_STALE" });
    // The claim runs BEFORE the deduction precisely so a stale hold costs the
    // buyer nothing.
    expect(await balanceOf(user.id)).toBe(400_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 0, orders: 0, transactions: 0 });
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
  });

  // --- discounts -------------------------------------------------------------

  // WS-16 ---------------------------------------------------------------------
  it("WS-16: a discount is claimed exactly once, inside the settlement", async () => {
    const user = await makeUser(500_000);
    const code = await prisma.discountCode.create({
      data: {
        code: `WS${runTag}CLAIM`.slice(0, 30),
        type: "PERCENT",
        value: 10,
        isActive: true,
        appliesTo: "BOTH",
        totalUsageLimit: 5,
      },
    });
    discountIds.push(code.id);

    const request = args(user.id, {
      originalPriceToman: 100_000,
      discountAmountToman: 10_000,
      finalPriceToman: 90_000,
      discountCodeId: code.id,
    });
    const first = await settleWalletOrder(request);
    expect(first.ok).toBe(true);
    expect(await balanceOf(user.id)).toBe(410_000);

    const usages = await prisma.discountCodeUsage.count({ where: { discountCodeId: code.id } });
    expect(usages).toBe(1);
    const after = await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(after.totalUsedCount).toBe(1);

    // A replay must not consume a second usage.
    const replay = await settleWalletOrder(request);
    expect(replay.ok).toBe(true);
    expect(await prisma.discountCodeUsage.count({ where: { discountCodeId: code.id } })).toBe(1);
  });

  // WS-17 ---------------------------------------------------------------------
  it("WS-17: an exhausted discount aborts the settlement and refunds nothing", async () => {
    const user = await makeUser(500_000);
    const code = await prisma.discountCode.create({
      data: {
        code: `WS${runTag}EXH`.slice(0, 30),
        type: "PERCENT",
        value: 10,
        isActive: true,
        appliesTo: "BOTH",
        totalUsageLimit: 1,
        totalUsedCount: 1,
      },
    });
    discountIds.push(code.id);

    const result = await settleWalletOrder(
      args(user.id, {
        originalPriceToman: 100_000,
        discountAmountToman: 10_000,
        finalPriceToman: 90_000,
        discountCodeId: code.id,
      }),
    );
    expect(result).toEqual({ ok: false, code: "DISCOUNT_CHANGED" });
    // The claim is inside the transaction, so its failure takes the deduction,
    // the order and the payment with it. A discounted price can never settle
    // without its claimed usage.
    expect(await balanceOf(user.id)).toBe(500_000);
    expect(await ledgerFor(user.id)).toEqual({ payments: 0, orders: 0, transactions: 0 });
  });

  // --- low balance -----------------------------------------------------------

  // WS-18 ---------------------------------------------------------------------
  it("WS-18: settlement runs the low-balance state machine, as every wallet path does", async () => {
    // Turn the feature on with a threshold the settlement will cross.
    //
    // The keys come from the shared constants, never from string literals. An
    // earlier version of this case spelled them by hand, got them wrong, and
    // still PASSED locally — because the bot's own low-balance suite had left
    // the real rows enabled in the shared test database. CI, with a fresh
    // database, is what caught it. A test that depends on another suite's
    // leftovers is not testing what it says it tests.
    for (const [key, value] of [
      [LOW_BALANCE_ENABLED_KEY, "true"],
      [LOW_BALANCE_THRESHOLD_KEY, "50000"],
      [LOW_BALANCE_REARM_MARGIN_KEY, "10000"],
    ] as const) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value, type: "BOOLEAN", isPublic: false },
      });
    }
    try {
      const user = await makeUser(100_000);
      const result = await settleWalletOrder(args(user.id, { finalPriceToman: 80_000 }));
      expect(result.ok).toBe(true);

      // A Mini App settlement that skipped the observer would be the first
      // wallet path in the codebase that does not, and the user would silently
      // stop receiving low-balance warnings depending on which door they used.
      const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user.id } });
      expect(state).not.toBeNull();
    } finally {
      await prisma.setting.deleteMany({
        where: {
          key: {
            in: [
              LOW_BALANCE_ENABLED_KEY,
              LOW_BALANCE_THRESHOLD_KEY,
              LOW_BALANCE_REARM_MARGIN_KEY,
            ],
          },
        },
      });
    }
  });

  // WS-19 ---------------------------------------------------------------------
  it("WS-19: the ledger's before/after pair is exact and self-consistent", async () => {
    const user = await makeUser(333_333);
    const result = await settleWalletOrder(args(user.id, { finalPriceToman: 111_111 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tx = result.walletTransaction;
    // Whole Toman throughout: no float, no rounding, and the arithmetic on the
    // ledger row closes exactly.
    expect(tx.balanceBeforeToman - tx.amountToman).toBe(tx.balanceAfterToman);
    expect(tx.balanceAfterToman).toBe(await balanceOf(user.id));
    expect(Number.isInteger(tx.amountToman)).toBe(true);
  });
});
