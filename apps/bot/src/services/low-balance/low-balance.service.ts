import {
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  prisma,
  UserStatus,
} from "@zedbot/database";
import {
  DEFAULT_LOW_BALANCE_CONFIG,
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  isLowBalance,
  isRearmed,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

import {
  evaluateEligibility,
  observeWalletBalance,
  readLowBalanceConfigRows,
  type LowBalanceEligibility,
  type ObserveArgs,
  type ObserveOutcome,
  type Toman,
} from "@zedbot/service-renewal";

import { getBooleanSetting, getSetting } from "../settings.service.js";

// The in-transaction observer now lives in @zedbot/service-renewal so a Mini App
// settlement runs the SAME state machine a Bot settlement does. Re-exported here
// so every existing bot import is unchanged and there is one implementation.
export {
  evaluateEligibility,
  observeWalletBalance,
  readLowBalanceConfigRows,
  type LowBalanceEligibility,
  type ObserveArgs,
  type ObserveOutcome,
  type Toman,
};

// =============================================================================
// Low wallet balance — the durable state machine (§3, §4, §7).
//
// This module is the ONLY writer of LowBalanceAlertState and the only producer
// of WALLET_LOW_BALANCE notifications. Two rules govern every line of it:
//
//   1. It NEVER touches money. It reads `User.balanceToman` and records what it
//      observed; it never writes a balance, a ledger row or a total. Nothing
//      here can change what a user is owed or owes.
//
//   2. It NEVER talks to Telegram. The in-transaction path only writes rows —
//      the state transition and a durable AutomatedNotification (the outbox).
//      Delivery happens later, in the worker, so a Telegram outage can never
//      roll back a checkout.
// =============================================================================

// --- configuration -----------------------------------------------------------

function parseIntSetting(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The live configuration. Read through the cached settings helpers because this
 * runs on the wallet hot path; correctness does not depend on freshness here,
 * since the authoritative decisions (send / cancel) are re-made at delivery
 * against the database.
 */
export async function getLowBalanceConfig(): Promise<LowBalanceConfig> {
  const [enabled, threshold, margin, version] = await Promise.all([
    getBooleanSetting(LOW_BALANCE_ENABLED_KEY, DEFAULT_LOW_BALANCE_CONFIG.enabled),
    getSetting(LOW_BALANCE_THRESHOLD_KEY, ""),
    getSetting(LOW_BALANCE_REARM_MARGIN_KEY, ""),
    getSetting(LOW_BALANCE_CONFIG_VERSION_KEY, ""),
  ]);
  return {
    enabled,
    thresholdToman: parseIntSetting(threshold, DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN),
    rearmMarginToman: parseIntSetting(margin, DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN),
    configVersion: parseIntSetting(version, DEFAULT_LOW_BALANCE_CONFIG.configVersion),
  };
}

// --- read models -------------------------------------------------------------

export interface LowBalanceOverview {
  config: LowBalanceConfig;
  rearmBoundaryToman: number;
  belowThreshold: number;
  alerted: number;
  armed: number;
  queued: number;
  sentRecently: number;
  terminalFailures: number;
  cancelledRecovered: number;
  cancelledDisabled: number;
}

const RECENT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The admin overview (§11). Every figure is an aggregate — no user identity is
 * selected, so the screen cannot leak who is low on funds.
 */
export async function getLowBalanceOverview(): Promise<LowBalanceOverview> {
  const config = await getLowBalanceConfig();
  const since = new Date(Date.now() - RECENT_WINDOW_MS);
  const [belowThreshold, alerted, armed, queued, sentRecently, terminalFailures, cancelled] =
    await Promise.all([
      prisma.user.count({
        where: { status: UserStatus.ACTIVE, balanceToman: { lte: config.thresholdToman } },
      }),
      prisma.lowBalanceAlertState.count({ where: { state: LowBalanceAlertStateValue.ALERTED } }),
      prisma.lowBalanceAlertState.count({ where: { state: LowBalanceAlertStateValue.ARMED } }),
      prisma.automatedNotification.count({
        where: {
          type: AutomatedNotificationType.WALLET_LOW_BALANCE,
          status: {
            in: [
              AutomatedNotificationStatus.SCHEDULED,
              AutomatedNotificationStatus.READY,
              AutomatedNotificationStatus.SENDING,
            ],
          },
        },
      }),
      prisma.automatedNotification.count({
        where: {
          type: AutomatedNotificationType.WALLET_LOW_BALANCE,
          status: AutomatedNotificationStatus.SENT,
          sentAt: { gte: since },
        },
      }),
      prisma.automatedNotification.count({
        where: {
          type: AutomatedNotificationType.WALLET_LOW_BALANCE,
          status: AutomatedNotificationStatus.DEAD_LETTER,
        },
      }),
      prisma.automatedNotification.count({
        where: {
          type: AutomatedNotificationType.WALLET_LOW_BALANCE,
          status: AutomatedNotificationStatus.CANCELLED,
          cancelledAt: { gte: since },
        },
      }),
    ]);
  return {
    config,
    rearmBoundaryToman: rearmBoundaryToman(config),
    belowThreshold,
    alerted,
    armed,
    queued,
    sentRecently,
    terminalFailures,
    // Cancellation reasons live in the safe error code; the overview reports the
    // total and the operations log carries the breakdown.
    cancelledRecovered: cancelled,
    cancelledDisabled: 0,
  };
}

export { isLowBalance, isRearmed, rearmBoundaryToman };
