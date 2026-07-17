import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { BackupOperationStatus, SystemLogLevel, prisma } from "@zedbot/database";
import {
  BACKUP_ENVELOPE_HEADER_BYTES,
  BACKUP_ENVELOPE_TAG_BYTES,
  BACKUP_PARTIAL_SUFFIX,
  createBackupEncryptor,
  createLogger,
  errorMessage,
  scrubSecretsFromText,
} from "@zedbot/shared";

import { appVersion, backupDir, backupEncryptionPassword, backupTimeoutMs } from "../config.js";
import { writeOpsLog } from "../ops-log.js";
import {
  pickBackupFileName,
  promotePartialFile,
  sha256File,
  unlinkQuiet,
  updateManifestVerification,
  writeManifest,
} from "./files.js";
import { pgDumpSafeUrl, pgDumpVersion } from "./pg.js";
import { verifyBackupFile } from "./verify.js";
import { zbk1Stream } from "./zbk1-stream.js";

// =============================================================================
// The create+verify sequence for one BackupOperation. This is the SINGLE
// implementation used by the queue consumer, the scheduled path and the CLI
// (which calls it directly, without Redis). Locking and retry/attempt policy
// are the CALLER's responsibility - this module only runs one attempt and
// reports failures as BackupFailure with a short scrubbed safeErrorCode.
// =============================================================================

const logger = createLogger("worker:backup");

/** Failure with a short safe code ("pg-dump-exit-1") - never raw stderr/URLs. */
export class BackupFailure extends Error {
  constructor(public readonly safeErrorCode: string) {
    super(safeErrorCode);
    this.name = "BackupFailure";
  }
}

/** Collapses any unknown error into a safe code for DB persistence. */
export function backupFailureCode(err: unknown): string {
  return err instanceof BackupFailure ? err.safeErrorCode : "unexpected-error";
}

export interface ExecuteBackupResult {
  /** true only when the dump was created AND verified. */
  ok: boolean;
  /** The operation had already left QUEUED/RUNNING - nothing was done. */
  alreadyDone: boolean;
  status: BackupOperationStatus;
  filename: string | null;
  verified: boolean;
}

/**
 * pg_dump (custom format, URL as argv - no shell) -> optional ZBK1 envelope
 * -> exclusively-created .partial file. A watchdog SIGKILLs a hung pg_dump.
 */
