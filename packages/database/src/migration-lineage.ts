import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "./client.js";
import {
  classifyReferralMigrationChecksum,
  REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  readPrismaMigrationChecksum,
  type ReferralMigrationChecksumClass,
} from "./migration-checksum.js";
import { readLatestSuccessfulMigrationAttempt } from "./migration-attempts.js";

// =============================================================================
// Referral migration LINEAGE evaluation. `20260719180000` shipped in two logical SQL
// forms (PR #108 ORIGINAL, PR #110 embedded-preflight) with an IDENTICAL final schema,
// each applyable from an LF OR CRLF checkout — four empirically verified checksums in
// all (see migration-checksum.ts). A database that applied any of them recorded THAT
// checksum, so a strict "on-disk == recorded" gate would wrongly block a valid install
// forever. This module accepts ONLY those four known checksums for that ONE migration —
// and ONLY after EVERY schema postcondition passes (including EXACT_MATCH, since a
// checksum can be right while the live schema has drifted) — and rejects everything
// else. It never edits the migration file or `_prisma_migrations`; every query is
// read-only. Shared by the activation gate and the operator lineage-status command.
// =============================================================================

export type ReferralMigrationLineageStatus =
  /** on-disk checksum == recorded checksum AND all schema postconditions pass. */
  | "EXACT_MATCH"
  /** recorded == a known non-current variant AND all schema postconditions pass. */
  | "KNOWN_COMPATIBLE_LEGACY_VARIANT"
  /** recorded is not in the empirically verified allowlist (unknown / tampered). */
  | "CHECKSUM_DRIFT"
  /** the migration file is absent on disk (cannot verify). */
  | "FILE_MISSING"
  /** recorded is a known variant but a schema postcondition failed (drifted schema). */
  | "SCHEMA_POSTCONDITION_FAILED";

export interface ReferralSchemaPostcondition {
  key: string;
  ok: boolean;
}

/**
 * Exact catalog verification of the one-commission-per-order UNIQUE index, tied to the
 * resolved ReferralCommission table OID (never trusting the index NAME alone).
 */
export interface ReferralUniqueIndexVerification {
  ok: boolean;
  /** An index with the expected name is bound to the resolved ReferralCommission OID. */
  exists: boolean;
  /** pg_index.indrelid == the resolved ReferralCommission table OID. */
  belongsToReferralCommission: boolean;
  /** The index relation lives in the same schema as ReferralCommission. */
  sameSchema: boolean;
  /** pg_index.indisunique. */
  isUnique: boolean;
  /** pg_index.indisvalid. */
  isValid: boolean;
  /** pg_index.indisready. */
  isReady: boolean;
  /** pg_index.indpred IS NULL (not a partial index). */
  noPredicate: boolean;
  /** pg_index.indexprs IS NULL (not an expression index). */
  noExpression: boolean;
  /** Exactly one key column and no INCLUDE columns (indnatts == indnkeyatts == 1). */
  singleKeyColumn: boolean;
  /** The single key column is exactly ReferralCommission.orderId. */
  targetsOrderId: boolean;
  detail: string;
}

