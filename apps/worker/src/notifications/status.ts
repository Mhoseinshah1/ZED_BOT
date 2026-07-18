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
}

export function createEngineState(): NotificationEngineState {
  return {
    lastServiceSyncAt: null,
    lastServiceScanAt: null,
    lastCheckoutScanAt: null,
    abandonedCheckoutCandidates: 0,
    paymentRetryCandidates: 0,
  };
}

export async function publishNotificationWorkerStatus(
  redis: RawRedis,
  queues: NotificationQueues,
  state: NotificationEngineState,
  schedulerActive: boolean,
): Promise<void> {
  const [waiting, delayed, deliveryFailed, deadLetter] = await Promise.all([
    queues.deliveryQueue.getWaitingCount(),
    queues.deliveryQueue.getDelayedCount(),
    prisma.automatedNotification.count({ where: { status: AutomatedNotificationStatus.FAILED } }),
    prisma.automatedNotification.count({ where: { status: AutomatedNotificationStatus.DEAD_LETTER } }),
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
): () => void {
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    publishNotificationWorkerStatus(redis, queues, state, isSchedulerActive())
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
