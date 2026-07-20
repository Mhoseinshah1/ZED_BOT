import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prisma } from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-preflight-tests-secret-0123456789";

import { runReferralMigrationPreflight } from "../../../packages/database/src/referral-migration-preflight.js";

// =============================================================================
// §4 — the applied migration is RESTORED to its immutable PR #108 original, and the
// duplicate check runs as a SEPARATE deployment preflight (before `migrate deploy`).
// The DB-backed cases need a migrated database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const MIGRATION_SQL = fileURLToPath(
  new URL(
    "../../../packages/database/prisma/migrations/20260719180000_referral_affiliate_commissions/migration.sql",
    import.meta.url,
  ),
);
const MIGRATE_SH = fileURLToPath(new URL("../../../scripts/migrate.sh", import.meta.url));
const PREFLIGHT_SH = fileURLToPath(new URL("../../../scripts/referral-migration-preflight.sh", import.meta.url));

describe("referral migration preflight — static contract (§4)", () => {
  it("the applied migration is restored to its original (no in-migration preflight)", () => {
    const sql = readFileSync(MIGRATION_SQL, "utf8");
    expect(sql).toContain('CREATE UNIQUE INDEX "ReferralCommission_orderId_key"');
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
    expect(sql).not.toMatch(/DO \$\$/);
  });

  it("the deploy runs the preflight BEFORE prisma migrate deploy", () => {
    const sh = readFileSync(MIGRATE_SH, "utf8");
    const preflightIdx = sh.indexOf("referral-migration-preflight.js");
    const deployIdx = sh.indexOf("prisma migrate deploy");
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(deployIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeLessThan(deployIdx);
  });

  it("a standalone preflight script exists", () => {
    const sh = readFileSync(PREFLIGHT_SH, "utf8");
    expect(sh).toContain("referral-migration-preflight.js");
  });
});

d("referral migration preflight — runtime behaviour (§4)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("the applied migration checksum equals the on-disk file's SHA-256 (immutable history)", async () => {
    const diskSha = createHash("sha256").update(readFileSync(MIGRATION_SQL, "utf8")).digest("hex");
    const rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM _prisma_migrations
      WHERE migration_name = '20260719180000_referral_affiliate_commissions'`;
    expect(rows[0]?.checksum).toBe(diskSha);
  });

  it("succeeds (exit 0) on a clean table and mutates nothing", async () => {
    const before = await prisma.referralCommission.count();
    const beforeTx = await prisma.walletTransaction.count();
    const code = await runReferralMigrationPreflight(prisma);
    expect(code).toBe(0);
    // Read-only: no rows added or removed.
    expect(await prisma.referralCommission.count()).toBe(before);
    expect(await prisma.walletTransaction.count()).toBe(beforeTx);
  });

  it("the duplicate-detection SQL flags duplicate non-null orderIds (probe table)", async () => {
    // The real table carries the unique index, so real duplicates are impossible;
    // exercise the exact detection aggregate against a temporary probe table to prove
    // it fires on the legacy-duplicate state the preflight guards against.
    const n = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE pf_probe ("orderId" text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO pf_probe VALUES ('o1'),('o1'),('o2'),(NULL),(NULL)`);
      const rows = await tx.$queryRawUnsafe<Array<{ dup_groups: bigint }>>(`
        SELECT count(*)::bigint AS dup_groups FROM (
          SELECT "orderId" FROM pf_probe WHERE "orderId" IS NOT NULL GROUP BY "orderId" HAVING count(*) > 1
        ) d`);
      return Number(rows[0]?.dup_groups ?? 0n);
    });
    expect(n).toBe(1); // only 'o1' is duplicated; NULLs are excluded
  });
});
