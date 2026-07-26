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
  INT32_MAX,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_DEDUPE_PREFIX,
  LOW_BALANCE_DEDUPE_SEPARATOR,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "low-balance-linearizability-secret-0123456789";

import {
  countBackfillCandidates,
  setLowBalanceRearmMargin,
  setLowBalanceThreshold,
  startLowBalanceBackfill,
} from "../src/services/low-balance/low-balance-admin.service.js";
import { getLowBalanceConfig } from "../src/services/low-balance/low-balance.service.js";
import { onWalletBalanceChanged } from "../src/services/low-balance/low-balance-hook.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { runLowBalanceBackfillTick } from "../../worker/src/notifications/low-balance-backfill.js";

// =============================================================================
// LINEARIZABLE CLAIMS (§4.1), BOUNDED CANDIDATE COUNTING (§4.2), CRASH-CONSISTENT
// PROGRESS (§4.4) and ATOMIC CONFIGURATION (§4.5).
//
// The races here are pinned with REAL PostgreSQL locks, the way the rest of the
// repository's concurrency tests work. A transaction holding
// `SELECT … FOR UPDATE` on a user's state row stops that user's backfill unit
// mid-flight — AFTER it has taken the run-claim lock — which is the only moment
// at which a cancellation or a takeover can be made to queue behind it. Waiting
// backends are detected through `pg_locks`, so nothing depends on a sleep.
//
// Money is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const THRESHOLD = 100_000;
const MARGIN = 20_000;
const REARM_BOUNDARY = THRESHOLD + MARGIN;

const TELEGRAM_ID_BASE = 8_900_000_000_000n;
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
  await setSettingRow(LOW_BALANCE_CONFIG_VERSION_KEY, "1", SettingType.NUMBER);
  clearSettingsCache();
}

async function makeUser(
  balanceToman: number,
  overrides: {
    status?: UserStatus;
    lowBalanceNotificationsEnabled?: boolean;
    paymentNotificationsEnabled?: boolean;
  } = {},
): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: {
      telegramId: TELEGRAM_ID_BASE + RUN_TAG * 100_000n + seq,
      balanceToman,
      status: overrides.status ?? UserStatus.ACTIVE,
      lowBalanceNotificationsEnabled: overrides.lowBalanceNotificationsEnabled ?? true,
      paymentNotificationsEnabled: overrides.paymentNotificationsEnabled ?? true,
    },
  });
  createdUserIds.push(row.id);
  return row.id;
}

/** Seeds an ARMED state row and then drops the balance, without a witnessed edge. */
async function armedAndLow(balanceToman: number): Promise<string> {
  const id = await makeUser(500_000);
  await prisma.$transaction(async (tx) => {
    await onWalletBalanceChanged(tx, {
      userId: id,
      balanceBeforeToman: 500_000,
      balanceAfterToman: 500_000,
      source: "TEST",
    });
  });
  await prisma.user.update({ where: { id }, data: { balanceToman } });
  return id;
}

