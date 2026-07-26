import { LowBalanceAlertStateValue, prisma, UserStatus } from "@zedbot/database";
import {
  evaluateLowBalanceTransition,
  formatTomanAmount,
  INT32_MAX,
  isLowBalance,
  isRearmed,
  lowBalanceDedupeKey,
  parseTomanAmount,
  rearmBoundaryToman,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateEligibility,
  getLowBalanceOverview,
  observeWalletBalance,
} from "../src/services/low-balance/low-balance.service.js";
import { onWalletBalanceChanged } from "../src/services/low-balance/low-balance-hook.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Low wallet balance notifications — state machine, boundaries, idempotency and
// concurrency (§17).
//
// Money here is WHOLE TOMAN, the canonical `User.balanceToman` unit.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const TELEGRAM_ID_BASE = 8_400_000_000_000n;
const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;

const THRESHOLD = 100_000;
const MARGIN = 20_000;
/** threshold + margin = 120,000 */
const REARM_BOUNDARY = THRESHOLD + MARGIN;

const createdUserIds: string[] = [];

async function makeUser(
  balanceToman: number,
  overrides: Partial<{
    status: UserStatus;
    lowBalanceNotificationsEnabled: boolean;
    paymentNotificationsEnabled: boolean;
  }> = {},
): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: {
      telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq,
      balanceToman,
      status: overrides.status ?? UserStatus.ACTIVE,
      lowBalanceNotificationsEnabled: overrides.lowBalanceNotificationsEnabled ?? true,
      paymentNotificationsEnabled: overrides.paymentNotificationsEnabled ?? true,
    },
  });
  createdUserIds.push(row.id);
  return row.id;
}

/**
 * Moves the balance and runs the observer exactly as a wallet mutation does —
 * including the authoritative BEFORE value, which every real wallet site
 * already computes for its `WalletTransaction.balanceBeforeToman`.
 */
async function moveBalance(userId: string, to: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balanceToman: true },
    });
    await tx.user.update({ where: { id: userId }, data: { balanceToman: to } });
    await onWalletBalanceChanged(tx, {
      userId,
      balanceBeforeToman: before.balanceToman,
      balanceAfterToman: to,
      source: "TEST",
    });
  });
}

async function stateOf(userId: string) {
  return prisma.lowBalanceAlertState.findUnique({ where: { userId } });
}

async function notificationCount(userId: string): Promise<number> {
  return prisma.automatedNotification.count({
    where: { userId, type: "WALLET_LOW_BALANCE" },
  });
}

async function enableFeature(threshold = THRESHOLD, margin = MARGIN): Promise<void> {
  await setSetting("low_balance_notification_enabled", "true", "BOOLEAN");
  await setSetting("low_balance_threshold", String(threshold), "NUMBER");
  await setSetting("low_balance_rearm_margin", String(margin), "NUMBER");
  await setSetting("low_balance_config_version", "1", "NUMBER");
  clearSettingsCache();
}

async function resetAll(): Promise<void> {
  await prisma.automatedNotification.deleteMany({ where: { type: "WALLET_LOW_BALANCE" } });
  await prisma.lowBalanceAlertState.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  await prisma.setting.deleteMany({
    where: {
      key: {
        in: [
          "low_balance_notification_enabled",
          "low_balance_threshold",
          "low_balance_rearm_margin",
          "low_balance_config_version",
        ],
      },
    },
  });
  clearSettingsCache();
}

// --- pure contract (no database) ---------------------------------------------

