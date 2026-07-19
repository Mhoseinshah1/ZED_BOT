import { prisma } from "@zedbot/database";
import {
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  STARS_SUBSCRIPTION_EXECUTE_QUEUE_NAME,
  STARS_SUBSCRIPTION_JOB_NAMES,
  STARS_SUBSCRIPTION_QUEUE_NAME,
  STARS_SUBSCRIPTION_RECONCILE_LOCK_KEY,
  STARS_SUBSCRIPTION_SCHEDULER_IDS,
  createLogger,
  errorMessage,
  type StarsSubscriptionStatusFields,
} from "@zedbot/shared";
import { Queue, Worker, type Job } from "bullmq";

import type { WorkerRedisConnection } from "../queues.js";
import { acquireLock, releaseLock, type RawRedis } from "../redis.js";
import { runStarsTransactionRecovery } from "./recovery.js";
import {
  runStarsChargeCleanup,
  runStarsFulfillmentReconcile,
  runStarsPastDueDetection,
  runStarsRefundRetry,
} from "./reconcile.js";
import { getStarsSubscriptionConfig, isStarsSubscriptionsEnabled } from "./settings.js";

// =============================================================================
// Telegram Stars subscription WORKER engine (Phase 2.1). Owns the recurring
// transaction-recovery / expiration(PAST_DUE) / refund-retry / cleanup jobs on the
// `stars-subscription` queue plus the settings-driven scheduler. Money-touching
// work (recovered-charge settlement, refund execution, stuck-charge reconcile) is
// PRODUCED onto the bot-consumed `stars-subscription-execute` queue, which the bot
// process settles with the existing services. Dormant until the operator enables
// the master switch — the scheduler removes every recurring job while it is off.
// =============================================================================

const logger = createLogger("worker:stars-engine");

const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Best-effort single-flight for the cursor-sensitive transaction scan. */
const RECON_LOCK_TTL_MS = 4 * 60_000;

export interface StarsSubscriptionEngine {
  stop: () => Promise<void>;
  getStatusFields: () => Promise<StarsSubscriptionStatusFields>;
}

interface EngineState {
  lastReconcileAt: string | null;
}