function notificationsFor(userId: string): Promise<number> {
  return prisma.automatedNotification.count({
    where: { userId, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
  });
}

/** Every ACTIVE user at or below the threshold, in the order the run walks them. */
async function candidateOrder(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { status: UserStatus.ACTIVE, balanceToman: { lte: THRESHOLD } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

function activeRun() {
  return prisma.lowBalanceBackfillRun.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
}

/**
 * Blocks until at least `n` backends are WAITING on a lock.
 *
 * This is the synchronisation primitive the whole file rests on: it turns "the
 * worker has reached the lock" into an observable fact instead of a sleep.
 */
async function waitForBlockedBackends(n: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted
    `;
    if (Number(row?.n ?? 0n) >= n) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Dump what the backends were actually doing — a silent timeout here is
  // otherwise indistinguishable between "nothing blocked" and "blocked on
  // something else entirely".
  const activity = await prisma.$queryRaw<unknown[]>`
    SELECT state, wait_event_type, wait_event, left(query, 90) AS query
    FROM pg_stat_activity WHERE datname = current_database()
  `;
  throw new Error(
    `timed out waiting for ${n} blocked backend(s): ${JSON.stringify(activity)}`,
  );
}

/**
 * Holds a user's state row locked until `release()` is called.
 *
 * Resolves only once the lock is actually HELD. Returning as soon as the
 * transaction was started is a race of its own: the worker could reach the row
 * first, finish the whole page, and the pin would then be holding a lock nobody
 * is waiting for.
 */
async function pinStateRow(userId: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let acquired!: () => void;
  let failed!: (err: Error) => void;
  const locked = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "LowBalanceAlertState" WHERE "userId" = ${userId} FOR UPDATE
      `;
      if (rows.length !== 1) {
        // A FOR UPDATE over an empty set locks nothing, which would silently
        // turn every test built on this into a no-op.
        failed(new Error("no state row to pin"));
        return;
      }
      acquired();
      await gate;
    },
    { timeout: 120_000 },
  );
  holder.catch((err) => failed(err instanceof Error ? err : new Error(String(err))));
  await locked;
  return {
    release: async () => {
      open();
      await holder.catch(() => undefined);
    },
  };
}

/** Drives ticks to completion, bounded. */
async function drainBackfill(maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await runLowBalanceBackfillTick();
    if (result.status !== "advanced") {
      return;
    }
  }
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

/**
 * Runs one backfill with its first unit pinned, commits `interfere()` while that
 * unit holds the run-claim lock, and returns which users were reached.
 *
 * The result is ONE serial order with both directions in it:
 *
 *   * the pinned unit took the claim lock FIRST, so `interfere()` had to wait
 *     and the unit completed atomically — it is expected to have its message;
 *   * `interfere()` then committed BEFORE the next unit reached the lock, so
 *     every later unit is expected to find the claim gone and write nothing.
 */
async function raceAgainstPinnedUnit(
  interfere: () => Promise<unknown>,
): Promise<{ first: string; later: string[]; status: string }> {
  const mine: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    mine.push(await armedAndLow(40_000));
  }
  expect((await startLowBalanceBackfill("admin-race")).ok).toBe(true);

  // Start the page exactly at the first of MY users, so no unrelated user is
  // touched before the interference lands.
  const order = await candidateOrder();
  const ordered = order.filter((id) => mine.includes(id));
  const first = ordered[0];
  const index = order.indexOf(first);
  if (index > 0) {
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: LowBalanceBackfillStatus.PENDING },
      data: { cursorUserId: order[index - 1] },
    });
  }

  const pin = await pinStateRow(first);
  try {
    // The worker passes its page selection, reaches the first unit, takes the
    // claim lock and then blocks on the pinned state row.
    const tick = runLowBalanceBackfillTick();
    await waitForBlockedBackends(1);

    // Now the interference queues BEHIND that unit's claim lock. The async IIFE
    // is required: Prisma's model methods return a LAZY `PrismaPromise` that
    // dispatches nothing until it is awaited, so `interfere()` on its own would
    // sit inert until the `Promise.all` below — long after the pin is released.
    const interference = (async () => await interfere())();
    await waitForBlockedBackends(2);

    await pin.release();
    const [result] = await Promise.all([tick, interference]);
    return { first, later: ordered.slice(1), status: result.status };
  } finally {
    // Never leave the pin holding a pooled connection if an expectation blew up.
    await pin.release();
  }
}

// --- §4.1 linearizable per-unit claim ------------------------------------------

