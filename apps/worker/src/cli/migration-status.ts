import { readdir } from "node:fs/promises";
import path from "node:path";

import { connectDatabase, disconnectDatabase, prisma } from "@zedbot/database";

// =============================================================================
// CLI: compare the Prisma migrations SHIPPED IN THIS IMAGE against the ones
// the database has actually applied (deploy scripts use this to decide
// whether `prisma migrate deploy` is still pending/failed). Usage:
//
//   node dist/cli/migration-status.js
//
// Prints one-line JSON {ok, appliedCount, pendingCount, failedCount,
// upToDate, pendingNames} and exits 0; on an unreachable database prints
// {ok:false, error:"db-unreachable"} and exits 1. A database without the
// _prisma_migrations table (fresh install) reads as "nothing applied yet".
// The connection string is never printed.
// =============================================================================

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/** Shipped migration directory names, resolved from repo root or app cwd. */
async function readShippedMigrations(): Promise<string[] | null> {
  const candidates = [
    path.resolve(process.cwd(), "packages/database/prisma/migrations"),
    path.resolve(process.cwd(), "../../packages/database/prisma/migrations"),
  ];
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      // Entries are one directory per migration; migration_lock.toml is a file.
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      // Try the next candidate location.
    }
  }
  return null;
}

/** True for "relation _prisma_migrations does not exist" (fresh database). */
function isUndefinedTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("42P01") ||
    (message.includes("_prisma_migrations") && message.includes("does not exist"))
  );
}

async function main(): Promise<void> {
  const shipped = await readShippedMigrations();
  if (shipped === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "migrations-dir-missing" })}\n`);
    process.exit(1);
    return;
  }

  let exitCode = 1;
  try {
    await connectDatabase();
    let rows: MigrationRow[] = [];
    try {
      rows = await prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
      `;
    } catch (err) {
      if (!isUndefinedTableError(err)) {
        throw err;
      }
      // Fresh database: no migrations table yet -> nothing applied.
      rows = [];
    }

    const finished = new Set(
      rows.filter((row) => row.finished_at !== null).map((row) => row.migration_name),
    );
    const pendingNames = shipped.filter((name) => !finished.has(name));
    const appliedCount = shipped.length - pendingNames.length;
    // Started but neither finished nor rolled back: a migration that died
    // mid-flight and blocks `prisma migrate deploy` until resolved.
    const failedCount = rows.filter(
      (row) => row.finished_at === null && row.rolled_back_at === null,
    ).length;
    const result = {
      ok: true,
      appliedCount,
      pendingCount: pendingNames.length,
      failedCount,
      upToDate: pendingNames.length === 0 && failedCount === 0,
      pendingNames: pendingNames.slice(0, 5),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    exitCode = 0;
  } catch {
    // Any database error collapses to a fixed safe string - never the
    // underlying message, which could embed the connection string.
    process.stdout.write(`${JSON.stringify({ ok: false, error: "db-unreachable" })}\n`);
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch(() => {
  process.stderr.write("migration-status failed\n");
  process.exit(1);
});
