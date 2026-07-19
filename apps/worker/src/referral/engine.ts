import {
  REFERRAL_CLEANUP_INTERVAL_MS,
  REFERRAL_EXECUTE_QUEUE_NAME,
  REFERRAL_JOB_NAMES,
  REFERRAL_QUEUE_NAME,
  REFERRAL_RECONCILE_INTERVAL_MS,
  REFERRAL_SCAN_LOCK_KEY,
  REFERRAL_SCHEDULER_IDS,
  createLogger,
  errorMessage,
} from "@zedbot/shared";
import { Queue, Worker, type Job } from "bullmq";

import type { WorkerRedisConnection } from "../queues.js";
import type { RawRedis } from "../redis.js";
import {
  createReferralScanState,
  publishReferralStatus,
  runReferralCleanup,
  runReferralCreditScan,
  runReferralDebtRecoveryScan,
  runReferralReversalScan,
  type ReferralScanState,
} from "./scan.js";

// =============================================================================
// Referral commission reconciliation WORKER engine. Owns the recurring credit /
// reversal / recovery / cleanup scans on the `referral-commissions` control queue
// plus the settings-independent scheduler, and PRODUCES idempotent execute jobs
// onto `referral-commissions-execute` which the BOT process consumes (the wallet
// mutation reuses the bot's ledger; the worker cannot import the bot).
//
// The credit + reversal scans self-gate on the master switch (no-op when off), so
// nothing is paid behind a disabled system; the recovery + cleanup scans run
// regardless so an already-owed debt stays collectable after payouts are paused.
// =============================================================================

const logger = createLogger("worker:referral-engine");

/** Only one referral scan runs at a time across scheduler copies (short TTL). */
const SCAN_LOCK_TTL_MS = 4 * 60_000;
/** Status snapshot TTL — generous so it persists between scans (recency = checkedAt). */
const STATUS_TTL_SECONDS = 24 * 3600;

export interface ReferralEngine {
  stop: () => Promise<void>;
}

export function startReferralEngine(connection: WorkerRedisConnection, redis: RawRedis): ReferralEngine {
  const state: ReferralScanState = createReferralScanState();

  const controlQueue = new Queue(REFERRAL_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 24 * 3600 } },
  });
  const executeQueue = new Queue(REFERRAL_EXECUTE_QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: 5, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  });
  for (const [name, q] of [["referral-control", controlQueue], ["referral-execute", executeQueue]] as const) {
    q.on("error", (err) => logger.warn(`${name} redis error`, { error: errorMessage(err) }));
  }

  const withScanLock = async <T>(run: () => Promise<T>): Promise<T | { skipped: string }> => {
    const token = `${Date.now()}`;
    const acquired = await redis.set(REFERRAL_SCAN_LOCK_KEY, token, "PX", SCAN_LOCK_TTL_MS, "NX");
    if (acquired !== "OK") {
      return { skipped: "scan-locked" };
    }
    try {
      return await run();
    } finally {
      await redis
        .eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, REFERRAL_SCAN_LOCK_KEY, token)
        .catch(() => undefined);
    }
  };

  const worker = new Worker(
    REFERRAL_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      state.lastScanAt = new Date().toISOString();
      let result: Record<string, unknown>;
      if (job.name === REFERRAL_JOB_NAMES.SCAN_REFERRAL_CREDITS) {
        result = (await withScanLock(() => runReferralCreditScan(executeQueue, state))) as Record<string, unknown>;
      } else if (job.name === REFERRAL_JOB_NAMES.SCAN_REFERRAL_REVERSALS) {
        result = (await withScanLock(() => runReferralReversalScan(executeQueue, state))) as Record<string, unknown>;
      } else if (job.name === REFERRAL_JOB_NAMES.RECOVER_REFERRAL_DEBTS) {
        result = (await withScanLock(() => runReferralDebtRecoveryScan(executeQueue, state))) as Record<string, unknown>;
      } else if (job.name === REFERRAL_JOB_NAMES.CLEANUP_REFERRAL_COMMISSIONS) {
        result = (await runReferralCleanup()) as unknown as Record<string, unknown>;
      } else {
        throw new Error(`unknown job: ${job.name}`);
      }
      await publishReferralStatus(redis, state, STATUS_TTL_SECONDS);
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    logger.error("referral-control job failed", { jobName: job?.name, error: errorMessage(err) });
  });
  worker.on("error", (err) => logger.warn("referral-control worker redis error", { error: errorMessage(err) }));

  // --- scheduler (always active — scans self-gate on the master switch) -----
  const reconcile = async (): Promise<void> => {
    try {
      await Promise.all([
        controlQueue.upsertJobScheduler(
          REFERRAL_SCHEDULER_IDS.credits,
          { every: REFERRAL_RECONCILE_INTERVAL_MS },
          { name: REFERRAL_JOB_NAMES.SCAN_REFERRAL_CREDITS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          REFERRAL_SCHEDULER_IDS.reversals,
          { every: REFERRAL_RECONCILE_INTERVAL_MS },
          { name: REFERRAL_JOB_NAMES.SCAN_REFERRAL_REVERSALS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          REFERRAL_SCHEDULER_IDS.recovery,
          { every: REFERRAL_RECONCILE_INTERVAL_MS },
          { name: REFERRAL_JOB_NAMES.RECOVER_REFERRAL_DEBTS, data: {} },
        ),
        controlQueue.upsertJobScheduler(
          REFERRAL_SCHEDULER_IDS.cleanup,
          { every: REFERRAL_CLEANUP_INTERVAL_MS },
          { name: REFERRAL_JOB_NAMES.CLEANUP_REFERRAL_COMMISSIONS, data: {} },
        ),
      ]);
    } catch (err) {
      logger.warn("referral schedule reconcile failed", { error: errorMessage(err) });
    }
  };
  void reconcile();
  const timer = setInterval(() => void reconcile(), REFERRAL_RECONCILE_INTERVAL_MS);
  timer.unref();

  logger.info(`referral engine started (queues: ${REFERRAL_QUEUE_NAME}, ${REFERRAL_EXECUTE_QUEUE_NAME})`);

  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await Promise.allSettled([worker.close()]);
    await Promise.allSettled([controlQueue.close(), executeQueue.close()]);
  };

  return { stop };
}