d("low balance — linearizable backfill claim (§4.1)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L105 a cancellation that lands mid-page stops every unit after the one holding the claim", async () => {
    await enableFeature();
    const { first, later, status } = await raceAgainstPinnedUnit(() =>
      prisma.lowBalanceBackfillRun.updateMany({
        where: {
          status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
        },
        data: { status: LowBalanceBackfillStatus.CANCELLED, cancelledAt: new Date() },
      }),
    );

    // The unit that held the claim first completed atomically.
    expect(await notificationsFor(first)).toBe(1);
    // Everything after it saw the committed cancellation and wrote nothing.
    for (const id of later) {
      expect(await notificationsFor(id)).toBe(0);
      expect(await prisma.lowBalanceAlertState.findUnique({ where: { userId: id } })).toMatchObject({
        state: LowBalanceAlertStateValue.ARMED,
        alertCycle: 0,
      });
    }
    expect(["cancelled", "lost-claim"]).toContain(status);
  });

  it("L106 a lease takeover that lands mid-page stops the old owner immediately", async () => {
    await enableFeature();
    const { first, later, status } = await raceAgainstPinnedUnit(() =>
      prisma.lowBalanceBackfillRun.updateMany({
        where: { status: LowBalanceBackfillStatus.RUNNING },
        data: {
          ownerToken: "worker-B",
          leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        },
      }),
    );

    expect(await notificationsFor(first)).toBe(1);
    for (const id of later) {
      expect(await notificationsFor(id)).toBe(0);
    }
    expect(status).toBe("lost-claim");

    // The old owner's release is guarded on its own token, so the new owner's
    // claim survives untouched.
    expect((await activeRun()).ownerToken).toBe("worker-B");
  });

  it("L107 a cancellation committed before any unit lets nothing at all out", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await armedAndLow(40_000));
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);
    await prisma.lowBalanceBackfillRun.updateMany({
      where: {
        status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
      },
      data: { status: LowBalanceBackfillStatus.CANCELLED, cancelledAt: new Date() },
    });

    await drainBackfill();
    for (const id of ids) {
      expect(await notificationsFor(id)).toBe(0);
    }
    const run = await activeRun();
    expect(run.processedCount).toBe(0);
    expect(run.queuedCount).toBe(0);
    expect(run.cursorUserId).toBeNull();
  });
});

// --- §4.4 crash-consistent progress --------------------------------------------

d("low balance — crash-consistent progress (§4.4)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L108 an interrupted run resumes without duplicating, losing or mis-counting anything", async () => {
    await enableFeature();
    const mineCount = 6;
    const { first, later } = await raceAgainstPinnedUnit(() =>
      // The old worker is taken over mid-page — the durable equivalent of it
      // crashing after some units and before any page-level bookkeeping.
      prisma.lowBalanceBackfillRun.updateMany({
        where: { status: LowBalanceBackfillStatus.RUNNING },
        data: { ownerToken: "worker-B", leaseExpiresAt: new Date(Date.now() - 1_000) },
      }),
    );

    const interrupted = await activeRun();
    // Exactly the units that committed are accounted for — no more, no less.
    expect(interrupted.processedCount).toBe(1);
    expect(interrupted.queuedCount).toBe(1);
    expect(interrupted.cursorUserId).toBe(first);

    // A replacement worker picks the run up (the lease is expired) and finishes.
    await drainBackfill();
    const finished = await activeRun();

    // No duplicates, nothing missed.
    expect(await notificationsFor(first)).toBe(1);
    for (const id of later) {
      expect(await notificationsFor(id)).toBe(1);
    }
    // Totals describe reality, and processed is always queued + skipped.
    expect(finished.queuedCount).toBeGreaterThanOrEqual(mineCount);
    expect(finished.processedCount).toBe(finished.queuedCount + finished.skippedCount);
    // The cursor only ever moved forward.
    expect(finished.cursorUserId).not.toBeNull();
    expect(String(finished.cursorUserId) >= String(interrupted.cursorUserId)).toBe(true);
  });

  it("L109 a unit that commits nothing advances neither the cursor nor the counters", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await armedAndLow(40_000));
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);
    // Cancelled before the first unit: no unit may record progress.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: {
        status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
      },
      data: { status: LowBalanceBackfillStatus.CANCELLED, cancelledAt: new Date() },
    });
    await drainBackfill();

    const run = await activeRun();
    expect(run.processedCount).toBe(0);
    expect(run.skippedCount).toBe(0);
    expect(run.cursorUserId).toBeNull();
  });

  it("L110 counters equal the messages actually queued", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await armedAndLow(40_000));
    }
    // One of them opts out: it must land in skipped, never in queued.
    await prisma.user.update({
      where: { id: ids[2] },
      data: { lowBalanceNotificationsEnabled: false },
    });

    const before = await prisma.automatedNotification.count({
      where: { type: AutomatedNotificationType.WALLET_LOW_BALANCE },
    });
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);
    await drainBackfill();
    const after = await prisma.automatedNotification.count({
      where: { type: AutomatedNotificationType.WALLET_LOW_BALANCE },
    });

    const run = await activeRun();
    // The counter IS the number of messages that appeared. Not a tally kept
    // alongside them, which is what could drift.
    expect(run.queuedCount).toBe(after - before);
    expect(run.processedCount).toBe(run.queuedCount + run.skippedCount);
    expect(run.skippedCount).toBeGreaterThanOrEqual(1);
    expect(await notificationsFor(ids[2])).toBe(0);
    for (const id of [ids[0], ids[1], ids[3], ids[4]]) {
      expect(await notificationsFor(id)).toBe(1);
    }
  });
});

