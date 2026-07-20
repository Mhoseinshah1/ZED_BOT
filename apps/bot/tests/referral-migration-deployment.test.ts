import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateMigrationDeploymentState, prisma, resolveMigrationsDir } from "@zedbot/database";
import { afterAll, afterEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-deployment-tests-secret-0123456789";

// =============================================================================
// §2/§5 — the AUTHORITATIVE migration DEPLOYMENT STATE compares the committed on-disk
// migrations directory with the `_prisma_migrations` attempt history and never infers
// "all applied" from a single successful row. Every shipped on-disk migration must be
// currently APPLIED; every APPLIED database migration must still have its file on disk.
// These tests build a TEMP copy of the real migrations dir (so all real applied
// migrations have their files) and insert / remove synthetic rows + directories to
// construct each divergence. Every synthetic row is cleaned up.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const REAL_DIR = resolveMigrationsDir();

/** A fresh temp dir that is a byte-for-byte copy of the shipped migrations directory. */
function copyRealMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-mig-"));
  if (REAL_DIR !== null) cpSync(REAL_DIR, dir, { recursive: true });
  return dir;
}

/** Adds a synthetic on-disk migration directory (with a migration.sql) to `dir`. */
function addOnDiskMigration(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "migration.sql"), "-- synthetic pending migration\nSELECT 1;\n");
}

async function insertAttempt(
  id: string,
  name: string,
  opts: { finished?: boolean; rolledBack?: boolean; startedShift?: string },
): Promise<void> {
  const started = opts.startedShift ? `now() - interval '${opts.startedShift}'` : "now()";
  await prisma.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
     VALUES ($1, 'x', $2, ${started}, ${opts.finished ? "now()" : "NULL"}, ${opts.rolledBack ? "now()" : "NULL"}, ${opts.finished ? 1 : 0})`,
    id,
    name,
  );
}

async function clearSynthetic(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE id LIKE 'deploy-test-%'`);
}

d("migration deployment state — on-disk vs database (§2/§5)", () => {
  const temps: string[] = [];
  function tmp(): string {
    const dir = copyRealMigrationsDir();
    temps.push(dir);
    return dir;
  }

  afterEach(async () => {
    await clearSynthetic();
  });
  afterAll(async () => {
    await clearSynthetic();
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("resolves the shipped migrations directory (never null in this repo)", () => {
    expect(REAL_DIR).not.toBeNull();
  });

  it("every shipped on-disk migration is currently applied → READY", async () => {
    const dep = await evaluateMigrationDeploymentState(tmp());
    expect(dep.ready).toBe(true);
    expect(dep.blocker).toBeNull();
    expect(dep.onDiskCount).toBeGreaterThan(0);
    expect(dep.appliedCount).toBe(dep.onDiskCount);
    expect(dep.pending).toHaveLength(0);
    expect(dep.currentlyFailed).toHaveLength(0);
    expect(dep.rolledBackNotReapplied).toHaveLength(0);
    expect(dep.missingFile).toHaveLength(0);
  });

  it("a migration file present on disk with NO database row → PENDING and BLOCKS", async () => {
    const dir = tmp();
    addOnDiskMigration(dir, "29991231000000_pending_never_applied");
    const dep = await evaluateMigrationDeploymentState(dir);
    expect(dep.ready).toBe(false);
    expect(dep.pending).toContain("29991231000000_pending_never_applied");
    expect(dep.blocker).toBe("pending:29991231000000_pending_never_applied");
  });

  it("a DATABASE success whose migration FILE is missing on disk → BLOCKS (missing-file)", async () => {
    await insertAttempt("deploy-test-ghost", "29991231000000_ghost_applied_no_file", { finished: true });
    const dep = await evaluateMigrationDeploymentState(tmp());
    expect(dep.ready).toBe(false);
    expect(dep.missingFile).toContain("29991231000000_ghost_applied_no_file");
    expect(dep.blocker).toBe("missing-file:29991231000000_ghost_applied_no_file");
  });

  it("a migration ROLLED BACK and never reapplied → BLOCKS (rolled-back-not-reapplied)", async () => {
    await insertAttempt("deploy-test-rbnr", "29991231000000_rolledback_unreapplied", { rolledBack: true });
    const dep = await evaluateMigrationDeploymentState(tmp());
    expect(dep.ready).toBe(false);
    expect(dep.rolledBackNotReapplied).toContain("29991231000000_rolledback_unreapplied");
    expect(dep.blocker).toBe("rolled-back-not-reapplied:29991231000000_rolledback_unreapplied");
  });

  it("a migration that SUCCEEDED then was LATER rolled back → BLOCKS (older success is NOT proof)", async () => {
    await insertAttempt("deploy-test-sr1", "29991231000000_success_then_rollback", { finished: true, startedShift: "2 hours" });
    await insertAttempt("deploy-test-sr2", "29991231000000_success_then_rollback", { rolledBack: true });
    const dep = await evaluateMigrationDeploymentState(tmp());
    expect(dep.ready).toBe(false);
    expect(dep.rolledBackNotReapplied).toContain("29991231000000_success_then_rollback");
  });

  it("a ROLLBACK FOLLOWED BY a later successful reapplication → APPLIED (non-blocking, stays READY)", async () => {
    const dir = tmp();
    const name = "29991231000000_rollback_then_reapply";
    addOnDiskMigration(dir, name); // ships on disk
    // Older rolled-back attempt, then a strictly newer successful attempt → currently applied.
    await insertAttempt("deploy-test-rr1", name, { rolledBack: true, startedShift: "2 hours" });
    await insertAttempt("deploy-test-rr2", name, { finished: true });
    const dep = await evaluateMigrationDeploymentState(dir);
    expect(dep.ready).toBe(true);
    expect(dep.blocker).toBeNull();
    expect(dep.rolledBackNotReapplied).not.toContain(name);
    const entry = dep.entries.find((e) => e.migrationName === name);
    expect(entry?.state).toBe("APPLIED");
    expect(entry?.onDisk).toBe(true);
  });

  it("a shipped migration directory MISSING migration.sql → BLOCKS (incomplete-on-disk, never silently dropped)", async () => {
    const dir = tmp();
    const name = "29991231000000_partial_no_sql";
    mkdirSync(join(dir, name), { recursive: true }); // directory exists, but NO migration.sql inside
    const dep = await evaluateMigrationDeploymentState(dir);
    expect(dep.ready).toBe(false);
    expect(dep.incompleteOnDisk).toContain(name);
    expect(dep.blocker).toBe(`incomplete-on-disk:${name}`);
    // It must NOT be counted as a usable on-disk migration.
    expect(dep.onDiskCount).toBe(dep.appliedCount);
  });

  it("a currently-stuck (unfinished, not rolled back) migration → BLOCKS (currently-failed)", async () => {
    await insertAttempt("deploy-test-stuck", "29991231000000_currently_stuck", { finished: false, rolledBack: false });
    const dep = await evaluateMigrationDeploymentState(tmp());
    expect(dep.ready).toBe(false);
    expect(dep.currentlyFailed).toContain("29991231000000_currently_stuck");
    expect(dep.blocker).toBe("currently-failed:29991231000000_currently_stuck");
  });

  it("the typed result exposes counts and NAMES only — no row contents or credentials", async () => {
    const dep = await evaluateMigrationDeploymentState(tmp());
    const serialized = JSON.stringify(dep);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    // Migration NAMES (timestamp_slug) and public checksums are allowed; UUID row ids are not.
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const e of dep.entries) expect(e.migrationName).toMatch(/^[0-9]{14}_/);
  });
});
