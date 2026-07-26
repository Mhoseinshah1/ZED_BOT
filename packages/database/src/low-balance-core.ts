import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  LowBalanceAlertStateValue,
  type Prisma,
} from "@prisma/client";

// =============================================================================
// Low wallet balance — the ONE state-transition primitive.
//
// The live wallet observer, the reconciliation sweep and the OWNER backfill all
// go through this function. There is deliberately no second implementation of
// the transition rules, because three copies of "when do we alert" is how a
// user ends up notified twice or not at all.
//
// It lives in @zedbot/database because that is the only package both apps
// depend on that has Prisma. @zedbot/database carries no workspace deps, so the
// caller supplies the dedupe key and payload (built with @zedbot/shared) via
// `buildNotification`; the boundaries arrive as plain integers.
//
// MONEY. Whole Toman, the canonical `User.balanceToman` unit (PG INTEGER).
//
// -----------------------------------------------------------------------------
// CYCLE SEMANTICS — three distinct things, easy to confuse:
//
//   cycle 0, SILENT BASELINE
//     "This user was already below the threshold the first time we ever looked
//     at them." Recorded ALERTED so the machine is truthful, but NO message: we
//     did not witness a decrease, so claiming one would be a lie. This is what
//     enabling the feature produces for existing low-balance users.
//
//   cycle > 0, REAL ALERT
//     A witnessed crossing: the balance went from above the threshold to at or
//     below it. Exactly one message per cycle, keyed by the dedupe key.
//
//   cycle > 0, EXPLICIT BACKFILL
//     The OWNER asked us to notify people who are already low. Same shape as a
//     real alert and the same dedupe key, but opened without a witnessed
//     crossing — which is why it requires an explicit, confirmed action.
//
// -----------------------------------------------------------------------------
// FIRST OBSERVATION. A user can have no state row at all: the feature was
// enabled and the sweep has not reached them yet. The rule then depends on
// BOTH balances, which is why callers must pass the authoritative before value:
//
//   before >  threshold, after <= threshold  -> cycle 1, ALERTED, NOTIFY
//   before <= threshold, after <= threshold  -> cycle 0, ALERTED, silent
//   after  >  threshold                      -> cycle 0, ARMED,   silent
//
// Without the before value the first case is indistinguishable from the second,
// and a genuine first post-enable crossing is silently swallowed.
//
// CONCURRENCY. A missing row cannot be locked, so this seeds the row FIRST with
// ON CONFLICT DO NOTHING (never a caught unique violation, which would abort the
// caller's financial transaction) and only then takes FOR UPDATE on it. Two
// first observations therefore converge: one insert wins, both lock the same
// row in turn, and the second evaluates against the first's committed result.
//
// The seeded row describes the state implied by the BEFORE balance, and the
// transition is then evaluated to the AFTER balance from the locked row. That
// single trick makes the first observation behave exactly like every later one.
// =============================================================================

/** Whole Toman. */
export type TomanAmount = number;

export interface LowBalanceNotificationDraft {
  dedupeKey: string;
  ruleVersion: number;
  /** Safe render data only: no identity, no ledger id, no token. */
  payloadSnapshot: Prisma.InputJsonValue;
}

export interface LowBalanceObservationInput {
  userId: string;
  /**
   * The authoritative pre-mutation balance. `null` only where no edge exists —
   * the reconciliation sweep observing a user it has never seen.
   */
  balanceBeforeToman: TomanAmount | null;
  /** The committed post-mutation balance, read back under the row lock. */
  balanceAfterToman: TomanAmount;
  thresholdToman: TomanAmount;
  rearmBoundaryToman: TomanAmount;
  configVersion: number;
  /**
   * Whether this user may receive a message. An ineligible user still gets a
   * correct state transition — the machine must describe reality — but no
   * outbox row is written.
   */
  eligible: boolean;
  /**
   * Opens a cycle even from a silent baseline. ONLY the OWNER-confirmed
   * backfill sets this; nothing automatic may.
   */
  forceAlert?: boolean;
  /** Called at most once, only when a cycle is opened. */
  buildNotification: (cycle: number) => LowBalanceNotificationDraft;
}

export type LowBalanceObservationOutcome =
  | { kind: "seeded-armed"; cycle: number }
  | { kind: "seeded-baseline"; cycle: number }
  | { kind: "alerted"; cycle: number; notificationId: string | null }
  | { kind: "rearmed"; cycle: number }
  | { kind: "unchanged"; cycle: number };

