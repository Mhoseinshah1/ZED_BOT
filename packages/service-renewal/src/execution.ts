import {
  OrderStatus,
  OrderType,
  PanelStatus,
  ServiceLocation,
  ServiceStatus,
  WalletTransactionSource,
  WalletTransactionType,
  prisma,
  type Order,
  type Prisma,
  type Service,
} from "@zedbot/database";
import type { PanelAdapter } from "@zedbot/panel-adapters";

import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter.js";
import { onWalletBalanceChanged } from "./low-balance.js";
import {
  acquireServiceLock,
  serviceOperationLockKey,
  serviceProvisioningLockKey,
} from "./service-lock.js";
import { consumeReservationForOrder, releaseReservationForFailedOrder } from "./username-reservation.js";

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 86_400_000;
export const COMMERCE_OPERATION_INTENT_EVENT = "COMMERCE_OPERATION_INTENT";
export const COMMERCE_OPERATION_APPLIED_EVENT = "COMMERCE_OPERATION_APPLIED";
export const TRIAL_CONVERTED_EVENT_TYPE = "TRIAL_CONVERTED_TO_PAID";
export const REFUND_PROVISIONING_REASON = "REFUND_PROVISIONING_FAILED";

export type ExecutionClassification =
  | "SUCCESS"
  | "DEFINITE_FAILURE_REFUNDED"
  | "UNCERTAIN_RECONCILIATION_REQUIRED"
  | "ALREADY_CONVERGED"
  | "REPLAY"
  | "BUSY";

export type CommerceExecutionResult =
  | { ok: true; classification: "SUCCESS" | "ALREADY_CONVERGED" | "REPLAY"; service: Service }
  | { ok: false; classification: "DEFINITE_FAILURE_REFUNDED"; refunded: boolean; code: string }
  | { ok: false; classification: "UNCERTAIN_RECONCILIATION_REQUIRED" | "BUSY"; refunded: false; code: string };

type OrderWithRows = Order & {
  product: ({ panel: NonNullable<Awaited<ReturnType<typeof prisma.panel.findUnique>>> | null } & NonNullable<Awaited<ReturnType<typeof prisma.product.findUnique>>>) | null;
  checkoutSession: NonNullable<Awaited<ReturnType<typeof prisma.checkoutSession.findUnique>>> | null;
};

export interface CommerceExecutionDependencies {
  buildAdapter?: (panel: NonNullable<OrderWithRows["product"]>["panel"] extends infer P ? NonNullable<P> : never) => PanelAdapter;
}

function record(snapshot: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && value[key] !== "" ? value[key] as string : null;
}

function intField(value: Record<string, unknown>, key: string): number | null {
  return Number.isSafeInteger(value[key]) ? value[key] as number : null;
}

async function orderRows(orderId: string): Promise<OrderWithRows | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { product: { include: { panel: true } }, checkoutSession: true },
  }) as Promise<OrderWithRows | null>;
}

async function refundDefinite(order: OrderWithRows, reason: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const flipped = await tx.order.updateMany({
      where: { id: order.id, status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING] } },
      data: { status: OrderStatus.FAILED, failureReason: reason.slice(0, 500) },
    });
    const existing = await tx.walletTransaction.findFirst({
      where: { relatedOrderId: order.id, reason: REFUND_PROVISIONING_REASON },
    });
    if (existing !== null) return true;
    if (flipped.count !== 1) return false;
    await releaseReservationForFailedOrder(tx, { orderId: order.id, checkoutSessionId: order.checkoutSessionId });
    if (order.finalPriceToman <= 0) return true;
    const credited = await tx.user.update({
      where: { id: order.userId },
      data: { balanceToman: { increment: order.finalPriceToman }, totalRefundedToman: { increment: order.finalPriceToman } },
      select: { balanceToman: true },
    });
    await tx.walletTransaction.create({ data: {
      userId: order.userId, amountToman: order.finalPriceToman,
      type: WalletTransactionType.REFUND, source: WalletTransactionSource.SYSTEM,
      reason: REFUND_PROVISIONING_REASON, relatedOrderId: order.id,
      relatedPaymentId: order.paymentId,
      balanceBeforeToman: credited.balanceToman - order.finalPriceToman,
      balanceAfterToman: credited.balanceToman,
    }});
    await onWalletBalanceChanged(tx, {
      userId: order.userId,
      balanceBeforeToman: credited.balanceToman - order.finalPriceToman,
      balanceAfterToman: credited.balanceToman,
      source: "REFUND",
    });
    return true;
  });
}

