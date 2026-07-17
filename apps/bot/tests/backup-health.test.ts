import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "backup-health-tests-secret-0001";

import {
  BackupOperationStatus,
  BackupTrigger,
  prisma,
  type Admin,
} from "@zedbot/database";
import {
  BACKUP_QUEUE_NAME,
  getRedisOptions,
  WORKER_CAPABILITIES_KEY,
  WORKER_HEARTBEAT_KEY,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  BACKUP_DELETE_ACTIVE_TEXT,
  BACKUP_DELETED_TEXT,
  BACKUP_NOT_FOUND_TEXT,
  BACKUP_PAGE_SIZE,
  backupShortIdFromName,
  buildRestoreInstructions,
  deleteBackup,
  formatBytes,
  getBackupFile,
  getSystemHealth,
  isBackupFileName,
  listBackups,
  requestManualBackup,
} from "../src/services/backup-health.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";

// =============================================================================
// Production-backup rework: the bot NEVER runs pg_dump anymore - it only
// lists/serves backup files from BACKUP_DIR, requests backups by creating a
// BackupOperation row + enqueueing a BullMQ job (worker executes it), deletes
// terminal backups and reports system health (redis ping, worker heartbeat /
// capability snapshot, statfs disk stats). All file operations run in a
// per-run TEMP backup directory - the real backup dir is never touched.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const tempDir = path.join(os.tmpdir(), `zedbot-backup-test-${runTag}`);
// backupDir() reads BACKUP_DIR lazily on every call, so pointing it at the
// temp directory before any test body runs is sufficient (old-suite pattern).
process.env.BACKUP_DIR = tempDir;

// Per-run unique stamps (8+6 digits): repeated/crashed runs can never leave
// BackupOperation rows behind that would join onto THIS run's filenames.
const stampBase = 90_000_000 + Math.floor(Math.random() * 9_000_000);
function stamp(n: number): string {
  return `${stampBase + n}-120000`;
}

async function writeBackupFile(name: string, content = "data"): Promise<void> {
  await writeFile(path.join(tempDir, name), content);
}

async function fileExists(name: string): Promise<boolean> {
  try {
    await stat(path.join(tempDir, name));
    return true;
  } catch {
    return false;
  }
}

/** bigint-safe stringify used to scan health output for leaked secrets. */
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === "bigint" ? val.toString() : val,
  );
}

beforeAll(async () => {
  await mkdir(tempDir, { recursive: true });
});

