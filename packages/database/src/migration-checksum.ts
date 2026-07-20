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

/**
 * Prisma checksum of the ORIGINAL PR #108 form — also the current, restored on-disk
 * form. Equals sha256 of the raw LF file bytes; verified == `_prisma_migrations.checksum`.
 */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL =
  "eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59";

/**
 * Prisma checksum of the PR #110 form — identical FINAL schema, plus an embedded
 * duplicate-orderId preflight block. A database that applied that variant stores THIS
 * checksum. Verified == `_prisma_migrations.checksum`.
 */
export const REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110 =
  "9acc8e3b5e2720a1bc1166c08a3ced30a7108f21eee11b654943d07e6a44a970";

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
