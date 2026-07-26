import {
  applyLowBalanceObservation,
  LowBalanceAlertStateValue,
  prisma,
  UserStatus,
  type Prisma,
} from "@zedbot/database";
import {
  buildLowBalanceSnapshot,
  createLogger,
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  errorMessage,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_RECONCILE_BATCH,
  LOW_BALANCE_RECONCILE_MAX_BATCHES,
  LOW_BALANCE_RULE_VERSION,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
} from "@zedbot/shared";

import { acquireLease, releaseLease, renewLease, saveProgress } from "./low-balance-lease.js";

// =============================================================================
// Low-balance RECONCILIATION (§6).
//
// A REPAIR mechanism, not the primary trigger. The event-driven observer in the
// wallet transaction is authoritative; this sweep exists for the gaps it cannot
// cover: rows written before the feature shipped, a legacy code path that
// bypasses the observer, and the failure modes where the observer's own write
// was lost.
//
// SCALE. It never scans `User` for repairs. Two phases, paged differently on
// purpose:
//
//   INITIALISE — users with no state row. The predicate SHRINKS as it works, so
//   it needs no cursor; each batch simply takes the next page of whatever is
//   still missing. That also makes it self-healing: a unit that fails is picked
//   up again next batch instead of being stranded behind a cursor.
//
//   REPAIR — every state row. This set does NOT shrink, so it pages by keyset
//   and persists the cursor after every committed batch. Without that, a large
//   installation rescans the first page forever and its later rows are never
//   repaired. Draining both phases wraps the cursor back to the start.
//
// COORDINATION. A durable lease, not a pooled session advisory lock — see
// low-balance-lease.ts for why the latter is unsafe through a connection pool.
//
// ATOMICITY. Each user is one transaction: locked state, transition, outbox row
// and cursor commit together. A committed alert cycle therefore ALWAYS has its
// deterministic notification. Splitting them would let a crash leave a user
// ALERTED with nothing queued — and every later pass would skip them as
// "already alerted", so they would never be warned again.
//
// SAFETY. It shares ONE transition primitive with the observer and the
// backfill, through the same dedupe key, so it cannot produce a second message
// for a cycle that already has one. A user it initialises for the first time
// who is ALREADY low is recorded ALERTED WITHOUT a message.
// =============================================================================

const log = createLogger("worker:low-balance-reconcile");

export interface ReconcileStats {
  examined: number;
  repairedAlerted: number;
  repairedRearmed: number;
  initialised: number;
  enqueued: number;
  durationMs: number;
  /** True when both phases reached the end and the cursors wrapped. */
  completed: boolean;
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
 * Multi-replica safe: a second replica finds the lease held and returns
 * immediately. Restart-safe: the repair cursor is durable and initialisation is
 * inherently resumable, so an interrupted pass continues rather than restarting.
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
    completed: false,
  };

  const { enabled, config } = await loadConfig();
  if (!enabled) {
    return { ...empty, durationMs: Date.now() - startedAt, skipped: "disabled" };
  }

  const lease = await acquireLease(new Date());
  if (lease === null) {
    return { ...empty, durationMs: Date.now() - startedAt, skipped: "locked" };
  }

  const stats = { ...empty };
  let completed = false;
  try {
    const init = await initialiseMissingStates(config, lease.ownerToken);
    stats.initialised = init.initialised;
    stats.enqueued += init.enqueued;

    const repaired = await repairInconsistentStates(config, lease.ownerToken, lease.repairCursorId);
    stats.examined = repaired.examined;
    stats.repairedAlerted = repaired.alerted;
    stats.repairedRearmed = repaired.rearmed;
    stats.enqueued += repaired.enqueued;

    // Only a pass that drained BOTH phases wraps the cursors.
    completed = init.done && repaired.done;
  } catch (err) {
    // Safe code only: never a balance, user id or telegram id.
    log.warn("low-balance reconciliation pass failed", { error: errorMessage(err) });
  } finally {
    await releaseLease(lease.ownerToken, new Date(), completed);
  }

  stats.completed = completed;
  stats.durationMs = Date.now() - startedAt;
  log.info("low-balance reconciliation pass", {
    examined: stats.examined,
    repairedAlerted: stats.repairedAlerted,
    repairedRearmed: stats.repairedRearmed,
    initialised: stats.initialised,
    enqueued: stats.enqueued,
    completed: stats.completed,
    durationMs: stats.durationMs,
  });
  return stats;
}

interface EligibleUser {
  id: string;
  balanceToman: number;
  status: UserStatus;
  lowBalanceNotificationsEnabled: boolean;
  paymentNotificationsEnabled: boolean;
}

function isEligible(user: EligibleUser): boolean {
  return (
    user.status === UserStatus.ACTIVE &&
    user.lowBalanceNotificationsEnabled &&
    user.paymentNotificationsEnabled
  );
}

function draftFor(userId: string, balance: number, config: Config, origin: "reconcile") {
  return (cycle: number) => ({
    dedupeKey: lowBalanceDedupeKey(userId, cycle),
    ruleVersion: LOW_BALANCE_RULE_VERSION,
    payloadSnapshot: buildLowBalanceSnapshot({
      balanceToman: balance,
      thresholdToman: config.thresholdToman,
      rearmBoundaryToman: config.rearmBoundaryToman,
      configVersion: config.configVersion,
      alertCycle: cycle,
      origin,
    }) as unknown as Prisma.InputJsonValue,
  });
}

/**
 * Creates missing state rows for ACTIVE users, in bounded pages.
 *
 * A user is seeded to the state their CURRENT balance implies, and one already
 * below the threshold is seeded ALERTED with NO notification — there was no
 * witnessed crossing, so claiming one would be a lie (§16). This is exactly the
 * silent baseline, cycle 0.
 */
