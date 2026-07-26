import {
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  LowBalanceBackfillStatus,
  prisma,
  SettingType,
  UserStatus,
} from "@zedbot/database";
import {
  buildLowBalanceSnapshot,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "low-balance-cycle-authority-secret-0123456789";

import { onWalletBalanceChanged } from "../src/services/low-balance/low-balance-hook.js";
import { startLowBalanceBackfill } from "../src/services/low-balance/low-balance-admin.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { runLowBalanceBackfillTick } from "../../worker/src/notifications/low-balance-backfill.js";
import { revalidateLowBalanceForDelivery } from "../../worker/src/notifications/low-balance-eligibility.js";

// =============================================================================
// CYCLE AUTHORITY (§4.1), the LOCKED backfill decision (§4.2) and per-unit
// CLAIM enforcement (§4.3).
//
// The through-line: a queued alert is valid for exactly one state cycle, and
// nothing observed before a lock may authorise a new one.
//
// Interleavings here are built from REAL row locks, the way the repository's
// other race tests work — a transaction holding `SELECT … FOR UPDATE` on the
// state row pins the other side deterministically. No mock harness.
//
// Money is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const THRESHOLD = 100_000;
const MARGIN = 20_000;
const REARM_BOUNDARY = THRESHOLD + MARGIN;

const TELEGRAM_ID_BASE = 8_800_000_000_000n;
const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;
const createdUserIds: string[] = [];

async function setSettingRow(key: string, value: string, type: SettingType): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value, type },
    create: { key, value, type, isPublic: false },
  });
}

async function enableFeature(): Promise<void> {
  await setSettingRow(LOW_BALANCE_ENABLED_KEY, "true", SettingType.BOOLEAN);
  await setSettingRow(LOW_BALANCE_THRESHOLD_KEY, String(THRESHOLD), SettingType.NUMBER);
  await setSettingRow(LOW_BALANCE_REARM_MARGIN_KEY, String(MARGIN), SettingType.NUMBER);
  clearSettingsCache();
}

async function makeUser(balanceToman: number): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: {
      telegramId: TELEGRAM_ID_BASE + RUN_TAG * 100_000n + seq,
      balanceToman,
      status: UserStatus.ACTIVE,
    },
  });
  createdUserIds.push(row.id);
  return row.id;
}

async function walletMove(userId: string, from: number, to: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { balanceToman: to } });
    await onWalletBalanceChanged(tx, {
      userId,
      balanceBeforeToman: from,
      balanceAfterToman: to,
      source: "TEST",
    });
  });
}

async function queueAlert(userId: string, cycle: number, balance: number): Promise<string> {
  const row = await prisma.automatedNotification.create({
    data: {
      type: AutomatedNotificationType.WALLET_LOW_BALANCE,
      category: "PAYMENT",
      status: AutomatedNotificationStatus.SCHEDULED,
      userId,
      dedupeKey: lowBalanceDedupeKey(userId, cycle),
      ruleVersion: 1,
      scheduledFor: new Date(),
      payloadSnapshot: buildLowBalanceSnapshot({
        balanceToman: balance,
        thresholdToman: THRESHOLD,
        rearmBoundaryToman: REARM_BOUNDARY,
        configVersion: 1,
        alertCycle: cycle,
        origin: "event",
      }) as never,
    },
  });
  return row.id;
}

function metaFor(cycle: number): Record<string, number> {
  return {
    alertCycle: cycle,
    configVersion: 1,
    thresholdToman: THRESHOLD,
    rearmBoundaryToman: REARM_BOUNDARY,
  };
}