describe("low balance — boundaries and parsing (pure)", () => {
  const cfg = { thresholdToman: THRESHOLD, rearmMarginToman: MARGIN };

  it("L01 the re-arm boundary is threshold + margin", () => {
    expect(rearmBoundaryToman(cfg)).toBe(120_000);
  });

  it("L02 a balance AT the threshold is low (alert boundary is inclusive)", () => {
    expect(isLowBalance(THRESHOLD, cfg)).toBe(true);
    expect(isLowBalance(THRESHOLD + 1, cfg)).toBe(false);
  });

  it("L03 re-arm requires STRICTLY above the re-arm boundary", () => {
    expect(isRearmed(REARM_BOUNDARY, cfg)).toBe(false);
    expect(isRearmed(REARM_BOUNDARY + 1, cfg)).toBe(true);
  });

  it("L04 a zero margin re-arms only strictly above the threshold", () => {
    const zero = { thresholdToman: THRESHOLD, rearmMarginToman: 0 };
    expect(rearmBoundaryToman(zero)).toBe(THRESHOLD);
    expect(isRearmed(THRESHOLD, zero)).toBe(false);
    expect(isRearmed(THRESHOLD + 1, zero)).toBe(true);
  });

  it("L05 the re-arm boundary saturates instead of overflowing INT32", () => {
    expect(rearmBoundaryToman({ thresholdToman: INT32_MAX, rearmMarginToman: 1000 })).toBe(INT32_MAX);
  });

  it("L06 the transition table is exactly alert / rearm / none", () => {
    expect(evaluateLowBalanceTransition("ARMED", 90_000, cfg)).toEqual({ kind: "alert" });
    expect(evaluateLowBalanceTransition("ARMED", 150_000, cfg)).toEqual({ kind: "none" });
    expect(evaluateLowBalanceTransition("ALERTED", 70_000, cfg)).toEqual({ kind: "none" });
    expect(evaluateLowBalanceTransition("ALERTED", 95_000, cfg)).toEqual({ kind: "none" });
    expect(evaluateLowBalanceTransition("ALERTED", 130_000, cfg)).toEqual({ kind: "rearm" });
  });

  it("L07 the dedupe key is per user and per cycle", () => {
    expect(lowBalanceDedupeKey("u1", 1)).not.toBe(lowBalanceDedupeKey("u1", 2));
    expect(lowBalanceDedupeKey("u1", 1)).not.toBe(lowBalanceDedupeKey("u2", 1));
    expect(lowBalanceDedupeKey("u1", 1)).toBe(lowBalanceDedupeKey("u1", 1));
  });

  it("L08 amount parsing accepts Persian digits and separators", () => {
    expect(parseTomanAmount("۱۰۰,۰۰۰")).toEqual({ ok: true, value: 100_000 });
    expect(parseTomanAmount("100 000")).toEqual({ ok: true, value: 100_000 });
    expect(parseTomanAmount("0")).toEqual({ ok: true, value: 0 });
  });

  it("L09 amount parsing rejects decimals, negatives, junk and INT32 overflow", () => {
    // Decimals are REJECTED, never rounded: the canonical unit is a whole Toman
    // and silently truncating would change the boundary the operator set.
    expect(parseTomanAmount("100.5")).toEqual({ ok: false, error: "NOT_AN_INTEGER" });
    expect(parseTomanAmount("-5")).toEqual({ ok: false, error: "NEGATIVE" });
    expect(parseTomanAmount("abc")).toEqual({ ok: false, error: "NOT_A_NUMBER" });
    expect(parseTomanAmount("")).toEqual({ ok: false, error: "NOT_A_NUMBER" });
    expect(parseTomanAmount(String(INT32_MAX + 1))).toEqual({ ok: false, error: "TOO_LARGE" });
  });

  it("L10 money renders in the repository's canonical Toman format", () => {
    expect(formatTomanAmount(100_000)).toBe("100,000 تومان");
  });

  it("L11 eligibility excludes inactive users and both opt-out layers", () => {
    const base = {
      status: UserStatus.ACTIVE,
      lowBalanceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
    };
    expect(evaluateEligibility(base).eligible).toBe(true);
    expect(evaluateEligibility({ ...base, status: UserStatus.BLOCKED })).toEqual({
      eligible: false,
      reason: "inactive",
    });
    expect(evaluateEligibility({ ...base, lowBalanceNotificationsEnabled: false })).toEqual({
      eligible: false,
      reason: "opted-out",
    });
    expect(evaluateEligibility({ ...base, paymentNotificationsEnabled: false })).toEqual({
      eligible: false,
      reason: "payment-category-off",
    });
  });
});

// --- state machine (database) ------------------------------------------------

