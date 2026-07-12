import {
  OrderStatus,
  OrderType,
  prisma,
  ServiceStatus,
  type Panel,
  type Product,
  type Service,
} from "@zedbot/database";
import type { GetServiceAccountResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { EXTRA_TIME_EVENT_TYPE } from "./extra-time.service.js";
import { EXTRA_VOLUME_EVENT_TYPE } from "./extra-volume.service.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  failOrderWithRefund,
  generatePanelUsername,
  type OrderForProvisioning,
} from "./provisioning.service.js";
import { RENEWAL_EVENT_TYPE } from "./service-renewal.service.js";

// =============================================================================
// Startup crash recovery for in-request pipelines, with SAFE panel/database
// reconciliation.
//
// Every post-payment pipeline (service purchase / renewal / extra volume /
// extra time) claims its order with a compare-and-set PAID -> PROVISIONING
// and finishes as COMPLETED (with a Service row or ServiceEventLog anchor
// committed in the same transaction) or FAILED + wallet refund. A crash
// between the claim and the finish leaves the order stuck in PROVISIONING
// forever. The same applies to a Broadcast stuck in RUNNING when the send
// loop dies with the process.
//
// CRITICAL SAFETY RULE: a missing database anchor does NOT prove the remote
// panel mutation did not happen - the crash window explicitly includes
// "panel succeeded, database commit lost". Refunding on a missing anchor
// alone would hand out the panel mutation AND the money. Recovery therefore
// resolves an anchor-less order ONLY by asking the panel:
//
//   - PURCHASE: the order's deterministic panel username is fetched.
//       account exists    -> ADOPT it: recreate the Service row from the
//                            order's sold snapshots + the panel's own
//                            subscription data, finish COMPLETED. No refund.
//       positively absent -> the create never happened; FAILED + refund.
//       cannot check      -> DEFER (leave PROVISIONING, log; retried on
//                            every sweep, manual admin resolution possible).
//   - RENEWAL / EXTRAS: the target service's account is fetched and the
//     mutation-owned fields (data limit for volume, expiry for time, either
//     for renewal) are compared against the service row's stored
//     PRE-mutation state (the crash lost the DB update, so the row still
//     holds the old values):
//       panel differs      -> the mutation applied: persist the pipeline's
//                             own anchor (ServiceEventLog + service update
//                             from panel truth), finish COMPLETED. No refund.
//       panel identical    -> the mutation never applied; FAILED + refund.
//       account absent     -> the panel PUT would have 404-failed exactly
//                             like an in-process failure; FAILED + refund.
//       cannot check/tell  -> DEFER, never refund on uncertainty.
//
// Safety:
//   - Only rows STALE for longer than STALE_PIPELINE_MINUTES are touched; a
//     live pipeline holds an order for seconds, so the sweep can never
//     collide with in-flight work even though it also re-runs while the bot
//     is serving updates.
//   - Every transition is a compare-and-set on the expected status and the
//     refund path is the existing idempotent one, so concurrent or repeated
//     recovery runs settle each order exactly once. Reconciled completions
//     write the pipeline's own anchor, so re-runs short-circuit as anchored.
//   - "Could not check" (panel unreachable, auth failure, adapter without
//     read support - e.g. XUI) NEVER refunds and NEVER completes; the order
//     stays PROVISIONING and is retried on the next sweep.
//   - Recovery never sends Telegram messages; refunds surface in the user's
//     wallet history (docs/panel-database-reconciliation.md).
// =============================================================================

export const STALE_PIPELINE_MINUTES = 10;
/** Startup re-check delay: crash-fresh rows age past the threshold by then. */
export const RECOVERY_RECHECK_DELAY_MS = 15 * 60_000;

/** Marzban stores expiry in unix SECONDS - tolerate sub-second truncation. */
const EXPIRY_TOLERANCE_MS = 1500;

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
  /** Could not be verified against the panel - left PROVISIONING, retried. */
  deferredOrders: number;
  unresolvedOrders: number;
  failedBroadcasts: number;
}

