import {
  CheckoutStatus,
  DiscountType,
  OrderStatus,
  OrderType,
  PaymentSettlementStatus,
  PaymentStatus,
  prisma,
  type CheckoutSession,
  type User,
} from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "cross-provider-settlement-tests-01";

import {
  recordProviderSuccessFromBot,
  settleGatewayPayment,
  type SettleOutcome,
} from "../src/services/gateway-payment.service.js";
import {
  DUPLICATE_SUCCESS_ADMIN_HEADER,
  DUPLICATE_SUCCESS_USER_TEXT,
  notifyDuplicateSuccessCase,
  recordDuplicateSuccess,
} from "../src/services/financial-reconciliation.service.js";

// =============================================================================
// P0 cross-provider settlement: one Checkout paid successfully through TWO
// different providers must produce exactly ONE local financial settlement.
//
// RACE REPRO (this describe block was written FIRST, against the pre-fix
// code, and failed exactly as the incident report predicts):
//   - order purchase: the losing payment silently REUSED the winner's order
//     and became APPROVED - a double charge with no visible resolution;
//   - wallet charge: the losing payment aborted with an error and stayed
//     PENDING+SUCCESS forever - stranded external money the sweep retried
//     in an endless loop.
// After the fix, the atomic checkout claim (settledByPaymentId) makes one
// payment the owner and files the other as DUPLICATE_SUCCESS_REVIEW with a
// financial reconciliation case.
//
// Requires real PostgreSQL + Redis (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 60_000;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

async function createUser(balanceToman = 0): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), balanceToman } });
}

async function createCheckout(
  user: User,
  purpose: "ORDER_PAYMENT" | "WALLET_CHARGE",
  extra: { discountCodeId?: string; discountAmountToman?: number } = {},
): Promise<CheckoutSession> {
  const discount = extra.discountAmountToman ?? 0;
  return prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose,
      ...(purpose === "ORDER_PAYMENT"
        ? {
            orderType: "SERVICE_PURCHASE",
            productSnapshot: {
              productName: `xps-prod-${runTag}`,
              originalPriceToman: PRICE + discount,
              durationDays: 30,
              volumeGb: 10,
            },
          }
        : {}),
      originalPriceToman: PRICE + discount,
      discountAmountToman: discount,
      finalPriceToman: PRICE,
      ...(extra.discountCodeId !== undefined ? { discountCodeId: extra.discountCodeId } : {}),
      status: CheckoutStatus.PENDING,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

/** A gateway Payment whose provider SUCCESS is already recorded (the state
 * the IPN/callback/Stars recorder leaves behind). Overrides let single tests
 * shape pre-success / legacy / failed rows. */
async function createSuccessfulPayment(
  user: User,
  checkout: CheckoutSession,
  provider: "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS",
  purpose: "ORDER_PAYMENT" | "WALLET_CHARGE",
  overrides: {
    status?: PaymentStatus;
    providerStatus?: string | null;
    externalTransactionId?: string | null;
    settlementStatus?: PaymentSettlementStatus;
    paidAt?: Date;
  } = {},
): Promise<string> {
  seq += 1;
  const providerStatus =
    overrides.providerStatus === undefined ? "SUCCESS" : overrides.providerStatus;
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose,
      status: overrides.status ?? PaymentStatus.PENDING,
      amountToman: PRICE,
      payableAmountToman: PRICE,
      provider,
      authority: `xps-${provider}-${runTag}-${seq}`,
      providerStatus,
      ...(providerStatus === "SUCCESS" ? { verifiedAt: new Date() } : {}),
      ...(overrides.externalTransactionId !== undefined
        ? overrides.externalTransactionId === null
          ? {}
          : { externalTransactionId: overrides.externalTransactionId }
        : { externalTransactionId: `ext-${provider}-${runTag}-${seq}` }),
      idempotencyKey: `xps:${checkout.id}:${provider}:${seq}`,
      ...(overrides.settlementStatus !== undefined
        ? { settlementStatus: overrides.settlementStatus }
        : {}),
      ...(overrides.paidAt !== undefined ? { paidAt: overrides.paidAt } : {}),
    },
  });
  return payment.id;
}

