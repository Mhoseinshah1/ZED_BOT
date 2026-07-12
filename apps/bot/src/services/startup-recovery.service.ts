import { OrderStatus, OrderType, prisma } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { EXTRA_TIME_EVENT_TYPE } from "./extra-time.service.js";
import { EXTRA_VOLUME_EVENT_TYPE } from "./extra-volume.service.js";
import {
  failOrderWithRefund,
  generatePanelUsername,
  type OrderForProvisioning,
} from "./provisioning.service.js";
import { RENEWAL_EVENT_TYPE } from "./service-renewal.service.js";

// =============================================================================
// Startup crash recovery for in-request pipelines.
//
// Every post-payment pipeline (service purchase / renewal / extra volume /
// extra time) claims its order with a compare-and-set PAID -> PROVISIONING
// and finishes as COMPLETED (with a Service row or ServiceEventLog anchor
// committed in the same transaction) or FAILED + wallet refund. That state
// machine is airtight while the process lives - but a crash/restart between
// the claim and the finish leaves the order stuck in PROVISIONING forever:
// every entry point refuses PROVISIONING orders, so the user stays charged
// with no service and no refund. The same applies to a Broadcast stuck in
// RUNNING when the send loop dies with the process.
//
// This module resolves those orphans by applying each pipeline's OWN
// documented completion/failure semantics - it introduces no new business
// outcome:
//   - completion anchor exists (Service row for a purchase, event-log row
//     for renewal/extras) -> the order finishes COMPLETED, exactly as the
//     pipeline's persistence transaction would have;
//   - no anchor -> the shared failOrderWithRefund path (order FAILED +
//     idempotent wallet refund), exactly as an in-process failure would.
//
// Safety:
//   - Only rows STALE for longer than STALE_PIPELINE_MINUTES are touched; a
//     live pipeline holds an order for seconds, so the sweep can never
//     collide with in-flight work even though it also re-runs while the bot
//     is serving updates.
//   - Every transition is a compare-and-set on the expected status and the
//     refund path is the existing idempotent one, so concurrent or repeated
//     recovery runs settle each order exactly once.
//   - Recovery never sends Telegram messages; refunds surface in the user's
//     wallet history (documented in docs/background-jobs-audit.md).
// =============================================================================

export const STALE_PIPELINE_MINUTES = 10;
/** Startup re-check delay: crash-fresh rows age past the threshold by then. */
export const RECOVERY_RECHECK_DELAY_MS = 15 * 60_000;

const RECOVERABLE_ORDER_TYPES: OrderType[] = [
  OrderType.SERVICE_PURCHASE,
  OrderType.SERVICE_RENEWAL,
  OrderType.EXTRA_VOLUME,
  OrderType.EXTRA_TIME,
];

const EVENT_TYPE_BY_ORDER_TYPE: Partial<Record<OrderType, string>> = {
  [OrderType.SERVICE_RENEWAL]: RENEWAL_EVENT_TYPE,
  [OrderType.EXTRA_VOLUME]: EXTRA_VOLUME_EVENT_TYPE,
  [OrderType.EXTRA_TIME]: EXTRA_TIME_EVENT_TYPE,
};

export interface StartupRecoveryReport {
  checkedOrders: number;
  completedOrders: number;
  refundedOrders: number;
  unresolvedOrders: number;
  failedBroadcasts: number;
}

/** CAS finish: only flips the order we still see as PROVISIONING. */
async function completeRecoveredOrder(orderId: string): Promise<boolean> {
  const flipped = await prisma.order.updateMany({
    where: { id: orderId, status: OrderStatus.PROVISIONING },
    data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
  });
  return flipped.count === 1;
}

/**
 * A SERVICE_PURCHASE crashed after the panel account was created iff a
 * Service row exists for the order - or, for a crash before the service was
 * linked, under the order's deterministic panel username (mirrors the
 * in-process recovery ladder; a foreign user's service is never touched).
 */
async function findPurchaseAnchor(order: OrderForProvisioning): Promise<boolean> {
  const byOrder = await prisma.service.findFirst({ where: { orderId: order.id } });
  if (byOrder !== null) {
    return true;
  }
  const username = generatePanelUsername(order.user.telegramId, order.id);
  const byUsername = await prisma.service.findUnique({ where: { username } });
  if (
    byUsername !== null &&
    byUsername.userId === order.userId &&
    (byUsername.orderId === null || byUsername.orderId === order.id)
  ) {
    if (byUsername.orderId === null) {
      await prisma.service.update({
        where: { id: byUsername.id },
        data: { orderId: order.id },
      });
      logger.info("startup recovery: unlinked service repaired", {
        orderId: order.id,
        serviceId: byUsername.id,
      });
    }
    return true;
  }
  return false;
}

