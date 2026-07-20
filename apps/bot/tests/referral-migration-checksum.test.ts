import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  prisma,
  prismaMigrationChecksum,
  readPrismaMigrationChecksum,
} from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-checksum-tests-secret-0123456789";

// =============================================================================
// §6 (checksum helper matches Prisma exactly) + §2 (the migration file is immutable).
// Prisma 6.19.3 records the SHA-256 of the RAW file bytes (NO line-ending
// normalization — verified empirically). The helper must do the same.
// =============================================================================

const MIGRATION_SQL = fileURLToPath(
  new URL(
    `../../../packages/database/prisma/migrations/${REFERRAL_AFFILIATE_MIGRATION_NAME}/migration.sql`,
    import.meta.url,
  ),
);

describe("prisma migration checksum helper (§6)", () => {
  it("is the lowercase hex SHA-256 of the raw bytes", () => {
    const content = Buffer.from("CREATE TABLE foo (id int);\n", "utf8");
    expect(prismaMigrationChecksum(content)).toBe(createHash("sha256").update(content).digest("hex"));
    expect(prismaMigrationChecksum(content)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT normalize line endings — LF and CRLF differ (matches real Prisma)", () => {
    const lf = "line1\nline2\n";
    const crlf = "line1\r\nline2\r\n";
    expect(prismaMigrationChecksum(lf)).not.toBe(prismaMigrationChecksum(crlf));
    // Each equals the raw-bytes SHA-256 of its own form.
    expect(prismaMigrationChecksum(crlf)).toBe(createHash("sha256").update(Buffer.from(crlf, "utf8")).digest("hex"));
  });

  it("distinguishes a trailing newline present vs absent", () => {
    expect(prismaMigrationChecksum("SELECT 1;\n")).not.toBe(prismaMigrationChecksum("SELECT 1;"));
  });

  it("hashes UTF-8 content by its bytes", () => {
    const utf8 = "-- تست یونیکد ✅\nSELECT 1;\n";
    expect(prismaMigrationChecksum(utf8)).toBe(createHash("sha256").update(Buffer.from(utf8, "utf8")).digest("hex"));
    // Buffer and string inputs of identical bytes agree.
    expect(prismaMigrationChecksum(Buffer.from(utf8, "utf8"))).toBe(prismaMigrationChecksum(utf8));
  });
});

describe("referral affiliate migration is immutable (§2)", () => {
  it("the committed file's SHA-256 equals the pinned original checksum (fails if edited)", () => {
    const onDisk = createHash("sha256").update(readFileSync(MIGRATION_SQL)).digest("hex");
    expect(onDisk).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL);
    expect(onDisk).toBe("eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59");
    // And the two known lineage checksums are distinct.
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL).not.toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110);
  });

  it("the file is LF-only (no CRLF) so its raw-byte checksum is stable cross-platform", () => {
    expect(readFileSync(MIGRATION_SQL).includes(Buffer.from("\r\n"))).toBe(false);
  });
});

import {
  classifyRecordedChecksum,
  printReferralMigrationLineageStatus,
} from "../../../packages/database/src/referral-migration-lineage-status.js";

describe("lineage-status classification (§4, pure)", () => {
  it("classifies the recorded checksum", () => {
    expect(classifyRecordedChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL)).toBe("ORIGINAL");
    expect(classifyRecordedChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110)).toBe("PR110_COMPATIBLE");
    expect(classifyRecordedChecksum("f".repeat(64))).toBe("UNKNOWN");
    expect(classifyRecordedChecksum(null)).toBe("NOT_APPLIED");
  });
});

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
(hasDb ? describe : describe.skip)("checksum helper matches the value Prisma actually recorded (§6)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("readPrismaMigrationChecksum(on-disk file) == _prisma_migrations.checksum", async () => {
    const rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM _prisma_migrations WHERE migration_name = ${REFERRAL_AFFILIATE_MIGRATION_NAME}`;
    expect(rows[0]?.checksum).toBe(readPrismaMigrationChecksum(MIGRATION_SQL));
    expect(rows[0]?.checksum).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL);
  });

  it("the lineage-status command prints an ORIGINAL verdict with NO ids / credentials", async () => {
    const lines: string[] = [];
    const code = await printReferralMigrationLineageStatus((l) => lines.push(l));
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("classification:     ORIGINAL");
    expect(out).toContain("lineage status:     EXACT_MATCH");
    // PII-safe: never a connection string, order id or uuid.
    expect(out).not.toMatch(/postgres(ql)?:\/\//i);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
