import {
  AutomatedNotificationStatus,
  OrderStatus,
  Prisma,
  WalletTransactionType,
  prisma,
} from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  evaluateNotificationAttributionCandidate,
  type AttributionConfig,
  type AttributionInteractionInput,
  type AttributionKind,
  type AttributionOrderInput,
  type NotificationInteractionTypeValue,
  type NotificationType,
  type OrderTypeValue,
} from "@zedbot/shared";

import {
  getAnalyticsStartedAt,
  getAttributionConfig,
  getAttributionRetentionDays,
  isNotificationAnalyticsEnabled,
} from "./settings.js";

// =============================================================================
// EVIDENCE-BASED conversion attribution — worker side (Phase 4). Turns the pure
// @zedbot/shared evaluator into DB reads + idempotent writes. NOTHING here
// invents a conversion: every attribution is anchored to a persisted click that
// preceded a completed paid Order, and both writers (the after-commit hook's
// per-order job and the periodic batch sweep) converge on `orderId @unique` /
// `interactionId @unique`, so an Order is attributed AT MOST once.
//
// Four maintenance jobs, all safe on any cadence and while analytics is off:
//   reconcileOrderAttribution(orderId) - one completed Order (after-commit hook)
//   runAttributionBatch()              - sweep recently-completed Orders (catch-all
//                                        for crash-recovery + OTHER_PRODUCT paths)
//   runAttributionReversals()          - flip attributions whose Order was refunded
//   runAttributionCleanup()            - prune attributions past retention
// =============================================================================

const log = createLogger("worker:notif-attribution");

/** Per-order/batch: how many recorded clicks (this user) to load as evidence. */
const MAX_INTERACTIONS_PER_ORDER = 500;
/** Batch sweep: max completed Orders examined per run (bounded work). */
const ATTRIBUTION_BATCH = 500;
/** Reversal sweep: max recently-refunded Orders examined per run (bounded). */
const REVERSAL_BATCH = 1000;
/**
 * Reversal look-back: refunds are keyed off recent refund SIGNALS. Comfortably
 * exceeds the default 60-min cadence so a worker down for up to a week still
 * catches every refund on restart.
 */
const REVERSAL_LOOKBACK_MS = 7 * 24 * 3_600_000;

interface AttributionContext {
  startedAt: number;
  config: AttributionConfig;
}

export type AttributionOutcome =
  | { status: "attributed"; kind: AttributionKind }
  | { status: "reversed" }
  | { status: "already-attributed" }
  | { status: "skipped"; reason: string };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * A COMPLETED Order carries a refund signal when a refunding WalletTransaction is
 * linked to it (the codebase's actual reversal mechanism — Order.status=REFUNDED
 * is unused). Kept defensive: a non-COMPLETED terminal status also counts.
 */
async function isOrderRefunded(orderId: string, status: OrderStatus): Promise<boolean> {
  if (
    status === OrderStatus.REFUNDED ||
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.FAILED
  ) {
    return true;
  }
  const refundTx = await prisma.walletTransaction.count({
    where: { relatedOrderId: orderId, type: WalletTransactionType.REFUND },
  });
  return refundTx > 0;
}