describe.runIf(hasDb)("low balance — state machine (§2, §3)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L12 a disabled feature creates no state and no alert", async () => {
    const userId = await makeUser(500_000);
    await moveBalance(userId, 10_000);
    expect(await stateOf(userId)).toBeNull();
    expect(await notificationCount(userId)).toBe(0);
  });

  it("L13 an above-threshold debit creates no alert", async () => {
    await enableFeature();
    const userId = await makeUser(500_000);
    await moveBalance(userId, 300_000);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(await notificationCount(userId)).toBe(0);
  });

  it("L14 crossing the threshold produces exactly one alert", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000); // first observation -> ARMED
    await moveBalance(userId, 90_000); // crossing
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(1);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L15 a further debit while low produces NO second alert", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 90_000);
    await moveBalance(userId, 70_000);
    expect(await notificationCount(userId)).toBe(1);
    expect((await stateOf(userId))?.alertCycle).toBe(1);
  });

  it("L16 a top-up BELOW the re-arm boundary does not re-arm", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 70_000);
    await moveBalance(userId, 95_000); // still <= 120,000
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L17 a top-up ABOVE the re-arm boundary re-arms silently", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 70_000);
    await moveBalance(userId, 130_000);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.rearmedAt).not.toBeNull();
    // Re-arming is silent — still exactly the one original message.
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L18 a second crossing after re-arm opens a NEW cycle and alerts again", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 70_000);
    await moveBalance(userId, 130_000);
    await moveBalance(userId, 50_000);
    const state = await stateOf(userId);
    expect(state?.alertCycle).toBe(2);
    expect(await notificationCount(userId)).toBe(2);
  });

  it("L19 exactly ON the threshold is low and alerts", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, THRESHOLD);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L20 exactly ON the re-arm boundary does NOT re-arm", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 70_000);
    await moveBalance(userId, REARM_BOUNDARY);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ALERTED);
  });

  it("L21 a zero margin re-arms one Toman above the threshold", async () => {
    await enableFeature(THRESHOLD, 0);
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 70_000);
    await moveBalance(userId, THRESHOLD);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    await moveBalance(userId, THRESHOLD + 1);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ARMED);
  });

  it("L22 a negative balance is low and alerts once", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, -5_000);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L23 a user FIRST OBSERVED already low is recorded ALERTED with NO message", async () => {
    // This is the future-crossings-only rule that stops enabling the feature
    // from blasting the historical low-balance population.
    await enableFeature();
    const userId = await makeUser(10_000);
    await moveBalance(userId, 9_000);
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ALERTED);
    expect(state?.alertCycle).toBe(0);
    expect(await notificationCount(userId)).toBe(0);
  });

  it("L24 the state row records the boundaries the cycle was opened under", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 90_000);
    const state = await stateOf(userId);
    expect(state?.lastThresholdToman).toBe(THRESHOLD);
    expect(state?.lastRearmBoundaryToman).toBe(REARM_BOUNDARY);
    expect(state?.lastConfigVersion).toBe(1);
  });
});

// --- concurrency + idempotency ------------------------------------------------

describe.runIf(hasDb)("low balance — concurrency and idempotency (§7)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L25 two concurrent debits that both cross produce exactly ONE alert", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);

    // Both transactions observe a committed low balance. The FOR UPDATE row lock
    // serialises them: one sees ARMED and alerts, the other sees ALERTED.
    await Promise.all([
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 90_000 } });
        await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 90_000 });
      }),
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 80_000 } });
        await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 80_000 });
      }),
    ]);

    expect(await notificationCount(userId)).toBe(1);
    expect((await stateOf(userId))?.alertCycle).toBe(1);
  });

  it("L26 many concurrent debits still produce exactly one alert", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);

    await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        prisma.$transaction(async (tx) => {
          const to = 90_000 - i * 1_000;
          await tx.user.update({ where: { id: userId }, data: { balanceToman: to } });
          await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: to });
        }),
      ),
    );

    expect(await notificationCount(userId)).toBe(1);
  });

  it("L27 a replayed wallet mutation creates no duplicate notification", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 90_000);
    // Same committed balance observed again (a retried webhook / replayed job).
    await moveBalance(userId, 90_000);
    await moveBalance(userId, 90_000);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L28 the dedupe key makes a duplicate insert a no-op, not an error", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    await moveBalance(userId, 90_000);
    const existing = await prisma.automatedNotification.findFirst({
      where: { userId, type: "WALLET_LOW_BALANCE" },
    });
    // Inserting the SAME dedupe key must be absorbed by the unique index.
    const dup = await prisma.automatedNotification.createMany({
      data: [
        {
          type: "WALLET_LOW_BALANCE",
          category: "PAYMENT",
          status: "SCHEDULED",
          userId,
          dedupeKey: existing?.dedupeKey ?? "x",
          scheduledFor: new Date(),
          payloadSnapshot: {},
        },
      ],
      skipDuplicates: true,
    });
    expect(dup.count).toBe(0);
    expect(await notificationCount(userId)).toBe(1);
  });

  it("L29 concurrent debit and top-up leave state consistent with the final balance", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);

    await Promise.all([
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 50_000 } });
        await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 50_000 });
      }),
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 400_000 } });
        await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 400_000 });
      }),
    ]);

    // Whichever order won, the machine must not be left claiming something the
    // balance contradicts in a way that suppresses a future alert forever.
    const state = await stateOf(userId);
    const balance = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).balanceToman;
    expect(state).not.toBeNull();
    if (balance > REARM_BOUNDARY) {
      // If the top-up landed last the machine is either already ARMED, or
      // ALERTED and guaranteed to re-arm on the next observation.
      await moveBalance(userId, balance);
      expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ARMED);
    }
    expect(await notificationCount(userId)).toBeLessThanOrEqual(1);
  });

  it("L30 a rolled-back financial transaction takes the notification with it", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 90_000 } });
        await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 90_000 });
        throw new Error("payment failed after the notification was prepared");
      }),
    ).rejects.toThrow();

    expect(await notificationCount(userId)).toBe(0);
    expect((await stateOf(userId))?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).balanceToman).toBe(
      150_000,
    );
  });
});