// --- §4.2 bounded, exact candidate counting ------------------------------------

d("low balance — bounded candidate counting (§4.2)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  /** Counts are global, so every assertion is a DELTA around the change. */
  async function delta<T>(body: () => Promise<T>) {
    const before = await countBackfillCandidates(await getLowBalanceConfig());
    await body();
    const after = await countBackfillCandidates(await getLowBalanceConfig());
    return {
      belowThreshold: after.belowThreshold - before.belowThreshold,
      lowBalanceOptOuts: after.lowBalanceOptOuts - before.lowBalanceOptOuts,
      paymentCategoryOptOuts: after.paymentCategoryOptOuts - before.paymentCategoryOptOuts,
      alreadyNotified: after.alreadyNotified - before.alreadyNotified,
      expectedRecipients: after.expectedRecipients - before.expectedRecipients,
    };
  }

  async function setState(
    userId: string,
    state: LowBalanceAlertStateValue,
    alertCycle: number,
  ): Promise<void> {
    await prisma.lowBalanceAlertState.upsert({
      where: { userId },
      update: { state, alertCycle },
      create: {
        userId,
        state,
        alertCycle,
        lastObservedBalanceToman: 40_000,
        lastThresholdToman: THRESHOLD,
        lastRearmBoundaryToman: REARM_BOUNDARY,
        lastConfigVersion: 1,
      },
    });
  }

  async function queueFor(userId: string, cycle: number): Promise<void> {
    await prisma.automatedNotification.create({
      data: {
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
        category: "PAYMENT",
        status: AutomatedNotificationStatus.SCHEDULED,
        userId,
        dedupeKey: lowBalanceDedupeKey(userId, cycle),
        ruleVersion: 1,
        scheduledFor: new Date(),
        payloadSnapshot: buildLowBalanceSnapshot({
          balanceToman: 40_000,
          thresholdToman: THRESHOLD,
          rearmBoundaryToman: REARM_BOUNDARY,
          configVersion: 1,
          alertCycle: cycle,
          origin: "event",
        }) as never,
      },
    });
  }

  it("L111 a user with no state row is an expected recipient", async () => {
    await enableFeature();
    const change = await delta(async () => {
      await makeUser(40_000);
    });
    expect(change).toMatchObject({ belowThreshold: 1, alreadyNotified: 0, expectedRecipients: 1 });
  });

  it("L112 the SQL-composed dedupe key is byte-identical to the shared helper", async () => {
    await enableFeature();
    const user = await makeUser(40_000);
    await setState(user, LowBalanceAlertStateValue.ALERTED, 7);
    // Composed exactly the way the aggregate composes it, from the same shared
    // constants — so a change to either spelling fails here first.
    const [row] = await prisma.$queryRaw<{ composed: string }[]>`
      SELECT ${LOW_BALANCE_DEDUPE_PREFIX} || u."id" ||
             ${LOW_BALANCE_DEDUPE_SEPARATOR} || s."alertCycle"::text AS composed
      FROM "User" u
      JOIN "LowBalanceAlertState" s ON s."userId" = u."id"
      WHERE u."id" = ${user}
    `;
    expect(row?.composed).toBe(lowBalanceDedupeKey(user, 7));
  });

  it("L113 an ARMED user holding an OLD cycle's notification is still an expected recipient", async () => {
    await enableFeature();
    // The regression: the run will open cycle 4 and queue a message, so counting
    // this user as "already notified" under-promised what it would actually send.
    const change = await delta(async () => {
      const user = await makeUser(40_000);
      await setState(user, LowBalanceAlertStateValue.ARMED, 3);
      await queueFor(user, 3);
    });
    expect(change).toMatchObject({ alreadyNotified: 0, expectedRecipients: 1 });
  });

  it("L114 an ALERTED silent baseline (cycle 0) is an expected recipient", async () => {
    await enableFeature();
    const change = await delta(async () => {
      const user = await makeUser(40_000);
      await setState(user, LowBalanceAlertStateValue.ALERTED, 0);
    });
    expect(change).toMatchObject({ alreadyNotified: 0, expectedRecipients: 1 });
  });

  it("L115 ALERTED above cycle 0 counts as notified only when THAT cycle has its message", async () => {
    await enableFeature();
    const without = await delta(async () => {
      const user = await makeUser(40_000);
      await setState(user, LowBalanceAlertStateValue.ALERTED, 5);
    });
    expect(without).toMatchObject({ alreadyNotified: 0, expectedRecipients: 1 });

    const withMessage = await delta(async () => {
      const user = await makeUser(40_000);
      await setState(user, LowBalanceAlertStateValue.ALERTED, 5);
      await queueFor(user, 5);
    });
    expect(withMessage).toMatchObject({ alreadyNotified: 1, expectedRecipients: 0 });

    // A message for a DIFFERENT cycle does not count.
    const otherCycle = await delta(async () => {
      const user = await makeUser(40_000);
      await setState(user, LowBalanceAlertStateValue.ALERTED, 5);
      await queueFor(user, 4);
    });
    expect(otherCycle).toMatchObject({ alreadyNotified: 0, expectedRecipients: 1 });
  });

  it("L116 opt-outs are counted in their own bucket and inactive users not at all", async () => {
    await enableFeature();
    const focused = await delta(async () => {
      await makeUser(40_000, { lowBalanceNotificationsEnabled: false });
    });
    expect(focused).toMatchObject({
      belowThreshold: 1,
      lowBalanceOptOuts: 1,
      paymentCategoryOptOuts: 0,
      expectedRecipients: 0,
    });

    const category = await delta(async () => {
      await makeUser(40_000, { paymentNotificationsEnabled: false });
    });
    expect(category).toMatchObject({
      belowThreshold: 1,
      lowBalanceOptOuts: 0,
      paymentCategoryOptOuts: 1,
      expectedRecipients: 0,
    });

    const inactive = await delta(async () => {
      await makeUser(40_000, { status: UserStatus.BLOCKED });
    });
    expect(inactive).toMatchObject({ belowThreshold: 0, expectedRecipients: 0 });
  });

  it("L117 the estimate matches what a run on unchanged data actually queues", async () => {
    await enableFeature();
    for (let i = 0; i < 4; i += 1) {
      await armedAndLow(40_000);
    }
    await makeUser(40_000, { lowBalanceNotificationsEnabled: false });

    const estimate = await countBackfillCandidates(await getLowBalanceConfig());
    const started = await startLowBalanceBackfill("admin-1");
    expect(started.ok).toBe(true);
    await drainBackfill();

    const run = await activeRun();
    expect(run.estimatedCount).toBe(estimate.expectedRecipients);
    expect(run.queuedCount).toBe(estimate.expectedRecipients);
  });

  it("L118 counts 100,000 users with bounded memory and no oversized statement", async () => {
    await enableFeature();
    const marker = TELEGRAM_ID_BASE + 90_000_000_000n;
    try {
      // Bulk-inserted database-side: the point of the test is that nothing about
      // this population reaches the application.
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "telegramId", "balanceToman", "status", "updatedAt")
        SELECT gen_random_uuid(), ${marker} + g, 1000, 'ACTIVE', NOW()
        FROM generate_series(1, 100000) AS g
      `;

      const before = process.memoryUsage().heapUsed;
      const counted = await countBackfillCandidates(await getLowBalanceConfig());
      const heapGrowth = process.memoryUsage().heapUsed - before;

      expect(counted.belowThreshold).toBeGreaterThanOrEqual(100_000);
      expect(counted.expectedRecipients).toBeGreaterThanOrEqual(100_000);
      // The old implementation materialised one id and one dedupe key per user
      // and sent them as a single `IN` list — tens of megabytes of strings, and
      // far past PostgreSQL's 65535 bind-parameter ceiling. Completing at all is
      // the proof that neither happens now; the heap bound makes it explicit.
      expect(heapGrowth).toBeLessThan(50 * 1024 * 1024);
    } finally {
      // An exact range — an open-ended `gte` would sweep up other suites' rows.
      await prisma.user.deleteMany({
        where: { telegramId: { gt: marker, lte: marker + 100_000n } },
      });
    }
  }, 120_000);
});

// --- §4.5 atomic configuration -------------------------------------------------

d("low balance — atomic configuration mutation (§4.5)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  async function storedConfig(): Promise<{
    thresholdToman: number;
    rearmMarginToman: number;
    configVersion: number;
  }> {
    clearSettingsCache();
    const config = await getLowBalanceConfig();
    return {
      thresholdToman: config.thresholdToman,
      rearmMarginToman: config.rearmMarginToman,
      configVersion: config.configVersion,
    };
  }

  it("L119 a failure between the boundary and the version write rolls BOTH back", async () => {
    await enableFeature();
    const before = await storedConfig();

    // A database-level injection: the version write is made to fail for real,
    // which is the only honest way to prove the two writes share a transaction.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION zedbot_test_block_lb_version() RETURNS trigger AS $$
      BEGIN
        IF NEW."key" = '${LOW_BALANCE_CONFIG_VERSION_KEY}' THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER zedbot_test_block_lb_version
      BEFORE INSERT OR UPDATE ON "Setting"
      FOR EACH ROW EXECUTE FUNCTION zedbot_test_block_lb_version();
    `);
    try {
      await expect(setLowBalanceThreshold(before.thresholdToman + 5_000)).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zedbot_test_block_lb_version ON "Setting";`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zedbot_test_block_lb_version();`);
    }

    // Neither half landed: no new boundary under an old version.
    expect(await storedConfig()).toEqual(before);
  });

  it("L120 concurrent threshold updates produce monotonic versions with none lost", async () => {
    await enableFeature();
    const before = await storedConfig();
    const writers = 5;

    const results = await Promise.all(
      Array.from({ length: writers }, (_, i) => setLowBalanceThreshold(50_000 + i * 1_000)),
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const after = await storedConfig();
    // Serialized by the configuration lock: every writer read the previous
    // version and added exactly one. A lost increment would show up here.
    expect(after.configVersion).toBe(before.configVersion + writers);
    const versions = results.map((r) => (r.ok ? r.config.configVersion : -1)).sort((a, b) => a - b);
    expect(versions).toEqual(
      Array.from({ length: writers }, (_, i) => before.configVersion + i + 1),
    );
  });

  it("L121 a concurrent threshold and margin change leave one valid combined snapshot", async () => {
    await enableFeature();
    const before = await storedConfig();

    await Promise.all([setLowBalanceThreshold(70_000), setLowBalanceRearmMargin(30_000)]);

    const after = await storedConfig();
    expect(after.thresholdToman).toBe(70_000);
    expect(after.rearmMarginToman).toBe(30_000);
    expect(after.configVersion).toBe(before.configVersion + 2);
    expect(after.thresholdToman + after.rearmMarginToman).toBeLessThanOrEqual(INT32_MAX);
  });

  it("L122 a backfill freezes ONE coherent configuration tuple", async () => {
    await enableFeature();
    const beforeTuple = await storedConfig();

    // A boundary change races the run creation; the frozen tuple must match one
    // snapshot or the other, never a mixture of the two.
    const [started] = await Promise.all([
      startLowBalanceBackfill("admin-1"),
      setLowBalanceThreshold(60_000),
    ]);
    expect(started.ok).toBe(true);

    const run = await activeRun();
    const afterTuple = await storedConfig();
    const candidates = [beforeTuple, afterTuple];
    const matched = candidates.find(
      (tuple) =>
        run.thresholdToman === tuple.thresholdToman &&
        run.rearmBoundaryToman === tuple.thresholdToman + tuple.rearmMarginToman &&
        run.configVersion === tuple.configVersion,
    );
    expect(matched).toBeDefined();
  });
});
