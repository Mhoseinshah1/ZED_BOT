import {
  BACKUP_JOB_NAMES,
  BACKUP_QUEUE_NAME,
  LOG_DELIVERY_JOB_NAME,
  LOG_DELIVERY_QUEUE_NAME,
} from "@zedbot/shared";
import { Queue, type DefaultJobOptions } from "bullmq";

// =============================================================================
// Queue construction + typed job payloads. Default job options are defined
// once here so internal enqueues (worker-side) match the bot-side contract.
// =============================================================================

export interface CreateBackupJobData {
  /** Absent on scheduler-emitted jobs - the worker creates the row itself. */
  operationId?: string;
  trigger?: string;
  scheduled?: boolean;
}

export interface BackupOperationJobData {
  operationId: string;
}

export interface LogDeliveryJobData {
  deliveryId: string;
}

/** Backup jobs: 3 attempts, exponential backoff from 10s. */
export const BACKUP_DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 100 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/** Log deliveries: 5 attempts, exponential backoff from 30s (30s * 2^n). */
export const LOG_DELIVERY_DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 100 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export interface WorkerRedisConnection {
  host: string;
  port: number;
  password?: string;
  /** BullMQ requires null so blocking commands survive reconnects. */
  maxRetriesPerRequest: null;
}

export function createBackupQueue(connection: WorkerRedisConnection): Queue {
  return new Queue(BACKUP_QUEUE_NAME, {
    connection,
    defaultJobOptions: BACKUP_DEFAULT_JOB_OPTIONS,
  });
}

export function createLogDeliveryQueue(connection: WorkerRedisConnection): Queue {
  return new Queue(LOG_DELIVERY_QUEUE_NAME, {
    connection,
    defaultJobOptions: LOG_DELIVERY_DEFAULT_JOB_OPTIONS,
  });
}

/** Enqueues the owner notification for a finished/failed backup operation. */
export async function enqueueBackupNotification(
  backupQueue: Queue,
  operationId: string,
): Promise<void> {
  const data: BackupOperationJobData = { operationId };
  await backupQueue.add(BACKUP_JOB_NAMES.NOTIFY, data, { jobId: `notify-${operationId}` });
}

/** Enqueues one Telegram delivery job (jobId = deliveryId for idempotency). */
export async function enqueueLogDelivery(logQueue: Queue, deliveryId: string): Promise<void> {
  const data: LogDeliveryJobData = { deliveryId };
  await logQueue.add(LOG_DELIVERY_JOB_NAME, data, { jobId: `logdel-${deliveryId}` });
}
