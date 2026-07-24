import { connectDatabase, disconnectDatabase } from "@zedbot/database";
import {
  BACKUP_QUEUE_NAME,
  LOG_DELIVERY_QUEUE_NAME,
  LOG_GROUP_SETUP_QUEUE_NAME,
  createLogger,
  errorMessage,
  getRedisOptions,
  type RedisConnectionOptions,
} from "@zedbot/shared";
import { Worker } from "bullmq";

import { gitSha } from "./config.js";
import { startHeartbeat } from "./heartbeat.js";
import { createLogDeliveryProcessor } from "./log-delivery.js";
import { createLogGroupSetupProcessor } from "./log-group-setup.js";
import { startNotificationEngine } from "./notifications/engine.js";
import { startAutoRenewalEngine } from "./auto-renewal/engine.js";
import { startReferralEngine } from "./referral/engine.js";
import { startStarsSubscriptionEngine } from "./stars-subscription/engine.js";
import { setLogDeliveryEnqueuer } from "./ops-log.js";
import {
  createBackupQueue,
  createLogDeliveryQueue,
  createLogGroupSetupQueue,
  enqueueLogDelivery,
  type WorkerRedisConnection,
} from "./queues.js";
import { rawRedisClient } from "./redis.js";
import { startReservationCleanupLoop } from "./reservations/cleanup.js";
import { startScheduleReconciler } from "./scheduler.js";
import { createBackupProcessor } from "./workers.js";

// =============================================================================
// ZED_BOT worker bootstrap: Prisma + two BullMQ consumers (database backups,
// Telegram log delivery), the Redis heartbeat/capabilities loop and the
// scheduled-backup reconciler. Shutdown closes workers -> queues -> Prisma
// so in-flight jobs finish and connections drain cleanly.
// =============================================================================

const logger = createLogger("worker");

const redisOptions = getRedisOptions();
if (redisOptions === null) {
  logger.error(
    "Redis is not configured (set REDIS_URL or REDIS_HOST/REDIS_PORT/REDIS_PASSWORD in .env).",
  );
  // Slow down the restart loop while the operator fixes the configuration.
  setTimeout(() => process.exit(1), 60_000);
} else {
  run(redisOptions).catch((err: unknown) => {
    logger.error("worker bootstrap failed", { error: errorMessage(err) });
    setTimeout(() => process.exit(1), 10_000);
  });
}

