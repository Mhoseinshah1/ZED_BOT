import { LowBalanceBackfillStatus, prisma, SettingType } from "@zedbot/database";
import {
  formatTomanAmount,
  INT32_MAX,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

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

export type StartBackfillResult =
  | { ok: true; run: BackfillView; candidates: number }
  | { ok: false; reason: "disabled" | "already-running" };

/**
 * How many ACTIVE users are currently at or below the threshold.
 *
 * This is the number the confirmation screen shows an OWNER BEFORE anything is
 * sent. It is an aggregate count — the screen never lists who they are.
 */
export async function countBackfillCandidates(config: LowBalanceConfig): Promise<number> {
  return prisma.user.count({
    where: { status: "ACTIVE", balanceToman: { lte: config.thresholdToman } },
  });
}

/**
 * Creates the single backfill run. The worker advances it; this only authorises
 * it, freezing the config it was authorised against.
 *
 * A concurrent second attempt loses on the partial unique index and is reported
 * as `already-running` rather than silently creating a second run.
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
        estimatedCount: candidates,
      },
    });
    return { ok: true, run: toView(run), candidates };
  } catch {
    // The partial unique index rejected it: a run is already PENDING/RUNNING.
    return { ok: false, reason: "already-running" };
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
