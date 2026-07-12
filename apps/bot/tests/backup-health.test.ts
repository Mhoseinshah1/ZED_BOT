import { spawnSync } from "node:child_process";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase35-test-secret-phase35-test-secret";

import { prisma } from "@zedbot/database";

import {
  backupShortIdFromName,
  buildRestoreInstructions,
  cleanupOldBackups,
  createDatabaseBackup,
  formatBytes,
  getBackupFile,
  getSystemHealth,
  isBackupFileName,
  listBackups,
  pgDumpSafeUrl,
} from "../src/services/backup-health.service.js";

// =============================================================================
// Phase 35 backup/health. All file operations run in a per-run TEMP backup
// directory (BACKUP_DIR env) - /opt/zedbot/backups is never touched. The
// real pg_dump round-trip runs only where pg_dump is installed.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasPgDump = spawnSync("pg_dump", ["--version"]).status === 0;

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const tempDir = path.join(os.tmpdir(), `zedbot-backup-test-${runTag}`);

async function writeBackupFile(name: string, content = "data", ageDays = 0): Promise<void> {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, content);
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await utimes(filePath, when, when);
  }
}

describe("backup/health file layer (Phase 35)", () => {
  beforeAll(async () => {
    process.env.BACKUP_DIR = tempDir;
    await mkdir(tempDir, { recursive: true });
  });

  it("accepts only the expected backup filename pattern", () => {
    expect(isBackupFileName("zedbot-db-20260710-183000.sql.gz")).toBe(true);
    expect(backupShortIdFromName("zedbot-db-20260710-183000.sql.gz")).toBe("20260710-183000");
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

  it("lists only matching files, newest first, paginated", async () => {
    await writeBackupFile("zedbot-db-20260101-000000.sql.gz");
    await writeBackupFile("zedbot-db-20260301-120000.sql.gz");
    await writeBackupFile("zedbot-db-20260201-060000.sql.gz");
    await writeBackupFile("junk.txt");
    await writeBackupFile("zedbot-db-junk.sql.gz");

    const page = await listBackups(1);
    const names = page.backups.map((backup) => backup.name);
    expect(names).toEqual([
      "zedbot-db-20260301-120000.sql.gz",
      "zedbot-db-20260201-060000.sql.gz",
      "zedbot-db-20260101-000000.sql.gz",
    ]);
    expect(page.total).toBe(3);
    expect((await listBackups(999)).page).toBe(1);
  });

  it("resolves files safely: traversal, garbage and unknown ids refused; too-large flagged", async () => {
    await writeBackupFile("zedbot-db-20260401-090000.sql.gz", "0123456789");

    const ok = await getBackupFile("20260401-090000");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.name).toBe("zedbot-db-20260401-090000.sql.gz");
    expect(ok.sizeBytes).toBe(10);
    expect(ok.path.startsWith(path.resolve(tempDir))).toBe(true);

    for (const bad of ["../../etc/passwd", "20260401-09000x", "zzzz", "", "99999999-999999"]) {
      const refused = await getBackupFile(bad);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.tooLarge).toBe(false);
    }

    const tooLarge = await getBackupFile("20260401-090000", 5);
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) return;
    expect(tooLarge.tooLarge).toBe(true);
    expect(tooLarge.safeMessage).toContain(tempDir);
  });

  it("cleanup deletes only OLD MATCHING backups", async () => {
    await writeBackupFile("zedbot-db-20250101-000000.sql.gz", "old", 30);
    await writeBackupFile("old-junk.txt", "junk", 30);
    const freshName = "zedbot-db-20260501-000000.sql.gz";
    await writeBackupFile(freshName, "fresh");

    const result = await cleanupOldBackups(7);
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);
    expect(result.freedBytes).toBeGreaterThan(0);

    const remaining = await readdir(tempDir);
    expect(remaining).not.toContain("zedbot-db-20250101-000000.sql.gz");
    expect(remaining).toContain("old-junk.txt"); // non-matching never deleted
    expect(remaining).toContain(freshName); // fresh backup kept
  });

  it("restore instructions carry placeholders, never the DATABASE_URL", () => {
    const instructions = buildRestoreInstructions();
    expect(instructions).toContain("<POSTGRES_USER>");
    expect(instructions).toContain("<POSTGRES_DB>");
    expect(instructions).toContain("docker compose");
    expect(instructions).toContain("بکاپ تازه");
    const url = process.env.DATABASE_URL;
    if (typeof url === "string" && url !== "") {
      expect(instructions).not.toContain(url);
    }
    expect(instructions).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("formats byte sizes readably", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(13_002_342)).toBe("12.4 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe.runIf(hasDb)("system health (Phase 35)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports a healthy database with latency and a writable backup dir", async () => {
    const health = await getSystemHealth();
    expect(health.db.ok).toBe(true);
    expect(health.db.latencyMs).not.toBeNull();
    expect(health.db.error).toBeNull();
    expect(health.redis.checked).toBe(false);
    expect(health.backupDirectory.path).toBe(tempDir);
    expect(health.backupDirectory.exists).toBe(true);
    expect(health.backupDirectory.writable).toBe(true);
    expect(health.node.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.node.rssBytes).toBeGreaterThan(0);
  });
});

