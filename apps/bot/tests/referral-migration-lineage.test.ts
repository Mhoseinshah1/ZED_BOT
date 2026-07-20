import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OrderStatus,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  ReferralCommissionStatus,
  evaluateReferralMigrationLineage,
  prisma,
  resolveMigrationsDir,
  type Order,
  type Referral,
  type User,
} from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_EXECUTE_HEARTBEAT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_PAYOUT_WINDOWS_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
  WORKER_HEARTBEAT_KEY,
  getRedisOptions,
} from "@zedbot/shared";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-lineage-tests-secret-0123456789";

import {
  assessReferralActivationReadiness,
  enableReferralPayoutsGated,
  getReferralMigrationHistory,
} from "../src/services/referral-activation.service.js";
import { disableReferralPayouts, isReferralSystemEnabled } from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// §3/§4/§5/§10 — dual-lineage activation. Needs a migrated database (and Redis for the
// gate-integration block). Some tests temporarily rewrite the recorded checksum, drop the
// unique index, or insert synthetic _prisma_migrations rows to construct the failure
// states; every one restores.
// =============================================================================

const redisOptions = getRedisOptions();
const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const dg = hasDb && redisOptions !== null ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

async function setRecorded(checksum: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name=$2 AND rolled_back_at IS NULL`,
    checksum,
    REFERRAL_AFFILIATE_MIGRATION_NAME,
  );
}
async function restoreRecorded(): Promise<void> {
  await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
}
async function dropUniqueIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "ReferralCommission_orderId_key"`);
}
async function restoreUniqueIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId")`,
  );
}

const KNOWN_LEGACY_VARIANTS: Array<[string, string]> = [
  ["PR110_LF", REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF],
  ["ORIGINAL_CRLF", REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF],
  ["PR110_CRLF", REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF],
];