type OrderOutcome = "completed" | "refunded" | "deferred" | "unresolved";

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

/** Read-only panel probe; every failure mode collapses to ok=false. */
async function fetchPanelAccount(
  panel: Panel,
  username: string,
): Promise<GetServiceAccountResult> {
  try {
    const adapter = buildAdapterForPanel(panel);
    return await adapter.getServiceAccount({
      username,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    return { ok: false, errorMessage: errorMessage(err) };
  }
}

function deferOrder(order: OrderForProvisioning, reason: string): OrderOutcome {
  logger.warn("startup recovery: reconciliation deferred - order left PROVISIONING", {
    orderId: order.id,
    orderType: order.type,
    reason,
  });
  return "deferred";
}

async function refundUnappliedOrder(
  order: OrderForProvisioning,
  provenBy: string,
): Promise<OrderOutcome> {
  // failOrderWithRefund returns true when a refund is in place (created
  // now, pre-existing, or nothing to move for a 0-toman order).
  const refunded = await failOrderWithRefund(
    order,
    `stale PROVISIONING recovered after restart: ${provenBy}`,
  );
  return refunded ? "refunded" : "unresolved";
}

/**
 * Panel account exists for an anchor-less purchase: the create DID happen
 * and only the database commit was lost. Recreate the Service row exactly
 * as the pipeline's persistence transaction would have - sold values from
 * the order's immutable snapshots, connection data from the panel's own
 * report - and finish the order. Never refunds.
 */
async function adoptPanelAccount(
  order: OrderForProvisioning,
  product: Product & { panel: Panel | null },
  panel: Panel,
  username: string,
  fetched: GetServiceAccountResult,
): Promise<OrderOutcome> {
  const volumeGb = order.volumeGbSnapshot ?? product.volumeGb ?? 0;
  const durationDays = order.durationDaysSnapshot ?? product.durationDays ?? 0;
  const volumeBytes =
    fetched.totalBytes !== undefined && fetched.totalBytes !== null
      ? fetched.totalBytes
      : volumeGb > 0
        ? BigInt(volumeGb) * 1024n * 1024n * 1024n
        : 0n;
  const usedBytes = fetched.usedBytes ?? 0n;
  const now = new Date();
  const expiresAt =
    fetched.expiresAt !== undefined
      ? fetched.expiresAt
      : durationDays > 0
        ? new Date(now.getTime() + durationDays * 86_400_000)
        : null;

  await prisma.$transaction(async (tx) => {
    const duplicate = await tx.service.findFirst({ where: { orderId: order.id } });
    if (duplicate === null) {
      await tx.service.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          panelId: panel.id,
          productId: product.id,
          panelType: panel.type,
          username,
          note: `zedbot order:${order.id.slice(0, 8)} tg:${order.user.telegramId}`,
          status: ServiceStatus.ACTIVE,
          productNameSnapshot: order.productNameSnapshot ?? product.name,
          panelNameSnapshot: order.panelNameSnapshot ?? panel.name,
          volumeBytes,
          usedBytes,
          remainingBytes: volumeBytes > usedBytes ? volumeBytes - usedBytes : 0n,
          durationDays,
          startsAt: now,
          expiresAt,
          subscriptionUrl: fetched.subscriptionUrl ?? null,
          subscriptionToken: fetched.subscriptionToken ?? null,
          ...(fetched.configLinks !== undefined && fetched.configLinks.length > 0
            ? { configLinks: fetched.configLinks }
            : {}),
        },
      });
    }
    await tx.order.updateMany({
      where: { id: order.id, status: OrderStatus.PROVISIONING },
      data: { status: OrderStatus.COMPLETED, completedAt: now },
    });
  });
  logger.info("startup recovery: panel account adopted for anchor-less purchase", {
    orderId: order.id,
    panelId: panel.id,
  });
  return "completed";
}

