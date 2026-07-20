import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// =============================================================================
// Prisma migration checksum — ONE tested helper that matches the INSTALLED Prisma
// version (6.19.3) EXACTLY.
//
// Empirically verified against real `prisma migrate deploy` + `_prisma_migrations`:
//   - the recorded checksum is the lowercase hex SHA-256 of the RAW file bytes;
//   - Prisma does NOT normalize line endings — a CRLF file records the CRLF-bytes
//     hash, a LF file records the LF-bytes hash (they differ). So this helper must
//     NOT normalize either, or it would disagree with a genuinely CRLF-applied
//     migration.
// (See docs/referral-migration-lineage.md for the full audit + the LF `.gitattributes`
// pin that keeps on-disk bytes LF on every platform.)
// =============================================================================

/** The referral affiliate migration shipped in two historical byte forms. */
export const REFERRAL_AFFILIATE_MIGRATION_NAME = "20260719180000_referral_affiliate_commissions";

// -----------------------------------------------------------------------------
// The NARROWLY SCOPED, EMPIRICALLY VERIFIED historical checksum allowlist.
//
// `20260719180000` was deployed in two logical SQL forms — the PR #108 ORIGINAL and
// the PR #110 variant (embedded duplicate-orderId preflight) — with an IDENTICAL
// final schema. Each form could have been applied from an LF checkout OR a CRLF
// checkout (Windows autocrlf), and Prisma records the raw-byte SHA-256 with NO
// line-ending normalization, so each (form × line-ending) records a DISTINCT
// checksum. All four below were computed from the exact historical bytes AND
// verified against the value `prisma migrate deploy` actually records in
// `_prisma_migrations.checksum` on real PostgreSQL 16 (see
// docs/referral-migration-lineage.md §1). Nothing outside this list is accepted.
// -----------------------------------------------------------------------------

/** ORIGINAL PR #108 form, LF line endings — ALSO the current restored on-disk file. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF =
  "eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59";

/** ORIGINAL PR #108 form applied from a CRLF checkout. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF =
  "ae972ad361bd060432a3aa030e0597b91b0bbf4a0bfee2f12e71b0fc27200447";

/** PR #110 form (embedded preflight), LF line endings. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF =
  "9acc8e3b5e2720a1bc1166c08a3ced30a7108f21eee11b654943d07e6a44a970";

/** PR #110 form applied from a CRLF checkout. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF =
  "00f1687433b4424e632d87b9c4a23741f6b3632ef81c37f0eb5abdb3e6ea5254";

/**
 * Back-compat aliases (the LF forms are the canonical "original"/"PR110" checksums).
 * @deprecated prefer the explicit `_LF` / `_CRLF` constants.
 */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL = REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF;
/** @deprecated prefer the explicit `_LF` / `_CRLF` constants. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110 = REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF;

/** The empirically verified historical byte variants (the only accepted checksums). */
export type ReferralMigrationChecksumVariant = "ORIGINAL_LF" | "ORIGINAL_CRLF" | "PR110_LF" | "PR110_CRLF";

/** Recorded-checksum classification, including the two non-accepted terminals. */
export type ReferralMigrationChecksumClass = ReferralMigrationChecksumVariant | "UNKNOWN" | "NOT_APPLIED";

/** checksum → variant. The authoritative allowlist; anything absent is UNKNOWN. */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST: Readonly<Record<ReferralMigrationChecksumVariant, string>> =
  Object.freeze({
    ORIGINAL_LF: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF,
    ORIGINAL_CRLF: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF,
    PR110_LF: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF,
    PR110_CRLF: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF,
  });

/** The ONE variant that equals the current on-disk file (an EXACT_MATCH candidate). */
export const REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT: ReferralMigrationChecksumVariant = "ORIGINAL_LF";

/**
 * Classifies a recorded checksum against the empirically verified allowlist. Returns
 * NOT_APPLIED for null, the matching variant for a known checksum, or UNKNOWN for any
 * other value (which the activation gate blocks regardless of the current schema).
 */
export function classifyReferralMigrationChecksum(recorded: string | null): ReferralMigrationChecksumClass {
  if (recorded === null) return "NOT_APPLIED";
  for (const [variant, checksum] of Object.entries(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST)) {
    if (checksum === recorded) return variant as ReferralMigrationChecksumVariant;
  }
  return "UNKNOWN";
}

/**
 * Computes the Prisma migration checksum for the given file CONTENT exactly as the
 * installed Prisma version does: lowercase hex SHA-256 of the RAW bytes, with NO
 * line-ending normalization. Accepts a Buffer (raw bytes, preferred) or a string
 * (hashed as UTF-8 — identical for the ASCII migration files).
 */
export function prismaMigrationChecksum(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Reads a migration.sql file as RAW BYTES and returns its Prisma checksum. */
export function readPrismaMigrationChecksum(filePath: string): string {
  return prismaMigrationChecksum(readFileSync(filePath));
}
