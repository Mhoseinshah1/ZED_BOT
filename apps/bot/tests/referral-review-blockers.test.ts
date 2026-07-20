import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { OrderStatus, prisma, type Order, type User } from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_JOB_NAMES,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_PAYOUT_WINDOWS_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-review-blockers-tests-secret-0123456789";

import {
  creditReferralCommissionForOrder,
  reverseReferralCommissionForOrder,
} from "../src/services/referral-commission.service.js";
import {
  applyReferralIfEligible,
  disableReferralPayouts,
  enableReferralPayouts,
  getReferralPayoutWindows,
} from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { createReferralScanState, runReferralCreditScan, runReferralReversalScan } from "../../worker/src/referral/scan.js";

// =============================================================================
// Regression + concurrency tests for the PR #109 review blockers:
//   B1 clawback lock-order deadlock (credit ↔ reverse never deadlock)
//   B2 atomic /start attribution mismatch guard (no silent referrer disagreement)
//   B4 activation horizon committed atomically with the switch + a payout window
//   B5 orders completed while payouts were PAUSED are never back-filled
//   B6 reversal discovery runs while payouts are disabled
//   B7 credit scan has no time floor (old-but-eligible orders are still recovered)
//   B8 the duplicate preflight runs BEFORE the unique-index creation migration
// Skips unless DATABASE_URL points at a migrated, disposable database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 24 * 3_600_000;

async function upsertSetting(key: string, value: string, type: "BOOLEAN" | "NUMBER" | "STRING"): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value, type }, update: { value, type } });
}

/** Resets every referral setting so each test builds its own window history. */
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

async function setConfig(opts: { percent?: number; firstPurchaseOnly?: boolean; minToman?: number }): Promise<void> {
  if (opts.percent !== undefined) await upsertSetting(REFERRAL_COMMISSION_PERCENT_KEY, String(opts.percent), "NUMBER");
  if (opts.firstPurchaseOnly !== undefined) await upsertSetting(REFERRAL_FIRST_PURCHASE_ONLY_KEY, opts.firstPurchaseOnly ? "true" : "false", "BOOLEAN");
  if (opts.minToman !== undefined) await upsertSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, String(opts.minToman), "NUMBER");
  clearSettingsCache();
}

const GUARD_INDEX_MIGRATION = fileURLToPath(
  new URL(
    "../../../packages/database/prisma/migrations/20260719180000_referral_affiliate_commissions/migration.sql",
    import.meta.url,
  ),
);

