import { prisma } from "./client.js";

// =============================================================================
// Prisma migration-ATTEMPT selection — the AUTHORITATIVE, deterministic helpers
// for reasoning about `_prisma_migrations` rows. Prisma keeps EVERY attempt of a
// migration forever, including failed and rolled-back rows: a migration that failed,
// was `migrate resolve --rolled-back`, then successfully re-applied leaves BOTH the
// old rolled-back row AND the new successful row. Selecting "the first row" or
// "any rolled_back row" is therefore wrong — it can pick an outdated/failed attempt
// or block forever on ancient history.
//
// Contract (used identically by migration health AND lineage evaluation):
//   - a SUCCESSFUL attempt is  finished_at IS NOT NULL AND rolled_back_at IS NULL;
//   - a CURRENTLY failed/stuck attempt is  finished_at IS NULL AND rolled_back_at IS NULL;
//   - a HISTORICAL rolled-back attempt is  rolled_back_at IS NOT NULL (diagnostic only —
//     it must NOT block once a later successful attempt exists);
//   - when several attempts exist, the LATEST is  ORDER BY started_at DESC LIMIT 1.
// Read-only; never modifies `_prisma_migrations`.
// =============================================================================

/** Per-migration lifecycle classification derived from its recorded attempts. */
export type MigrationAttemptStatus =
  /** No row at all for this migration name. */
  | "NOT_APPLIED"
  /** A latest successful attempt exists (even if older attempts were rolled back). */
  | "APPLIED"
  /** The latest attempt is unfinished and not rolled back — a live failure/stuck state. */
  | "CURRENTLY_FAILED"
  /** The latest attempt was rolled back and NO successful attempt has replaced it. */
  | "HISTORICALLY_ROLLED_BACK";

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
 * This is the authoritative source of the migration's applied checksum — never an
 * old failed / rolled-back attempt.
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

/**
 * Count of migrations that are CURRENTLY failed or stuck across the whole history
 * (finished_at IS NULL AND rolled_back_at IS NULL). Historical rolled-back rows are
 * deliberately excluded — they do not represent a live failure.
 */
export async function countCurrentlyFailedOrStuckMigrations(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM _prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
  return rows[0]?.n ?? 0;
}

/**
 * Classifies a migration from its latest and latest-successful attempts. A live
 * failure (latest attempt unfinished & not rolled back) wins; otherwise the presence
 * of ANY successful attempt means APPLIED, so a rolled-back-then-reapplied migration
 * is APPLIED, not blocked.
 */
export function classifyMigrationAttempt(
  latest: MigrationAttempt | null,
  latestSuccessful: MigrationAttempt | null,
): MigrationAttemptStatus {
  if (latest === null) return "NOT_APPLIED";
  if (latest.finishedAt === null && latest.rolledBackAt === null) return "CURRENTLY_FAILED";
  if (latestSuccessful !== null) return "APPLIED";
  return "HISTORICALLY_ROLLED_BACK";
}

export interface MigrationAttemptState {
  status: MigrationAttemptStatus;
  /** Most-recent attempt of any outcome. */
  latest: MigrationAttempt | null;
  /** Most-recent successful attempt — the authoritative applied checksum source. */
  latestSuccessful: MigrationAttempt | null;
  /** How many recorded attempts were rolled back (diagnostic only; does not block). */
  historicalRolledBackCount: number;
}

/**
 * Reads the full attempt history of ONE migration in a single query and derives its
 * authoritative state (status + latest + latest-successful + historical rollback count).
 * This is the single helper migration health and lineage evaluation both consume.
 */
export async function readMigrationAttemptState(name: string): Promise<MigrationAttemptState> {
  const rows = await prisma.$queryRaw<RawAttemptRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
    FROM _prisma_migrations
    WHERE migration_name = ${name}
    ORDER BY started_at DESC`;
  const attempts = rows.map(toAttempt);
  const latest = attempts[0] ?? null;
  // Rows are already ORDER BY started_at DESC, so the first success IS the latest.
  const latestSuccessful = attempts.find((a) => a.finishedAt !== null && a.rolledBackAt === null) ?? null;
  const historicalRolledBackCount = attempts.filter((a) => a.rolledBackAt !== null).length;
  return {
    status: classifyMigrationAttempt(latest, latestSuccessful),
    latest,
    latestSuccessful,
    historicalRolledBackCount,
  };
}
