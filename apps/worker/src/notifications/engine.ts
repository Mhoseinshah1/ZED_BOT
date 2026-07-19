import {
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  NOTIFICATION_JOB_NAMES,
  NOTIFICATION_MAINTENANCE_QUEUE_NAME,
  NOTIFICATION_SCAN_QUEUE_NAME,
  SERVICE_STATE_SYNC_QUEUE_NAME,
  createLogger,
  errorMessage,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";

import type { WorkerRedisConnection } from "../queues.js";
import type { RawRedis } from "../redis.js";
import { runCheckoutNotificationScan } from "./checkout-scan.js";
import { runWinbackScan } from "./winback-scan.js";
import {
  runAttributionBatch,
  runAttributionCleanup,
  runAttributionReversals,
  reconcileOrderAttribution,
} from "./attribution.js";
import { createNotificationDeliveryProcessor } from "./delivery.js";
import { runNotificationCleanup, runNotificationReconcile } from "./maintenance.js";
import {
  createNotificationQueues,
  type AttributionReconcileJobData,
  type NotificationQueues,
  type PanelSyncJobData,
} from "./queues.js";
import { runServiceNotificationScan } from "./scan.js";
import { startNotificationScheduler } from "./scheduler.js";
import { runServiceStateSync, syncPanelServices } from "./service-sync.js";
import { createEngineState, startNotificationStatusLoop } from "./status.js";

// =============================================================================
// Notification-engine bootstrap (feat/notification-retention-engine, Phase 1).
// Wires the four queues + their concurrency-1 workers, the settings-driven
// scheduler reconciler and the status-publish loop into ONE unit the worker
// process starts and stops. Nothing here decides WHETHER to notify - that is
// the master switch (read live by the scheduler + every processor); this module
// only owns the plumbing so index.ts stays small.
// =============================================================================

const logger = createLogger("worker:notif-engine");

export interface NotificationEngine {
  queues: NotificationQueues;
  stop: () => Promise<void>;
}

export function startNotificationEngine(
  connection: WorkerRedisConnection,
  redis: RawRedis,
  extraStatus?: () => Promise<Partial<import("@zedbot/shared").NotificationWorkerStatus>>,
): NotificationEngine {
  const queues = createNotificationQueues(connection);
  const state = createEngineState();

  for (const [name, queue] of Object.entries(queues)) {
    queue.on("error", (err: Error) => {
      logger.warn(`${name} redis error`, { error: errorMessage(err) });
    });
  }

  // --- service-state sync worker -------------------------------------------
  const syncWorker = new Worker(
    SERVICE_STATE_SYNC_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name !== NOTIFICATION_JOB_NAMES.SYNC_PANEL_SERVICES) {
        throw new Error(`unknown job: ${job.name}`);
      }
      const { panelId } = (job.data ?? {}) as PanelSyncJobData;
      const result =
        panelId !== undefined && panelId !== ""
          ? await syncPanelServices({ redis }, panelId)
          : await runServiceStateSync({ redis });
      state.lastServiceSyncAt = new Date().toISOString();
      return result as unknown as Record<string, unknown>;
    },
    { connection, concurrency: 1 },
  );

  // --- scan worker (service + checkout/payment scans) -----------------------
  const scanWorker = new Worker(
    NOTIFICATION_SCAN_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name === NOTIFICATION_JOB_NAMES.SCAN_SERVICE_NOTIFICATIONS) {
        const result = await runServiceNotificationScan(queues.deliveryQueue);
        state.lastServiceScanAt = new Date().toISOString();
        return result as unknown as Record<string, unknown>;
      }
      if (job.name === NOTIFICATION_JOB_NAMES.SCAN_CHECKOUT_NOTIFICATIONS) {
        const result = await runCheckoutNotificationScan(queues.deliveryQueue);
        state.lastCheckoutScanAt = new Date().toISOString();
        state.abandonedCheckoutCandidates = result.abandonedScanned;
        state.paymentRetryCandidates = result.paymentScanned;
        return result as unknown as Record<string, unknown>;
      }
      if (job.name === NOTIFICATION_JOB_NAMES.SCAN_RETENTION_NOTIFICATIONS) {
        try {
          const result = await runWinbackScan(queues.deliveryQueue, queues.serviceSyncQueue);
          state.lastRetentionScanAt = new Date().toISOString();
          state.winbackCandidates = result.scanned;
          state.winbackScheduled = result.created;
          state.winbackExcludedUncertainService = result.excludedUncertainService;
          return result as unknown as Record<string, unknown>;
        } catch (err) {
          state.retentionScanFailures = (state.retentionScanFailures ?? 0) + 1;
          throw err;
        }
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 1 },
  );

  // --- delivery worker (Telegram-rate-limited, one at a time) ---------------
  const deliveryWorker = new Worker(
    NOTIFICATION_DELIVERY_QUEUE_NAME,
    createNotificationDeliveryProcessor({
      deliveryQueue: queues.deliveryQueue,
      serviceSyncQueue: queues.serviceSyncQueue,
    }),
    { connection, concurrency: 1, limiter: { max: 15, duration: 60_000 } },
  );

  // --- maintenance worker ---------------------------------------------------
  const maintenanceWorker = new Worker(
    NOTIFICATION_MAINTENANCE_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name === NOTIFICATION_JOB_NAMES.CLEANUP_NOTIFICATION_HISTORY) {
        return (await runNotificationCleanup()) as unknown as Record<string, unknown>;
      }
      if (job.name === NOTIFICATION_JOB_NAMES.RECONCILE_FAILED_NOTIFICATIONS) {
        return (await runNotificationReconcile(queues.deliveryQueue)) as unknown as Record<string, unknown>;
      }
      // Analytics phase (Phase 4). Attribution jobs share the maintenance queue.
      if (job.name === NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION) {
        const { orderId } = (job.data ?? {}) as AttributionReconcileJobData;
        if (orderId === undefined || orderId === "") {
          return { skipped: "no-order-id" };
        }
        return (await reconcileOrderAttribution(orderId)) as unknown as Record<string, unknown>;
      }
      if (job.name === NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH) {
        try {
          const result = await runAttributionBatch();
          state.lastAttributionBatchAt = new Date().toISOString();
          return result as unknown as Record<string, unknown>;
        } catch (err) {
          state.attributionReconcileFailures = (state.attributionReconcileFailures ?? 0) + 1;
          throw err;
        }
      }
      if (job.name === NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS) {
        const result = await runAttributionReversals();
        state.lastAttributionReversalsAt = new Date().toISOString();
        return result as unknown as Record<string, unknown>;
      }
      if (job.name === NOTIFICATION_JOB_NAMES.CLEANUP_NOTIFICATION_ATTRIBUTION) {
        return (await runAttributionCleanup()) as unknown as Record<string, unknown>;
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 1 },
  );

  const workers = [
    ["notif-sync", syncWorker],
    ["notif-scan", scanWorker],
    ["notif-delivery", deliveryWorker],
    ["notif-maintenance", maintenanceWorker],
  ] as const;
  for (const [name, worker] of workers) {
    worker.on("ready", () => {
      logger.info(`${name} worker ready`);
    });
    worker.on("failed", (job, err) => {
      logger.error(`${name} job failed`, {
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        error: errorMessage(err),
      });
    });
    worker.on("error", (err) => {
      logger.warn(`${name} worker redis error`, { error: errorMessage(err) });
    });
  }

  const scheduler = startNotificationScheduler(queues);
  const stopStatusLoop = startNotificationStatusLoop(redis, queues, state, scheduler.isActive, extraStatus);

  logger.info(
    `notification engine started (queues: ${SERVICE_STATE_SYNC_QUEUE_NAME}, ${NOTIFICATION_SCAN_QUEUE_NAME}, ${NOTIFICATION_DELIVERY_QUEUE_NAME}, ${NOTIFICATION_MAINTENANCE_QUEUE_NAME})`,
  );

  const stop = async (): Promise<void> => {
    scheduler.stop();
    stopStatusLoop();
    await Promise.allSettled([
      syncWorker.close(),
      scanWorker.close(),
      deliveryWorker.close(),
      maintenanceWorker.close(),
    ]);
    await Promise.allSettled([
      queues.serviceSyncQueue.close(),
      queues.scanQueue.close(),
      queues.deliveryQueue.close(),
      queues.maintenanceQueue.close(),
    ]);
  };

  return { queues, stop };
}
