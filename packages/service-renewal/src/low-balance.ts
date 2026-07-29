import {
  applyLowBalanceObservation,
  UserStatus,
  type Prisma,
} from "@zedbot/database";
import {
  DEFAULT_LOW_BALANCE_CONFIG,
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  buildLowBalanceSnapshot,
  LOW_BALANCE_CONFIG_VERSION_KEY,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_RULE_VERSION,
  LOW_BALANCE_THRESHOLD_KEY,
  lowBalanceDedupeKey,
  rearmBoundaryToman,
  type LowBalanceConfig,
} from "@zedbot/shared";

// =============================================================================
// The in-transaction low-balance observer.
//
// WHY IT MOVED. Every wallet mutation in this system calls this from inside the
// transaction that moved the balance, so the state machine sees checkout,
// renewal, auto-renewal, add-ons, admin adjustments, receipts, gateways, Stars,
// referrals and refunds identically. A Mini App settlement that skipped it would
// be the first wallet path in the codebase that does not — the user would stop
// receiving low-balance warnings depending on which door they bought through.
//
// Only the IN-TRANSACTION path is here. The admin console, the overview read
// models and the backfill stay in the bot: they render, and they are operator
// surfaces, not part of what a payment does.
//
// IT NEVER TOUCHES MONEY and it NEVER TALKS TO TELEGRAM. It reads the balance it
// is told about and writes at most two rows — the state transition and a durable
// notification outbox entry. Delivery happens later in the worker, so a Telegram
// outage can never roll back a checkout.
//
// The transition itself lives in ONE place, `applyLowBalanceObservation` in
// @zedbot/database, shared with the reconciliation sweep and the backfill, so
// there is no second implementation of "when do we alert" to drift.
// =============================================================================

/** Toman, whole numbers — the canonical `User.balanceToman` unit. */
export type Toman = number;

function parseIntSetting(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The exact truthy set this repository uses for boolean settings.
 *
 * Duplicating the list rather than importing the bot's reader is deliberate —
 * the package cannot import an app — and the two are pinned together by
 * `ROLL-6`, which asserts every spelling reads the same on both sides.
 */
const TRUTHY_SETTING_VALUES = ["true", "1", "yes"];

function isTruthySettingValue(raw: string | null | undefined): boolean {
  return raw !== null && raw !== undefined && TRUTHY_SETTING_VALUES.includes(raw.toLowerCase());
}

/**
 * Transaction-scoped config read. Uses the settings ROWS rather than any process
 * cache so a wallet mutation cannot act on a config the database has already
 * moved past.
 */
export async function readLowBalanceConfigRows(
  tx: Prisma.TransactionClient,
): Promise<LowBalanceConfig> {
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

export interface LowBalanceEligibility {
  eligible: boolean;
  reason?: "inactive" | "opted-out" | "payment-category-off";
}

/** Whether this user may receive a low-balance alert at all. */
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

export interface ObserveArgs {
  userId: string;
  /**
   * The AUTHORITATIVE pre-mutation balance — the same value the caller wrote to
   * `WalletTransaction.balanceBeforeToman`.
   *
   * Required, not decorative. A user can have no state row yet, and without the
   * before value a genuine first crossing from above the threshold to below it
   * is indistinguishable from a user who was already low, so the alert would be
   * silently swallowed.
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

/** THE wallet integration point. Called inside the balance-moving transaction. */
export async function observeWalletBalance(
  tx: Prisma.TransactionClient,
  args: ObserveArgs,
): Promise<ObserveOutcome> {
  const config = await readLowBalanceConfigRows(tx);
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

/**
 * The wallet → low-balance bridge every mutation site calls.
 *
 * One invariant justifies the catch: a defect in the notification feature must
 * never fail a financial transaction.
 *
 * What the catch does and does NOT buy, precisely:
 *
 *   * A LOGIC error here is swallowed. The money has already moved correctly and
 *     the reconciliation sweep repairs the state this call failed to record, so
 *     the mutation stands.
 *
 *   * A DATABASE error is NOT actually recoverable by catching: PostgreSQL marks
 *     the whole transaction aborted, so the caller's next statement fails with
 *     25P02 and the financial mutation rolls back anyway. The catch does not
 *     hide that — it only stops this module from being the thing that raises.
 */
export async function onWalletBalanceChanged(
  tx: Prisma.TransactionClient,
  args: ObserveArgs,
): Promise<void> {
  try {
    await observeWalletBalance(tx, args);
  } catch {
    // Deliberately swallowed, and deliberately not logged from here: the caller
    // owns the transaction and the logger, and this package has neither.
  }
}
