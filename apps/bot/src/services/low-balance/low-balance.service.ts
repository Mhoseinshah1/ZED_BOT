import {
  applyLowBalanceObservation,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  Prisma,
  prisma,
  UserStatus,
} from "@zedbot/database";
import {
  DEFAULT_LOW_BALANCE_CONFIG,
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  buildLowBalanceSnapshot,
  isLowBalance,
  isRearmed,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_RULE_VERSION,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

import { getBooleanSetting, getSetting, isTruthySettingValue } from "../settings.service.js";

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

/** Toman, whole numbers — the canonical `User.balanceToman` unit. */
export type Toman = number;

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

/**
 * Transaction-scoped config read for the in-transaction observer. Uses the
 * settings ROWS rather than the process cache so a wallet mutation cannot act on
 * a config the database has already moved past — the same reasoning the terms
 * acceptance path uses.
 *
 * Exported as `readLowBalanceConfigRows` because the admin surface needs the
 * same thing for a different reason: a configuration mutation and a backfill
 * snapshot must both see ONE coherent (threshold, margin, version) tuple, taken
 * under the configuration lock. Four cached reads are not one tuple.
 */
async function getConfigInTransaction(tx: Prisma.TransactionClient): Promise<LowBalanceConfig> {
  const rows = await tx.setting.findMany({
    where: {
      key: {
        in: [
          LOW_BALANCE_ENABLED_KEY,
          LOW_BALANCE_THRESHOLD_KEY,
          LOW_BALANCE_REARM_MARGIN_KEY,
          LOW_BALANCE_CONFIG_VERSION_KEY,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    enabled: isTruthySettingValue(byKey.get(LOW_BALANCE_ENABLED_KEY)),
    thresholdToman: parseIntSetting(
      byKey.get(LOW_BALANCE_THRESHOLD_KEY) ?? "",
      DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
    ),
    rearmMarginToman: parseIntSetting(
      byKey.get(LOW_BALANCE_REARM_MARGIN_KEY) ?? "",
      DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
    ),
    configVersion: parseIntSetting(
      byKey.get(LOW_BALANCE_CONFIG_VERSION_KEY) ?? "",
      DEFAULT_LOW_BALANCE_CONFIG.configVersion,
    ),
  };
}

export { getConfigInTransaction as readLowBalanceConfigRows };

// --- the observer ------------------------------------------------------------

export interface ObserveArgs {
  userId: string;
  /**
   * The AUTHORITATIVE pre-mutation balance — the same value the caller wrote to
   * `WalletTransaction.balanceBeforeToman`.
   *
   * It is required, not decorative. A user can have no state row yet (the
   * feature was enabled and the sweep has not reached them), and without the
   * before value a genuine first crossing from above the threshold to below it
   * is indistinguishable from a user who was already low — so the alert would
   * be silently swallowed. `null` is accepted only where no edge exists.
   */
  balanceBeforeToman: Toman | null;
  /** The COMMITTED post-mutation balance, read back under the row lock. */
  balanceAfterToman: Toman;
  /** Safe provenance label for metrics only (e.g. "ORDER", "TOPUP"). */
  source?: string;
}

export type ObserveOutcome =
  | { kind: "disabled" }
  | { kind: "ineligible" }
  | { kind: "alerted"; cycle: number; notificationId: string | null }
  | { kind: "rearmed"; cycle: number }
  | { kind: "seeded"; cycle: number }
  | { kind: "unchanged" };

/**
 * THE wallet integration point (§4).
 *
 * Called from inside the SAME transaction that just moved a balance and wrote
 * its WalletTransaction row, with the exact before/after pair that ledger row
 * recorded. Every wallet path funnels through here, so the state machine sees
 * checkout, renewal, auto-renewal, extra volume/time, admin credit/debit,
 * approved receipts, gateway and Stars fulfilment, referral rewards, refunds
 * and settlements identically.
 *
 * The transition itself lives in ONE place — `applyLowBalanceObservation` in
 * @zedbot/database — shared with the reconciliation sweep and the backfill, so
 * there is no second implementation of "when do we alert" to drift.
 *
 * It writes at most two rows and performs no network I/O, so it cannot fail a
 * financial transaction for an external reason.
 */
export async function observeWalletBalance(
  tx: Prisma.TransactionClient,
  args: ObserveArgs,
): Promise<ObserveOutcome> {
  const config = await getConfigInTransaction(tx);
  if (!config.enabled) {
    return { kind: "disabled" };
  }

  // Eligibility is an ENQUEUE-time optimisation only; delivery re-checks it
  // authoritatively. An ineligible user still gets a correct state transition.
  const user = await tx.user.findUnique({
    where: { id: args.userId },
    select: {
      status: true,
      lowBalanceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
    },
  });
  if (user === null) {
    return { kind: "ineligible" };
  }
  const eligibility = evaluateEligibility(user);

  const outcome = await applyLowBalanceObservation(tx, {
    userId: args.userId,
    balanceBeforeToman: args.balanceBeforeToman,
    balanceAfterToman: args.balanceAfterToman,
    thresholdToman: config.thresholdToman,
    rearmBoundaryToman: rearmBoundaryToman(config),
    configVersion: config.configVersion,
    eligible: eligibility.eligible,
    buildNotification: (cycle) => ({
      dedupeKey: lowBalanceDedupeKey(args.userId, cycle),
      ruleVersion: LOW_BALANCE_RULE_VERSION,
      payloadSnapshot: buildLowBalanceSnapshot({
        balanceToman: args.balanceAfterToman,
        thresholdToman: config.thresholdToman,
        rearmBoundaryToman: rearmBoundaryToman(config),
        configVersion: config.configVersion,
        alertCycle: cycle,
        origin: "event",
      }) as unknown as Prisma.InputJsonValue,
    }),
  });

  switch (outcome.kind) {
    case "alerted":
      return eligibility.eligible
        ? { kind: "alerted", cycle: outcome.cycle, notificationId: outcome.notificationId }
        : { kind: "ineligible" };
    case "rearmed":
      return { kind: "rearmed", cycle: outcome.cycle };
    case "seeded-armed":
    case "seeded-baseline":
      return { kind: "seeded", cycle: outcome.cycle };
    default:
      return { kind: "unchanged" };
  }
}

// --- eligibility -------------------------------------------------------------

/**
 * Whether this user may receive a low-balance message at all (§10).
 *
 * Checked at ENQUEUE time only as an optimisation; delivery re-checks it
 * authoritatively, so a preference flipped after enqueue is still honoured.
 */
export interface LowBalanceEligibility {
  eligible: boolean;
  reason?: "inactive" | "opted-out" | "payment-category-off";
}

export function evaluateEligibility(user: {
  status: UserStatus;
  lowBalanceNotificationsEnabled: boolean;
  paymentNotificationsEnabled: boolean;
}): LowBalanceEligibility {
  if (user.status !== UserStatus.ACTIVE) {
    return { eligible: false, reason: "inactive" };
  }
  if (!user.lowBalanceNotificationsEnabled) {
    return { eligible: false, reason: "opted-out" };
  }
  if (!user.paymentNotificationsEnabled) {
    return { eligible: false, reason: "payment-category-off" };
  }
  return { eligible: true };
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
