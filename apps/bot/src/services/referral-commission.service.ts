import {
  OrderStatus,
  Prisma,
  ReferralCommissionStatus,
  WalletTransactionSource,
  WalletTransactionType,
  prisma,
} from "@zedbot/database";
import { isOrderWithinReferralHorizon, planReferralClawback, resolveReferralCommission } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  getReferralCommissionsStartedAt,
  getReferralConfig,
  isReferralSystemEnabled,
} from "./referral.service.js";

// =============================================================================
// Referral affiliate commissions — the money engine (financial-safety phase).
// When a REFERRED user's order completes, the REFERRER earns a configured percent
// of the order (floored) credited to their internal wallet. Every wallet mutation
// here runs in the BOT process (co-located with the wallet ledger); the worker
// discovers work and PRODUCES execute jobs the bot consumes.
//
// Correctness guarantees:
//   - GATED by the master switch AND the activation horizon (disabled by default;
//     only orders completed at/after the first-enable instant are ever eligible —
//     historical orders are never back-filled).
//   - IDEMPOTENT per order — the ReferralCommission's unique orderId is claimed
//     inside the transaction, so a re-fired hook / concurrent settlement / a
//     recovered worker job can never credit twice.
//   - FIRST-PURCHASE-SAFE under concurrency — the credit locks the Referral row
//     (SELECT … FOR UPDATE) and RE-CHECKS firstPurchaseOnly inside that lock, so
//     two DIFFERENT qualifying orders for one referral produce exactly one payout.
//   - ATOMIC — the wallet increment (row-locked, returning the true post-balance)
//     and the WalletTransaction ledger row are written in ONE transaction.
//   - REVERSIBLE WITHOUT OVERDRAFT — a refunded order claws the credit back only
//     as far as the referrer's balance allows (never negative unless the user is
//     explicitly allowNegativeBalance); any shortfall becomes an auditable
//     REVERSAL_PENDING debt recovered as funds arrive, never over-collected.
//
// Business outcomes are TYPED results, never thrown Error strings; only genuine
// infrastructure errors propagate. Callers wrap the live path fail-soft.
// =============================================================================

/** Commission statuses that consume a referral's "first purchase" slot. */
const FIRST_PURCHASE_CONSUMING = [
  ReferralCommissionStatus.PENDING,
  ReferralCommissionStatus.PAID,
  ReferralCommissionStatus.REVERSAL_PENDING,
  ReferralCommissionStatus.REVERSED,
] as const;

export type ReferralCreditResult =
  | { status: "credited"; commissionToman: number }
  | { status: "already-credited" }
  | {
      status:
        | "disabled"
        | "before-horizon"
        | "order-missing"
        | "not-completed"
        | "no-referrer"
        | "not-eligible"
        | "self-referral";
    };

/**
 * Credits the referrer of `order`'s buyer when the order is COMPLETED, enabled,
 * and completed at/after the activation horizon. Returns a structured outcome;
 * never throws for a business reason.
 */
