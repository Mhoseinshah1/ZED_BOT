import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  LowBalanceBackfillStatus,
  prisma,
  UserStatus,
} from "@zedbot/database";
import {
  buildLowBalanceSnapshot,
  createLogger,
  errorMessage,
  LOW_BALANCE_BACKFILL_BATCH,
  LOW_BALANCE_RULE_VERSION,
  lowBalanceDedupeKey,
} from "@zedbot/shared";

// =============================================================================
// Low-balance BACKFILL (§12).
//
// The default answer to "the OWNER just enabled this" is SILENCE: the state
// machine seeds every existing user without producing a message, so only future
// crossings notify. This module implements the OTHER choice — the one an OWNER
// has to ask for explicitly, on a confirmation screen — "also notify the users
// who are ALREADY low right now".
//
// It is deliberately the most conservative thing in the feature:
//
//   * At most ONE run can be PENDING or RUNNING, enforced by a partial unique
//     index in the database, not by a check in application code. Pressing the
//     button twice cannot double-notify.
//   * The run works against a FROZEN config snapshot taken when the OWNER
//     confirmed. Changing the threshold mid-run does not silently re-target it.
//   * It advances by KEYSET in small batches with a durable cursor, so it is
//     restart-safe and never loads the user table into memory.
//   * Every message goes through the SAME dedupe key as the live observer, so a
//     user the observer already alerted in this cycle cannot be alerted twice.
//   * Cancellation takes effect between batches AND is re-checked inside the
//     batch transaction, so a cancelled run stops enqueuing immediately.
// =============================================================================

const log = createLogger("worker:low-balance-backfill");

export interface BackfillTickResult {
  status: "idle" | "advanced" | "completed" | "cancelled";
  runId?: string;
  processed: number;
  queued: number;
  skipped: number;
}

/** How many batches one scheduler tick advances before yielding. */
const BATCHES_PER_TICK = 10;

/**
 * Advances the single active backfill run, if there is one.
 *
 * Returns quickly (one indexed lookup) when no run is active, so registering
 * this on a short cadence costs almost nothing on an idle install.
 */
