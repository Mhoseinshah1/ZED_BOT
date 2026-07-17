import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "ops-pipeline-tests-secret-0001";

import { BackupOperationStatus, prisma } from "@zedbot/database";
import {
  BACKUP_QUEUE_NAME,
  getRedisOptions,
  LOG_DELIVERY_QUEUE_NAME,
} from "@zedbot/shared";
import { Queue } from "bullmq";

import { listBackups } from "../src/services/backup-health.service.js";

// =============================================================================
// End-to-end worker backup pipeline through the REAL CLIs (the exact same
// entrypoints deploy scripts use): create-backup produces a verified custom
// format dump (optionally ZBK1-encrypted) + manifest sidecar + BackupOperation
// row, verify-backup structurally validates files, and the BOT's listBackups
// sees the very same files (shared-directory proof). Everything runs against
// a per-run temp BACKUP_DIR; spawned output is asserted secret-free.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasPgDump =
  spawnSync("pg_dump", ["--version"]).status === 0 &&
  spawnSync("pg_restore", ["--version"]).status === 0;
const hasDeps = hasDb && hasRedis && hasPgDump;

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const tempDir = path.join(os.tmpdir(), `zedbot-ops-pipeline-${runTag}`);
// The bot service reads BACKUP_DIR lazily; point it at the same directory the
// spawned CLIs write into.
process.env.BACKUP_DIR = tempDir;

const workerDist = fileURLToPath(new URL("../../worker/dist", import.meta.url));
const createBackupCli = path.join(workerDist, "cli/create-backup.js");
const verifyBackupCli = path.join(workerDist, "cli/verify-backup.js");

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Every spawn's combined output, swept for secrets at the end. */
const spawnOutputs: { label: string; text: string }[] = [];

function runCli(label: string, script: string, args: string[], extraEnv: Record<string, string>): CliRun {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    BACKUP_DIR: tempDir,
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
    timeout: 150_000,
    killSignal: "SIGKILL",
  });
  const run = { status: result.status, stdout: result.stdout, stderr: result.stderr };
  spawnOutputs.push({ label, text: `${run.stdout}\n${run.stderr}` });
  return run;
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const dbEnv = (): Record<string, string> => ({
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  ...(process.env.REDIS_URL === undefined ? {} : { REDIS_URL: process.env.REDIS_URL }),
});

const ENCRYPTION_PASSWORD = "test-pass-123";
const legacyName = "zedbot-db-20200101-000000.sql.gz";

let plainName = "";
let encName = "";