async function run(options: RedisConnectionOptions): Promise<void> {
  // BullMQ requires maxRetriesPerRequest=null so blocking commands survive
  // reconnects.
  const connection: WorkerRedisConnection = { ...options, maxRetriesPerRequest: null };

  await connectDatabase();
  logger.info("database connected");

  const backupQueue = createBackupQueue(connection);
  const logQueue = createLogDeliveryQueue(connection);
  const logGroupSetupQueue = createLogGroupSetupQueue(connection);
  backupQueue.on("error", (err) => {
    logger.warn("backup queue redis error", { error: errorMessage(err) });
  });
  logQueue.on("error", (err) => {
    logger.warn("log queue redis error", { error: errorMessage(err) });
  });
  logGroupSetupQueue.on("error", (err) => {
    logger.warn("log group setup queue redis error", { error: errorMessage(err) });
  });

  // Ops logs written anywhere in this process enqueue their Telegram delivery
  // through the log queue.
  setLogDeliveryEnqueuer((deliveryId) => enqueueLogDelivery(logQueue, deliveryId));

  // Heartbeat + capabilities reuse the queue's existing Redis connection
  // (the worker holds no direct ioredis dependency - see redis.ts).
  const redis = await rawRedisClient(backupQueue);
  const stopHeartbeat = startHeartbeat(redis);
  const stopReconciler = startScheduleReconciler(backupQueue);
  // Service-checkout username reservation cleanup (feat/service-checkout-username-note):
  // an unconditional bounded sweep that reclaims abandoned username holds. Runs on
  // its own fixed cadence, independent of any feature master switch.
  const stopReservationCleanup = startReservationCleanupLoop();

  // Wallet auto-renewal engine (own scan/reconcile/cleanup queue + scheduler).
  // Dormant until the operator enables the master switch. Started BEFORE the
  // notification engine so its status fields feed the shared worker snapshot.
  const autoRenewalEngine = startAutoRenewalEngine(connection, redis);

  // Telegram Stars subscription recovery engine (own reconcile/expiration/refund/
  // cleanup queue + scheduler; produces bot-consumed settle/refund/reconcile jobs).
  // Dormant until the operator enables the master switch. Started before the
  // notification engine so its status fields feed the shared worker snapshot.
  const starsSubscriptionEngine = startStarsSubscriptionEngine(connection, redis);

  // Referral commission reconciliation engine (own credit/reversal/recovery/cleanup
  // control queue + scheduler; produces bot-consumed execute jobs). The durable
  // authority that makes a commission impossible to permanently lose and a refund
  // impossible to permanently leave un-reversed. Credit/reversal scans self-gate on
  // the master switch; recovery/cleanup run regardless so an owed debt stays
  // collectable after payouts are paused.
  const referralEngine = startReferralEngine(connection, redis);

  // Automated-notification / retention engine (own queues + workers +
  // settings-driven scheduler). Dormant until the operator enables the master
  // switch - the scheduler removes every recurring job while it is off. The
  // wallet-auto-renewal + Stars-subscription status fields are merged into the one
  // published worker snapshot.
  const notificationEngine = startNotificationEngine(connection, redis, async () => ({
    ...(await autoRenewalEngine.getStatusFields()),
    ...(await starsSubscriptionEngine.getStatusFields()),
  }));

  const backupWorker = new Worker(
    BACKUP_QUEUE_NAME,
    createBackupProcessor({ redis, backupQueue }),
    { connection, concurrency: 1 },
  );
  const logWorker = new Worker(
    LOG_DELIVERY_QUEUE_NAME,
    createLogDeliveryProcessor({ redis, logQueue }),
    // Telegram-safe: at most 15 sends per minute, one at a time.
    { connection, concurrency: 1, limiter: { max: 15, duration: 60_000 } },
  );
  const logGroupSetupWorker = new Worker(
    LOG_GROUP_SETUP_QUEUE_NAME,
    createLogGroupSetupProcessor({ redis, setupQueue: logGroupSetupQueue }),
    // A limiter is required for Worker.RateLimitError()/queue.rateLimit() to
    // pause the queue when Telegram returns 429 during topic provisioning; the
    // generous ceiling never throttles a normal single-setup run.
    { connection, concurrency: 1, limiter: { max: 60, duration: 60_000 } },
  );

  for (const [name, worker] of [
    ["backup", backupWorker],
    ["log-delivery", logWorker],
    ["log-group-setup", logGroupSetupWorker],
  ] as const) {
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

  // Every service must log its running SHA at startup (deploy diagnostics).
  logger.info(
    `ZED_BOT worker service started (queues: ${BACKUP_QUEUE_NAME}, ${LOG_DELIVERY_QUEUE_NAME}, ${LOG_GROUP_SETUP_QUEUE_NAME})`,
    { gitSha: gitSha() ?? "unknown" },
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    stopHeartbeat();
    stopReconciler();
    stopReservationCleanup();
    try {
      await notificationEngine.stop();
      await starsSubscriptionEngine.stop();
      await autoRenewalEngine.stop();
      await referralEngine.stop();
      await Promise.allSettled([
        backupWorker.close(),
        logWorker.close(),
        logGroupSetupWorker.close(),
      ]);
      await Promise.allSettled([backupQueue.close(), logQueue.close(), logGroupSetupQueue.close()]);
      await disconnectDatabase();
    } catch (err) {
      logger.warn("error during shutdown", { error: errorMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
