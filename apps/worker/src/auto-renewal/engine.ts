import { prisma } from "@zedbot/database";
import {
  AUTO_RENEWAL_EXECUTE_QUEUE_NAME,
  AUTO_RENEWAL_JOB_NAMES,
  AUTO_RENEWAL_QUEUE_NAME,
  AUTO_RENEWAL_SCAN_LOCK_KEY,
  AUTO_RENEWAL_SCHEDULER_IDS,
  SERVICE_STATE_SYNC_QUEUE_NAME,
  createLogger,
  errorMessage,
  type WalletAutoRenewalStatusFields,
} from "@zedbot/shared";
import { Queue, Worker, type Job } from "bullmq";

import type { WorkerRedisConnection } from "../queues.js";
import type { RawRedis } from "../redis.js";
import {
  createAutoRenewalScanState,
  runAutoRenewalCleanup,
  runAutoRenewalReconcile,
  runAutoRenewalScan,
  type AutoRenewalScanState,
} from "./scan.js";
import { getWalletAutoRenewalConfig, isWalletAutoRenewalEnabled } from "./settings.js";

// =============================================================================
// Wallet auto-renewal WORKER engine. Owns the recurring scan / reconcile /
// cleanup on the `service-auto-renewal` queue plus the settings-driven scheduler.
// It PRODUCES EXECUTE jobs onto `service-auto-renewal-execute`, which the BOT
// process consumes (the wallet charge + in-place renewal reuse the bot's existing
// settlement + renewal executor). Dormant until the operator enables the master
// switch — the scheduler removes every recurring job while it is off.
// =============================================================================

const logger = createLogger("worker:war-engine");

const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Only one scan runs at a time across scheduler copies (short TTL, best-effort). */
const SCAN_LOCK_TTL_MS = 4 * 60_000;

export interface AutoRenewalEngine {
  stop: () => Promise<void>;
  getStatusFields: () => Promise<WalletAutoRenewalStatusFields>;
}

export function startAutoRenewalEngine(
  connection: WorkerRedisConnection,
  redis: RawRedis,
): AutoRenewalEngine {
  const state: AutoRenewalScanState = createAutoRenewalScanState();

  const controlQueue = new Queue(AUTO_RENEWAL_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 24 * 3600 } },
  });
  const executeQueue = new Queue(AUTO_RENEWAL_EXECUTE_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  });
  const serviceSyncQueue = new Queue(SERVICE_STATE_SYNC_QUEUE_NAME, { connection });

  for (const [name, q] of [["war-control", controlQueue], ["war-execute", executeQueue]] as const) {
    q.on("error", (err) => logger.warn(`${name} redis error`, { error: errorMessage(err) }));
  }

  const worker = new Worker(
    AUTO_RENEWAL_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      if (job.name === AUTO_RENEWAL_JOB_NAMES.SCAN_WALLET_AUTO_RENEWALS) {
        // Best-effort single-flight: skip if another scan holds the lock.
        const token = `${Date.now()}`;
        const acquired = await redis.set(AUTO_RENEWAL_SCAN_LOCK_KEY, token, "PX", SCAN_LOCK_TTL_MS, "NX");
        if (acquired !== "OK") {
          return { skipped: "scan-locked" };
        }
        try {
          return (await runAutoRenewalScan(serviceSyncQueue, executeQueue, state)) as unknown as Record<string, unknown>;
        } finally {
          // Release only our own token (never delete a newer scan's lock).
          await redis
            .eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, AUTO_RENEWAL_SCAN_LOCK_KEY, token)
            .catch(() => undefined);
        }
      }
      if (job.name === AUTO_RENEWAL_JOB_NAMES.RECONCILE_WALLET_AUTO_RENEWALS) {
        return (await runAutoRenewalReconcile(executeQueue)) as unknown as Record<string, unknown>;
      }
      if (job.name === AUTO_RENEWAL_JOB_NAMES.CLEANUP_WALLET_AUTO_RENEWAL_ATTEMPTS) {
        return (await runAutoRenewalCleanup()) as unknown as Record<string, unknown>;
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    logger.error("war-control job failed", { jobName: job?.name, error: errorMessage(err) });
  });
  worker.on("error", (err) => logger.warn("war-control worker redis error", { error: errorMessage(err) }));

  // --- settings-driven scheduler ------------------------------------------
  const reconcile = async (): Promise<void> => {
    try {
      if (!(await isWalletAutoRenewalEnabled())) {
        await Promise.allSettled([
          controlQueue.removeJobScheduler(AUTO_RENEWAL_SCHEDULER_IDS.scan),
          controlQueue.removeJobScheduler(AUTO_RENEWAL_SCHEDULER_IDS.reconcile),
          controlQueue.removeJobScheduler(AUTO_RENEWAL_SCHEDULER_IDS.cleanup),
        ]);
        return;
      }
      const config = await getWalletAutoRenewalConfig();
      await Promise.all([
        controlQueue.upsertJobScheduler(
          AUTO_RENEWAL_SCHEDULER_IDS.scan,
          { every: config.scanMinutes * 60_000 },
          { name: AUTO_RENEWAL_JOB_NAMES.SCAN_WALLET_AUTO_RENEWALS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          AUTO_RENEWAL_SCHEDULER_IDS.reconcile,
          { every: RECONCILE_INTERVAL_MS },
          { name: AUTO_RENEWAL_JOB_NAMES.RECONCILE_WALLET_AUTO_RENEWALS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          AUTO_RENEWAL_SCHEDULER_IDS.cleanup,
          { every: 24 * 60 * 60_000 },
          { name: AUTO_RENEWAL_JOB_NAMES.CLEANUP_WALLET_AUTO_RENEWAL_ATTEMPTS, data: {} },
        ),
      ]);
    } catch (err) {
      logger.warn("auto-renewal schedule reconcile failed", { error: errorMessage(err) });
    }
  };
  void reconcile();
  const timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  timer.unref();

  logger.info(`auto-renewal engine started (queues: ${AUTO_RENEWAL_QUEUE_NAME}, ${AUTO_RENEWAL_EXECUTE_QUEUE_NAME})`);

  const getStatusFields = async (): Promise<WalletAutoRenewalStatusFields> => {
    const [enabled, dueOpen, completedToday, insufficient, requiresAction, failed] = await Promise.all([
      isWalletAutoRenewalEnabled(),
      prisma.serviceAutoRenewalAttempt.count({ where: { status: { in: ["SCHEDULED", "CLAIMED", "PAYMENT_CREATED", "FULFILLING"] } } }),
      prisma.serviceAutoRenewalAttempt.count({ where: { status: "COMPLETED", completedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } } }),
      prisma.serviceAutoRenewalAttempt.count({ where: { status: "INSUFFICIENT_BALANCE" } }),
      prisma.serviceAutoRenewalAttempt.count({ where: { status: "REQUIRES_ACTION" } }),
      prisma.serviceAutoRenewalAttempt.count({ where: { status: { in: ["FAILED", "DEAD_LETTER"] } } }),
    ]);
    return {
      walletAutoRenewalEnabled: enabled,
      lastWalletAutoRenewalScanAt: state.lastScanAt,
      autoRenewalDueCount: dueOpen,
      autoRenewalCompletedCount: completedToday,
      autoRenewalInsufficientBalanceCount: insufficient,
      autoRenewalRequiresActionCount: requiresAction,
      autoRenewalFailureCount: failed,
    };
  };

  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await Promise.allSettled([worker.close()]);
    await Promise.allSettled([controlQueue.close(), executeQueue.close(), serviceSyncQueue.close()]);
  };

  return { stop, getStatusFields };
}
