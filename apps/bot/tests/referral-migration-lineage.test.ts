import {
  OrderStatus,
  ReferralCommissionStatus,
  prisma,
  type Order,
  type Referral,
  type User,
} from "@zedbot/database";
import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  evaluateReferralMigrationLineage,
  resolveMigrationsDir,
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
// §3/§9/§11 — dual-lineage activation. Needs a migrated database (and Redis for
// the gate-integration block). Some tests temporarily rewrite the recorded checksum
// / drop the unique index to construct the failure states; every one restores.
// =============================================================================

const redisOptions = getRedisOptions();
const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const dg = hasDb && redisOptions !== null ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

async function setRecorded(checksum: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name=$2`,
    checksum,
    REFERRAL_AFFILIATE_MIGRATION_NAME,
  );
}
async function restoreRecorded(): Promise<void> {
  await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL);
}

d("referral migration lineage evaluator (§3)", () => {
  let seq = 0;
  afterEach(async () => {
    await restoreRecorded();
  });
  afterAll(async () => {
    await restoreRecorded();
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
    const dir = resolveMigrationsDir();
    expect(dir).not.toBeNull();
  });

  it("ORIGINAL lineage → EXACT_MATCH (activation allowed, no warning)", async () => {
    const l = await evaluateReferralMigrationLineage();
    expect(l.status).toBe("EXACT_MATCH");
    expect(l.activationAllowed).toBe(true);
    expect(l.legacyVariant).toBe(false);
    expect(l.recordedChecksum).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL);
  });

  it("PR#110 recorded checksum + valid schema → KNOWN_COMPATIBLE_LEGACY_VARIANT", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110);
    const l = await evaluateReferralMigrationLineage();
    expect(l.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
    expect(l.activationAllowed).toBe(true);
    expect(l.legacyVariant).toBe(true);
    expect(l.postconditions?.every((p) => p.ok)).toBe(true);
  });

  it("an UNKNOWN recorded checksum → CHECKSUM_DRIFT (blocks)", async () => {
    await setRecorded("deadbeef".repeat(8));
    const l = await evaluateReferralMigrationLineage();
    expect(l.status).toBe("CHECKSUM_DRIFT");
    expect(l.activationAllowed).toBe(false);
  });

  it("known PR#110 checksum but a NON-unique index → SCHEMA_POSTCONDITION_FAILED", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110);
    try {
      await prisma.$executeRawUnsafe(`DROP INDEX "ReferralCommission_orderId_key"`);
      await prisma.$executeRawUnsafe(`CREATE INDEX "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId")`);
      const l = await evaluateReferralMigrationLineage();
      expect(l.status).toBe("SCHEMA_POSTCONDITION_FAILED");
      expect(l.activationAllowed).toBe(false);
      expect(l.postconditions?.find((p) => p.key === "index-is-unique")?.ok).toBe(false);
    } finally {
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "ReferralCommission_orderId_key"`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId")`);
    }
  });

  it("known PR#110 checksum but a DUPLICATE orderId → SCHEMA_POSTCONDITION_FAILED", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110);
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
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId")`,
      );
    }
  });
});

dg("dual-lineage activation gate integration (§3/§9)", () => {
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

  beforeEach(async () => {
    await resetSettings();
    await writeFreshHeartbeats();
  });
  afterEach(async () => {
    await restoreRecorded();
  });
  afterAll(async () => {
    await restoreRecorded();
    await resetSettings();
    if (redis !== null) await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("ORIGINAL lineage: activation SUCCEEDS with a HEALTHY migration history", async () => {
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

  it("PR#110 lineage: activation SUCCEEDS but flags the non-blocking legacy warning", async () => {
    await setRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110);
    const mh = await getReferralMigrationHistory();
    expect(mh.status).toBe("KNOWN_COMPATIBLE_LEGACY_VARIANT");
    expect(mh.legacyWarning).toBe(true);
    expect(mh.blocking).toBe(false);

    const result = await enableReferralPayoutsGated();
    expect(result.status).toBe("enabled");
    if (result.status === "enabled") {
      expect(result.migrationHistory.legacyWarning).toBe(true);
    }
    expect(await isReferralSystemEnabled()).toBe(true);
  });

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

  it("DISABLING is never gated even under an unknown migration history", async () => {
    // Enable under the original lineage first.
    await restoreRecorded();
    await writeFreshHeartbeats();
    expect((await enableReferralPayoutsGated()).status).toBe("enabled");
    // Now corrupt the recorded checksum — disable must still work.
    await setRecorded("f".repeat(64));
    expect(await disableReferralPayouts()).toBe(true);
    expect(await isReferralSystemEnabled()).toBe(false);
  });
});
