import {
  createLogger,
  errorMessage,
  getRedisOptions,
  type RedisConnectionOptions,
} from "@zedbot/shared";
import { Queue, Worker, type Job } from "bullmq";

const logger = createLogger("worker");

export const DEFAULT_QUEUE_NAME = "default";
export const PLACEHOLDER_JOB_NAME = "placeholder";

const redisOptions = getRedisOptions();
if (redisOptions === null) {
  logger.error(
    "Redis is not configured (set REDIS_URL or REDIS_HOST/REDIS_PORT/REDIS_PASSWORD in .env).",
  );
  // Slow down the restart loop while the operator fixes the configuration.
  setTimeout(() => process.exit(1), 60_000);
} else {
  void run(redisOptions);
}

async function run(options: RedisConnectionOptions): Promise<void> {
  // BullMQ requires maxRetriesPerRequest=null so blocking commands survive
  // reconnects.
  const connection = { ...options, maxRetriesPerRequest: null };

  const queue = new Queue(DEFAULT_QUEUE_NAME, { connection });
  queue.on("error", (err) => {
    logger.warn("queue redis error", { error: errorMessage(err) });
  });

  const worker = new Worker(
    DEFAULT_QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case PLACEHOLDER_JOB_NAME:
          logger.info("processed placeholder job", { jobId: job.id });
          return { ok: true };
        default:
          logger.warn("received unknown job type, ignoring", { jobName: job.name, jobId: job.id });
          return { ok: false, reason: "unknown_job" };
      }
    },
    { connection },
  );

  worker.on("ready", () => {
    logger.info(`ZED_BOT worker service started (queue: ${DEFAULT_QUEUE_NAME})`);
  });
  worker.on("failed", (job, err) => {
    logger.error("job failed", { jobId: job?.id, jobName: job?.name, error: errorMessage(err) });
  });
  worker.on("error", (err) => {
    logger.warn("worker redis error", { error: errorMessage(err) });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    try {
      await worker.close();
      await queue.close();
    } catch (err) {
      logger.warn("error during shutdown", { error: errorMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
