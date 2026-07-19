import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prisma } from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-guard-tests-secret-0123456789";

// =============================================================================
// S7 — ReferralCommission.orderId uniqueness MIGRATION SAFETY. The guard migration
// must detect duplicate NON-NULL orderId values before (re-)enforcing uniqueness,
// fail loudly on real duplicates, and be a safe no-op on clean / legacy / nullable
// data. Here we exercise the exact preflight detection SQL against a temporary
// probe table in the four required database states, prove the RAISE fires on
// duplicates, and assert the real table upholds the invariant.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const GUARD_MIGRATION = fileURLToPath(
  new URL(
    "../../../packages/database/prisma/migrations/20260720121000_referral_commission_orderid_unique_guard/migration.sql",
    import.meta.url,
  ),
);

/** The exact duplicate-detection query the guard migration runs, retargeted at a probe table. */
const DUP_COUNT_SQL = (table: string): string => `
  SELECT count(*)::int AS n FROM (
    SELECT "orderId" FROM ${table}
    WHERE "orderId" IS NOT NULL
    GROUP BY "orderId"
    HAVING count(*) > 1
  ) dup`;

d("referral commission orderId unique guard migration", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function dupGroups(tx: { $queryRawUnsafe: (sql: string) => Promise<Array<{ n: number }>> }, table: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe(DUP_COUNT_SQL(table));
    return rows[0]?.n ?? 0;
  }

  it("detects zero duplicates on clean / legacy / nullable data, and one on a real duplicate", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ref_guard_probe ("orderId" text) ON COMMIT DROP`);
      // clean (empty)
      expect(await dupGroups(tx, "ref_guard_probe")).toBe(0);
      // populated legacy DB, no duplicates
      await tx.$executeRawUnsafe(`INSERT INTO ref_guard_probe VALUES ('o1'),('o2'),('o3')`);
      expect(await dupGroups(tx, "ref_guard_probe")).toBe(0);
      // nullable orderId rows are excluded (never a false positive)
      await tx.$executeRawUnsafe(`INSERT INTO ref_guard_probe VALUES (NULL),(NULL)`);
      expect(await dupGroups(tx, "ref_guard_probe")).toBe(0);
      // a real duplicate non-null orderId is detected
      await tx.$executeRawUnsafe(`INSERT INTO ref_guard_probe VALUES ('o1')`);
      expect(await dupGroups(tx, "ref_guard_probe")).toBe(1);
    });
  });

  it("the guard RAISEs an explicit error when duplicates exist", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE ref_guard_raise ("orderId" text) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO ref_guard_raise VALUES ('dup'),('dup')`);
        await tx.$executeRawUnsafe(`
          DO $$
          DECLARE d int;
          BEGIN
            SELECT count(*) INTO d FROM (
              SELECT "orderId" FROM ref_guard_raise WHERE "orderId" IS NOT NULL GROUP BY "orderId" HAVING count(*) > 1
            ) x;
            IF d > 0 THEN
              RAISE EXCEPTION 'ReferralCommission has % order id(s) carrying duplicate commission rows', d;
            END IF;
          END $$;`);
      }),
    ).rejects.toThrow(/duplicate commission rows/);
  });

  it("passes cleanly when no duplicates exist (idempotent re-run)", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE ref_guard_ok ("orderId" text) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO ref_guard_ok VALUES ('a'),('b'),(NULL)`);
        await tx.$executeRawUnsafe(`
          DO $$
          DECLARE d int;
          BEGIN
            SELECT count(*) INTO d FROM (
              SELECT "orderId" FROM ref_guard_ok WHERE "orderId" IS NOT NULL GROUP BY "orderId" HAVING count(*) > 1
            ) x;
            IF d > 0 THEN RAISE EXCEPTION 'unexpected'; END IF;
          END $$;`);
      }),
    ).resolves.toBeUndefined();
  });

  it("the shipped guard migration fails loudly and re-asserts the unique index", () => {
    const sql = readFileSync(GUARD_MIGRATION, "utf8");
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/HAVING count\(\*\) > 1/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_orderId_key"/);
  });

  it("the real ReferralCommission table upholds the one-commission-per-order invariant", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(DUP_COUNT_SQL('"ReferralCommission"'));
    expect(rows[0]?.n ?? 0).toBe(0);
  });
});