async function convertTrial(tx: Prisma.TransactionClient, service: Service, orderId: string, now: Date) {
  const changed = await tx.service.updateMany({
    where: { id: service.id, source: "FREE_TRIAL", convertedToPaidAt: null },
    data: { convertedToPaidAt: now, firstPaidOrderId: orderId },
  });
  if (changed.count === 1) await tx.serviceEventLog.create({ data: {
    serviceId: service.id, userId: service.userId, panelId: service.panelId,
    eventType: TRIAL_CONVERTED_EVENT_TYPE, metadata: { orderId },
  }});
}

function acquiredFailure(): CommerceExecutionResult {
  return { ok: false, classification: "BUSY", refunded: false, code: "EXECUTION_BUSY" };
}

export async function executePaidCommerceOrder(
  orderId: string,
  dependencies: CommerceExecutionDependencies = {},
): Promise<CommerceExecutionResult> {
  const head = await prisma.order.findUnique({ where: { id: orderId }, select: { type: true } });
  if (head === null) return { ok: false, classification: "BUSY", refunded: false, code: "ORDER_NOT_FOUND" };
  if (head.type === OrderType.SERVICE_PURCHASE) return provisionPaidOrder(orderId, dependencies);
  if (head.type === OrderType.SERVICE_RENEWAL) return executeServiceOperation(orderId, "RENEWAL", dependencies);
  if (head.type === OrderType.EXTRA_VOLUME) return executeServiceOperation(orderId, "EXTRA_VOLUME", dependencies);
  if (head.type === OrderType.EXTRA_TIME) return executeServiceOperation(orderId, "EXTRA_TIME", dependencies);
  return { ok: false, classification: "BUSY", refunded: false, code: "ORDER_TYPE_UNSUPPORTED" };
}