afterAll(async () => {
  if (hasDb) {
    await prisma.$disconnect();
  }
});

// =============================================================================
// RACE REPRO - written before the fix; these assertions encode the REQUIRED
// post-fix invariant and FAILED on the pre-fix code.
// =============================================================================

describe.runIf(hasDb)("RACE REPRO: two providers settle one checkout concurrently", () => {
  it("R1. ORDER purchase: exactly one settlement, one order, one duplicate review", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const zarinpalId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");
    const nowpaymentsId = await createSuccessfulPayment(
      user,
      checkout,
      "NOWPAYMENTS",
      "ORDER_PAYMENT",
    );

    const [a, b] = await Promise.all([
      settleGatewayPayment(zarinpalId),
      settleGatewayPayment(nowpaymentsId),
    ]);

    const outcomes = [a, b].map((o) => o.kind).sort();
    // Exactly one settles; the other is a visible duplicate - never a second
    // settlement, never an invisible error.
    expect(outcomes).toEqual(["duplicate", "settled"]);

    // Both provider successes stay truthfully recorded.
    const payments = await prisma.payment.findMany({
      where: { id: { in: [zarinpalId, nowpaymentsId] } },
    });
    expect(payments.every((p) => p.providerStatus === "SUCCESS")).toBe(true);

    // Exactly one payment owns the checkout; exactly one order exists.
    const freshCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(freshCheckout.status).toBe(CheckoutStatus.PAID);
    expect(freshCheckout.settledByPaymentId).not.toBeNull();
    expect([zarinpalId, nowpaymentsId]).toContain(freshCheckout.settledByPaymentId);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);

    // Winner SETTLED+APPROVED; loser DUPLICATE_SUCCESS_REVIEW, not APPROVED.
    const winner = payments.find((p) => p.id === freshCheckout.settledByPaymentId);
    const loser = payments.find((p) => p.id !== freshCheckout.settledByPaymentId);
    expect(winner?.status).toBe(PaymentStatus.APPROVED);
    expect(winner?.settlementStatus).toBe("SETTLED");
    expect(loser?.settlementStatus).toBe("DUPLICATE_SUCCESS_REVIEW");
    expect(loser?.status).not.toBe(PaymentStatus.APPROVED);
    expect(loser?.status).not.toBe(PaymentStatus.FAILED);
    expect(loser?.orderId).toBeNull(); // the loser never touches the order

    // Exactly one reconciliation case, keyed by the duplicate payment.
    const cases = await prisma.financialReconciliationCase.findMany({
      where: { checkoutSessionId: checkout.id },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].duplicatePaymentId).toBe(loser?.id);
    expect(cases[0].primaryPaymentId).toBe(winner?.id);
    expect(cases[0].status).toBe("OPEN");

    // No wallet mutation for an order purchase.
    expect(
      await prisma.walletTransaction.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(0);
  });

  it("R2. WALLET charge: wallet credited exactly once, duplicate visible", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "WALLET_CHARGE");
    const zarinpalId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "WALLET_CHARGE");
    const starsId = await createSuccessfulPayment(
      user,
      checkout,
      "TELEGRAM_STARS",
      "WALLET_CHARGE",
    );

    const [a, b] = await Promise.all([
      settleGatewayPayment(zarinpalId),
      settleGatewayPayment(starsId),
    ]);
    expect([a, b].map((o) => o.kind).sort()).toEqual(["duplicate", "settled"]);

    // Wallet credited EXACTLY once.
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.balanceToman).toBe(PRICE);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, type: "CHARGE" },
      }),
    ).toBe(1);

    // One owner, one visible duplicate case, no stranded invisible payment.
    const freshCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(freshCheckout.settledByPaymentId).not.toBeNull();
    const payments = await prisma.payment.findMany({
      where: { id: { in: [zarinpalId, starsId] } },
    });
    expect(payments.every((p) => p.providerStatus === "SUCCESS")).toBe(true);
    const loser = payments.find((p) => p.id !== freshCheckout.settledByPaymentId);
    expect(loser?.settlementStatus).toBe("DUPLICATE_SUCCESS_REVIEW");
    expect(
      await prisma.financialReconciliationCase.count({
        where: { duplicatePaymentId: loser?.id ?? "" },
      }),
    ).toBe(1);
  });
});

