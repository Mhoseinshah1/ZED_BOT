import { AutomatedNotificationStatus, prisma } from "@zedbot/database";
import { createLogger, errorMessage, notificationDeliveryJobId } from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery, type NotificationQueues } from "./queues.js";
import { getRetentionDays } from "./settings.js";

// =============================================================================
// Notification MAINTENANCE (feat/notification-retention-engine, Phase 1). Two
// idempotent housekeeping jobs, both safe to run on any cadence:
//   cleanup   - prune history past the configured retention windows (interactions
//               cascade). Never touches in-flight rows.
//   reconcile - the durability safety net: re-arm SCHEDULED rows that are due
//               (quiet-hours / daily-cap deferrals, or scan enqueues lost to a
//               Redis flush) and rescue SENDING rows orphaned by a crash. The
//               delivery CAS still guarantees at-most-once send.
// =============================================================================

const log = createLogger("worker:notif-maintenance");

/** A SENDING row whose claim is older than this is treated as crash-orphaned. */
const SENDING_ORPHAN_MS = 10 * 60_000;

/** Reconcile enqueues at most this many due rows per run (bounded work). */
const RECONCILE_BATCH = 500;

export interface CleanupResult {
  history: number;
  failed: number;
  deadLetter: number;
}

/**
 * Deletes terminal rows past their retention window. History (SENT / CANCELLED /
 * SUPPRESSED / EXPIRED) uses the history window; FAILED and DEAD_LETTER keep
 * their own (longer) windows so an operator can still inspect them.
 */
export async function runNotificationCleanup(now: Date = new Date()): Promise<CleanupResult> {
  const retention = await getRetentionDays();
  const historyCutoff = new Date(now.getTime() - retention.history * 24 * 3600_000);
  const failedCutoff = new Date(now.getTime() - retention.failed * 24 * 3600_000);
  const deadLetterCutoff = new Date(now.getTime() - retention.deadLetter * 24 * 3600_000);

  const [history, failed, deadLetter] = await Promise.all([
    prisma.automatedNotification.deleteMany({
      where: {
        status: {
          in: [
            AutomatedNotificationStatus.SENT,
            AutomatedNotificationStatus.CANCELLED,
            AutomatedNotificationStatus.SUPPRESSED,
            AutomatedNotificationStatus.EXPIRED,
          ],
        },
        updatedAt: { lt: historyCutoff },
      },
    }),
    prisma.automatedNotification.deleteMany({
      where: { status: AutomatedNotificationStatus.FAILED, updatedAt: { lt: failedCutoff } },
    }),
    prisma.automatedNotification.deleteMany({
      where: { status: AutomatedNotificationStatus.DEAD_LETTER, updatedAt: { lt: deadLetterCutoff } },
    }),
  ]);

  log.info("notification cleanup complete", {
    history: history.count,
    failed: failed.count,
    deadLetter: deadLetter.count,
  });
  return { history: history.count, failed: failed.count, deadLetter: deadLetter.count };
}

export interface ReconcileResult {
  requeued: number;
  orphansRecovered: number;
}

/**
 * Re-arms due work. First flips crash-orphaned SENDING rows (claimed too long
 * ago) back to SCHEDULED, then re-enqueues every SCHEDULED row whose
 * scheduledFor has passed - removing any stale completed delivery job first so
 * the deterministic jobId can be re-added.
 */
export async function runNotificationReconcile(
  deliveryQueue: Queue,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const orphanCutoff = new Date(now.getTime() - SENDING_ORPHAN_MS);
  const orphans = await prisma.automatedNotification.updateMany({
    where: {
      status: AutomatedNotificationStatus.SENDING,
      claimedAt: { lt: orphanCutoff },
    },
    data: { status: AutomatedNotificationStatus.SCHEDULED, safeErrorCode: "sending-orphan-recovered" },
  });

  const due = await prisma.automatedNotification.findMany({
    where: {
      status: AutomatedNotificationStatus.SCHEDULED,
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: RECONCILE_BATCH,
    select: { id: true },
  });

  let requeued = 0;
  for (const { id } of due) {
    try {
      // Drop any completed job still parked under the deterministic id, then
      // re-add. remove() is a no-op when the job is gone.
      await deliveryQueue.remove(notificationDeliveryJobId(id)).catch(() => undefined);
      await enqueueNotificationDelivery(deliveryQueue, id);
      requeued += 1;
    } catch (err) {
      log.warn("reconcile re-enqueue failed", { notif: id.slice(0, 8), error: errorMessage(err) });
    }
  }

  if (orphans.count > 0 || requeued > 0) {
    log.info("notification reconcile complete", { requeued, orphansRecovered: orphans.count });
  }
  return { requeued, orphansRecovered: orphans.count };
}

/** Runs both maintenance passes (used by the maintenance job processor). */
export async function runNotificationMaintenance(
  queues: Pick<NotificationQueues, "deliveryQueue">,
  now: Date = new Date(),
): Promise<{ cleanup: CleanupResult; reconcile: ReconcileResult }> {
  const cleanup = await runNotificationCleanup(now);
  const reconcile = await runNotificationReconcile(queues.deliveryQueue, now);
  return { cleanup, reconcile };
}
