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
  LOW_BALANCE_TEMPLATE_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "low-balance-worker-tests-secret-0123456789";

import {
  cancelLowBalanceBackfill,
  countBackfillCandidates,
  describeBoundaries,
  getLatestBackfill,
  setLowBalanceRearmMargin,
  setLowBalanceThreshold,
  startLowBalanceBackfill,
} from "../src/services/low-balance/low-balance-admin.service.js";
import { getLowBalanceConfig } from "../src/services/low-balance/low-balance.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { runLowBalanceBackfillTick } from "../../worker/src/notifications/low-balance-backfill.js";
import { runLowBalanceReconciliation } from "../../worker/src/notifications/low-balance-reconcile.js";
import { revalidateLowBalanceForDelivery } from "../../worker/src/notifications/low-balance-eligibility.js";

// =============================================================================
// Low wallet balance — the pieces that live OUTSIDE the wallet transaction
// (§6 reconciliation, §8 send-time policy, §11 admin mutations, §12 backfill),
// against a real PostgreSQL.
//
// Money here is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const THRESHOLD = 100_000;
const MARGIN = 20_000;
const REARM_BOUNDARY = THRESHOLD + MARGIN;

const TELEGRAM_ID_BASE = 8_500_000_000_000n;
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

async function enableFeature(enabled = true): Promise<void> {
  await setSettingRow(LOW_BALANCE_ENABLED_KEY, enabled ? "true" : "false", SettingType.BOOLEAN);
  await setSettingRow(LOW_BALANCE_THRESHOLD_KEY, String(THRESHOLD), SettingType.NUMBER);
  await setSettingRow(LOW_BALANCE_REARM_MARGIN_KEY, String(MARGIN), SettingType.NUMBER);
  clearSettingsCache();
}

async function makeUser(
  balanceToman: number,
  overrides: Partial<{
    status: UserStatus;
    lowBalanceNotificationsEnabled: boolean;
    paymentNotificationsEnabled: boolean;
  }> = {},
): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: {
      telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq,
      balanceToman,
      status: overrides.status ?? UserStatus.ACTIVE,
      lowBalanceNotificationsEnabled: overrides.lowBalanceNotificationsEnabled ?? true,
      paymentNotificationsEnabled: overrides.paymentNotificationsEnabled ?? true,
    },
  });
  createdUserIds.push(row.id);
  return row.id;
}

async function seedState(
  userId: string,
  state: LowBalanceAlertStateValue,
  alertCycle = 0,
): Promise<void> {
  await prisma.lowBalanceAlertState.create({
    data: {
      userId,
      state,
      alertCycle,
      lastObservedBalanceToman: 0,
      lastThresholdToman: THRESHOLD,
      lastRearmBoundaryToman: REARM_BOUNDARY,
      lastConfigVersion: 1,
    },
  });
}

/**
 * Drives the backfill to completion in bounded ticks.
 *
 * The run is global by design, so on a shared database one tick need not drain
 * it. Asserting on a single tick's status silently assumes an empty database.
 */
async function drainBackfill(maxTicks = 40): Promise<string> {
  let status = "advanced";
  for (let i = 0; i < maxTicks && status === "advanced"; i += 1) {
    status = (await runLowBalanceBackfillTick()).status;
  }
  return status;
}

function notificationsFor(userId: string): Promise<number> {
  return prisma.automatedNotification.count({
    where: { userId, type: AutomatedNotificationType.WALLET_LOW_BALANCE },
  });
}

async function resetAll(): Promise<void> {
  await prisma.lowBalanceBackfillRun.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.automatedNotification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.lowBalanceAlertState.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  clearSettingsCache();
}

// --- the payload snapshot -----------------------------------------------------