export async function creditReferralCommissionForOrder(
  orderId: string,
  now: Date = new Date(),
): Promise<ReferralCreditResult> {
  if (!(await isReferralSystemEnabled())) {
    return { status: "disabled" };
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true, completedAt: true, finalPriceToman: true },
  });
  if (order === null) {
    return { status: "order-missing" };
  }
  if (order.status !== OrderStatus.COMPLETED || order.completedAt === null) {
    return { status: "not-completed" };
  }
  // Activation horizon: a null horizon (payouts never enabled) is fail-closed, and
  // an order completed before the horizon is never back-filled.
  const horizon = await getReferralCommissionsStartedAt();
  if (
    !isOrderWithinReferralHorizon({
      orderCompletedAtEpoch: order.completedAt.getTime(),
      horizonEpoch: horizon?.getTime() ?? null,
    })
  ) {
    return { status: "before-horizon" };
  }
  // The buyer must have been attributed to a referrer (Referral row on /start).
  const referral = await prisma.referral.findUnique({ where: { referredUserId: order.userId } });
  if (referral === null) {
    return { status: "no-referrer" };
  }
  if (referral.referrerUserId === order.userId) {
    return { status: "self-referral" };
  }

  const config = await getReferralConfig();
  const decision = resolveReferralCommission({ orderAmountToman: order.finalPriceToman, config });
  if (!decision.eligible) {
    return { status: "not-eligible" };
  }

  try {
    const outcome = await prisma.$transaction(async (tx): Promise<ReferralCreditResult> => {
      // SERIALIZE concurrent credits for THIS referral: lock the Referral row so a
      // second qualifying order cannot observe zero prior commissions at the same
      // time. This is the real first-purchase-only concurrency authority.
      await tx.$queryRaw`SELECT id FROM "Referral" WHERE id = ${referral.id} FOR UPDATE`;

      if (config.firstPurchaseOnly) {
        // Re-check UNDER THE LOCK: any commission for a DIFFERENT order of this
        // referral (in any live/terminal state) means this is not the first.
        const prior = await tx.referralCommission.count({
          where: {
            referralId: referral.id,
            orderId: { not: order.id },
            status: { in: [...FIRST_PURCHASE_CONSUMING] },
          },
        });
        if (prior > 0) {
          return { status: "not-eligible" };
        }
      }

      // Claim idempotency: the unique orderId makes a concurrent/duplicate credit
      // fail here (P2002) BEFORE any money moves.
      const commission = await tx.referralCommission.create({
        data: {
          referralId: referral.id,
          referrerUserId: referral.referrerUserId,
          referredUserId: order.userId,
          orderId: order.id,
          amountToman: decision.commissionToman,
          percent: decision.percent,
          status: ReferralCommissionStatus.PAID,
          paidAt: now,
        },
        select: { id: true },
      });
      // Credit the referrer's wallet — the increment locks the row and returns the
      // true post-balance (never pre-read a balance: it races a concurrent spend).
      const credited = await tx.user.update({
        where: { id: referral.referrerUserId },
        data: {
          balanceToman: { increment: decision.commissionToman },
          // NET retained commission (decremented on clawback).
          totalReferralCommissionToman: { increment: decision.commissionToman },
          // GROSS referred-purchase activity (never decremented — a historical sale).
          totalReferralPurchaseCount: { increment: 1 },
          totalReferralPurchaseAmountToman: { increment: order.finalPriceToman },
        },
        select: { balanceToman: true },
      });
      const balanceAfter = credited.balanceToman;
      const balanceBefore = balanceAfter - decision.commissionToman;
      const wtx = await tx.walletTransaction.create({
        data: {
          userId: referral.referrerUserId,
          amountToman: decision.commissionToman,
          type: WalletTransactionType.COMMISSION,
          source: WalletTransactionSource.REFERRAL,
          reason: `پاداش زیرمجموعه‌گیری (سفارش ${order.id.slice(0, 8)})`,
          relatedOrderId: order.id,
          balanceBeforeToman: balanceBefore,
          balanceAfterToman: balanceAfter,
        },
        select: { id: true },
      });
      await tx.referralCommission.update({ where: { id: commission.id }, data: { walletTransactionId: wtx.id } });
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          totalPurchaseAmountToman: { increment: order.finalPriceToman },
          totalCommissionAmountToman: { increment: decision.commissionToman },
          firstPurchaseAt: referral.firstPurchaseAt ?? now,
          firstPurchaseOrderId: referral.firstPurchaseOrderId ?? order.id,
        },
      });
      return { status: "credited", commissionToman: decision.commissionToman };
    });
    if (outcome.status === "credited") {
      // PII-safe: an order fingerprint + amount only — never a user/referrer id.
      logger.info("referral commission credited", {
        order: orderId.slice(0, 8),
        amountToman: decision.commissionToman,
      });
    }
    return outcome;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A commission for this order already exists — the credit already happened.
      return { status: "already-credited" };
    }
    throw err;
  }
}

// --- reversal + no-overdraft recovery ----------------------------------------

export type ReferralReverseResult =
  | { status: "reversed"; commissionToman: number }
  | { status: "reversal-pending"; recoveredToman: number; outstandingToman: number }
  | { status: "already-reversed" | "not-paid" | "no-commission" | "no-op" };

