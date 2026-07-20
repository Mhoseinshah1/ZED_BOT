import {
  OrderStatus,
  ReferralCommissionStatus,
  prisma,
  type Order,
  type User,
} from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_JOB_NAMES,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-financial-safety-tests-secret-0123456789";

import type { BotContext } from "../src/core/context.js";
import { renderReferralPage } from "../src/handlers/user-referral/referral.handler.js";
import {
  creditReferralCommissionForOrder,
  recoverReferralCommissionDebt,
  reverseReferralCommissionForOrder,
} from "../src/services/referral-commission.service.js";
import { applyReferralIfEligible } from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import {
  createReferralScanState,
  publishReferralStatus,
  runReferralCreditScan,
  runReferralDebtRecoveryScan,
  runReferralReversalScan,
} from "../../worker/src/referral/scan.js";

// =============================================================================
// Referral FINANCIAL-SAFETY hardening against a REAL DB. Verifies the fixes:
//   S1 first-purchase-only concurrency (row lock, two DIFFERENT orders)
//   S2 activation horizon + durable credit recovery scan (no historical backfill)
//   S3 durable reversal reconciler (authoritative refund evidence)
//   S4 no-overdraft reversal + REVERSAL_PENDING debt + recovery (no negative wallet)
//   S5 atomic /start attribution under competing referrers
//   S6 disabled gate on the user route (fail closed)
// Skips itself unless DATABASE_URL points at a migrated, disposable database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

async function upsertSetting(key: string, value: string, type: "BOOLEAN" | "NUMBER" | "STRING"): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value, type }, update: { value, type } });
}

async function configure(opts: {
  enabled?: boolean;
  percent?: number;
  firstPurchaseOnly?: boolean;
  minToman?: number;
  horizon?: Date | null;
}): Promise<void> {
  if (opts.enabled !== undefined) await upsertSetting(REFERRAL_SYSTEM_ENABLED_KEY, opts.enabled ? "true" : "false", "BOOLEAN");
  if (opts.percent !== undefined) await upsertSetting(REFERRAL_COMMISSION_PERCENT_KEY, String(opts.percent), "NUMBER");
  if (opts.firstPurchaseOnly !== undefined) await upsertSetting(REFERRAL_FIRST_PURCHASE_ONLY_KEY, opts.firstPurchaseOnly ? "true" : "false", "BOOLEAN");
  if (opts.minToman !== undefined) await upsertSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, String(opts.minToman), "NUMBER");
  if (opts.horizon !== undefined) {
    if (opts.horizon === null) {
      await prisma.setting.deleteMany({ where: { key: REFERRAL_COMMISSIONS_STARTED_AT_KEY } });
    } else {
      await upsertSetting(REFERRAL_COMMISSIONS_STARTED_AT_KEY, opts.horizon.toISOString(), "STRING");
    }
  }
  clearSettingsCache();
}

/** A fake BullMQ queue that records add() calls (worker scans produce onto it). */
function fakeQueue(): { added: Array<{ name: string; data: Record<string, unknown> }> } & { add: (name: string, data: Record<string, unknown>) => Promise<void> } {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    added,
    async add(name: string, data: Record<string, unknown>): Promise<void> {
      added.push({ name, data });
    },
  };
}