describe("low balance — payload snapshot (§9)", () => {
  it("L35 renders both amounts as formatted Toman, never raw integers", () => {
    const snap = buildLowBalanceSnapshot({
      balanceToman: 90_000,
      thresholdToman: 100_000,
      rearmBoundaryToman: 120_000,
      configVersion: 1,
      alertCycle: 3,
      origin: "event",
    });
    expect(snap.templateKey).toBe(LOW_BALANCE_TEMPLATE_KEY);
    expect(snap.variables.balance).toBe("90,000 تومان");
    expect(snap.variables.threshold).toBe("100,000 تومان");
  });

  it("L36 carries the boundary of the cycle it was opened under", () => {
    const snap = buildLowBalanceSnapshot({
      balanceToman: 10,
      thresholdToman: 500,
      rearmBoundaryToman: 900,
      configVersion: 7,
      alertCycle: 2,
      origin: "reconcile",
    });
    expect(snap.meta.rearmBoundaryToman).toBe(900);
    expect(snap.meta.configVersion).toBe(7);
    expect(snap.meta.alertCycle).toBe(2);
    expect(snap.meta.origin).toBe("reconcile");
  });

  it("L37 contains no user identity of any kind", () => {
    const snap = buildLowBalanceSnapshot({
      balanceToman: 1,
      thresholdToman: 2,
      rearmBoundaryToman: 3,
      configVersion: 1,
      alertCycle: 1,
      origin: "backfill",
    });
    const keys = [...Object.keys(snap.variables), ...Object.keys(snap.meta)];
    for (const forbidden of ["userId", "telegramId", "chatId", "username", "name", "phone"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(snap)).not.toContain("userId");
  });

  it("L38 routes its buttons by constant action codes, not by label", () => {
    const snap = buildLowBalanceSnapshot({
      balanceToman: 1,
      thresholdToman: 2,
      rearmBoundaryToman: 3,
      configVersion: 1,
      alertCycle: 1,
      origin: "event",
    });
    expect(snap.buttons.map((b) => b.action)).toEqual(["t", "w"]);
  });

  it("L39 is identical whichever producer opened the cycle", () => {
    const base = {
      balanceToman: 50_000,
      thresholdToman: 100_000,
      rearmBoundaryToman: 120_000,
      configVersion: 2,
      alertCycle: 4,
    } as const;
    const fromEvent = buildLowBalanceSnapshot({ ...base, origin: "event" });
    const fromSweep = buildLowBalanceSnapshot({ ...base, origin: "reconcile" });
    expect(fromSweep.variables).toEqual(fromEvent.variables);
    expect(fromSweep.buttons).toEqual(fromEvent.buttons);
    // `origin` is the ONLY difference, and it is diagnostics, never rendered.
    expect({ ...fromSweep.meta, origin: "event" }).toEqual(fromEvent.meta);
  });
});

// --- admin mutations ----------------------------------------------------------

d("low balance — admin mutations (§11, §13)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L40 changing a boundary bumps the config version", async () => {
    await enableFeature();
    await setSettingRow(LOW_BALANCE_THRESHOLD_KEY, String(THRESHOLD), SettingType.NUMBER);
    clearSettingsCache();
    const before = (await getLowBalanceConfig()).configVersion;

    const result = await setLowBalanceThreshold(80_000);
    expect(result.ok).toBe(true);
    const after = await getLowBalanceConfig();
    expect(after.thresholdToman).toBe(80_000);
    expect(after.configVersion).toBe(before + 1);
  });

  it("L41 rejects a threshold whose re-arm boundary no balance could reach", async () => {
    await enableFeature();
    // A boundary above INT32 would strand every alerted user permanently
    // ALERTED, because balanceToman can never exceed the column's range.
    const result = await setLowBalanceThreshold(2_000_000_000);
    expect(result).toEqual({ ok: false, reason: "out-of-range" });
    expect((await getLowBalanceConfig()).thresholdToman).toBe(THRESHOLD);
  });

  it("L42 accepts a zero margin and describes it as re-arm above the threshold", async () => {
    await enableFeature();
    const result = await setLowBalanceRearmMargin(0);
    expect(result.ok).toBe(true);
    const config = await getLowBalanceConfig();
    expect(config.rearmMarginToman).toBe(0);
    // With no margin the boundary IS the threshold, so the copy must not claim
    // a band that does not exist.
    expect(describeBoundaries(config)[1]).toContain("100,000 تومان");
  });

  it("L43 rejects a negative or fractional boundary", async () => {
    await enableFeature();
    expect(await setLowBalanceThreshold(-1)).toEqual({ ok: false, reason: "out-of-range" });
    expect(await setLowBalanceRearmMargin(1.5)).toEqual({ ok: false, reason: "out-of-range" });
  });
});