export type ReferralRecoverResult =
  | { status: "reversed"; recoveredToman: number }
  | { status: "reversal-pending"; recoveredToman: number; outstandingToman: number }
  | { status: "no-commission" | "not-pending" | "no-op" };

/**
 * One row-locked clawback STEP. Recovers as much of the commission's outstanding
 * debt as the referrer's balance allows WITHOUT going negative (unless the user is
 * explicitly allowNegativeBalance). Writes a truthful WalletTransaction for the
 * actual debit, updates the recovery accounting, and transitions the commission to
 * REVERSED (fully recovered) or REVERSAL_PENDING (debt remains). Concurrency-safe:
 * the FOR UPDATE lock serialises every reversal/recovery on the same commission, so
 * the debt is never over-collected. Returns the effective outcome.
 */
async function runClawbackStep(
  commissionId: string,
  now: Date,
): Promise<{ status: "reversed" | "reversal-pending" | "no-op"; recoveredToman: number; outstandingToman: number }> {
  return prisma.$transaction(async (tx) => {
    // Lock the commission row so concurrent reversals/recoveries serialise.
    await tx.$queryRaw`SELECT id FROM "ReferralCommission" WHERE id = ${commissionId} FOR UPDATE`;
    const commission = await tx.referralCommission.findUnique({ where: { id: commissionId } });
    if (commission === null) {
      return { status: "no-op" as const, recoveredToman: 0, outstandingToman: 0 };
    }
    // Only a PAID (first reversal) or REVERSAL_PENDING (retry) row is actionable.
    let outstanding: number;
    if (commission.status === ReferralCommissionStatus.PAID) {
      outstanding = commission.amountToman;
    } else if (commission.status === ReferralCommissionStatus.REVERSAL_PENDING) {
      outstanding = commission.recoveryOutstandingToman;
    } else {
      return { status: "no-op" as const, recoveredToman: 0, outstandingToman: 0 };
    }

    // Row-locked live balance to decide how much can be recovered without overdraft.
    const [locked] = await tx.$queryRaw<Array<{ balanceToman: number; allowNegativeBalance: boolean }>>`
      SELECT "balanceToman", "allowNegativeBalance" FROM "User" WHERE id = ${commission.referrerUserId} FOR UPDATE`;
    const plan = planReferralClawback({
      outstandingToman: outstanding,
      currentBalanceToman: locked?.balanceToman ?? 0,
      allowNegativeBalance: locked?.allowNegativeBalance ?? false,
    });

    if (plan.recoverNow > 0) {
      const debited = await tx.user.update({
        where: { id: commission.referrerUserId },
        data: {
          balanceToman: { decrement: plan.recoverNow },
          // NET retained commission shrinks by what was actually clawed back.
          totalReferralCommissionToman: { decrement: plan.recoverNow },
        },
        select: { balanceToman: true },
      });
      const balanceAfter = debited.balanceToman;
      const balanceBefore = balanceAfter + plan.recoverNow;
      const wtx = await tx.walletTransaction.create({
        data: {
          userId: commission.referrerUserId,
          amountToman: plan.recoverNow,
          // type SYSTEM_ADJUSTMENT + source REFERRAL is ALWAYS a referral-commission
          // clawback DEBIT (documented in wallet-ledger-integrity.md).
          type: WalletTransactionType.SYSTEM_ADJUSTMENT,
          source: WalletTransactionSource.REFERRAL,
          reason: `بازگردانی پاداش زیرمجموعه‌گیری (سفارش ${commission.orderId.slice(0, 8)})`,
          relatedOrderId: commission.orderId,
          balanceBeforeToman: balanceBefore,
          balanceAfterToman: balanceAfter,
        },
        select: { id: true },
      });
      await tx.referral.update({
        where: { id: commission.referralId },
        data: { totalCommissionAmountToman: { decrement: plan.recoverNow } },
      });
      await tx.referralCommission.update({
        where: { id: commission.id },
        data: {
          recoveredToman: { increment: plan.recoverNow },
          recoveryOutstandingToman: plan.remainingOutstanding,
          status: plan.fullyRecovered
            ? ReferralCommissionStatus.REVERSED
            : ReferralCommissionStatus.REVERSAL_PENDING,
          reversedAt: plan.fullyRecovered ? now : commission.reversedAt,
          reversalRequestedAt: commission.reversalRequestedAt ?? now,
          reversalWalletTransactionId: commission.reversalWalletTransactionId ?? wtx.id,
        },
      });
    } else {
      // Nothing recoverable right now (insufficient balance): record/refresh the
      // debt WITHOUT a wallet debit (every debit must be a real ledger row).
      await tx.referralCommission.update({
        where: { id: commission.id },
        data: {
          recoveryOutstandingToman: outstanding,
          status: ReferralCommissionStatus.REVERSAL_PENDING,
          reversalRequestedAt: commission.reversalRequestedAt ?? now,
        },
      });
    }

    return {
      status: plan.fullyRecovered ? ("reversed" as const) : ("reversal-pending" as const),
      recoveredToman: plan.recoverNow,
      outstandingToman: plan.remainingOutstanding,
    };
  });
}

