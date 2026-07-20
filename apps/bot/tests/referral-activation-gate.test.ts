import {
  prisma,
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
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-activation-gate-tests-secret-0123456789";

import {
  assessReferralActivationReadiness,
  enableReferralPayoutsGated,
} from "../src/services/referral-activation.service.js";
import { disableReferralPayouts, isReferralSystemEnabled } from "../src/services/referral.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// §6 — the activation integrity gate must BLOCK enabling payouts until the system
// is provably healthy, and DISABLING must always work. Needs a migrated database
// AND a reachable Redis (for the worker / execute-consumer heartbeats).
// =============================================================================

const redisOptions = getRedisOptions();
const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb && redisOptions !== null ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

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

async function resetReferralSettings(): Promise<void> {
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

function checkOk(readiness: Awaited<ReturnType<typeof assessReferralActivationReadiness>>, key: string): boolean {
  return readiness.checks.find((c) => c.key === key)?.ok ?? false;
}

d("referral activation integrity gate (§6)", () => {
  let seq = 0;

  beforeEach(async () => {
    await resetReferralSettings();
    // NOTE: we deliberately do NOT wipe the commission table here. The integrity
    // checks count VIOLATIONS (out-of-bounds ledger rows, mismatches, duplicates),
    // which stay 0 on the app's consistent data — so a global delete would only
    // orphan other suites' orders into the credit-scan candidate pool for no gain.
    await writeFreshHeartbeats();
  });

  afterAll(async () => {
    await resetReferralSettings();
    if (redis !== null) await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  });

  async function makeUser(): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F" } });
  }

  it("passes and enables ATOMICALLY when the system is healthy", async () => {
    const readiness = await assessReferralActivationReadiness();
    expect(readiness.ready).toBe(true);

    const result = await enableReferralPayoutsGated();
    expect(result.status).toBe("enabled");
    // The switch flipped AND a payout window opened in the same activation.
    expect(await isReferralSystemEnabled()).toBe(true);
    const windows = await prisma.setting.findUnique({ where: { key: REFERRAL_PAYOUT_WINDOWS_KEY } });
    expect(windows).not.toBeNull();
    expect(windows?.value).toContain('"to":null');
  });

  it("BLOCKS enabling when the execute-consumer heartbeat is missing", async () => {
    await client().del(REFERRAL_EXECUTE_HEARTBEAT_KEY);
    const readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "execute-consumer-heartbeat-fresh")).toBe(false);
    expect(readiness.ready).toBe(false);

    const result = await enableReferralPayoutsGated();
    expect(result.status).toBe("blocked");
    // Nothing changed — payouts stay OFF.
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("BLOCKS enabling when the worker heartbeat is missing", async () => {
    await client().del(WORKER_HEARTBEAT_KEY);
    const readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "worker-heartbeat-fresh")).toBe(false);
    expect(readiness.ready).toBe(false);
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("BLOCKS enabling when the payout windows are corrupt", async () => {
    await prisma.setting.upsert({
      where: { key: REFERRAL_PAYOUT_WINDOWS_KEY },
      create: { key: REFERRAL_PAYOUT_WINDOWS_KEY, value: "{not json", type: "STRING" },
      update: { value: "{not json", type: "STRING" },
    });
    clearSettingsCache();
    const readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "payout-windows-valid")).toBe(false);
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");
    expect(await isReferralSystemEnabled()).toBe(false);
  });

  it("BLOCKS enabling when a Referral/User attribution mismatch exists, then unblocks once repaired", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const referred = await makeUser();
    await prisma.user.update({ where: { id: referred.id }, data: { referrerId: a.id } });
    // Legacy corruption: the Referral row points at a DIFFERENT referrer than User.referrerId.
    const ref = await prisma.referral.create({ data: { referrerUserId: b.id, referredUserId: referred.id } });

    let readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "no-attribution-mismatch")).toBe(false);
    expect((await enableReferralPayoutsGated()).status).toBe("blocked");

    // Repair the mismatch — the gate clears.
    await prisma.referral.update({ where: { id: ref.id }, data: { referrerUserId: a.id } });
    readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "no-attribution-mismatch")).toBe(true);

    // Cleanup so the shared table stays consistent for later suites.
    await prisma.referral.delete({ where: { id: ref.id } });
  });

  it("reports the migration-history immutability check as passing on a clean deploy", async () => {
    const readiness = await assessReferralActivationReadiness();
    expect(checkOk(readiness, "migrations-healthy")).toBe(true);
    expect(checkOk(readiness, "migration-history-immutable")).toBe(true);
  });

  it("§4: the OWNER readiness gate assesses the FULL end-to-end set, not just migrations", async () => {
    // The migration-only diagnostic command (printReferralMigrationLineageStatus) deliberately
    // checks migrations alone. The OWNER activation gate must additionally cover Redis / control
    // queue / worker + execute heartbeats / wallet ledger / payout windows / attribution /
    // integrity — so a green migration verdict can never be mistaken for full activation.
    const readiness = await assessReferralActivationReadiness();
    const keys = readiness.checks.map((c) => c.key);
    for (const required of [
      "migrations-healthy",
      "migration-history-immutable",
      "worker-heartbeat-fresh",
      "control-queue-reachable",
      "execute-consumer-heartbeat-fresh",
      "wallet-ledger-healthy",
      "payout-windows-valid",
      "no-attribution-mismatch",
      "no-duplicate-commission-order",
      "no-unresolved-integrity-issue",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("DISABLING is never gated — it works even with every heartbeat gone", async () => {
    // First enable (healthy), then wipe the heartbeats and confirm disable still works.
    expect((await enableReferralPayoutsGated()).status).toBe("enabled");
    expect(await isReferralSystemEnabled()).toBe(true);
    await client().del(WORKER_HEARTBEAT_KEY);
    await client().del(REFERRAL_EXECUTE_HEARTBEAT_KEY);
    const flipped = await disableReferralPayouts();
    expect(flipped).toBe(true);
    expect(await isReferralSystemEnabled()).toBe(false);
  });
});