export async function provisionPaidOrder(
  orderId: string,
  dependencies: CommerceExecutionDependencies = {},
): Promise<CommerceExecutionResult> {
  const order = await orderRows(orderId);
  if (order === null || order.type !== OrderType.SERVICE_PURCHASE) return acquiredFailure();
  const already = await prisma.service.findFirst({ where: { orderId } });
  if (already !== null) {
    await prisma.order.updateMany({ where: { id: orderId, status: { not: OrderStatus.COMPLETED } }, data: { status: OrderStatus.COMPLETED, completedAt: new Date() } });
    return { ok: true, classification: "REPLAY", service: already };
  }
  if (order.status !== OrderStatus.PAID || order.product?.panel === null || order.product === null) return acquiredFailure();
  const captured = record(order.checkoutSession?.productSnapshot ?? null);
  const panel = order.product.panel;
  const frozenPanelId = stringField(captured, "panelId");
  const username = stringField(captured, "serviceUsername");
  if (frozenPanelId !== panel.id || username === null || panel.status !== PanelStatus.ACTIVE) {
    const refunded = await refundDefinite(order, "invalid frozen provisioning target");
    return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "PROVISIONING_TARGET_INVALID" };
  }
  const acquisition = await acquireServiceLock(serviceProvisioningLockKey(panel.id, username));
  if (!acquisition.ok) return acquiredFailure();
  try {
    const replay = await prisma.service.findFirst({ where: { orderId } });
    if (replay !== null) return { ok: true, classification: "ALREADY_CONVERGED", service: replay };
    const claimed = await prisma.order.updateMany({ where: { id: order.id, status: OrderStatus.PAID }, data: { status: OrderStatus.PROVISIONING } });
    if (claimed.count !== 1) return acquiredFailure();
    const volumeGb = order.volumeGbSnapshot ?? intField(captured, "volumeGb") ?? 0;
    const durationDays = order.durationDaysSnapshot ?? intField(captured, "durationDays") ?? 0;
    const product = order.product;
    if (product === null) return acquiredFailure();
    const volumeBytes = volumeGb > 0 ? BigInt(volumeGb) * GIB : null;
    const now = new Date();
    const expiresAt = durationDays > 0 ? new Date(now.getTime() + durationDays * DAY_MS) : null;
    const adapter = dependencies.buildAdapter?.(panel) ?? buildAdapterForPanel(panel);
    let remote;
    try {
      remote = await adapter.createServiceAccount({
        username, note: `zedbot order:${order.id.slice(0, 8)}`, volumeBytes, durationDays, expiresAt,
        templateUsername: panel.templateUsername, dataLimitResetStrategy: panel.resetStrategy,
        trafficResetCycle: product.trafficResetCycle,
        subscriptionBaseUrl: normalizeSubscriptionBase(panel),
        inboundIds: Array.isArray(order.inboundIdsSnapshot) ? order.inboundIdsSnapshot.filter((v): v is number => Number.isSafeInteger(v)) : null,
        protocolSettings: typeof panel.protocolSettings === "object" && panel.protocolSettings !== null ? panel.protocolSettings as Record<string, unknown> : null,
      });
    } catch {
      remote = { ok: false, uncertain: true } as const;
    }
    if (!remote.ok) {
      if (remote.uncertain === true) return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "REMOTE_RESULT_UNCERTAIN" };
      const refunded = await refundDefinite(order, remote.errorMessage ?? "definite panel refusal");
      return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "REMOTE_DEFINITE_FAILURE" };
    }
    if (acquisition.lock.isLost()) return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "LOCK_LOST_AFTER_REMOTE" };
    const service = await prisma.$transaction(async tx => {
      const existing = await tx.service.findFirst({ where: { orderId: order.id } });
      if (existing !== null) return existing;
      const created = await tx.service.create({ data: {
        userId: order.userId, orderId: order.id, panelId: panel.id, productId: order.productId,
        panelType: panel.type, username: remote.username ?? username,
        note: `zedbot order:${order.id.slice(0, 8)}`, userNote: order.serviceNoteSnapshot,
        status: ServiceStatus.ACTIVE,
        serviceLocation: product.serviceLocation ?? ServiceLocation.MULTI_LOCATION,
        productNameSnapshot: order.productNameSnapshot ?? product.name,
        panelNameSnapshot: order.panelNameSnapshot ?? panel.name,
        volumeBytes: volumeBytes ?? 0n, usedBytes: 0n, remainingBytes: volumeBytes ?? 0n,
        durationDays, startsAt: now, expiresAt,
        subscriptionUrl: remote.subscriptionUrl ?? null, subscriptionToken: remote.subscriptionToken ?? null,
        ...(remote.configLinks !== undefined ? { configLinks: remote.configLinks } : {}),
        remoteClientId: remote.remoteClientId ?? null,
        ...(remote.remoteInboundIds !== undefined ? { remoteInboundIds: remote.remoteInboundIds } : {}),
        ...(remote.remoteMetadata !== undefined ? { remoteMetadata: remote.remoteMetadata as Prisma.InputJsonObject } : {}),
      }});
      await consumeReservationForOrder(tx, order.id, created.id, created.username);
      await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PROVISIONING }, data: { status: OrderStatus.COMPLETED, completedAt: now } });
      return created;
    });
    return { ok: true, classification: "SUCCESS", service };
  } finally {
    await acquisition.lock.release();
  }
}

type Operation = "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME";

function expected(operation: Operation, service: Service, order: Order, now: Date) {
  const volumeGb = order.volumeGbSnapshot ?? 0;
  const durationDays = order.durationDaysSnapshot ?? 0;
  if (operation === "EXTRA_VOLUME") {
    const totalBytes = (service.remainingBytes > 0n ? service.remainingBytes : 0n) + BigInt(volumeGb) * GIB;
    return { totalBytes, remainingBytes: totalBytes, expiresAt: service.expiresAt, durationDays, volumeGb };
  }
  if (operation === "EXTRA_TIME") {
    const base = service.expiresAt !== null && service.expiresAt > now ? service.expiresAt : now;
    return { totalBytes: service.volumeBytes > 0n ? service.volumeBytes : null, remainingBytes: service.remainingBytes, expiresAt: new Date(base.getTime() + durationDays * DAY_MS), durationDays, volumeGb };
  }
  const base = service.expiresAt !== null && service.expiresAt > now ? service.expiresAt : now;
  const totalBytes = volumeGb === 0 ? null : (service.remainingBytes > 0n ? service.remainingBytes : 0n) + BigInt(volumeGb) * GIB;
  return { totalBytes, remainingBytes: totalBytes, expiresAt: durationDays > 0 ? new Date(base.getTime() + durationDays * DAY_MS) : service.expiresAt, durationDays, volumeGb };
}