export interface ReferralMigrationLineage {
  status: ReferralMigrationLineageStatus;
  /** Recorded `_prisma_migrations.checksum` of the latest SUCCESSFUL attempt (null if none). */
  recordedChecksum: string | null;
  /** Classification of the recorded checksum against the empirical allowlist. */
  checksumClass: ReferralMigrationChecksumClass;
  /** SHA-256 of the on-disk migration file (null if missing / dir unresolved). */
  onDiskChecksum: string | null;
  /** True when the status permits activation (EXACT_MATCH or KNOWN_COMPATIBLE_LEGACY_VARIANT). */
  activationAllowed: boolean;
  /** True ONLY for KNOWN_COMPATIBLE_LEGACY_VARIANT — surfaces the non-blocking OWNER warning. */
  legacyVariant: boolean;
  /** Short, id-free detail for logs / the operator command. */
  detail: string;
  /** The schema postconditions evaluated (null only when the checksum is UNKNOWN/absent). */
  postconditions: ReferralSchemaPostcondition[] | null;
  /** The exact unique-index verification (null only when the checksum is UNKNOWN/absent). */
  indexVerification: ReferralUniqueIndexVerification | null;
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
 * EXACT catalog verification of the `ReferralCommission_orderId_key` UNIQUE index.
 * Ties the index to the resolved table OID via `pg_index.indrelid`, then asserts every
 * required property (unique / valid / ready / no predicate / no expression / a single
 * key column that is exactly `orderId`). Trusting the index NAME alone is insufficient:
 * a unique index of the same name on ANOTHER table, or a partial / expression / wrong-
 * column index, must NOT satisfy the one-commission-per-order guarantee. Read-only.
 */
export async function verifyReferralOrderIdUniqueIndex(schema: string): Promise<ReferralUniqueIndexVerification> {
  const rows = await prisma.$queryRaw<
    Array<{
      index_schema: string;
      indisunique: boolean;
      indisvalid: boolean;
      indisready: boolean;
      no_predicate: boolean;
      no_expression: boolean;
      indnatts: number;
      indnkeyatts: number;
      key_column: string | null;
    }>
  >`
    SELECT
      n.nspname AS index_schema,
      i.indisunique,
      i.indisvalid,
      i.indisready,
      (i.indpred IS NULL) AS no_predicate,
      (i.indexprs IS NULL) AS no_expression,
      i.indnatts::int AS indnatts,
      i.indnkeyatts::int AS indnkeyatts,
      a.attname AS key_column
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = to_regclass(format('%I.%I', ${schema}::text, 'ReferralCommission'))
      AND ic.relname = 'ReferralCommission_orderId_key'`;

  if (rows.length === 0) {
    // No index of that name is bound to the resolved ReferralCommission OID. This also
    // covers "the index was dropped" and "a same-named index exists on another table"
    // (that index has a different indrelid, so it never matches here).
    return {
      ok: false,
      exists: false,
      belongsToReferralCommission: false,
      sameSchema: false,
      isUnique: false,
      isValid: false,
      isReady: false,
      noPredicate: false,
      noExpression: false,
      singleKeyColumn: false,
      targetsOrderId: false,
      detail: "no unique index named ReferralCommission_orderId_key on ReferralCommission",
    };
  }

  const r = rows[0];
  const exists = true;
  const belongsToReferralCommission = true; // enforced by indrelid = to_regclass(...)
  const sameSchema = r.index_schema === schema;
  const isUnique = r.indisunique === true;
  const isValid = r.indisvalid === true;
  const isReady = r.indisready === true;
  const noPredicate = r.no_predicate === true;
  const noExpression = r.no_expression === true;
  const singleKeyColumn = r.indnatts === 1 && r.indnkeyatts === 1;
  const targetsOrderId = r.key_column === "orderId";
  const ok =
    belongsToReferralCommission &&
    sameSchema &&
    isUnique &&
    isValid &&
    isReady &&
    noPredicate &&
    noExpression &&
    singleKeyColumn &&
    targetsOrderId;
  const detail = ok
    ? "exact unique index on ReferralCommission(orderId) verified"
    : `index checks failed: ${[
        !sameSchema && "wrong-schema",
        !isUnique && "not-unique",
        !isValid && "invalid",
        !isReady && "not-ready",
        !noPredicate && "partial",
        !noExpression && "expression",
        !singleKeyColumn && "multi-column",
        !targetsOrderId && "wrong-column",
      ]
        .filter(Boolean)
        .join(",")}`;
  return {
    ok,
    exists,
    belongsToReferralCommission,
    sameSchema,
    isUnique,
    isValid,
    isReady,
    noPredicate,
    noExpression,
    singleKeyColumn,
    targetsOrderId,
    detail,
  };
}

export interface ReferralSchemaPostconditionsResult {
  ok: boolean;
  postconditions: ReferralSchemaPostcondition[];
  /** The exact unique-index verification (null only when the table is absent). */
  indexVerification: ReferralUniqueIndexVerification | null;
  /** The resolved schema that holds ReferralCommission (null when absent). */
  schema: string | null;
}

/**
 * Verifies every required STRUCTURAL schema postcondition of the referral affiliate
 * migration — regardless of which byte form applied it. Migration-attempt state
 * (finished / rolled back / stuck) is NOT part of this: that is the authoritative
 * migration-attempt helper's job (see migration-attempts.ts). Schema-aware (custom
 * search_path safe): the schema name is read from the catalog and passed as a BIND
 * PARAMETER (never concatenated); table-data reads use the unqualified name so
 * search_path resolves it. Read-only; count-only; never touches an order/user id.
 */
export async function checkReferralSchemaPostconditions(): Promise<ReferralSchemaPostconditionsResult> {
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
      "no-duplicate-orderid",
    ]) {
      push(k, false);
    }
    return { ok: false, postconditions: pc, indexVerification: null, schema: null };
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

  // EXACT unique-index verification (§3) — tied to the ReferralCommission OID, exact key.
  const indexVerification = await verifyReferralOrderIdUniqueIndex(schema);
  push("orderid-unique-index", indexVerification.ok);

  const [dupRow] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM (
      SELECT "orderId" FROM "ReferralCommission"
      WHERE "orderId" IS NOT NULL
      GROUP BY "orderId"
      HAVING count(*) > 1
    ) d`;
  push("no-duplicate-orderid", (dupRow?.n ?? 0) === 0);

  return { ok: pc.every((p) => p.ok), postconditions: pc, indexVerification, schema };
}

/**
 * Reads the recorded checksum of the known migration — the LATEST SUCCESSFUL attempt's
 * checksum (finished, not rolled back, ordered by started_at DESC). Never an old failed
 * or rolled-back attempt.
 */
async function readRecordedChecksum(): Promise<string | null> {
  const attempt = await readLatestSuccessfulMigrationAttempt(REFERRAL_AFFILIATE_MIGRATION_NAME);
  return attempt?.checksum ?? null;
}

/**
 * Evaluates the lineage of the ONE known referral migration. Accepts ONLY the four
 * empirically verified historical checksums (ORIGINAL/PR110 × LF/CRLF), and ONLY after
 * every schema postcondition passes (EXACT_MATCH included). Any other recorded checksum
 * is CHECKSUM_DRIFT and is blocked regardless of the current schema. Never edits anything.
 *
 * `providedChecksum` lets the caller pass an already-fetched authoritative recorded
 * checksum (the latest successful attempt's) to avoid a second `_prisma_migrations`
 * query. Pass `undefined` (the default) to have this function read it.
 */
export async function evaluateReferralMigrationLineage(
  migrationsDir: string | null = resolveMigrationsDir(),
  providedChecksum?: string | null,
): Promise<ReferralMigrationLineage> {
  const onDiskChecksum =
    migrationsDir === null
      ? null
      : (() => {
          const file = resolvePath(migrationsDir, REFERRAL_AFFILIATE_MIGRATION_NAME, "migration.sql");
          return existsSync(file) ? readPrismaMigrationChecksum(file) : null;
        })();

  const recordedChecksum = providedChecksum !== undefined ? providedChecksum : await readRecordedChecksum();
  const checksumClass = classifyReferralMigrationChecksum(recordedChecksum);

  const base = {
    recordedChecksum,
    onDiskChecksum,
    checksumClass,
    postconditions: null as ReferralSchemaPostcondition[] | null,
    indexVerification: null as ReferralUniqueIndexVerification | null,
  };

  if (onDiskChecksum === null) {
    return { ...base, status: "FILE_MISSING", activationAllowed: false, legacyVariant: false, detail: "migration file not found on disk" };
  }
  if (checksumClass === "NOT_APPLIED") {
    // Not recorded as a successful attempt — surfaced separately by the migration-attempt
    // gate; treat as drift for the lineage dimension (blocked).
    return { ...base, status: "CHECKSUM_DRIFT", activationAllowed: false, legacyVariant: false, detail: "migration not recorded as a successful attempt" };
  }
  if (checksumClass === "UNKNOWN") {
    // Unknown checksum → blocked REGARDLESS of the current schema (no postconditions).
    return { ...base, status: "CHECKSUM_DRIFT", activationAllowed: false, legacyVariant: false, detail: "recorded checksum is not an empirically verified historical variant" };
  }

  // A KNOWN variant. EVERY accepted lineage must prove the financial schema invariant,
  // so the postconditions run for EXACT_MATCH and legacy variants alike (§4).
  const postconditions = await checkReferralSchemaPostconditions();
  if (!postconditions.ok) {
    return {
      ...base,
      postconditions: postconditions.postconditions,
      indexVerification: postconditions.indexVerification,
      status: "SCHEMA_POSTCONDITION_FAILED",
      activationAllowed: false,
      legacyVariant: false,
      detail: `failed: ${postconditions.postconditions.filter((p) => !p.ok).map((p) => p.key).join(",")}`,
    };
  }

  const isCurrentOnDisk = checksumClass === REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT && recordedChecksum === onDiskChecksum;
  if (isCurrentOnDisk) {
    return {
      ...base,
      postconditions: postconditions.postconditions,
      indexVerification: postconditions.indexVerification,
      status: "EXACT_MATCH",
      activationAllowed: true,
      legacyVariant: false,
      detail: "on-disk checksum matches recorded and schema postconditions pass",
    };
  }
  return {
    ...base,
    postconditions: postconditions.postconditions,
    indexVerification: postconditions.indexVerification,
    status: "KNOWN_COMPATIBLE_LEGACY_VARIANT",
    activationAllowed: true,
    legacyVariant: true,
    detail: `known compatible ${checksumClass} lineage with valid schema`,
  };
}