export async function runLowBalanceBackfillTick(): Promise<BackfillTickResult> {
  const run = await prisma.lowBalanceBackfillRun.findFirst({
    where: {
      status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (run === null) {
    return { status: "idle", processed: 0, queued: 0, skipped: 0 };
  }

  if (run.status === LowBalanceBackfillStatus.PENDING) {
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { id: run.id, status: LowBalanceBackfillStatus.PENDING },
      data: { status: LowBalanceBackfillStatus.RUNNING, startedAt: new Date() },
    });
  }

  let cursor = run.cursorUserId ?? undefined;
  let processed = 0;
  let queued = 0;
  let skipped = 0;

  for (let batch = 0; batch < BATCHES_PER_TICK; batch += 1) {
    // Cancellation is honoured between batches: an OWNER who stops the run gets
    // no further messages, and the users already notified keep their alerts.
    const live = await prisma.lowBalanceBackfillRun.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (live?.status !== LowBalanceBackfillStatus.RUNNING) {
      return { status: "cancelled", runId: run.id, processed, queued, skipped };
    }

    let page;
    try {
      page = await advanceOneBatch(run.id, cursor, {
        thresholdToman: run.thresholdToman,
        rearmBoundaryToman: run.rearmBoundaryToman,
        configVersion: run.configVersion,
      });
    } catch (err) {
      // Safe code only — never a balance, a user id or a telegram id.
      log.warn("low-balance backfill batch failed", { error: errorMessage(err) });
      await prisma.lowBalanceBackfillRun.update({
        where: { id: run.id },
        data: { failedCount: { increment: 1 }, safeErrorCode: "batch-failed" },
      });
      return { status: "advanced", runId: run.id, processed, queued, skipped };
    }

    processed += page.processed;
    queued += page.queued;
    skipped += page.skipped;

    if (page.done) {
      await prisma.lowBalanceBackfillRun.updateMany({
        where: { id: run.id, status: LowBalanceBackfillStatus.RUNNING },
        data: { status: LowBalanceBackfillStatus.COMPLETED, completedAt: new Date() },
      });
      log.info("low-balance backfill completed", { processed, queued, skipped });
      return { status: "completed", runId: run.id, processed, queued, skipped };
    }
    cursor = page.cursor;
  }

  return { status: "advanced", runId: run.id, processed, queued, skipped };
}

interface FrozenConfig {
  thresholdToman: number;
  rearmBoundaryToman: number;
  configVersion: number;
}

interface BatchResult {
  processed: number;
  queued: number;
  skipped: number;
  cursor?: string;
  done: boolean;
}

/**
 * One keyset page: find ARMED users at or below the frozen threshold, advance
 * each one's cycle, and enqueue at most one notification per user.
 *
 * The cursor advances over ALL users in the page — including the ones that were
 * skipped — so a page full of ineligible users still makes progress.
 */
async function advanceOneBatch(
  runId: string,
  cursor: string | undefined,
  config: FrozenConfig,
): Promise<BatchResult> {
  const users = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      balanceToman: { lte: config.thresholdToman },
    },
    select: {
      id: true,
      balanceToman: true,
      lowBalanceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
      lowBalanceAlertState: { select: { id: true, state: true, alertCycle: true } },
    },
    orderBy: { id: "asc" },
    take: LOW_BALANCE_BACKFILL_BATCH,
    ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
  });

  if (users.length === 0) {
    return { processed: 0, queued: 0, skipped: 0, done: true };
  }

  const nextCursor = users[users.length - 1].id;
  let queued = 0;
  let skipped = 0;

  for (const user of users) {
    const eligible = user.lowBalanceNotificationsEnabled && user.paymentNotificationsEnabled;
    const state = user.lowBalanceAlertState;
    // No state row yet, or already ALERTED: the observer/initialiser owns this
    // user's cycle. Re-notifying would either invent a cycle the machine does
    // not know about or duplicate one it already opened.
    if (!eligible || state === null || state.state !== LowBalanceAlertStateValue.ARMED) {
      skipped += 1;
      continue;
    }

    const cycle = state.alertCycle + 1;
    const advanced = await prisma.lowBalanceAlertState.updateMany({
      where: {
        id: state.id,
        state: LowBalanceAlertStateValue.ARMED,
        alertCycle: state.alertCycle,
      },
      data: {
        state: LowBalanceAlertStateValue.ALERTED,
        alertCycle: cycle,
        lastObservedBalanceToman: user.balanceToman,
        lastThresholdToman: config.thresholdToman,
        lastRearmBoundaryToman: config.rearmBoundaryToman,
        lastConfigVersion: config.configVersion,
        alertedAt: new Date(),
      },
    });
    // A live wallet mutation won the race and owns this cycle (and its message).
    if (advanced.count !== 1) {
      skipped += 1;
      continue;
    }

    const created = await prisma.automatedNotification.createMany({
      data: [
        {
          type: AutomatedNotificationType.WALLET_LOW_BALANCE,
          category: AutomatedNotificationCategory.PAYMENT,
          status: AutomatedNotificationStatus.SCHEDULED,
          userId: user.id,
          dedupeKey: lowBalanceDedupeKey(user.id, cycle),
          ruleVersion: LOW_BALANCE_RULE_VERSION,
          scheduledFor: new Date(),
          payloadSnapshot: buildLowBalanceSnapshot({
            balanceToman: user.balanceToman,
            thresholdToman: config.thresholdToman,
            rearmBoundaryToman: config.rearmBoundaryToman,
            configVersion: config.configVersion,
            alertCycle: cycle,
            origin: "backfill",
          }),
        },
      ],
      skipDuplicates: true,
    });
    queued += created.count;
  }

  await prisma.lowBalanceBackfillRun.update({
    where: { id: runId },
    data: {
      cursorUserId: nextCursor,
      processedCount: { increment: users.length },
      queuedCount: { increment: queued },
      skippedCount: { increment: skipped },
    },
  });

  return {
    processed: users.length,
    queued,
    skipped,
    cursor: nextCursor,
    done: users.length < LOW_BALANCE_BACKFILL_BATCH,
  };
}
