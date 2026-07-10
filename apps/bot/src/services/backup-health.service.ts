import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, constants, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

import { prisma } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";

// =============================================================================
// «گزارشات / بکاپ 🛡» (Phase 35) - manual database backups, retention
// cleanup and a system health check. Backups are `pg_dump | gzip` written
// ONLY inside the backup directory with strictly validated names
// (zedbot-db-YYYYMMDD-HHMMSS.sql.gz); the short id is the timestamp part,
// so no arbitrary filename/path can ever be resolved (traversal-proof by
// regex + containment check). pg_dump is spawned with the DATABASE_URL as
// an ARGUMENT (no shell, no interpolation) and the URL is never logged,
// echoed or included in any message - error strings are scrubbed
// defensively. Restore is INSTRUCTIONS ONLY - never executed from here.
// No payment/order/service row is touched.
// =============================================================================

export const BACKUP_MAX_TELEGRAM_BYTES = 45 * 1024 * 1024;
export const BACKUP_PAGE_SIZE = 10;
export const BACKUP_FILE_RE = /^zedbot-db-(\d{8}-\d{6})\.sql\.gz$/;
const SHORT_ID_RE = /^\d{8}-\d{6}$/;

export const BACKUP_FAILED_TEXT = "ساخت بکاپ ناموفق بود. لاگ سرور را بررسی کنید.";
export const BACKUP_NOT_FOUND_TEXT = "فایل بکاپ پیدا نشد.";

/** Read lazily so tests can point BACKUP_DIR at a temp directory. */
export function backupDir(): string {
  return process.env.BACKUP_DIR ?? "/opt/zedbot/backups";
}

export function backupRetentionDays(): number {
  const parsed = Number(process.env.BACKUP_RETENTION_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
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

export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_RE.test(name);
}

/** zedbot-db-20260710-183000.sql.gz -> "20260710-183000" (callback-safe). */
export function backupShortIdFromName(name: string): string | null {
  const match = BACKUP_FILE_RE.exec(name);
  return match === null ? null : match[1];
}

/** Defensive scrub: an error string must never leak the connection URL. */
function scrubError(err: unknown): string {
  let message = errorMessage(err).slice(0, 300);
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== "") {
    message = message.split(url).join("[database-url]");
  }
  return message.replace(/postgres(ql)?:\/\/\S+/gi, "[database-url]");
}

export async function ensureBackupDir(): Promise<void> {
  await mkdir(backupDir(), { recursive: true });
}

export interface BackupEntry {
  name: string;
  shortId: string;
  sizeBytes: number;
  createdAt: Date;
}

export type CreateBackupOutcome =
  | { ok: true; backup: BackupEntry }
  | { ok: false; safeMessage: string };

