import { stat } from "node:fs/promises";
import path from "node:path";

import {
  BackupOperationStatus,
  BackupTrigger,
  connectDatabase,
  disconnectDatabase,
  prisma,
} from "@zedbot/database";
import { BACKUP_JOB_NAMES, WORKER_HEARTBEAT_KEY, getRedisOptions, intEnv } from "@zedbot/shared";
import type { Queue } from "bullmq";

import { pgDumpVersion, pgRestoreVersion } from "../backup/pg.js";
import { backupDir } from "../config.js";
import { probeBackupDirWritable } from "../heartbeat.js";
import { createBackupQueue, type CreateBackupJobData } from "../queues.js";
import { rawRedisClient, type RawRedis } from "../redis.js";

// =============================================================================
// CLI: bounded post-deployment smoke test, run by scripts/update.sh in a
// ONE-OFF worker container while the freshly recreated REAL worker container
// is running. It proves, in order: Redis answers, the worker heartbeat is
// live, the backup dir is writable, pg_dump/pg_restore exist, and a real
// enqueued backup (processed by the RUNNING worker, exactly like a bot-
// triggered one) reaches VERIFIED with its file on disk. Usage:
//
//   node dist/cli/deploy-smoke.js
//
// Overall budget: ZEDBOT_SMOKE_TIMEOUT_SECONDS (default 240). Prints one-line
// JSON {ok, failureCategory, filename, operationId, steps} and exits 0/1.
// Sends nothing to Telegram, deletes nothing, and never prints connection
// strings/passwords - step info fields carry fixed safe strings only.
// =============================================================================

const POLL_INTERVAL_MS = 3_000;
const HEARTBEAT_WAIT_MS = 60_000;
const REDIS_CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5_000;

