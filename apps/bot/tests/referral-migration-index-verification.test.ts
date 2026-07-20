import { prisma, verifyReferralOrderIdUniqueIndex } from "@zedbot/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-index-tests-secret-0123456789";

// =============================================================================
// §3 — EXACT catalog verification of ReferralCommission_orderId_key. Runs against an
// ISOLATED custom schema holding a minimal `ReferralCommission` table, so every index
// shape (missing / non-unique / invalid / partial / expression / wrong-column /
// multi-column / same-name-on-another-table) can be constructed without touching the
// real public table. This also exercises the custom-schema resolution path.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const SCHEMA = `refidx_test_${process.pid}`;
const IDX = "ReferralCommission_orderId_key";

async function dropIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${SCHEMA}"."${IDX}"`);
}
async function makeIndex(sql: string): Promise<void> {
  await dropIndex();
  await prisma.$executeRawUnsafe(sql);
}

d("exact unique-index verification (§3)", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${SCHEMA}"."ReferralCommission" ("id" text NOT NULL, "orderId" text)`,
    );
    await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."Decoy" ("orderId" text)`);
  });
  afterEach(async () => {
    await dropIndex();
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${SCHEMA}"."${IDX}_decoy"`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${SCHEMA}"."${IDX}"`);
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await prisma.$disconnect();
  });

  it("a correct unique index on ReferralCommission(orderId) passes", async () => {
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(true);
    expect(v.exists).toBe(true);
    expect(v.belongsToReferralCommission).toBe(true);
    expect(v.isUnique && v.isValid && v.isReady).toBe(true);
    expect(v.noPredicate && v.noExpression).toBe(true);
    expect(v.singleKeyColumn && v.targetsOrderId).toBe(true);
  });

  it("a missing index fails (exists = false)", async () => {
    await dropIndex();
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.exists).toBe(false);
  });

  it("a non-unique index of the right name fails", async () => {
    await makeIndex(`CREATE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.isUnique).toBe(false);
  });

  it("an INVALID index fails (indisvalid = false)", async () => {
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId")`);
    // Force indisvalid = false directly in the catalog (simulates a failed CONCURRENTLY build).
    await prisma.$executeRawUnsafe(
      `UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = to_regclass('"${SCHEMA}"."${IDX}"')`,
    );
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.isValid).toBe(false);
  });

  it("a partial unique index (has a predicate) fails", async () => {
    await makeIndex(
      `CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId") WHERE "orderId" IS NOT NULL`,
    );
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.noPredicate).toBe(false);
  });

  it("an expression index fails", async () => {
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"(lower("orderId"))`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.noExpression).toBe(false);
  });

  it("a unique index on the WRONG column fails", async () => {
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("id")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.targetsOrderId).toBe(false);
  });

  it("a multi-column unique index fails (must be exactly one key column)", async () => {
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId", "id")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    expect(v.singleKeyColumn).toBe(false);
  });

  it("a same-NAMED unique index on ANOTHER table does not satisfy the check", async () => {
    // The real ReferralCommission index is dropped; an index of the same name exists on Decoy.
    await dropIndex();
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."Decoy"("orderId")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(false);
    // It is not bound to the ReferralCommission OID, so we treat it as absent.
    expect(v.exists).toBe(false);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${SCHEMA}"."${IDX}"`);
  });

  it("works against a custom (non-public) PostgreSQL schema", async () => {
    // The whole suite already runs in a custom schema; assert the resolved schema matches.
    await makeIndex(`CREATE UNIQUE INDEX "${IDX}" ON "${SCHEMA}"."ReferralCommission"("orderId")`);
    const v = await verifyReferralOrderIdUniqueIndex(SCHEMA);
    expect(v.ok).toBe(true);
    expect(v.sameSchema).toBe(true);
  });
});