export async function executeServiceOperation(
  orderId: string,
  operation: Operation,
  dependencies: CommerceExecutionDependencies = {},
): Promise<CommerceExecutionResult> {
  const head = await prisma.order.findUnique({ where: { id: orderId }, select: { serviceId: true } });
  if (head?.serviceId === null || head?.serviceId === undefined) return acquiredFailure();
  const acquisition = await acquireServiceLock(serviceOperationLockKey(head.serviceId));
  if (!acquisition.ok) return acquiredFailure();
  try {
    const order = await orderRows(orderId);
    if (order === null || order.serviceId === null) return acquiredFailure();
    const applied = await prisma.serviceEventLog.findFirst({ where: { eventType: COMMERCE_OPERATION_APPLIED_EVENT, metadata: { path: ["orderId"], equals: order.id } } });
    if (applied !== null) {
      const service = await prisma.service.findUnique({ where: { id: applied.serviceId } });
      if (service !== null) return { ok: true, classification: "REPLAY", service };
    }
    if (order.status !== OrderStatus.PAID) return acquiredFailure();
    const service = await prisma.service.findFirst({ where: { id: order.serviceId, userId: order.userId, deletedAt: null }, include: { panel: true } });
    if (service === null || service.panel.status !== PanelStatus.ACTIVE) {
      const refunded = await refundDefinite(order, "operation target unavailable");
      return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "SERVICE_UNAVAILABLE" };
    }
    const now = new Date();
    const post = expected(operation, service, order, now);
    if ((operation === "EXTRA_VOLUME" && (post.volumeGb <= 0 || service.volumeBytes <= 0n)) || (operation === "EXTRA_TIME" && (post.durationDays <= 0 || service.expiresAt === null))) {
      const refunded = await refundDefinite(order, "invalid operation grant");
      return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "INVALID_GRANT" };
    }
    const claimed = await prisma.$transaction(async tx => {
      const changed = await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PAID }, data: { status: OrderStatus.PROVISIONING } });
      if (changed.count !== 1) return false;
      await tx.serviceEventLog.create({ data: {
        serviceId: service.id, userId: order.userId, panelId: service.panelId,
        eventType: COMMERCE_OPERATION_INTENT_EVENT,
        metadata: { orderId: order.id, operation, beforeTotalBytes: service.volumeBytes.toString(), beforeRemainingBytes: service.remainingBytes.toString(), beforeExpiresAt: service.expiresAt?.toISOString() ?? null, expectedTotalBytes: post.totalBytes?.toString() ?? null, expectedExpiresAt: post.expiresAt?.toISOString() ?? null },
      }});
      return true;
    });
    if (!claimed) return acquiredFailure();
    const adapter = dependencies.buildAdapter?.(service.panel) ?? buildAdapterForPanel(service.panel);
    let remote;
    try {
      remote = operation === "RENEWAL"
        ? await adapter.renewServiceAccount({ username: service.username, totalBytes: post.totalBytes, expiresAt: post.expiresAt, subscriptionBaseUrl: normalizeSubscriptionBase(service.panel) })
        : operation === "EXTRA_VOLUME"
          ? await adapter.addServiceVolume({ username: service.username, totalBytes: post.totalBytes as bigint, expiresAt: service.expiresAt, subscriptionBaseUrl: normalizeSubscriptionBase(service.panel) })
          : await adapter.addServiceTime({ username: service.username, totalBytes: post.totalBytes, expiresAt: post.expiresAt as Date, subscriptionBaseUrl: normalizeSubscriptionBase(service.panel) });
    } catch {
      remote = { ok: false, uncertain: true } as const;
    }
    if (!remote.ok) {
      if (remote.uncertain === true) return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "REMOTE_RESULT_UNCERTAIN" };
      const refunded = await refundDefinite(order, remote.errorMessage ?? "definite panel refusal");
      return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "REMOTE_DEFINITE_FAILURE" };
    }
    if (acquisition.lock.isLost()) return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "LOCK_LOST_AFTER_REMOTE" };
    const updated = await prisma.$transaction(async tx => {
      const row = await tx.service.update({ where: { id: service.id }, data: {
        volumeBytes: remote.totalBytes ?? post.totalBytes ?? 0n,
        remainingBytes: remote.remainingBytes ?? post.remainingBytes ?? 0n,
        usedBytes: remote.usedBytes ?? 0n,
        expiresAt: remote.expiresAt === undefined ? post.expiresAt : remote.expiresAt,
        status: ServiceStatus.ACTIVE,
        ...(remote.subscriptionUrl !== undefined ? { subscriptionUrl: remote.subscriptionUrl } : {}),
        ...(remote.configLinks !== undefined ? { configLinks: remote.configLinks } : {}),
      }});
      await tx.serviceEventLog.create({ data: { serviceId: service.id, userId: order.userId, panelId: service.panelId, eventType: COMMERCE_OPERATION_APPLIED_EVENT, metadata: { orderId: order.id, operation } } });
      await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PROVISIONING }, data: { status: OrderStatus.COMPLETED, completedAt: now } });
      await convertTrial(tx, service, order.id, now);
      return row;
    });
    return { ok: true, classification: "SUCCESS", service: updated };
  } finally {
    await acquisition.lock.release();
  }
}

