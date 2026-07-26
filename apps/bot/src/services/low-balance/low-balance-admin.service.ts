import {
  LowBalanceBackfillStatus,
  Prisma,
  prisma,
  SettingType,
  UserStatus,
} from "@zedbot/database";
import {
  errorMessage,
  formatTomanAmount,
  INT32_MAX,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_DEDUPE_PREFIX,
  LOW_BALANCE_DEDUPE_SEPARATOR,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

import { logger } from "../../core/logger.js";
import { clearSettingsCache, setSettingWithClient } from "../settings.service.js";
import { readLowBalanceConfigRows } from "./low-balance.service.js";

// =============================================================================
// Low wallet balance — ADMIN mutations (§11, §12, §13).
//
// Everything an OWNER can change lives here so the handler stays a rendering
// layer. Three rules:
//
//   * Changing the threshold or the margin BUMPS the config version. Alerts
//     already queued carry the boundary of the cycle they were opened under, so
//     a change never retroactively rewrites the meaning of a pending message.
//
//   * Nothing here touches a balance, a ledger row or a notification body. The
//     admin surface configures the rule; it never sends.
//
//   * The backfill is opt-in and singular. Starting one is a distinct,
//     explicitly-confirmed action, and the database — not this code — enforces
//     that only one can be PENDING or RUNNING.
// =============================================================================

/** Sane operator bounds. INT32_MAX is the column's own ceiling. */
export const MAX_THRESHOLD_TOMAN = 100_000_000;
export const MAX_REARM_MARGIN_TOMAN = 100_000_000;

export type ConfigUpdateResult =
  | { ok: true; config: LowBalanceConfig }
  | { ok: false; reason: "out-of-range" | "would-overflow" };

/**
 * ONE dedicated advisory-lock namespace serializing every low-balance
 * CONFIGURATION mutation, and every read that must see a coherent tuple.
 *
 * The boundary and its config version are two rows in `Setting`, and they mean
 * something only together: a version that did not move leaves alerts queued
 * under the old boundary indistinguishable from alerts queued under the new
 * one. Writing them as two independent statements has two failure modes — a
 * database error between them commits a new boundary under an old version, and
 * two concurrent admins can interleave read-read-write-write and lose an
 * increment entirely.
 *
 * A row lock cannot fix this: the version row may not exist yet, and
 * `SELECT … FOR UPDATE` over an absent row locks nothing at all. A
 * transaction-level advisory lock exists independently of any row and is
 * released at COMMIT or ROLLBACK, so the whole low-balance configuration
 * behaves as one serialized resource — the convention the terms and force-join
 * configuration surfaces already use.
 *
 * It is deliberately its OWN namespace: this subsystem must never block, or be
 * blocked by, those two.
 */
const LOW_BALANCE_CONFIG_LOCK = "zedbot-low-balance-config";

async function lockLowBalanceConfig(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOW_BALANCE_CONFIG_LOCK}))`;
}

/**
 * Applies one boundary change atomically.
 *
 * Under the lock it re-reads the configuration from the Setting ROWS — never
 * the process cache, which may be up to its TTL out of date and belongs to this
 * process alone — validates against that snapshot, and writes the changed
 * boundary together with the incremented version in a single transaction.
 * Either both land or neither does.
 *
 * The process cache is dropped AFTER the commit. Seeding it inside would
 * advertise a value a rollback could take away.
 */
async function mutateBoundary(
  key: typeof LOW_BALANCE_THRESHOLD_KEY | typeof LOW_BALANCE_REARM_MARGIN_KEY,
  value: number,
  max: number,
): Promise<ConfigUpdateResult> {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    return { ok: false, reason: "out-of-range" };
  }
  const result = await prisma.$transaction(async (tx) => {
    await lockLowBalanceConfig(tx);
    const current = await readLowBalanceConfigRows(tx);
    const threshold = key === LOW_BALANCE_THRESHOLD_KEY ? value : current.thresholdToman;
    const margin = key === LOW_BALANCE_REARM_MARGIN_KEY ? value : current.rearmMarginToman;
    // Judged against the SAME locked snapshot both parts come from, so a
    // concurrent change to the other half cannot slip past this check.
    if (threshold + margin > INT32_MAX) {
      return { ok: false, reason: "would-overflow" } as const;
    }
    await setSettingWithClient(tx, key, String(value), SettingType.NUMBER);
    await setSettingWithClient(
      tx,
      LOW_BALANCE_CONFIG_VERSION_KEY,
      String(current.configVersion + 1),
      SettingType.NUMBER,
    );
    return {
      ok: true,
      config: {
        enabled: current.enabled,
        thresholdToman: threshold,
        rearmMarginToman: margin,
        configVersion: current.configVersion + 1,
      },
    } as const;
  });
  if (result.ok) {
    clearSettingsCache();
  }
  return result;
}

/**
 * Sets the alert boundary.
 *
 * Rejects a threshold whose re-arm boundary would exceed the INT32 range of
 * `User.balanceToman` — a boundary no balance can ever reach would leave every
 * alerted user permanently stuck ALERTED.
 */
export async function setLowBalanceThreshold(value: number): Promise<ConfigUpdateResult> {
  return mutateBoundary(LOW_BALANCE_THRESHOLD_KEY, value, MAX_THRESHOLD_TOMAN);
}

/**
 * Sets the re-arm margin (the hysteresis band above the threshold).
 *
 * Zero is legal and meaningful: with no margin the machine re-arms as soon as
 * the balance is STRICTLY above the threshold. It is the noisiest setting, not
 * an invalid one.
 */
export async function setLowBalanceRearmMargin(value: number): Promise<ConfigUpdateResult> {
  return mutateBoundary(LOW_BALANCE_REARM_MARGIN_KEY, value, MAX_REARM_MARGIN_TOMAN);
}

/** Human-readable summary of what the current boundaries mean, for the UI. */
export function describeBoundaries(config: LowBalanceConfig): string[] {
  const boundary = rearmBoundaryToman(config);
  return [
    `هشدار وقتی موجودی ${formatTomanAmount(config.thresholdToman)} یا کمتر شود.`,
    config.rearmMarginToman === 0
      ? `آماده‌سازی دوباره وقتی موجودی از ${formatTomanAmount(config.thresholdToman)} بیشتر شود.`
      : `آماده‌سازی دوباره وقتی موجودی از ${formatTomanAmount(boundary)} بیشتر شود.`,
  ];
}

// --- backfill (§12) -----------------------------------------------------------

export interface BackfillView {
  id: string;
  status: LowBalanceBackfillStatus;
  thresholdToman: number;
  processedCount: number;
  queuedCount: number;
  skippedCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Aggregate breakdown of who a backfill would actually reach.
 *
 * Every figure is a COUNT. No user identity is selected, so the confirmation
 * screen cannot be used to find out who is short of money.
 */
export interface BackfillCandidateBreakdown {
  /** ACTIVE users at or below the frozen threshold. */
  belowThreshold: number;
  /** Of those, how many silenced this specific alert. */
  lowBalanceOptOuts: number;
  /** Of those, how many silenced the whole PAYMENT category. */
  paymentCategoryOptOuts: number;
  /**
   * Of the eligible remainder, how many are ALERTED on a cycle greater than
   * zero that already produced its deterministic message.
   */
  alreadyNotified: number;
  /**
   * The eligibility estimate the OWNER is shown: how many users the run would
   * queue a message for IF nothing changed between now and the run reaching
   * them. It is not a promise — see `startLowBalanceBackfill`.
   */
  expectedRecipients: number;
}

/** One row, five bigints — everything the aggregate returns. */
interface CandidateAggregateRow {
  below_threshold: bigint;
  low_balance_opt_outs: bigint;
  payment_category_opt_outs: bigint;
  already_notified: bigint;
  expected_recipients: bigint;
}

/**
 * Counts what a backfill would SEND, not merely who is poor.
 *
 * BOUNDED. This is ONE aggregate query. The previous version loaded every
 * eligible user id and cycle into application memory, built a dedupe key per
 * user and sent them all as a single `IN` list — which on a production-sized
 * installation is hundreds of thousands of strings in the bot process and a
 * statement far past PostgreSQL's bind-parameter limit. The admin screen would
 * simply fail, and the failure would arrive as a generic error. The counts are
 * now computed database-side with `FILTER`, so application memory is constant
 * (one row) and the statement carries three parameters no matter how many users
 * exist.
 *
 * EXACT. The classification mirrors the worker's rules, case for case:
 *
 *   no state row                                        -> recipient
 *   ARMED (any cycle) while at or below the threshold   -> recipient
 *   ALERTED, cycle 0 (the silent baseline)              -> recipient
 *   ALERTED, cycle > 0, that cycle has no message       -> recipient
 *   ALERTED, cycle > 0, that cycle HAS its message      -> already notified
 *   opted out / payment category off / not ACTIVE       -> excluded
 *
 * The ARMED case is the one that was wrong before: a user re-armed after cycle 3
 * still has a notification for cycle 3, and the old query counted them as
 * already notified — while the worker would open cycle 4 and queue a message.
 * The screen therefore promised FEWER messages than the run would send. Being
 * ALERTED is now part of the condition, exactly as it is in the transition.
 *
 * "Recovered" needs no case: the population filter is `balance <= threshold` and
 * the re-arm boundary is never below the threshold, so no user inside this set
 * can be recovered.
 */
export async function countBackfillCandidates(
  config: LowBalanceConfig,
  client: Prisma.TransactionClient = prisma,
): Promise<BackfillCandidateBreakdown> {
  // The dedupe key composed in SQL from the shared pieces. L112 asserts this
  // spelling and `lowBalanceDedupeKey` produce byte-identical keys.
  const [row] = await client.$queryRaw<CandidateAggregateRow[]>`
    SELECT
      COUNT(*) AS below_threshold,
      COUNT(*) FILTER (
        WHERE NOT u."lowBalanceNotificationsEnabled"
      ) AS low_balance_opt_outs,
      COUNT(*) FILTER (
        WHERE u."lowBalanceNotificationsEnabled"
          AND NOT u."paymentNotificationsEnabled"
      ) AS payment_category_opt_outs,
      COUNT(*) FILTER (
        WHERE u."lowBalanceNotificationsEnabled"
          AND u."paymentNotificationsEnabled"
          AND n."id" IS NOT NULL
      ) AS already_notified,
      COUNT(*) FILTER (
        WHERE u."lowBalanceNotificationsEnabled"
          AND u."paymentNotificationsEnabled"
          AND n."id" IS NULL
      ) AS expected_recipients
    FROM "User" u
    LEFT JOIN "LowBalanceAlertState" s
      ON s."userId" = u."id"
    LEFT JOIN "AutomatedNotification" n
      ON s."state" = 'ALERTED'
     AND s."alertCycle" > 0
     AND n."dedupeKey" =
         ${LOW_BALANCE_DEDUPE_PREFIX} || u."id" ||
         ${LOW_BALANCE_DEDUPE_SEPARATOR} || s."alertCycle"::text
    WHERE u."status" = ${UserStatus.ACTIVE}::"UserStatus"
      AND u."balanceToman" <= ${config.thresholdToman}
  `;

  return {
    belowThreshold: Number(row?.below_threshold ?? 0n),
    lowBalanceOptOuts: Number(row?.low_balance_opt_outs ?? 0n),
    paymentCategoryOptOuts: Number(row?.payment_category_opt_outs ?? 0n),
    alreadyNotified: Number(row?.already_notified ?? 0n),
    expectedRecipients: Number(row?.expected_recipients ?? 0n),
  };
}

export type StartBackfillResult =
  | { ok: true; run: BackfillView; candidates: BackfillCandidateBreakdown }
  | { ok: false; reason: "disabled" | "already-running" | "failed" };

/** The repository's unique-violation convention (see attribution.ts). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Creates the single backfill run. The worker advances it; this only authorises
 * it, freezing the config it was authorised against.
 *
 * ONE COHERENT TUPLE. The whole thing happens under the configuration lock, and
 * the configuration is read from the Setting rows inside that transaction. A run
 * frozen from four independent cached reads could pair a threshold with the
 * version that preceded it, and every alert it queued would then be judged at
 * delivery against a boundary it was never opened under.
 *
 * `estimatedCount` is exactly that — an estimate. Balances move, users opt out,
 * and every unit re-checks eligibility before it queues anything, so the number
 * of messages actually sent can only be this or fewer.
 *
 * Only the EXPECTED uniqueness violation becomes `already-running`. Reporting
 * every database failure that way told the OWNER a run existed when none did,
 * and hid real faults; anything else is logged safely and surfaced as a generic
 * failure, never as a raw database error.
 */
export async function startLowBalanceBackfill(adminId: string): Promise<StartBackfillResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockLowBalanceConfig(tx);
      const config = await readLowBalanceConfigRows(tx);
      if (!config.enabled) {
        return { ok: false, reason: "disabled" } as const;
      }
      const candidates = await countBackfillCandidates(config, tx);
      const run = await tx.lowBalanceBackfillRun.create({
        data: {
          status: LowBalanceBackfillStatus.PENDING,
          thresholdToman: config.thresholdToman,
          rearmBoundaryToman: rearmBoundaryToman(config),
          configVersion: config.configVersion,
          createdByAdminId: adminId,
          estimatedCount: candidates.expectedRecipients,
        },
      });
      return { ok: true, run: toView(run), candidates } as const;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The partial unique index rejected it: a run is already PENDING/RUNNING.
      return { ok: false, reason: "already-running" };
    }
    // Safe code only — never a raw database error, never a user identity.
    logger.warn("low-balance backfill start failed", { error: errorMessage(err) });
    return { ok: false, reason: "failed" };
  }
}

/** Stops the active run. Messages already queued are NOT recalled. */
export async function cancelLowBalanceBackfill(): Promise<boolean> {
  const result = await prisma.lowBalanceBackfillRun.updateMany({
    where: {
      status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
    },
    data: { status: LowBalanceBackfillStatus.CANCELLED, cancelledAt: new Date() },
  });
  return result.count > 0;
}

/** The active run, or the most recent finished one when nothing is active. */
export async function getLatestBackfill(): Promise<BackfillView | null> {
  const active = await prisma.lowBalanceBackfillRun.findFirst({
    where: {
      status: { in: [LowBalanceBackfillStatus.PENDING, LowBalanceBackfillStatus.RUNNING] },
    },
    orderBy: { createdAt: "desc" },
  });
  const row =
    active ??
    (await prisma.lowBalanceBackfillRun.findFirst({ orderBy: { createdAt: "desc" } }));
  return row === null ? null : toView(row);
}

function toView(row: {
  id: string;
  status: LowBalanceBackfillStatus;
  thresholdToman: number;
  processedCount: number;
  queuedCount: number;
  skippedCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
}): BackfillView {
  return {
    id: row.id,
    status: row.status,
    thresholdToman: row.thresholdToman,
    processedCount: row.processedCount,
    queuedCount: row.queuedCount,
    skippedCount: row.skippedCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
