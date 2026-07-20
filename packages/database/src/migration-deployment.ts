import { existsSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  classifyMigrationAttempt,
  readAllMigrationAttempts,
  type MigrationAttempt,
  type MigrationAttemptStatus,
} from "./migration-attempts.js";
import { resolveMigrationsDir } from "./migration-lineage.js";

// =============================================================================
// AUTHORITATIVE migration DEPLOYMENT STATE — the single helper that compares the
// committed on-disk migrations directory with the `_prisma_migrations` attempt
// history and decides whether the deployment is READY. It never infers "all applied"
// from a single successful row: EVERY shipped on-disk migration must be currently
// APPLIED (a success started after every rollback), and every successfully applied
// database migration must still have its file on disk. Migration health, the referral
// activation gate and the operator diagnostic all consume this one result so their
// semantics can never drift. Read-only; the typed result carries counts and migration
// NAMES only (public, non-sensitive) — never row contents or credentials.
// =============================================================================

export interface MigrationDeploymentEntry {
  migrationName: string;
  /** True when a migration directory ships on disk. */
  onDisk: boolean;
  /** Lifecycle derived from the DB attempt history. */
  state: MigrationAttemptStatus;
  /** Currently-applied recorded checksum (only when APPLIED). */
  currentChecksum: string | null;
}

export interface MigrationDeploymentState {
  ready: boolean;
  /** Number of migration directories shipped on disk. */
  onDiskCount: number;
  /** Number of migrations currently APPLIED. */
  appliedCount: number;
  /** On-disk migrations with no successful current attempt (pending). */
  pending: string[];
  /** Migrations whose latest attempt is a live failure/stuck. */
  currentlyFailed: string[];
  /** Migrations rolled back with no later successful reapplication. */
  rolledBackNotReapplied: string[];
  /** Migrations APPLIED in the DB whose migration file is absent on disk. */
  missingFile: string[];
  /** First blocking reason (id-free machine string), null when ready. */
  blocker: string | null;
  /** Per-migration detail in deterministic name order (counts/names only). */
  entries: MigrationDeploymentEntry[];
}

/** Lists the migration directory names shipped on disk (deterministic sort). */
function listOnDiskMigrations(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolvePath(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

function latestSuccessfulChecksum(attempts: readonly MigrationAttempt[]): string | null {
  let latest: MigrationAttempt | null = null;
  for (const a of attempts) {
    if (a.finishedAt !== null && a.rolledBackAt === null && (latest === null || a.startedAt > latest.startedAt)) latest = a;
  }
  return latest?.checksum ?? null;
}

/**
 * Compares the on-disk migrations directory with the DB attempt history and returns the
 * deployment readiness. Blocks when ANY shipped migration is pending / currently failed /
 * rolled-back-not-reapplied, or when ANY currently-applied migration lost its file. A
 * historical rollback followed by a later successful reapplication is APPLIED (non-blocking).
 */
export async function evaluateMigrationDeploymentState(
  migrationsDir: string | null = resolveMigrationsDir(),
): Promise<MigrationDeploymentState> {
  const empty = (blocker: string): MigrationDeploymentState => ({
    ready: false,
    onDiskCount: 0,
    appliedCount: 0,
    pending: [],
    currentlyFailed: [],
    rolledBackNotReapplied: [],
    missingFile: [],
    blocker,
    entries: [],
  });

  if (migrationsDir === null) return empty("migrations-dir-missing");

  const onDiskNames = listOnDiskMigrations(migrationsDir);
  const onDiskSet = new Set(onDiskNames);
  const attemptsByName = await readAllMigrationAttempts();

  const allNames = [...new Set([...onDiskNames, ...attemptsByName.keys()])].sort();

  const pending: string[] = [];
  const currentlyFailed: string[] = [];
  const rolledBackNotReapplied: string[] = [];
  const missingFile: string[] = [];
  const entries: MigrationDeploymentEntry[] = [];
  let appliedCount = 0;

  for (const name of allNames) {
    const attempts = attemptsByName.get(name) ?? [];
    const onDisk = onDiskSet.has(name);
    const state = classifyMigrationAttempt(attempts);
    const currentChecksum = state === "APPLIED" ? latestSuccessfulChecksum(attempts) : null;
    entries.push({ migrationName: name, onDisk, state, currentChecksum });

    switch (state) {
      case "APPLIED":
        appliedCount += 1;
        if (!onDisk) missingFile.push(name); // applied in DB but file gone
        break;
      case "CURRENTLY_FAILED":
        currentlyFailed.push(name);
        break;
      case "ROLLED_BACK_NOT_REAPPLIED":
        rolledBackNotReapplied.push(name);
        break;
      case "NOT_APPLIED":
        if (onDisk) pending.push(name); // shipped but never applied
        break;
    }
  }

  let blocker: string | null = null;
  if (onDiskNames.length === 0) blocker = "no-migrations-on-disk";
  else if (pending.length > 0) blocker = `pending:${pending[0]}`;
  else if (currentlyFailed.length > 0) blocker = `currently-failed:${currentlyFailed[0]}`;
  else if (rolledBackNotReapplied.length > 0) blocker = `rolled-back-not-reapplied:${rolledBackNotReapplied[0]}`;
  else if (missingFile.length > 0) blocker = `missing-file:${missingFile[0]}`;

  return {
    ready: blocker === null,
    onDiskCount: onDiskNames.length,
    appliedCount,
    pending,
    currentlyFailed,
    rolledBackNotReapplied,
    missingFile,
    blocker,
    entries,
  };
}