// =============================================================================
// CONCURRENCY MATRIX (3-5)
// =============================================================================

describe.runIf(hasDb)("CONCURRENCY: provider pairs and repetition (3-5)", () => {
  it("3. Stars + Zarinpal race: one settlement, one duplicate review", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const starsId = await createSuccessfulPayment(
      user,
      checkout,
      "TELEGRAM_STARS",
      "ORDER_PAYMENT",
    );
    const zarinpalId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");

    const [a, b] = await Promise.all([
      settleGatewayPayment(starsId),
      settleGatewayPayment(zarinpalId),
    ]);
    expect([a, b].map((o) => o.kind).sort()).toEqual(["duplicate", "settled"]);

    const freshCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect([starsId, zarinpalId]).toContain(freshCheckout.settledByPaymentId);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
    const payments = await prisma.payment.findMany({
      where: { id: { in: [starsId, zarinpalId] } },
    });
    // Both real charges stay truthfully recorded - SUCCESS is never downgraded.
    expect(payments.every((p) => p.providerStatus === "SUCCESS")).toBe(true);
    expect(payments.every((p) => p.status !== PaymentStatus.FAILED)).toBe(true);
    expect(
      await prisma.financialReconciliationCase.count({
        where: { checkoutSessionId: checkout.id },
      }),
    ).toBe(1);
  });

  it(
    "4. the SAME payment delivered 20x concurrently settles exactly once",
    { timeout: 60_000 },
    async () => {
      const user = await createUser();
      const checkout = await createCheckout(user, "ORDER_PAYMENT");
      const paymentId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => settleGatewayPayment(paymentId)),
      );
      const kinds = outcomes.map((o) => o.kind);
      // Exactly one "settled"; every replay resolves to "already" - never a
      // duplicate case (same payment = same owner), never an error.
      expect(kinds.filter((k) => k === "settled")).toHaveLength(1);
      expect(kinds.filter((k) => k === "already")).toHaveLength(19);

      expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
      const stats = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stats.ordersCount).toBe(1);
      expect(stats.paidOrdersCount).toBe(1);
      expect(stats.totalPurchaseAmountToman).toBe(PRICE);
      expect(
        await prisma.financialReconciliationCase.count({
          where: { checkoutSessionId: checkout.id },
        }),
      ).toBe(0);
    },
  );

  it(
    "5. two-provider race repeated 20x: the invariant holds every time",
    { timeout: 120_000 },
    async () => {
      const pairs: Array<["ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS", "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS"]> = [
        ["ZARINPAL", "NOWPAYMENTS"],
        ["ZARINPAL", "TELEGRAM_STARS"],
        ["NOWPAYMENTS", "TELEGRAM_STARS"],
      ];
      for (let i = 0; i < 20; i += 1) {
        const [p1, p2] = pairs[i % pairs.length];
        const user = await createUser();
        const checkout = await createCheckout(user, "ORDER_PAYMENT");
        const id1 = await createSuccessfulPayment(user, checkout, p1, "ORDER_PAYMENT");
        const id2 = await createSuccessfulPayment(user, checkout, p2, "ORDER_PAYMENT");

        const [a, b] = await Promise.all([settleGatewayPayment(id1), settleGatewayPayment(id2)]);
        expect([a, b].map((o) => o.kind).sort(), `iteration ${i} (${p1}+${p2})`).toEqual([
          "duplicate",
          "settled",
        ]);
        expect(
          await prisma.order.count({ where: { checkoutSessionId: checkout.id } }),
          `iteration ${i} orders`,
        ).toBe(1);
        const cases = await prisma.financialReconciliationCase.findMany({
          where: { checkoutSessionId: checkout.id },
        });
        expect(cases, `iteration ${i} cases`).toHaveLength(1);
        const loser = await prisma.payment.findUniqueOrThrow({
          where: { id: cases[0].duplicatePaymentId },
        });
        expect(loser.status, `iteration ${i} loser status`).not.toBe(PaymentStatus.APPROVED);
        expect(loser.providerStatus, `iteration ${i} loser provider`).toBe("SUCCESS");
      }
    },
  );
});

