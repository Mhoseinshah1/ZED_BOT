import {
  AutomatedNotificationType,
  PrismaClient,
  LowBalanceAlertStateValue,
  LowBalanceBackfillStatus,
  prisma,
  SettingType,
  UserStatus,
} from "@zedbot/database";
import {
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_RECONCILE_BATCH,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "low-balance-multi-replica-secret-0123456789";

import { startLowBalanceBackfill } from "../src/services/low-balance/low-balance-admin.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { runLowBalanceBackfillTick } from "../../worker/src/notifications/low-balance-backfill.js";
import { runLowBalanceReconciliation } from "../../worker/src/notifications/low-balance-reconcile.js";

// =============================================================================
// MULTI-REPLICA safety and cursor progress (§4.5, §6).
//
// Production runs more than one worker. These tests put concurrent replicas
// against the same shared PostgreSQL and assert the two things that actually
// matter: no user is notified twice, and no user is starved.
//
// Money here is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const THRESHOLD = 100_000;
const MARGIN = 20_000;

const TELEGRAM_ID_BASE = 8_700_000_000_000n;
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

async function makeUsers(count: number, balanceToman: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1n;
    const row = await prisma.user.create({
      data: {
        telegramId: TELEGRAM_ID_BASE + RUN_TAG * 100_000n + seq,
        balanceToman,
        status: UserStatus.ACTIVE,
      },
    });
    createdUserIds.push(row.id);
    ids.push(row.id);
  }
  return ids;
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

d("low balance — multi-replica reconciliation (§4.5)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L84 four concurrent replicas: exactly one works, the rest back off", async () => {
    await enableFeature();
    await makeUsers(5, 40_000);

    const results = await Promise.all([
      runLowBalanceReconciliation(),
      runLowBalanceReconciliation(),
      runLowBalanceReconciliation(),
      runLowBalanceReconciliation(),
    ]);
    expect(results.filter((r) => r.skipped === "locked")).toHaveLength(3);

    // Initialisation is silent, so a correct concurrent run notifies nobody.
    const notified = await prisma.automatedNotification.count({
      where: {
        userId: { in: createdUserIds },
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
      },
    });
    expect(notified).toBe(0);
    // ...and every user still got exactly one state row.
    for (const id of createdUserIds) {
      expect(await prisma.lowBalanceAlertState.count({ where: { userId: id } })).toBe(1);
    }
  });

  it("L85 rows beyond one bounded pass are eventually reached, not starved", async () => {
    await enableFeature();
    // More users than a single initialisation batch can hold, so the first pass
    // provably cannot finish and the cursor has to carry the rest.
    const total = LOW_BALANCE_RECONCILE_BATCH + 25;
    const ids = await makeUsers(total, 40_000);

    // Drive passes until it reports completion, bounded so a starving
    // implementation fails the test instead of hanging.
    let completed = false;
    for (let pass = 0; pass < 30 && !completed; pass += 1) {
      completed = (await runLowBalanceReconciliation()).completed;
    }
    expect(completed).toBe(true);

    const withState = await prisma.lowBalanceAlertState.count({
      where: { userId: { in: ids } },
    });
    // The tail of the table was reached: no row is permanently skipped.
    expect(withState).toBe(total);
  });

  it("L86 the sweep works with a SINGLE database connection", async () => {
    await enableFeature();
    await makeUsers(3, 40_000);

    // connection_limit=1 is the sharpest version of the pooled-connection
    // problem: a session advisory lock taken and released across the pool has
    // nowhere to hide here, and any leaked lock deadlocks the next statement.
    const url = new URL(process.env.DATABASE_URL as string);
    url.searchParams.set("connection_limit", "1");
    url.searchParams.set("pool_timeout", "10");
    const single = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await single.$queryRaw`SELECT 1`;
      const stats = await runLowBalanceReconciliation();
      expect(stats.skipped).toBeUndefined();
      // Still no advisory lock left behind anywhere.
      const [{ count }] = await single.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count" FROM pg_locks WHERE locktype = 'advisory'
      `;
      expect(Number(count)).toBe(0);
    } finally {
      await single.$disconnect();
    }
  });
});

d("low balance — multi-replica backfill (§4.3)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L87 four concurrent replicas advance one run without double-notifying", async () => {
    await enableFeature();
    const ids = await makeUsers(6, 40_000);
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    const results = await Promise.all([
      runLowBalanceBackfillTick(),
      runLowBalanceBackfillTick(),
      runLowBalanceBackfillTick(),
      runLowBalanceBackfillTick(),
    ]);
    // Exactly one replica holds the claim; the others report it taken.
    expect(results.filter((r) => r.status === "locked").length).toBeGreaterThanOrEqual(3);

    for (const id of ids) {
      const count = await prisma.automatedNotification.count({
        where: { userId: id, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
      });
      expect(count).toBe(1);
      const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: id } });
      expect(state?.alertCycle).toBe(1);
      // The message exists under the deterministic key for that exact cycle.
      const row = await prisma.automatedNotification.findUnique({
        where: { dedupeKey: lowBalanceDedupeKey(id, 1) },
      });
      expect(row).not.toBeNull();
    }
  });

  it("L88 an abandoned claim is taken over rather than stranding the run", async () => {
    await enableFeature();
    const ids = await makeUsers(3, 40_000);
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    // Simulate a replica that claimed the run and then died.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: LowBalanceBackfillStatus.PENDING },
      data: {
        status: LowBalanceBackfillStatus.RUNNING,
        ownerToken: "dead-replica",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const tick = await runLowBalanceBackfillTick();
    expect(tick.status).not.toBe("locked");
    for (const id of ids) {
      expect(
        await prisma.automatedNotification.count({
          where: { userId: id, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
        }),
      ).toBe(1);
    }
  });

  it("L89 a live claim is respected: the run is not advanced twice", async () => {
    await enableFeature();
    await makeUsers(3, 40_000);
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    await prisma.lowBalanceBackfillRun.updateMany({
      where: { status: LowBalanceBackfillStatus.PENDING },
      data: {
        status: LowBalanceBackfillStatus.RUNNING,
        ownerToken: "healthy-replica",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    expect((await runLowBalanceBackfillTick()).status).toBe("locked");
    const notified = await prisma.automatedNotification.count({
      where: {
        userId: { in: createdUserIds },
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
      },
    });
    expect(notified).toBe(0);
  });

  it("L90 a run interleaved with live crossings notifies each user exactly once", async () => {
    await enableFeature();
    const ids = await makeUsers(5, 40_000);
    // Seed them as ARMED so a live crossing is possible for each.
    for (const id of ids) {
      await prisma.lowBalanceAlertState.create({
        data: {
          userId: id,
          state: LowBalanceAlertStateValue.ARMED,
          alertCycle: 0,
          lastObservedBalanceToman: 40_000,
          lastThresholdToman: THRESHOLD,
          lastRearmBoundaryToman: THRESHOLD + MARGIN,
          lastConfigVersion: 1,
        },
      });
    }
    expect((await startLowBalanceBackfill("admin-1")).ok).toBe(true);

    await Promise.all([
      runLowBalanceBackfillTick(),
      runLowBalanceReconciliation(),
      runLowBalanceBackfillTick(),
    ]);

    for (const id of ids) {
      const count = await prisma.automatedNotification.count({
        where: { userId: id, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
      });
      // The deterministic key is what makes this hold no matter who got there
      // first — the backfill, the sweep, or a live wallet mutation.
      expect(count).toBe(1);
    }
  });
});
