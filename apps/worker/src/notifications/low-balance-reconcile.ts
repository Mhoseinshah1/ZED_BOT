import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  prisma,
  UserStatus,
} from "@zedbot/database";
import {
  createLogger,
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_RECONCILE_BATCH,
  LOW_BALANCE_RECONCILE_MAX_BATCHES,
  LOW_BALANCE_RULE_VERSION,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";

// =============================================================================
// Low-balance RECONCILIATION (§6).
//
// A REPAIR mechanism, not the primary trigger. The event-driven observer in the
// wallet transaction is authoritative; this sweep exists for the gaps it cannot
// cover: rows written before the feature shipped, a legacy code path that
// bypasses the observer, and the (transaction-aborting) failure modes where the
// observer's own write was lost.
//
// SCALE. It never scans `User`. It pages `LowBalanceAlertState` by keyset on the
// primary key in bounded batches, and only joins back to the user's balance for
// the rows in the current page. Users with no state row at all are discovered
// through a separate bounded keyset page over ACTIVE users, so first-time
// initialisation is also incremental.
//
// SAFETY. It advances the machine exactly like the observer does, through the
// same dedupe key, so it can never produce a second message for a cycle that
// already has one. A user it initialises for the first time who is ALREADY low
// is recorded ALERTED WITHOUT a message — the future-crossings-only rule.
// =============================================================================

const log = createLogger("worker:low-balance-reconcile");

/** Advisory-lock key: one reconciliation sweep across all replicas. */
const RECONCILE_LOCK_KEY = "zedbot-low-balance-reconcile";

export interface ReconcileStats {
  examined: number;
  repairedAlerted: number;
  repairedRearmed: number;
  initialised: number;
  enqueued: number;
  durationMs: number;
  skipped?: "disabled" | "locked";
}

interface Config {
  thresholdToman: number;
  rearmBoundaryToman: number;
  configVersion: number;
}

async function loadConfig(): Promise<{ enabled: boolean; config: Config }> {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          LOW_BALANCE_ENABLED_KEY,
          LOW_BALANCE_THRESHOLD_KEY,
          LOW_BALANCE_REARM_MARGIN_KEY,
          LOW_BALANCE_CONFIG_VERSION_KEY,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const raw = (byKey.get(LOW_BALANCE_ENABLED_KEY) ?? "").toLowerCase();
  const int = (key: string, fallback: number): number => {
    const value = Number(byKey.get(key));
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  const threshold = int(LOW_BALANCE_THRESHOLD_KEY, DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN);
  const margin = int(LOW_BALANCE_REARM_MARGIN_KEY, DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN);
  return {
    enabled: raw === "true" || raw === "1" || raw === "yes",
    config: {
      thresholdToman: threshold,
      rearmBoundaryToman: threshold + margin,
      configVersion: int(LOW_BALANCE_CONFIG_VERSION_KEY, 1),
    },
  };
}

/**
 * One bounded reconciliation pass.
 *
 * Multi-replica safe: the whole pass runs under a transaction-level advisory
 * lock, so a second replica finds it taken and returns immediately rather than
 * duplicating work. Restart-safe: every batch commits on its own, and the sweep
 * is idempotent, so an interrupted pass simply resumes next tick.
 */
export async function runLowBalanceReconciliation(): Promise<ReconcileStats> {
  const startedAt = Date.now();
  const empty: ReconcileStats = {
    examined: 0,
    repairedAlerted: 0,
    repairedRearmed: 0,
    initialised: 0,
    enqueued: 0,
    durationMs: 0,
  };

  const { enabled, config } = await loadConfig();
  if (!enabled) {
    return { ...empty, durationMs: Date.now() - startedAt, skipped: "disabled" };
  }

  // pg_try_advisory_lock: never block a worker tick waiting for a peer.
  const [lock] = await prisma.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${RECONCILE_LOCK_KEY})) AS "acquired"
  `;
  if (lock?.acquired !== true) {
    return { ...empty, durationMs: Date.now() - startedAt, skipped: "locked" };
  }

  const stats = { ...empty };
  try {
    stats.initialised = await initialiseMissingStates(config);
    const repaired = await repairInconsistentStates(config);
    stats.examined = repaired.examined;
    stats.repairedAlerted = repaired.alerted;
    stats.repairedRearmed = repaired.rearmed;
    stats.enqueued = repaired.enqueued;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${RECONCILE_LOCK_KEY}))`;
  }

  stats.durationMs = Date.now() - startedAt;
  log.info("low-balance reconciliation pass", {
    examined: stats.examined,
    repairedAlerted: stats.repairedAlerted,
    repairedRearmed: stats.repairedRearmed,
    initialised: stats.initialised,
    enqueued: stats.enqueued,
    durationMs: stats.durationMs,
  });
  return stats;
}

/**
 * Creates missing state rows for ACTIVE users, in bounded keyset pages.
 *
 * Rows are seeded to the state the CURRENT balance implies, and a user already
 * below the threshold is seeded ALERTED with NO notification — initialisation
 * must never generate a message (§16).
 */
