import {
  NOTIFICATION_JOB_NAMES,
  NOTIFICATION_SCHEDULER_IDS,
  createLogger,
  errorMessage,
} from "@zedbot/shared";
import { getScheduleMinutes, isNotificationSystemEnabled } from "./settings.js";
import type { NotificationQueues } from "./queues.js";

// =============================================================================
// Notification SCHEDULER reconciler (feat/notification-retention-engine, Phase
// 1). Mirrors the backup scheduler: reconciles the recurring job schedulers
// against the operator Settings on a fixed cadence, so enabling/disabling the
// engine or changing a cadence applies WITHOUT a worker restart. When the
// master switch is off every scheduler is removed - a dormant install runs no
// recurring notification work at all.
// =============================================================================

const log = createLogger("worker:notif-scheduler");

/** How often the scheduler set is re-derived from Settings. */
export const NOTIF_RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * Makes the four recurring schedulers match Settings: upsert (idempotent,
 * replaces a stale cadence under the same id) when the engine is enabled,
 * remove them all when it is disabled.
 */
export async function reconcileNotificationSchedulers(queues: NotificationQueues): Promise<boolean> {
  const enabled = await isNotificationSystemEnabled();
  if (!enabled) {
    await removeAllSchedulers(queues);
    return false;
  }
  const minutes = await getScheduleMinutes();
  await Promise.all([
    queues.serviceSyncQueue.upsertJobScheduler(
      NOTIFICATION_SCHEDULER_IDS.serviceSync,
      { every: minutes.serviceSync * 60_000 },
      { name: NOTIFICATION_JOB_NAMES.SYNC_PANEL_SERVICES, data: {} },
    ),
    queues.scanQueue.upsertJobScheduler(
      NOTIFICATION_SCHEDULER_IDS.serviceScan,
      { every: minutes.serviceScan * 60_000 },
      { name: NOTIFICATION_JOB_NAMES.SCAN_SERVICE_NOTIFICATIONS, data: {} },
    ),
    queues.maintenanceQueue.upsertJobScheduler(
      NOTIFICATION_SCHEDULER_IDS.reconcile,
      { every: minutes.reconcile * 60_000 },
      { name: NOTIFICATION_JOB_NAMES.RECONCILE_FAILED_NOTIFICATIONS, data: {} },
    ),
    queues.maintenanceQueue.upsertJobScheduler(
      NOTIFICATION_SCHEDULER_IDS.cleanup,
      { every: minutes.cleanup * 60_000 },
      { name: NOTIFICATION_JOB_NAMES.CLEANUP_NOTIFICATION_HISTORY, data: {} },
    ),
  ]);
  return true;
}

async function removeAllSchedulers(queues: NotificationQueues): Promise<void> {
  await Promise.allSettled([
    queues.serviceSyncQueue.removeJobScheduler(NOTIFICATION_SCHEDULER_IDS.serviceSync),
    queues.scanQueue.removeJobScheduler(NOTIFICATION_SCHEDULER_IDS.serviceScan),
    queues.maintenanceQueue.removeJobScheduler(NOTIFICATION_SCHEDULER_IDS.reconcile),
    queues.maintenanceQueue.removeJobScheduler(NOTIFICATION_SCHEDULER_IDS.cleanup),
  ]);
}

/**
 * Immediate reconcile + fixed cadence. Returns a getter for the last known
 * "scheduler active" state (for the status snapshot) and a stop function.
 */
export function startNotificationScheduler(queues: NotificationQueues): {
  isActive: () => boolean;
  stop: () => void;
} {
  let active = false;
  const run = (): void => {
    reconcileNotificationSchedulers(queues)
      .then((enabled) => {
        active = enabled;
      })
      .catch((err: unknown) => {
        log.warn("notification schedule reconcile failed", { error: errorMessage(err) });
      });
  };
  run();
  const timer = setInterval(run, NOTIF_RECONCILE_INTERVAL_MS);
  timer.unref();
  return { isActive: () => active, stop: () => clearInterval(timer) };
}