describe("backup file layer (bot surface)", () => {
  it("keeps the legacy filename helpers and page size", () => {
    expect(BACKUP_PAGE_SIZE).toBe(10);
    expect(isBackupFileName("zedbot-db-20260710-183000.sql.gz")).toBe(true);
    expect(backupShortIdFromName("zedbot-db-20260710-183000.sql.gz")).toBe("20260710-183000");
    // The new bot surface also classifies dump/enc names for callbacks.
    expect(backupShortIdFromName("zedbot-db-20260710-183000.dump")).toBe("20260710-183000");
    expect(backupShortIdFromName("zedbot-db-20260710-183000.dump.enc")).toBe("20260710-183000");
    for (const bad of [
      "zedbot-db-20260710-183000.sql",
      "zedbot-db-2026071-183000.sql.gz",
      "other-db-20260710-183000.sql.gz",
      "zedbot-db-20260710-183000.sql.gz.bak",
      "../../etc/passwd",
      "notes.txt",
    ]) {
      expect(isBackupFileName(bad)).toBe(false);
      expect(backupShortIdFromName(bad)).toBeNull();
    }
  });

  it("formats byte sizes readably", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(13_002_342)).toBe("12.4 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("lists only real backups newest-first; partial and manifest files never appear", async () => {
    const legacyName = `zedbot-db-${stamp(1)}.sql.gz`;
    const dumpName = `zedbot-db-${stamp(2)}.dump`;
    const encName = `zedbot-db-${stamp(3)}.dump.enc`;
    await writeBackupFile(legacyName, "legacy-gzip-bytes");
    await writeBackupFile(dumpName, "PGDMP-fake-dump-bytes");
    await writeBackupFile(encName, "ZBK1-fake-envelope-bytes");
    await writeBackupFile(`zedbot-db-${stamp(4)}.dump.partial`, "in-flight");
    await writeBackupFile(`${dumpName}.manifest.json`, "{}");
    await writeBackupFile("junk.txt", "junk");

    const page = await listBackups(1);
    expect(page.backups.map((b) => b.name)).toEqual([encName, dumpName, legacyName]);
    expect(page.total).toBe(3);
    expect(page.backups.map((b) => b.kind)).toEqual(["dump-encrypted", "dump", "legacy-sql-gz"]);
    // No BackupOperation rows exist for these files: encrypted falls back to
    // the classified kind and verification state is unknown.
    expect(page.backups[0].encrypted).toBe(true);
    expect(page.backups[1].encrypted).toBe(false);
    expect(page.backups.every((b) => b.operation === null)).toBe(true);
    expect(page.backups.every((b) => b.verifyState === "unknown")).toBe(true);
    expect(page.backups.every((b) => b.sizeBytes > 0)).toBe(true);
    // Page clamping.
    expect((await listBackups(999)).page).toBe(1);
    expect((await listBackups(-5)).page).toBe(1);
  });

  it("serves one backup file by short id, containment-checked", async () => {
    const name = `zedbot-db-${stamp(5)}.dump`;
    await writeBackupFile(name, "0123456789");
    const ok = await getBackupFile(stamp(5));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.name).toBe(name);
    expect(ok.kind).toBe("dump");
    expect(ok.sizeBytes).toBe(10);
    expect(ok.path.startsWith(path.resolve(tempDir) + path.sep)).toBe(true);
  });

  it("refuses traversal, garbage and unknown short ids", async () => {
    for (const bad of ["../../etc/passwd", "20260401-09000x", "zzzz", "", "99999999-999999"]) {
      const refused = await getBackupFile(bad);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.tooLarge).toBe(false);
      expect(refused.safeMessage).toBe(BACKUP_NOT_FOUND_TEXT);
    }
  });

  it("flags too-large files with the server-path instruction", async () => {
    const tooLarge = await getBackupFile(stamp(5), 5);
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) return;
    expect(tooLarge.tooLarge).toBe(true);
    expect(tooLarge.safeMessage).toContain(tempDir);
  });

  it("prefers the encrypted dump when both kinds share a stamp", async () => {
    await writeBackupFile(`zedbot-db-${stamp(6)}.dump`, "plain");
    await writeBackupFile(`zedbot-db-${stamp(6)}.dump.enc`, "encrypted");
    const outcome = await getBackupFile(stamp(6));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.name).toBe(`zedbot-db-${stamp(6)}.dump.enc`);
    expect(outcome.kind).toBe("dump-encrypted");
  });

  it("restore instructions carry placeholders, never the DATABASE_URL", () => {
    const instructions = buildRestoreInstructions();
    expect(instructions).toContain("<POSTGRES_USER>");
    expect(instructions).toContain("<POSTGRES_DB>");
    expect(instructions).toContain("<DATABASE_URL>");
    expect(instructions).toContain("بکاپ تازه");
    const url = process.env.DATABASE_URL;
    if (typeof url === "string" && url !== "") {
      expect(instructions).not.toContain(url);
    }
    expect(instructions).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe.runIf(hasDb)("backup deletion", () => {
  let admin: Admin;
  const createdOpIds: string[] = [];

  beforeAll(async () => {
    admin = await prisma.admin.create({
      data: { telegramId: BigInt(Date.now()) * 1000n + 777n, role: "OWNER", isActive: true },
    });
  });

  afterAll(async () => {
    if (createdOpIds.length > 0) {
      await prisma.backupOperation.deleteMany({ where: { id: { in: createdOpIds } } });
    }
    await prisma.admin.deleteMany({ where: { id: admin.id } });
  });

  it("deletes a VERIFIED dump plus its manifest and writes an AuditLog row", async () => {
    const name = `zedbot-db-${stamp(7)}.dump`;
    await writeBackupFile(name, "PGDMP-deletable");
    await writeBackupFile(`${name}.manifest.json`, JSON.stringify({ filename: name }));
    const op = await prisma.backupOperation.create({
      data: { trigger: BackupTrigger.MANUAL, status: BackupOperationStatus.VERIFIED, filename: name },
    });
    createdOpIds.push(op.id);

    const outcome = await deleteBackup(admin, stamp(7));
    expect(outcome.ok).toBe(true);
    expect(outcome.safeMessage).toBe(BACKUP_DELETED_TEXT);
    expect(await fileExists(name)).toBe(false);
    expect(await fileExists(`${name}.manifest.json`)).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "backup.deleted", entityId: op.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorTelegramId).toBe(admin.telegramId);
    expect((audit?.metadata as { filename?: string }).filename).toBe(name);
  });

  it("refuses files owned by an active operation and dumps without any operation row", async () => {
    // Active operation - refused, file stays.
    const activeName = `zedbot-db-${stamp(8)}.dump`;
    await writeBackupFile(activeName, "PGDMP-active");
    const activeOp = await prisma.backupOperation.create({
      data: {
        trigger: BackupTrigger.MANUAL,
        status: BackupOperationStatus.RUNNING,
        filename: activeName,
      },
    });
    createdOpIds.push(activeOp.id);
    const refusedActive = await deleteBackup(admin, stamp(8));
    expect(refusedActive.ok).toBe(false);
    expect(refusedActive.safeMessage).toBe(BACKUP_DELETE_ACTIVE_TEXT);
    expect(await fileExists(activeName)).toBe(true);
    // Neutralize the RUNNING row so it can never block requestManualBackup.
    await prisma.backupOperation.update({
      where: { id: activeOp.id },
      data: { status: BackupOperationStatus.CANCELLED },
    });

    // Dump with NO operation row - unknown provenance, refused.
    const orphanName = `zedbot-db-${stamp(9)}.dump`;
    await writeBackupFile(orphanName, "PGDMP-orphan");
    const refusedOrphan = await deleteBackup(admin, stamp(9));
    expect(refusedOrphan.ok).toBe(false);
    expect(refusedOrphan.safeMessage).toBe(BACKUP_NOT_FOUND_TEXT);
    expect(await fileExists(orphanName)).toBe(true);

    // Traversal / unknown ids fail safe.
    for (const bad of ["../../etc/passwd", "99999999-999999", ""]) {
      const refused = await deleteBackup(admin, bad);
      expect(refused.ok).toBe(false);
      expect(refused.safeMessage).toBe(BACKUP_NOT_FOUND_TEXT);
    }
  });

  it("deletes legacy .sql.gz files even without an operation row", async () => {
    const legacyName = `zedbot-db-${stamp(10)}.sql.gz`;
    await writeBackupFile(legacyName, "legacy-bytes");
    const outcome = await deleteBackup(admin, stamp(10));
    expect(outcome.ok).toBe(true);
    expect(await fileExists(legacyName)).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "backup.deleted", metadata: { path: ["filename"], equals: legacyName } },
    });
    expect(audit).not.toBeNull();
    expect(audit?.entityId).toBeNull();
  });
});

