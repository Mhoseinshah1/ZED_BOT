import { access, constants, readdir, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

import {
  BackupOperationStatus,
  BackupTrigger,
  prisma,
  type Admin,
  type BackupOperation,
} from "@zedbot/database";
import {
  BACKUP_MANIFEST_SUFFIX,
  classifyBackupFileName,
  DEFAULT_CONTAINER_BACKUP_DIR,
  errorMessage,
  type BackupFileKind,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  enqueueBackupCreate,
  getBackupQueueCounts,
  pingOpsRedis,
  readWorkerCapabilities,
  readWorkerHeartbeat,
  type BackupQueueCounts,
} from "./ops-queue.service.js";
import { getSetting } from "./settings.service.js";
import { OPS_EVENTS, writeSystemLog, LOG_GROUP_CHAT_ID_KEY } from "./system-log.service.js";

// =============================================================================
// «گزارشات / بکاپ 🛡» (production-backup rework) - backup listing, manual
// backup REQUESTS and the system health check. The bot NEVER runs pg_dump
// anymore: a manual backup creates one BackupOperation row and enqueues a
// BullMQ job (jobId = operation id, so repeated taps can never duplicate
// work); the worker service performs the dump/verify/cleanup against the
// shared backup directory. File resolution stays traversal-proof: names are
// only accepted through classifyBackupFileName (anchored regexes) and the
// resolved path is containment-checked against the backup directory.
// Partial files and manifest sidecars are never listed or served. No
// credential, connection URL or encryption password ever appears in any
// output - error strings are scrubbed defensively.
// =============================================================================

export const BACKUP_PAGE_SIZE = 10;
const SHORT_ID_RE = /^\d{8}-\d{6}$/;

/** Legacy plain-gzip pattern kept for scripts/tests that still reference it. */
export const BACKUP_FILE_RE = /^zedbot-db-(\d{8}-\d{6})\.sql\.gz$/;

export const BACKUP_NOT_FOUND_TEXT = "فایل بکاپ پیدا نشد.";
export const BACKUP_QUEUE_UNAVAILABLE_TEXT =
  "صف پردازش در دسترس نیست. تنظیمات Redis و سرویس worker را بررسی کنید.";

// Scheduled-backup Settings (the WORKER reconciles its repeatable BullMQ job
// from these rows - the bot only edits them, it never touches the queue's
// repeatable jobs directly).
export const BACKUP_SCHEDULE_ENABLED_KEY = "backup_schedule_enabled";
export const BACKUP_SCHEDULE_INTERVAL_KEY = "backup_schedule_interval";
export const BACKUP_SCHEDULE_HOUR_KEY = "backup_schedule_hour";
export const BACKUP_SCHEDULE_NOTIFY_KEY = "backup_schedule_notify";

export const BACKUP_SCHEDULE_INTERVALS = ["6h", "12h", "daily", "weekly"] as const;
export type BackupScheduleInterval = (typeof BACKUP_SCHEDULE_INTERVALS)[number];

/** Read lazily so tests can point BACKUP_DIR at a temp directory. */
export function backupDir(): string {
  return process.env.BACKUP_DIR ?? DEFAULT_CONTAINER_BACKUP_DIR;
}

export function backupRetentionDays(): number {
  const parsed = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

/** Minimum number of backups the cleanup always keeps (worker-enforced). */
export function backupMinRetained(): number {
  const parsed = Number(process.env.BACKUP_MIN_RETAINED ?? 3);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 3;
}

/** Free-disk warning threshold for the health page (MB). */
export function backupMinFreeDiskMb(): number {
  const parsed = Number(process.env.BACKUP_MIN_FREE_DISK_MB ?? 500);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

function telegramMaxBytes(): number {
  const parsed = Number(process.env.BACKUP_MAX_TELEGRAM_MB ?? 45);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 45) * 1024 * 1024;
}

export const BACKUP_MAX_TELEGRAM_BYTES = telegramMaxBytes();

/** True when backups are encrypted at rest (presence only - NEVER the value). */
export function isBackupEncryptionEnabled(): boolean {
  return (process.env.BACKUP_ENCRYPTION_PASSWORD ?? "") !== "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Legacy helper kept for deploy scripts/tests: plain-gzip names only. */
export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_RE.test(name);
}

/** zedbot-db-20260710-183000.sql.gz -> "20260710-183000" (callback-safe). */
export function backupShortIdFromName(name: string): string | null {
  return classifyBackupFileName(name)?.shortId ?? null;
}

/** Defensive scrub: an error string must never leak the connection URL. */
export function scrubBackupError(err: unknown): string {
  let message = errorMessage(err).slice(0, 300);
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== "") {
    message = message.split(url).join("[database-url]");
  }
  return message.replace(/postgres(ql)?:\/\/\S+/gi, "[database-url]");
}

// --- listing --------------------------------------------------------------------------------

export type BackupVerifyState = "verified" | "corrupt" | "unknown";

export interface BackupListEntry {
  name: string;
  shortId: string;
  kind: BackupFileKind;
  sizeBytes: number;
  createdAt: Date;
  /** Joined BackupOperation (by filename); null for legacy/CLI files. */
  operation: BackupOperation | null;
  encrypted: boolean;
  verifyState: BackupVerifyState;
}

export interface BackupsPage {
  backups: BackupListEntry[];
  page: number;
  pages: number;
  total: number;
}

function verifyStateOf(operation: BackupOperation | null): BackupVerifyState {
  if (operation?.status === BackupOperationStatus.VERIFIED) {
    return "verified";
  }
  if (operation?.status === BackupOperationStatus.CORRUPT) {
    return "corrupt";
  }
  return "unknown";
}

/**
 * Backup files only (dump / encrypted dump / legacy sql.gz), newest first.
 * `.partial` files and `.manifest.json` sidecars never classify, so they can
 * never be listed. Each file is joined with its BackupOperation row (by
 * filename) for status/trigger/verification metadata; legacy or CLI-created
 * files without a row render as manual/unknown.
 */
export async function listBackups(page: number): Promise<BackupsPage> {
  let names: string[] = [];
  try {
    names = (await readdir(backupDir())).filter((name) => classifyBackupFileName(name) !== null);
  } catch {
    // Missing/unreadable directory = no backups visible.
    names = [];
  }
  names.sort((a, b) => b.localeCompare(a));
  const total = names.length;
  const pages = Math.max(1, Math.ceil(total / BACKUP_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const slice = names.slice((safePage - 1) * BACKUP_PAGE_SIZE, safePage * BACKUP_PAGE_SIZE);

  let operations: BackupOperation[] = [];
  if (slice.length > 0) {
    try {
      operations = await prisma.backupOperation.findMany({
        where: { filename: { in: slice } },
        orderBy: { createdAt: "desc" },
      });
    } catch (err) {
      logger.warn("backup operation join failed", { error: scrubBackupError(err) });
    }
  }
  const byFilename = new Map<string, BackupOperation>();
  for (const op of operations) {
    if (op.filename !== null && !byFilename.has(op.filename)) {
      byFilename.set(op.filename, op);
    }
  }

  const backups: BackupListEntry[] = [];
  for (const name of slice) {
    const classified = classifyBackupFileName(name);
    if (classified === null) {
      continue;
    }
    try {
      const stats = await stat(path.join(backupDir(), name));
      const operation = byFilename.get(name) ?? null;
      backups.push({
        name,
        shortId: classified.shortId,
        kind: classified.kind,
        sizeBytes: stats.size,
        createdAt: stats.mtime,
        operation,
        encrypted: operation?.encrypted ?? classified.kind === "dump-encrypted",
        verifyState: verifyStateOf(operation),
      });
    } catch {
      // Deleted between readdir and stat - skip.
    }
  }
  return { backups, page: safePage, pages, total };
}

// --- single-file resolution ------------------------------------------------------------------

/**
 * Resolves ONE backup by its timestamp short id: only directory entries that
 * classify as backup files are considered, the candidate name comes from the
 * directory itself (never from user input) and the resolved path must stay
 * inside the backup directory. Multiple kinds with the same stamp prefer
 * encrypted dump > dump > legacy.
 */
async function resolveBackupEntry(
  shortId: string,
): Promise<{ name: string; kind: BackupFileKind; filePath: string } | null> {
  if (!SHORT_ID_RE.test(shortId)) {
    return null;
  }
  let names: string[] = [];
  try {
    names = await readdir(backupDir());
  } catch {
    return null;
  }
  const kindRank: Record<BackupFileKind, number> = {
    "dump-encrypted": 0,
    dump: 1,
    "legacy-sql-gz": 2,
  };
  let best: { name: string; kind: BackupFileKind } | null = null;
  for (const name of names) {
    const classified = classifyBackupFileName(name);
    if (classified === null || classified.shortId !== shortId) {
      continue;
    }
    if (best === null || kindRank[classified.kind] < kindRank[best.kind]) {
      best = { name, kind: classified.kind };
    }
  }
  if (best === null) {
    return null;
  }
  const dir = path.resolve(backupDir());
  const filePath = path.resolve(dir, best.name);
  if (!filePath.startsWith(dir + path.sep)) {
    return null;
  }
  return { ...best, filePath };
}

/** One listed backup (file metadata + joined operation) by short id. */
export async function getBackupEntry(shortId: string): Promise<BackupListEntry | null> {
  const entry = await resolveBackupEntry(shortId);
  if (entry === null) {
    return null;
  }
  let stats;
  try {
    stats = await stat(entry.filePath);
  } catch {
    return null;
  }
  let operation: BackupOperation | null = null;
  try {
    operation = await prisma.backupOperation.findFirst({
      where: { filename: entry.name },
      orderBy: { createdAt: "desc" },
    });
  } catch (err) {
    logger.warn("backup entry operation lookup failed", { error: scrubBackupError(err) });
  }
  return {
    name: entry.name,
    shortId,
    kind: entry.kind,
    sizeBytes: stats.size,
    createdAt: stats.mtime,
    operation,
    encrypted: operation?.encrypted ?? entry.kind === "dump-encrypted",
    verifyState: verifyStateOf(operation),
  };
}

export type BackupFileOutcome =
  | { ok: true; path: string; name: string; kind: BackupFileKind; sizeBytes: number }
  | { ok: false; tooLarge: boolean; safeMessage: string };

/**
 * One backup file for download. Size-limited for Telegram; the too-large
 * outcome carries the server-path instruction text (OWNER-only display).
 */
export async function getBackupFile(
  shortId: string,
  maxBytes: number = BACKUP_MAX_TELEGRAM_BYTES,
): Promise<BackupFileOutcome> {
  const entry = await resolveBackupEntry(shortId);
  if (entry === null) {
    return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
  try {
    const stats = await stat(entry.filePath);
    if (!stats.isFile()) {
      return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        tooLarge: true,
        safeMessage: `حجم بکاپ برای ارسال در تلگرام زیاد است. از مسیر سرور دریافت کنید:\n${entry.filePath}`,
      };
    }
    return {
      ok: true,
      path: entry.filePath,
      name: entry.name,
      kind: entry.kind,
      sizeBytes: stats.size,
    };
  } catch {
    return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
}

// --- manual backup request ---------------------------------------------------------------------

const ACTIVE_STATUSES: BackupOperationStatus[] = [
  BackupOperationStatus.QUEUED,
  BackupOperationStatus.RUNNING,
  BackupOperationStatus.VERIFYING,
];

export interface ManualBackupRequest {
  op: BackupOperation;
  /** false = an active operation already existed (repeated tap). */
  created: boolean;
  /** false = Redis/queue unavailable - the operation was marked FAILED. */
  enqueued: boolean;
}

/**
 * Requests one manual database backup. NEVER runs pg_dump - it creates a
 * BackupOperation row and enqueues the CREATE job with jobId = operation id.
 * At most ONE active operation (QUEUED/RUNNING/VERIFYING) exists at a time:
 * repeated taps return the existing row (and re-enqueue idempotently - the
 * shared job id makes a duplicate job impossible). When the queue is
 * unavailable a freshly created row is closed as FAILED so it can never
 * block future requests.
 */
export async function requestManualBackup(admin: Admin): Promise<ManualBackupRequest> {
  const active = await prisma.backupOperation.findFirst({
    where: { status: { in: ACTIVE_STATUSES } },
    orderBy: { queuedAt: "desc" },
  });
  if (active !== null) {
    // Re-enqueue is a no-op while the job exists; it also self-heals an
    // operation whose first enqueue was lost with Redis down.
    const enqueued = await enqueueBackupCreate(active.id);
    return { op: active, created: false, enqueued };
  }
  const op = await prisma.backupOperation.create({
    data: {
      trigger: BackupTrigger.MANUAL,
      requestedByAdminId: admin.id,
      status: BackupOperationStatus.QUEUED,
    },
  });
  const enqueued = await enqueueBackupCreate(op.id);
  if (!enqueued) {
    const failed = await prisma.backupOperation.update({
      where: { id: op.id },
      data: { status: BackupOperationStatus.FAILED, safeErrorCode: "queue-unavailable" },
    });
    return { op: failed, created: true, enqueued: false };
  }
  return { op, created: true, enqueued: true };
}

/** One operation by 8-char short id (prefix match, ambiguity fails safe). */
export async function getBackupOperationByShortId(
  shortId: string,
): Promise<BackupOperation | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.backupOperation.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- deletion -----------------------------------------------------------------------------------

const DELETABLE_STATUSES: BackupOperationStatus[] = [
  BackupOperationStatus.COMPLETED,
  BackupOperationStatus.VERIFIED,
  BackupOperationStatus.CORRUPT,
];

export interface DeleteBackupOutcome {
  ok: boolean;
  safeMessage: string;
}

export const BACKUP_DELETED_TEXT = "فایل بکاپ حذف شد ✅";
export const BACKUP_DELETE_ACTIVE_TEXT =
  "این بکاپ به یک عملیات در حال اجرا تعلق دارد و فعلاً قابل حذف نیست.";
export const BACKUP_DELETE_FAILED_TEXT = "حذف فایل بکاپ ناموفق بود. لاگ سرور را بررسی کنید.";

/**
 * Deletes ONE backup file (+ its manifest sidecar). Caller enforces OWNER.
 * Only files with a terminal (COMPLETED/VERIFIED/CORRUPT) BackupOperation
 * row or legacy-classified names may be deleted - a file owned by an active
 * operation is refused. Writes an AuditLog row and an AUDIT ops log.
 */
export async function deleteBackup(admin: Admin, shortId: string): Promise<DeleteBackupOutcome> {
  const entry = await resolveBackupEntry(shortId);
  if (entry === null) {
    return { ok: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
  let operation: BackupOperation | null = null;
  try {
    operation = await prisma.backupOperation.findFirst({
      where: { filename: entry.name },
      orderBy: { createdAt: "desc" },
    });
  } catch (err) {
    logger.warn("backup delete operation lookup failed", { error: scrubBackupError(err) });
  }
  if (entry.kind !== "legacy-sql-gz") {
    if (operation === null) {
      return { ok: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
    }
    if (!DELETABLE_STATUSES.includes(operation.status)) {
      return { ok: false, safeMessage: BACKUP_DELETE_ACTIVE_TEXT };
    }
  }
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(entry.filePath)).size;
    await unlink(entry.filePath);
  } catch (err) {
    logger.error("backup delete failed", { name: entry.name, error: scrubBackupError(err) });
    return { ok: false, safeMessage: BACKUP_DELETE_FAILED_TEXT };
  }
  // Sidecar manifest (best effort - legacy files have none).
  await unlink(`${entry.filePath}${BACKUP_MANIFEST_SUFFIX}`).catch(() => undefined);

  try {
    await prisma.auditLog.create({
      data: {
        actorTelegramId: admin.telegramId,
        actorType: "ADMIN",
        action: "backup.deleted",
        entityType: "BackupOperation",
        entityId: operation?.id ?? null,
        metadata: { filename: entry.name, sizeBytes, adminId: admin.id },
      },
    });
  } catch (err) {
    logger.warn("backup delete audit log failed", { error: scrubBackupError(err) });
  }
  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.BACKUP_DELETED,
    message: `backup file deleted by admin`,
    metadata: { filename: entry.name, sizeBytes },
    topicKey: "AUDIT",
    adminId: admin.id,
  });
  logger.info("backup deleted", { name: entry.name, sizeBytes, adminId: admin.id });
  return { ok: true, safeMessage: BACKUP_DELETED_TEXT };
}

// --- restore help ---------------------------------------------------------------------------------

/** Manual restore commands - placeholders only, NEVER credentials. */
export function buildRestoreInstructions(): string {
  return [
    "راهنمای Restore ♻️ (اجرای دستی روی سرور)",
    "",
    "⚠️ قبل از بازیابی حتماً یک بکاپ تازه بگیرید.",
    "⚠️ بازیابی از داخل تلگرام عمداً پیاده‌سازی نشده است - فقط روی سرور اجرا کنید.",
    "",
    "# فایل‌های .dump (فرمت custom):",
    `pg_restore --clean --if-exists -d <DATABASE_URL> ${path.join(backupDir(), "<file>.dump")}`,
    "",
    "# فایل‌های .dump.enc (رمز‌شده) - ابتدا رمزگشایی:",
    `openssl enc -d -aes-256-cbc -pbkdf2 -in ${path.join(backupDir(), "<file>.dump.enc")} -out /tmp/restore.dump`,
    "pg_restore --clean --if-exists -d <DATABASE_URL> /tmp/restore.dump",
    "",
    "# فایل‌های قدیمی .sql.gz:",
    `gunzip -c ${path.join(backupDir(), "<file>.sql.gz")} | docker compose exec -T postgres psql -U <POSTGRES_USER> <POSTGRES_DB>`,
    "",
    "<DATABASE_URL> و <POSTGRES_USER>/<POSTGRES_DB> را از فایل .env سرور بردارید.",
    "رمز فایل‌های رمز‌شده همان BACKUP_ENCRYPTION_PASSWORD فایل .env است.",
  ].join("\n");
}

// --- health ------------------------------------------------------------------------------------

export interface SystemHealth {
  timestamp: Date;
  db: { ok: boolean; latencyMs: number | null };
  redis: { ok: boolean; latencyMs: number | null };
  worker: {
    alive: boolean;
    heartbeatAgeSeconds: number | null;
    queue: BackupQueueCounts | null;
  };
  backupDirectory: {
    path: string;
    botReadable: boolean;
    /** Worker-published fact; null = unknown (no capability snapshot). */
    workerWritable: boolean | null;
  };
  pgDump: {
    /** null = unknown (worker capabilities unavailable). */
    available: boolean | null;
    version: string | null;
  };
  disk: {
    ok: boolean;
    totalBytes: number | null;
    usedBytes: number | null;
    freeBytes: number | null;
    percentUsed: number | null;
    /** free space below BACKUP_MIN_FREE_DISK_MB. */
    low: boolean;
  };
  latestBackup: {
    name: string;
    createdAt: Date;
    sizeBytes: number;
    verifyState: BackupVerifyState;
    ageHours: number;
    /** older than 48h - together with `null latestBackup` drives warnings. */
    stale: boolean;
  } | null;
  encryptionEnabled: boolean;
  logGroup: {
    configured: boolean;
    /** Latest delivery outcome: true=SENT, false=FAILED/DEAD_LETTER, null=none. */
    lastDeliveryOk: boolean | null;
  };
}

export const LATEST_BACKUP_STALE_HOURS = 48;

/**
 * The health snapshot behind «وضعیت سیستم 🩺». The bot reports only ITS OWN
 * facts directly (db latency, redis ping, read access, disk stats); write
 * access to the backup directory and pg_dump presence are the WORKER's facts,
 * read from its published capability snapshot - the bot's own W_OK is
 * deliberately NOT used (its mount is read-only in production).
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  // DB: one trivial round-trip, timed.
  let db: SystemHealth["db"];
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    db = { ok: false, latencyMs: null };
  }

  const [redis, heartbeat, capabilities, queue] = await Promise.all([
    pingOpsRedis(),
    readWorkerHeartbeat(),
    readWorkerCapabilities(),
    getBackupQueueCounts(),
  ]);

  const dir = backupDir();
  let botReadable = false;
  try {
    await access(dir, constants.R_OK);
    await readdir(dir);
    botReadable = true;
  } catch {
    botReadable = false;
  }

  let disk: SystemHealth["disk"] = {
    ok: false,
    totalBytes: null,
    usedBytes: null,
    freeBytes: null,
    percentUsed: null,
    low: false,
  };
  try {
    const fsStats = await statfs(dir);
    const totalBytes = fsStats.blocks * fsStats.bsize;
    const freeBytes = fsStats.bavail * fsStats.bsize;
    const usedBytes = (fsStats.blocks - fsStats.bfree) * fsStats.bsize;
    disk = {
      ok: true,
      totalBytes,
      usedBytes,
      freeBytes,
      percentUsed: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : null,
      low: freeBytes < backupMinFreeDiskMb() * 1024 * 1024,
    };
  } catch {
    // Directory missing/unreachable - disk stays unchecked.
  }

  let latestBackup: SystemHealth["latestBackup"] = null;
  try {
    const pageData = await listBackups(1);
    const newest = pageData.backups[0];
    if (newest !== undefined) {
      const ageHours = Math.floor((Date.now() - newest.createdAt.getTime()) / 3_600_000);
      latestBackup = {
        name: newest.name,
        createdAt: newest.createdAt,
        sizeBytes: newest.sizeBytes,
        verifyState: newest.verifyState,
        ageHours,
        stale: ageHours >= LATEST_BACKUP_STALE_HOURS,
      };
    }
  } catch {
    latestBackup = null;
  }

  let lastDeliveryOk: boolean | null = null;
  let logGroupConfigured = false;
  try {
    logGroupConfigured = (await getSetting(LOG_GROUP_CHAT_ID_KEY, "")) !== "";
    const lastDelivery = await prisma.systemLogDelivery.findFirst({
      where: { status: { in: ["SENT", "FAILED", "DEAD_LETTER"] } },
      orderBy: { updatedAt: "desc" },
      select: { status: true },
    });
    if (lastDelivery !== null) {
      lastDeliveryOk = lastDelivery.status === "SENT";
    }
  } catch {
    lastDeliveryOk = null;
  }

  return {
    timestamp: new Date(),
    db,
    redis: { ok: redis.ok, latencyMs: redis.latencyMs },
    worker: {
      alive: heartbeat !== null,
      heartbeatAgeSeconds: heartbeat?.ageSeconds ?? null,
      queue,
    },
    backupDirectory: {
      path: dir,
      botReadable,
      workerWritable: capabilities === null ? null : capabilities.backupDirWritable,
    },
    pgDump: {
      available: capabilities === null ? null : capabilities.pgDumpVersion !== null,
      version: capabilities?.pgDumpVersion ?? null,
    },
    disk,
    latestBackup,
    encryptionEnabled: isBackupEncryptionEnabled(),
    logGroup: { configured: logGroupConfigured, lastDeliveryOk },
  };
}
