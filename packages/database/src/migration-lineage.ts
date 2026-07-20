import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "./client.js";
import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  readPrismaMigrationChecksum,
} from "./migration-checksum.js";

// =============================================================================
// Referral migration LINEAGE evaluation. `20260719180000` shipped in two byte
// forms with identical FINAL schema but different checksums:
//   - ORIGINAL (PR #108, also the current restored file);
//   - PR #110 (embedded duplicate-orderId preflight block).
// A database that applied the PR #110 form recorded THAT checksum, so a strict
// "on-disk == recorded" activation gate would wrongly block it forever even though
// its schema is valid. This module accepts BOTH known checksums for that ONE
// migration — and ONLY after every required SCHEMA postcondition passes — while
// still rejecting any UNKNOWN modification. It never edits the migration file or
// `_prisma_migrations`, and every query is read-only. Shared by the activation gate
// and the operator lineage-status command.
// =============================================================================

export type ReferralMigrationLineageStatus =
  /** on-disk checksum == recorded checksum (an ordinary immutable migration). */
  | "EXACT_MATCH"
  /** recorded == the known PR #110 checksum AND all schema postconditions pass. */
  | "KNOWN_COMPATIBLE_LEGACY_VARIANT"
  /** recorded is neither known checksum (an unknown / tampered history). */
  | "CHECKSUM_DRIFT"
  /** the migration file is absent on disk (cannot verify). */
  | "FILE_MISSING"
  /** recorded == the known PR #110 checksum but a schema postcondition failed. */
  | "SCHEMA_POSTCONDITION_FAILED";

export interface ReferralSchemaPostcondition {
  key: string;
  ok: boolean;
}

export interface ReferralMigrationLineage {
  status: ReferralMigrationLineageStatus;
  /** Recorded `_prisma_migrations.checksum` for the known migration (null if not applied). */
  recordedChecksum: string | null;
  /** SHA-256 of the on-disk migration file (null if missing / dir unresolved). */
  onDiskChecksum: string | null;
  /** True when the status permits activation (EXACT_MATCH or KNOWN_COMPATIBLE_LEGACY_VARIANT). */
  activationAllowed: boolean;
  /** True ONLY for KNOWN_COMPATIBLE_LEGACY_VARIANT — surfaces the non-blocking OWNER warning. */
  legacyVariant: boolean;
  /** Short, id-free detail for logs / the operator command. */
  detail: string;
  /** The schema postconditions evaluated (only populated when the recorded checksum is PR #110). */
  postconditions: ReferralSchemaPostcondition[] | null;
}

/**
 * Resolves the prisma/migrations directory that ships ALONGSIDE this package (the
 * Dockerfile copies `packages/database/prisma` into the runtime image, so this
 * resolves inside the bot/api/worker containers too). Returns null only if the
 * directory is genuinely absent.
 */
export function resolveMigrationsDir(): string | null {
  try {
    // this module: <pkg>/dist/migration-lineage.js (or src/… under vitest)
    //   → <pkg>/prisma/migrations
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolvePath(here, "..", "prisma", "migrations");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Resolves the schema that actually contains ReferralCommission (search_path-aware). */
async function resolveReferralSchema(): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ schema: string | null }>>`
    SELECT n.nspname AS schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = to_regclass('"ReferralCommission"')`;
  return rows[0]?.schema ?? null;
}

/**
 * Verifies every required SCHEMA postcondition of the referral affiliate migration —
 * regardless of which byte form applied it. Schema-aware (custom search_path safe):
 * the schema name is read from the catalog and passed as a BIND PARAMETER (never
 * concatenated), and table-data reads use the unqualified name so search_path
 * resolves it. Read-only; count-only; never touches an order/user id.
 */
