import {
  OrderStatus,
  ReferralCommissionStatus,
  WalletTransactionSource,
  WalletTransactionType,
  prisma,
  type Order,
  type User,
} from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-commission-tests-secret-0123456789";

import { applyReferralIfEligible } from "../src/services/referral.service.js";
import {
  creditReferralCommissionForOrder,
  reverseReferralCommissionForOrder,
} from "../src/services/referral-commission.service.js";
import { getReferralAdminStats } from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// Referral affiliate commissions against a REAL DB. Verifies the money engine:
// a referred user's completed order credits the referrer's wallet exactly
// floor(amount*pct/100), writes ONE ledger row with a truthful
// balanceBefore/After, is idempotent + concurrency-safe (one commission per
// order), honours first-purchase-only, the minimum, and the master switch, and
// claws the credit back on refund. Also covers the /start attribution linker.
// Skips itself unless DATABASE_URL points at a migrated, disposable database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

/** Sets the referral settings the engine reads, then drops the bot cache so the
 *  next read sees them (the settings service caches for 30s). */
async function configureReferral(opts: {
  enabled?: boolean;
  percent?: number;
  firstPurchaseOnly?: boolean;
  minToman?: number;
}): Promise<void> {
  const rows: Array<{ key: string; value: string; type: "BOOLEAN" | "NUMBER" | "STRING" }> = [];
  if (opts.enabled !== undefined) {
    rows.push({ key: REFERRAL_SYSTEM_ENABLED_KEY, value: opts.enabled ? "true" : "false", type: "BOOLEAN" });
  }
  if (opts.percent !== undefined) {
    rows.push({ key: REFERRAL_COMMISSION_PERCENT_KEY, value: String(opts.percent), type: "NUMBER" });
  }
  if (opts.firstPurchaseOnly !== undefined) {
    rows.push({ key: REFERRAL_FIRST_PURCHASE_ONLY_KEY, value: opts.firstPurchaseOnly ? "true" : "false", type: "BOOLEAN" });
  }
  if (opts.minToman !== undefined) {
    rows.push({ key: REFERRAL_MIN_PURCHASE_TOMAN_KEY, value: String(opts.minToman), type: "NUMBER" });
  }
  // Stamp the activation horizon at the epoch so every "now"-completed test order
  // is on/after it (the horizon gate is exercised on its own in the financial-
  // safety suite). Without this the engine fail-closes and credits nothing.
  rows.push({ key: REFERRAL_COMMISSIONS_STARTED_AT_KEY, value: new Date(0).toISOString(), type: "STRING" });
  for (const r of rows) {
    await prisma.setting.upsert({
      where: { key: r.key },
      create: { key: r.key, value: r.value, type: r.type },
      update: { value: r.value, type: r.type },
    });
  }
  clearSettingsCache();
}