// --- backfill -----------------------------------------------------------------

d("low balance — backfill (§12)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L44 refuses to start while the feature is disabled", async () => {
    await enableFeature(false);
    expect(await startLowBalanceBackfill("admin-1")).toEqual({ ok: false, reason: "disabled" });
  });

  it("L45 allows only ONE active run — a second start is rejected by the database", async () => {
    await enableFeature();
    const first = await startLowBalanceBackfill("admin-1");
    expect(first.ok).toBe(true);
    const second = await startLowBalanceBackfill("admin-1");
    expect(second).toEqual({ ok: false, reason: "already-running" });
    expect(
      await prisma.lowBalanceBackfillRun.count({
        where: {
          status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
        },
      }),
    ).toBe(1);
  });

  it("L46 notifies ARMED low-balance users exactly once and completes", async () => {
    await enableFeature();
    const low = await makeUser(40_000);
    await seedState(low, LowBalanceAlertStateValue.ARMED);
    const rich = await makeUser(900_000);
    await seedState(rich, LowBalanceAlertStateValue.ARMED);

    expect(await startLowBalanceBackfill("admin-1")).toMatchObject({ ok: true });
    const tick = await runLowBalanceBackfillTick();
    expect(tick.status).toBe("completed");

    expect(await notificationsFor(low)).toBe(1);
    expect(await notificationsFor(rich)).toBe(0);
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: low } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(1);

    // Running again produces nothing new: the run is finished and the dedupe
    // key would absorb a repeat anyway.
    expect((await runLowBalanceBackfillTick()).status).toBe("idle");
    expect(await notificationsFor(low)).toBe(1);
  });

  it("L47 skips a user whose current cycle already produced its message", async () => {
    await enableFeature();
    const alreadyNotified = await makeUser(30_000);
    await seedState(alreadyNotified, LowBalanceAlertStateValue.ALERTED, 5);
    // The deterministic key — not the state alone — is the authority on whether
    // this user has already been told.
    await prisma.automatedNotification.create({
      data: {
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
        category: "PAYMENT",
        status: AutomatedNotificationStatus.SENT,
        userId: alreadyNotified,
        dedupeKey: lowBalanceDedupeKey(alreadyNotified, 5),
        ruleVersion: 1,
        scheduledFor: new Date(),
        payloadSnapshot: {} as never,
      },
    });

    await startLowBalanceBackfill("admin-1");
    await drainBackfill();

    // Exactly the one that already existed; no second message.
    expect(await notificationsFor(alreadyNotified)).toBe(1);
    const state = await prisma.lowBalanceAlertState.findUnique({
      where: { userId: alreadyNotified },
    });
    expect(state?.alertCycle).toBe(5);
  });

  it("L47b notifies a silent baseline user (cycle 0) — the whole point of the run", async () => {
    await enableFeature();
    // This is what enabling the feature leaves behind, so if the backfill
    // skipped it the OWNER action would complete having sent almost nothing.
    const baseline = await makeUser(30_000);
    await seedState(baseline, LowBalanceAlertStateValue.ALERTED, 0);

    await startLowBalanceBackfill("admin-1");
    await drainBackfill();

    expect(await notificationsFor(baseline)).toBe(1);
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: baseline } });
    expect(state?.alertCycle).toBe(1);
  });

  it("L47c notifies a low user who has no state row at all", async () => {
    await enableFeature();
    const noState = await makeUser(25_000);

    await startLowBalanceBackfill("admin-1");
    await drainBackfill();

    expect(await notificationsFor(noState)).toBe(1);
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: noState } });
    expect(state?.alertCycle).toBe(1);
  });

  it("L48 skips users who opted out, and inactive users", async () => {
    await enableFeature();
    const optedOut = await makeUser(10_000, { lowBalanceNotificationsEnabled: false });
    await seedState(optedOut, LowBalanceAlertStateValue.ARMED);
    const categoryOff = await makeUser(10_000, { paymentNotificationsEnabled: false });
    await seedState(categoryOff, LowBalanceAlertStateValue.ARMED);
    const blocked = await makeUser(10_000, { status: UserStatus.BLOCKED });
    await seedState(blocked, LowBalanceAlertStateValue.ARMED);

    await startLowBalanceBackfill("admin-1");
    await drainBackfill();

    expect(await notificationsFor(optedOut)).toBe(0);
    expect(await notificationsFor(categoryOff)).toBe(0);
    expect(await notificationsFor(blocked)).toBe(0);
  });

  it("L49 stops enqueuing as soon as the run is cancelled", async () => {
    await enableFeature();
    const low = await makeUser(10_000);
    await seedState(low, LowBalanceAlertStateValue.ARMED);

    await startLowBalanceBackfill("admin-1");
    expect(await cancelLowBalanceBackfill()).toBe(true);

    const tick = await runLowBalanceBackfillTick();
    expect(tick.status).toBe("idle");
    expect(await notificationsFor(low)).toBe(0);
    expect((await getLatestBackfill())?.status).toBe(LowBalanceBackfillStatus.CANCELLED);
  });

  it("L50 counts candidates without reading any user identity", async () => {
    await enableFeature();
    await makeUser(10_000);
    await makeUser(THRESHOLD); // exactly at the boundary counts as low
    await makeUser(THRESHOLD + 1);
    const breakdown = await countBackfillCandidates(await getLowBalanceConfig());
    expect(breakdown.belowThreshold).toBeGreaterThanOrEqual(2);
    expect(breakdown.expectedRecipients).toBeGreaterThanOrEqual(2);
  });

  it("L51 freezes the config it was authorised against", async () => {
    await enableFeature();
    const run = await startLowBalanceBackfill("admin-1");
    expect(run.ok).toBe(true);
    // Moving the threshold afterwards must not re-target the authorised run.
    await setLowBalanceThreshold(500_000);
    const row = await prisma.lowBalanceBackfillRun.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(row.thresholdToman).toBe(THRESHOLD);
    expect(row.rearmBoundaryToman).toBe(REARM_BOUNDARY);
  });
});