// =============================================================================
// SEQUENTIAL DUPLICATES + CRASH RECOVERY (6-8)
// =============================================================================

describe.runIf(hasDb)("SEQUENTIAL duplicates and crash windows (6-8)", () => {
  it("6. a DELAYED second success (no race) goes to review; retries converge on ONE case", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const firstId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");

    const first = await settleGatewayPayment(firstId);
    expect(first.kind).toBe("settled");

    // The second provider's callback arrives minutes later.
    const secondId = await createSuccessfulPayment(user, checkout, "NOWPAYMENTS", "ORDER_PAYMENT");
    const second = await settleGatewayPayment(secondId);
    expect(second.kind).toBe("duplicate");
    if (second.kind !== "duplicate") {
      return;
    }
    expect(second.created).toBe(true);
    expect(second.reconciliationCase.primaryPaymentId).toBe(firstId);
    expect(second.reconciliationCase.duplicatePaymentId).toBe(secondId);
    expect(second.reconciliationCase.expectedAmountToman).toBe(PRICE);

    // Sweep/button retries: SAME case, created=false - notify exactly once.
    const retry = await settleGatewayPayment(secondId);
    expect(retry.kind).toBe("duplicate");
    if (retry.kind === "duplicate") {
      expect(retry.created).toBe(false);
      expect(retry.reconciliationCase.id).toBe(second.reconciliationCase.id);
    }
    expect(
      await prisma.financialReconciliationCase.count({
        where: { checkoutSessionId: checkout.id },
      }),
    ).toBe(1);

    // The duplicate never provisioned or failed: provider truth intact.
    const loser = await prisma.payment.findUniqueOrThrow({ where: { id: secondId } });
    expect(loser.providerStatus).toBe("SUCCESS");
    expect(loser.status).not.toBe(PaymentStatus.APPROVED);
    expect(loser.status).not.toBe(PaymentStatus.FAILED);
    expect(loser.orderId).toBeNull();
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
  });

  it("7. crash window: checkout claimed but payment flip lost - the owner's retry completes", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const paymentId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");

    // Simulate the half-settled shape (claim recorded, payment not flipped) -
    // in the real code both live in ONE transaction, but the settle path must
    // still recover if such a row ever exists (legacy writers, manual fixes).
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: {
        settledByPaymentId: paymentId,
        status: CheckoutStatus.PAID,
        paidAt: new Date(),
      },
    });

    const outcome = await settleGatewayPayment(paymentId);
    // The claim CAS matches 0 rows, but the re-read shows THIS payment owns
    // the checkout - settlement continues idempotently instead of filing a
    // false duplicate.
    expect(outcome.kind).toBe("settled");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentStatus.APPROVED);
    expect(payment.settlementStatus).toBe(PaymentSettlementStatus.SETTLED);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
    expect(
      await prisma.financialReconciliationCase.count({
        where: { checkoutSessionId: checkout.id },
      }),
    ).toBe(0);
  });

  it("8. Order.checkoutSessionId is DB-unique; an existing order is reused, never doubled", async () => {
    const user = await createUser();
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const paymentId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");

    // A pre-existing order for this checkout (legacy writer shape).
    const legacy = await prisma.order.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        type: OrderType.SERVICE_PURCHASE,
        status: OrderStatus.PAID,
        originalPriceToman: PRICE,
        discountAmountToman: 0,
        finalPriceToman: PRICE,
        paidAt: new Date(),
      },
    });

    const outcome = await settleGatewayPayment(paymentId);
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.order?.id).toBe(legacy.id);
    }
    // Linked, not duplicated - and stats did NOT double-count the order.
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.orderId).toBe(legacy.id);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
    const stats = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stats.ordersCount).toBe(0);
    expect(stats.paidOrdersCount).toBe(0);

    // The DB constraint itself: a second order for the same checkout is
    // impossible no matter which code path tries.
    await expect(
      prisma.order.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          type: OrderType.SERVICE_PURCHASE,
          status: OrderStatus.PAID,
          originalPriceToman: PRICE,
          discountAmountToman: 0,
          finalPriceToman: PRICE,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

// =============================================================================
// DISCOUNT + PROVIDER-EVIDENCE UNIQUENESS (9-10)
// =============================================================================

describe.runIf(hasDb)("DISCOUNT and external-evidence uniqueness (9-10)", () => {
  it("9. a discounted checkout consumes its code EXACTLY once under a settle race", async () => {
    const user = await createUser();
    seq += 1;
    const code = await prisma.discountCode.create({
      data: {
        code: `xps-code-${runTag}-${seq}`,
        type: DiscountType.FIXED_AMOUNT,
        value: 10_000,
        isActive: true,
      },
    });
    const checkout = await createCheckout(user, "ORDER_PAYMENT", {
      discountCodeId: code.id,
      discountAmountToman: 10_000,
    });
    const id1 = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");
    const id2 = await createSuccessfulPayment(user, checkout, "NOWPAYMENTS", "ORDER_PAYMENT");

    const [a, b] = await Promise.all([settleGatewayPayment(id1), settleGatewayPayment(id2)]);
    expect([a, b].map((o) => o.kind).sort()).toEqual(["duplicate", "settled"]);

    // One usage row, one counted use - the loser never reached the discount.
    expect(
      await prisma.discountCodeUsage.count({ where: { checkoutSessionId: checkout.id } }),
    ).toBe(1);
    const freshCode = await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(freshCode.totalUsedCount).toBe(1);

    // And the DB backstop: a second usage row for this checkout is impossible.
    await expect(
      prisma.discountCodeUsage.create({
        data: {
          discountCodeId: code.id,
          userId: user.id,
          checkoutSessionId: checkout.id,
          amountToman: 10_000,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("10. a provider transaction id can never attach to a SECOND payment of that provider", async () => {
    const user = await createUser();
    const checkoutX = await createCheckout(user, "ORDER_PAYMENT");
    const checkoutY = await createCheckout(user, "ORDER_PAYMENT");
    const checkoutZ = await createCheckout(user, "ORDER_PAYMENT");
    seq += 1;
    const sharedExtId = `xps-shared-ext-${runTag}-${seq}`;
    const xId = await createSuccessfulPayment(user, checkoutX, "ZARINPAL", "ORDER_PAYMENT", {
      externalTransactionId: sharedExtId,
    });
    // Y: same provider, NO provider evidence yet.
    const yId = await createSuccessfulPayment(user, checkoutY, "ZARINPAL", "ORDER_PAYMENT", {
      providerStatus: null,
      externalTransactionId: null,
    });

    // A replayed/forged event reusing X's transaction id is refused entirely:
    // no SUCCESS lands on Y, nothing crashes.
    await recordProviderSuccessFromBot(yId, {
      transactionId: sharedExtId,
      sanitizedPayload: { replayed: true },
    });
    const y = await prisma.payment.findUniqueOrThrow({ where: { id: yId } });
    expect(y.providerStatus).toBeNull();
    expect(y.verifiedAt).toBeNull();
    expect(y.externalTransactionId).toBeNull();
    // Without recorded SUCCESS, Y can never settle (NOWPayments/Stars-style
    // rows wait for their IPN; Zarinpal would re-verify against the provider,
    // which is not configured here - the outcome stays non-settling).
    const yOutcome = await settleGatewayPayment(yId);
    expect(yOutcome.kind).toBe("pending");
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutY.id } }))
        .settledByPaymentId,
    ).toBeNull();

    // Direct DB writes hit the same wall.
    await expect(
      prisma.payment.update({
        where: { id: yId },
        data: { externalTransactionId: sharedExtId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // A DIFFERENT provider may carry the same external id (per-provider scope).
    const zId = await createSuccessfulPayment(user, checkoutZ, "NOWPAYMENTS", "ORDER_PAYMENT", {
      providerStatus: null,
      externalTransactionId: null,
    });
    await recordProviderSuccessFromBot(zId, { transactionId: sharedExtId });
    const z = await prisma.payment.findUniqueOrThrow({ where: { id: zId } });
    expect(z.providerStatus).toBe("SUCCESS");
    expect(z.externalTransactionId).toBe(sharedExtId);

    // X is untouched by all of the above.
    const x = await prisma.payment.findUniqueOrThrow({ where: { id: xId } });
    expect(x.providerStatus).toBe("SUCCESS");
    expect(x.externalTransactionId).toBe(sharedExtId);
  });
});

// =============================================================================
// TRUST BOUNDARY (11)
// =============================================================================

describe.runIf(hasDb)("TRUST BOUNDARY: only recorded provider SUCCESS settles (11)", () => {
  it("11. no SUCCESS, UNKNOWN, or terminal-failed payments never settle or claim", async () => {
    const user = await createUser();

    // (a) No provider event at all -> pending, checkout unclaimed.
    const c1 = await createCheckout(user, "ORDER_PAYMENT");
    const p1 = await createSuccessfulPayment(user, c1, "NOWPAYMENTS", "ORDER_PAYMENT", {
      providerStatus: null,
      externalTransactionId: null,
    });
    expect((await settleGatewayPayment(p1)).kind).toBe("pending");

    // (b) UNKNOWN provider status is NOT success -> pending.
    const c2 = await createCheckout(user, "ORDER_PAYMENT");
    const p2 = await createSuccessfulPayment(user, c2, "TELEGRAM_STARS", "ORDER_PAYMENT", {
      providerStatus: "UNKNOWN",
      externalTransactionId: null,
    });
    expect((await settleGatewayPayment(p2)).kind).toBe("pending");

    // (c) Terminal failed statuses answer "failed" and never touch money.
    const c3 = await createCheckout(user, "ORDER_PAYMENT");
    const p3 = await createSuccessfulPayment(user, c3, "NOWPAYMENTS", "ORDER_PAYMENT", {
      status: PaymentStatus.FAILED,
      providerStatus: "FAILED",
      externalTransactionId: null,
    });
    expect((await settleGatewayPayment(p3)).kind).toBe("failed");

    for (const checkoutId of [c1.id, c2.id, c3.id]) {
      const fresh = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutId } });
      expect(fresh.status).toBe(CheckoutStatus.PENDING);
      expect(fresh.settledByPaymentId).toBeNull();
      expect(await prisma.order.count({ where: { checkoutSessionId: checkoutId } })).toBe(0);
    }
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(0);
  });
});

// =============================================================================
// MIGRATION BACKFILL (12) - the exact statements shipped in
// 20260715062734_atomic_checkout_settlement, validated against seeded
// legacy-shaped fixtures. Test 13 (admin UI security) lives in
// financial-reconciliation-ui.test.ts.
// =============================================================================

describe.runIf(hasDb)("MIGRATION backfill semantics (12)", () => {
  it("12. unambiguous owners are backfilled; ambiguous rows are left for audit; nothing is deleted", async () => {
    const user = await createUser();
    const paidAt = new Date("2026-01-15T10:00:00Z");

    // Legacy shape A: settled checkout, exactly ONE approved payment.
    const cUnambiguous = await createCheckout(user, "ORDER_PAYMENT");
    const pOwner = await createSuccessfulPayment(user, cUnambiguous, "ZARINPAL", "ORDER_PAYMENT", {
      status: PaymentStatus.APPROVED,
      settlementStatus: PaymentSettlementStatus.UNSETTLED,
      paidAt,
    });
    await prisma.checkoutSession.update({
      where: { id: cUnambiguous.id },
      data: { status: CheckoutStatus.PAID, paidAt },
    });

    // Legacy shape B: pre-fix double-settle victim - TWO approved payments.
    const cAmbiguous = await createCheckout(user, "ORDER_PAYMENT");
    const pDup1 = await createSuccessfulPayment(user, cAmbiguous, "ZARINPAL", "ORDER_PAYMENT", {
      status: PaymentStatus.APPROVED,
      settlementStatus: PaymentSettlementStatus.UNSETTLED,
    });
    const pDup2 = await createSuccessfulPayment(user, cAmbiguous, "NOWPAYMENTS", "ORDER_PAYMENT", {
      status: PaymentStatus.APPROVED,
      settlementStatus: PaymentSettlementStatus.UNSETTLED,
    });
    await prisma.checkoutSession.update({
      where: { id: cAmbiguous.id },
      data: { status: CheckoutStatus.COMPLETED, paidAt },
    });

    // Live shape: PENDING checkout with an un-settled payment - untouched.
    const cPending = await createCheckout(user, "ORDER_PAYMENT");
    const pPending = await createSuccessfulPayment(user, cPending, "NOWPAYMENTS", "ORDER_PAYMENT", {
      providerStatus: null,
      externalTransactionId: null,
    });

    const paymentsBefore = await prisma.payment.count({ where: { userId: user.id } });

    // THE MIGRATION'S BACKFILL STATEMENTS, VERBATIM (both are idempotent and
    // scoped so re-running them on a live database is safe).
    await prisma.$executeRawUnsafe(`
      UPDATE "Payment"
      SET "settlementStatus" = 'SETTLED',
          "settledAt" = COALESCE("paidAt", "updatedAt")
      WHERE "status" = 'APPROVED';
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "CheckoutSession" AS c
      SET "settledByPaymentId" = single."paymentId"
      FROM (
        SELECT "checkoutSessionId", MIN("id") AS "paymentId"
        FROM "Payment"
        WHERE "status" = 'APPROVED' AND "checkoutSessionId" IS NOT NULL
        GROUP BY "checkoutSessionId"
        HAVING COUNT(*) = 1
      ) AS single
      WHERE c."id" = single."checkoutSessionId"
        AND c."status" IN ('PAID', 'COMPLETED')
        AND c."settledByPaymentId" IS NULL;
    `);

    // Unambiguous: the single approved payment becomes the recorded owner.
    const unambiguous = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: cUnambiguous.id },
    });
    expect(unambiguous.settledByPaymentId).toBe(pOwner);
    const owner = await prisma.payment.findUniqueOrThrow({ where: { id: pOwner } });
    expect(owner.settlementStatus).toBe(PaymentSettlementStatus.SETTLED);
    expect(owner.settledAt?.getTime()).toBe(paidAt.getTime());

    // Ambiguous: NO silent winner - the audit queries own these rows.
    const ambiguous = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: cAmbiguous.id },
    });
    expect(ambiguous.settledByPaymentId).toBeNull();
    for (const id of [pDup1, pDup2]) {
      const p = await prisma.payment.findUniqueOrThrow({ where: { id } });
      expect(p.status).toBe(PaymentStatus.APPROVED); // history preserved
      expect(p.settlementStatus).toBe(PaymentSettlementStatus.SETTLED);
    }

    // Live pending rows: completely untouched.
    const pending = await prisma.payment.findUniqueOrThrow({ where: { id: pPending } });
    expect(pending.settlementStatus).toBe(PaymentSettlementStatus.UNSETTLED);
    expect(pending.settledAt).toBeNull();
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: cPending.id } }))
        .settledByPaymentId,
    ).toBeNull();

    // Nothing deleted, no balances touched, nothing provisioned.
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(paymentsBefore);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
  });
});