async function dumpToFile(
  databaseUrl: string,
  tmpPath: string,
  password: string | null,
): Promise<void> {
  const child = spawn("pg_dump", ["--format=custom", "--dbname", pgDumpSafeUrl(databaseUrl)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrTail.length < 2048) {
      stderrTail += chunk.toString();
    }
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, backupTimeoutMs());
  watchdog.unref();

  let spawnFailed = false;
  const exit = new Promise<number>((resolve) => {
    child.on("error", () => {
      // e.g. pg_dump binary missing. stdout simply ends, pipeline completes.
      spawnFailed = true;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });

  const out = createWriteStream(tmpPath, { flags: "wx", mode: 0o600 });
  try {
    if (password !== null) {
      const encryptor = createBackupEncryptor(password);
      await pipeline(child.stdout, (source) => zbk1Stream(source, encryptor), out);
    } else {
      await pipeline(child.stdout, out);
    }
  } catch (err) {
    child.kill("SIGKILL");
    await exit;
    clearTimeout(watchdog);
    // Local scrubbed diagnostics only - the DB gets the short code below.
    logger.warn("backup stream failed", {
      error: scrubSecretsFromText(errorMessage(err)).slice(0, 200),
    });
    const fsCode = (err as NodeJS.ErrnoException).code;
    if (fsCode === "EACCES" || fsCode === "EROFS" || fsCode === "ENOENT" || fsCode === "EEXIST") {
      throw new BackupFailure("backup-dir-unwritable");
    }
    if (fsCode === "ENOSPC") {
      throw new BackupFailure("disk-full");
    }
    throw new BackupFailure(password !== null ? "encryption-failed" : "backup-write-failed");
  }
  const code = await exit;
  clearTimeout(watchdog);
  if (timedOut) {
    throw new BackupFailure("pg-dump-timeout");
  }
  if (spawnFailed) {
    throw new BackupFailure("pg-dump-spawn-failed");
  }
  if (code !== 0) {
    logger.warn("pg_dump failed", {
      exitCode: code,
      stderr: scrubSecretsFromText(stderrTail).slice(0, 200),
    });
    throw new BackupFailure(`pg-dump-exit-${code}`);
  }
}

/**
 * Runs one create+verify attempt for the given BackupOperation:
 * CAS -> RUNNING, pg_dump to .partial (fresh name per attempt), sha256,
 * fsync + atomic rename, sidecar manifest, COMPLETED, then inline
 * verification to VERIFIED/CORRUPT. Throws BackupFailure on dump failure
 * (after removing ONLY its own .partial file).
 */
export async function executeBackup(operationId: string): Promise<ExecuteBackupResult> {
  const operation = await prisma.backupOperation.findUnique({ where: { id: operationId } });
  if (operation === null) {
    throw new Error(`unknown backup operation: ${operationId}`);
  }
  // Idempotency CAS: only QUEUED/RUNNING operations may (re)start. A row a
  // previous attempt already drove to a terminal state is reported as done.
  const claimed = await prisma.backupOperation.updateMany({
    where: {
      id: operationId,
      status: { in: [BackupOperationStatus.QUEUED, BackupOperationStatus.RUNNING] },
    },
    data: { status: BackupOperationStatus.RUNNING, startedAt: new Date(), safeErrorCode: null },
  });
  if (claimed.count === 0) {
    const verified = operation.status === BackupOperationStatus.VERIFIED;
    return {
      ok: verified,
      alreadyDone: true,
      status: operation.status,
      filename: operation.filename,
      verified,
    };
  }

  await writeOpsLog({
    level: SystemLogLevel.INFO,
    topicKey: "BACKUP",
    eventType: "backup_started",
    message: "ساخت بکاپ دیتابیس شروع شد",
    metadata: { operationId, trigger: operation.trigger },
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new BackupFailure("db-url-missing");
  }

  const dir = backupDir();
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const password = backupEncryptionPassword();
  const encrypted = password !== null;

  let finalName: string;
  try {
    ({ finalName } = pickBackupFileName(dir, encrypted, BACKUP_PARTIAL_SUFFIX));
  } catch {
    throw new BackupFailure("filename-collision");
  }
  const finalPath = path.join(dir, finalName);
  const tmpPath = `${finalPath}${BACKUP_PARTIAL_SUFFIX}`;

  let sizeBytes: number;
  let checksum: string;
  try {
    await dumpToFile(databaseUrl, tmpPath, password);
    const stats = await stat(tmpPath);
    sizeBytes = stats.size;
    const minSize = encrypted ? BACKUP_ENVELOPE_HEADER_BYTES + BACKUP_ENVELOPE_TAG_BYTES + 1 : 1;
    if (sizeBytes < minSize) {
      throw new BackupFailure("empty-output");
    }
    // Checksum of the final bytes as written (the rename does not change them).
    checksum = await sha256File(tmpPath);
  } catch (err) {
    // Remove ONLY the .partial file this attempt exclusively created.
    await unlinkQuiet(tmpPath);
    throw err instanceof BackupFailure ? err : new BackupFailure("backup-write-failed");
  }

  await promotePartialFile(tmpPath, finalPath);

  const pgClientVersion = await pgDumpVersion();
  const manifest = {
    operationId,
    filename: finalName,
    createdAt: new Date().toISOString(),
    appVersion: appVersion(),
    pgClientVersion,
    dumpFormat: "custom" as const,
    formatVersion: 1,
    sizeBytes,
    sha256: checksum,
    encrypted,
    verification: "PENDING" as const,
  };
  await writeManifest(finalPath, manifest).catch(() => undefined);

  await prisma.backupOperation.update({
    where: { id: operationId },
    data: {
      status: BackupOperationStatus.COMPLETED,
      filename: finalName,
      sizeBytes: BigInt(sizeBytes),
      checksumSha256: checksum,
      encrypted,
      formatVersion: 1,
      appVersion: appVersion(),
      pgClientVersion,
      completedAt: new Date(),
    },
  });
  await writeOpsLog({
    level: SystemLogLevel.INFO,
    topicKey: "BACKUP",
    eventType: "backup_completed",
    message: "بکاپ دیتابیس ساخته شد",
    metadata: { operationId, filename: finalName, sizeBytes, encrypted },
  });

  // --- inline verification (same job) ---------------------------------------
  await prisma.backupOperation.update({
    where: { id: operationId },
    data: { status: BackupOperationStatus.VERIFYING },
  });
  const verification = await verifyBackupFile(finalPath, password);
  if (verification.ok) {
    await prisma.backupOperation.update({
      where: { id: operationId },
      data: { status: BackupOperationStatus.VERIFIED, verifiedAt: new Date() },
    });
    await updateManifestVerification(finalPath, "VERIFIED");
    await writeOpsLog({
      level: SystemLogLevel.INFO,
      topicKey: "BACKUP",
      eventType: "backup_verified",
      message: "صحت بکاپ دیتابیس تایید شد",
      metadata: { operationId, filename: finalName },
    });
    return {
      ok: true,
      alreadyDone: false,
      status: BackupOperationStatus.VERIFIED,
      filename: finalName,
      verified: true,
    };
  }
  await prisma.backupOperation.update({
    where: { id: operationId },
    data: {
      status: BackupOperationStatus.CORRUPT,
      safeErrorCode: verification.reason ?? "verify-failed",
    },
  });
  await updateManifestVerification(finalPath, "CORRUPT");
  await writeOpsLog({
    level: SystemLogLevel.ERROR,
    topicKey: "BACKUP",
    eventType: "backup_corrupt",
    message: "بکاپ دیتابیس تایید صحت نشد و خراب است",
    metadata: { operationId, filename: finalName, reason: verification.reason },
  });
  return {
    ok: false,
    alreadyDone: false,
    status: BackupOperationStatus.CORRUPT,
    filename: finalName,
    verified: false,
  };
}

/** Terminal failure: FAILED + safe code + ops log (used on the last attempt). */
export async function markOperationFailed(
  operationId: string,
  safeErrorCode: string,
): Promise<void> {
  await prisma.backupOperation.updateMany({
    where: {
      id: operationId,
      status: { in: [BackupOperationStatus.QUEUED, BackupOperationStatus.RUNNING] },
    },
    data: { status: BackupOperationStatus.FAILED, safeErrorCode, completedAt: new Date() },
  });
  await writeOpsLog({
    level: SystemLogLevel.ERROR,
    topicKey: "BACKUP",
    eventType: "backup_failed",
    message: `ساخت بکاپ دیتابیس ناموفق بود (${safeErrorCode})`,
    metadata: { operationId, safeErrorCode },
  });
}

/**
 * Intermediate failure: back to QUEUED (recording the safe code) so the next
 * BullMQ attempt passes the QUEUED/RUNNING idempotency check. The FINAL
 * attempt uses markOperationFailed instead ("attempts exhausted = FAILED").
 */
export async function requeueOperationForRetry(
  operationId: string,
  safeErrorCode: string,
): Promise<void> {
  await prisma.backupOperation.updateMany({
    where: { id: operationId, status: BackupOperationStatus.RUNNING },
    data: { status: BackupOperationStatus.QUEUED, safeErrorCode },
  });
}
