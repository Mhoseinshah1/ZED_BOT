import { statfs } from "node:fs/promises";

import { BackupOperationStatus, BackupTrigger, SystemLogLevel, prisma } from "@zedbot/database";
import {
  BACKUP_JOB_NAMES,
  SCHEDULED_BACKUP_JOB_ID,
  createLogger,
  errorMessage,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { backupDir, backupMinFreeDiskMb } from "./config.js";
import { probeBackupDirWritable } from "./heartbeat.js";
import { writeOpsLog } from "./ops-log.js";
import { pgDumpVersion } from "./backup/pg.js";
import type { CreateBackupJobData } from "./queues.js";

// =============================================================================
// Scheduled backups: reconciles ONE BullMQ job scheduler (repeatable job)
// against the operator-editable Settings, re-checked every 5 minutes so
// bot-side changes apply without a worker restart. The scheduled job carries
// NO operationId - the worker creates the BackupOperation row itself, but
// only after the preflight passes ("missed" runs are SystemLog-only, no row).
// =============================================================================

const logger = createLogger("worker:scheduler");

/** Exact Setting keys consumed (bot-side UI writes them). */
export const SETTING_BACKUP_SCHEDULE_ENABLED = "backup_schedule_enabled";
export const SETTING_BACKUP_SCHEDULE_INTERVAL = "backup_schedule_interval";
export const SETTING_BACKUP_SCHEDULE_HOUR = "backup_schedule_hour";

export const RECONCILE_INTERVAL_MS = 5 * 60_000;

async function settingValue(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value.trim() ?? "";
  return value === "" ? null : value;
}

/**
 * Settings -> cron pattern (cron runs in the container's local timezone,
 * i.e. whatever TZ the compose file sets). Weekly backups fire on Friday -
 * the Iranian weekend, when database churn is lowest.
 */
export async function desiredSchedulePattern(): Promise<string | null> {
  const enabledRaw = (await settingValue(SETTING_BACKUP_SCHEDULE_ENABLED))?.toLowerCase() ?? "false";
  const enabled = enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes";
  if (!enabled) {
    return null;
  }
  const interval = (await settingValue(SETTING_BACKUP_SCHEDULE_INTERVAL)) ?? "daily";
  const hourRaw = Number.parseInt((await settingValue(SETTING_BACKUP_SCHEDULE_HOUR)) ?? "3", 10);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, hourRaw)) : 3;
  switch (interval) {
    case "6h":
      return "0 */6 * * *";
    case "12h":
      return "0 */12 * * *";
    case "daily":
      return `0 ${hour} * * *`;
    case "weekly":
      return `0 ${hour} * * 5`;
    default:
      logger.warn("unknown backup_schedule_interval, schedule disabled", { interval });
      return null;
  }
}

/**
 * Makes the queue's job schedulers match the Settings: upsert (which
 * replaces a stale pattern under the same id) when enabled, remove when
 * disabled. upsertJobScheduler is idempotent, so running this every 5
 * minutes is safe.
 */
export async function reconcileBackupSchedule(backupQueue: Queue): Promise<void> {
  try {
    const pattern = await desiredSchedulePattern();
    if (pattern === null) {
      await backupQueue.removeJobScheduler(SCHEDULED_BACKUP_JOB_ID);
      return;
    }
    const data: CreateBackupJobData = { scheduled: true, trigger: BackupTrigger.SCHEDULED };
    await backupQueue.upsertJobScheduler(
      SCHEDULED_BACKUP_JOB_ID,
      { pattern },
      { name: BACKUP_JOB_NAMES.CREATE, data },
    );
  } catch (err) {
    logger.warn("schedule reconcile failed", { error: errorMessage(err) });
  }
}

/** Immediate reconcile + 5-minute cadence; returns a stop function. */
export function startScheduleReconciler(backupQueue: Queue): () => void {
  void reconcileBackupSchedule(backupQueue);
  const timer = setInterval(() => void reconcileBackupSchedule(backupQueue), RECONCILE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// --- preflight ---------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  /** Short reason ("pg-dump-missing", "dir-unwritable", "low-disk", ...). */
  reason: string | null;
}

/**
 * Scheduled-run preflight. Worker liveness is trivially true (we ARE the
 * worker). Checks: backup dir writable, enough free disk, no backup already
 * in flight, pg_dump present.
 */
export async function scheduledBackupPreflight(): Promise<PreflightResult> {
  const dir = backupDir();
  if (!(await probeBackupDirWritable(dir))) {
    return { ok: false, reason: "dir-unwritable" };
  }
  try {
    const stats = await statfs(dir);
    const freeMb = (Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024);
    if (freeMb < backupMinFreeDiskMb()) {
      return { ok: false, reason: "low-disk" };
    }
  } catch {
    return { ok: false, reason: "statfs-failed" };
  }
  const inFlight = await prisma.backupOperation.count({
    where: {
      status: { in: [BackupOperationStatus.RUNNING, BackupOperationStatus.VERIFYING] },
    },
  });
  if (inFlight > 0) {
    return { ok: false, reason: "backup-in-flight" };
  }
  if ((await pgDumpVersion()) === null) {
    return { ok: false, reason: "pg-dump-missing" };
  }
  return { ok: true, reason: null };
}

/**
 * Entry for a scheduler-emitted CREATE job: preflight, then create the
 * SCHEDULED BackupOperation row. A failed preflight emits a "scheduled
 * backup missed" ops log and creates NO operation row.
 */
export async function prepareScheduledOperation(): Promise<
  { operationId: string } | { operationId: null; missedReason: string }
> {
  const preflight = await scheduledBackupPreflight();
  if (!preflight.ok) {
    const reason = preflight.reason ?? "unknown";
    await writeOpsLog({
      level: SystemLogLevel.WARN,
      topicKey: "BACKUP",
      eventType: "scheduled_backup_missed",
      message: `بکاپ زمانبندی‌شده اجرا نشد (${reason})`,
      metadata: { reason },
    });
    return { operationId: null, missedReason: reason };
  }
  const operation = await prisma.backupOperation.create({
    data: { trigger: BackupTrigger.SCHEDULED, status: BackupOperationStatus.QUEUED },
  });
  return { operationId: operation.id };
}