d("referral affiliate commissions — engine", () => {
  let seq = 0;

  beforeEach(async () => {
    // Sensible default for every test: enabled, 10%, all purchases, no minimum.
    await configureReferral({ enabled: true, percent: 10, firstPurchaseOnly: false, minToman: 0 });
  });

  afterAll(async () => {
    // Reset the master switch to its default so a later suite's menu default-state
    // assertions never see the referral button (it is gated on this global flag).
    await configureReferral({ enabled: false });
    await prisma.$disconnect();
  });

  async function makeUser(balanceToman = 0): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman },
    });
  }

  /** A referred user linked to `referrer` via a Referral row (as /start would).
   *  Returns the UPDATED user (referrerId populated), mirroring the freshly-loaded
   *  user object every production caller passes. */
  async function makeReferredUser(referrer: User): Promise<User> {
    const user = await makeUser();
    const linked = await prisma.user.update({
      where: { id: user.id },
      data: { referrerId: referrer.id, referralJoinedAt: new Date() },
    });
    await prisma.referral.create({ data: { referrerUserId: referrer.id, referredUserId: user.id } });
    return linked;
  }

  async function makeCompletedOrder(user: User, finalPriceToman: number): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: {
        userId: user.id,
        type: "SERVICE_PURCHASE",
        status: OrderStatus.COMPLETED,
        finalPriceToman,
        completedAt: new Date(),
      },
    });
  }

  async function walletTxFor(orderId: string, type: WalletTransactionType) {
    return prisma.walletTransaction.findFirst({ where: { relatedOrderId: orderId, type } });
  }

  // --- credit correctness ----------------------------------------------------

  it("credits the referrer's wallet exactly floor(amount*percent/100) and writes one truthful ledger row", async () => {
    const referrer = await makeUser(5_000);
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 123_456); // 10% → 12345 (floored from 12345.6)

    const res = await creditReferralCommissionForOrder(order.id);
    expect(res).toEqual({ status: "credited", commissionToman: 12_345 });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(after.balanceToman).toBe(5_000 + 12_345);
    expect(after.totalReferralCommissionToman).toBe(12_345);
    expect(after.totalReferralPurchaseCount).toBe(1);
    expect(after.totalReferralPurchaseAmountToman).toBe(123_456);

    const commission = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(commission.status).toBe(ReferralCommissionStatus.PAID);
    expect(commission.amountToman).toBe(12_345);
    expect(commission.percent).toBe(10);
    expect(commission.referrerUserId).toBe(referrer.id);
    expect(commission.referredUserId).toBe(referred.id);
    expect(commission.walletTransactionId).not.toBeNull();

    const tx = await walletTxFor(order.id, WalletTransactionType.COMMISSION);
    expect(tx).not.toBeNull();
    expect(tx?.amountToman).toBe(12_345);
    expect(tx?.source).toBe(WalletTransactionSource.REFERRAL);
    expect(tx?.balanceBeforeToman).toBe(5_000);
    expect(tx?.balanceAfterToman).toBe(5_000 + 12_345);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.id } });
    expect(referral.totalCommissionAmountToman).toBe(12_345);
    expect(referral.totalPurchaseAmountToman).toBe(123_456);
    expect(referral.firstPurchaseOrderId).toBe(order.id);
    expect(referral.firstPurchaseAt).not.toBeNull();
  });

  // --- idempotency -----------------------------------------------------------

  it("is idempotent — a second credit call pays nothing extra", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);

    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "credited", commissionToman: 10_000 });
    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "already-credited" });

    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(after.balanceToman).toBe(10_000);
    expect(await prisma.walletTransaction.count({ where: { relatedOrderId: order.id, type: "COMMISSION" } })).toBe(1);
  });

  it("two concurrent credits for one order create exactly one commission and credit once", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 200_000);

    const results = await Promise.all([
      creditReferralCommissionForOrder(order.id),
      creditReferralCommissionForOrder(order.id),
    ]);
    const credited = results.filter((r) => r.status === "credited");
    const already = results.filter((r) => r.status === "already-credited");
    expect(credited).toHaveLength(1);
    expect(already).toHaveLength(1);

    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(after.balanceToman).toBe(20_000);
    expect(await prisma.walletTransaction.count({ where: { relatedOrderId: order.id, type: "COMMISSION" } })).toBe(1);
  });

  // --- gating ----------------------------------------------------------------

  it("does not credit when the master switch is disabled", async () => {
    await configureReferral({ enabled: false });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);

    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "disabled" });
    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(0);
  });

  it("does not credit an order below the configured minimum", async () => {
    await configureReferral({ minToman: 150_000 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 149_999);

    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "not-eligible" });
    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("credits an order exactly at the minimum", async () => {
    await configureReferral({ minToman: 150_000, percent: 10 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 150_000);

    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "credited", commissionToman: 15_000 });
  });

  it("credits nothing when the percent is zero", async () => {
    await configureReferral({ percent: 0 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);

    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "not-eligible" });
    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(0);
  });

  // --- first-purchase-only ---------------------------------------------------

  it("first-purchase-only: pays the first order and skips the second", async () => {
    await configureReferral({ firstPurchaseOnly: true, percent: 10 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);

    const first = await makeCompletedOrder(referred, 100_000);
    const second = await makeCompletedOrder(referred, 100_000);

    expect(await creditReferralCommissionForOrder(first.id)).toEqual({ status: "credited", commissionToman: 10_000 });
    expect(await creditReferralCommissionForOrder(second.id)).toEqual({ status: "not-eligible" });

    expect(await prisma.referralCommission.count({ where: { referredUserId: referred.id } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(10_000);
  });

  it("first-purchase-only: a prior below-minimum order does NOT consume the slot", async () => {
    // A below-min order earns nothing and must not block the later qualifying order.
    await configureReferral({ firstPurchaseOnly: true, percent: 10, minToman: 50_000 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);

    const tiny = await makeCompletedOrder(referred, 10_000); // below the 50k minimum
    const real = await makeCompletedOrder(referred, 100_000);

    expect(await creditReferralCommissionForOrder(tiny.id)).toEqual({ status: "not-eligible" });
    expect(await creditReferralCommissionForOrder(real.id)).toEqual({ status: "credited", commissionToman: 10_000 });
  });

  it("all-purchases mode: pays every qualifying order", async () => {
    await configureReferral({ firstPurchaseOnly: false, percent: 10 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);

    const first = await makeCompletedOrder(referred, 100_000);
    const second = await makeCompletedOrder(referred, 50_000);

    expect(await creditReferralCommissionForOrder(first.id)).toEqual({ status: "credited", commissionToman: 10_000 });
    expect(await creditReferralCommissionForOrder(second.id)).toEqual({ status: "credited", commissionToman: 5_000 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(15_000);
  });

  // --- eligibility guards ----------------------------------------------------

  it("does not credit a buyer with no referrer", async () => {
    const buyer = await makeUser();
    const order = await makeCompletedOrder(buyer, 100_000);
    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "no-referrer" });
  });

  it("does not credit an order that is not COMPLETED", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await prisma.order.create({
      data: { userId: referred.id, type: "SERVICE_PURCHASE", status: OrderStatus.PENDING, finalPriceToman: 100_000 },
    });
    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "not-completed" });
  });

  it("returns order-missing for an unknown order id", async () => {
    expect(await creditReferralCommissionForOrder("00000000-0000-0000-0000-000000000000")).toEqual({
      status: "order-missing",
    });
  });

  // --- reversal (clawback) ---------------------------------------------------

  it("reverses a paid commission — claws the wallet credit back and marks it REVERSED", async () => {
    const referrer = await makeUser(1_000);
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(11_000);

    const res = await reverseReferralCommissionForOrder(order.id);
    expect(res).toEqual({ status: "reversed", commissionToman: 10_000 });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(after.balanceToman).toBe(1_000); // credit clawed back to the pre-commission balance
    expect(after.totalReferralCommissionToman).toBe(0);

    const commission = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(commission.status).toBe(ReferralCommissionStatus.REVERSED);
    expect(commission.reversedAt).not.toBeNull();
    expect(commission.reversalWalletTransactionId).not.toBeNull();

    const debit = await walletTxFor(order.id, WalletTransactionType.SYSTEM_ADJUSTMENT);
    expect(debit).not.toBeNull();
    expect(debit?.amountToman).toBe(10_000);
    expect(debit?.balanceBeforeToman).toBe(11_000);
    expect(debit?.balanceAfterToman).toBe(1_000);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referred.id } });
    expect(referral.totalCommissionAmountToman).toBe(0);
  });

  it("reversal is idempotent — a second reversal claws back nothing more", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);

    expect(await reverseReferralCommissionForOrder(order.id)).toEqual({ status: "reversed", commissionToman: 10_000 });
    expect(await reverseReferralCommissionForOrder(order.id)).toEqual({ status: "already-reversed" });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { relatedOrderId: order.id, type: "SYSTEM_ADJUSTMENT" } })).toBe(1);
  });

  it("two concurrent reversals claw back exactly once", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);

    const results = await Promise.all([
      reverseReferralCommissionForOrder(order.id),
      reverseReferralCommissionForOrder(order.id),
    ]);
    expect(results.filter((r) => r.status === "reversed")).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { relatedOrderId: order.id, type: "SYSTEM_ADJUSTMENT" } })).toBe(1);
  });

  it("reversing an order with no commission is a no-op", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    // never credited
    expect(await reverseReferralCommissionForOrder(order.id)).toEqual({ status: "no-commission" });
  });

  // --- /start attribution linker (applyReferralIfEligible) -------------------

  it("attribution: a numeric /start payload links the referred user to the referrer", async () => {
    const referrer = await makeUser();
    const joined = await makeUser();
    await applyReferralIfEligible(joined, String(referrer.telegramId));

    const linked = await prisma.user.findUniqueOrThrow({ where: { id: joined.id } });
    expect(linked.referrerId).toBe(referrer.id);
    const referral = await prisma.referral.findUnique({ where: { referredUserId: joined.id } });
    expect(referral?.referrerUserId).toBe(referrer.id);
  });

  it("attribution: a self-referral payload is ignored", async () => {
    const user = await makeUser();
    await applyReferralIfEligible(user, String(user.telegramId));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).referrerId).toBeNull();
    expect(await prisma.referral.findUnique({ where: { referredUserId: user.id } })).toBeNull();
  });

  it("attribution: a non-numeric payload is ignored and never throws", async () => {
    const user = await makeUser();
    await applyReferralIfEligible(user, "not-a-code");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).referrerId).toBeNull();
  });

  it("attribution: an already-referred user keeps their original referrer", async () => {
    const first = await makeUser();
    const second = await makeUser();
    const joined = await makeReferredUser(first); // already linked to `first`
    await applyReferralIfEligible(joined, String(second.telegramId));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: joined.id } })).referrerId).toBe(first.id);
  });

  // --- admin stats -----------------------------------------------------------

  it("admin stats reflect paid + reversed commissions", async () => {
    await configureReferral({ enabled: true, percent: 10, firstPurchaseOnly: false, minToman: 0 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const paidOrder = await makeCompletedOrder(referred, 100_000);
    const reversedOrder = await makeCompletedOrder(referred, 50_000);
    await creditReferralCommissionForOrder(paidOrder.id);
    await creditReferralCommissionForOrder(reversedOrder.id);
    await reverseReferralCommissionForOrder(reversedOrder.id);

    const stats = await getReferralAdminStats();
    expect(stats.enabled).toBe(true);
    expect(stats.commissionPercent).toBe(10);
    expect(stats.firstPurchaseOnly).toBe(false);
    // Global counters (other tests share the DB) — assert monotonic minimums.
    expect(stats.totalReferrals).toBeGreaterThanOrEqual(1);
    expect(stats.paidCommissionCount).toBeGreaterThanOrEqual(1);
    expect(stats.paidCommissionToman).toBeGreaterThanOrEqual(10_000);
    expect(stats.reversedCommissionCount).toBeGreaterThanOrEqual(1);
  });
});
