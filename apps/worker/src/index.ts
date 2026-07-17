import { connectDatabase, disconnectDatabase } from "@zedbot/database";
import {
  BACKUP_QUEUE_NAME,
  LOG_DELIVERY_QUEUE_NAME,
  createLogger,
  errorMessage,
  getRedisOptions,
  type RedisConnectionOptions,
} from "@zedbot/shared";
import { Worker } from "bullmq";

import { gitSha } from "./config.js";
import { startHeartbeat } from "./heartbeat.js";
import { createLogDeliveryProcessor } from "./log-delivery.js";
import { setLogDeliveryEnqueuer } from "./ops-log.js";
import {
  createBackupQueue,
  createLogDeliveryQueue,
  enqueueLogDelivery,
  type WorkerRedisConnection,
} from "./queues.js";
import { rawRedisClient } from "./redis.js";
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
  backupQueue.on("error", (err) => {
    logger.warn("backup queue redis error", { error: errorMessage(err) });
  });
  logQueue.on("error", (err) => {
    logger.warn("log queue redis error", { error: errorMessage(err) });
  });

  // Ops logs written anywhere in this process enqueue their Telegram delivery
  // through the log queue.
  setLogDeliveryEnqueuer((deliveryId) => enqueueLogDelivery(logQueue, deliveryId));

  // Heartbeat + capabilities reuse the queue's existing Redis connection
  // (the worker holds no direct ioredis dependency - see redis.ts).
  const redis = await rawRedisClient(backupQueue);
  const stopHeartbeat = startHeartbeat(redis);
  const stopReconciler = startScheduleReconciler(backupQueue);

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

  for (const [name, worker] of [
    ["backup", backupWorker],
    ["log-delivery", logWorker],
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
    `ZED_BOT worker service started (queues: ${BACKUP_QUEUE_NAME}, ${LOG_DELIVERY_QUEUE_NAME})`,
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
    try {
      await Promise.allSettled([backupWorker.close(), logWorker.close()]);
      await Promise.allSettled([backupQueue.close(), logQueue.close()]);
      await disconnectDatabase();
    } catch (err) {
      logger.warn("error during shutdown", { error: errorMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