/** Anchor-less purchase: ask the panel whether the account really exists. */
async function reconcilePurchase(order: OrderForProvisioning): Promise<OrderOutcome> {
  const product = order.product;
  const panel = product?.panel ?? null;
  if (product === null || panel === null) {
    return deferOrder(order, "product/panel no longer resolvable - cannot verify panel state");
  }
  const username = generatePanelUsername(order.user.telegramId, order.id);
  const fetched = await fetchPanelAccount(panel, username);
  if (fetched.ok) {
    return adoptPanelAccount(order, product, panel, username, fetched);
  }
  if (fetched.notFound === true) {
    return refundUnappliedOrder(order, "panel confirmed the account was never created");
  }
  return deferOrder(order, fetched.errorMessage ?? "panel state could not be read");
}

type MutationVerdict = "applied" | "not_applied" | "unknown";

function expiryEquals(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a.getTime() - b.getTime()) < EXPIRY_TOLERANCE_MS;
}

/**
 * Compares the mutation-owned panel fields against the service row's stored
 * PRE-mutation state. Only fields the bot itself mutates are compared
 * (data limit, expiry) - usage grows on its own and must never decide.
 * A field the panel did not report yields "unknown", never a guess.
 */
export function compareMutationState(
  orderType: OrderType,
  service: Pick<Service, "volumeBytes" | "expiresAt">,
  fetched: GetServiceAccountResult,
): MutationVerdict {
  // Service rows store 0n for unlimited; the adapter reports null.
  const panelLimit =
    fetched.totalBytes === undefined ? undefined : (fetched.totalBytes ?? 0n);
  const limitKnown = panelLimit !== undefined;
  const limitChanged = limitKnown && panelLimit !== service.volumeBytes;
  const expiryKnown = fetched.expiresAt !== undefined;
  const expiryChanged =
    expiryKnown && !expiryEquals(fetched.expiresAt ?? null, service.expiresAt);

  switch (orderType) {
    case OrderType.EXTRA_VOLUME:
      return limitKnown ? (limitChanged ? "applied" : "not_applied") : "unknown";
    case OrderType.EXTRA_TIME:
      return expiryKnown ? (expiryChanged ? "applied" : "not_applied") : "unknown";
    case OrderType.SERVICE_RENEWAL:
      if (limitChanged || expiryChanged) {
        return "applied";
      }
      return limitKnown && expiryKnown ? "not_applied" : "unknown";
    default:
      return "unknown";
  }
}

/**
 * The mutation reached the panel but its database commit was lost: persist
 * the pipeline's own anchor (ServiceEventLog with the order id) and update
 * the service row from the panel's reported truth, then finish the order -
 * the same end state the pipeline's transaction would have produced.
 */
async function completeReconciledMutation(
  order: OrderForProvisioning,
  service: Service & { panel: Panel },
  eventType: string,
  fetched: GetServiceAccountResult,
): Promise<OrderOutcome> {
  const now = new Date();
  const volumeBytes =
    fetched.totalBytes === undefined
      ? service.volumeBytes
      : (fetched.totalBytes ?? 0n);
  const usedBytes = fetched.usedBytes ?? service.usedBytes;
  const expiresAt = fetched.expiresAt === undefined ? service.expiresAt : fetched.expiresAt;

  await prisma.$transaction(async (tx) => {
    await tx.service.update({
      where: { id: service.id },
      data: {
        status: ServiceStatus.ACTIVE,
        volumeBytes,
        usedBytes,
        remainingBytes:
          volumeBytes === 0n ? 0n : volumeBytes > usedBytes ? volumeBytes - usedBytes : 0n,
        expiresAt,
        durationDays:
          expiresAt === null
            ? 0
            : Math.max(
                0,
                Math.ceil((expiresAt.getTime() - service.startsAt.getTime()) / 86_400_000),
              ),
        lastSubscriptionUpdateAt: now,
        ...(fetched.subscriptionUrl !== undefined && fetched.subscriptionUrl !== ""
          ? { subscriptionUrl: fetched.subscriptionUrl }
          : {}),
      },
    });
    await tx.serviceEventLog.create({
      data: {
        serviceId: service.id,
        userId: order.userId,
        panelId: service.panel.id,
        eventType,
        metadata: { orderId: order.id, reconciled: true },
      },
    });
    await tx.order.updateMany({
      where: { id: order.id, status: OrderStatus.PROVISIONING },
      data: { status: OrderStatus.COMPLETED, completedAt: now },
    });
  });
  logger.info("startup recovery: panel mutation reconciled for anchor-less order", {
    orderId: order.id,
    orderType: order.type,
    serviceId: service.id,
  });
  return "completed";
}

