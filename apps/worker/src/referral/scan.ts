import { OrderStatus, ReferralCommissionStatus, WalletTransactionType, prisma } from "@zedbot/database";
import {
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
//   reversal — orders with authoritative refund evidence (a REFUND wallet tx or a
//              terminal order status) that still hold a PAID commission → REVERSE.
//              REFUND-DRIVEN (scales with refunds, not the whole PAID population),
//              age-independent, naturally convergent (a reversed commission stops
//              matching), and runs REGARDLESS of the enabled switch.
//   recovery — REVERSAL_PENDING debts (retry the no-overdraft clawback) → RECOVER.
//   cleanup  — prune ONLY transient BullMQ job artifacts. ReferralCommission rows
//              (incl. terminal REVERSED/CANCELLED markers) are PERMANENT financial +
//              idempotency records and are NEVER hard-deleted.
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
 * Reversal scan: enqueue an idempotent REVERSE job for every order that carries
 * AUTHORITATIVE refund evidence AND still holds a PAID commission.
 *
 * REFUND-DRIVEN (inverted), so it SCALES WITH REFUNDS, not with the whole PAID
 * population. Instead of scanning every PAID commission every cycle (which grows
 * without bound — almost all referrals stay PAID forever), we start from the two
 * highly selective evidence sets — REFUND wallet transactions and terminal
 * (REFUNDED/CANCELLED/FAILED) orders — and require each candidate order to still
 * have a PAID commission. Cost is O(refunds), not O(all commissions).
 *
 * NATURALLY CONVERGENT: the moment a commission leaves PAID (→ REVERSAL_PENDING
 * after the first clawback, → REVERSED when fully recovered), the order stops
 * matching `referralCommissions: { some: { status: PAID } }` and drops out of this
 * scan — so no durable cursor is needed and a stuck row can never wedge the batch.
 * REVERSAL_PENDING debts are retried by the recovery scan, not here.
 *
 * NO time floor (a refund from before any fixed look-back is still caught) and runs
 * REGARDLESS of the enabled switch — a commission paid before payouts were paused
 * must still be clawed back if its order is later refunded. Bounded + stably
 * paginated (deterministic orderId order); never reverses on an uncertain
 * remote/panel state (only real REFUND / terminal-order records count).
 */
export async function runReferralReversalScan(
  executeQueue: Queue,
  state: ReferralScanState,
): Promise<{ scanned: number; enqueued: number }> {
  const paidCommissionExists = {
    referralCommissions: { some: { status: ReferralCommissionStatus.PAID } },
  } as const;
  const [refundTx, terminalOrders] = await Promise.all([
    // REFUND ledger rows whose order still has a PAID commission. Selective on the
    // (type, relatedOrderId) index; deterministic order → stable pagination.
    prisma.walletTransaction.findMany({
      where: {
        type: WalletTransactionType.REFUND,
        relatedOrderId: { not: null },
        relatedOrder: paidCommissionExists,
      },
      select: { relatedOrderId: true },
      distinct: ["relatedOrderId"],
      orderBy: { relatedOrderId: "asc" },
      take: REFERRAL_SCAN_BATCH,
    }),
    // Terminally-failed orders that still have a PAID commission. Selective on the
    // Order.status index; deterministic order → stable pagination.
    prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.REFUNDED, OrderStatus.CANCELLED, OrderStatus.FAILED] },
        ...paidCommissionExists,
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: REFERRAL_SCAN_BATCH,
    }),
  ]);
  const orderIds = [
    ...new Set([
      ...refundTx.map((t) => t.relatedOrderId).filter((id): id is string => id !== null),
      ...terminalOrders.map((o) => o.id),
    ]),
  ];
  let enqueued = 0;
  for (const orderId of orderIds) {
    try {
      await executeQueue.add(
        REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION,
        { orderId },
        { jobId: referralReverseJobId(orderId), attempts: 5, backoff: { type: "exponential", delay: 10_000 }, ...jobOpts },
      );
      enqueued += 1;
    } catch (err) {
      state.executeFailures += 1;
      log.warn("referral reverse enqueue failed", { error: errorMessage(err) });
    }
  }
  state.reversalScanEnqueued = enqueued;
  if (enqueued > 0) {
    log.info("referral reversal scan enqueued", { scanned: orderIds.length, enqueued });
  }
  return { scanned: orderIds.length, enqueued };
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
 * Retention cleanup — TRANSIENT control data ONLY. A ReferralCommission row (in ANY
 * status, INCLUDING the terminal REVERSED / CANCELLED zero-amount markers) is a
 * PERMANENT financial + idempotency record and is NEVER hard-deleted here:
 *   - the credit scan excludes an order that has ANY commission row
 *     (`referralCommissions: { none: {} }`), so deleting a REVERSED/CANCELLED row
 *     would make the order eligible AGAIN and re-credit an already-refunded or
 *     already-declined order — the exact regression this cleanup used to cause;
 *   - the WalletTransaction ledger and the ReferralCommission rows together keep
 *     the full payout history reconstructable.
 * So this pass only trims BullMQ's own completed/failed job artifacts on the two
 * referral queues (non-financial, self-expiring anyway) to keep Redis tidy.
 */
export async function runReferralCleanup(
  queues: { control: Queue; execute: Queue },
): Promise<{ cleaned: number }> {
  const COMPLETED_GRACE_MS = 24 * 3_600_000;
  const FAILED_GRACE_MS = 7 * 24 * 3_600_000;
  let cleaned = 0;
  for (const q of [queues.control, queues.execute]) {
    try {
      const done = await q.clean(COMPLETED_GRACE_MS, 1000, "completed");
      const failed = await q.clean(FAILED_GRACE_MS, 1000, "failed");
      cleaned += done.length + failed.length;
    } catch (err) {
      log.debug("referral transient-job cleanup skipped", { error: errorMessage(err) });
    }
  }
  if (cleaned > 0) {
    log.info("referral transient job cleanup complete", { cleaned });
  }
  return { cleaned };
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