d("referral review blockers", () => {
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
    return prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman },
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

  function fakeQueue(): { added: Array<{ name: string; data: Record<string, unknown> }>; add: (n: string, d: Record<string, unknown>) => Promise<void> } {
    const added: Array<{ name: string; data: Record<string, unknown> }> = [];
    return { added, async add(name, data) { added.push({ name, data }); } };
  }

  // --- B1: credit ↔ reverse never deadlock ----------------------------------

  it("B1: concurrent credit and reversal on the same referrer never deadlock", async () => {
    await enableReferralPayouts();
    await setConfig({ percent: 10, firstPurchaseOnly: false, minToman: 0 });
    // Repeat to stress the credit(Referral→User) vs clawback(now also Referral→User) race.
    for (let i = 0; i < 6; i += 1) {
      const referrer = await makeUser(0);
      const referred = await makeReferredUser(referrer);
      const orderA = await makeCompletedOrder(referred, 100_000);
      const orderB = await makeCompletedOrder(referred, 100_000);
      await creditReferralCommissionForOrder(orderA.id); // PAID, balance 10000

      const [creditB, reverseA] = await Promise.all([
        creditReferralCommissionForOrder(orderB.id),
        reverseReferralCommissionForOrder(orderA.id),
      ]);
      // Both complete (no deadlock/throw); orderA is reversed and orderB credited.
      expect(reverseA.status).toBe("reversed");
      expect(creditB.status).toBe("credited");
      const bal = (await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).balanceToman;
      expect(bal).toBe(10_000); // +10000 (B) −10000 (A reversed)
    }
  });

  // --- B2: attribution mismatch guard ---------------------------------------

  it("B2: a legacy Referral row pointing elsewhere is never silently overwritten", async () => {
    const realReferrer = await makeUser();
    const otherReferrer = await makeUser();
    // Legacy inconsistency: a Referral row exists but User.referrerId is still null.
    const joined = await makeUser();
    await prisma.referral.create({ data: { referrerUserId: realReferrer.id, referredUserId: joined.id } });

    await applyReferralIfEligible(joined, String(otherReferrer.telegramId));

    // The mismatch is rolled back — User.referrerId stays null, Referral unchanged.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: joined.id } })).referrerId).toBeNull();
    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: joined.id } });
    expect(referral.referrerUserId).toBe(realReferrer.id);
    expect(await prisma.referral.count({ where: { referredUserId: joined.id } })).toBe(1);
  });

  it("B2: a consistent existing Referral row links cleanly (no mismatch)", async () => {
    const referrer = await makeUser();
    const joined = await makeUser();
    await prisma.referral.create({ data: { referrerUserId: referrer.id, referredUserId: joined.id } });
    await applyReferralIfEligible(joined, String(referrer.telegramId));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: joined.id } })).referrerId).toBe(referrer.id);
  });

  // --- B4: atomic horizon + switch + window ---------------------------------

  it("B4: enabling stamps horizon + an open window + the switch together", async () => {
    const { flipped, startedAt } = await enableReferralPayouts();
    expect(flipped).toBe(true);
    const enabled = await prisma.setting.findUnique({ where: { key: REFERRAL_SYSTEM_ENABLED_KEY } });
    const horizon = await prisma.setting.findUnique({ where: { key: REFERRAL_COMMISSIONS_STARTED_AT_KEY } });
    const windows = await getReferralPayoutWindows();
    expect(enabled?.value).toBe("true");
    expect(horizon?.value).toBe(startedAt.toISOString());
    expect(windows).toHaveLength(1);
    expect(windows[0].to).toBeNull(); // open window
    expect(windows[0].from).toBe(startedAt.toISOString());
  });

  it("B4: disabling closes the window and re-enabling preserves the original horizon", async () => {
    const t0 = new Date(Date.now() - 3 * DAY);
    const first = await enableReferralPayouts(t0);
    await disableReferralPayouts(new Date(Date.now() - 2 * DAY));
    const second = await enableReferralPayouts(new Date(Date.now() - 1 * DAY));
    // Horizon preserved across the toggle.
    expect(second.startedAt.toISOString()).toBe(first.startedAt.toISOString());
    const windows = await getReferralPayoutWindows();
    expect(windows).toHaveLength(2);
    expect(windows[0].to).not.toBeNull(); // first window closed
    expect(windows[1].to).toBeNull(); // re-opened window
  });

  // --- B5: paused-period orders are never back-filled -----------------------

  it("B5: an order completed while payouts were PAUSED is never credited after re-enable", async () => {
    await setConfig({ percent: 10, firstPurchaseOnly: false, minToman: 0 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);

    await enableReferralPayouts(new Date(Date.now() - 5 * DAY));
    const active1 = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - 4 * DAY)); // in window 1
    await disableReferralPayouts(new Date(Date.now() - 3 * DAY));
    const paused = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - 2 * DAY)); // in the gap
    await enableReferralPayouts(new Date(Date.now() - 1 * DAY));
    const active2 = await makeCompletedOrder(referred, 100_000, new Date()); // in window 2

    expect((await creditReferralCommissionForOrder(active1.id)).status).toBe("credited");
    expect((await creditReferralCommissionForOrder(paused.id)).status).toBe("before-horizon");
    expect((await creditReferralCommissionForOrder(active2.id)).status).toBe("credited");
    // The paused order never earns a commission — no row at all (it is filtered before markers).
    expect(await prisma.referralCommission.count({ where: { orderId: paused.id } })).toBe(0);

    // The durable credit scan must not enqueue the paused order either.
    const q = fakeQueue();
    await runReferralCreditScan(q as never, createReferralScanState());
    expect(q.added.some((j) => j.data.orderId === paused.id)).toBe(false);
  });

  // --- B6: reversal discovery runs while payouts are disabled ---------------

  it("B6: the reversal scan reverses a refunded commission even while payouts are disabled", async () => {
    await setConfig({ percent: 10, firstPurchaseOnly: false, minToman: 0 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    await enableReferralPayouts(new Date(Date.now() - 2 * DAY));
    const order = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - DAY));
    await creditReferralCommissionForOrder(order.id); // PAID

    // Owner pauses payouts, THEN the order is refunded.
    await disableReferralPayouts();
    await prisma.walletTransaction.create({
      data: { userId: referred.id, amountToman: 100_000, type: "REFUND", source: "SYSTEM", relatedOrderId: order.id, balanceBeforeToman: 0, balanceAfterToman: 100_000 },
    });

    const q = fakeQueue();
    const res = await runReferralReversalScan(q as never, createReferralScanState());
    expect(res.enqueued).toBeGreaterThanOrEqual(1);
    const mine = q.added.filter((j) => j.data.orderId === order.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION);
  });

  // --- B7: credit scan has no time floor ------------------------------------

  it("B7: the credit scan recovers an eligible order older than any fixed look-back", async () => {
    await setConfig({ percent: 10, firstPurchaseOnly: false, minToman: 0 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    // Window opened 60 days ago; an eligible order completed 30 days ago (well past
    // a 7-day floor) must still be discovered.
    await enableReferralPayouts(new Date(Date.now() - 60 * DAY));
    const oldOrder = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - 30 * DAY));

    const q = fakeQueue();
    await runReferralCreditScan(q as never, createReferralScanState());
    const mine = q.added.filter((j) => j.data.orderId === oldOrder.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION);

    // Convergence: once processed (credited), a re-scan no longer enqueues it.
    await creditReferralCommissionForOrder(oldOrder.id);
    const q2 = fakeQueue();
    await runReferralCreditScan(q2 as never, createReferralScanState());
    expect(q2.added.some((j) => j.data.orderId === oldOrder.id)).toBe(false);
  });

  it("B7: an ineligible in-window order converges (marked, not re-enqueued forever)", async () => {
    await setConfig({ percent: 10, firstPurchaseOnly: false, minToman: 500_000 });
    const referrer = await makeUser();
    const referred = await makeReferredUser(referrer);
    await enableReferralPayouts(new Date(Date.now() - 10 * DAY));
    const belowMin = await makeCompletedOrder(referred, 100_000, new Date(Date.now() - DAY)); // below the 500k minimum

    // First scan enqueues it; the engine then records a terminal marker.
    const q1 = fakeQueue();
    await runReferralCreditScan(q1 as never, createReferralScanState());
    expect(q1.added.some((j) => j.data.orderId === belowMin.id)).toBe(true);
    expect((await creditReferralCommissionForOrder(belowMin.id)).status).toBe("not-eligible");
    expect(await prisma.referralCommission.count({ where: { orderId: belowMin.id, status: "CANCELLED" } })).toBe(1);

    // A subsequent scan no longer re-selects it (converged).
    const q2 = fakeQueue();
    await runReferralCreditScan(q2 as never, createReferralScanState());
    expect(q2.added.some((j) => j.data.orderId === belowMin.id)).toBe(false);
  });

  // --- B8: migration preflight ordering -------------------------------------

  it("B8: the duplicate preflight runs BEFORE the unique-index creation in one migration", () => {
    const sql = readFileSync(GUARD_INDEX_MIGRATION, "utf8");
    const raiseIdx = sql.indexOf("RAISE EXCEPTION");
    // Match the actual DDL (not the explanatory comment) — the create statement.
    const createIdx = sql.indexOf('CREATE UNIQUE INDEX "ReferralCommission_orderId_key"');
    expect(raiseIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    // The RAISE (preflight) must appear BEFORE the unique-index creation.
    expect(raiseIdx).toBeLessThan(createIdx);
    expect(sql).toMatch(/HAVING count\(\*\) > 1/);
  });
});