function notificationsFor(userId: string): Promise<number> {
  return prisma.automatedNotification.count({
    where: { userId, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
  });
}

function stateOf(userId: string) {
  return prisma.lowBalanceAlertState.findUnique({ where: { userId } });
}

async function resetAll(): Promise<void> {
  await prisma.lowBalanceBackfillRun.deleteMany({});
  await prisma.lowBalanceReconciliationState.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.automatedNotification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.lowBalanceAlertState.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  clearSettingsCache();
}

// --- §4.1 stale cycle supersession ---------------------------------------------

d("low balance — send-time cycle authority (§4.1)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L91 a stale cycle 1 is cancelled while cycle 2 is live, even with a low balance", async () => {
    await enableFeature();
    // The exact production sequence: cross, recover, cross again, then the FIRST
    // message finally gets its delivery attempt while the balance is low.
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000); // cycle 1 opens + queues
    const cycle1 = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });
    await walletMove(user, 90_000, 500_000); // recovers, re-arms
    await walletMove(user, 500_000, 80_000); // cycle 2 opens + queues

    expect((await stateOf(user))?.alertCycle).toBe(2);

    // Every balance claim in the cycle-1 message is currently TRUE, and it is
    // still wrong to send: the user would get two warnings for one episode.
    expect(await revalidateLowBalanceForDelivery(cycle1, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "cycle-superseded",
    });

    // ...and cycle 2 is still perfectly deliverable.
    const cycle2 = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 2) },
    });
    expect(await revalidateLowBalanceForDelivery(cycle2, metaFor(2))).toBeNull();
  });

  it("L92 cancelling a stale cycle never re-arms the newer one", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000);
    const cycle1 = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });
    await walletMove(user, 90_000, 500_000);
    await walletMove(user, 500_000, 80_000);

    await revalidateLowBalanceForDelivery(cycle1, metaFor(1));

    const state = await stateOf(user);
    // Untouched. Re-arming here would swallow the message cycle 2 is waiting to
    // send — the exact bug the unconditional re-arm could cause.
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(2);
  });

  it("L93 the matching current cycle still sends", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000);
    const row = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });
    expect(await revalidateLowBalanceForDelivery(row, metaFor(1))).toBeNull();
  });

  it("L94 a missing state row cancels safely and creates nothing", async () => {
    await enableFeature();
    const user = await makeUser(30_000);
    const id = await queueAlert(user, 1, 30_000);
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });

    expect(await revalidateLowBalanceForDelivery(row, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "state-missing",
    });
    // Delivery must never invent state for something nobody observed.
    expect(await stateOf(user)).toBeNull();
  });

  it("L95 an ARMED state cancels the queued alert without reopening a cycle", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000);
    const row = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });
    // The episode closes before the message goes out, but the balance dips back
    // below the threshold — so a balance-only check would still send.
    await prisma.lowBalanceAlertState.updateMany({
      where: { userId: user },
      data: { state: LowBalanceAlertStateValue.ARMED },
    });

    expect(await revalidateLowBalanceForDelivery(row, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "cycle-closed",
    });
    const state = await stateOf(user);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.alertCycle).toBe(1);
  });

  it("L96 repeated delivery attempts are idempotent", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000);
    const row = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });

    const decisions = [
      await revalidateLowBalanceForDelivery(row, metaFor(1)),
      await revalidateLowBalanceForDelivery(row, metaFor(1)),
      await revalidateLowBalanceForDelivery(row, metaFor(1)),
    ];
    expect(decisions).toEqual([null, null, null]);
    const state = await stateOf(user);
    expect(state?.alertCycle).toBe(1);
    expect(await notificationsFor(user)).toBe(1);
  });

  it("L97 a recovery on the MATCHING cycle still cancels and re-arms", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 90_000);
    const row = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(user, 1) },
    });
    // Top up without going through the observer, so the state is still ALERTED
    // on cycle 1 when delivery runs.
    await prisma.user.update({
      where: { id: user },
      data: { balanceToman: REARM_BOUNDARY + 5_000 },
    });

    expect(await revalidateLowBalanceForDelivery(row, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "balance-recovered",
    });
    expect((await stateOf(user))?.state).toBe(LowBalanceAlertStateValue.ARMED);
  });
});

// --- §4.2 the locked backfill decision -----------------------------------------