// --- reconciliation -----------------------------------------------------------

d("low balance — reconciliation sweep (§6)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L52 does nothing at all while the feature is disabled", async () => {
    await enableFeature(false);
    const stats = await runLowBalanceReconciliation();
    expect(stats.skipped).toBe("disabled");
    expect(stats.enqueued).toBe(0);
  });

  it("L53 seeds an already-low user ALERTED without sending anything", async () => {
    await enableFeature();
    const low = await makeUser(20_000);
    await runLowBalanceReconciliation();

    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: low } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    // The future-crossings-only rule: initialisation NEVER produces a message.
    expect(await notificationsFor(low)).toBe(0);
  });

  it("L54 alerts a crossing the observer missed, exactly once", async () => {
    await enableFeature();
    const user = await makeUser(30_000);
    await seedState(user, LowBalanceAlertStateValue.ARMED);

    await runLowBalanceReconciliation();
    expect(await notificationsFor(user)).toBe(1);

    // A second sweep finds the state already correct and adds nothing.
    await runLowBalanceReconciliation();
    expect(await notificationsFor(user)).toBe(1);
  });

  it("L55 re-arms a recovery the observer missed", async () => {
    await enableFeature();
    const user = await makeUser(REARM_BOUNDARY + 1);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 2);

    await runLowBalanceReconciliation();
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    // Re-arming does NOT open a cycle, so the counter is untouched.
    expect(state?.alertCycle).toBe(2);
    expect(await notificationsFor(user)).toBe(0);
  });

  it("L56 leaves a user inside the hysteresis band alone", async () => {
    await enableFeature();
    // Above the threshold but not yet above the re-arm boundary: neither a new
    // alert nor a re-arm. This is the band that stops a hovering balance from
    // producing a stream of messages.
    const user = await makeUser(THRESHOLD + 1);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);

    await runLowBalanceReconciliation();
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(await notificationsFor(user)).toBe(0);
  });

  it("L57 corrects an ineligible user's state but sends them nothing", async () => {
    await enableFeature();
    const user = await makeUser(10_000, { lowBalanceNotificationsEnabled: false });
    await seedState(user, LowBalanceAlertStateValue.ARMED);

    await runLowBalanceReconciliation();
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user } });
    // The machine must reflect reality even when the user is silent...
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    // ...but silence means silence.
    expect(await notificationsFor(user)).toBe(0);
  });

  it("L58 never scans the User table for the repair phase", async () => {
    await enableFeature();
    const user = await makeUser(30_000);
    await seedState(user, LowBalanceAlertStateValue.ARMED);
    const stats = await runLowBalanceReconciliation();
    // `examined` counts STATE rows paged by keyset, not users.
    expect(stats.examined).toBeGreaterThanOrEqual(1);
    expect(stats.skipped).toBeUndefined();
  });
});

