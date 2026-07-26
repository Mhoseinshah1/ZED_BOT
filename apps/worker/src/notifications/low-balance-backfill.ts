import {
  applyLowBalanceObservation,
  hasNotificationForCycle,
  LowBalanceBackfillStatus,
  prisma,
  UserStatus,
  type Prisma,
} from "@zedbot/database";
import { randomUUID } from "node:crypto";
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
// The default answer to "the OWNER just enabled this" is SILENCE: existing
// users are seeded without a message, so only future crossings notify. This
// module implements the OTHER choice — the one an OWNER has to ask for
// explicitly, on a confirmation screen — "also notify the users who are ALREADY
// low right now".
//
// POPULATION. The intended set is every ACTIVE, eligible user currently at or
// below the frozen threshold, whatever state the machine happens to be in:
//
//   no state row              -> create the first explicit cycle and notify
//   silent baseline (cycle 0) -> open the first real cycle and notify
//   ARMED while low           -> advance one cycle and notify
//   cycle already notified    -> skip
//   opted out / category off / inactive / recovered -> skip
//
// Skipping the first two is what made an earlier cut of this complete having
// sent almost nothing: right after enabling, essentially the whole low-balance
// population is exactly those two states.
//
// SAFETY. Every message goes through the SAME transition primitive and the SAME
// deterministic dedupe key as the live observer, so a user the observer already
// alerted in this cycle cannot be alerted twice. One run can be PENDING or
// RUNNING at a time (a partial unique index), and a durable worker claim stops
// two replicas advancing the same run.
// =============================================================================

const log = createLogger("worker:low-balance-backfill");

export interface BackfillTickResult {
  status: "idle" | "advanced" | "completed" | "cancelled" | "locked";
  runId?: string;
  processed: number;
  queued: number;
  skipped: number;
}

/** How many batches one scheduler tick advances before yielding. */
const BATCHES_PER_TICK = 10;

/** How long a worker's claim on a run is held. */
const CLAIM_DURATION_MS = 5 * 60_000;

/**
 * Advances the single active backfill run, if there is one.
 *
 * Returns quickly (one indexed lookup) when no run is active, so registering
 * this on a short cadence costs almost nothing on an idle install.
 */
