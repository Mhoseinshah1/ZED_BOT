import {
  OrderStatus,
  ReferralCommissionStatus,
  WalletTransactionSource,
  WalletTransactionType,
  prisma,
  type Order,
  type Referral,
  type User,
} from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_PAYOUT_WINDOWS_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-terminal-safety-tests-secret-0123456789";

import { creditReferralCommissionForOrder } from "../src/services/referral-commission.service.js";
import { enableReferralPayouts } from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import {
  createReferralScanState,
  runReferralCleanup,
  runReferralCreditScan,
  runReferralReversalScan,
} from "../../worker/src/referral/scan.js";

// =============================================================================
// §1 (ReferralCommission rows are PERMANENT — never hard-deleted) and §3 (reversal
// discovery scales with REFUNDS, not the whole PAID population). Skips unless
// DATABASE_URL points at a migrated, disposable database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 24 * 3_600_000;
const THREE_YEARS = 3 * 365 * DAY;

async function upsertSetting(key: string, value: string, type: "BOOLEAN" | "NUMBER" | "STRING"): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value, type }, update: { value, type } });
}

async function resetReferralSettings(): Promise<void> {
  await prisma.setting.deleteMany({
    where: {
      key: {
        in: [
          REFERRAL_SYSTEM_ENABLED_KEY,
          REFERRAL_COMMISSIONS_STARTED_AT_KEY,
          REFERRAL_PAYOUT_WINDOWS_KEY,
          REFERRAL_COMMISSION_PERCENT_KEY,
          REFERRAL_FIRST_PURCHASE_ONLY_KEY,
          REFERRAL_MIN_PURCHASE_TOMAN_KEY,
        ],
      },
    },
  });
  clearSettingsCache();
}

/** A fake execute queue that records enqueued jobs. */
function fakeQueue(): { added: Array<{ name: string; data: Record<string, unknown> }>; add: (n: string, d: Record<string, unknown>) => Promise<void> } {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  return { added, async add(name, data) { added.push({ name, data }); } };
}