d("referral financial safety", () => {
  let seq = 0;

  beforeEach(async () => {
    await configure({ enabled: true, percent: 10, firstPurchaseOnly: false, minToman: 0, horizon: new Date(0) });
  });

  afterAll(async () => {
    await configure({ enabled: false });
    await prisma.$disconnect();
  });

  async function makeUser(balanceToman = 0, allowNegativeBalance = false): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman, allowNegativeBalance },
    });
  }

  async function makeReferredUser(referrer: User): Promise<User> {
    const user = await makeUser();
    const linked = await prisma.user.update({
      where: { id: user.id },
      data: { referrerId: referrer.id, referralJoinedAt: new Date() },
    });
    await prisma.referral.create({ data: { referrerUserId: referrer.id, referredUserId: user.id } });
    return linked;
  }

  async function makeCompletedOrder(user: User, finalPriceToman: number, completedAt = new Date()): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: { userId: user.id, type: "SERVICE_PURCHASE", status: OrderStatus.COMPLETED, finalPriceToman, completedAt },
    });
  }

  // --- S1: first-purchase-only concurrency (two DIFFERENT orders) ------------

  it("S1: two concurrent DIFFERENT orders under first-purchase-only pay exactly one commission", async () => {
    await configure({ firstPurchaseOnly: true, percent: 10 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const orderA = await makeCompletedOrder(referred, 100_000);
    const orderB = await makeCompletedOrder(referred, 100_000);

    const results = await Promise.all([
      creditReferralCommissionForOrder(orderA.id),
      creditReferralCommissionForOrder(orderB.id),
    ]);
    const credited = results.filter((r) => r.status === "credited");
    expect(credited).toHaveLength(1);
    expect(await prisma.referralCommission.count({ where: { referredUserId: referred.id, status: "PAID" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(10_000);
  });

  it("S1: all-purchases mode credits BOTH concurrent different orders", async () => {
    await configure({ firstPurchaseOnly: false, percent: 10 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const orderA = await makeCompletedOrder(referred, 100_000);
    const orderB = await makeCompletedOrder(referred, 50_000);

    const results = await Promise.all([
      creditReferralCommissionForOrder(orderA.id),
      creditReferralCommissionForOrder(orderB.id),
    ]);
    expect(results.filter((r) => r.status === "credited")).toHaveLength(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(15_000);
  });

  // --- S2: activation horizon (no historical backfill) ----------------------

  it("S2: an order completed BEFORE the horizon never earns a commission", async () => {
    await configure({ horizon: new Date(Date.now() - 60 * 60_000) }); // horizon = 1h ago
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const oldOrder = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - 2 * 60 * 60_000)); // 2h ago
    expect(await creditReferralCommissionForOrder(oldOrder.id)).toEqual({ status: "before-horizon" });
    expect(await prisma.referralCommission.count({ where: { orderId: oldOrder.id } })).toBe(0);
  });

  it("S2: an order completed AFTER the horizon is eligible", async () => {
    await configure({ horizon: new Date(Date.now() - 60 * 60_000) });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000, new Date()); // now, after horizon
    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "credited", commissionToman: 10_000 });
  });

  it("S2: a MISSING horizon is fail-closed — nothing is credited (never back-fills history)", async () => {
    await configure({ horizon: null });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    expect(await creditReferralCommissionForOrder(order.id)).toEqual({ status: "before-horizon" });
  });

  // --- S2: durable credit recovery scan (missed live hook / Redis flush) -----

  it("S2: the worker credit scan discovers a completed order the live hook missed", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    const q = fakeQueue();
    const state = createReferralScanState();
    await runReferralCreditScan(q as never, state);
    const mine = q.added.filter((j) => j.data.orderId === order.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION);

    // Once credited, a re-scan no longer enqueues it (no double-work / restart-safe).
    await creditReferralCommissionForOrder(order.id);
    const q2 = fakeQueue();
    await runReferralCreditScan(q2 as never, createReferralScanState());
    expect(q2.added.filter((j) => j.data.orderId === order.id)).toHaveLength(0);
  });

  it("S2: the credit scan enqueues nothing while payouts are disabled", async () => {
    await configure({ enabled: false });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    await makeCompletedOrder(referred, 100_000);
    const q = fakeQueue();
    const res = await runReferralCreditScan(q as never, createReferralScanState());
    expect(res.enqueued).toBe(0);
    expect(q.added).toHaveLength(0);
  });

  // --- S3: durable reversal reconciler (authoritative evidence) --------------

  it("S3: the reversal scan enqueues a PAID commission whose order has a REFUND record", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    // Authoritative refund evidence: a REFUND wallet transaction on the order.
    await prisma.walletTransaction.create({
      data: { userId: referred.id, amountToman: 100_000, type: "REFUND", source: "SYSTEM", relatedOrderId: order.id, balanceBeforeToman: 0, balanceAfterToman: 100_000 },
    });
    const q = fakeQueue();
    await runReferralReversalScan(q as never, createReferralScanState());
    const mine = q.added.filter((j) => j.data.orderId === order.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION);
  });

  it("S3: the reversal scan does NOT enqueue a PAID commission with no refund evidence", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    const q = fakeQueue();
    await runReferralReversalScan(q as never, createReferralScanState());
    expect(q.added.filter((j) => j.data.orderId === order.id)).toHaveLength(0);
  });

  // --- S4: no-overdraft reversal + debt + recovery --------------------------

  it("S4: sufficient balance → full reversal, wallet returns to its pre-commission balance", async () => {
    const referrer = await makeUser(2_000);
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id); // +10000 → 12000
    expect(await reverseReferralCommissionForOrder(order.id)).toEqual({ status: "reversed", commissionToman: 10_000 });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(u.balanceToman).toBe(2_000);
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(c.status).toBe(ReferralCommissionStatus.REVERSED);
    expect(c.recoveredToman).toBe(10_000);
    expect(c.recoveryOutstandingToman).toBe(0);
  });

  it("S4: insufficient balance → REVERSAL_PENDING, wallet NEVER goes negative, debt recorded", async () => {
    const referrer = await makeUser(); // 0 balance
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id); // +10000 → 10000
    // Spend the credited money elsewhere so the clawback cannot fully recover.
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 3_000 } });

    const res = await reverseReferralCommissionForOrder(order.id);
    expect(res).toEqual({ status: "reversal-pending", recoveredToman: 3_000, outstandingToman: 7_000 });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(u.balanceToman).toBe(0); // clawed back exactly what was affordable — never negative
    expect(u.balanceToman).toBeGreaterThanOrEqual(0);
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(c.status).toBe(ReferralCommissionStatus.REVERSAL_PENDING);
    expect(c.recoveredToman).toBe(3_000);
    expect(c.recoveryOutstandingToman).toBe(7_000);
    // Every debit is a real ledger row.
    const debits = await prisma.walletTransaction.findMany({ where: { relatedOrderId: order.id, type: "SYSTEM_ADJUSTMENT" } });
    expect(debits).toHaveLength(1);
    expect(debits[0].amountToman).toBe(3_000);
    expect(debits[0].balanceBeforeToman).toBe(3_000);
    expect(debits[0].balanceAfterToman).toBe(0);
  });

  it("S4: allowNegativeBalance users are fully clawed back even at zero balance", async () => {
    const referrer = await makeUser(0, true);
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 0 } });
    expect(await reverseReferralCommissionForOrder(order.id)).toEqual({ status: "reversed", commissionToman: 10_000 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(-10_000);
  });

  it("S4: a REVERSAL_PENDING debt is recovered later when funds arrive", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 4_000 } });
    await reverseReferralCommissionForOrder(order.id); // recovers 4000, 6000 outstanding

    // Funds arrive: recover the rest in two steps.
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 2_000 } });
    const c1 = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(await recoverReferralCommissionDebt(c1.id)).toEqual({ status: "reversal-pending", recoveredToman: 2_000, outstandingToman: 4_000 });

    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 10_000 } });
    expect(await recoverReferralCommissionDebt(c1.id)).toEqual({ status: "reversed", recoveredToman: 4_000 });

    const c2 = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(c2.status).toBe(ReferralCommissionStatus.REVERSED);
    expect(c2.recoveredToman).toBe(10_000); // total recovered == the original credit, never more
    expect(c2.recoveryOutstandingToman).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman).toBe(6_000);
  });

  it("S4: concurrent recovery collects the debt exactly once (never over-collects)", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 0 } });
    await reverseReferralCommissionForOrder(order.id); // REVERSAL_PENDING, outstanding 10000
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 10_000 } });

    await Promise.all([recoverReferralCommissionDebt(c.id), recoverReferralCommissionDebt(c.id)]);
    const after = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(after.recoveredToman).toBe(10_000); // exactly once
    expect(after.status).toBe(ReferralCommissionStatus.REVERSED);
    const debits = await prisma.walletTransaction.aggregate({ where: { relatedOrderId: order.id, type: "SYSTEM_ADJUSTMENT" }, _sum: { amountToman: true } });
    expect(debits._sum.amountToman).toBe(10_000);
  });

  it("S4: recovering a non-pending commission is a no-op", async () => {
    const referrer = await makeUser(50_000);
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(await recoverReferralCommissionDebt(c.id)).toEqual({ status: "not-pending" });
  });

  it("S4: concurrent wallet spend vs commission recovery keeps the wallet non-negative and never over-collects", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id); // balance 10000
    // A gated spend (only if affordable, like the real wallet) races the clawback.
    const spend = prisma.user.updateMany({ where: { id: referrer.id, balanceToman: { gte: 10_000 } }, data: { balanceToman: { decrement: 10_000 } } });
    const [, rev] = await Promise.all([spend, reverseReferralCommissionForOrder(order.id)]);
    void rev;
    const u = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(u.balanceToman).toBeGreaterThanOrEqual(0); // no overdraft under the race
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(c.recoveredToman + c.recoveryOutstandingToman).toBe(10_000); // never over-collected
    expect(c.recoveredToman).toBeLessThanOrEqual(10_000);
  });

  it("S4: the recovery scan enqueues outstanding REVERSAL_PENDING debts", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);
    await prisma.user.update({ where: { id: referrer.id }, data: { balanceToman: 0 } });
    await reverseReferralCommissionForOrder(order.id); // REVERSAL_PENDING
    const c = await prisma.referralCommission.findUniqueOrThrow({ where: { orderId: order.id } });
    const q = fakeQueue();
    await runReferralDebtRecoveryScan(q as never, createReferralScanState());
    const mine = q.added.filter((j) => j.data.commissionId === c.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(REFERRAL_JOB_NAMES.RECOVER_REFERRAL_COMMISSION);
  });

  // --- S5: atomic /start attribution under competing referrers --------------

  it("S5: two concurrent /start with DIFFERENT codes converge to exactly one referrer", async () => {
    const refA = await makeUser();
    const refB = await makeUser();
    const joined = await makeUser();

    await Promise.all([
      applyReferralIfEligible(joined, String(refA.telegramId)),
      applyReferralIfEligible(joined, String(refB.telegramId)),
    ]);

    const linked = await prisma.user.findUniqueOrThrow({ where: { id: joined.id } });
    expect([refA.id, refB.id]).toContain(linked.referrerId);
    // The Referral row and the User relation reference the SAME referrer (never half-linked).
    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: joined.id } });
    expect(referral.referrerUserId).toBe(linked.referrerId);
    // Exactly one Referral row.
    expect(await prisma.referral.count({ where: { referredUserId: joined.id } })).toBe(1);
  });

  it("S5: an existing attribution is never replaced by a later /start", async () => {
    const first = await makeUser();
    const second = await makeUser();
    const joined = await makeReferredUser(first);
    await applyReferralIfEligible(joined, String(second.telegramId));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: joined.id } })).referrerId).toBe(first.id);
  });

  // --- S6: disabled gate on the user route (fail closed) --------------------

  function fakeCtx(user: User): { ctx: BotContext; replies: string[] } {
    const replies: string[] = [];
    const ctx = {
      dbUser: user,
      me: { username: "TestBot" },
      callbackQuery: undefined,
      reply: async (text: string): Promise<void> => {
        replies.push(text);
      },
    } as unknown as BotContext;
    return { ctx, replies };
  }

  it("S6: the referral page fails closed while payouts are disabled (no commission % shown)", async () => {
    await configure({ enabled: false, percent: 10 });
    const user = await makeUser();
    const { ctx, replies } = fakeCtx(user);
    await renderReferralPage(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("غیرفعال");
    expect(replies[0]).not.toContain("۱۰٪");
    expect(replies[0]).not.toContain("t.me/TestBot");
  });

  it("S6: the referral page renders the link + percent when enabled", async () => {
    await configure({ enabled: true, percent: 10 });
    const user = await makeUser();
    const { ctx, replies } = fakeCtx(user);
    await renderReferralPage(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`t.me/TestBot?start=${String(user.telegramId)}`);
  });

  // --- PII safety: the worker status snapshot leaks no identifiers -----------

  it("PII: the published worker status snapshot contains only counts/timestamps", async () => {
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    const order = await makeCompletedOrder(referred, 100_000);
    await creditReferralCommissionForOrder(order.id);

    let stored: string | null = null;
    const fakeRedis = {
      async set(_key: string, value: string): Promise<void> {
        stored = value;
      },
    };
    const state = createReferralScanState();
    await publishReferralStatus(fakeRedis as never, state, 3600);
    expect(stored).not.toBeNull();
    const snapshot = JSON.parse(stored ?? "{}") as Record<string, unknown>;
    // No user id, telegram id, order id or referral code anywhere in the payload.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(referrer.id);
    expect(serialized).not.toContain(referred.id);
    expect(serialized).not.toContain(order.id);
    expect(serialized).not.toContain(String(referred.telegramId));
    // Only the documented keys are present.
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "checkedAt",
        "creditScanEnqueued",
        "enabled",
        "executeFailures",
        "lastScanAt",
        "paidCount",
        "recoveryScanEnqueued",
        "reversalPendingCount",
        "reversalPendingOutstandingToman",
        "reversalScanEnqueued",
        "reversedCount",
      ].sort(),
    );
  });
});
