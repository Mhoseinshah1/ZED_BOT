import { execFile } from "node:child_process";

import { backupTimeoutMs } from "../config.js";

// =============================================================================
// PostgreSQL client-tool helpers: URL sanitizing for libpq, pg_dump version
// probing and pg_restore-based structural verification. DATABASE_URL is
// never logged - failures collapse to short safe reason codes.
// =============================================================================

// Prisma connection strings may carry Prisma-only query parameters that
// libpq does not know - pg_dump then fails with
// `invalid URI query parameter: "schema"`. Strip exactly those before
// spawning pg_dump; libpq-valid parameters (sslmode, connect_timeout,
// application_name, ...) pass through untouched. Mirrors
// apps/bot/src/services/backup-health.service.ts (kept in sync by hand -
// the worker must not depend on bot internals).
const PRISMA_ONLY_URL_PARAMS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "socket_timeout",
  "pgbouncer",
  "statement_cache_size",
  "sslaccept",
  "sslidentity",
];

/**
 * DATABASE_URL -> a URL libpq/pg_dump accepts. Never throws and never logs
 * the URL; unparseable input passes through unchanged so pg_dump reports
 * its own (scrubbed) error.
 */
export function pgDumpSafeUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    for (const param of PRISMA_ONLY_URL_PARAMS) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

/** `pg_dump --version` -> "17.2" style string, or null when unavailable. */
export async function pgDumpVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("pg_dump", ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const match = /(\d+(?:\.\d+)*)/.exec(stdout);
      resolve(match !== null ? match[1] : stdout.trim().slice(0, 60) || null);
    });
  });
}

export interface PgRestoreListResult {
  ok: boolean;
  /** Short safe reason ("pg-restore-exit-1", "pg-restore-empty", ...). */
  reason: string | null;
}

/**
 * Structural verification: `pg_restore --list <dump>` must exit 0 and print
 * a non-empty table of contents. Output/stderr are never propagated.
 */
export async function pgRestoreList(dumpPath: string): Promise<PgRestoreListResult> {
  return new Promise((resolve) => {
    execFile(
      "pg_restore",
      ["--list", dumpPath],
      { timeout: backupTimeoutMs(), killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) {
          const withCode = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
          if (withCode.killed === true) {
            resolve({ ok: false, reason: "pg-restore-timeout" });
            return;
          }
          const code = typeof withCode.code === "number" ? withCode.code : "failed";
          resolve({ ok: false, reason: `pg-restore-exit-${code}` });
          return;
        }
        if (stdout.trim() === "") {
          resolve({ ok: false, reason: "pg-restore-empty" });
          return;
        }
        resolve({ ok: true, reason: null });
      },
    );
  });
}