d("referral terminal safety (§1 permanence, §3 refund-driven reversal)", () => {
  let seq = 0;

  beforeEach(async () => {
    await resetReferralSettings();
  });

  afterAll(async () => {
    await resetReferralSettings();
    await prisma.$disconnect();
  });

  async function makeUser(balanceToman = 0): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman } });
  }

  async function makeChain(): Promise<{ referrer: User; referred: User; referral: Referral }> {
    const referrer = await makeUser(0);
    const referred = await makeUser(0);
    await prisma.user.update({ where: { id: referred.id }, data: { referrerId: referrer.id, referralJoinedAt: new Date() } });
    const referral = await prisma.referral.create({ data: { referrerUserId: referrer.id, referredUserId: referred.id } });
    return { referrer, referred, referral };
  }

  async function makeOrder(user: User, status: OrderStatus, finalPriceToman: number, completedAt: Date | null): Promise<Order> {
    seq += 1;
    return prisma.order.create({ data: { userId: user.id, type: "SERVICE_PURCHASE", status, finalPriceToman, completedAt } });
  }

  /** Directly inserts a PAID commission (bypasses the window gate — for reversal setup). */
  async function makePaidCommission(referral: Referral, referred: User, order: Order, amountToman = 10_000): Promise<string> {
    const c = await prisma.referralCommission.create({
      data: {
        referralId: referral.id,
        referrerUserId: referral.referrerUserId,
        referredUserId: referred.id,
        orderId: order.id,
        amountToman,
        percent: 10,
        status: ReferralCommissionStatus.PAID,
        paidAt: new Date(),
      },
      select: { id: true },
    });
    return c.id;
  }

  // --- §1: reversed / cancelled rows are permanent --------------------------

  it("a REVERSED commission is never hard-deleted, so a refunded order is never re-credited", async () => {
    const { referrer, referred, referral } = await makeChain();
    const order = await makeOrder(referred, OrderStatus.REFUNDED, 100_000, new Date(Date.now() - DAY));
    // A fully-reversed commission (amount clawed back), aged well beyond any retention.
    await prisma.referralCommission.create({
      data: {
        referralId: referral.id,
        referrerUserId: referrer.id,
        referredUserId: referred.id,
        orderId: order.id,
        amountToman: 10_000,
        percent: 10,
        status: ReferralCommissionStatus.REVERSED,
        recoveredToman: 10_000,
        recoveryOutstandingToman: 0,
        createdAt: new Date(Date.now() - THREE_YEARS),
        reversedAt: new Date(Date.now() - THREE_YEARS),
      },
    });

    // Cleanup runs — it must NOT delete any financial row.
    const cleaned = await runReferralCleanup({ control: fakeQueue() as never, execute: fakeQueue() as never });
    expect(cleaned).toHaveProperty("cleaned");
    expect(await prisma.referralCommission.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.referralCommission.count({ where: { orderId: order.id, status: "REVERSED" } })).toBe(1);

    // Even inside an active window, the credit scan never re-selects it (a row exists).
    await upsertSetting(REFERRAL_SYSTEM_ENABLED_KEY, "true", "BOOLEAN");
    await upsertSetting(REFERRAL_PAYOUT_WINDOWS_KEY, JSON.stringify([{ from: new Date(Date.now() - 10 * DAY).toISOString(), to: null }]), "STRING");
    clearSettingsCache();
    const q = fakeQueue();
    await runReferralCreditScan(q as never, createReferralScanState());
    expect(q.added.some((j) => j.data.orderId === order.id)).toBe(false);
  });

  it("a CANCELLED no-commission marker is never removed by cleanup", async () => {
    const { referrer, referred, referral } = await makeChain();
    const order = await makeOrder(referred, OrderStatus.COMPLETED, 100_000, new Date(Date.now() - DAY));
    await prisma.referralCommission.create({
      data: {
        referralId: referral.id,
        referrerUserId: referrer.id,
        referredUserId: referred.id,
        orderId: order.id,
        amountToman: 0,
        percent: 0,
        status: ReferralCommissionStatus.CANCELLED,
        createdAt: new Date(Date.now() - THREE_YEARS),
      },
    });
    await runReferralCleanup({ control: fakeQueue() as never, execute: fakeQueue() as never });
    expect(await prisma.referralCommission.count({ where: { orderId: order.id, status: "CANCELLED" } })).toBe(1);
  });

  it("lowering the minimum / raising the percent never retroactively pays a CANCELLED-marked order", async () => {
    await enableReferralPayouts();
    // High minimum → the order is below it and gets a CANCELLED marker.
    await upsertSetting(REFERRAL_COMMISSION_PERCENT_KEY, "10", "NUMBER");
    await upsertSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, "500000", "NUMBER");
    await upsertSetting(REFERRAL_FIRST_PURCHASE_ONLY_KEY, "false", "BOOLEAN");
    clearSettingsCache();

    const { referred } = await makeChain();
    const order = await makeOrder(referred, OrderStatus.COMPLETED, 100_000, new Date());
    expect((await creditReferralCommissionForOrder(order.id)).status).toBe("not-eligible");
    expect(await prisma.referralCommission.count({ where: { orderId: order.id, status: "CANCELLED" } })).toBe(1);

    // Config now becomes generous — the OLD order must NOT be paid retroactively.
    await upsertSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, "0", "NUMBER");
    await upsertSetting(REFERRAL_COMMISSION_PERCENT_KEY, "25", "NUMBER");
    clearSettingsCache();

    // Neither a re-credit attempt nor a durable scan pays it.
    expect((await creditReferralCommissionForOrder(order.id)).status).toBe("already-credited");
    const q = fakeQueue();
    await runReferralCreditScan(q as never, createReferralScanState());
    expect(q.added.some((j) => j.data.orderId === order.id)).toBe(false);
    expect(await prisma.referralCommission.count({ where: { orderId: order.id, status: "PAID" } })).toBe(0);
  });

  // --- §3: reversal discovery scales with refunds ---------------------------

  it("the reversal scan enqueues ONLY refunded orders, never the whole PAID population", async () => {
    // A large-ish PAID population with NO refund evidence — must never be enqueued.
    const cleanOrderIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const { referred, referral } = await makeChain();
      const order = await makeOrder(referred, OrderStatus.COMPLETED, 100_000, new Date(Date.now() - DAY));
      await makePaidCommission(referral, referred, order);
      cleanOrderIds.push(order.id);
    }
    // A few PAID commissions whose orders carry authoritative refund evidence.
    const refundedOrderIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { referrer, referred, referral } = await makeChain();
      const order = await makeOrder(referred, OrderStatus.REFUNDED, 100_000, new Date(Date.now() - DAY));
      await makePaidCommission(referral, referred, order);
      // one of them via a REFUND wallet transaction instead of a terminal status
      if (i === 0) {
        await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED } });
        await prisma.walletTransaction.create({
          data: {
            userId: referrer.id,
            amountToman: 100_000,
            type: WalletTransactionType.REFUND,
            source: WalletTransactionSource.SYSTEM,
            relatedOrderId: order.id,
            balanceBeforeToman: 0,
            balanceAfterToman: 0,
          },
        });
      }
      refundedOrderIds.push(order.id);
    }

    const q = fakeQueue();
    await runReferralReversalScan(q as never, createReferralScanState());
    const enqueuedIds = new Set(q.added.map((j) => j.data.orderId));
    // The property under test: every REFUNDED order with a PAID commission is
    // enqueued, and NONE of the 20 clean PAID orders are (the scan is refund-driven,
    // never scanning the whole PAID population). Absolute counts aren't asserted
    // because the scan reads the whole DB (other suites' rows are irrelevant here).
    for (const id of refundedOrderIds) expect(enqueuedIds.has(id)).toBe(true);
    for (const id of cleanOrderIds) expect(enqueuedIds.has(id)).toBe(false);
  });

  it("an OLD refund is still discovered (no time floor)", async () => {
    const { referred, referral } = await makeChain();
    const order = await makeOrder(referred, OrderStatus.REFUNDED, 100_000, new Date(Date.now() - 400 * DAY));
    const cid = await makePaidCommission(referral, referred, order);
    // Backdate the commission too — the scan must still catch it (age-independent).
    await prisma.referralCommission.update({ where: { id: cid }, data: { createdAt: new Date(Date.now() - 400 * DAY) } });

    const q = fakeQueue();
    await runReferralReversalScan(q as never, createReferralScanState());
    expect(q.added.some((j) => j.data.orderId === order.id)).toBe(true);
  });

  it("naturally converges: once a commission leaves PAID it stops matching the reversal scan", async () => {
    const { referred, referral } = await makeChain();
    const order = await makeOrder(referred, OrderStatus.REFUNDED, 100_000, new Date(Date.now() - DAY));
    const cid = await makePaidCommission(referral, referred, order);

    const q1 = fakeQueue();
    await runReferralReversalScan(q1 as never, createReferralScanState());
    expect(q1.added.some((j) => j.data.orderId === order.id)).toBe(true);

    // Simulate the reversal completing (PAID → REVERSED).
    await prisma.referralCommission.update({
      where: { id: cid },
      data: { status: ReferralCommissionStatus.REVERSED, recoveredToman: 10_000, recoveryOutstandingToman: 0, reversedAt: new Date() },
    });

    const q2 = fakeQueue();
    await runReferralReversalScan(q2 as never, createReferralScanState());
    expect(q2.added.some((j) => j.data.orderId === order.id)).toBe(false);
  });
});
