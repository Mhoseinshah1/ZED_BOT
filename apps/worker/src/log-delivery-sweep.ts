import { LogDeliveryStatus, prisma } from "@zedbot/database";
import { createLogger, errorMessage } from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueLogDelivery } from "./queues.js";

// =============================================================================
// Orphaned log-delivery sweep.
//
// A SystemLogDelivery row and its BullMQ job are created by two different
// mechanisms, and only the row is durable. Whenever the row exists but the job
// does not, the alert is silently never delivered:
//
//   * a WRITER WITH NO QUEUE. The Force Join unhealthy-channel policy is now
//     reachable from the API, which runs no BullMQ connection at all. It
//     commits its operational event as an outbox row inside the configuration
//     transaction (see `@zedbot/force-join`'s ops-outbox) precisely so that
//     nothing is lost — but somebody has to pick that row up. This loop is
//     that somebody.
//   * a CRASH BETWEEN COMMIT AND ENQUEUE. `writeSystemLog` commits the row and
//     then enqueues; a process that dies in between, or an `enqueue` that
//     throws on a Redis blip, leaves a PENDING row forever.
//   * a LOST DELAYED JOB. A FAILED row's retry lives only in Redis. If Redis is
//     flushed or replaced, the retry evaporates while the row still says the
//     alert is owed.
//   * an ABANDONED CLAIM. The processor moves a row to SENDING and then calls
//     Telegram. If the worker is killed, or Redis loses the job, in that window
//     the row sits in SENDING forever: the database says the alert is not
//     terminal, and nothing recreates the job. Without this branch an automatic
//     Force Join deactivation alert could stay permanently undelivered despite
//     the outbox having done its part.
//
// The sweep is deliberately dumb: find rows that are still owed, enqueue them,
// let the existing processor do everything else. It never talks to Telegram.
// Two properties keep it safe to run on a fixed cadence next to the normal
// path:
//
//   * the job id is derived from the delivery id (`logdel-<id>`), so enqueuing
//     one that is already queued or delayed is a no-op — no duplicate sends;
//   * the processor re-reads the row and returns early on any terminal status,
//     and claims work with a CAS, so even a genuinely duplicated job cannot
//     send twice.
//
// WHAT THIS ACTUALLY GUARANTEES. Stated honestly, because the difference
// matters when an operator is reasoning about a duplicate alert:
//
//   * ONE durable record per committed retirement — the outbox writes it on the
//     configuration transaction, so it cannot be lost or doubled;
//   * DETERMINISTIC, IDEMPOTENT job creation — the same delivery id always
//     produces the same job id, so re-enqueuing is a no-op while that job
//     exists;
//   * terminal deliveries (SENT / DEAD_LETTER / SKIPPED) are never intentionally
//     retried;
//   * Telegram delivery is AT-LEAST-ONCE. A single delivery per alert is NOT
//     promised and cannot be: there is an unavoidable ambiguous window where
//     the process dies after Telegram accepted the message but before the
//     `SENT` status commits. The row is still SENDING, so this sweep will —
//     correctly — hand it back to the processor, which sends it again. A
//     duplicate operational alert is the right trade against a silently lost
//     one, and no amount of bookkeeping on this side of the network can close
//     that window.
//
// ANTI-RECURSION: like the delivery processor, nothing here ever writes a
// SystemLog row. A failing sweep reports to stdout only.
// =============================================================================

const logger = createLogger("worker:log-delivery-sweep");

export const LOG_DELIVERY_SWEEP_INTERVAL_MS = 60_000;
/** Bounded per pass so a large backlog drains steadily instead of in one burst. */
export const LOG_DELIVERY_SWEEP_BATCH = 200;
/**
 * A PENDING row younger than this is left alone: the writer that just created
 * it is almost certainly enqueuing it right now, and racing that costs a
 * pointless Redis round-trip on every normal ops log.
 */
export const LOG_DELIVERY_SWEEP_MIN_AGE_MS = 30_000;

/**
 * How long a row may sit in SENDING before it is treated as abandoned.
 *
 * SENDING is a CLAIM, not a state a healthy delivery lingers in. The processor
 * sets it, does one Redis aggregation check, makes one Telegram call and writes
 * a terminal status. That Telegram call is hard-bounded by an AbortController
 * at `TELEGRAM_API_TIMEOUT_MS`, whose own ceiling is 60 s — so a live claim
 * cannot outlive roughly a minute even in the worst configured case.
 *
 * Ten minutes is therefore an order of magnitude past any legitimate claim,
 * which is the point: the cost of being wrong in one direction is a DUPLICATE
 * operational alert, and in the other a PERMANENTLY LOST one. Being generous
 * here makes the first essentially impossible while still bounding the second
 * to one sweep interval past the threshold.
 *
 * Measured against `updatedAt`, never `createdAt`: the row's age says nothing
 * about when it was claimed, and a long-queued alert claimed one second ago is
 * exactly the row that must NOT be disturbed.
 */
export const LOG_DELIVERY_SENDING_STALE_MS = 10 * 60_000;

/**
 * One bounded pass. Returns how many deliveries were enqueued — the tests use
 * that; nothing in production depends on the number.
 */
export async function sweepOrphanedLogDeliveries(logQueue: Queue): Promise<number> {
  const now = Date.now();
  const rows = await prisma.systemLogDelivery.findMany({
    where: {
      OR: [
        // Committed but (as far as we can tell) never enqueued.
        {
          status: LogDeliveryStatus.PENDING,
          createdAt: { lt: new Date(now - LOG_DELIVERY_SWEEP_MIN_AGE_MS) },
        },
        // A retry that is due. If its delayed job still exists the jobId
        // dedupe makes this a no-op; if Redis lost it, this is the only way
        // back.
        {
          status: LogDeliveryStatus.FAILED,
          nextAttemptAt: { lte: new Date(now) },
        },
        // An ABANDONED CLAIM: moved to SENDING and then left there, which only
        // happens if the worker died or Redis lost the job mid-send. Keyed on
        // `updatedAt` — the claim time — so a delivery being processed right
        // now is never disturbed no matter how old the row itself is.
        {
          status: LogDeliveryStatus.SENDING,
          updatedAt: { lt: new Date(now - LOG_DELIVERY_SENDING_STALE_MS) },
        },
      ],
    },
    // Oldest first: an alert that has been owed longest is delivered first.
    orderBy: { createdAt: "asc" },
    take: LOG_DELIVERY_SWEEP_BATCH,
    select: { id: true },
  });

  let enqueued = 0;
  for (const row of rows) {
    try {
      await enqueueLogDelivery(logQueue, row.id);
      enqueued += 1;
    } catch (err) {
      // Redis is unavailable; the row stays owed and the next pass retries it.
      logger.warn("orphaned log delivery enqueue failed", {
        deliveryId: row.id,
        error: errorMessage(err),
      });
    }
  }
  if (enqueued > 0) {
    logger.info("re-enqueued orphaned log deliveries", { count: enqueued });
  }
  return enqueued;
}

/** Immediate pass + fixed cadence; returns a stop function. */
export function startLogDeliverySweep(logQueue: Queue): () => void {
  const pass = (): void => {
    void sweepOrphanedLogDeliveries(logQueue).catch((err: unknown) => {
      logger.warn("log delivery sweep failed", { error: errorMessage(err) });
    });
  };
  pass();
  const timer = setInterval(pass, LOG_DELIVERY_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
