import {
  applyLowBalanceObservation,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  prisma,
  SettingType,
  UserStatus,
} from "@zedbot/database";
import {
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "low-balance-first-observation-secret-0123456789";

import { onWalletBalanceChanged } from "../src/services/low-balance/low-balance-hook.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { acquireLease, releaseLease } from "../../worker/src/notifications/low-balance-lease.js";
import { runLowBalanceReconciliation } from "../../worker/src/notifications/low-balance-reconcile.js";

// =============================================================================
// FIRST OBSERVATION and CONCURRENT STATE CREATION (§4.1, §4.2), plus the
// atomicity invariant (§4.4) and the reconciliation lease (§4.5).
//
// The scenario these exist for: an OWNER enables the feature, and before the
// sweep has reached a user, that user's very next purchase takes them from
// comfortably funded to below the threshold. That is the single most likely
// real crossing there is, and it is exactly the one an implementation without
// the authoritative BEFORE balance silently loses.
//
// Money here is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const THRESHOLD = 100_000;
const MARGIN = 20_000;
const REARM_BOUNDARY = THRESHOLD + MARGIN;

const TELEGRAM_ID_BASE = 8_600_000_000_000n;
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
      telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq,
      balanceToman,
      status: UserStatus.ACTIVE,
    },
  });
  createdUserIds.push(row.id);
  return row.id;
}

/** A wallet mutation exactly as the real sites perform it. */
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

function stateOf(userId: string) {
  return prisma.lowBalanceAlertState.findUnique({ where: { userId } });
}

function notificationsFor(userId: string): Promise<number> {
  return prisma.automatedNotification.count({
    where: { userId, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
  });
}

async function resetAll(): Promise<void> {
  await prisma.lowBalanceReconciliationState.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.automatedNotification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.lowBalanceAlertState.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  clearSettingsCache();
}

// --- §4.1 first-observation semantics -----------------------------------------

d("low balance — first observation (§4.1)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L66 the first post-enable debit that CROSSES alerts exactly once", async () => {
    await enableFeature();
    // No state row: the feature was just enabled and the sweep has not run.
    const userId = await makeUser(150_000);
    expect(await stateOf(userId)).toBeNull();

    await walletMove(userId, 150_000, 90_000);

    // This is the regression. Without the authoritative before balance the
    // machine cannot tell this from a user who was always low, and the alert
    // is silently swallowed.
    expect(await notificationsFor(userId)).toBe(1);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(1);
  });

  it("L67 a historically low user stays silent on their first observation", async () => {
    await enableFeature();
    const userId = await makeUser(40_000);

    // Already low before AND after: no crossing was witnessed, so claiming one
    // would be a lie. Silent baseline, cycle 0.
    await walletMove(userId, 40_000, 30_000);

    expect(await notificationsFor(userId)).toBe(0);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(0);
  });

  it("L68 a first observation above the threshold becomes ARMED", async () => {
    await enableFeature();
    const userId = await makeUser(500_000);

    await walletMove(userId, 500_000, 400_000);

    expect(await notificationsFor(userId)).toBe(0);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.alertCycle).toBe(0);
  });

  it("L69 a first observation that is a TOP-UP never alerts", async () => {
    await enableFeature();
    const userId = await makeUser(30_000);

    // Low -> recovered on the very first observation. The final state must
    // reflect the money, and no alert may be invented on the way through.
    await walletMove(userId, 30_000, 500_000);

    expect(await notificationsFor(userId)).toBe(0);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.lastObservedBalanceToman).toBe(500_000);
  });

  it("L70 a first observation landing inside the hysteresis band is ARMED, silently", async () => {
    await enableFeature();
    const userId = await makeUser(500_000);

    // Above the alert boundary but below the re-arm boundary. With no history
    // there is no alert to recover from, so ARMED is the truthful state.
    await walletMove(userId, 500_000, THRESHOLD + 1);

    expect(await notificationsFor(userId)).toBe(0);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ARMED);
  });

  it("L71 the crossing alert carries the boundaries it was opened under", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await walletMove(userId, 150_000, 50_000);

    const row = await prisma.automatedNotification.findUniqueOrThrow({
      where: { dedupeKey: lowBalanceDedupeKey(userId, 1) },
    });
    const meta = (row.payloadSnapshot as { meta: Record<string, number | string> }).meta;
    expect(meta.thresholdToman).toBe(THRESHOLD);
    expect(meta.rearmBoundaryToman).toBe(REARM_BOUNDARY);
    expect(meta.alertCycle).toBe(1);
  });
});

