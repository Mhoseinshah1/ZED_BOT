import { PrismaClient } from "@prisma/client";

// =============================================================================
// Referral migration PREFLIGHT — a standalone DEPLOYMENT step that MUST run
// BEFORE `prisma migrate deploy` (wired into scripts/migrate.sh, which install.sh
// and update.sh both call). Run standalone via scripts/referral-migration-preflight.sh.
//
// WHY IT IS SEPARATE (not inside a migration): a migration file, once applied, is
// immutable — its checksum is recorded in `_prisma_migrations`. The
// one-commission-per-order UNIQUE index lives in an already-applied migration, so
// the duplicate check cannot live there. Instead this preflight runs first, and on
// a legacy database that predates the unique index and somehow accumulated
// DUPLICATE non-null ReferralCommission.orderId rows it exits non-zero with an
// ACTIONABLE, PII-safe message — long before the index-creating migration would
// abort with PostgreSQL's opaque "could not create unique index" error.
//
// GUARANTEES:
//   - uses the configured (production) DATABASE_URL — the standard Prisma env var;
//   - MOVES NO MONEY and DELETES NO ROWS (a read-only aggregate query);
//   - exposes NO full order / user / commission ids — counts only;
//   - PASSES on a clean database AND on a brand-new one (the table may not exist
//     yet, since the preflight runs before any migration).
// =============================================================================

const EXIT_OK = 0;
const EXIT_DUPLICATES_FOUND = 1;
const EXIT_PREFLIGHT_ERROR = 2;

export async function runReferralMigrationPreflight(prisma: PrismaClient): Promise<number> {
  // A brand-new database has not created the table yet — nothing to verify. Using
  // to_regclass keeps this a safe no-op that never throws on a missing relation.
  const reg = await prisma.$queryRaw<Array<{ regclass: string | null }>>`
    SELECT to_regclass('"public"."ReferralCommission"')::text AS regclass`;
  if (!reg[0] || reg[0].regclass === null) {
    console.log("referral-migration-preflight: ReferralCommission table absent (fresh database) — OK");
    return EXIT_OK;
  }

  const rows = await prisma.$queryRaw<Array<{ dup_groups: bigint; dup_rows: bigint }>>`
    SELECT
      count(*)::bigint AS dup_groups,
      COALESCE(sum(c), 0)::bigint AS dup_rows
    FROM (
      SELECT "orderId", count(*) AS c
      FROM "ReferralCommission"
      WHERE "orderId" IS NOT NULL
      GROUP BY "orderId"
      HAVING count(*) > 1
    ) d`;
  const dupGroups = Number(rows[0]?.dup_groups ?? 0n);
  const dupRows = Number(rows[0]?.dup_rows ?? 0n);

  if (dupGroups > 0) {
    console.error(
      `referral-migration-preflight: FAILED — ReferralCommission has ${dupGroups} order id(s) ` +
        `carrying duplicate commission rows (${dupRows} rows total). A referral payout must be at most ` +
        `one per order. Resolve the duplicates (keep the earliest PAID row per orderId and reconcile the ` +
        `wallet ledger for any extra credit) BEFORE running 'prisma migrate deploy'. See ` +
        `docs/referral-migration-preflight.md for the recovery procedure. No money was moved and no rows ` +
        `were changed.`,
    );
    return EXIT_DUPLICATES_FOUND;
  }

  console.log("referral-migration-preflight: no duplicate orderId commissions — OK");
  return EXIT_OK;
}

async function main(): Promise<number> {
  const prisma = new PrismaClient();
  try {
    return await runReferralMigrationPreflight(prisma);
  } catch (err) {
    // Never print a connection string — only the diagnostic class of the failure.
    console.error(
      `referral-migration-preflight: ERROR — could not verify ReferralCommission uniqueness: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
    return EXIT_PREFLIGHT_ERROR;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

// Only run as a CLI when invoked directly (so tests can import the pure function).
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("referral-migration-preflight.js");
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