/** Anchor-less renewal/extras: decide from the panel's actual state. */
async function reconcileServiceMutation(
  order: OrderForProvisioning,
  eventType: string,
): Promise<OrderOutcome> {
  const service =
    order.serviceId === null
      ? null
      : await prisma.service.findFirst({
          where: { id: order.serviceId },
          include: { panel: true },
        });
  if (service === null) {
    return deferOrder(order, "target service row missing - cannot verify panel state");
  }
  const fetched = await fetchPanelAccount(service.panel, service.username);
  if (fetched.notFound === true) {
    // The panel PUT would have failed with the same 404 in-process.
    return refundUnappliedOrder(order, "panel confirmed the target account no longer exists");
  }
  if (!fetched.ok) {
    return deferOrder(order, fetched.errorMessage ?? "panel state could not be read");
  }
  const verdict = compareMutationState(order.type, service, fetched);
  if (verdict === "applied") {
    return completeReconciledMutation(order, service, eventType, fetched);
  }
  if (verdict === "not_applied") {
    return refundUnappliedOrder(order, "panel state matches the pre-mutation service state");
  }
  return deferOrder(order, "panel report incomplete - mutation state undecidable");
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
  let deferredOrders = 0;
  let unresolvedOrders = 0;
  for (const order of stale) {
    try {
      const eventType = EVENT_TYPE_BY_ORDER_TYPE[order.type];
      const anchored =
        order.type === OrderType.SERVICE_PURCHASE
          ? await findPurchaseAnchor(order)
          : eventType !== undefined && (await findEventAnchor(order.id, eventType));

      let outcome: OrderOutcome;
      if (anchored) {
        // CAS may lose only to a concurrent sweep that already resolved the
        // order - nothing to count in that case.
        if (!(await completeRecoveredOrder(order.id))) {
          continue;
        }
        outcome = "completed";
        logger.info("startup recovery: stale PROVISIONING order completed", {
          orderId: order.id,
          orderType: order.type,
        });
      } else if (order.type === OrderType.SERVICE_PURCHASE) {
        outcome = await reconcilePurchase(order);
      } else if (eventType !== undefined) {
        outcome = await reconcileServiceMutation(order, eventType);
      } else {
        outcome = deferOrder(order, "no reconciliation strategy for this order type");
      }

      if (outcome === "completed") completedOrders += 1;
      else if (outcome === "refunded") refundedOrders += 1;
      else if (outcome === "deferred") deferredOrders += 1;
      else unresolvedOrders += 1;
    } catch (err) {
      unresolvedOrders += 1;
      logger.error("startup recovery: order recovery failed", {
        orderId: order.id,
        error: errorMessage(err),
      });
    }
  }
  return {
    checkedOrders: stale.length,
    completedOrders,
    refundedOrders,
    deferredOrders,
    unresolvedOrders,
  };
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
    if (report.checkedOrders > 0 || report.failedBroadcasts > 0) {
      logger.info("startup recovery finished", { ...report });
    }
    return report;
  } catch (err) {
    logger.error("startup recovery failed", { error: errorMessage(err) });
    return {
      checkedOrders: 0,
      completedOrders: 0,
      refundedOrders: 0,
      deferredOrders: 0,
      unresolvedOrders: 0,
      failedBroadcasts: 0,
    };
  }
}
