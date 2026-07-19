import {
  OrderStatus,
  Prisma,
  ReferralCommissionStatus,
  WalletTransactionSource,
  WalletTransactionType,
  prisma,
} from "@zedbot/database";
import { resolveReferralCommission } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { getReferralConfig, isReferralSystemEnabled } from "./referral.service.js";

// =============================================================================
// Referral affiliate commissions — the money engine (Phase 1). When a REFERRED
// user's Order completes, the REFERRER earns a commission (a configured percent of
// the order, floored) credited to their internal wallet. It is:
//   - GATED by the master switch (disabled by default) — attribution linking is
//     unaffected; only the payout is gated.
//   - IDEMPOTENT per order — the ReferralCommission row's unique orderId is claimed
//     FIRST inside the transaction, so a re-fired hook / concurrent settlement can
//     never credit twice.
//   - ATOMIC — the wallet increment (which locks the user row and returns the true
//     post-balance) and the WalletTransaction ledger row are written in ONE
//     transaction, so balanceBefore/After always describe a real transition.
//   - REVERSIBLE — a refunded/cancelled order claws the commission back (a
//     compensating SYSTEM_ADJUSTMENT debit + status REVERSED), idempotently.
// It never throws into the fulfillment path (a commission failure must never break a
// paid order); callers wrap it fail-soft.
// =============================================================================

export type ReferralCreditResult =
  | { status: "credited"; commissionToman: number }
  | { status: "already-credited" }
  | { status: "disabled" | "order-missing" | "not-completed" | "no-referrer" | "not-eligible" | "self-referral" };

/**
 * Credits the referrer of `order`'s buyer when the order is COMPLETED and the
 * system is enabled. Returns a structured outcome; never throws for a business
 * reason. `firstPurchaseOnly` (config) restricts the payout to the referred user's
 * first COMMISSIONED order (a prior below-minimum order never consumes the slot).
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
  // The buyer must have been attributed to a referrer (Referral row on /start).
  const referral = await prisma.referral.findUnique({ where: { referredUserId: order.userId } });
  if (referral === null) {
    return { status: "no-referrer" };
  }
  if (referral.referrerUserId === order.userId) {
    return { status: "self-referral" };
  }

  const config = await getReferralConfig();
  // First-purchase-only: skip if this referral already earned a commission.
  if (config.firstPurchaseOnly) {
    const prior = await prisma.referralCommission.count({
      where: { referralId: referral.id, status: { in: [ReferralCommissionStatus.PENDING, ReferralCommissionStatus.PAID] } },
    });
    if (prior > 0) {
      return { status: "not-eligible" };
    }
  }

  const decision = resolveReferralCommission({ orderAmountToman: order.finalPriceToman, config });
  if (!decision.eligible) {
    return { status: "not-eligible" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Claim idempotency FIRST: the unique orderId makes a concurrent/duplicate
      // credit fail here (P2002) BEFORE any money moves.
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
          totalReferralCommissionToman: { increment: decision.commissionToman },
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
    });
    logger.info("referral commission credited", {
      orderId: orderId.slice(0, 8),
      referrerUserId: referral.referrerUserId,
      amountToman: decision.commissionToman,
    });
    return { status: "credited", commissionToman: decision.commissionToman };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A commission for this order already exists — the credit already happened.
      return { status: "already-credited" };
    }
    throw err;
  }
}

export type ReferralReverseResult =
  | { status: "reversed"; commissionToman: number }
  | { status: "skipped" | "already-reversed" | "not-paid" | "no-commission" };

/**
 * Reverses (claws back) the commission for a refunded/cancelled order: a
 * compensating SYSTEM_ADJUSTMENT debit on the referrer's wallet + status REVERSED.
 * Idempotent (CAS on status=PAID) so a repeated refund signal reverses exactly once.
 * Only a PAID commission is reversed; PENDING/CANCELLED/REVERSED are left as-is. A
 * clawback may push the referrer's balance negative (they owe the credit back) —
 * this is intended ledger behaviour.
 */
export async function reverseReferralCommissionForOrder(
  orderId: string,
  now: Date = new Date(),
): Promise<ReferralReverseResult> {
  const commission = await prisma.referralCommission.findUnique({ where: { orderId } });
  if (commission === null) {
    return { status: "no-commission" };
  }
  if (commission.status === ReferralCommissionStatus.REVERSED) {
    return { status: "already-reversed" };
  }
  if (commission.status !== ReferralCommissionStatus.PAID) {
    return { status: "not-paid" };
  }
  try {
    const reversed = await prisma.$transaction(async (tx) => {
      // CAS: only the caller that flips PAID → REVERSED performs the clawback.
      const claimed = await tx.referralCommission.updateMany({
        where: { id: commission.id, status: ReferralCommissionStatus.PAID },
        data: { status: ReferralCommissionStatus.REVERSED, reversedAt: now },
      });
      if (claimed.count === 0) {
        return false;
      }
      const debited = await tx.user.update({
        where: { id: commission.referrerUserId },
        data: {
          balanceToman: { decrement: commission.amountToman },
          totalReferralCommissionToman: { decrement: commission.amountToman },
        },
        select: { balanceToman: true },
      });
      const balanceAfter = debited.balanceToman;
      const balanceBefore = balanceAfter + commission.amountToman;
      const wtx = await tx.walletTransaction.create({
        data: {
          userId: commission.referrerUserId,
          amountToman: commission.amountToman,
          type: WalletTransactionType.SYSTEM_ADJUSTMENT,
          source: WalletTransactionSource.REFERRAL,
          reason: `بازگردانی پاداش زیرمجموعه‌گیری (سفارش ${orderId.slice(0, 8)})`,
          relatedOrderId: orderId,
          balanceBeforeToman: balanceBefore,
          balanceAfterToman: balanceAfter,
        },
        select: { id: true },
      });
      await tx.referralCommission.update({
        where: { id: commission.id },
        data: { reversalWalletTransactionId: wtx.id },
      });
      await tx.referral.update({
        where: { id: commission.referralId },
        data: { totalCommissionAmountToman: { decrement: commission.amountToman } },
      });
      return true;
    });
    if (!reversed) {
      return { status: "already-reversed" };
    }
    logger.info("referral commission reversed", { orderId: orderId.slice(0, 8), amountToman: commission.amountToman });
    return { status: "reversed", commissionToman: commission.amountToman };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: "already-reversed" };
    }
    throw err;
  }
}
