import { prisma } from "./client.js";

// =============================================================================
// Prisma migration-ATTEMPT selection — the AUTHORITATIVE, deterministic lifecycle
// model for `_prisma_migrations` rows. Prisma keeps EVERY attempt of a migration
// forever, including failed and rolled-back rows. The order of attempts matters:
//   - a migration that failed, was `migrate resolve --rolled-back`, then successfully
//     re-applied is APPLIED (a success STARTED AFTER the rollback);
//   - a migration that succeeded and was LATER rolled back (with no reapply) is NOT
//     applied — an older success must NEVER be read as proof of the current state.
// Selecting "the latest successful row ever" or "any rolled_back row" is therefore
// wrong; the state must be derived from the full ordered attempt history.
// Read-only; never modifies `_prisma_migrations`.
// =============================================================================

/** Per-migration lifecycle derived from the FULL ordered attempt history. */
export type MigrationAttemptStatus =
  /** No attempt row exists for this migration name. */
  | "NOT_APPLIED"
  /** The latest attempt is unfinished and not rolled back — a live failure/stuck state. */
  | "CURRENTLY_FAILED"
  /** A rollback is the latest relevant outcome and NO success started after it. */
  | "ROLLED_BACK_NOT_REAPPLIED"
  /** A successful attempt exists that started AFTER every rollback (currently applied). */
  | "APPLIED";

export interface MigrationAttempt {
  migrationName: string;
  checksum: string;
  startedAt: Date;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
}