// --- send-time policy ---------------------------------------------------------

d("low balance — send-time policy (§8)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  async function queueAlert(userId: string, cycle: number): Promise<string> {
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
          balanceToman: 10_000,
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

  it("L59 delivers when the balance is still low AND the cycle matches", async () => {
    await enableFeature();
    const user = await makeUser(30_000);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toBeNull();
  });

  it("L60 cancels — and RE-ARMS — when the user topped up before delivery", async () => {
    await enableFeature();
    const user = await makeUser(REARM_BOUNDARY + 5_000);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });

    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "balance-recovered",
    });
    // Leaving the machine ALERTED here would swallow the NEXT real crossing.
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
  });

  it("L61 judges recovery against the boundary the CYCLE was opened under", async () => {
    await enableFeature();
    // Balance sits above the ORIGINAL boundary but below a newly-raised one.
    const user = await makeUser(REARM_BOUNDARY + 1);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    await setLowBalanceThreshold(900_000); // operator raises it AFTER the fact

    // The snapshot's own boundary wins: raising the threshold must not turn a
    // historical alert into a lie by resurrecting it.
    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "balance-recovered",
    });
  });

  it("L62 cancels when the feature was switched off after enqueue", async () => {
    await enableFeature();
    const user = await makeUser(10_000);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    await enableFeature(false);

    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "low-balance-disabled",
    });
  });

  it("L63 honours an opt-out flipped AFTER the alert was queued", async () => {
    await enableFeature();
    const user = await makeUser(10_000);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    await prisma.user.update({
      where: { id: user },
      data: { lowBalanceNotificationsEnabled: false },
    });
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });

    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "low-balance-opted-out",
    });
  });

  it("L64 cancels for a user who is no longer active", async () => {
    await enableFeature();
    const user = await makeUser(10_000);
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 1);
    const id = await queueAlert(user, 1);
    await prisma.user.update({ where: { id: user }, data: { status: UserStatus.BLOCKED } });
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });

    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "user-inactive",
    });
  });

  it("L65 a stale cycle is cancelled as superseded and never touches the newer one", async () => {
    await enableFeature();
    const user = await makeUser(REARM_BOUNDARY + 5_000);
    // The machine has moved on to cycle 4. A stale cycle-1 alert must neither
    // send nor re-arm cycle 4 and swallow the message it is waiting to deliver.
    await seedState(user, LowBalanceAlertStateValue.ALERTED, 4);
    const id = await queueAlert(user, 1);
    const notification = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });

    expect(await revalidateLowBalanceForDelivery(notification, metaFor(1))).toEqual({
      kind: "cancel",
      reason: "cycle-superseded",
    });
    const state = await prisma.lowBalanceAlertState.findUnique({ where: { userId: user } });
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(4);
  });
});
