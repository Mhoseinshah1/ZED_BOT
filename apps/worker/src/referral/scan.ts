import { OrderStatus, ReferralCommissionStatus, WalletTransactionType, prisma } from "@zedbot/database";
import {
  REFERRAL_COMMISSION_RETENTION_DAYS,
  REFERRAL_JOB_NAMES,
  REFERRAL_SCAN_BATCH,
  REFERRAL_WORKER_STATUS_KEY,
  createLogger,
  errorMessage,
  referralCreditJobId,
  referralRecoverJobId,
  referralReverseJobId,
  type ReferralWorkerStatus,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import type { RawRedis } from "../redis.js";
import {
  getReferralPayoutWindows,
  isReferralSystemEnabled,
} from "./settings.js";

// =============================================================================
// Referral reconciliation SCANS (worker side). The DURABLE authority that makes a
// commission impossible to permanently lose and a refund impossible to permanently
// leave un-reversed. Each scan DISCOVERS work from authoritative DB state and
// PRODUCES idempotent execute jobs the bot consumes (the bot owns the wallet
// mutation). Bounded per run; safe on any cadence. NEVER logs a user/order id or a
// balance.
//   credit   — orders completed inside an active payout window, referred, still
//              uncommissioned → CREDIT. No time floor (oldest-first pages), so a
//              multi-day outage never permanently drops an eligible order; the
//              engine writes a terminal marker for orders that yield no payout, so
//              the scan converges instead of re-selecting them forever.
//   reversal — PAID commissions whose source order is definitively refunded →
//              REVERSE. Commission-driven (no time floor) and runs REGARDLESS of the
//              enabled switch, so a refund whose live enqueue was lost while payouts
//              were paused is still reversed.
//   recovery — REVERSAL_PENDING debts (retry the no-overdraft clawback) → RECOVER.
//   cleanup  — prune terminal rows past retention (the wallet ledger persists).
// =============================================================================

const log = createLogger("worker:referral-scan");

export interface ReferralScanState {
  lastScanAt: string | null;
  creditScanEnqueued: number;
  reversalScanEnqueued: number;
  recoveryScanEnqueued: number;
  executeFailures: number;
}

export function createReferralScanState(): ReferralScanState {
  return {
    lastScanAt: null,
    creditScanEnqueued: 0,
    reversalScanEnqueued: 0,
    recoveryScanEnqueued: 0,
    executeFailures: 0,
  };
}

const jobOpts = { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } as const;

/**
 * Credit scan: orders completed INSIDE an active payout window (so a paused-period
 * order is never back-filled), belonging to a referred user and still missing a
 * commission → enqueue an idempotent CREDIT job. Recovers every credit the live
 * hook lost to a crash / Redis flush. NO time floor — the window ranges bound the
 * candidate set and orders are processed OLDEST-FIRST in bounded pages, so a
 * multi-day outage never permanently excludes an eligible order (the durable
 * recovery guarantee). The engine writes a terminal marker for any candidate that
 * yields no payout, so this scan converges instead of re-selecting it forever.
 * No-op while disabled or before the first enable (fail-closed).
 */
export async function runReferralCreditScan(
  executeQueue: Queue,
  state: ReferralScanState,
): Promise<{ scanned: number; enqueued: number }> {
  if (!(await isReferralSystemEnabled())) {
    return { scanned: 0, enqueued: 0 };
  }
  const windows = await getReferralPayoutWindows();
  if (windows.length === 0) {
    return { scanned: 0, enqueued: 0 };
  }
  // One completedAt range per active window → an order is a candidate ONLY if it
  // completed while payouts were switched on (never during a pause). No lower time
  // floor beyond window[0].from, so an old-but-eligible order is never dropped.
  const windowRanges = windows.map((w) => ({
    completedAt: { gte: new Date(w.from), ...(w.to === null ? {} : { lte: new Date(w.to) }) },
  }));
  const orders = await prisma.order.findMany({
    where: {
      status: OrderStatus.COMPLETED,
      OR: windowRanges,
      user: { referralAsReferred: { isNot: null } },
      referralCommissions: { none: {} },
    },
    select: { id: true },
    orderBy: { completedAt: "asc" },
    take: REFERRAL_SCAN_BATCH,
  });
  let enqueued = 0;
  for (const o of orders) {
    try {
      await executeQueue.add(
        REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION,
        { orderId: o.id },
        { jobId: referralCreditJobId(o.id), attempts: 5, backoff: { type: "exponential", delay: 10_000 }, ...jobOpts },
      );
      enqueued += 1;
    } catch (err) {
      state.executeFailures += 1;
      log.warn("referral credit enqueue failed", { error: errorMessage(err) });
    }
  }
  state.creditScanEnqueued = enqueued;
  if (enqueued > 0) {
    log.info("referral credit scan enqueued", { scanned: orders.length, enqueued });
  }
  return { scanned: orders.length, enqueued };
}

/**
 * Reversal scan: PAID commissions whose source order carries AUTHORITATIVE refund
 * evidence — a REFUND WalletTransaction or a terminal Order status — → enqueue an
 * idempotent REVERSE job. COMMISSION-DRIVEN with NO time floor (the query joins each
 * PAID commission to its order's refund records), so a refund from before any
 * fixed look-back is still caught. Runs REGARDLESS of the enabled switch — a
 * commission already paid before payouts were paused must still be clawed back if
 * its order is later refunded, even while the payout switch is off. Never reverses
 * on an uncertain remote/panel state (only real refund records count).
 */
export async function runReferralReversalScan(
  executeQueue: Queue,
  state: ReferralScanState,
): Promise<{ scanned: number; enqueued: number }> {
  // Only PAID commissions are first-time reversal candidates (REVERSAL_PENDING is
  // handled by the recovery scan; REVERSED is done). Age-independent: the join to
  // the order's terminal status / REFUND wallet transactions carries no time floor.
  const commissions = await prisma.referralCommission.findMany({
    where: {
      status: ReferralCommissionStatus.PAID,
      order: {
        OR: [
          { status: { in: [OrderStatus.REFUNDED, OrderStatus.CANCELLED, OrderStatus.FAILED] } },
          { walletTransactions: { some: { type: WalletTransactionType.REFUND } } },
        ],
      },
    },
    select: { orderId: true },
    orderBy: { createdAt: "asc" },
    take: REFERRAL_SCAN_BATCH,
  });
  let enqueued = 0;
  for (const c of commissions) {
    try {
      await executeQueue.add(
        REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION,
        { orderId: c.orderId },
        { jobId: referralReverseJobId(c.orderId), attempts: 5, backoff: { type: "exponential", delay: 10_000 }, ...jobOpts },
      );
      enqueued += 1;
    } catch (err) {
      state.executeFailures += 1;
      log.warn("referral reverse enqueue failed", { error: errorMessage(err) });
    }
  }
  state.reversalScanEnqueued = enqueued;
  if (enqueued > 0) {
    log.info("referral reversal scan enqueued", { scanned: commissions.length, enqueued });
  }
  return { scanned: commissions.length, enqueued };
}

/**
 * Recovery scan: REVERSAL_PENDING debts (a refunded order's credit not yet fully
 * clawed back because the referrer's wallet lacked funds) → enqueue an idempotent
 * RECOVER job that collects whatever is now affordable. Runs regardless of the
 * enabled switch (an owed debt must be collectable even after payouts are paused).
 */
export async function runReferralDebtRecoveryScan(
  executeQueue: Queue,
  state: ReferralScanState,
): Promise<{ scanned: number; enqueued: number }> {
  const pending = await prisma.referralCommission.findMany({
    where: { status: ReferralCommissionStatus.REVERSAL_PENDING, recoveryOutstandingToman: { gt: 0 } },
    select: { id: true },
    take: REFERRAL_SCAN_BATCH,
  });
  let enqueued = 0;
  for (const c of pending) {
    try {
      await executeQueue.add(
        REFERRAL_JOB_NAMES.RECOVER_REFERRAL_COMMISSION,
        { commissionId: c.id },
        { jobId: referralRecoverJobId(c.id), attempts: 3, backoff: { type: "exponential", delay: 15_000 }, ...jobOpts },
      );
      enqueued += 1;
    } catch (err) {
      state.executeFailures += 1;
      log.warn("referral recover enqueue failed", { error: errorMessage(err) });
    }
  }
  state.recoveryScanEnqueued = enqueued;
  if (enqueued > 0) {
    log.info("referral debt recovery scan enqueued", { scanned: pending.length, enqueued });
  }
  return { scanned: pending.length, enqueued };
}

/**
 * Prunes fully-terminal commission rows (REVERSED / CANCELLED) past the retention
 * window. The immutable WalletTransaction ledger is the durable financial record
 * and is never touched here, so pruning a derived commission row loses no money
 * history. PENDING / PAID / REVERSAL_PENDING (money still owed or held) are never
 * pruned.
 */
export async function runReferralCleanup(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - REFERRAL_COMMISSION_RETENTION_DAYS * 24 * 3_600_000);
  const res = await prisma.referralCommission.deleteMany({
    where: {
      status: { in: [ReferralCommissionStatus.REVERSED, ReferralCommissionStatus.CANCELLED] },
      createdAt: { lt: cutoff },
    },
  });
  if (res.count > 0) {
    log.info("referral commission cleanup complete", { deleted: res.count });
  }
  return { deleted: res.count };
}

