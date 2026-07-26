import {
  LowBalanceAlertStateValue,
  prisma,
  UserStatus,
  type AutomatedNotification,
} from "@zedbot/database";
import {
  DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_REARM_MARGIN_KEY,
  LOW_BALANCE_THRESHOLD_KEY,
} from "@zedbot/shared";

// =============================================================================
// Low-balance SEND-TIME policy (§8).
//
// A queued alert is a claim about the past. Before it is delivered, three things
// are re-checked against the DATABASE — never against the snapshot alone:
//
//   1. the feature is still enabled;
//   2. the user still wants this alert;
//   3. the balance is still low.
//
// A user who topped up between the crossing and the delivery must NOT receive a
// "you are running out of money" warning. Cancelling is always preferred to
// sending something already false.
//
// THRESHOLD-CHANGE POLICY (§13). The recovery test uses the re-arm boundary the
// cycle was OPENED under, carried in the notification snapshot — not whatever
// the OWNER has configured since. An operator raising the threshold must not
// retroactively turn a historical alert into a lie, and lowering it must not
// silently cancel alerts that were correct when they were created.
// =============================================================================

export type LowBalanceDecision =
  | { kind: "cancel"; reason: string }
  | null;

interface LowBalanceMeta {
  /**
   * The alert cycle this notification belongs to. Deliberately NOT called
   * `cycle`: the shared re-validation meta already uses that name for the
   * expiry FINGERPRINT, which is a string.
   */
  alertCycle?: number;
  configVersion?: number;
  thresholdToman?: number;
  rearmBoundaryToman?: number;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

async function isFeatureEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({
    where: { key: LOW_BALANCE_ENABLED_KEY },
    select: { value: true },
  });
  const raw = (row?.value ?? "").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * The live boundary, used only as a FALLBACK when a notification predates the
 * snapshot format. Current notifications always carry their own boundary.
 */
async function liveRearmBoundary(): Promise<number> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [LOW_BALANCE_THRESHOLD_KEY, LOW_BALANCE_REARM_MARGIN_KEY] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const threshold = byKey.get(LOW_BALANCE_THRESHOLD_KEY);
  const margin = byKey.get(LOW_BALANCE_REARM_MARGIN_KEY);
  return (
    (Number.isInteger(threshold) ? (threshold as number) : DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN) +
    (Number.isInteger(margin) ? (margin as number) : DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN)
  );
}

/**
 * Re-validates one queued WALLET_LOW_BALANCE notification.
 *
 * Returns a cancellation decision, or null to proceed with delivery. Also
 * RE-ARMS the state machine when it cancels for recovery: the user is provably
 * above the boundary, so leaving the machine ALERTED would suppress the next
 * genuine crossing.
 */
export async function revalidateLowBalanceForDelivery(
  notification: AutomatedNotification,
  meta: LowBalanceMeta,
): Promise<LowBalanceDecision> {
  if (!(await isFeatureEnabled())) {
    return { kind: "cancel", reason: "low-balance-disabled" };
  }

  const user = await prisma.user.findUnique({
    where: { id: notification.userId },
    select: {
      status: true,
      balanceToman: true,
      lowBalanceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
    },
  });
  if (user === null) {
    return { kind: "cancel", reason: "user-gone" };
  }
  if (user.status !== UserStatus.ACTIVE) {
    return { kind: "cancel", reason: "user-inactive" };
  }
  // The focused opt-out is checked IN ADDITION to the PAYMENT category gate the
  // delivery worker already applied, so silencing this one alert does not
  // require silencing every payment notice.
  if (!user.lowBalanceNotificationsEnabled) {
    return { kind: "cancel", reason: "low-balance-opted-out" };
  }

  const boundary = readNumber(meta.rearmBoundaryToman, await liveRearmBoundary());
  if (user.balanceToman > boundary) {
    // Recovered before delivery. Cancel the obsolete warning AND re-arm, so the
    // next real crossing is not swallowed by a stale ALERTED state.
    await prisma.lowBalanceAlertState.updateMany({
      where: {
        userId: notification.userId,
        state: LowBalanceAlertStateValue.ALERTED,
        alertCycle: readNumber(meta.alertCycle, -1),
      },
      data: {
        state: LowBalanceAlertStateValue.ARMED,
        lastObservedBalanceToman: user.balanceToman,
        rearmedAt: new Date(),
      },
    });
    return { kind: "cancel", reason: "balance-recovered" };
  }

  return null;
}
