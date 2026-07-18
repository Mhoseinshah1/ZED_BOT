import {
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  NOTIFICATION_JOB_NAMES,
  NOTIFICATION_MAINTENANCE_QUEUE_NAME,
  NOTIFICATION_SCAN_QUEUE_NAME,
  SERVICE_STATE_SYNC_QUEUE_NAME,
  notificationDeliveryJobId,
  panelSyncJobId,
} from "@zedbot/shared";
import { Queue, type DefaultJobOptions } from "bullmq";

import type { WorkerRedisConnection } from "../queues.js";

// =============================================================================
// Notification-engine queues (feat/notification-retention-engine, Phase 1).
// Four cooperating queues, all worker-owned:
//   service-state-sync  - refresh Service usage/status from panels (per panel)
//   notification-scan   - evaluate rules -> create SCHEDULED notifications
//   notification-delivery - render + send one notification (Telegram-rate-limited)
//   notification-maintenance - cleanup history + reconcile stuck/failed rows
//
// Job ids are DERIVED from the entity id (panel / notification), so a retried
// or duplicated enqueue collapses onto the same job - the DB row + its dedupe
// key are the durable idempotency anchors, never the queue.
// =============================================================================

export interface PanelSyncJobData {
  panelId: string;
}

export interface NotificationDeliveryJobData {
  notificationId: string;
}

/** Panel sync: 2 attempts (a panel blip should not spam) - the next scheduled
 * scan re-enqueues anyway. */
export const SERVICE_STATE_SYNC_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 2,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 24 * 3600 },
};

/** Scans: single attempt - a missed scan is picked up on the next cadence. */
export const NOTIFICATION_SCAN_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 24 * 3600 },
};

/** Deliveries: 5 attempts, exponential from 30s (mirrors log delivery). The
 * AutomatedNotification row is the source of truth; BullMQ only paces retries. */
export const NOTIFICATION_DELIVERY_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 200 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/** Maintenance: single attempt, re-runs on its own cadence. */
export const NOTIFICATION_MAINTENANCE_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { age: 3600, count: 50 },
  removeOnFail: { age: 24 * 3600 },
};

export interface NotificationQueues {
  serviceSyncQueue: Queue;
  scanQueue: Queue;
  deliveryQueue: Queue;
  maintenanceQueue: Queue;
}

export function createNotificationQueues(connection: WorkerRedisConnection): NotificationQueues {
  return {
    serviceSyncQueue: new Queue(SERVICE_STATE_SYNC_QUEUE_NAME, {
      connection,
      defaultJobOptions: SERVICE_STATE_SYNC_JOB_OPTIONS,
    }),
    scanQueue: new Queue(NOTIFICATION_SCAN_QUEUE_NAME, {
      connection,
      defaultJobOptions: NOTIFICATION_SCAN_JOB_OPTIONS,
    }),
    deliveryQueue: new Queue(NOTIFICATION_DELIVERY_QUEUE_NAME, {
      connection,
      defaultJobOptions: NOTIFICATION_DELIVERY_JOB_OPTIONS,
    }),
    maintenanceQueue: new Queue(NOTIFICATION_MAINTENANCE_QUEUE_NAME, {
      connection,
      defaultJobOptions: NOTIFICATION_MAINTENANCE_JOB_OPTIONS,
    }),
  };
}

/** Enqueue one panel sync (jobId = per-panel, so at most one in flight). */
export async function enqueuePanelSync(serviceSyncQueue: Queue, panelId: string): Promise<void> {
  const data: PanelSyncJobData = { panelId };
  await serviceSyncQueue.add(NOTIFICATION_JOB_NAMES.SYNC_PANEL_SERVICES, data, {
    jobId: panelSyncJobId(panelId),
  });
}

/** Enqueue one notification delivery (jobId = per-notification, idempotent). */
export async function enqueueNotificationDelivery(
  deliveryQueue: Queue,
  notificationId: string,
  delayMs?: number,
): Promise<void> {
  const data: NotificationDeliveryJobData = { notificationId };
  await deliveryQueue.add(NOTIFICATION_JOB_NAMES.DELIVER_AUTOMATED_NOTIFICATION, data, {
    jobId: notificationDeliveryJobId(notificationId),
    delay: delayMs !== undefined && delayMs > 0 ? delayMs : undefined,
  });
}