d("referral migration lineage evaluator (§3/§4/§5)", () => {
  let seq = 0;
  afterEach(async () => {
    await restoreRecorded();
    await restoreUniqueIndex();
  });
  afterAll(async () => {
    await restoreRecorded();
    await restoreUniqueIndex();
    await prisma.$disconnect();
  });

  async function makeCommissionable(): Promise<{ referral: Referral; referred: User; order: Order }> {
    seq += 1;
    const referrer = await prisma.user.create({ data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F" } });
    seq += 1;
    const referred = await prisma.user.create({ data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F" } });
    const referral = await prisma.referral.create({ data: { referrerUserId: referrer.id, referredUserId: referred.id } });
    seq += 1;
    const order = await prisma.order.create({
      data: { userId: referred.id, type: "SERVICE_PURCHASE", status: OrderStatus.COMPLETED, finalPriceToman: 100_000, completedAt: new Date() },
    });
    return { referral, referred, order };
  }

  it("the resolver finds the shipped migrations directory (never null in this repo)", () => {
    expect(resolveMigrationsDir()).not.toBeNull();
  });

  it("ORIGINAL_LF lineage → EXACT_MATCH (allowed, no warning, postconditions pass)", async () => {
    const l = await evaluateReferralMigrationLineage();
    expect(l.status).toBe("EXACT_MATCH");
    expect(l.activationAllowed).toBe(true);
    expect(l.legacyVariant).toBe(false);
    expect(l.checksumClass).toBe("ORIGINAL_LF");
    expect(l.postconditions?.every((p) => p.ok)).toBe(true);
    expect(l.indexVerification?.ok).toBe(true);
  });

  it.each(KNOWN_LEGACY_VARIANTS)(
    "%s recorded checksum + valid schema → KNOWN_COMPATIBLE_LEGACY_VARIANT (warning)",
    async (_name, checksum) => {
      await setRecorded(checksum);
      const l = await evaluateReferralMigrationLineage();
      expect(l.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
      expect(l.activationAllowed).toBe(true);
      expect(l.legacyVariant).toBe(true);
      expect(l.postconditions?.every((p) => p.ok)).toBe(true);
    },
  );

  it("an UNKNOWN recorded checksum → CHECKSUM_DRIFT (blocks, no postconditions run)", async () => {
    await setRecorded("deadbeef".repeat(8));
    const l = await evaluateReferralMigrationLineage();
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
    expect(l.checksumClass).toBe("UNKNOWN");
    // Unknown is blocked REGARDLESS of the schema — postconditions are not consulted.
    expect(l.postconditions).toBeNull();
  });

  it("§4: EXACT_MATCH but a manually dropped unique index → SCHEMA_POSTCONDITION_FAILED (blocks)", async () => {
    await dropUniqueIndex();
    try {
      const l = await evaluateReferralMigrationLineage();
      expect(l.status).toBe("SCHEMA_POSTCONDITION_FAILED");
      expect(l.activationAllowed).toBe(false);
      expect(l.postconditions?.find((p) => p.key === "orderid-unique-index")?.ok).toBe(false);
      expect(l.indexVerification?.ok).toBe(false);
    } finally {
      await restoreUniqueIndex();
    }
  });

  it.each(KNOWN_LEGACY_VARIANTS)(
    "§4: %s lineage with a broken schema → SCHEMA_POSTCONDITION_FAILED (blocks)",
    async (_name, checksum) => {
      await setRecorded(checksum);
      await dropUniqueIndex();
      try {
        const l = await evaluateReferralMigrationLineage();
        expect(l.status).toBe("SCHEMA_POSTCONDITION_FAILED");
        expect(l.activationAllowed).toBe(false);
      } finally {
        await restoreUniqueIndex();
      }
    },
  );

  it("known checksum but a NON-unique index → SCHEMA_POSTCONDITION_FAILED", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF);
    try {
      await prisma.$executeRawUnsafe(`DROP INDEX "ReferralCommission_orderId_key"`);
      await prisma.$executeRawUnsafe(`CREATE INDEX "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId")`);
      const l = await evaluateReferralMigrationLineage();
      expect(l.status).toBe("SCHEMA_POSTCONDITION_FAILED");
      expect(l.indexVerification?.isUnique).toBe(false);
      expect(l.postconditions?.find((p) => p.key === "orderid-unique-index")?.ok).toBe(false);
    } finally {
      await dropUniqueIndex();
      await restoreUniqueIndex();
    }
  });

  it("known checksum but a DUPLICATE orderId → SCHEMA_POSTCONDITION_FAILED", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF);
    const { referral, referred, order } = await makeCommissionable();
    try {
      await prisma.$executeRawUnsafe(`DROP INDEX "ReferralCommission_orderId_key"`);
      for (const status of [ReferralCommissionStatus.PAID, ReferralCommissionStatus.CANCELLED]) {
        await prisma.referralCommission.create({
          data: {
            referralId: referral.id,
            referrerUserId: referral.referrerUserId,
            referredUserId: referred.id,
            orderId: order.id,
            amountToman: 0,
            percent: 0,
            status,
          },
        });
      }
      const l = await evaluateReferralMigrationLineage();
      expect(l.status).toBe("SCHEMA_POSTCONDITION_FAILED");
      expect(l.postconditions?.find((p) => p.key === "no-duplicate-orderid")?.ok).toBe(false);
    } finally {
      await prisma.referralCommission.deleteMany({ where: { orderId: order.id } });
      await restoreUniqueIndex();
    }
  });

  it("§7: a provided recorded checksum is used verbatim (no second _prisma_migrations read)", async () => {
    // Even though the DB records ORIGINAL_LF, passing a legacy checksum drives the legacy path.
    const l = await evaluateReferralMigrationLineage(undefined, REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF);
    expect(l.recordedChecksum).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF);
    expect(l.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
  });
});

// =============================================================================
// §1 — the SHIPPED on-disk file must ALWAYS be the canonical current bytes. Historical
// compatibility applies only to the RECORDED checksum, never to arbitrary on-disk bytes.
// These tests point the evaluator at temp migration dirs holding modified files; the
// live schema (real migrated DB) stays intact, so a modified file must STILL block.
// =============================================================================
d("on-disk migration file integrity (§1)", () => {
  const canonicalFile = join(resolveMigrationsDir() ?? "", REFERRAL_AFFILIATE_MIGRATION_NAME, "migration.sql");

  function mkMigrationsDir(bytes: Buffer | "CANONICAL"): string {
    const dir = mkdtempSync(join(tmpdir(), "ondisk-mig-"));
    mkdirSync(join(dir, REFERRAL_AFFILIATE_MIGRATION_NAME), { recursive: true });
    const file = join(dir, REFERRAL_AFFILIATE_MIGRATION_NAME, "migration.sql");
    if (bytes === "CANONICAL") copyFileSync(canonicalFile, file);
    else writeFileSync(file, bytes);
    return dir;
  }
  const lf = (): Buffer => readFileSync(canonicalFile);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("canonical file + ORIGINAL_LF recorded → EXACT_MATCH (allowed, no warning)", async () => {
    const l = await evaluateReferralMigrationLineage(mkMigrationsDir("CANONICAL"), REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(l.status).toBe("EXACT_MATCH");
    expect(l.activationAllowed).toBe(true);
    expect(l.legacyVariant).toBe(false);
  });

  it.each(KNOWN_LEGACY_VARIANTS)(
    "canonical file + %s recorded → KNOWN_COMPATIBLE_LEGACY_VARIANT (allowed, warning)",
    async (_name, checksum) => {
      const l = await evaluateReferralMigrationLineage(mkMigrationsDir("CANONICAL"), checksum);
      expect(l.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
      expect(l.activationAllowed).toBe(true);
      expect(l.legacyVariant).toBe(true);
    },
  );

  it("canonical file + UNKNOWN recorded → CHECKSUM_DRIFT (blocked)", async () => {
    const l = await evaluateReferralMigrationLineage(mkMigrationsDir("CANONICAL"), "f".repeat(64));
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
  });

  it("appended comment on disk → CHECKSUM_DRIFT even with an allowlisted recorded checksum (the P1 case)", async () => {
    const appended = mkMigrationsDir(Buffer.concat([lf(), Buffer.from("\n-- harmless-looking appended comment\n")]));
    for (const recorded of [
      REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF,
      REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF,
      REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF,
    ]) {
      const l = await evaluateReferralMigrationLineage(appended, recorded);
      expect(l.status).toBe("CHECKSUM_DRIFT");
      expect(l.activationAllowed).toBe(false);
      expect(l.legacyVariant).toBe(false);
    }
  });

  it("a CRLF current on-disk file → CHECKSUM_DRIFT", async () => {
    const crlf = mkMigrationsDir(Buffer.from(lf().toString("latin1").replace(/\n/g, "\r\n"), "latin1"));
    const l = await evaluateReferralMigrationLineage(crlf, REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
  });

  it("a whitespace-only on-disk modification → CHECKSUM_DRIFT", async () => {
    const ws = mkMigrationsDir(Buffer.concat([lf(), Buffer.from("   ")]));
    const l = await evaluateReferralMigrationLineage(ws, REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
  });

  it("modified SQL on disk → CHECKSUM_DRIFT", async () => {
    const sqlmod = mkMigrationsDir(Buffer.from(lf().toString("utf8").replace("CREATE", "create"), "utf8"));
    const l = await evaluateReferralMigrationLineage(sqlmod, REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
  });

  it("an altered file blocks BEFORE the schema postconditions run (they never mask it)", async () => {
    // Recorded checksum is a known legacy variant and the live schema is intact, yet the
    // modified on-disk bytes must still block — and without even consulting the schema.
    const appended = mkMigrationsDir(Buffer.concat([lf(), Buffer.from("\n-- x\n")]));
    const l = await evaluateReferralMigrationLineage(appended, REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF);
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.postconditions).toBeNull();
  });
});

dg("dual-lineage activation gate integration (§3/§4/§10)", () => {
  let redis: Redis | null = null;
  function client(): Redis {
    if (redis === null) {
      const o = getRedisOptions();
      redis = new Redis({ host: o?.host, port: o?.port, password: o?.password, maxRetriesPerRequest: null });
    }
    return redis;
  }
  async function writeFreshHeartbeats(): Promise<void> {
    const now = new Date().toISOString();
    await client().set(WORKER_HEARTBEAT_KEY, now, "EX", 45);
    await client().set(REFERRAL_EXECUTE_HEARTBEAT_KEY, now, "EX", 45);
  }
  async function resetSettings(): Promise<void> {
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            REFERRAL_SYSTEM_ENABLED_KEY,
            REFERRAL_COMMISSIONS_STARTED_AT_KEY,
            REFERRAL_PAYOUT_WINDOWS_KEY,
            REFERRAL_COMMISSION_PERCENT_KEY,
            REFERRAL_FIRST_PURCHASE_ONLY_KEY,
            REFERRAL_MIN_PURCHASE_TOMAN_KEY,
          ],
        },
      },
    });
    clearSettingsCache();
  }
  async function clearSyntheticMigrations(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE id LIKE 'lineage-gate-test-%'`,
    );
    // Any extra rows for the referral migration beyond the single real applied one.
    await prisma.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE id LIKE 'lineage-gate-rb-%'`,
    );
  }

  beforeEach(async () => {
    await resetSettings();
    await writeFreshHeartbeats();
  });
  afterEach(async () => {
    await restoreRecorded();
    await restoreUniqueIndex();
    await clearSyntheticMigrations();
  });
  afterAll(async () => {
    await restoreRecorded();
    await restoreUniqueIndex();
    await clearSyntheticMigrations();
    await resetSettings();
    if (redis !== null) await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("ORIGINAL_LF lineage: activation SUCCEEDS with a HEALTHY migration history", async () => {
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.migrationHistory.status).toBe("HEALTHY");
    expect(readiness.migrationHistory.legacyWarning).toBe(false);

    const result = await enableReferralPayoutsGated();
    expect(result.status).toBe("enabled");
    if (result.status === "enabled") {
      expect(result.migrationHistory.status).toBe("HEALTHY");
      expect(result.migrationHistory.legacyWarning).toBe(false);
    }
    expect(await isReferralSystemEnabled()).toBe(true);
  });

  it.each(KNOWN_LEGACY_VARIANTS)(
    "%s lineage: activation SUCCEEDS but flags the non-blocking legacy warning",
    async (_name, checksum) => {
      await setRecorded(checksum);
      const mh = await getReferralMigrationHistory();
      expect(mh.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
      expect(mh.legacyWarning).toBe(true);
      expect(mh.blocking).toBe(false);

      const result = await enableReferralPayoutsGated();
      expect(result.status).toBe("enabled");
      if (result.status === "enabled") expect(result.migrationHistory.legacyWarning).toBe(true);
      expect(await isReferralSystemEnabled()).toBe(true);
    },
  );

  it("UNKNOWN modified migration: activation is BLOCKED (payouts stay off)", async () => {
    await setRecorded("abc1234567".repeat(6) + "abcd"); // 64 hex, unknown
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.migrationHistory.status).toBe("CHECKSUM_DRIFT");
    expect(readiness.migrationHistory.blocking).toBe(true);
    expect(readiness.checks.find((c) => c.key === "migration-history-immutable")?.ok).toBe(false);

    const result = await enableReferralPayoutsGated();
    expect(result.status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("§4: EXACT_MATCH checksum but a dropped unique index BLOCKS activation", async () => {
    await dropUniqueIndex();
    try {
      const readiness = await assessReferralActivationReadiness();
      expect(readiness.migrationHistory.status).toBe("SCHEMA_POSTCONDITION_FAILED");
      expect(readiness.migrationHistory.blocking).toBe(true);
      expect((await enableReferralPayoutsGated()).status).toBe("blocked");
      expect(await isReferralSystemEnabled()).toBe(false);
    } finally {
      await restoreUniqueIndex();
    }
  });

  it("§2/§10: a HISTORICAL rolled-back attempt of the referral migration does NOT block after reapply", async () => {
    // Add an OLDER rolled-back attempt row alongside the real successful one.
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-rb-1', 'oldbadchecksum', $1, '2020-01-01T00:00:00Z', NULL, '2020-01-01T00:05:00Z', 0)`,
      REFERRAL_AFFILIATE_MIGRATION_NAME,
    );
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.migrationHistory.status).toBe("HEALTHY");
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.ok).toBe(true);
    expect((await enableReferralPayoutsGated()).status).toBe("enabled");
    expect(await isReferralSystemEnabled()).toBe(true);
  });

  it("§2/§10: a CURRENTLY failed/stuck migration BLOCKS activation", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-test-stuck', 'stuck', '29991231000000_stuck_migration', now(), NULL, NULL, 0)`,
    );
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.ok).toBe(false);
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("§1/§4: a migration ROLLED BACK and NEVER reapplied BLOCKS activation", async () => {
    // Its only attempt is a failure that was resolved --rolled-back: not currently applied.
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-test-rbnr', 'x', '29991231000000_rolledback_unreapplied', now(), NULL, now(), 0)`,
    );
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.ok).toBe(false);
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.detail).toContain("rolled-back-not-reapplied");
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("§1/§4: a migration that SUCCEEDED and was LATER rolled back BLOCKS activation", async () => {
    // An older success does NOT prove the current state is applied once a newer rollback exists.
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-test-sr1', 'x', '29991231000000_success_then_rollback', now() - interval '2 hours', now() - interval '2 hours', NULL, 1)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-test-sr2', 'x', '29991231000000_success_then_rollback', now(), NULL, now(), 0)`,
    );
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.ok).toBe(false);
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("§2/§4: an APPLIED database migration whose FILE is missing on disk BLOCKS activation", async () => {
    // A successful attempt for a migration that ships no directory: the deployment state must
    // NOT infer 'all applied' — the missing file is a divergence that blocks.
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('lineage-gate-test-ghost', 'x', '29991231000000_ghost_applied_no_file', now(), now(), NULL, 1)`,
    );
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.checks.find((c) => c.key === "migrations-healthy")?.ok).toBe(false);
    // The ordinary-immutability check also flags the missing file as FILE_MISSING.
    expect(readiness.migrationHistory.status).toBe("FILE_MISSING");
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("DISABLING is never gated even under an unknown migration history", async () => {
    await restoreRecorded();
    await writeFreshHeartbeats();
    expect((await enableReferralPayoutsGated()).status).toBe("enabled");
    await setRecorded("f".repeat(64));
    expect(await disableReferralPayouts()).toBe(true);
    expect(await isReferralSystemEnabled()).toBe(false);
  });
});
