import { type Prisma } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../../core/logger.js";
import { observeWalletBalance } from "./low-balance.service.js";

// =============================================================================
// The wallet -> low-balance bridge.
//
// Every wallet mutation site calls THIS, not the service directly, because of
// one invariant (§14): a defect in the notification feature must never fail a
// financial transaction.
//
// What the catch does and does NOT buy, precisely:
//
//   * A LOGIC error here (a TypeError, a bad assumption) is swallowed. The money
//     has already moved correctly and the reconciliation sweep repairs the state
//     this call failed to record, so the mutation stands.
//
//   * A DATABASE error is NOT actually recoverable by catching: PostgreSQL marks
//     the whole transaction aborted, so the caller's next statement fails with
//     25P02 and the financial mutation rolls back anyway. The catch does not
//     hide that — it only stops this module from being the thing that raises.
//     This is why the outbox insert uses ON CONFLICT DO NOTHING rather than
//     catching a unique violation: a raised 23505 would doom the checkout.
//
// It runs INSIDE the caller's transaction, so on the happy path the state
// transition and the outbox row commit atomically with the ledger entry, and a
// rolled-back financial transaction takes the notification with it — which is
// exactly what §7 case 10 requires.
// =============================================================================

export interface WalletBalanceObservation {
  userId: string;
  /**
   * The AUTHORITATIVE pre-mutation balance — the same value the caller wrote to
   * `WalletTransaction.balanceBeforeToman`. Every wallet site already computes
   * it for the ledger row, so this asks for nothing new; it is what lets a
   * FIRST observation tell a genuine crossing apart from an already-low user.
   */
  balanceBeforeToman: number;
  /** The committed post-mutation balance, as recorded on the ledger row. */
  balanceAfterToman: number;
  /** Safe provenance label for metrics (never a user identifier). */
  source: string;
}

/**
 * Records a committed wallet balance change against the low-balance state
 * machine. Never throws.
 */
export async function onWalletBalanceChanged(
  tx: Prisma.TransactionClient,
  observation: WalletBalanceObservation,
): Promise<void> {
  try {
    await observeWalletBalance(tx, {
      userId: observation.userId,
      balanceBeforeToman: observation.balanceBeforeToman,
      balanceAfterToman: observation.balanceAfterToman,
      source: observation.source,
    });
  } catch (err) {
    // Safe code only: no balance, no user identity, no ledger id.
    logger.warn("low-balance observation failed; reconciliation will repair", {
      source: observation.source,
      error: errorMessage(err),
    });
  }
}