/** Renewal/extras committed their event log WITH the service update. */
async function findEventAnchor(orderId: string, eventType: string): Promise<boolean> {
  const event = await prisma.serviceEventLog.findFirst({
    where: { eventType, metadata: { path: ["orderId"], equals: orderId } },
  });
  return event !== null;
}

/**
 * Resolves every service-pipeline order stuck in PROVISIONING since before
 * `olderThan`. Returns per-outcome counts; a failure on one order never
 * blocks the others.
 */
export async function recoverStaleProvisioningOrders(
  olderThan: Date,
): Promise<Omit<StartupRecoveryReport, "failedBroadcasts">> {
  const stale = (await prisma.order.findMany({
    where: {
      status: OrderStatus.PROVISIONING,
      type: { in: RECOVERABLE_ORDER_TYPES },
      updatedAt: { lt: olderThan },
    },
    include: { user: true, product: { include: { panel: true } } },
    orderBy: { updatedAt: "asc" },
  })) as OrderForProvisioning[];

  let completedOrders = 0;
  let refundedOrders = 0;
  let unresolvedOrders = 0;
  for (const order of stale) {
    try {
      const eventType = EVENT_TYPE_BY_ORDER_TYPE[order.type];
      const anchored =
        order.type === OrderType.SERVICE_PURCHASE
          ? await findPurchaseAnchor(order)
          : eventType !== undefined && (await findEventAnchor(order.id, eventType));

      if (anchored) {
        if (await completeRecoveredOrder(order.id)) {
          completedOrders += 1;
          logger.info("startup recovery: stale PROVISIONING order completed", {
            orderId: order.id,
            orderType: order.type,
          });
        }
        continue;
      }
      // failOrderWithRefund returns true when a refund is in place (created
      // now, pre-existing, or nothing to move for a 0-toman order).
      const refunded = await failOrderWithRefund(
        order,
        "stale PROVISIONING recovered after restart: pipeline result not found",
      );
      if (refunded) {
        refundedOrders += 1;
      } else {
        unresolvedOrders += 1;
      }
    } catch (err) {
      unresolvedOrders += 1;
      logger.error("startup recovery: order recovery failed", {
        orderId: order.id,
        error: errorMessage(err),
      });
    }
  }
  return { checkedOrders: stale.length, completedOrders, refundedOrders, unresolvedOrders };
}

/**
 * A RUNNING broadcast whose loop died with the process never progresses
 * again (the start guard refuses re-entry, by design). Its updatedAt is
 * bumped with every batch, so RUNNING + stale = dead loop: mark it FAILED.
 * Recipient rows keep the exact partial sent/failed counts, and no message
 * is ever re-sent.
 */
export async function failStaleRunningBroadcasts(olderThan: Date): Promise<number> {
  const failed = await prisma.broadcast.updateMany({
    where: { status: "RUNNING", updatedAt: { lt: olderThan } },
    data: { status: "FAILED" },
  });
  if (failed.count > 0) {
    logger.warn("startup recovery: stale RUNNING broadcasts marked FAILED", {
      count: failed.count,
    });
  }
  return failed.count;
}

/**
 * One full recovery sweep. Never throws - recovery is best-effort and must
 * not take the bot down; problems are logged and retried on the next run.
 */
export async function runStartupRecovery(now: Date = new Date()): Promise<StartupRecoveryReport> {
  const olderThan = new Date(now.getTime() - STALE_PIPELINE_MINUTES * 60_000);
  try {
    const orders = await recoverStaleProvisioningOrders(olderThan);
    const failedBroadcasts = await failStaleRunningBroadcasts(olderThan);
    const report = { ...orders, failedBroadcasts };
    if (
      report.checkedOrders > 0 ||
      report.failedBroadcasts > 0
    ) {
      logger.info("startup recovery finished", { ...report });
    }
    return report;
  } catch (err) {
    logger.error("startup recovery failed", { error: errorMessage(err) });
    return {
      checkedOrders: 0,
      completedOrders: 0,
      refundedOrders: 0,
      unresolvedOrders: 0,
      failedBroadcasts: 0,
    };
  }
}