// --- §4.2 concurrent first-state creation -------------------------------------

d("low balance — concurrent first-state creation (§4.2)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L72 two concurrent first observations: no wallet failure, one state row, one cycle", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    expect(await stateOf(userId)).toBeNull();

    // Both transactions see NO state row. A create-then-lock implementation has
    // both of them INSERT, and the loser's unique violation aborts a REAL
    // financial transaction. Neither may fail here.
    const results = await Promise.allSettled([
      walletMove(userId, 150_000, 90_000),
      walletMove(userId, 150_000, 80_000),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    expect(await prisma.lowBalanceAlertState.count({ where: { userId } })).toBe(1);
    expect(await notificationsFor(userId)).toBe(1);
    const state = await stateOf(userId);
    expect(state?.alertCycle).toBe(1);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
  });

  it("L73 twelve concurrent first observations still yield one row and one alert", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => walletMove(userId, 150_000, 90_000 - i * 100)),
    );
    const failed = results.filter((r) => r.status === "rejected");
    // A notification-bookkeeping race must never cost a wallet mutation.
    expect(failed).toHaveLength(0);

    expect(await prisma.lowBalanceAlertState.count({ where: { userId } })).toBe(1);
    expect(await notificationsFor(userId)).toBe(1);
  });

  it("L74 the final state agrees with the final committed balance", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);

    await Promise.allSettled([
      walletMove(userId, 150_000, 90_000),
      walletMove(userId, 150_000, 90_000),
    ]);
    // Now genuinely recover, and the machine must follow the money.
    await walletMove(userId, 90_000, 500_000);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.lastObservedBalanceToman).toBe(user.balanceToman);
  });

  it("L75 a crossing racing a plain initialisation still produces exactly one cycle", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);

    // One path witnesses the crossing; the other is the sweep initialising the
    // same user. Whichever wins, the user must end up with one cycle at most.
    await Promise.allSettled([
      walletMove(userId, 150_000, 90_000),
      runLowBalanceReconciliation(),
    ]);

    expect(await prisma.lowBalanceAlertState.count({ where: { userId } })).toBe(1);
    expect(await notificationsFor(userId)).toBeLessThanOrEqual(1);
  });
});

// --- §4.4 atomicity ------------------------------------------------------------

d("low balance — state and outbox atomicity (§4.4)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L76 a failure AFTER the transition rolls back the state too", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);

    await expect(
      prisma.$transaction(async (tx) => {
        await applyLowBalanceObservation(tx, {
          userId,
          balanceBeforeToman: 150_000,
          balanceAfterToman: 90_000,
          thresholdToman: THRESHOLD,
          rearmBoundaryToman: REARM_BOUNDARY,
          configVersion: 1,
          eligible: true,
          buildNotification: (cycle) => ({
            dedupeKey: lowBalanceDedupeKey(userId, cycle),
            ruleVersion: 1,
            payloadSnapshot: { variables: {}, meta: {} } as never,
          }),
        });
        throw new Error("injected failure after the transition");
      }),
    ).rejects.toThrow("injected failure");

    // Neither half survived. An ALERTED row with no message would make every
    // later pass skip this user as "already alerted" — silent forever.
    expect(await stateOf(userId)).toBeNull();
    expect(await notificationsFor(userId)).toBe(0);
  });

  it("L77 a failure AFTER the outbox insert rolls back the notification too", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);

    await expect(
      prisma.$transaction(async (tx) => {
        const outcome = await applyLowBalanceObservation(tx, {
          userId,
          balanceBeforeToman: 150_000,
          balanceAfterToman: 90_000,
          thresholdToman: THRESHOLD,
          rearmBoundaryToman: REARM_BOUNDARY,
          configVersion: 1,
          eligible: true,
          buildNotification: (cycle) => ({
            dedupeKey: lowBalanceDedupeKey(userId, cycle),
            ruleVersion: 1,
            payloadSnapshot: { variables: {}, meta: {} } as never,
          }),
        });
        expect(outcome.kind).toBe("alerted");
        throw new Error("injected failure after the outbox insert");
      }),
    ).rejects.toThrow("injected failure");

    expect(await notificationsFor(userId)).toBe(0);
    expect(await stateOf(userId)).toBeNull();
  });

  it("L78 every committed non-baseline cycle has its deterministic message", async () => {
    await enableFeature();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await makeUser(150_000);
      ids.push(id);
      await walletMove(id, 150_000, 40_000);
    }

    // The invariant, stated directly: cycle > 0 implies a row under its key.
    for (const id of ids) {
      const state = await stateOf(id);
      expect(state?.alertCycle).toBe(1);
      const row = await prisma.automatedNotification.findUnique({
        where: { dedupeKey: lowBalanceDedupeKey(id, 1) },
      });
      expect(row).not.toBeNull();
    }
  });
});