describe.runIf(hasDeps)("ops backup pipeline (worker CLI + bot listing)", () => {
  beforeAll(async () => {
    await mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    const filenames = [plainName, encName].filter((name) => name !== "");
    if (filenames.length > 0) {
      await prisma.backupOperation.deleteMany({ where: { filename: { in: filenames } } });
    }
    const options = getRedisOptions();
    if (options !== null) {
      for (const name of [BACKUP_QUEUE_NAME, LOG_DELIVERY_QUEUE_NAME]) {
        const queue = new Queue(name, { connection: { ...options, maxRetriesPerRequest: null } });
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it(
    "create-backup CLI produces a verified PGDMP dump, manifest and VERIFIED operation row",
    async () => {
      const run = runCli("create-plain", createBackupCli, ["--trigger", "MANUAL"], dbEnv());
      expect(run.status).toBe(0);
      const result = lastJsonLine(run.stdout);
      expect(result.ok).toBe(true);
      expect(result.verified).toBe(true);
      expect(typeof result.filename).toBe("string");
      plainName = result.filename as string;
      expect(plainName).toMatch(/^zedbot-db-\d{8}-\d{6}\.dump$/);

      // File: non-empty custom-format dump starting with the PGDMP magic.
      const filePath = path.join(tempDir, plainName);
      const stats = await stat(filePath);
      expect(stats.size).toBeGreaterThan(0);
      const head = (await readFile(filePath)).subarray(0, 5).toString("ascii");
      expect(head).toBe("PGDMP");

      // Checksum chain: file bytes === manifest.sha256 === operation row.
      const digest = await sha256(filePath);
      const manifestRaw = await readFile(`${filePath}.manifest.json`, "utf8");
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      expect(manifest.filename).toBe(plainName);
      expect(manifest.sha256).toBe(digest);
      expect(manifest.sizeBytes).toBe(stats.size);
      expect(manifest.encrypted).toBe(false);
      expect(manifest.verification).toBe("VERIFIED");
      // The manifest is a non-secret sidecar - no URLs, no passwords.
      expect(manifestRaw).not.toMatch(/postgres(ql)?:\/\//i);
      expect(manifestRaw).not.toContain(process.env.DATABASE_URL ?? "postgres://never");

      const op = await prisma.backupOperation.findFirst({ where: { filename: plainName } });
      expect(op).not.toBeNull();
      expect(op?.status).toBe(BackupOperationStatus.VERIFIED);
      expect(op?.checksumSha256).toBe(digest);
      expect(op?.sizeBytes).toBe(BigInt(stats.size));
      expect(op?.encrypted).toBe(false);
      expect(op?.startedAt).not.toBeNull();
      expect(op?.completedAt).not.toBeNull();
      expect(op?.verifiedAt).not.toBeNull();

      // No .partial temp file may survive a successful run.
      const leftovers = (await readdir(tempDir)).filter((name) => name.endsWith(".partial"));
      expect(leftovers).toEqual([]);
    },
    180_000,
  );

  it(
    "verify-backup CLI accepts the dump and rejects a truncated copy",
    async () => {
      expect(plainName).not.toBe("");
      const filePath = path.join(tempDir, plainName);
      const good = runCli("verify-plain", verifyBackupCli, [filePath], {});
      expect(good.status).toBe(0);
      expect((lastJsonLine(good.stdout) as { ok: boolean }).ok).toBe(true);

      // Corrupt a COPY: truncated half, capped at 64 KiB so the cut always
      // lands inside the custom-format TOC (pg_restore --list would still
      // succeed on a file whose complete TOC merely lost data blocks).
      const bytes = await readFile(filePath);
      const cut = Math.min(Math.floor(bytes.length / 2), 64 * 1024);
      const corruptPath = path.join(tempDir, "corrupt-copy.dump");
      await writeFile(corruptPath, bytes.subarray(0, cut));
      const bad = runCli("verify-corrupt", verifyBackupCli, [corruptPath], {});
      expect(bad.status).not.toBe(0);
      expect((lastJsonLine(bad.stdout) as { ok: boolean }).ok).toBe(false);
      await rm(corruptPath, { force: true });
    },
    180_000,
  );

  it(
    "encrypted run produces a ZBK1 envelope that only the right password verifies",
    async () => {
      const run = runCli("create-encrypted", createBackupCli, ["--trigger", "MANUAL"], {
        ...dbEnv(),
        BACKUP_ENCRYPTION_PASSWORD: ENCRYPTION_PASSWORD,
      });
      expect(run.status).toBe(0);
      const result = lastJsonLine(run.stdout);
      expect(result.ok).toBe(true);
      expect(result.verified).toBe(true);
      encName = result.filename as string;
      expect(encName).toMatch(/^zedbot-db-\d{8}-\d{6}\.dump\.enc$/);

      // Envelope, not plaintext: starts with ZBK1, never with PGDMP.
      const filePath = path.join(tempDir, encName);
      const head = (await readFile(filePath)).subarray(0, 5);
      expect(head.subarray(0, 4).toString("ascii")).toBe("ZBK1");
      expect(head.toString("ascii")).not.toContain("PGDMP");

      const op = await prisma.backupOperation.findFirst({ where: { filename: encName } });
      expect(op?.status).toBe(BackupOperationStatus.VERIFIED);
      expect(op?.encrypted).toBe(true);

      const good = runCli("verify-encrypted-good", verifyBackupCli, [filePath], {
        BACKUP_ENCRYPTION_PASSWORD: ENCRYPTION_PASSWORD,
      });
      expect(good.status).toBe(0);
      const wrong = runCli("verify-encrypted-wrong", verifyBackupCli, [filePath], {
        BACKUP_ENCRYPTION_PASSWORD: "wrong",
      });
      expect(wrong.status).not.toBe(0);
      expect((lastJsonLine(wrong.stdout) as { ok: boolean }).ok).toBe(false);
    },
    180_000,
  );

  it("no spawned CLI ever leaked the connection URL or the encryption password", () => {
    expect(spawnOutputs.length).toBeGreaterThanOrEqual(6);
    const databaseUrl = process.env.DATABASE_URL ?? "";
    for (const { label, text } of spawnOutputs) {
      expect(text, label).not.toMatch(/postgres(ql)?:\/\//i);
      if (databaseUrl !== "") {
        expect(text, label).not.toContain(databaseUrl);
      }
      expect(text, label).not.toContain(ENCRYPTION_PASSWORD);
    }
  });

  it("bot listBackups sees the CLI-created files plus a hand-written legacy backup", async () => {
    expect(plainName).not.toBe("");
    expect(encName).not.toBe("");
    await writeFile(path.join(tempDir, legacyName), "legacy-gzip-bytes");

    const page = await listBackups(1);
    const byName = new Map(page.backups.map((entry) => [entry.name, entry]));
    expect(page.total).toBe(3);

    const plainEntry = byName.get(plainName);
    expect(plainEntry?.kind).toBe("dump");
    // The BackupOperation row joins by filename: the bot shows the worker's
    // verification verdict for the very file the CLI wrote.
    expect(plainEntry?.operation?.status).toBe(BackupOperationStatus.VERIFIED);
    expect(plainEntry?.verifyState).toBe("verified");
    expect(plainEntry?.encrypted).toBe(false);

    const encEntry = byName.get(encName);
    expect(encEntry?.kind).toBe("dump-encrypted");
    expect(encEntry?.encrypted).toBe(true);
    expect(encEntry?.verifyState).toBe("verified");

    const legacyEntry = byName.get(legacyName);
    expect(legacyEntry?.kind).toBe("legacy-sql-gz");
    expect(legacyEntry?.operation ?? null).toBeNull();
    expect(legacyEntry?.verifyState).toBe("unknown");
  });
});

describe.skipIf(hasDeps)("ops backup pipeline (skipped)", () => {
  it("pipeline tests require DATABASE_URL, REDIS_URL and pg_dump/pg_restore - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
