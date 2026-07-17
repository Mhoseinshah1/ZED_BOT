import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { ActorType, BackupOperationStatus, SystemLogLevel, prisma } from "@zedbot/database";
import { classifyBackupFileName, createLogger, errorMessage } from "@zedbot/shared";

import { backupDir, backupMinRetained, backupRetentionDays } from "../config.js";
import { writeOpsLog } from "../ops-log.js";
import { manifestPath, unlinkQuiet } from "./files.js";

// =============================================================================
// Retention cleanup over the new .dump[.enc] backups only - legacy
// .sql.gz files are recognized but deliberately exempt (never deleted).
// Hard safety rules: only names classifyBackupFileName recognizes are ever
// touched (so .partial files, manifests and foreign files are untouchable),
// the newest file survives unconditionally, the newest VERIFIED operation's
// file survives, and the newest BACKUP_MIN_RETAINED files survive regardless
// of age. A deleted backup takes its sidecar manifest with it.
// =============================================================================

const logger = createLogger("worker:backup-cleanup");

export interface CleanupResult {
  scanned: number;
  deleted: number;
  retained: number;
  freedBytes: number;
}

interface BackupEntry {
  name: string;
  shortId: string;
  sizeBytes: number;
  mtimeMs: number;
}

export async function runBackupCleanup(): Promise<CleanupResult> {
  const dir = backupDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    logger.warn("cleanup: cannot read backup dir", { error: errorMessage(err) });
    return { scanned: 0, deleted: 0, retained: 0, freedBytes: 0 };
  }

  const entries: BackupEntry[] = [];
  for (const name of names) {
    const classified = classifyBackupFileName(name);
    if (classified === null) {
      continue; // .partial, manifests, unknown files: NEVER candidates.
    }
    if (classified.kind === "legacy-sql-gz") {
      // Task rule: existing legacy backups are never deleted or renamed
      // automatically. Only the operator-run CLI legacy retention (which
      // predates this worker) may prune them.
      continue;
    }
    try {
      const stats = await stat(path.join(dir, name));
      if (!stats.isFile()) {
        continue;
      }
      entries.push({
        name,
        shortId: classified.shortId,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // Raced deletion or unreadable entry - skip it.
    }
  }

  // Newest first. The embedded UTC stamp sorts lexicographically; mtime is
  // the tie-breaker for identical stamps across kinds.
  entries.sort((a, b) => b.shortId.localeCompare(a.shortId) || b.mtimeMs - a.mtimeMs);

  const protectedNames = new Set<string>();
  if (entries.length > 0) {
    protectedNames.add(entries[0].name); // The newest backup always survives.
  }
  const newestVerified = await prisma.backupOperation.findFirst({
    where: { status: BackupOperationStatus.VERIFIED, filename: { not: null } },
    orderBy: { verifiedAt: "desc" },
    select: { filename: true },
  });
  if (newestVerified?.filename != null) {
    protectedNames.add(newestVerified.filename);
  }

  const minRetained = backupMinRetained();
  const cutoffMs = Date.now() - backupRetentionDays() * 24 * 3600 * 1000;

  let deleted = 0;
  let freedBytes = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (i < minRetained || protectedNames.has(entry.name) || entry.mtimeMs >= cutoffMs) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    try {
      await unlinkQuiet(filePath);
      await unlinkQuiet(manifestPath(filePath)); // The manifest travels with its backup.
      deleted += 1;
      freedBytes += entry.sizeBytes;
    } catch (err) {
      logger.warn("cleanup: failed to delete backup", { error: errorMessage(err) });
    }
  }

  const result: CleanupResult = {
    scanned: entries.length,
    deleted,
    retained: entries.length - deleted,
    freedBytes,
  };

  await writeOpsLog({
    level: SystemLogLevel.INFO,
    topicKey: "BACKUP",
    eventType: "backup_cleanup",
    message: `پاکسازی بکاپ‌های قدیمی انجام شد (${deleted} فایل حذف شد)`,
    metadata: { ...result, retentionDays: backupRetentionDays(), minRetained },
  });
  try {
    await prisma.auditLog.create({
      data: {
        actorType: ActorType.SYSTEM,
        action: "backup_cleanup",
        entityType: "BackupOperation",
        metadata: { ...result, retentionDays: backupRetentionDays(), minRetained },
      },
    });
  } catch (err) {
    logger.warn("cleanup: failed to write audit log", { error: errorMessage(err) });
  }
  return result;
}