// --- §4.5 lease and cursor -----------------------------------------------------

d("low balance — reconciliation lease and cursor (§4.5)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L79 only one holder at a time; a second acquisition is refused", async () => {
    const first = await acquireLease(new Date());
    expect(first).not.toBeNull();
    expect(await acquireLease(new Date())).toBeNull();
    await releaseLease(first!.ownerToken, new Date(), false);
    // Released: the next caller may take it.
    const third = await acquireLease(new Date());
    expect(third).not.toBeNull();
    await releaseLease(third!.ownerToken, new Date(), false);
  });

  it("L80 an EXPIRED lease is taken over — a crashed worker cannot strand the sweep", async () => {
    const crashed = await acquireLease(new Date());
    expect(crashed).not.toBeNull();
    // The worker dies without releasing. Nothing calls releaseLease.
    const later = new Date(Date.now() + 10 * 60_000);
    const takeover = await acquireLease(later);
    expect(takeover).not.toBeNull();
    expect(takeover?.ownerToken).not.toBe(crashed?.ownerToken);
    await releaseLease(takeover!.ownerToken, later, false);
  });

  it("L81 a concurrent sweep returns 'locked' rather than duplicating work", async () => {
    await enableFeature();
    const userId = await makeUser(40_000);

    const [a, b] = await Promise.all([
      runLowBalanceReconciliation(),
      runLowBalanceReconciliation(),
    ]);
    const skipped = [a, b].filter((r) => r.skipped === "locked");
    expect(skipped).toHaveLength(1);

    // And the work that did run was still correct + silent for a baseline user.
    expect(await notificationsFor(userId)).toBe(0);
    expect((await stateOf(userId))?.alertCycle).toBe(0);
  });

  it("L82 progress is durable: a completed sweep wraps its cursors", async () => {
    await enableFeature();
    await makeUser(40_000);
    const stats = await runLowBalanceReconciliation();
    expect(stats.completed).toBe(true);

    const control = await prisma.lowBalanceReconciliationState.findUnique({
      where: { singletonKey: "default" },
    });
    // Wrapped, so the next pass re-examines the head instead of pinning to the
    // tail of a table whose end happens to be clean.
    expect(control?.initCursorUserId).toBeNull();
    expect(control?.repairCursorId).toBeNull();
    expect(control?.ownerToken).toBeNull();
    expect(control?.completedSweepCount).toBeGreaterThanOrEqual(1);
  });

  it("L83 the sweep leaves no connection-level lock behind", async () => {
    await enableFeature();
    await makeUser(40_000);
    await runLowBalanceReconciliation();

    // The old implementation took a SESSION advisory lock through the pool. If
    // any survived, this count would be non-zero.
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory'
    `;
    expect(Number(count)).toBe(0);
  });
});