function backupStamp(when: Date): string {
  // YYYYMMDD-HHMMSS (UTC)
  return when.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * A stamp whose file does not exist yet - two backups inside the same
 * second must never share a name (overwriting, then failure-cleanup, would
 * otherwise destroy the earlier good file).
 */
async function freeBackupStamp(): Promise<string> {
  for (let offset = 0; offset < 60; offset++) {
    const stamp = backupStamp(new Date(Date.now() + offset * 1000));
    try {
      await stat(path.join(backupDir(), `zedbot-db-${stamp}.sql.gz`));
    } catch {
      return stamp; // no such file - name is free
    }
  }
  throw new Error("no free backup filename");
}

/** pg_dump (URL as argv, no shell) -> gzip -> file; partial files removed. */
export async function createDatabaseBackup(): Promise<CreateBackupOutcome> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    return { ok: false, safeMessage: BACKUP_FAILED_TEXT };
  }
  await ensureBackupDir().catch(() => undefined);
  let stamp: string;
  try {
    stamp = await freeBackupStamp();
  } catch (err) {
    logger.error("database backup failed", { error: scrubError(err) });
    return { ok: false, safeMessage: BACKUP_FAILED_TEXT };
  }
  const name = `zedbot-db-${stamp}.sql.gz`;
  const filePath = path.join(backupDir(), name);
  try {
    await ensureBackupDir();
    const dump = spawn("pg_dump", [databaseUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    dump.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = new Promise<number>((resolve, reject) => {
      dump.on("error", reject); // e.g. pg_dump not installed
      dump.on("close", (code) => resolve(code ?? -1));
    });
    await pipeline(dump.stdout, createGzip(), createWriteStream(filePath));
    const code = await exit;
    if (code !== 0) {
      throw new Error(`pg_dump exited with ${code}: ${stderr.slice(0, 200)}`);
    }
    const stats = await stat(filePath);
    if (stats.size <= 0) {
      throw new Error("backup file is empty");
    }
    logger.info("database backup created", { name, sizeBytes: stats.size });
    return {
      ok: true,
      backup: { name, shortId: stamp, sizeBytes: stats.size, createdAt: stats.mtime },
    };
  } catch (err) {
    logger.error("database backup failed", { name, error: scrubError(err) });
    await unlink(filePath).catch(() => undefined);
    return { ok: false, safeMessage: BACKUP_FAILED_TEXT };
  }
}

export interface BackupsPage {
  backups: BackupEntry[];
  page: number;
  pages: number;
  total: number;
}

/** Matching backup files only, newest first (timestamp names sort cleanly). */
export async function listBackups(page: number): Promise<BackupsPage> {
  let names: string[] = [];
  try {
    names = (await readdir(backupDir())).filter(isBackupFileName);
  } catch {
    // Missing directory = no backups yet.
    names = [];
  }
  names.sort((a, b) => b.localeCompare(a));
  const total = names.length;
  const pages = Math.max(1, Math.ceil(total / BACKUP_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const slice = names.slice((safePage - 1) * BACKUP_PAGE_SIZE, safePage * BACKUP_PAGE_SIZE);
  const backups: BackupEntry[] = [];
  for (const name of slice) {
    try {
      const stats = await stat(path.join(backupDir(), name));
      backups.push({
        name,
        shortId: backupShortIdFromName(name) ?? "",
        sizeBytes: stats.size,
        createdAt: stats.mtime,
      });
    } catch {
      // Deleted between readdir and stat - skip.
    }
  }
  return { backups, page: safePage, pages, total };
}

export type BackupFileOutcome =
  | { ok: true; path: string; name: string; sizeBytes: number }
  | { ok: false; tooLarge: boolean; safeMessage: string };

/**
 * Resolves ONE backup by its timestamp short id - the name is rebuilt from
 * the validated id and containment-checked, so traversal is impossible.
 */
export async function getBackupFile(
  shortId: string,
  maxBytes: number = BACKUP_MAX_TELEGRAM_BYTES,
): Promise<BackupFileOutcome> {
  if (!SHORT_ID_RE.test(shortId)) {
    return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
  const name = `zedbot-db-${shortId}.sql.gz`;
  const dir = path.resolve(backupDir());
  const filePath = path.resolve(dir, name);
  if (!filePath.startsWith(dir + path.sep)) {
    return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        tooLarge: true,
        safeMessage: `حجم بکاپ برای ارسال در تلگرام زیاد است. از مسیر سرور دریافت کنید:\n${path.join(backupDir(), name)}`,
      };
    }
    return { ok: true, path: filePath, name, sizeBytes: stats.size };
  } catch {
    return { ok: false, tooLarge: false, safeMessage: BACKUP_NOT_FOUND_TEXT };
  }
}

export interface CleanupResult {
  deletedCount: number;
  freedBytes: number;
}

/** Deletes MATCHING backups older than the retention window - nothing else. */
export async function cleanupOldBackups(
  retentionDays: number = backupRetentionDays(),
): Promise<CleanupResult> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let freedBytes = 0;
  let names: string[] = [];
  try {
    names = (await readdir(backupDir())).filter(isBackupFileName);
  } catch {
    return { deletedCount: 0, freedBytes: 0 };
  }
  for (const name of names) {
    const filePath = path.join(backupDir(), name);
    try {
      const stats = await stat(filePath);
      if (stats.mtime.getTime() < cutoff) {
        await unlink(filePath);
        deletedCount += 1;
        freedBytes += stats.size;
      }
    } catch {
      // Raced deletion - ignore.
    }
  }
  if (deletedCount > 0) {
    logger.info("old backups cleaned up", { deletedCount, freedBytes, retentionDays });
  }
  return { deletedCount, freedBytes };
}

/** Manual restore commands - placeholders only, NEVER credentials. */
export function buildRestoreInstructions(): string {
  return [
    "راهنمای Restore ♻️ (اجرای دستی روی سرور)",
    "",
    "⚠️ قبل از بازیابی حتماً یک بکاپ تازه بگیرید.",
    "⚠️ بازیابی از داخل تلگرام عمداً پیاده‌سازی نشده است - فقط روی سرور اجرا کنید.",
    "",
    "cd /opt/zedbot",
    "docker compose down",
    `cp ${path.join(backupDir(), "<file>.sql.gz")} ${path.join(backupDir(), "restore.sql.gz")}`,
    `gunzip -c ${path.join(backupDir(), "restore.sql.gz")} | docker compose exec -T postgres psql -U <POSTGRES_USER> <POSTGRES_DB>`,
    "docker compose up -d",
    "",
    "<POSTGRES_USER> و <POSTGRES_DB> را از فایل .env سرور بردارید.",
  ].join("\n");
}

// --- health ------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export interface SystemHealth {
  timestamp: Date;
  db: { ok: boolean; latencyMs: number | null; error: string | null };
  redis: { checked: boolean; reason: string };
  backupDirectory: { path: string; exists: boolean; writable: boolean };
  disk: { checked: boolean; totalKb?: number; usedKb?: number; availableKb?: number; usePercent?: string };
  node: {
    version: string;
    uptimeSeconds: number;
    pid: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
  appVersion: string | null;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  // DB: one trivial round-trip, timed.
  let db: SystemHealth["db"];
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = { ok: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    db = { ok: false, latencyMs: null, error: scrubError(err).slice(0, 120) };
  }

  // Redis: the queue lives in apps/worker (bullmq); the bot has no redis
  // client, and adding one just for a ping is not worth it (documented).
  const redisConfigured =
    (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
  const redis = {
    checked: false,
    reason: redisConfigured
      ? "صف در سرویس worker است؛ از ربات بررسی نمی‌شود."
      : "Redis پیکربندی نشده است.",
  };

  // Backup directory: existence + writability, without mutating anything.
  const dir = backupDir();
  let exists = false;
  let writable = false;
  try {
    exists = (await stat(dir)).isDirectory();
    await access(dir, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  // Disk usage for the backup dir's filesystem (best effort).
  let disk: SystemHealth["disk"] = { checked: false };
  try {
    const target = exists ? dir : path.dirname(dir);
    const { stdout } = await execFileAsync("df", ["-k", target]);
    const line = stdout.trim().split("\n").at(-1);
    const cols = line?.split(/\s+/) ?? [];
    if (cols.length >= 5) {
      disk = {
        checked: true,
        totalKb: Number(cols[1]),
        usedKb: Number(cols[2]),
        availableKb: Number(cols[3]),
        usePercent: cols[4],
      };
    }
  } catch {
    disk = { checked: false };
  }

  const memory = process.memoryUsage();
  return {
    timestamp: new Date(),
    db,
    redis,
    backupDirectory: { path: dir, exists, writable },
    disk,
    node: {
      version: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    appVersion: process.env.APP_VERSION ?? process.env.GIT_SHA ?? null,
  };
}