// =============================================================================
// NOTIFICATIONS (14): retries send again but NEVER file a second case, and
// alerts carry safe fields only.
// =============================================================================

describe.runIf(hasDb)("NOTIFICATIONS: retry-safe, safe-fields-only (14)", () => {
  it("14. exact Persian texts, short ids only, and no second case on retry", async () => {
    const user = await createUser();
    seq += 1;
    const owner = await prisma.admin.create({
      data: { telegramId: runTag * 100n + BigInt(seq), role: "OWNER", isActive: true },
    });
    const checkout = await createCheckout(user, "ORDER_PAYMENT");
    const firstId = await createSuccessfulPayment(user, checkout, "ZARINPAL", "ORDER_PAYMENT");
    expect((await settleGatewayPayment(firstId)).kind).toBe("settled");
    const dupId = await createSuccessfulPayment(user, checkout, "NOWPAYMENTS", "ORDER_PAYMENT");
    const outcome = await settleGatewayPayment(dupId);
    expect(outcome.kind).toBe("duplicate");
    if (outcome.kind !== "duplicate") {
      return;
    }

    // The exact task-mandated texts, locked verbatim.
    expect(DUPLICATE_SUCCESS_USER_TEXT).toBe(
      "پرداخت شما در درگاه با موفقیت ثبت شد، اما این پیش‌فاکتور قبلاً با روش دیگری پرداخت شده است.\n\n" +
        "پرداخت دوم برای بررسی مالی ثبت شد و نتیجه از طریق ربات اطلاع‌رسانی می‌شود.",
    );
    expect(DUPLICATE_SUCCESS_ADMIN_HEADER).toBe(
      "⚠️ پرداخت موفق تکراری برای یک پیش‌فاکتور\n\n" +
        "یک پیش‌فاکتور از بیش از یک روش پرداخت با موفقیت پرداخت شده است و نیاز به بررسی مالی دارد.",
    );

    const sent: Array<{ chatId: string; text: string }> = [];
    const api = {
      sendMessage: async (chatId: string | number, text: string): Promise<void> => {
        sent.push({ chatId: String(chatId), text });
      },
    };
    await notifyDuplicateSuccessCase(api, outcome.reconciliationCase, outcome.payment);

    const userMsg = sent.find((m) => m.chatId === user.telegramId.toString());
    expect(userMsg?.text).toBe(DUPLICATE_SUCCESS_USER_TEXT);
    const adminMsg = sent.find((m) => m.chatId === owner.telegramId.toString());
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain(DUPLICATE_SUCCESS_ADMIN_HEADER);
    // Safe fields only: 8-char short ids, providers, amount, telegram id -
    // never full UUIDs, authorities, payloads or signatures.
    expect(adminMsg?.text).toContain(outcome.reconciliationCase.id.slice(0, 8));
    expect(adminMsg?.text).toContain(checkout.id.slice(0, 8));
    expect(adminMsg?.text).toContain(user.telegramId.toString());
    expect(adminMsg?.text).toContain("ZARINPAL");
    expect(adminMsg?.text).toContain("NOWPAYMENTS");
    expect(adminMsg?.text).not.toContain(outcome.reconciliationCase.id);
    expect(adminMsg?.text).not.toContain(checkout.id);
    expect(adminMsg?.text).not.toContain(dupId);
    expect(adminMsg?.text).not.toContain("xps-"); // no authorities leak

    // A retried notification (crash before/after send) NEVER refiles a case.
    await notifyDuplicateSuccessCase(api, outcome.reconciliationCase, outcome.payment);
    const refiled = await recordDuplicateSuccess({
      checkoutSessionId: checkout.id,
      duplicatePaymentId: dupId,
      primaryPaymentId: firstId,
      userId: user.id,
      expectedAmountToman: PRICE,
      safeReason: "notification retry after crash",
    });
    expect(refiled.created).toBe(false);
    expect(refiled.reconciliationCase.id).toBe(outcome.reconciliationCase.id);
    expect(
      await prisma.financialReconciliationCase.count({
        where: { duplicatePaymentId: dupId },
      }),
    ).toBe(1);
  });
});

describe.skipIf(hasDb)("cross-provider settlement (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});

// Keeps the outcome union in scope for suites that type against it.
export type { SettleOutcome };