export async function runLowBalanceBackfillTick(): Promise<BackfillTickResult> {
  const now = new Date();
  const candidate = await prisma.lowBalanceBackfillRun.findFirst({
    where: {
      status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (candidate === null) {
    return { status: "idle", processed: 0, queued: 0, skipped: 0 };
  }

  // Durable claim: of N replicas exactly one gets count === 1. An expired claim
  // (crashed worker) is taken over rather than stranding the run forever.
  const ownerToken = randomUUID();
  const claimed = await prisma.lowBalanceBackfillRun.updateMany({
    where: {
      id: candidate.id,
      status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
      OR: [{ ownerToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: LowBalanceBackfillStatus.RUNNING,
      ownerToken,
      leaseExpiresAt: new Date(now.getTime() + CLAIM_DURATION_MS),
      startedAt: now,
    },
  });
  if (claimed.count !== 1) {
    return { status: "locked", runId: candidate.id, processed: 0, queued: 0, skipped: 0 };
  }

  const run = await prisma.lowBalanceBackfillRun.findUnique({ where: { id: candidate.id } });
  if (run === null || run.ownerToken !== ownerToken) {
    return { status: "locked", runId: candidate.id, processed: 0, queued: 0, skipped: 0 };
  }

  const config: FrozenConfig = {
    thresholdToman: run.thresholdToman,
    rearmBoundaryToman: run.rearmBoundaryToman,
    configVersion: run.configVersion,
  };
  let cursor = run.cursorUserId ?? undefined;
  let processed = 0;
  let queued = 0;
  let skipped = 0;

  try {
    for (let batch = 0; batch < BATCHES_PER_TICK; batch += 1) {
      // Cancellation is honoured between batches, and the claim is re-checked:
      // an OWNER who stops the run gets no further messages, and a run taken
      // over by another replica is not advanced twice.
      const live = await prisma.lowBalanceBackfillRun.findUnique({
        where: { id: run.id },
        select: { status: true, ownerToken: true },
      });
      if (live?.status !== LowBalanceBackfillStatus.RUNNING || live.ownerToken !== ownerToken) {
        return { status: "cancelled", runId: run.id, processed, queued, skipped };
      }

      const page = await advanceOneBatch(run.id, ownerToken, cursor, config);
      processed += page.processed;
      queued += page.queued;
      skipped += page.skipped;

      if (page.done) {
        await prisma.lowBalanceBackfillRun.updateMany({
          where: {
            id: run.id,
            status: LowBalanceBackfillStatus.RUNNING,
            ownerToken,
          },
          data: {
            status: LowBalanceBackfillStatus.COMPLETED,
            completedAt: new Date(),
            ownerToken: null,
            leaseExpiresAt: null,
          },
        });
        log.info("low-balance backfill completed", { processed, queued, skipped });
        return { status: "completed", runId: run.id, processed, queued, skipped };
      }
      cursor = page.cursor;

      await prisma.lowBalanceBackfillRun.updateMany({
        where: { id: run.id, ownerToken },
        data: { leaseExpiresAt: new Date(Date.now() + CLAIM_DURATION_MS) },
      });
    }
  } catch (err) {
    // Safe code only — never a balance, a user id or a telegram id.
    log.warn("low-balance backfill batch failed", { error: errorMessage(err) });
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { id: run.id, ownerToken },
      data: { failedCount: { increment: 1 }, safeErrorCode: "batch-failed" },
    });
  } finally {
    // Release the claim so the next tick (or another replica) can continue.
    await prisma.lowBalanceBackfillRun.updateMany({
      where: { id: run.id, ownerToken, status: LowBalanceBackfillStatus.RUNNING },
      data: { ownerToken: null, leaseExpiresAt: null },
    });
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
 * One keyset page of ACTIVE users at or below the frozen threshold.
 *
 * The cursor advances over ALL users in the page — including skipped ones — so
 * a page full of ineligible users still makes progress.
 */
async function advanceOneBatch(
  runId: string,
  ownerToken: string,
  cursor: string | undefined,
  config: FrozenConfig,
): Promise<BatchResult> {
  const users = await prisma.user.findMany({
    where: { status: UserStatus.ACTIVE, balanceToman: { lte: config.thresholdToman } },
    select: { id: true },
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

  for (const { id } of users) {
    const result = await processOneUser(id, config);
    if (result === "queued") {
      queued += 1;
    } else {
      skipped += 1;
    }
  }

  // The cursor and the counters commit with the run row, after the units they
  // describe have already committed.
  await prisma.lowBalanceBackfillRun.updateMany({
    where: { id: runId, ownerToken },
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

/**
 * One user, one transaction: live balance re-read, locked state, transition and
 * outbox row all commit together or not at all.
 *
 * `forceAlert` is what lets this open a cycle from a silent baseline — the one
 * place in the whole feature allowed to notify without a witnessed crossing,
 * because an OWNER explicitly asked for it on a confirmation screen.
 */
async function processOneUser(
  userId: string,
  config: FrozenConfig,
): Promise<"queued" | "skipped"> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          balanceToman: true,
          status: true,
          lowBalanceNotificationsEnabled: true,
          paymentNotificationsEnabled: true,
        },
      });
      if (user === null || user.status !== UserStatus.ACTIVE) {
        return "skipped";
      }
      // Re-checked live: the balance may have recovered since the page was read.
      if (user.balanceToman > config.thresholdToman) {
        return "skipped";
      }
      const eligible =
        user.lowBalanceNotificationsEnabled && user.paymentNotificationsEnabled;
      if (!eligible) {
        return "skipped";
      }

      // A cycle that already produced its message must not produce another. The
      // deterministic key is the authority, so ask it directly.
      const state = await tx.lowBalanceAlertState.findUnique({
        where: { userId },
        select: { alertCycle: true },
      });
      if (
        state !== null &&
        state.alertCycle > 0 &&
        (await hasNotificationForCycle(tx, lowBalanceDedupeKey(userId, state.alertCycle)))
      ) {
        return "skipped";
      }

      const outcome = await applyLowBalanceObservation(tx, {
        userId,
        // No witnessed edge — the OWNER's explicit request is the justification.
        balanceBeforeToman: null,
        balanceAfterToman: user.balanceToman,
        thresholdToman: config.thresholdToman,
        rearmBoundaryToman: config.rearmBoundaryToman,
        configVersion: config.configVersion,
        eligible: true,
        forceAlert: true,
        buildNotification: (cycle) => ({
          dedupeKey: lowBalanceDedupeKey(userId, cycle),
          ruleVersion: LOW_BALANCE_RULE_VERSION,
          payloadSnapshot: buildLowBalanceSnapshot({
            balanceToman: user.balanceToman,
            thresholdToman: config.thresholdToman,
            rearmBoundaryToman: config.rearmBoundaryToman,
            configVersion: config.configVersion,
            alertCycle: cycle,
            origin: "backfill",
          }) as unknown as Prisma.InputJsonValue,
        }),
      });
      return outcome.kind === "alerted" && outcome.notificationId !== null
        ? "queued"
        : "skipped";
    });
  } catch (err) {
    log.warn("low-balance backfill unit failed", { error: errorMessage(err) });
    return "skipped";
  }
}