/**
 * Reverses (claws back) the commission for a refunded/cancelled order. The CALLER
 * is the authority on refund evidence — the worker reversal SCAN and
 * `failOrderWithRefund` only reverse orders with authoritative refund records (a
 * REFUND WalletTransaction or a terminal Order status), never an uncertain
 * remote/panel state. Idempotent + concurrency-safe via the row lock: repeated or
 * concurrent reversals recover the debt exactly once. Honours the no-overdraft
 * invariant — a shortfall becomes a REVERSAL_PENDING debt, never a negative wallet.
 */
export async function reverseReferralCommissionForOrder(
  orderId: string,
  now: Date = new Date(),
): Promise<ReferralReverseResult> {
  const commission = await prisma.referralCommission.findUnique({
    where: { orderId },
    select: { id: true, status: true },
  });
  if (commission === null) {
    return { status: "no-commission" };
  }
  if (commission.status === ReferralCommissionStatus.REVERSED) {
    return { status: "already-reversed" };
  }
  if (
    commission.status !== ReferralCommissionStatus.PAID &&
    commission.status !== ReferralCommissionStatus.REVERSAL_PENDING
  ) {
    return { status: "not-paid" };
  }
  const step = await runClawbackStep(commission.id, now);
  if (step.status === "no-op") {
    // Raced with a concurrent reversal that already finished it.
    const fresh = await prisma.referralCommission.findUnique({
      where: { id: commission.id },
      select: { status: true },
    });
    return fresh?.status === ReferralCommissionStatus.REVERSED
      ? { status: "already-reversed" }
      : { status: "no-op" };
  }
  if (step.status === "reversed") {
    logger.info("referral commission reversed", { orderId: orderId.slice(0, 8), recoveredToman: step.recoveredToman });
    return { status: "reversed", commissionToman: step.recoveredToman };
  }
  logger.warn("referral commission reversal pending (insufficient balance)", {
    orderId: orderId.slice(0, 8),
    recoveredToman: step.recoveredToman,
    outstandingToman: step.outstandingToman,
  });
  return { status: "reversal-pending", recoveredToman: step.recoveredToman, outstandingToman: step.outstandingToman };
}

/**
 * Retries recovery of one REVERSAL_PENDING debt (called by the worker recovery
 * scan when the referrer's wallet may now hold funds). Idempotent + no-overdraft;
 * collects whatever is affordable now and flips to REVERSED once fully recovered.
 */
export async function recoverReferralCommissionDebt(
  commissionId: string,
  now: Date = new Date(),
): Promise<ReferralRecoverResult> {
  const commission = await prisma.referralCommission.findUnique({
    where: { id: commissionId },
    select: { status: true },
  });
  if (commission === null) {
    return { status: "no-commission" };
  }
  if (commission.status !== ReferralCommissionStatus.REVERSAL_PENDING) {
    return { status: "not-pending" };
  }
  const step = await runClawbackStep(commissionId, now);
  if (step.status === "no-op") {
    return { status: "no-op" };
  }
  if (step.status === "reversed") {
    logger.info("referral commission debt fully recovered", { recoveredToman: step.recoveredToman });
    return { status: "reversed", recoveredToman: step.recoveredToman };
  }
  return { status: "reversal-pending", recoveredToman: step.recoveredToman, outstandingToman: step.outstandingToman };
}