describe("pg_dump URL sanitizing", () => {
  it("strips Prisma-only query parameters that libpq rejects", () => {
    // The exact CI shape that made pg_dump fail with
    // `invalid URI query parameter: "schema"`.
    expect(pgDumpSafeUrl("postgresql://u:p@localhost:5432/db?schema=public")).toBe(
      "postgresql://u:p@localhost:5432/db",
    );
    expect(
      pgDumpSafeUrl(
        "postgresql://u:p@localhost:5432/db?schema=public&connection_limit=5&pool_timeout=10&pgbouncer=true",
      ),
    ).toBe("postgresql://u:p@localhost:5432/db");
  });

  it("keeps libpq-valid parameters and URLs without a query untouched", () => {
    expect(
      pgDumpSafeUrl("postgresql://u:p@db.example.com:5432/db?sslmode=require&schema=public&connect_timeout=10"),
    ).toBe("postgresql://u:p@db.example.com:5432/db?sslmode=require&connect_timeout=10");
    expect(pgDumpSafeUrl("postgresql://u:p@localhost:5432/db")).toBe(
      "postgresql://u:p@localhost:5432/db",
    );
  });

  it("passes unparseable input through unchanged (pg_dump reports its own error)", () => {
    expect(pgDumpSafeUrl("not a url")).toBe("not a url");
  });
});

describe.runIf(hasDb && hasPgDump)("pg_dump backup round-trip (Phase 35)", () => {
  it("creates a real non-empty gzip backup that lists with a short id", async () => {
    const outcome = await createDatabaseBackup();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isBackupFileName(outcome.backup.name)).toBe(true);
    expect(outcome.backup.sizeBytes).toBeGreaterThan(0);
    const stats = await stat(path.join(tempDir, outcome.backup.name));
    expect(stats.size).toBe(outcome.backup.sizeBytes);
    const page = await listBackups(1);
    expect(page.backups.some((backup) => backup.name === outcome.backup.name)).toBe(true);
  });

  it("creates a backup when DATABASE_URL carries Prisma-only query parameters", async () => {
    // Reproduces the CI connection string shape (?schema=public&...) that
    // libpq rejected before the fix.
    const original = process.env.DATABASE_URL ?? "";
    const separator = original.includes("?") ? "&" : "?";
    process.env.DATABASE_URL = `${original}${separator}schema=public&connection_limit=5`;
    try {
      const outcome = await createDatabaseBackup();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.backup.sizeBytes).toBeGreaterThan(0);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it("fails safely on an unreachable DATABASE_URL and removes the partial file", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://postgres@127.0.0.1:59999/nope";
    try {
      const before = (await readdir(tempDir)).filter(isBackupFileName).length;
      const outcome = await createDatabaseBackup();
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.safeMessage).not.toContain("59999");
      const after = (await readdir(tempDir)).filter(isBackupFileName).length;
      expect(after).toBe(before); // partial file deleted
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it("concurrent backups claim distinct files and both succeed", async () => {
    // Reproduces the same-second stamp race: before the exclusive-create
    // claim, both calls could pick one name, interleave two pg_dump streams
    // into one corrupt file, and the loser's cleanup could delete the
    // winner's output.
    const [a, b] = await Promise.all([createDatabaseBackup(), createDatabaseBackup()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.backup.name).not.toBe(b.backup.name); // NEVER the same file
    const [statsA, statsB] = await Promise.all([
      stat(path.join(tempDir, a.backup.name)),
      stat(path.join(tempDir, b.backup.name)),
    ]);
    expect(statsA.size).toBeGreaterThan(0);
    expect(statsB.size).toBeGreaterThan(0);
  });

  it("kills a hung pg_dump via the watchdog and removes the partial file", async () => {
    // A TCP listener that accepts and never answers: pg_dump connects and
    // waits for the server greeting forever - the pre-fix code had no
    // timeout, so the admin action would hang and orphan the child process.
    const server = net.createServer(() => {
      /* accept and stay silent */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const originalUrl = process.env.DATABASE_URL;
    const originalTimeout = process.env.BACKUP_TIMEOUT_MS;
    process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/nope`;
    process.env.BACKUP_TIMEOUT_MS = "1500";
    try {
      const before = (await readdir(tempDir)).filter(isBackupFileName).length;
      const startedAt = Date.now();
      const outcome = await createDatabaseBackup();
      expect(outcome.ok).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(30_000); // no infinite hang
      const after = (await readdir(tempDir)).filter(isBackupFileName).length;
      expect(after).toBe(before); // partial file deleted
    } finally {
      process.env.DATABASE_URL = originalUrl;
      if (originalTimeout === undefined) {
        delete process.env.BACKUP_TIMEOUT_MS;
      } else {
        process.env.BACKUP_TIMEOUT_MS = originalTimeout;
      }
      server.close();
    }
  });
});

describe.skipIf(hasDb)("backup/health (skipped)", () => {
  it("health/backup integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