export async function checkReferralSchemaPostconditions(): Promise<{
  ok: boolean;
  postconditions: ReferralSchemaPostcondition[];
}> {
  const schema = await resolveReferralSchema();
  const pc: ReferralSchemaPostcondition[] = [];
  const push = (key: string, ok: boolean): void => {
    pc.push({ key, ok });
  };

  if (schema === null) {
    // The table is absent — none of the structural postconditions can hold.
    for (const k of [
      "table-exists",
      "enum-has-reversed",
      "reversal-wallet-tx-column",
      "reversed-at-column",
      "orderid-unique-index",
      "index-is-unique",
      "no-duplicate-orderid",
      "migration-finished",
      "migration-not-rolled-back",
      "no-migration-failure",
    ]) {
      push(k, false);
    }
    return { ok: false, postconditions: pc };
  }
  push("table-exists", true);

  const [enumRow] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = ${schema} AND t.typname = 'ReferralCommissionStatus' AND e.enumlabel = 'REVERSED'`;
  push("enum-has-reversed", (enumRow?.n ?? 0) > 0);

  const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = 'ReferralCommission'
      AND column_name IN ('reversalWalletTransactionId', 'reversedAt')`;
  const colSet = new Set(cols.map((c) => c.column_name));
  push("reversal-wallet-tx-column", colSet.has("reversalWalletTransactionId"));
  push("reversed-at-column", colSet.has("reversedAt"));

  const idxRows = await prisma.$queryRaw<Array<{ indisunique: boolean }>>`
    SELECT i.indisunique
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = ${schema} AND c.relname = 'ReferralCommission_orderId_key'`;
  push("orderid-unique-index", idxRows.length > 0);
  push("index-is-unique", idxRows.length > 0 && idxRows.every((r) => r.indisunique === true));

  const [dupRow] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM (
      SELECT "orderId" FROM "ReferralCommission"
      WHERE "orderId" IS NOT NULL
      GROUP BY "orderId"
      HAVING count(*) > 1
    ) d`;
  push("no-duplicate-orderid", (dupRow?.n ?? 0) === 0);

  const [migRow] = await prisma.$queryRaw<Array<{ finished: boolean; rolled_back: boolean }>>`
    SELECT (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back
    FROM _prisma_migrations
    WHERE migration_name = ${REFERRAL_AFFILIATE_MIGRATION_NAME}`;
  push("migration-finished", migRow?.finished === true);
  push("migration-not-rolled-back", migRow !== undefined && migRow.rolled_back === false);

  const [failRow] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL`;
  push("no-migration-failure", (failRow?.n ?? 0) === 0);

  return { ok: pc.every((p) => p.ok), postconditions: pc };
}

/** Reads the recorded checksum of the known migration from `_prisma_migrations`. */
async function readRecordedChecksum(): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
    SELECT checksum FROM _prisma_migrations
    WHERE migration_name = ${REFERRAL_AFFILIATE_MIGRATION_NAME} AND rolled_back_at IS NULL`;
  return rows[0]?.checksum ?? null;
}

/**
 * Evaluates the lineage of the ONE known referral migration. Accepts the ORIGINAL and
 * the PR #110 checksums only (the latter after all schema postconditions pass); any
 * other recorded checksum is CHECKSUM_DRIFT. Never edits anything.
 */
export async function evaluateReferralMigrationLineage(
  migrationsDir: string | null = resolveMigrationsDir(),
): Promise<ReferralMigrationLineage> {
  const onDiskChecksum =
    migrationsDir === null
      ? null
      : (() => {
          const file = resolvePath(migrationsDir, REFERRAL_AFFILIATE_MIGRATION_NAME, "migration.sql");
          return existsSync(file) ? readPrismaMigrationChecksum(file) : null;
        })();

  const recordedChecksum = await readRecordedChecksum();

  const base = { recordedChecksum, onDiskChecksum, postconditions: null as ReferralSchemaPostcondition[] | null };

  if (onDiskChecksum === null) {
    return {
      ...base,
      status: "FILE_MISSING",
      activationAllowed: false,
      legacyVariant: false,
      detail: "migration file not found on disk",
    };
  }
  if (recordedChecksum === null) {
    // The migration is not recorded as applied — surfaced separately by the
    // migrations-healthy check; treat as drift for the lineage dimension.
    return {
      ...base,
      status: "CHECKSUM_DRIFT",
      activationAllowed: false,
      legacyVariant: false,
      detail: "migration not recorded as applied",
    };
  }
  if (recordedChecksum === onDiskChecksum) {
    return { ...base, status: "EXACT_MATCH", activationAllowed: true, legacyVariant: false, detail: "on-disk checksum matches recorded" };
  }
  // Drift: the recorded checksum differs from the current file. Accept ONLY the known
  // PR #110 checksum for the current (original) on-disk file, and only after the schema
  // postconditions confirm the final schema is intact.
  const isKnownLegacy =
    recordedChecksum === REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110 &&
    onDiskChecksum === REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL;
  if (!isKnownLegacy) {
    return {
      ...base,
      status: "CHECKSUM_DRIFT",
      activationAllowed: false,
      legacyVariant: false,
      detail: "recorded checksum is neither the original nor the known PR#110 variant",
    };
  }
  const postconditions = await checkReferralSchemaPostconditions();
  if (!postconditions.ok) {
    return {
      recordedChecksum,
      onDiskChecksum,
      status: "SCHEMA_POSTCONDITION_FAILED",
      activationAllowed: false,
      legacyVariant: false,
      detail: `failed: ${postconditions.postconditions.filter((p) => !p.ok).map((p) => p.key).join(",")}`,
      postconditions: postconditions.postconditions,
    };
  }
  return {
    recordedChecksum,
    onDiskChecksum,
    status: "KNOWN_COMPATIBLE_LEGACY_VARIANT",
    activationAllowed: true,
    legacyVariant: true,
    detail: "known compatible PR#110 lineage with valid schema",
    postconditions: postconditions.postconditions,
  };
}
