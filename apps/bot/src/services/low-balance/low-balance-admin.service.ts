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
  lowBalanceDedupeKey,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

import { logger } from "../../core/logger.js";
import { clearSettingsCache, setSetting } from "../settings.service.js";
import { getLowBalanceConfig } from "./low-balance.service.js";

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

async function bumpConfigVersion(current: number): Promise<void> {
  await setSetting(LOW_BALANCE_CONFIG_VERSION_KEY, String(current + 1), SettingType.NUMBER);
}

/**
 * Sets the alert boundary.
 *
 * Rejects a threshold whose re-arm boundary would exceed the INT32 range of
 * `User.balanceToman` — a boundary no balance can ever reach would leave every
 * alerted user permanently stuck ALERTED.
 */
export async function setLowBalanceThreshold(value: number): Promise<ConfigUpdateResult> {
  if (!Number.isInteger(value) || value < 0 || value > MAX_THRESHOLD_TOMAN) {
    return { ok: false, reason: "out-of-range" };
  }
  const current = await getLowBalanceConfig();
  if (value + current.rearmMarginToman > INT32_MAX) {
    return { ok: false, reason: "would-overflow" };
  }
  await setSetting(LOW_BALANCE_THRESHOLD_KEY, String(value), SettingType.NUMBER);
  await bumpConfigVersion(current.configVersion);
  clearSettingsCache();
  return { ok: true, config: await getLowBalanceConfig() };
}

/**
 * Sets the re-arm margin (the hysteresis band above the threshold).
 *
 * Zero is legal and meaningful: with no margin the machine re-arms as soon as
 * the balance is STRICTLY above the threshold. It is the noisiest setting, not
 * an invalid one.
 */
export async function setLowBalanceRearmMargin(value: number): Promise<ConfigUpdateResult> {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REARM_MARGIN_TOMAN) {
    return { ok: false, reason: "out-of-range" };
  }
  const current = await getLowBalanceConfig();
  if (current.thresholdToman + value > INT32_MAX) {
    return { ok: false, reason: "would-overflow" };
  }
  await setSetting(LOW_BALANCE_REARM_MARGIN_KEY, String(value), SettingType.NUMBER);
  await bumpConfigVersion(current.configVersion);
  clearSettingsCache();
  return { ok: true, config: await getLowBalanceConfig() };
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
  /** Of those, how many already have the message for their current cycle. */
  alreadyNotified: number;
  /** What the run intends to queue. This is the number the OWNER is shown. */
  expectedRecipients: number;
}

/**
 * Counts what a backfill would SEND, not merely who is poor.
 *
 * The earlier version showed every ACTIVE user below the threshold, which
 * over-promised: opted-out users and users already holding their current
 * cycle's message were counted and then skipped, so the OWNER confirmed a
 * number the run could not deliver.
 */
export async function countBackfillCandidates(
  config: LowBalanceConfig,
): Promise<BackfillCandidateBreakdown> {
  const lowFilter = {
    status: UserStatus.ACTIVE,
    balanceToman: { lte: config.thresholdToman },
  } as const;

  const [belowThreshold, lowBalanceOptOuts, paymentCategoryOptOuts] = await Promise.all([
    prisma.user.count({ where: lowFilter }),
    prisma.user.count({ where: { ...lowFilter, lowBalanceNotificationsEnabled: false } }),
    prisma.user.count({
      where: {
        ...lowFilter,
        lowBalanceNotificationsEnabled: true,
        paymentNotificationsEnabled: false,
      },
    }),
  ]);

  // Eligible users whose CURRENT cycle already produced its message. The
  // deterministic key is the authority, so this counts real notifications
  // rather than inferring from the state row alone.
  const eligible = await prisma.user.findMany({
    where: {
      ...lowFilter,
      lowBalanceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
      lowBalanceAlertState: { is: { alertCycle: { gt: 0 } } },
    },
    select: { id: true, lowBalanceAlertState: { select: { alertCycle: true } } },
  });
  let alreadyNotified = 0;
  const keys = eligible
    .map((u) =>
      u.lowBalanceAlertState === null
        ? null
        : lowBalanceDedupeKey(u.id, u.lowBalanceAlertState.alertCycle),
    )
    .filter((k): k is string => k !== null);
  if (keys.length > 0) {
    alreadyNotified = await prisma.automatedNotification.count({
      where: { dedupeKey: { in: keys } },
    });
  }

  const expectedRecipients = Math.max(
    0,
    belowThreshold - lowBalanceOptOuts - paymentCategoryOptOuts - alreadyNotified,
  );
  return {
    belowThreshold,
    lowBalanceOptOuts,
    paymentCategoryOptOuts,
    alreadyNotified,
    expectedRecipients,
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
 * Only the EXPECTED uniqueness violation becomes `already-running`. Reporting
 * every database failure that way told the OWNER a run existed when none did,
 * and hid real faults; anything else is logged safely and surfaced as a generic
 * failure, never as a raw database error.
 */
export async function startLowBalanceBackfill(adminId: string): Promise<StartBackfillResult> {
  const config = await getLowBalanceConfig();
  if (!config.enabled) {
    return { ok: false, reason: "disabled" };
  }
  const candidates = await countBackfillCandidates(config);
  try {
    const run = await prisma.lowBalanceBackfillRun.create({
      data: {
        status: LowBalanceBackfillStatus.PENDING,
        thresholdToman: config.thresholdToman,
        rearmBoundaryToman: rearmBoundaryToman(config),
        configVersion: config.configVersion,
        createdByAdminId: adminId,
        estimatedCount: candidates.expectedRecipients,
      },
    });
    return { ok: true, run: toView(run), candidates };
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