/** Loads this user's recorded clicks on SENT notifications sent before `before`. */
async function loadUserAttributionInteractions(
  userId: string,
  before: Date,
): Promise<AttributionInteractionInput[]> {
  const rows = await prisma.notificationInteraction.findMany({
    where: {
      userId,
      createdAt: { lt: before },
      notification: {
        status: AutomatedNotificationStatus.SENT,
        sentAt: { not: null, lt: before },
      },
    },
    select: {
      id: true,
      notificationId: true,
      type: true,
      createdAt: true,
      notification: {
        select: { type: true, sentAt: true, serviceId: true, checkoutSessionId: true },
      },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_INTERACTIONS_PER_ORDER,
  });
  const out: AttributionInteractionInput[] = [];
  for (const r of rows) {
    const sentAt = r.notification.sentAt;
    if (sentAt === null) {
      continue;
    }
    out.push({
      interactionId: r.id,
      notificationId: r.notificationId,
      notificationType: r.notification.type as NotificationType,
      interactionType: r.type as NotificationInteractionTypeValue,
      notificationSentAt: sentAt.getTime(),
      interactionAt: r.createdAt.getTime(),
      notificationCheckoutSessionId: r.notification.checkoutSessionId,
      notificationServiceId: r.notification.serviceId,
    });
  }
  return out;
}

async function attributeOrder(
  orderId: string,
  ctx: AttributionContext,
  source: "hook" | "batch",
): Promise<AttributionOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      type: true,
      status: true,
      completedAt: true,
      finalPriceToman: true,
      checkoutSessionId: true,
      serviceId: true,
    },
  });
  if (order === null) {
    return { status: "skipped", reason: "order-not-found" };
  }
  if (order.status !== OrderStatus.COMPLETED || order.completedAt === null) {
    return { status: "skipped", reason: "order-not-completed" };
  }

  const refunded = await isOrderRefunded(order.id, order.status);
  const interactions = await loadUserAttributionInteractions(order.userId, order.completedAt);

  const orderInput: AttributionOrderInput = {
    orderId: order.id,
    userId: order.userId,
    orderType: order.type as OrderTypeValue,
    orderCompletedAt: order.completedAt.getTime(),
    finalPriceToman: order.finalPriceToman,
    checkoutSessionId: order.checkoutSessionId,
    serviceId: order.serviceId,
    isRefunded: refunded,
    analyticsStartedAt: ctx.startedAt,
  };

  const evaluation = evaluateNotificationAttributionCandidate(orderInput, interactions, ctx.config);
  if (!evaluation.attributed) {
    // Self-healing: a completed order that already has an attribution but is now
    // refunded gets reversed immediately (belt-and-braces with the sweep).
    if (refunded) {
      const reversed = await reverseAttributionsForOrders([order.id]);
      if (reversed > 0) {
        return { status: "reversed" };
      }
    }
    return { status: "skipped", reason: evaluation.reason };
  }

  const decision = evaluation.decision;
  const evidenceSnapshot = {
    ...decision.evidence,
    sentAt: new Date(decision.notificationSentAt).toISOString(),
    interactionAt: new Date(decision.interactionAt).toISOString(),
    orderCompletedAt: new Date(decision.orderCompletedAt).toISOString(),
    candidateCount: evaluation.candidates.length,
    source,
  };

  try {
    await prisma.notificationConversionAttribution.create({
      data: {
        kind: decision.kind,
        orderId: order.id,
        notificationId: decision.notificationId,
        interactionId: decision.interactionId,
        userId: order.userId,
        notificationType: decision.notificationType,
        interactionType: decision.interactionType,
        grossRevenueToman: decision.grossRevenueToman,
        reversedRevenueToman: 0,
        netRevenueToman: decision.grossRevenueToman,
        notificationSentAt: new Date(decision.notificationSentAt),
        interactionAt: new Date(decision.interactionAt),
        orderCompletedAt: new Date(decision.orderCompletedAt),
        windowSeconds: decision.windowSeconds,
        evidenceSnapshot,
      },
    });
    log.info("attribution recorded", {
      order: order.id.slice(0, 8),
      kind: decision.kind,
      source,
    });
    return { status: "attributed", kind: decision.kind };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // orderId (or the winning interactionId) already attributed -> converged.
      return { status: "already-attributed" };
    }
    throw err;
  }
}

/** Loads the live analytics context (enabled + started + config); null when off. */
async function loadContext(): Promise<AttributionContext | null> {
  if (!(await isNotificationAnalyticsEnabled())) {
    return null;
  }
  const startedAt = await getAnalyticsStartedAt();
  if (startedAt === null) {
    return null;
  }
  const config = await getAttributionConfig();
  return { startedAt, config };
}

/** Attributes ONE completed Order (the after-commit hook's per-order job). */
export async function reconcileOrderAttribution(orderId: string): Promise<AttributionOutcome> {
  const ctx = await loadContext();
  if (ctx === null) {
    return { status: "skipped", reason: "analytics-disabled" };
  }
  return attributeOrder(orderId, ctx, "hook");
}

export interface AttributionBatchResult {
  scanned: number;
  attributed: number;
  reversed: number;
  alreadyAttributed: number;
  skipped: number;
}

/**
 * Periodic catch-all: examines COMPLETED Orders in the bounded look-back window
 * (>= analyticsStartedAt) that have no attribution yet, and evaluates each. Covers
 * every completion path the after-commit hook does not (startup-recovery sweeps,
 * OTHER_PRODUCT admin/stock delivery, a hook lost to a Redis flush).
 */