interface LockedState {
  id: string;
  state: LowBalanceAlertStateValue;
  alertCycle: number;
}

/**
 * Applies one observation to a user's low-balance state, inside the caller's
 * transaction. Writes the state row and, when a cycle opens, the outbox row —
 * atomically, because they commit together or not at all.
 *
 * Never reads or writes money. Never performs I/O.
 */
export async function applyLowBalanceObservation(
  tx: Prisma.TransactionClient,
  input: LowBalanceObservationInput,
): Promise<LowBalanceObservationOutcome> {
  const seeded = await seedAndLockState(tx, input);

  // AUTHORITATIVE BALANCE. When the caller witnessed the edge itself (a wallet
  // mutation, inside the very transaction that moved the money) its `after` is
  // authoritative by construction. When it did not — the sweep and the backfill
  // pass a null `before` — the balance must be re-read HERE, under the state
  // lock we now hold. Reading it earlier and deciding later is a real race: a
  // wallet mutation committing in between makes the sweep judge a stale balance
  // against fresh state, which can re-arm a user who just alerted and let the
  // next pass open a second cycle for the same decrease.
  const balanceAfterToman =
    input.balanceBeforeToman === null
      ? ((
          await tx.user.findUnique({
            where: { id: input.userId },
            select: { balanceToman: true },
          })
        )?.balanceToman ?? input.balanceAfterToman)
      : input.balanceAfterToman;

  const effective = { ...input, balanceAfterToman };
  const isLow = balanceAfterToman <= input.thresholdToman;
  const isRecovered = balanceAfterToman > input.rearmBoundaryToman;

  if (seeded.state.state === LowBalanceAlertStateValue.ALERTED) {
    if (isRecovered) {
      await rearm(tx, seeded.state.id, seeded.state.alertCycle, effective);
      return { kind: "rearmed", cycle: seeded.state.alertCycle };
    }
    // An explicit backfill may open a real cycle from here. Usually that is a
    // silent baseline (cycle 0). It can also be an older cycle that carries no
    // message — only reachable in data written before the state change and the
    // outbox insert were made atomic — and repairing that is exactly what the
    // OWNER asked for. The caller checks "does this cycle already have its
    // message" before ever setting the flag, so this cannot re-notify.
    if (input.forceAlert === true && isLow) {
      return openCycle(tx, seeded.state, effective);
    }
    await touch(tx, seeded.state.id, effective);
    // A row this call just created, still low: the silent baseline. No message,
    // because no decrease was witnessed.
    return seeded.created
      ? { kind: "seeded-baseline", cycle: seeded.state.alertCycle }
      : { kind: "unchanged", cycle: seeded.state.alertCycle };
  }

  // ARMED.
  if (isLow) {
    return openCycle(tx, seeded.state, effective);
  }
  await touch(tx, seeded.state.id, effective);
  return seeded.created
    ? { kind: "seeded-armed", cycle: seeded.state.alertCycle }
    : { kind: "unchanged", cycle: seeded.state.alertCycle };
}

/**
 * Ensures the row exists and returns it LOCKED.
 *
 * The insert is `ON CONFLICT DO NOTHING` rather than a create wrapped in a
 * try/catch: a raised 23505 would mark the surrounding PostgreSQL transaction
 * aborted, and since this runs inside a wallet mutation that would roll back a
 * real financial transaction because of a notification bookkeeping row.
 */
async function seedAndLockState(
  tx: Prisma.TransactionClient,
  input: LowBalanceObservationInput,
): Promise<{ state: LockedState; created: boolean }> {
  // Seed from the BEFORE balance so the first observation still has an edge to
  // evaluate. With no before value there is no edge, so fall back to AFTER,
  // which yields a silent baseline for an already-low user.
  const seedBalance = input.balanceBeforeToman ?? input.balanceAfterToman;
  const seedLow = seedBalance <= input.thresholdToman;
  const seedState = seedLow
    ? LowBalanceAlertStateValue.ALERTED
    : LowBalanceAlertStateValue.ARMED;

  const inserted = await tx.lowBalanceAlertState.createMany({
    data: [
      {
        userId: input.userId,
        state: seedState,
        alertCycle: 0,
        lastObservedBalanceToman: seedBalance,
        lastThresholdToman: input.thresholdToman,
        lastRearmBoundaryToman: input.rearmBoundaryToman,
        lastConfigVersion: input.configVersion,
        alertedAt: seedLow ? new Date() : null,
      },
    ],
    skipDuplicates: true,
  });

  const rows = await tx.$queryRaw<LockedState[]>`
    SELECT "id", "state", "alertCycle"
    FROM "LowBalanceAlertState"
    WHERE "userId" = ${input.userId}
    FOR UPDATE
  `;
  const state = rows[0];
  if (state === undefined) {
    // Only reachable if the row was deleted between the insert and the lock
    // (a user removal). Nothing to record.
    throw new Error("low-balance state row vanished during observation");
  }
  return { state, created: inserted.count === 1 };
}