async function initialiseMissingStates(
  config: Config,
  ownerToken: string,
): Promise<{ initialised: number; enqueued: number; done: boolean }> {
  let initialised = 0;
  let enqueued = 0;
  let done = false;

  for (let batch = 0; batch < LOW_BALANCE_RECONCILE_MAX_BATCHES; batch += 1) {
    // NO keyset cursor here, deliberately. This predicate SHRINKS as the phase
    // works: a user that gets a state row drops out of it. Paging a shrinking
    // set by cursor silently strands any row whose unit failed, because the
    // cursor has already moved past it and nothing revisits it — one user in
    // several hundred, invisible in production and forever un-warned.
    //
    // Querying from the start each time is both simpler and self-healing: the
    // successes leave the set, and a failed row is picked up by the next batch.
    // Progress is therefore inherent, which is why this phase needs no durable
    // cursor while the repair phase (whose set does not shrink) does.
    const users = await prisma.user.findMany({
      where: { status: UserStatus.ACTIVE, lowBalanceAlertState: { is: null } },
      select: {
        id: true,
        balanceToman: true,
        status: true,
        lowBalanceNotificationsEnabled: true,
        paymentNotificationsEnabled: true,
      },
      orderBy: { id: "asc" },
      take: LOW_BALANCE_RECONCILE_BATCH,
    });
    if (users.length === 0) {
      done = true;
      break;
    }

    let progressed = 0;
    for (const user of users) {
      const outcome = await processOne(user, config, null, false);
      if (outcome === null) {
        continue;
      }
      progressed += 1;
      initialised += 1;
      if (outcome.kind === "alerted" && outcome.notificationId !== null) {
        enqueued += 1;
      }
    }
    // Every unit in the batch failed: retrying the identical page would spin.
    if (progressed === 0) {
      break;
    }

    if (!(await renewLease(ownerToken, new Date()))) {
      break; // lease lost: stop touching shared state.
    }
    if (users.length < LOW_BALANCE_RECONCILE_BATCH) {
      done = true;
      break;
    }
  }
  return { initialised, enqueued, done };
}

/**
 * Repairs state rows whose recorded state disagrees with the live balance.
 *
 * ARMED + balance <= threshold  -> a crossing the observer missed: alert.
 * ALERTED + balance >  boundary -> a recovery the observer missed: re-arm.
 *
 * Each row is one transaction, so the state change and its notification are
 * never split.
 */
async function repairInconsistentStates(
  config: Config,
  ownerToken: string,
  startCursor: string | null,
): Promise<{ examined: number; alerted: number; rearmed: number; enqueued: number; done: boolean }> {
  let cursor = startCursor ?? undefined;
  let examined = 0;
  let alerted = 0;
  let rearmed = 0;
  let enqueued = 0;
  let done = false;

  for (let batch = 0; batch < LOW_BALANCE_RECONCILE_MAX_BATCHES; batch += 1) {
    const rows = await prisma.lowBalanceAlertState.findMany({
      select: {
        id: true,
        userId: true,
        state: true,
        user: {
          select: {
            id: true,
            balanceToman: true,
            status: true,
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
      done = true;
      break;
    }
    examined += rows.length;

    for (const row of rows) {
      const balance = row.user.balanceToman;
      const isLow = balance <= config.thresholdToman;
      const isAbove = balance > config.rearmBoundaryToman;
      // Nothing to repair: skip the transaction entirely.
      if (
        (row.state === LowBalanceAlertStateValue.ALERTED && !isAbove) ||
        (row.state === LowBalanceAlertStateValue.ARMED && !isLow)
      ) {
        continue;
      }
      const outcome = await processOne(row.user, config, null, false);
      if (outcome === null) {
        continue;
      }
      if (outcome.kind === "rearmed") {
        rearmed += 1;
      } else if (outcome.kind === "alerted") {
        alerted += 1;
        if (outcome.notificationId !== null) {
          enqueued += 1;
        }
      }
    }

    cursor = rows[rows.length - 1].id;
    if (!(await saveProgress(ownerToken, { repairCursorId: cursor }))) {
      break;
    }
    if (!(await renewLease(ownerToken, new Date()))) {
      break;
    }
    if (rows.length < LOW_BALANCE_RECONCILE_BATCH) {
      done = true;
      break;
    }
  }
  return { examined, alerted, rearmed, enqueued, done };
}

/**
 * One user, one transaction.
 *
 * The balance is RE-READ inside the transaction rather than trusted from the
 * page: a wallet mutation may have moved it since. Returns null when the unit
 * failed, which rolls the whole unit back — state, outbox and all.
 */
async function processOne(
  user: EligibleUser,
  config: Config,
  balanceBeforeToman: number | null,
  forceAlert: boolean,
): Promise<Awaited<ReturnType<typeof applyLowBalanceObservation>> | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const live = await tx.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          balanceToman: true,
          status: true,
          lowBalanceNotificationsEnabled: true,
          paymentNotificationsEnabled: true,
        },
      });
      if (live === null || live.status !== UserStatus.ACTIVE) {
        return null;
      }
      return applyLowBalanceObservation(tx, {
        userId: live.id,
        balanceBeforeToman,
        balanceAfterToman: live.balanceToman,
        thresholdToman: config.thresholdToman,
        rearmBoundaryToman: config.rearmBoundaryToman,
        configVersion: config.configVersion,
        eligible: isEligible(live),
        forceAlert,
        buildNotification: draftFor(live.id, live.balanceToman, config, "reconcile"),
      });
    });
  } catch (err) {
    log.warn("low-balance reconciliation unit failed", { error: errorMessage(err) });
    return null;
  }
}
