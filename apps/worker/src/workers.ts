import path from "node:path";

import { BackupOperationStatus, SystemLogLevel, prisma } from "@zedbot/database";
import { BACKUP_JOB_NAMES, createLogger, errorMessage } from "@zedbot/shared";
import type { Job, Queue } from "bullmq";

import { backupDir, backupEncryptionPassword } from "./config.js";
import { writeOpsLog } from "./ops-log.js";
import {
  BackupFailure,
  backupFailureCode,
  executeBackup,
  markOperationFailed,
  requeueOperationForRetry,
} from "./backup/create.js";
import { runBackupCleanup } from "./backup/cleanup.js";
import { sendBackupNotification } from "./backup/notify.js";
import { updateManifestVerification } from "./backup/files.js";
import { verifyBackupFile } from "./backup/verify.js";
import { prepareScheduledOperation } from "./scheduler.js";
import {
  enqueueBackupNotification,
  type BackupOperationJobData,
  type CreateBackupJobData,
} from "./queues.js";
import { acquireBackupLock, releaseBackupLock, type RawRedis } from "./redis.js";

// =============================================================================
// Backup-queue processor: dispatches the four BACKUP_JOB_NAMES; anything
// else THROWS so BullMQ marks the job failed (never silently ignored).
// =============================================================================

const logger = createLogger("worker:backup-jobs");

export interface BackupWorkerDeps {
  redis: RawRedis;
  backupQueue: Queue;
}

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * CREATE_DATABASE_BACKUP for a concrete operation id (manual/pre-update via
 * the bot with jobId=operationId, or a row the scheduled path just created).
 */
async function handleCreateForOperation(
  job: Job,
  deps: BackupWorkerDeps,
  operationId: string,
): Promise<Record<string, unknown>> {
  const operation = await prisma.backupOperation.findUnique({ where: { id: operationId } });
  if (operation === null) {
    throw new Error(`unknown backup operation: ${operationId}`);
  }
  if (
    operation.status !== BackupOperationStatus.QUEUED &&
    operation.status !== BackupOperationStatus.RUNNING
  ) {
    // A retried/duplicated job whose operation already finished: no-op.
    return { ok: true, alreadyDone: true, status: operation.status };
  }

  // Global single-backup lock. When another backup holds it we THROW so
  // BullMQ retries this job later through its exponential backoff.
  const lock = await acquireBackupLock(deps.redis);
  try {
    if (lock === null) {
      throw new Error("backup-already-running");
    }
    const result = await executeBackup(operationId);
    if (!result.alreadyDone) {
      try {
        await enqueueBackupNotification(deps.backupQueue, operationId);
      } catch (err) {
        // Never turn a finished backup into a failure over a notify enqueue.
        logger.warn("failed to enqueue backup notification", { error: errorMessage(err) });
      }
    }
    return {
      ok: result.ok,
      alreadyDone: result.alreadyDone,
      status: result.status,
      filename: result.filename,
      verified: result.verified,
    };
  } catch (err) {
    const code =
      err instanceof BackupFailure
        ? backupFailureCode(err)
        : err instanceof Error && err.message === "backup-already-running"
          ? "backup-already-running"
          : "unexpected-error";
    try {
      if (isFinalAttempt(job)) {
        // Attempts exhausted -> terminal FAILED + owner notification. This
        // also covers infrastructure errors (lock contention, DB blips) so
        // an operation can never rot in QUEUED after its job gave up.
        await markOperationFailed(operationId, code);
        await enqueueBackupNotification(deps.backupQueue, operationId);
      } else {
        // Intermediate attempt: back to QUEUED (fresh temp name next time).
        // No-op when the attempt never reached RUNNING (e.g. lock was held).
        await requeueOperationForRetry(operationId, code);
      }
    } catch (bookkeepingErr) {
      // Never mask the original failure with bookkeeping problems.
      logger.warn("backup failure bookkeeping failed", {
        error: errorMessage(bookkeepingErr),
      });
    }
    throw err;
  } finally {
    if (lock !== null) {
      await releaseBackupLock(deps.redis, lock);
    }
  }
}

/** Scheduler-emitted CREATE (no operationId): preflight then own row. */
async function handleScheduledCreate(
  job: Job,
  deps: BackupWorkerDeps,
): Promise<Record<string, unknown>> {
  const prepared = await prepareScheduledOperation();
  if (prepared.operationId === null) {
    return { ok: false, skipped: true, reason: prepared.missedReason };
  }
  return handleCreateForOperation(job, deps, prepared.operationId);
}

/** Standalone VERIFY_DATABASE_BACKUP job for an existing completed dump. */
async function handleVerifyJob(operationId: string): Promise<Record<string, unknown>> {
  const operation = await prisma.backupOperation.findUnique({ where: { id: operationId } });
  if (operation === null) {
    throw new Error(`unknown backup operation: ${operationId}`);
  }
  if (operation.filename === null) {
    throw new Error("backup operation has no file to verify");
  }
  await prisma.backupOperation.update({
    where: { id: operationId },
    data: { status: BackupOperationStatus.VERIFYING },
  });
  const filePath = path.join(backupDir(), operation.filename);
  const verification = await verifyBackupFile(filePath, backupEncryptionPassword());
  if (verification.ok) {
    await prisma.backupOperation.update({
      where: { id: operationId },
      data: { status: BackupOperationStatus.VERIFIED, verifiedAt: new Date() },
    });
    await updateManifestVerification(filePath, "VERIFIED");
    await writeOpsLog({
      level: SystemLogLevel.INFO,
      topicKey: "BACKUP",
      eventType: "backup_verified",
      message: "صحت بکاپ دیتابیس تایید شد",
      metadata: { operationId, filename: operation.filename },
    });
    return { ok: true, verified: true };
  }
  await prisma.backupOperation.update({
    where: { id: operationId },
    data: {
      status: BackupOperationStatus.CORRUPT,
      safeErrorCode: verification.reason ?? "verify-failed",
    },
  });
  await updateManifestVerification(filePath, "CORRUPT");
  await writeOpsLog({
    level: SystemLogLevel.ERROR,
    topicKey: "BACKUP",
    eventType: "backup_corrupt",
    message: "بکاپ دیتابیس تایید صحت نشد و خراب است",
    metadata: { operationId, filename: operation.filename, reason: verification.reason },
  });
  return { ok: false, verified: false, reason: verification.reason };
}

/** Builds the processor for the backup worker (concurrency 1). */
export function createBackupProcessor(
  deps: BackupWorkerDeps,
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job: Job): Promise<Record<string, unknown>> => {
    switch (job.name) {
      case BACKUP_JOB_NAMES.CREATE: {
        const data = job.data as CreateBackupJobData;
        if (data.operationId === undefined) {
          return handleScheduledCreate(job, deps);
        }
        return handleCreateForOperation(job, deps, data.operationId);
      }
      case BACKUP_JOB_NAMES.VERIFY: {
        const data = job.data as BackupOperationJobData;
        return handleVerifyJob(data.operationId);
      }
      case BACKUP_JOB_NAMES.CLEANUP: {
        const result = await runBackupCleanup();
        return { ok: true, ...result };
      }
      case BACKUP_JOB_NAMES.NOTIFY: {
        const data = job.data as BackupOperationJobData;
        const result = await sendBackupNotification(data.operationId);
        return { ok: true, ...result };
      }
      default:
        // Unknown names MUST fail loudly so they surface in the failed set.
        throw new Error(`unknown job: ${job.name}`);
    }
  };
}