async function initialiseMissingStates(config: Config): Promise<number> {
  let cursor: string | undefined;
  let created = 0;
  for (let batch = 0; batch < LOW_BALANCE_RECONCILE_MAX_BATCHES; batch += 1) {
    const users = await prisma.user.findMany({
      where: { status: UserStatus.ACTIVE, lowBalanceAlertState: { is: null } },
      select: { id: true, balanceToman: true },
      orderBy: { id: "asc" },
      take: LOW_BALANCE_RECONCILE_BATCH,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (users.length === 0) {
      break;
    }
    cursor = users[users.length - 1].id;
    const now = new Date();
    const result = await prisma.lowBalanceAlertState.createMany({
      data: users.map((u) => {
        const low = u.balanceToman <= config.thresholdToman;
        return {
          userId: u.id,
          state: low ? LowBalanceAlertStateValue.ALERTED : LowBalanceAlertStateValue.ARMED,
          alertCycle: 0,
          lastObservedBalanceToman: u.balanceToman,
          lastThresholdToman: config.thresholdToman,
          lastRearmBoundaryToman: config.rearmBoundaryToman,
          lastConfigVersion: config.configVersion,
          alertedAt: low ? now : null,
        };
      }),
      skipDuplicates: true,
    });
    created += result.count;
    if (users.length < LOW_BALANCE_RECONCILE_BATCH) {
      break;
    }
  }
  return created;
}

/**
 * Repairs state rows whose recorded state disagrees with the live balance.
 *
 * ARMED + balance <= threshold  -> a crossing the observer missed: alert.
 * ALERTED + balance >  boundary -> a recovery the observer missed: re-arm.
 *
 * The alert path reuses the SAME cycle counter and dedupe key as the observer,
 * so it cannot re-notify a cycle that already produced a message.
 */
async function repairInconsistentStates(
  config: Config,
): Promise<{ examined: number; alerted: number; rearmed: number; enqueued: number }> {
  let cursor: string | undefined;
  let examined = 0;
  let alerted = 0;
  let rearmed = 0;
  let enqueued = 0;

  for (let batch = 0; batch < LOW_BALANCE_RECONCILE_MAX_BATCHES; batch += 1) {
    const rows = await prisma.lowBalanceAlertState.findMany({
      select: {
        id: true,
        userId: true,
        state: true,
        alertCycle: true,
        user: {
          select: {
            status: true,
            balanceToman: true,
            lowBalanceNotificationsEnabled: true,
            paymentNotificationsEnabled: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: LOW_BALANCE_RECONCILE_BATCH,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (rows.length === 0) {
      break;
    }
    cursor = rows[rows.length - 1].id;
    examined += rows.length;

    for (const row of rows) {
      const balance = row.user.balanceToman;
      const isLow = balance <= config.thresholdToman;
      const isAbove = balance > config.rearmBoundaryToman;

      if (row.state === LowBalanceAlertStateValue.ALERTED && isAbove) {
        await prisma.lowBalanceAlertState.updateMany({
          where: { id: row.id, state: LowBalanceAlertStateValue.ALERTED },
          data: {
            state: LowBalanceAlertStateValue.ARMED,
            lastObservedBalanceToman: balance,
            rearmedAt: new Date(),
          },
        });
        rearmed += 1;
        continue;
      }

      if (row.state !== LowBalanceAlertStateValue.ARMED || !isLow) {
        continue;
      }
      // A missed crossing. Ineligible users still get their state corrected —
      // the machine must reflect reality — but no notification is produced.
      const eligible =
        row.user.status === UserStatus.ACTIVE &&
        row.user.lowBalanceNotificationsEnabled &&
        row.user.paymentNotificationsEnabled;

      const cycle = row.alertCycle + 1;
      const advanced = await prisma.lowBalanceAlertState.updateMany({
        where: { id: row.id, state: LowBalanceAlertStateValue.ARMED, alertCycle: row.alertCycle },
        data: {
          state: LowBalanceAlertStateValue.ALERTED,
          alertCycle: cycle,
          lastObservedBalanceToman: balance,
          lastThresholdToman: config.thresholdToman,
          lastRearmBoundaryToman: config.rearmBoundaryToman,
          lastConfigVersion: config.configVersion,
          alertedAt: new Date(),
        },
      });
      // A concurrent observer won the race; it owns the cycle and its message.
      if (advanced.count !== 1) {
        continue;
      }
      alerted += 1;
      if (!eligible) {
        continue;
      }
      const created = await prisma.automatedNotification.createMany({
        data: [
          {
            type: AutomatedNotificationType.WALLET_LOW_BALANCE,
            category: AutomatedNotificationCategory.PAYMENT,
            status: AutomatedNotificationStatus.SCHEDULED,
            userId: row.userId,
            dedupeKey: lowBalanceDedupeKey(row.userId, cycle),
            ruleVersion: LOW_BALANCE_RULE_VERSION,
            scheduledFor: new Date(),
            payloadSnapshot: {
              variables: { balance, threshold: config.thresholdToman },
              meta: {
                kind: "low-balance",
                alertCycle: cycle,
                configVersion: config.configVersion,
                thresholdToman: config.thresholdToman,
                rearmBoundaryToman: config.rearmBoundaryToman,
                origin: "reconcile",
              },
            },
          },
        ],
        skipDuplicates: true,
      });
      enqueued += created.count;
    }

    if (rows.length < LOW_BALANCE_RECONCILE_BATCH) {
      break;
    }
  }
  return { examined, alerted, rearmed, enqueued };
}
