import { prisma, type TelegramStarsServiceSubscription } from "@zedbot/database";
import {
  STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES,
  createLogger,
  errorMessage,
  starsSubscriptionExecuteJobId,
  type StarsSubscriptionConfig,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { createStarsNotification } from "./notify.js";

// =============================================================================
// Worker-owned reconciliation (Phase 2.1). Pure-DB PAST_DUE detection + selection
// of stuck charges (→ bot-consumed RECONCILE_CHARGE) + refund-retry selection (→
// bot-consumed RETRY_REFUND). None of these renews a Service, creates a Payment, or
// calls Telegram directly — the bot consumer performs the money-touching work with
// the existing settlement/refund services (one implementation, idempotent on the
// charge id). Every transition is a compare-and-set so a delayed charge or a
// concurrent scan cannot double-apply.
// =============================================================================

const logger = createLogger("worker:stars-reconcile");

/** Charges stuck longer than this in SETTLING/FULFILLING/RECONCILIATION_REQUIRED. */
const STUCK_CHARGE_MS = 15 * 60_000;
const BATCH = 200;

function isoDay(date: Date | null): string {
  return date === null ? "-" : date.toISOString().slice(0, 10);
}

/** The frozen plan name from the subscription's entitlement snapshot (safe, never
 * the remote service username). */
function frozenProductName(entitlementSnapshot: unknown): string {
  if (typeof entitlementSnapshot === "object" && entitlementSnapshot !== null && !Array.isArray(entitlementSnapshot)) {
    const name = (entitlementSnapshot as Record<string, unknown>).productName;
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return "-";
}

// --- PAST_DUE detection (Part K) ---------------------------------------------

export interface PastDueResult {
  pastDue: number;
}

/**
 * Marks subscriptions PAST_DUE when the paid period + grace has elapsed with no
 * newer charge evidence and no live `active` Update superseding the stale snapshot.
 * Creates NO Payment/Order, renews nothing, preserves the Service, and emits ONE
 * deduplicated notification per period.
 */
export async function runStarsPastDueDetection(
  config: StarsSubscriptionConfig,
  deliveryQueue: Queue | null,
  now: Date = new Date(),
): Promise<PastDueResult> {
  const graceMs = config.graceMinutes * 60_000;
  const cutoff = new Date(now.getTime() - graceMs);
  const candidates = await prisma.telegramStarsServiceSubscription.findMany({
    where: {
      status: { in: ["ACTIVE", "REACTIVATION_ALLOWED"] },
      currentPeriodEndsAt: { lt: cutoff },
    },
    take: BATCH,
  });

  let pastDue = 0;
  for (const sub of candidates) {
    if (sub.currentPeriodEndsAt === null) continue;
    // A fresh `active` subscription Update supersedes a stale period snapshot.
    if (
      sub.lastSubscriptionUpdateState === "active" &&
      sub.subscriptionUpdateAt !== null &&
      sub.subscriptionUpdateAt.getTime() > sub.currentPeriodEndsAt.getTime()
    ) {
      continue;
    }
    // Any newer charge (received/settling/fulfilling/completed) means a new cycle
    // is already in progress or done → not past due.
    const newerCharge = await prisma.telegramStarsSubscriptionCharge.count({
      where: {
        subscriptionId: sub.id,
        status: { in: ["RECEIVED", "SETTLING", "FULFILLING", "COMPLETED"] },
        subscriptionExpirationDate: { gt: sub.currentPeriodEndsAt },
      },
    });
    if (newerCharge > 0) continue;

    const claimed = await prisma.telegramStarsServiceSubscription.updateMany({
      where: {
        id: sub.id,
        status: { in: ["ACTIVE", "REACTIVATION_ALLOWED"] },
        currentPeriodEndsAt: sub.currentPeriodEndsAt,
      },
      data: { status: "PAST_DUE", pastDueMarkedAt: now, safeLastErrorCode: "past-due" },
    });
    if (claimed.count === 0) continue;
    pastDue += 1;
    try {
      await createStarsNotification(deliveryQueue, {
        subscriptionId: sub.id,
        userId: sub.userId,
        type: "STARS_SUBSCRIPTION_PAST_DUE",
        cycleKey: sub.currentPeriodEndsAt.toISOString(),
        serviceName: frozenProductName(sub.entitlementSnapshot),
        starsAmount: sub.starsAmount,
        currentPeriodEnd: isoDay(sub.currentPeriodEndsAt),
      });
    } catch (err) {
      logger.warn("past-due notification failed", { error: errorMessage(err) });
    }
  }
  if (pastDue > 0) logger.info("stars past-due detection", { pastDue });
  return { pastDue };
}

// --- fulfillment reconciliation selection (Part M) ---------------------------

export interface ReconcileSelectionResult {
  reconcileEnqueued: number;
}

/** Enqueues bot-consumed RECONCILE_CHARGE jobs for charges stuck past the threshold. */
export async function runStarsFulfillmentReconcile(
  executeQueue: Queue,
  now: Date = new Date(),
): Promise<ReconcileSelectionResult> {
  const threshold = new Date(now.getTime() - STUCK_CHARGE_MS);
  const stuck = await prisma.telegramStarsSubscriptionCharge.findMany({
    where: {
      status: { in: ["SETTLING", "FULFILLING", "RECONCILIATION_REQUIRED"] },
      updatedAt: { lt: threshold },
    },
    select: { id: true },
    take: BATCH,
  });
  for (const charge of stuck) {
    await executeQueue.add(
      STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.RECONCILE_CHARGE,
      { chargeId: charge.id },
      {
        jobId: starsSubscriptionExecuteJobId("reconcile", charge.id),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
  return { reconcileEnqueued: stuck.length };
}

// --- refund retry selection (Part L) -----------------------------------------

export interface RefundRetryResult {
  refundEnqueued: number;
  refundExhausted: number;
}

/**
 * Enqueues bot-consumed RETRY_REFUND jobs for REFUND_PENDING charges with retry
 * capacity remaining (respecting the retry interval). Charges that exhausted their
 * attempts surface their subscription as REQUIRES_ACTION for admin review; the
 * charge stays REFUND_PENDING (money still owed) — never silently dropped.
 */
export async function runStarsRefundRetry(
  executeQueue: Queue,
  config: StarsSubscriptionConfig,
  deliveryQueue: Queue | null,
  now: Date = new Date(),
): Promise<RefundRetryResult> {
  const retryCutoff = new Date(now.getTime() - config.refundRetryMinutes * 60_000);
  // Load all REFUND_PENDING charges (bounded); the retry INTERVAL is applied in the
  // loop so an exhausted charge is always surfaced regardless of when it last moved.
  const pending = await prisma.telegramStarsSubscriptionCharge.findMany({
    where: { status: "REFUND_PENDING" },
    include: {
      subscription: {
        select: { id: true, userId: true, starsAmount: true, currentPeriodEndsAt: true, entitlementSnapshot: true },
      },
    },
    take: BATCH,
  });

  let enqueued = 0;
  let exhausted = 0;
  for (const charge of pending) {
    if (charge.refundAttempts >= config.refundMaxAttempts) {
      // Exhausted — hand off to admin review via the subscription state.
      const flipped = await prisma.telegramStarsServiceSubscription.updateMany({
        where: { id: charge.subscription.id, status: { notIn: ["CANCELLED", "EXPIRED", "REQUIRES_ACTION"] } },
        data: { status: "REQUIRES_ACTION", safeLastErrorCode: "refund-exhausted" },
      });
      if (flipped.count > 0) {
        exhausted += 1;
        try {
          await createStarsNotification(deliveryQueue, {
            subscriptionId: charge.subscription.id,
            userId: charge.subscription.userId,
            type: "STARS_SUBSCRIPTION_REQUIRES_ACTION",
            cycleKey: `refund-exhausted:${charge.subscription.id}`,
            serviceName: frozenProductName(charge.subscription.entitlementSnapshot),
            starsAmount: charge.subscription.starsAmount,
            currentPeriodEnd: isoDay(charge.subscription.currentPeriodEndsAt),
          });
        } catch (err) {
          logger.warn("refund-exhausted notification failed", { error: errorMessage(err) });
        }
      }
      continue;
    }
    // Respect the retry interval: a charge that already attempted a refund waits
    // until the configured interval since its last move elapses (attempt 0 is due).
    if (charge.refundAttempts > 0 && charge.updatedAt >= retryCutoff) {
      continue;
    }
    await executeQueue.add(
      STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.RETRY_REFUND,
      { chargeId: charge.id },
      {
        jobId: starsSubscriptionExecuteJobId("refund", charge.id),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    enqueued += 1;
  }
  return { refundEnqueued: enqueued, refundExhausted: exhausted };
}

// --- cleanup (Part Y) --------------------------------------------------------

export interface CleanupResult {
  deleted: number;
}

/**
 * Deletes ONLY terminal, non-financial charge rows (FAILED/IGNORED) older than the
 * retention window — these carry no Payment/Checkout/Order and are never the first
 * or current-period charge. Never touches active subscriptions, REFUND_PENDING /
 * RECONCILIATION_REQUIRED / COMPLETED / REFUNDED charges, the cursor, or any
 * Payment/Order/audit history required for a dispute.
 */
export async function runStarsChargeCleanup(
  config: StarsSubscriptionConfig,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const cutoff = new Date(now.getTime() - config.chargeRetentionDays * 86_400_000);
  const result = await prisma.telegramStarsSubscriptionCharge.deleteMany({
    where: {
      status: { in: ["FAILED", "IGNORED"] },
      createdAt: { lt: cutoff },
      paymentId: null,
      orderId: null,
    },
  });
  if (result.count > 0) logger.info("stars charge cleanup", { deleted: result.count });
  return { deleted: result.count };
}

export type { TelegramStarsServiceSubscription };