describe.runIf(hasDb && hasRedis)("manual backup requests", () => {
  let admin: Admin;
  const createdOpIds: string[] = [];

  beforeAll(async () => {
    admin = await prisma.admin.create({
      data: { telegramId: BigInt(Date.now()) * 1000n + 778n, role: "OWNER", isActive: true },
    });
    // A crashed earlier run may have left active operations behind - the
    // one-active-op guard would then return those instead of creating ours.
    await prisma.backupOperation.updateMany({
      where: {
        status: {
          in: [
            BackupOperationStatus.QUEUED,
            BackupOperationStatus.RUNNING,
            BackupOperationStatus.VERIFYING,
          ],
        },
      },
      data: { status: BackupOperationStatus.CANCELLED },
    });
  });

  afterAll(async () => {
    if (createdOpIds.length > 0) {
      await prisma.backupOperation.deleteMany({ where: { id: { in: createdOpIds } } });
    }
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    // Remove the enqueued CREATE jobs from the shared test Redis.
    const options = getRedisOptions();
    if (options !== null) {
      const queue = new Queue(BACKUP_QUEUE_NAME, {
        connection: { ...options, maxRetriesPerRequest: null },
      });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await resetOpsQueueForTests();
  });

  it("creates ONE MANUAL operation; a repeated tap returns the same active op", async () => {
    const first = await requestManualBackup(admin);
    createdOpIds.push(first.op.id);
    expect(first.created).toBe(true);
    expect(first.enqueued).toBe(true);
    expect(first.op.trigger).toBe(BackupTrigger.MANUAL);
    expect(first.op.status).toBe(BackupOperationStatus.QUEUED);
    expect(first.op.requestedByAdminId).toBe(admin.id);

    const second = await requestManualBackup(admin);
    expect(second.created).toBe(false);
    expect(second.op.id).toBe(first.op.id);
    expect(second.enqueued).toBe(true); // re-enqueue is a no-op on the same job id

    const activeCount = await prisma.backupOperation.count({
      where: {
        status: {
          in: [
            BackupOperationStatus.QUEUED,
            BackupOperationStatus.RUNNING,
            BackupOperationStatus.VERIFYING,
          ],
        },
      },
    });
    expect(activeCount).toBe(1);
  });
});

describe.runIf(hasDb && hasRedis)("system health", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? "");
  });

  afterAll(async () => {
    await redis.del(WORKER_HEARTBEAT_KEY, WORKER_CAPABILITIES_KEY).catch(() => undefined);
    redis.disconnect();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("reports db+redis healthy and the worker offline while no heartbeat exists", async () => {
    await redis.del(WORKER_HEARTBEAT_KEY, WORKER_CAPABILITIES_KEY);
    const health = await getSystemHealth();
    expect(health.db.ok).toBe(true);
    expect(health.db.latencyMs).not.toBeNull();
    expect(health.redis.ok).toBe(true);
    expect(health.redis.latencyMs).not.toBeNull();
    expect(health.worker.alive).toBe(false);
    expect(health.worker.heartbeatAgeSeconds).toBeNull();
    // Worker facts are unknown (null), never guessed from the bot container.
    expect(health.pgDump.available).toBeNull();
    expect(health.pgDump.version).toBeNull();
    expect(health.backupDirectory.workerWritable).toBeNull();
    expect(health.backupDirectory.path).toBe(tempDir);
    expect(health.backupDirectory.botReadable).toBe(true);
    // statfs on the temp dir succeeded.
    expect(health.disk.ok).toBe(true);
    expect(health.disk.totalBytes ?? 0).toBeGreaterThan(0);
    expect(health.disk.freeBytes).not.toBeNull();
  });

  it("surfaces the worker heartbeat + capability snapshot and never leaks raw URLs", async () => {
    await redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), "EX", 45);
    await redis.set(
      WORKER_CAPABILITIES_KEY,
      JSON.stringify({
        pgDumpVersion: "pg_dump (PostgreSQL) 16.4",
        backupDirWritable: true,
        backupDir: tempDir,
        checkedAt: new Date().toISOString(),
      }),
      "EX",
      45,
    );

    const health = await getSystemHealth();
    expect(health.worker.alive).toBe(true);
    expect(health.worker.heartbeatAgeSeconds).not.toBeNull();
    expect(health.worker.heartbeatAgeSeconds ?? -1).toBeGreaterThanOrEqual(0);
    expect(health.worker.queue).not.toBeNull();
    expect(health.pgDump.available).toBe(true);
    expect(health.pgDump.version).toBe("pg_dump (PostgreSQL) 16.4");
    expect(health.backupDirectory.workerWritable).toBe(true);
    expect(health.disk.ok).toBe(true);

    // NOTHING in the health snapshot may carry a raw connection URL.
    const serialized = safeStringify(health);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/redis:\/\//i);
    const url = process.env.DATABASE_URL;
    if (typeof url === "string" && url !== "") {
      expect(serialized).not.toContain(url);
    }
  });
});

describe.skipIf(hasDb)("backup surface (skipped)", () => {
  it("backup/deletion integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});

describe.skipIf(hasDb && hasRedis)("manual backup + health (skipped)", () => {
  it("manual-backup/health tests require DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDb && hasRedis).toBe(false);
  });
});