interface RawAttemptRow {
  migration_name: string;
  checksum: string;
  started_at: Date;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

function toAttempt(r: RawAttemptRow): MigrationAttempt {
  return {
    migrationName: r.migration_name,
    checksum: r.checksum,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    rolledBackAt: r.rolled_back_at,
  };
}

const isSuccessful = (a: MigrationAttempt): boolean => a.finishedAt !== null && a.rolledBackAt === null;
const isRolledBack = (a: MigrationAttempt): boolean => a.rolledBackAt !== null;
const isStuck = (a: MigrationAttempt): boolean => a.finishedAt === null && a.rolledBackAt === null;

/**
 * The most-recently STARTED successful attempt (finished, not rolled back) among an
 * attempt array, or null. Order-independent — the single source of truth for "latest
 * success ever" that both the deployment-state helper and the ordinary-immutability check
 * consume. NOTE: a later rollback may still supersede it; use it only after confirming the
 * migration is APPLIED (see classifyMigrationAttempt).
 */
export function getLatestSuccessfulAttempt(attempts: readonly MigrationAttempt[]): MigrationAttempt | null {
  let latest: MigrationAttempt | null = null;
  for (const a of attempts) {
    if (isSuccessful(a) && (latest === null || a.startedAt > latest.startedAt)) latest = a;
  }
  return latest;
}

/** The single most-recently STARTED attempt for a migration (any outcome), or null. */
export async function readLatestMigrationAttempt(name: string): Promise<MigrationAttempt | null> {
  const rows = await prisma.$queryRaw<RawAttemptRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
    FROM _prisma_migrations
    WHERE migration_name = ${name}
    ORDER BY started_at DESC
    LIMIT 1`;
  return rows[0] ? toAttempt(rows[0]) : null;
}

/**
 * The most-recently STARTED SUCCESSFUL attempt (finished, not rolled back), or null.
 * NOTE: this is "latest success EVER" — it does NOT prove the migration is currently
 * applied (a later rollback may supersede it). Use `readMigrationAttemptState().currentChecksum`
 * for the authoritative currently-applied checksum.
 */
export async function readLatestSuccessfulMigrationAttempt(name: string): Promise<MigrationAttempt | null> {
  const rows = await prisma.$queryRaw<RawAttemptRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
    FROM _prisma_migrations
    WHERE migration_name = ${name} AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1`;
  return rows[0] ? toAttempt(rows[0]) : null;
}

/** Reads every `_prisma_migrations` attempt, grouped by migration name (ordered by started_at ASC). */
export async function readAllMigrationAttempts(): Promise<Map<string, MigrationAttempt[]>> {
  const rows = await prisma.$queryRaw<RawAttemptRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
    FROM _prisma_migrations
    ORDER BY migration_name, started_at ASC`;
  const byName = new Map<string, MigrationAttempt[]>();
  for (const r of rows) {
    const a = toAttempt(r);
    const list = byName.get(a.migrationName);
    if (list) list.push(a);
    else byName.set(a.migrationName, [a]);
  }
  return byName;
}

/**
 * Classifies a migration from its FULL attempt history (order-independent input).
 * The latest attempt decides a live failure; otherwise a rollback blocks UNLESS a
 * success started strictly after the latest rollback. An older success preceding a
 * newer rollback is NEVER treated as applied.
 */
export function classifyMigrationAttempt(attempts: readonly MigrationAttempt[]): MigrationAttemptStatus {
  if (attempts.length === 0) return "NOT_APPLIED";
  let latest: MigrationAttempt | null = null;
  let latestSuccessful: MigrationAttempt | null = null;
  let latestRolledBack: MigrationAttempt | null = null;
  for (const a of attempts) {
    if (latest === null || a.startedAt > latest.startedAt) latest = a;
    if (isSuccessful(a) && (latestSuccessful === null || a.startedAt > latestSuccessful.startedAt)) latestSuccessful = a;
    if (isRolledBack(a) && (latestRolledBack === null || a.startedAt > latestRolledBack.startedAt)) latestRolledBack = a;
  }
  if (latest !== null && isStuck(latest)) return "CURRENTLY_FAILED";
  if (latestSuccessful === null) return "ROLLED_BACK_NOT_REAPPLIED";
  if (latestRolledBack === null) return "APPLIED";
  return latestSuccessful.startedAt > latestRolledBack.startedAt ? "APPLIED" : "ROLLED_BACK_NOT_REAPPLIED";
}

/**
 * Number of migrations whose lifecycle is CURRENTLY_FAILED (a live failed/stuck latest
 * attempt). A rolled-back-not-reapplied migration is NOT counted here — that is a
 * distinct blocking state surfaced by the deployment-state helper.
 */
export async function countCurrentlyFailedOrStuckMigrations(): Promise<number> {
  const byName = await readAllMigrationAttempts();
  let n = 0;
  for (const attempts of byName.values()) {
    if (classifyMigrationAttempt(attempts) === "CURRENTLY_FAILED") n += 1;
  }
  return n;
}

export interface MigrationAttemptState {
  status: MigrationAttemptStatus;
  /** Most-recent attempt of any outcome. */
  latest: MigrationAttempt | null;
  /** Most-recent successful attempt ever (may be stale if a later rollback superseded it). */
  latestSuccessful: MigrationAttempt | null;
  /** Most-recent rolled-back attempt. */
  latestRolledBack: MigrationAttempt | null;
  /**
   * The recorded checksum of the CURRENT applied state — the latest successful attempt's
   * checksum ONLY when the migration is APPLIED (a success started after every rollback).
   * null when NOT_APPLIED / CURRENTLY_FAILED / ROLLED_BACK_NOT_REAPPLIED.
   */
  currentChecksum: string | null;
  /** How many recorded attempts were rolled back (diagnostic only). */
  rolledBackCount: number;
}

/**
 * Reads the full attempt history of ONE migration and derives its authoritative state.
 * `currentChecksum` is non-null ONLY when the migration is currently APPLIED, so callers
 * cannot mistake an older, since-rolled-back success for the live checksum.
 */
export async function readMigrationAttemptState(name: string): Promise<MigrationAttemptState> {
  const rows = await prisma.$queryRaw<RawAttemptRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
    FROM _prisma_migrations
    WHERE migration_name = ${name}
    ORDER BY started_at DESC`;
  const attempts = rows.map(toAttempt);
  const latest = attempts[0] ?? null; // rows are DESC
  const latestSuccessful = attempts.find(isSuccessful) ?? null;
  const latestRolledBack = attempts.find(isRolledBack) ?? null;
  const status = classifyMigrationAttempt(attempts);
  return {
    status,
    latest,
    latestSuccessful,
    latestRolledBack,
    currentChecksum: status === "APPLIED" ? (latestSuccessful?.checksum ?? null) : null,
    rolledBackCount: attempts.filter(isRolledBack).length,
  };
}