/**
 * Publishes the referral reconciliation heartbeat/status snapshot to Redis. Counts
 * + timestamps only — NEVER a user id, order id, referral code or balance. The key
 * carries the worker heartbeat TTL so its presence already means "alive recently".
 */
export async function publishReferralStatus(
  redis: RawRedis,
  state: ReferralScanState,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    const [enabled, paid, reversed, pending] = await Promise.all([
      isReferralSystemEnabled(),
      prisma.referralCommission.count({ where: { status: ReferralCommissionStatus.PAID } }),
      prisma.referralCommission.count({ where: { status: ReferralCommissionStatus.REVERSED } }),
      prisma.referralCommission.aggregate({
        where: { status: ReferralCommissionStatus.REVERSAL_PENDING },
        _count: true,
        _sum: { recoveryOutstandingToman: true },
      }),
    ]);
    const snapshot: ReferralWorkerStatus = {
      enabled,
      lastScanAt: state.lastScanAt,
      creditScanEnqueued: state.creditScanEnqueued,
      reversalScanEnqueued: state.reversalScanEnqueued,
      recoveryScanEnqueued: state.recoveryScanEnqueued,
      paidCount: paid,
      reversedCount: reversed,
      reversalPendingCount: pending._count,
      reversalPendingOutstandingToman: pending._sum.recoveryOutstandingToman ?? 0,
      executeFailures: state.executeFailures,
      checkedAt: now.toISOString(),
    };
    await redis.set(REFERRAL_WORKER_STATUS_KEY, JSON.stringify(snapshot), "EX", ttlSeconds);
  } catch (err) {
    log.debug("referral status publish failed", { error: errorMessage(err) });
  }
}