export function startStarsSubscriptionEngine(
  connection: WorkerRedisConnection,
  redis: RawRedis,
): StarsSubscriptionEngine {
  const state: EngineState = { lastReconcileAt: null };

  const controlQueue = new Queue(STARS_SUBSCRIPTION_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 24 * 3600 } },
  });
  const executeQueue = new Queue(STARS_SUBSCRIPTION_EXECUTE_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  });
  const deliveryQueue = new Queue(NOTIFICATION_DELIVERY_QUEUE_NAME, { connection });

  for (const [name, q] of [
    ["stars-control", controlQueue],
    ["stars-execute", executeQueue],
    ["stars-delivery", deliveryQueue],
  ] as const) {
    q.on("error", (err) => logger.warn(`${name} redis error`, { error: errorMessage(err) }));
  }

  const worker = new Worker(
    STARS_SUBSCRIPTION_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      // Every job re-checks the master switch: a disabled system performs no new
      // recovery, PAST_DUE transition, refund attempt or cleanup.
      if (!(await isStarsSubscriptionsEnabled())) {
        return { skipped: "system-disabled" };
      }
      const config = await getStarsSubscriptionConfig();

      if (job.name === STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS) {
        const lock = await acquireLock(redis, STARS_SUBSCRIPTION_RECONCILE_LOCK_KEY, RECON_LOCK_TTL_MS);
        if (lock === null) {
          return { skipped: "scan-locked" };
        }
        try {
          const result = await runStarsTransactionRecovery({ executeQueue }, config);
          state.lastReconcileAt = new Date().toISOString();
          return result as unknown as Record<string, unknown>;
        } finally {
          await releaseLock(redis, lock);
        }
      }
      if (job.name === STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_EXPIRATIONS) {
        const pastDue = await runStarsPastDueDetection(config, deliveryQueue);
        const recon = await runStarsFulfillmentReconcile(executeQueue);
        state.lastReconcileAt = new Date().toISOString();
        return { ...pastDue, ...recon };
      }
      if (job.name === STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_REFUNDS) {
        const result = await runStarsRefundRetry(executeQueue, config, deliveryQueue);
        state.lastReconcileAt = new Date().toISOString();
        return result as unknown as Record<string, unknown>;
      }
      if (job.name === STARS_SUBSCRIPTION_JOB_NAMES.CLEANUP_STARS_SUBSCRIPTION_CHARGES) {
        return (await runStarsChargeCleanup(config)) as unknown as Record<string, unknown>;
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    logger.error("stars-control job failed", { jobName: job?.name, error: errorMessage(err) });
  });
  worker.on("error", (err) => logger.warn("stars-control worker redis error", { error: errorMessage(err) }));

  // --- settings-driven scheduler ------------------------------------------
  const reconcile = async (): Promise<void> => {
    try {
      if (!(await isStarsSubscriptionsEnabled())) {
        await Promise.allSettled([
          controlQueue.removeJobScheduler(STARS_SUBSCRIPTION_SCHEDULER_IDS.transactions),
          controlQueue.removeJobScheduler(STARS_SUBSCRIPTION_SCHEDULER_IDS.expirations),
          controlQueue.removeJobScheduler(STARS_SUBSCRIPTION_SCHEDULER_IDS.refunds),
          controlQueue.removeJobScheduler(STARS_SUBSCRIPTION_SCHEDULER_IDS.cleanup),
        ]);
        return;
      }
      const config = await getStarsSubscriptionConfig();
      const every = config.reconcileMinutes * 60_000;
      await Promise.all([
        controlQueue.upsertJobScheduler(
          STARS_SUBSCRIPTION_SCHEDULER_IDS.transactions,
          { every },
          { name: STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          STARS_SUBSCRIPTION_SCHEDULER_IDS.expirations,
          { every },
          { name: STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_EXPIRATIONS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          STARS_SUBSCRIPTION_SCHEDULER_IDS.refunds,
          { every },
          { name: STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_REFUNDS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          STARS_SUBSCRIPTION_SCHEDULER_IDS.cleanup,
          { every: 24 * 60 * 60_000 },
          { name: STARS_SUBSCRIPTION_JOB_NAMES.CLEANUP_STARS_SUBSCRIPTION_CHARGES, data: {} },
        ),
      ]);
    } catch (err) {
      logger.warn("stars subscription schedule reconcile failed", { error: errorMessage(err) });
    }
  };
  void reconcile();
  const timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  timer.unref();

  logger.info(
    `stars subscription engine started (queues: ${STARS_SUBSCRIPTION_QUEUE_NAME}, ${STARS_SUBSCRIPTION_EXECUTE_QUEUE_NAME})`,
  );

  const getStatusFields = async (): Promise<StarsSubscriptionStatusFields> => {
    const [
      enabled,
      active,
      completed,
      refunded,
      pastDue,
      requiresAction,
      refundPending,
      reconRequired,
      failed,
      cursor,
      config,
    ] = await Promise.all([
      isStarsSubscriptionsEnabled(),
      prisma.telegramStarsServiceSubscription.count({ where: { status: "ACTIVE" } }),
      prisma.telegramStarsSubscriptionCharge.count({ where: { status: "COMPLETED" } }),
      prisma.telegramStarsSubscriptionCharge.count({ where: { status: "REFUNDED" } }),
      prisma.telegramStarsServiceSubscription.count({ where: { status: "PAST_DUE" } }),
      prisma.telegramStarsServiceSubscription.count({ where: { status: "REQUIRES_ACTION" } }),
      prisma.telegramStarsSubscriptionCharge.count({ where: { status: "REFUND_PENDING" } }),
      prisma.telegramStarsSubscriptionCharge.count({ where: { status: "RECONCILIATION_REQUIRED" } }),
      prisma.telegramStarsSubscriptionCharge.count({ where: { status: "FAILED" } }),
      prisma.telegramStarsReconciliationCursor.findUnique({ where: { singletonKey: "default" } }),
      getStarsSubscriptionConfig(),
    ]);
    const staleCutoffMs = config.cursorStaleMinutes * 60_000;
    const cursorStale =
      cursor !== null &&
      (cursor.lastSuccessfulRunAt === null ||
        Date.now() - cursor.lastSuccessfulRunAt.getTime() > staleCutoffMs);
    return {
      starsSubscriptionsEnabled: enabled,
      lastStarsSubscriptionReconcileAt: state.lastReconcileAt,
      starsSubscriptionsActive: active,
      starsSubscriptionChargesProcessed: completed,
      starsSubscriptionChargesRefunded: refunded,
      starsSubscriptionPastDue: pastDue,
      starsSubscriptionRequiresAction: requiresAction,
      starsSubscriptionFailures: failed,
      lastStarsTransactionOffset: cursor?.nextOffset ?? 0,
      starsSubscriptionRefundPending: refundPending,
      starsSubscriptionReconciliationRequired: reconRequired,
      starsSubscriptionCursorStale: cursorStale,
    };
  };

  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await Promise.allSettled([worker.close()]);
    await Promise.allSettled([controlQueue.close(), executeQueue.close(), deliveryQueue.close()]);
  };

  return { stop, getStatusFields };
}