/** Records what we saw without changing which side of the machine we are on. */
async function touch(
  tx: Prisma.TransactionClient,
  id: string,
  input: LowBalanceObservationInput,
): Promise<void> {
  await tx.lowBalanceAlertState.update({
    where: { id },
    data: {
      lastObservedBalanceToman: input.balanceAfterToman,
      lastThresholdToman: input.thresholdToman,
      lastRearmBoundaryToman: input.rearmBoundaryToman,
      lastConfigVersion: input.configVersion,
    },
  });
}

async function rearm(
  tx: Prisma.TransactionClient,
  id: string,
  cycle: number,
  input: LowBalanceObservationInput,
): Promise<void> {
  // Re-arming does NOT advance the cycle: it closes an episode, it does not
  // open one.
  await tx.lowBalanceAlertState.update({
    where: { id },
    data: {
      state: LowBalanceAlertStateValue.ARMED,
      lastObservedBalanceToman: input.balanceAfterToman,
      lastThresholdToman: input.thresholdToman,
      lastRearmBoundaryToman: input.rearmBoundaryToman,
      lastConfigVersion: input.configVersion,
      rearmedAt: new Date(),
    },
  });
  void cycle;
}

/**
 * Advances to the next alert cycle and writes its outbox row in the SAME
 * transaction.
 *
 * This atomicity is the invariant that keeps the feature from going silent
 * forever: a committed cycle greater than zero always has its deterministic
 * notification. If the state advanced but the outbox insert were a separate
 * commit, a crash in between would leave the user ALERTED with nothing queued,
 * and every later pass would skip them as "already alerted".
 */
async function openCycle(
  tx: Prisma.TransactionClient,
  state: LockedState,
  input: LowBalanceObservationInput,
): Promise<LowBalanceObservationOutcome> {
  const cycle = state.alertCycle + 1;
  await tx.lowBalanceAlertState.update({
    where: { id: state.id },
    data: {
      state: LowBalanceAlertStateValue.ALERTED,
      alertCycle: cycle,
      lastObservedBalanceToman: input.balanceAfterToman,
      lastThresholdToman: input.thresholdToman,
      lastRearmBoundaryToman: input.rearmBoundaryToman,
      lastConfigVersion: input.configVersion,
      alertedAt: new Date(),
    },
  });

  if (!input.eligible) {
    // State corrected, deliberately silent.
    return { kind: "alerted", cycle, notificationId: null };
  }

  const draft = input.buildNotification(cycle);
  const created = await tx.automatedNotification.createMany({
    data: [
      {
        type: AutomatedNotificationType.WALLET_LOW_BALANCE,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: input.userId,
        dedupeKey: draft.dedupeKey,
        ruleVersion: draft.ruleVersion,
        scheduledFor: new Date(),
        payloadSnapshot: draft.payloadSnapshot,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) {
    // The deterministic key already exists for this cycle: another producer got
    // here first. Not an error — that is exactly what the key is for.
    const existing = await tx.automatedNotification.findUnique({
      where: { dedupeKey: draft.dedupeKey },
      select: { id: true },
    });
    return { kind: "alerted", cycle, notificationId: existing?.id ?? null };
  }
  const row = await tx.automatedNotification.findUnique({
    where: { dedupeKey: draft.dedupeKey },
    select: { id: true },
  });
  return { kind: "alerted", cycle, notificationId: row?.id ?? null };
}

/**
 * Whether a cycle already has its notification.
 *
 * Used by the backfill to tell a silent baseline (cycle 0, no message ever)
 * apart from a cycle that was genuinely notified.
 */
export async function hasNotificationForCycle(
  tx: Prisma.TransactionClient,
  dedupeKey: string,
): Promise<boolean> {
  const row = await tx.automatedNotification.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  return row !== null;
}