// --- financial isolation ------------------------------------------------------

describe.runIf(hasDb)("low balance — financial invariants (§14)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L31 the observer never changes a balance or writes a ledger row", async () => {
    await enableFeature();
    const userId = await makeUser(90_000);
    const ledgerBefore = await prisma.walletTransaction.count({ where: { userId } });

    await prisma.$transaction(async (tx) => {
      await observeWalletBalance(tx, { userId, balanceBeforeToman: null, balanceAfterToman: 90_000 });
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.balanceToman).toBe(90_000);
    expect(user.totalSpentToman).toBe(0);
    expect(user.totalChargedToman).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId } })).toBe(ledgerBefore);
  });

  it("L32 a LOGIC error in the observer does not fail the wallet mutation", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);

    // A stand-in client that raises a plain TypeError the moment the observer
    // touches it. Nothing reaches PostgreSQL, so the enclosing transaction stays
    // healthy and the hook's catch is the only thing standing between the defect
    // and the money — which is the invariant §14 actually asks for.
    const brokenTx = new Proxy(
      {},
      {
        get() {
          throw new TypeError("simulated defect in the notification feature");
        },
      },
    ) as unknown as Parameters<typeof onWalletBalanceChanged>[0];

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { balanceToman: 90_000 } });
      await onWalletBalanceChanged(brokenTx, {
        userId,
        balanceBeforeToman: 150_000,
        balanceAfterToman: 90_000,
        source: "TEST",
      });
    });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).balanceToman).toBe(
      90_000,
    );
    // The defect recorded nothing: the machine still holds the value from the
    // last successful observation, and the sweep is what repairs the gap.
    const state = await stateOf(userId);
    expect(state?.state).toBe(LowBalanceAlertStateValue.ARMED);
    expect(state?.lastObservedBalanceToman).toBe(150_000);
  });

  it("L32b a DATABASE error in the observer rolls the mutation back, atomically", async () => {
    await enableFeature();
    const userId = await makeUser(150_000);
    await moveBalance(userId, 150_000);
    const ledgerBefore = await prisma.walletTransaction.count({ where: { userId } });

    // PostgreSQL aborts a transaction on ANY failed statement, so a DB-level
    // fault inside the observer cannot be caught back to a healthy transaction:
    // the caller's next statement fails with 25P02 and COMMIT degrades to
    // ROLLBACK. That is SAFE — money and notification move together or not at
    // all — but it is not the same guarantee as the logic-error case above, and
    // the hook's doc comment says so. This test keeps that claim honest, and is
    // why the outbox insert uses ON CONFLICT DO NOTHING instead of catching a
    // unique violation: a raised 23505 would doom the checkout.
    // A NUL byte is rejected by the server (22021) inside SELECT ... FOR UPDATE.
    const poisonedUserId = "\u0000not-a-real-user";
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 90_000 } });
        await onWalletBalanceChanged(tx, {
          userId: poisonedUserId,
          balanceBeforeToman: 150_000,
          balanceAfterToman: 90_000,
          source: "TEST",
        });
        await tx.user.update({ where: { id: userId }, data: { balanceToman: 90_000 } });
      }),
    ).rejects.toThrow();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.balanceToman).toBe(150_000);
    expect(await prisma.walletTransaction.count({ where: { userId } })).toBe(ledgerBefore);
  });
});

// --- admin read model ---------------------------------------------------------

describe.runIf(hasDb)("low balance — admin overview (§11)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("L33 the overview reports boundaries and aggregate counts only", async () => {
    await enableFeature();
    const low = await makeUser(150_000);
    await moveBalance(low, 150_000);
    await moveBalance(low, 90_000);
    const high = await makeUser(500_000);
    await moveBalance(high, 500_000);

    const overview = await getLowBalanceOverview();
    expect(overview.config.thresholdToman).toBe(THRESHOLD);
    expect(overview.rearmBoundaryToman).toBe(REARM_BOUNDARY);
    expect(overview.alerted).toBeGreaterThanOrEqual(1);
    expect(overview.armed).toBeGreaterThanOrEqual(1);
    expect(overview.queued).toBeGreaterThanOrEqual(1);
    // Aggregates only — the shape carries no user identity at all.
    expect(Object.keys(overview)).not.toContain("users");
  });
});
