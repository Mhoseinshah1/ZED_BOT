import { PrismaClient, prisma } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-preflight-schema-tests-secret-0123456789";

import { runReferralMigrationPreflight } from "../../../packages/database/src/referral-migration-preflight.js";

// =============================================================================
// §5 — the preflight must resolve ReferralCommission through the connection's
// search_path (public OR a configured custom schema), pass on a fresh database
// where the table is absent, and detect duplicates wherever the table lives.
// Needs a migrated database.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const CUSTOM = "ref_preflight_custom";
const EMPTY = "ref_preflight_empty";

function urlForSchema(schema: string): string {
  const base = (process.env.DATABASE_URL ?? "").replace(/([?&])schema=[^&]*/i, "").replace(/[?&]$/, "");
  return `${base}${base.includes("?") ? "&" : "?"}schema=${schema}`;
}

d("referral migration preflight — custom schema support (§5)", () => {
  let customClient: PrismaClient;
  let emptyClient: PrismaClient;

  beforeAll(async () => {
    // A custom schema WITH a ReferralCommission table (no unique index, so we can seed
    // duplicates), and an EMPTY schema with no table at all.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${CUSTOM}"`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${EMPTY}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${CUSTOM}"."ReferralCommission"`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${CUSTOM}"."ReferralCommission" ("orderId" text)`);
    customClient = new PrismaClient({ datasourceUrl: urlForSchema(CUSTOM) });
    emptyClient = new PrismaClient({ datasourceUrl: urlForSchema(EMPTY) });
  });

  afterAll(async () => {
    await customClient.$disconnect().catch(() => undefined);
    await emptyClient.$disconnect().catch(() => undefined);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${CUSTOM}" CASCADE`);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${EMPTY}" CASCADE`);
    await prisma.$disconnect();
  });

  it("public schema, no duplicates → OK (exit 0)", async () => {
    expect(await runReferralMigrationPreflight(prisma)).toBe(0);
  });

  it("absent table (fresh database / empty schema) → OK (exit 0)", async () => {
    expect(await runReferralMigrationPreflight(emptyClient)).toBe(0);
  });

  it("custom schema, no duplicates → OK (exit 0)", async () => {
    await customClient.$executeRawUnsafe(`TRUNCATE "${CUSTOM}"."ReferralCommission"`);
    await customClient.$executeRawUnsafe(`INSERT INTO "ReferralCommission" ("orderId") VALUES ('o1'),('o2'),(NULL)`);
    expect(await runReferralMigrationPreflight(customClient)).toBe(0);
  });

  it("custom schema WITH duplicate orderIds → FAILS (exit 1), read-only", async () => {
    await customClient.$executeRawUnsafe(`TRUNCATE "${CUSTOM}"."ReferralCommission"`);
    await customClient.$executeRawUnsafe(`INSERT INTO "ReferralCommission" ("orderId") VALUES ('dup'),('dup'),('o3'),(NULL),(NULL)`);
    const before = await customClient.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "ReferralCommission"`);
    expect(await runReferralMigrationPreflight(customClient)).toBe(1);
    // Preflight is read-only — the row count is unchanged.
    const after = await customClient.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "ReferralCommission"`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("resolves the table via search_path (custom schema), not a hardcoded public prefix", async () => {
    // Sanity: the unqualified `to_regclass` resolves to the CUSTOM schema for this
    // connection (its search_path), proving the preflight is schema-agnostic.
    const rows = await customClient.$queryRawUnsafe<Array<{ schema: string | null }>>(
      `SELECT n.nspname AS schema FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = to_regclass('"ReferralCommission"')`,
    );
    expect(rows[0]?.schema).toBe(CUSTOM);
  });
});