/** Reconciles one uncertain order from panel truth. It never repeats a remote
 * mutation and never refunds unless a read positively proves it did not land. */
export async function reconcileCommerceOrder(orderId: string, dependencies: CommerceExecutionDependencies = {}): Promise<CommerceExecutionResult> {
  const order = await orderRows(orderId);
  if (order === null || order.status !== OrderStatus.PROVISIONING) return acquiredFailure();
  if (order.type === OrderType.SERVICE_PURCHASE) {
    const panel = order.product?.panel;
    const captured = record(order.checkoutSession?.productSnapshot ?? null);
    const username = stringField(captured, "serviceUsername");
    if (panel === null || panel === undefined || username === null) return acquiredFailure();
    const acquisition = await acquireServiceLock(serviceProvisioningLockKey(panel.id, username));
    if (!acquisition.ok) return acquiredFailure();
    try {
      const adapter = dependencies.buildAdapter?.(panel) ?? buildAdapterForPanel(panel);
      const remote = await adapter.getServiceAccount({ username, subscriptionBaseUrl: normalizeSubscriptionBase(panel) });
      if (!remote.ok) {
        if (remote.diagnostic?.code === "not-found" && remote.diagnostic.certainty === "definite") {
          const refunded = await refundDefinite(order, "reconciliation proved account absent");
          return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "REMOTE_ABSENT" };
        }
        return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "REMOTE_READ_UNCERTAIN" };
      }
      // Adoption uses the same persistence path without another create call.
      const volumeGb = order.volumeGbSnapshot ?? 0; const durationDays = order.durationDaysSnapshot ?? 0;
      const service = await prisma.$transaction(async tx => {
        const existing = await tx.service.findFirst({ where: { orderId } }); if (existing !== null) return existing;
        const row = await tx.service.create({ data: {
          userId: order.userId, orderId, panelId: panel.id, productId: order.productId,
          panelType: panel.type, username: remote.username ?? username, status: ServiceStatus.ACTIVE,
          serviceLocation: order.product?.serviceLocation ?? ServiceLocation.MULTI_LOCATION,
          productNameSnapshot: order.productNameSnapshot, panelNameSnapshot: order.panelNameSnapshot,
          volumeBytes: remote.totalBytes ?? BigInt(volumeGb) * GIB,
          usedBytes: remote.usedBytes ?? 0n, remainingBytes: remote.remainingBytes ?? 0n,
          durationDays, expiresAt: remote.expiresAt ?? null,
          subscriptionUrl: remote.subscriptionUrl ?? null, subscriptionToken: remote.subscriptionToken ?? null,
          ...(remote.configLinks !== undefined ? { configLinks: remote.configLinks } : {}),
        }});
        await consumeReservationForOrder(tx, order.id, row.id, row.username);
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED, completedAt: new Date() } });
        return row;
      });
      return { ok: true, classification: "ALREADY_CONVERGED", service };
    } finally { await acquisition.lock.release(); }
  }
  // Existing-service operations: compare the durable intent with panel truth.
  const intent = await prisma.serviceEventLog.findFirst({ where: { eventType: COMMERCE_OPERATION_INTENT_EVENT, metadata: { path: ["orderId"], equals: order.id } }, orderBy: { createdAt: "desc" } });
  if (intent === null || order.serviceId === null) return acquiredFailure();
  const service = await prisma.service.findFirst({ where: { id: order.serviceId, userId: order.userId }, include: { panel: true } });
  if (service === null) return acquiredFailure();
  const acquisition = await acquireServiceLock(serviceOperationLockKey(service.id)); if (!acquisition.ok) return acquiredFailure();
  try {
    const adapter = dependencies.buildAdapter?.(service.panel) ?? buildAdapterForPanel(service.panel);
    const remote = await adapter.getServiceAccount({ username: service.username, subscriptionBaseUrl: normalizeSubscriptionBase(service.panel) });
    if (!remote.ok) return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "REMOTE_READ_UNCERTAIN" };
    const meta = record(intent.metadata); const expectedBytes = stringField(meta, "expectedTotalBytes"); const expectedExpiry = stringField(meta, "expectedExpiresAt");
    const applied = (expectedBytes !== null && remote.totalBytes?.toString() === expectedBytes) || (expectedExpiry !== null && remote.expiresAt?.toISOString() === expectedExpiry);
    if (!applied) {
      const unchangedBytes = stringField(meta, "beforeTotalBytes") === remote.totalBytes?.toString();
      const unchangedExpiry = (stringField(meta, "beforeExpiresAt") ?? null) === (remote.expiresAt?.toISOString() ?? null);
      if (unchangedBytes && unchangedExpiry) {
        const refunded = await refundDefinite(order, "reconciliation proved operation absent");
        return { ok: false, classification: "DEFINITE_FAILURE_REFUNDED", refunded, code: "REMOTE_UNCHANGED" };
      }
      return { ok: false, classification: "UNCERTAIN_RECONCILIATION_REQUIRED", refunded: false, code: "REMOTE_STATE_AMBIGUOUS" };
    }
    const now = new Date();
    const updated = await prisma.$transaction(async tx => {
      const row = await tx.service.update({ where: { id: service.id }, data: {
        ...(remote.totalBytes !== undefined ? { volumeBytes: remote.totalBytes ?? 0n } : {}),
        ...(remote.remainingBytes !== undefined ? { remainingBytes: remote.remainingBytes ?? 0n } : {}),
        ...(remote.usedBytes !== undefined ? { usedBytes: remote.usedBytes } : {}),
        ...(remote.expiresAt !== undefined ? { expiresAt: remote.expiresAt } : {}),
      }});
      await tx.serviceEventLog.create({ data: { serviceId: service.id, userId: order.userId, panelId: service.panelId, eventType: COMMERCE_OPERATION_APPLIED_EVENT, metadata: { orderId: order.id, reconciled: true } } });
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED, completedAt: now } });
      await convertTrial(tx, service, order.id, now);
      return row;
    });
    return { ok: true, classification: "ALREADY_CONVERGED", service: updated };
  } finally { await acquisition.lock.release(); }
}

export async function reconcileStaleCommerceOrders(olderThan: Date, limit = 50, dependencies: CommerceExecutionDependencies = {}) {
  const rows = await prisma.order.findMany({
    where: { status: OrderStatus.PROVISIONING, type: { in: [OrderType.SERVICE_PURCHASE, OrderType.SERVICE_RENEWAL, OrderType.EXTRA_VOLUME, OrderType.EXTRA_TIME] }, updatedAt: { lt: olderThan } },
    orderBy: { updatedAt: "asc" }, take: Math.max(1, Math.min(limit, 100)), select: { id: true },
  });
  const results: Array<{ orderId: string; result: CommerceExecutionResult }> = [];
  for (const row of rows) results.push({ orderId: row.id, result: await reconcileCommerceOrder(row.id, dependencies) });
  return results;
}