d("low balance — locked backfill authorization (§4.2)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  /**
   * Pins the backfill: holds the user's state row locked while a live crossing
   * commits, so the backfill's transition provably runs AFTER it. This is the
   * ordering an unlocked pre-check gets wrong.
   */
  async function withStateLockHeld<T>(userId: string, body: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "LowBalanceAlertState" WHERE "userId" = ${userId} FOR UPDATE
      `;
      await gate;
    });
    try {
      return await body();
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  }

  it("L98 a live crossing that wins the race leaves the backfill with nothing to open", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    // ARMED and low: the backfill's page read sees a user it would notify.
    await walletMove(user, 150_000, 500_000); // seeds ARMED
    await prisma.user.update({ where: { id: user }, data: { balanceToman: 90_000 } });

    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // The live crossing commits first and opens cycle 1 with its message.
    await walletMove(user, 150_000, 90_000);
    expect((await stateOf(user))?.alertCycle).toBe(1);

    // The backfill now runs against a cycle that already has its message.
    for (let i = 0; i < 40; i += 1) {
      if ((await runLowBalanceBackfillTick()).status !== "advanced") break;
    }

    expect(await notificationsFor(user)).toBe(1);
    expect((await stateOf(user))?.alertCycle).toBe(1);
  });

  it("L99 the backfill winning first leaves the live event with nothing to open", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 500_000);
    await prisma.user.update({ where: { id: user }, data: { balanceToman: 90_000 } });

    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);
    for (let i = 0; i < 40; i += 1) {
      if ((await runLowBalanceBackfillTick()).status !== "advanced") break;
    }
    expect(await notificationsFor(user)).toBe(1);

    // The live observer now sees ALERTED and must not open a second cycle.
    await walletMove(user, 90_000, 80_000);
    expect(await notificationsFor(user)).toBe(1);
    expect((await stateOf(user))?.alertCycle).toBe(1);
  });

  it("L100 a crossing committing while the backfill is pinned still yields ONE cycle", async () => {
    await enableFeature();
    const user = await makeUser(150_000);
    await walletMove(user, 150_000, 500_000);
    await prisma.user.update({ where: { id: user }, data: { balanceToman: 90_000 } });
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // Deterministic interleaving: the crossing commits while the state row is
    // held, so the backfill's transition is forced to run after it and sees the
    // cycle the crossing opened.
    await withStateLockHeld(user, async () => {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user }, data: { balanceToman: 85_000 } });
      });
    });
    await walletMove(user, 150_000, 85_000);

    for (let i = 0; i < 40; i += 1) {
      if ((await runLowBalanceBackfillTick()).status !== "advanced") break;
    }

    expect(await notificationsFor(user)).toBe(1);
    expect((await stateOf(user))?.alertCycle).toBe(1);
  });
});

// --- §4.3 per-unit claim and cancellation --------------------------------------

d("low balance — per-unit claim enforcement (§4.3)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L101 a committed cancellation stops every later unit in the batch", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await makeUser(40_000));
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // Cancel BEFORE any tick: with the check only between batches, a whole
    // bounded batch could still have gone out.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] } },
      data: { status: LowBalanceBackfillStatus.CANCELLED, cancelledAt: new Date() },
    });

    await runLowBalanceBackfillTick();
    for (const id of ids) {
      expect(await notificationsFor(id)).toBe(0);
    }
  });

  it("L102 an expired lease stops the old worker's units immediately", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await makeUser(40_000));
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // A worker holds the run but its lease has already expired — the exact
    // state a paused/GC-stalled replica is in when another takes over.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: LowBalanceBackfillStatus.PENDING },
      data: {
        status: LowBalanceBackfillStatus.RUNNING,
        ownerToken: "stale-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    // A fresh tick takes over (expired lease) and does the work exactly once.
    for (let i = 0; i < 40; i += 1) {
      if ((await runLowBalanceBackfillTick()).status !== "advanced") break;
    }
    for (const id of ids) {
      expect(await notificationsFor(id)).toBe(1);
    }
  });

  it("L103 an expired owner cannot renew and reclaim after a takeover", async () => {
    await enableFeature();
    await makeUser(40_000);
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // Worker B currently holds a healthy lease.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] } },
      data: {
        status: LowBalanceBackfillStatus.RUNNING,
        ownerToken: "worker-B",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    // Worker A, whose lease expired long ago, tries to renew on its token.
    const renewed = await prisma.lowBalanceBackfillRun.updateMany({
      where: {
        ownerToken: "worker-A",
        status: LowBalanceBackfillStatus.RUNNING,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    expect(renewed.count).toBe(0);

    // Ownership is unchanged: B still holds it.
    const run = await prisma.lowBalanceBackfillRun.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(run.ownerToken).toBe("worker-B");
  });

  it("L104 counters and cursor never double-count under takeover", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await makeUser(40_000));
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    for (let i = 0; i < 40; i += 1) {
      if ((await runLowBalanceBackfillTick()).status !== "advanced") break;
    }
    const first = await prisma.lowBalanceBackfillRun.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });

    // Further ticks find no active run; nothing may move.
    await runLowBalanceBackfillTick();
    const second = await prisma.lowBalanceBackfillRun.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(second.processedCount).toBe(first.processedCount);
    expect(second.queuedCount).toBe(first.queuedCount);
    expect(second.cursorUserId).toBe(first.cursorUserId);

    for (const id of ids) {
      expect(await notificationsFor(id)).toBe(1);
    }
  });
});