interface SmokeStep {
  name: string;
  ok: boolean;
  info?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hard-bounds one Redis/queue command so the CLI can never hang on it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("smoke command timed out"));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function main(): Promise<void> {
  const configured = intEnv("ZEDBOT_SMOKE_TIMEOUT_SECONDS", 240);
  const timeoutSeconds = configured > 0 ? configured : 240;
  const deadline = Date.now() + timeoutSeconds * 1_000;

  const steps: SmokeStep[] = [];
  let failureCategory: string | null = null;
  let filename: string | null = null;
  let operationId: string | null = null;
  let printed = false;

  const emit = (): void => {
    if (printed) {
      return;
    }
    printed = true;
    process.stdout.write(
      `${JSON.stringify({ ok: failureCategory === null, failureCategory, filename, operationId, steps })}\n`,
    );
  };

  // Safety net: even if some client blocks past every per-step bound, the
  // update script gets its JSON verdict and its exit code. unref'd so a
  // normally finished run never waits on it.
  const hardTimer = setTimeout(
    () => {
      if (failureCategory === null) {
        failureCategory = "BACKUP_NOT_VERIFIED_IN_TIME";
      }
      emit();
      process.exit(1);
    },
    (timeoutSeconds + 30) * 1_000,
  );
  hardTimer.unref();

  let queue: Queue | null = null;
  let redis: RawRedis | null = null;
  let dbConnected = false;

  try {
    try {
      // --- a. redis: queue construction + PING through the queue client ----
      const options = getRedisOptions();
      if (options === null) {
        steps.push({ name: "redis", ok: false, info: "redis-not-configured" });
        failureCategory = "REDIS_UNREACHABLE";
      } else {
        // Same connection contract the worker uses (queues.ts), plus a
        // bounded connect/retry so a dead Redis fails fast instead of
        // blocking the deploy.
        const connection = {
          host: options.host,
          port: options.port,
          password: options.password,
          maxRetriesPerRequest: null,
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          retryStrategy: (times: number) => Math.min(times * 500, 5_000),
        };
        queue = createBackupQueue(connection);
        queue.on("error", () => undefined); // Swallow connect noise; we race below.
        try {
          redis = await Promise.race<RawRedis | null>([
            rawRedisClient(queue),
            new Promise<null>((resolve) => {
              setTimeout(() => resolve(null), REDIS_CONNECT_TIMEOUT_MS).unref();
            }),
          ]);
          if (redis !== null) {
            await withTimeout(redis.ping(), COMMAND_TIMEOUT_MS);
          }
        } catch {
          redis = null;
        }
        if (redis === null) {
          steps.push({ name: "redis", ok: false, info: "connect-or-ping-failed" });
          failureCategory = "REDIS_UNREACHABLE";
        } else {
          steps.push({ name: "redis", ok: true });
        }
      }

      // --- b. worker-heartbeat: the recreated worker publishes at boot ------
      if (failureCategory === null && redis !== null) {
        const waitUntil = Date.now() + HEARTBEAT_WAIT_MS;
        let heartbeat: string | null = null;
        for (;;) {
          try {
            heartbeat = await withTimeout(redis.get(WORKER_HEARTBEAT_KEY), COMMAND_TIMEOUT_MS);
          } catch {
            heartbeat = null; // Transient Redis blip: keep polling until the window closes.
          }
          if (heartbeat !== null || Date.now() >= waitUntil) {
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        if (heartbeat === null) {
          steps.push({ name: "worker-heartbeat", ok: false, info: "no-heartbeat-within-60s" });
          failureCategory = "WORKER_HEARTBEAT_MISSING";
        } else {
          // The stored value is the worker's ISO publish time - safe to show.
          steps.push({ name: "worker-heartbeat", ok: true, info: heartbeat });
        }
      }

      // --- c. backup-dir-writable ------------------------------------------
      if (failureCategory === null) {
        const dir = backupDir();
        const writable = await probeBackupDirWritable(dir);
        steps.push({ name: "backup-dir-writable", ok: writable, info: dir });
        if (!writable) {
          failureCategory = "BACKUP_DIR_NOT_WRITABLE";
        }
      }

      // --- d. pg-client: both tools must exist for create AND verify --------
      if (failureCategory === null) {
        const dumpVersion = await pgDumpVersion();
        const restoreVersion = await pgRestoreVersion();
        const info = `pg_dump ${dumpVersion ?? "missing"}, pg_restore ${restoreVersion ?? "missing"}`;
        if (dumpVersion === null || restoreVersion === null) {
          steps.push({ name: "pg-client", ok: false, info });
          failureCategory = "PG_CLIENT_MISSING";
        } else {
          steps.push({ name: "pg-client", ok: true, info });
        }
      }

      // --- e. backup-enqueue: exactly the bot's enqueueBackupCreate contract
      if (failureCategory === null && queue !== null) {
        try {
          await connectDatabase();
          dbConnected = true;
          const operation = await prisma.backupOperation.create({
            data: {
              trigger: BackupTrigger.MANUAL,
              status: BackupOperationStatus.QUEUED,
              requestedByAdminId: null,
            },
          });
          operationId = operation.id;
          // Payload/jobId/attempts/backoff mirror the bot's
          // enqueueBackupCreate (ops-queue.service.ts) so the RUNNING worker
          // container processes this like any admin-triggered backup.
          const data: CreateBackupJobData = { operationId: operation.id };
          await withTimeout(
            queue.add(BACKUP_JOB_NAMES.CREATE, data, {
              jobId: operation.id,
              attempts: 3,
              backoff: { type: "exponential", delay: 10_000 },
            }),
            COMMAND_TIMEOUT_MS,
          );
          steps.push({ name: "backup-enqueue", ok: true });
        } catch {
          steps.push({ name: "backup-enqueue", ok: false, info: "enqueue-failed" });
          failureCategory = "BACKUP_ENQUEUE_FAILED";
        }
      }

      // --- f. backup-verified: wait for the real worker to finish ----------
      if (failureCategory === null && operationId !== null) {
        let lastStatus: string = BackupOperationStatus.QUEUED;
        for (;;) {
          const row = await prisma.backupOperation
            .findUnique({ where: { id: operationId } })
            .catch(() => null); // Transient DB blip: keep polling until the deadline.
          if (row !== null) {
            lastStatus = row.status;
            if (row.status === BackupOperationStatus.VERIFIED) {
              filename = row.filename;
              steps.push({
                name: "backup-verified",
                ok: true,
                ...(filename === null ? {} : { info: filename }),
              });
              break;
            }
            if (
              row.status === BackupOperationStatus.FAILED ||
              row.status === BackupOperationStatus.CORRUPT ||
              row.status === BackupOperationStatus.CANCELLED
            ) {
              // safeErrorCode is a short scrubbed code by construction.
              steps.push({
                name: "backup-verified",
                ok: false,
                info: row.safeErrorCode ?? row.status,
              });
              failureCategory = "BACKUP_FAILED";
              break;
            }
          }
          if (Date.now() >= deadline) {
            steps.push({
              name: "backup-verified",
              ok: false,
              info: `timeout-in-status-${lastStatus}`,
            });
            failureCategory = "BACKUP_NOT_VERIFIED_IN_TIME";
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      }

      // --- g. backup-file: the verified dump must exist on the shared dir --
      if (failureCategory === null) {
        if (filename === null) {
          steps.push({ name: "backup-file", ok: false, info: "no-filename-recorded" });
          failureCategory = "BACKUP_FILE_MISSING";
        } else {
          try {
            const stats = await stat(path.join(backupDir(), filename));
            steps.push({ name: "backup-file", ok: true, info: `${stats.size} bytes` });
          } catch {
            steps.push({ name: "backup-file", ok: false, info: filename });
            failureCategory = "BACKUP_FILE_MISSING";
          }
        }
      }
    } catch {
      // A step threw outside its own guard - never report a false pass.
      if (failureCategory === null) {
        failureCategory = "UNEXPECTED_ERROR";
      }
    }
  } finally {
    if (queue !== null) {
      await withTimeout(queue.close(), COMMAND_TIMEOUT_MS).catch(() => undefined);
    }
    if (dbConnected) {
      await disconnectDatabase().catch(() => undefined);
    }
    emit();
  }
  process.exit(failureCategory === null ? 0 : 1);
}

main().catch(() => {
  // Fixed string only - an unexpected error message could embed a URL.
  process.stderr.write("deploy-smoke failed\n");
  process.exit(1);
});