export async function runAttributionBatch(now: Date = new Date()): Promise<AttributionBatchResult> {
  const empty: AttributionBatchResult = {
    scanned: 0,
    attributed: 0,
    reversed: 0,
    alreadyAttributed: 0,
    skipped: 0,
  };
  const ctx = await loadContext();
  if (ctx === null) {
    return empty;
  }
  const lookbackStart = new Date(
    Math.max(ctx.startedAt, now.getTime() - ctx.config.batchLookbackHours * 3_600_000),
  );
  // Already-attributed orders in the window are excluded at the DB level, so the
  // bounded budget is spent ONLY on orders still missing an attribution. Newest
  // completions first — a just-missed after-commit hook is caught promptly, and
  // the 48h look-back bounds how far back a miss can be recovered.
  const attributedIds = (
    await prisma.notificationConversionAttribution.findMany({
      where: { orderCompletedAt: { gte: lookbackStart, lte: now } },
      select: { orderId: true },
    })
  ).map((a) => a.orderId);
  const orders = await prisma.order.findMany({
    where: {
      status: OrderStatus.COMPLETED,
      completedAt: { gte: lookbackStart, lte: now },
      id: attributedIds.length > 0 ? { notIn: attributedIds } : undefined,
    },
    select: { id: true },
    orderBy: { completedAt: "desc" },
    take: ATTRIBUTION_BATCH,
  });
  if (orders.length === 0) {
    return empty;
  }

  const result = { ...empty };
  for (const o of orders) {
    result.scanned += 1;
    try {
      const outcome = await attributeOrder(o.id, ctx, "batch");
      if (outcome.status === "attributed") result.attributed += 1;
      else if (outcome.status === "reversed") result.reversed += 1;
      else if (outcome.status === "already-attributed") result.alreadyAttributed += 1;
      else result.skipped += 1;
    } catch (err) {
      result.skipped += 1;
      log.warn("attribution batch item failed", {
        order: o.id.slice(0, 8),
        error: errorMessage(err),
      });
    }
  }
  if (result.attributed > 0 || result.reversed > 0) {
    log.info("attribution batch complete", {
      scanned: result.scanned,
      attributed: result.attributed,
      reversed: result.reversed,
    });
  }
  return result;
}

/**
 * Idempotently flips ACTIVE attributions for the given orders to REVERSED, moving
 * gross -> reversed and net -> 0 and stamping reversedAt ONCE (the `status =
 * 'ACTIVE'` predicate makes a second run a no-op). Returns the number reversed.
 */
async function reverseAttributionsForOrders(orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) {
    return 0;
  }
  const reversed = await prisma.$executeRaw(Prisma.sql`
    UPDATE "NotificationConversionAttribution"
    SET "status" = 'REVERSED'::"NotificationAttributionStatus",
        "reversedRevenueToman" = "grossRevenueToman",
        "netRevenueToman" = 0,
        "reversedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "orderId" IN (${Prisma.join(orderIds)})
      AND "status" = 'ACTIVE'`);
  return Number(reversed);
}

export interface AttributionReversalResult {
  reversed: number;
}

/**
 * Flips attributions whose underlying Order was refunded/voided. Signal-driven:
 * looks at recent refunding WalletTransactions and recent terminal Order
 * transitions (bounded look-back), then one idempotent SQL reversal. Never
 * asserts "profit" — only moves gross revenue into reversed and net to zero.
 */
export async function runAttributionReversals(
  now: Date = new Date(),
): Promise<AttributionReversalResult> {
  if (!(await isNotificationAnalyticsEnabled())) {
    return { reversed: 0 };
  }
  const lookback = new Date(now.getTime() - REVERSAL_LOOKBACK_MS);
  const [refundTx, terminalOrders] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: {
        type: WalletTransactionType.REFUND,
        relatedOrderId: { not: null },
        createdAt: { gte: lookback },
      },
      select: { relatedOrderId: true },
      distinct: ["relatedOrderId"],
      take: REVERSAL_BATCH,
    }),
    prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.REFUNDED, OrderStatus.CANCELLED, OrderStatus.FAILED] },
        updatedAt: { gte: lookback },
      },
      select: { id: true },
      take: REVERSAL_BATCH,
    }),
  ]);

  const orderIds = [
    ...new Set([
      ...refundTx.map((t) => t.relatedOrderId).filter((id): id is string => id !== null),
      ...terminalOrders.map((o) => o.id),
    ]),
  ];
  const reversed = await reverseAttributionsForOrders(orderIds);
  if (reversed > 0) {
    log.info("attribution reversals complete", { reversed });
  }
  return { reversed };
}

export interface AttributionCleanupResult {
  deleted: number;
}

/**
 * Prunes attribution rows whose Order completed before the retention window.
 * A standalone deleteMany on the attribution table ONLY — it never touches, and
 * is never cascaded by, notification/order/financial rows.
 */
export async function runAttributionCleanup(
  now: Date = new Date(),
): Promise<AttributionCleanupResult> {
  const retentionDays = await getAttributionRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3_600_000);
  const res = await prisma.notificationConversionAttribution.deleteMany({
    where: { orderCompletedAt: { lt: cutoff } },
  });
  if (res.count > 0) {
    log.info("attribution cleanup complete", { deleted: res.count });
  }
  return { deleted: res.count };
}
