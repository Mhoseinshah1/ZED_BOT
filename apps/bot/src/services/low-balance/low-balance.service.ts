import {
  AutomatedNotificationCategory,
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
  evaluateLowBalanceTransition,
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
  type LowBalanceState,
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

// --- the observer ------------------------------------------------------------

export interface ObserveArgs {
  userId: string;
  /** The COMMITTED post-mutation balance, read back under the row lock. */
  balanceAfterToman: Toman;
  /** Safe provenance label for metrics only (e.g. "ORDER", "TOPUP"). */
  source?: string;
}

export type ObserveOutcome =
  | { kind: "disabled" }
  | { kind: "ineligible" }
  | { kind: "alerted"; cycle: number; notificationId: string }
  | { kind: "rearmed"; cycle: number }
  | { kind: "unchanged" };

/**
 * THE wallet integration point (§4).
 *
 * Called from inside the SAME transaction that just moved a balance and wrote
 * its WalletTransaction row, with the exact committed `balanceAfterToman` that
 * ledger row recorded. Every wallet path funnels through here, so the state
 * machine sees checkout, renewal, auto-renewal, extra volume/time, admin
 * credit/debit, approved receipts, gateway and Stars fulfilment, referral
 * rewards, refunds and settlements identically.
 *
 * It writes at most two rows (the state row and one notification) and performs
 * no network I/O, so it cannot fail a financial transaction for an external
 * reason. It deliberately does NOT throw on its own errors — see the callers'
 * wrapper — because a wallet mutation must never be lost to a notification bug.
 */
export async function observeWalletBalance(
  tx: Prisma.TransactionClient,
  args: ObserveArgs,
): Promise<ObserveOutcome> {
  const config = await getConfigInTransaction(tx);
  if (!config.enabled) {
    return { kind: "disabled" };
  }

  // Serialize this user's machine. Two concurrent debits both crossing the
  // threshold contend here, so exactly one observes ARMED and alerts; the other
  // observes ALERTED and stays silent. Without the lock both could read ARMED.
  const [existing] = await tx.$queryRaw<
    { id: string; state: LowBalanceAlertStateValue; alertCycle: number }[]
  >`
    SELECT "id", "state", "alertCycle"
    FROM "LowBalanceAlertState"
    WHERE "userId" = ${args.userId}
    FOR UPDATE
  `;

  const boundary = rearmBoundaryToman(config);
  const balance = args.balanceAfterToman;

  if (existing === undefined) {
    // First observation for this user. A user who is ALREADY low when the
    // machine first sees them is recorded as ALERTED *without* a message: that
    // is the "future crossings only" rule (§16) and it is what stops enabling
    // the feature from blasting the historical low-balance population. An
    // explicit OWNER backfill is the only way to notify them.
    const initial: LowBalanceState = isLowBalance(balance, config) ? "ALERTED" : "ARMED";
    await tx.lowBalanceAlertState.create({
      data: {
        userId: args.userId,
        state: initial as LowBalanceAlertStateValue,
        alertCycle: 0,
        lastObservedBalanceToman: balance,
        lastThresholdToman: config.thresholdToman,
        lastRearmBoundaryToman: boundary,
        lastConfigVersion: config.configVersion,
        alertedAt: initial === "ALERTED" ? new Date() : null,
      },
    });
    return { kind: initial === "ALERTED" ? "unchanged" : "unchanged" };
  }

  const transition = evaluateLowBalanceTransition(
    existing.state as LowBalanceState,
    balance,
    config,
  );

  if (transition.kind === "none") {
    await tx.lowBalanceAlertState.update({
      where: { id: existing.id },
      data: { lastObservedBalanceToman: balance },
    });
    return { kind: "unchanged" };
  }

  if (transition.kind === "rearm") {
    await tx.lowBalanceAlertState.update({
      where: { id: existing.id },
      data: {
        state: LowBalanceAlertStateValue.ARMED,
        lastObservedBalanceToman: balance,
        lastThresholdToman: config.thresholdToman,
        lastRearmBoundaryToman: boundary,
        lastConfigVersion: config.configVersion,
        rearmedAt: new Date(),
      },
    });
    return { kind: "rearmed", cycle: existing.alertCycle };
  }

  // --- ARMED -> ALERTED: the one transition that produces a message ----------
  const cycle = existing.alertCycle + 1;
  await tx.lowBalanceAlertState.update({
    where: { id: existing.id },
    data: {
      state: LowBalanceAlertStateValue.ALERTED,
      alertCycle: cycle,
      lastObservedBalanceToman: balance,
      lastThresholdToman: config.thresholdToman,
      lastRearmBoundaryToman: boundary,
      lastConfigVersion: config.configVersion,
      alertedAt: new Date(),
    },
  });

  const notificationId = await enqueueLowBalanceNotification(tx, {
    userId: args.userId,
    cycle,
    balanceToman: balance,
    config,
    origin: "event",
  });
  return notificationId === null
    ? { kind: "unchanged" }
    : { kind: "alerted", cycle, notificationId };
}

// --- the outbox --------------------------------------------------------------

interface EnqueueArgs {
  userId: string;
  cycle: number;
  balanceToman: Toman;
  config: LowBalanceConfig;
  origin: "event" | "backfill" | "reconcile";
}

/**
 * Writes the durable outbox row (§4/§5) in the caller's transaction.
 *
 * `AutomatedNotification` IS the outbox: it already carries a unique dedupeKey,
 * a status lifecycle, retry counters and crash-safe re-claim. Re-using it means
 * no parallel send subsystem, and it means the notification commits or rolls
 * back atomically with the state transition that justified it.
 *
 * The snapshot holds ONLY safe render data — two Toman figures the user is about
 * to be shown. No name, username, phone number, chat id, ledger id or payment
 * token ever enters it.
 */
async function enqueueLowBalanceNotification(
  tx: Prisma.TransactionClient,
  args: EnqueueArgs,
): Promise<string | null> {
  const dedupeKey = lowBalanceDedupeKey(args.userId, args.cycle);
  const now = new Date();
  // skipDuplicates compiles to INSERT ... ON CONFLICT DO NOTHING. A raised
  // unique violation would ABORT the surrounding financial transaction, so a
  // duplicate must be absorbed by the index and never by a caught error.
  const created = await tx.automatedNotification.createMany({
    data: [
      {
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: args.userId,
        dedupeKey,
        ruleVersion: LOW_BALANCE_RULE_VERSION,
        scheduledFor: now,
        payloadSnapshot: {
          variables: {
            balance: args.balanceToman,
            threshold: args.config.thresholdToman,
          },
          meta: {
            kind: "low-balance",
            cycle: args.cycle,
            // The config the cycle was opened under. Delivery interprets the
            // alert with THESE numbers, never with unrelated newer settings.
            configVersion: args.config.configVersion,
            thresholdToman: args.config.thresholdToman,
            rearmBoundaryToman: rearmBoundaryToman(args.config),
            origin: args.origin,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) {
    return null;
  }
  const row = await tx.automatedNotification.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  return row?.id ?? null;
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
