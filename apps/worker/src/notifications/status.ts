import { AutomatedNotificationStatus, prisma } from "@zedbot/database";
import {
  NOTIFICATION_WORKER_STATUS_KEY,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  createLogger,
  errorMessage,
  type NotificationWorkerStatus,
} from "@zedbot/shared";

import type { RawRedis } from "../redis.js";
import type { NotificationQueues } from "./queues.js";
import { isNotificationAnalyticsEnabled } from "./settings.js";

// =============================================================================
// Notification worker STATUS publisher (feat/notification-retention-engine,
// Phase 1). Publishes the live engine snapshot the bot's admin health page
// reads: scheduler activity, last sync/scan instants and the delivery backlog /
// failure counts. Same TTL discipline as the main heartbeat, so a dead worker's
// snapshot expires and the admin page shows "worker not reporting". Carries only
// counts and timestamps - never a user id, service id or message body.
// =============================================================================

const log = createLogger("worker:notif-status");

/** Mutable timestamps the processors stamp; the status loop reads them. */
export interface NotificationEngineState {
  lastServiceSyncAt: string | null;
  lastServiceScanAt: string | null;
  lastCheckoutScanAt: string | null;
  abandonedCheckoutCandidates: number;
  paymentRetryCandidates: number;
  // Customer win-back (Phase 3).
  lastRetentionScanAt: string | null;
  winbackCandidates: number;
  winbackScheduled: number;
  winbackExcludedUncertainService: number;
  retentionScanFailures: number;
  // Analytics / attribution (Phase 4).
  lastAttributionBatchAt: string | null;
  lastAttributionReversalsAt: string | null;
  attributionReconcileFailures: number;
}

export function createEngineState(): NotificationEngineState {
  return {
    lastServiceSyncAt: null,
    lastServiceScanAt: null,
    lastCheckoutScanAt: null,
    abandonedCheckoutCandidates: 0,
    paymentRetryCandidates: 0,
    lastRetentionScanAt: null,
    winbackCandidates: 0,
    winbackScheduled: 0,
    winbackExcludedUncertainService: 0,
    retentionScanFailures: 0,
    lastAttributionBatchAt: null,
    lastAttributionReversalsAt: null,
    attributionReconcileFailures: 0,
  };
}

export async function publishNotificationWorkerStatus(
  redis: RawRedis,
  queues: NotificationQueues,
  state: NotificationEngineState,
  schedulerActive: boolean,
  extraStatus?: () => Promise<Partial<NotificationWorkerStatus>>,
): Promise<void> {
  const [waiting, delayed, deliveryFailed, deadLetter, analyticsEnabled, attributionsActive, attributionsReversed] =
    await Promise.all([
      queues.deliveryQueue.getWaitingCount(),
      queues.deliveryQueue.getDelayedCount(),
      prisma.automatedNotification.count({ where: { status: AutomatedNotificationStatus.FAILED } }),
      prisma.automatedNotification.count({ where: { status: AutomatedNotificationStatus.DEAD_LETTER } }),
      isNotificationAnalyticsEnabled(),
      prisma.notificationConversionAttribution.count({ where: { status: "ACTIVE" } }),
      prisma.notificationConversionAttribution.count({ where: { status: "REVERSED" } }),
    ]);
  const snapshot: NotificationWorkerStatus = {
    schedulerActive,
    lastServiceSyncAt: state.lastServiceSyncAt,
    lastServiceScanAt: state.lastServiceScanAt,
    deliveryWaiting: waiting + delayed,
    deliveryFailed,
    deadLetter,
    checkedAt: new Date().toISOString(),
    lastCheckoutScanAt: state.lastCheckoutScanAt,
    abandonedCheckoutCandidates: state.abandonedCheckoutCandidates,
    paymentRetryCandidates: state.paymentRetryCandidates,
    lastRetentionScanAt: state.lastRetentionScanAt,
    winbackCandidates: state.winbackCandidates,
    winbackScheduled: state.winbackScheduled,
    winbackExcludedUncertainService: state.winbackExcludedUncertainService,
    retentionScanFailures: state.retentionScanFailures,
    analyticsEnabled,
    lastAttributionBatchAt: state.lastAttributionBatchAt,
    lastAttributionReversalsAt: state.lastAttributionReversalsAt,
    attributionsActive,
    attributionsReversed,
    attributionReconcileFailures: state.attributionReconcileFailures,
    // Wallet auto-renewal fields (Phase 1) are merged from the auto-renewal
    // engine's status provider; a failure there never blocks the snapshot.
    ...(extraStatus === undefined ? {} : await extraStatus().catch(() => ({}))),
  };
  await redis.set(
    NOTIFICATION_WORKER_STATUS_KEY,
    JSON.stringify(snapshot),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS,
  );
}

/**
 * Starts the status-publish loop (immediate tick + heartbeat cadence). Never
 * stacks ticks; publish errors are logged and retried on the next tick (the TTL
 * handles staleness). Returns a stop function.
 */
export function startNotificationStatusLoop(
  redis: RawRedis,
  queues: NotificationQueues,
  state: NotificationEngineState,
  isSchedulerActive: () => boolean,
  extraStatus?: () => Promise<Partial<NotificationWorkerStatus>>,
): () => void {
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    publishNotificationWorkerStatus(redis, queues, state, isSchedulerActive(), extraStatus)
      .catch((err: unknown) => {
        log.warn("notification status publish failed", { error: errorMessage(err) });
      })
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const timer = setInterval(tick, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
