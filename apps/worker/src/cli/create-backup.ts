import { connectDatabase, disconnectDatabase, BackupOperationStatus, BackupTrigger, prisma } from "@zedbot/database";
import { BACKUP_QUEUE_NAME, getRedisOptions } from "@zedbot/shared";
import { Queue } from "bullmq";

import { backupFailureCode, executeBackup, markOperationFailed } from "../backup/create.js";
import { setLogDeliveryEnqueuer } from "../ops-log.js";
import { createLogDeliveryQueue, enqueueLogDelivery } from "../queues.js";
import {
  acquireBackupLock,
  rawRedisClient,
  releaseBackupLock,
  type BackupLock,
  type RawRedis,
} from "../redis.js";

// =============================================================================
// CLI: create + verify one database backup inline (no queue consumer needed)
// for deploy scripts and CI. Usage:
//
//   node dist/cli/create-backup.js [--trigger MANUAL|PRE_UPDATE]
//
// Redis is OPTIONAL here (documented behavior): when reachable within a
// short window we take the global backup lock (and refuse to run alongside
// a queue-driven backup); when Redis is down/absent the CLI proceeds
// WITHOUT the lock - a pre-update backup must still be possible while the
// stack is half-down. Ops logs are then persisted to Postgres only (their
// Telegram deliveries stay PENDING for the worker to pick up later).
//
// Prints JSON {ok, filename, verified} and exits 0 on verified success.
// =============================================================================

function parseTrigger(argv: string[]): BackupTrigger {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = arg === "--trigger" ? argv[i + 1] : arg.startsWith("--trigger=") ? arg.slice("--trigger=".length) : null;
    if (value !== null) {
      if (value === BackupTrigger.PRE_UPDATE) {
        return BackupTrigger.PRE_UPDATE;
      }
      if (value === BackupTrigger.MANUAL) {
        return BackupTrigger.MANUAL;
      }
      process.stderr.write(`unknown --trigger value: ${value} (use MANUAL or PRE_UPDATE)\n`);
      process.exit(1);
    }
  }
  return BackupTrigger.MANUAL;
}

/** Redis client with a hard connect deadline; null when unreachable. */
async function connectRedisBestEffort(): Promise<{ queue: Queue; redis: RawRedis } | null> {
  const options = getRedisOptions();
  if (options === null) {
    return null;
  }
  const queue = new Queue(BACKUP_QUEUE_NAME, {
    connection: {
      ...options,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      // Give up instead of retrying forever - the CLI must never hang.
      retryStrategy: () => null,
    },
  });
  queue.on("error", () => undefined); // Swallow connect noise; we race below.
  try {
    const redis = await Promise.race<RawRedis | null>([
      rawRedisClient(queue),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000).unref()),
    ]);
    if (redis === null) {
      void queue.close().catch(() => undefined);
      return null;
    }
    return { queue, redis };
  } catch {
    void queue.close().catch(() => undefined);
    return null;
  }
}

async function main(): Promise<void> {
  const trigger = parseTrigger(process.argv.slice(2));
  await connectDatabase();

  const redisContext = await connectRedisBestEffort();
  let logQueue: Queue | null = null;
  let lock: BackupLock | null = null;
  let exitCode = 1;
  try {
    let lockBlocked = false;
    if (redisContext !== null) {
      lock = await acquireBackupLock(redisContext.redis);
      if (lock === null) {
        // A queue-driven (or other CLI) backup is in flight - refuse to race it.
        lockBlocked = true;
        process.stdout.write(
          `${JSON.stringify({ ok: false, filename: null, verified: false, error: "backup-already-running" })}\n`,
        );
      } else {
        const options = getRedisOptions();
        if (options !== null) {
          logQueue = createLogDeliveryQueue({ ...options, maxRetriesPerRequest: null });
          logQueue.on("error", () => undefined);
          const boundLogQueue = logQueue;
          setLogDeliveryEnqueuer((deliveryId) => enqueueLogDelivery(boundLogQueue, deliveryId));
        }
      }
    }

    if (!lockBlocked) {
      const operation = await prisma.backupOperation.create({
        data: { trigger, status: BackupOperationStatus.QUEUED },
      });

      try {
        const result = await executeBackup(operation.id);
        exitCode = result.ok ? 0 : 1;
        process.stdout.write(
          `${JSON.stringify({ ok: result.ok, filename: result.filename, verified: result.verified })}\n`,
        );
      } catch (err) {
        const code = backupFailureCode(err);
        await markOperationFailed(operation.id, code);
        process.stdout.write(
          `${JSON.stringify({ ok: false, filename: null, verified: false, error: code })}\n`,
        );
      }
    }
  } finally {
    if (redisContext !== null && lock !== null) {
      await releaseBackupLock(redisContext.redis, lock);
    }
    if (logQueue !== null) {
      await logQueue.close().catch(() => undefined);
    }
    if (redisContext !== null) {
      await redisContext.queue.close().catch(() => undefined);
    }
    await disconnectDatabase().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(`create-backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
