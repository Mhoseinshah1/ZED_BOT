import {
  OrderStatus,
  OrderType,
  prisma,
  ServiceLocation,
  ServiceStatus,
  WalletTransactionSource,
  WalletTransactionType,
  type Order,
  type Panel,
  type Product,
  type Service,
  type User,
} from "@zedbot/database";
import { type CreateServiceAccountResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  assessPanelConfig,
  parsePanelInboundIds,
  resolveProductInboundIds,
} from "./panel-readiness.service.js";
import {
  acquireServiceLock,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_LOST_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceProvisioningLockKey,
  type ServiceLock,
} from "./service-lock.service.js";

// =============================================================================
// Provisioning (Phase 9): turns a PAID SERVICE_PURCHASE Order into a panel
// account + ACTIVE Service row, or FAILs the order and refunds the user's
// wallet. Core guarantee: the user is never left charged without either a
// service or a refund.
//
// Status flow: PAID -> PROVISIONING -> COMPLETED (success)
//                                   -> FAILED + wallet refund (failure)
//
// Idempotency:
//   - a Service already existing for the order short-circuits to success
//     (and repairs the order status to COMPLETED);
//   - the PAID -> PROVISIONING claim is a compare-and-set, so concurrent
//     calls cannot double-provision;
//   - the refund is created only by the call that flips the order to FAILED,
//     and never when a refund transaction for the order already exists;
//   - panel usernames are deterministic per order, and the Marzban adapter
//     recovers (not duplicates) an account left by a crashed attempt;
//   - (9.1) a DB failure AFTER panel success runs a recovery ladder
//     (existing service -> repair by username -> one retry -> refund), so
//     the order never stays PROVISIONING without a service or a refund.
//
// No renewal, extra volume/time, location change, service management or
// OtherProductOrder handling here - later phases.
// =============================================================================

export const REFUND_PROVISIONING_REASON = "REFUND_PROVISIONING_FAILED";

/** Customer-facing failure/refund notice (never contains adapter errors). */
export const PROVISION_FAILED_USER_TEXT =
  "پرداخت شما تایید شد ✅\n" +
  "اما ساخت سرویس با خطا مواجه شد.\n" +
  "مبلغ پرداختی به کیف پول شما برگشت داده شد.";

/**
 * Returned when the panel outcome is UNKNOWN/partial (e.g. timeout after the
 * request may have landed). The order stays PROVISIONING - never refunded on
 * uncertainty - and startup reconciliation settles it from panel truth.
 */
export const PROVISION_UNKNOWN_OUTCOME_TEXT =
  "نتیجه ساخت سرویس نامشخص ماند؛ وضعیت سفارش به‌صورت خودکار بررسی و اصلاح می‌شود.";

export type ProvisionOutcome =
  | { ok: true; service: Service; alreadyExisted: boolean }
  | { ok: false; refunded: boolean; error: string };

export type OrderForProvisioning = Order & {
  user: User;
  product: (Product & { panel: Panel | null }) | null;
};

/**
 * Deterministic, panel-safe username: zed_<telegramId>_<orderShortId>,
 * lowercase [a-z0-9_], shortened via the telegramId's last 8 digits when it
 * would exceed 32 chars. Same order always yields the same username.
 */
export function generatePanelUsername(telegramId: bigint, orderId: string): string {
  const orderShort = orderId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const tg = telegramId.toString();
  let username = `zed_${tg}_${orderShort}`;
  if (username.length > 32) {
    username = `zed_${tg.slice(-8)}_${orderShort}`;
  }
  return username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Marks the order FAILED and refunds finalPriceToman to the user's wallet,
 * all in one transaction. Only the caller that actually flips the status
 * creates the refund; an existing refund transaction for this order is never
 * duplicated. Returns true when a refund is in place (created now or before).
 * Shared with the Phase 12 renewal pipeline.
 */
export async function failOrderWithRefund(
  order: OrderForProvisioning,
  internalError: string,
): Promise<boolean> {
  const refunded = await prisma.$transaction(async (tx) => {
    const flipped = await tx.order.updateMany({
      where: { id: order.id, status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING] } },
      data: { status: OrderStatus.FAILED, failureReason: internalError.slice(0, 500) },
    });
    const existingRefund = await tx.walletTransaction.findFirst({
      where: { relatedOrderId: order.id, reason: REFUND_PROVISIONING_REASON },
    });
    if (existingRefund !== null) {
      return true;
    }
    if (flipped.count === 0) {
      // Someone else owns the failure path; do not double-refund.
      return false;
    }
    if (order.finalPriceToman <= 0) {
      // Fully-discounted order: nothing to move, FAILED is enough.
      return true;
    }
    // LEDGER-CRITICAL: the increment UPDATE takes the row lock and returns
    // the post-update row, so balanceBefore/balanceAfter always describe
    // the real transition. A plain pre-read here would race a concurrent
    // wallet operation and record a before/after pair that never existed.
    const credited = await tx.user.update({
      where: { id: order.userId },
      data: {
        balanceToman: { increment: order.finalPriceToman },
        totalRefundedToman: { increment: order.finalPriceToman },
      },
      select: { balanceToman: true },
    });
    const balanceAfter = credited.balanceToman;
    const balanceBefore = balanceAfter - order.finalPriceToman;
    await tx.walletTransaction.create({
      data: {
        userId: order.userId,
        amountToman: order.finalPriceToman,
        type: WalletTransactionType.REFUND,
        source: WalletTransactionSource.SYSTEM,
        reason: REFUND_PROVISIONING_REASON,
        relatedOrderId: order.id,
        relatedPaymentId: order.paymentId,
        balanceBeforeToman: balanceBefore,
        balanceAfterToman: balanceAfter,
      },
    });
    return true;
  });
  logger.warn("provisioning failed - order FAILED", {
    orderId: order.id,
    refunded,
    error: internalError,
  });
  return refunded;
}

/**
 * Provisions one PAID SERVICE_PURCHASE order. Safe to call repeatedly:
 * every path is guarded (see module header). All returned error strings are
 * admin-safe Persian; adapter internals only go to logs.
 *
 * CONCURRENCY: no Service row exists yet, so the distributed lock keys on
 * the panel + the order's deterministic username - the same key startup
 * reconciliation uses, so a stale-order sweep can never probe/adopt while
 * this pipeline is creating the account. Contention or an unavailable lock
 * backend leaves the order PAID and retryable - no panel call, no refund.
 */
export async function provisionPaidOrder(orderId: string): Promise<ProvisionOutcome> {
  // Pre-lock reads only feed the lock key (deterministic username + panel).
  const head = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } } },
  })) as OrderForProvisioning | null;
  if (head === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  const headPanel = head.product?.panel ?? null;
  if (head.type !== OrderType.SERVICE_PURCHASE || headPanel === null) {
    // Type mismatch errors and the missing-panel preflight refund need no
    // shared-state protection - delegate to the unguarded body.
    return provisionPaidOrderUnlocked(orderId, null);
  }
  const username = generatePanelUsername(head.user.telegramId, head.id);
  const acquisition = await acquireServiceLock(
    serviceProvisioningLockKey(headPanel.id, username),
  );
  if (!acquisition.ok) {
    return {
      ok: false,
      refunded: false,
      error:
        acquisition.reason === "contended"
          ? SERVICE_LOCK_BUSY_TEXT
          : SERVICE_LOCK_UNAVAILABLE_TEXT,
    };
  }
  try {
    return await provisionPaidOrderUnlocked(orderId, acquisition.lock);
  } finally {
    await acquisition.lock.release();
  }
}

async function provisionPaidOrderUnlocked(
  orderId: string,
  lock: ServiceLock | null,
): Promise<ProvisionOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } } },
  })) as OrderForProvisioning | null;
  if (order === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }

  // Idempotency: an existing Service wins over everything.
  const existingService = await prisma.service.findFirst({ where: { orderId: order.id } });
  if (existingService !== null) {
    if (order.status !== OrderStatus.COMPLETED) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
    }
    return { ok: true, service: existingService, alreadyExisted: true };
  }

  if (order.type !== OrderType.SERVICE_PURCHASE) {
    return { ok: false, refunded: false, error: "این سفارش از نوع خرید سرویس نیست." };
  }
  if (order.status === OrderStatus.PROVISIONING) {
    return { ok: false, refunded: false, error: "ساخت سرویس این سفارش هم‌اکنون در حال انجام است." };
  }
  if (order.status === OrderStatus.FAILED) {
    // No automatic retry in this phase.
    return { ok: false, refunded: false, error: "این سفارش قبلاً ناموفق شده است." };
  }
  if (order.status !== OrderStatus.PAID) {
    return { ok: false, refunded: false, error: "وضعیت سفارش برای ساخت سرویس معتبر نیست." };
  }

  // Pre-flight configuration checks. The order is PAID, so any dead end here
  // is a provisioning failure: FAIL + refund, never a silent charge.
  const product = order.product;
  const panel = product?.panel ?? null;
  // XUI: the product provisions into ITS resolved inbound subset of the
  // panel allowlist (null/empty selection inherits the full allowlist).
  const inboundResolution =
    panel !== null && panel.type === "XUI" && product !== null
      ? resolveProductInboundIds(panel, product.inboundIds)
      : null;
  const preflightError =
    product === null
      ? "product row no longer exists"
      : product.type !== "SERVICE_PRODUCT"
        ? "product is not a SERVICE_PRODUCT"
        : panel === null
          ? "product has no panel"
          : panel.status !== "ACTIVE"
            ? `panel status is ${panel.status}`
            : !assessPanelConfig(panel).ok
              ? `panel provisioning config incomplete: ${assessPanelConfig(panel).reason ?? "unknown"}`
              : inboundResolution !== null && !inboundResolution.ok
                ? `product inbound selection invalid: ${inboundResolution.reason}` +
                  (inboundResolution.invalidIds !== undefined
                    ? ` (${inboundResolution.invalidIds.join(", ")})`
                    : "")
                : null;
  if (preflightError !== null || product === null || panel === null) {
    const refunded = await failOrderWithRefund(order, preflightError ?? "invalid configuration");
    return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
  }

  // Claim the order: only one caller wins PAID -> PROVISIONING.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: OrderStatus.PAID },
    data: { status: OrderStatus.PROVISIONING },
  });
  if (claimed.count === 0) {
    return { ok: false, refunded: false, error: "سفارش توسط فرایند دیگری در حال پردازش است." };
  }
  logger.info("provisioning started", {
    orderId: order.id,
    panelId: panel.id,
    panelType: panel.type,
  });

  // Immutable sold values: order snapshots first, Product fields as fallback.
  const volumeGb = order.volumeGbSnapshot ?? product.volumeGb ?? 0;
  const durationDays = order.durationDaysSnapshot ?? product.durationDays ?? 0;
  const volumeBytes = volumeGb > 0 ? BigInt(volumeGb) * 1024n * 1024n * 1024n : null;
  const now = new Date();
  const expiresAt = durationDays > 0 ? new Date(now.getTime() + durationDays * 86_400_000) : null;
  const username = generatePanelUsername(order.user.telegramId, order.id);
  const note = `zedbot order:${order.id.slice(0, 8)} tg:${order.user.telegramId}`;

  let created: CreateServiceAccountResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    created = await adapter.createServiceAccount({
      username,
      note,
      volumeBytes,
      durationDays,
      expiresAt,
      templateUsername: panel.templateUsername,
      dataLimitResetStrategy: panel.resetStrategy,
      trafficResetCycle: product.trafficResetCycle,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
      inboundIds:
        inboundResolution !== null && inboundResolution.ok
          ? inboundResolution.inboundIds
          : parsePanelInboundIds(panel.inboundIds),
      protocolSettings:
        panel.protocolSettings !== null && typeof panel.protocolSettings === "object"
          ? (panel.protocolSettings as Record<string, unknown>)
          : null,
    });
  } catch (err) {
    // Covers credential decryption/config errors - never exposed to users.
    created = { ok: false, errorMessage: errorMessage(err) };
  }

  if (!created.ok) {
    // Structured sanitized diagnostic (never credentials/cookies/tokens).
    logger.warn("panel create-service failed", {
      orderId: order.id,
      panelId: panel.id,
      panelType: panel.type,
      code: created.diagnostic?.code ?? null,
      httpStatus: created.diagnostic?.httpStatus ?? null,
      endpointPath: created.diagnostic?.endpointPath ?? null,
      uncertain: created.uncertain === true,
      error: created.errorMessage ?? "unknown adapter error",
    });
    if (created.uncertain === true) {
      // UNKNOWN/partial remote state (e.g. timeout after the request may
      // have landed, or a multi-inbound cleanup that could not be
      // confirmed). NEVER refund on uncertainty: the order stays
      // PROVISIONING and startup reconciliation - which probes the panel
      // under the same lock - completes or refunds it on positive proof.
      return { ok: false, refunded: false, error: PROVISION_UNKNOWN_OUTCOME_TEXT };
    }
    const refunded = await failOrderWithRefund(order, created.errorMessage ?? "unknown adapter error");
    return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
  }

  // Confirmed lock loss after the panel write: persisting could interleave
  // with a new lock owner. Leave the order PROVISIONING - startup
  // reconciliation adopts/refunds it from panel truth under the same lock.
  if (lock !== null && lock.isLost()) {
    logger.error("provisioning: lock ownership lost after panel call - deferring to reconciliation", {
      orderId: order.id,
      panelId: panel.id,
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }

  // The panel account now exists (or was recovered). From here on the user
  // must end up with a recorded Service OR a refund - never a silent charge.
  const persistService = (): Promise<Service> =>
    prisma.$transaction(async (tx) => {
      // Last-line duplicate guard (username is also unique per order).
      const duplicate = await tx.service.findFirst({ where: { orderId: order.id } });
      if (duplicate !== null) {
        return duplicate;
      }
      const row = await tx.service.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          panelId: panel.id,
          productId: product.id,
          panelType: panel.type,
          username: created.username ?? username,
          note,
          status: ServiceStatus.ACTIVE,
          serviceLocation: product.serviceLocation ?? ServiceLocation.MULTI_LOCATION,
          productNameSnapshot: order.productNameSnapshot ?? product.name,
          panelNameSnapshot: order.panelNameSnapshot ?? panel.name,
          volumeBytes: volumeBytes ?? 0n,
          usedBytes: 0n,
          remainingBytes: volumeBytes ?? 0n,
          durationDays,
          startsAt: now,
          expiresAt,
          subscriptionUrl: created.subscriptionUrl ?? null,
          subscriptionToken: created.subscriptionToken ?? null,
          ...(created.configLinks !== undefined ? { configLinks: created.configLinks } : {}),
          // Remote client identifiers (XUI): needed for later sync/cleanup.
          remoteClientId: created.remoteClientId ?? null,
          ...(created.remoteInboundIds !== undefined
            ? { remoteInboundIds: created.remoteInboundIds }
            : {}),
          ...(created.remoteMetadata !== undefined
            ? { remoteMetadata: created.remoteMetadata as object }
            : {}),
        },
      });
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PROVISIONING },
        data: { status: OrderStatus.COMPLETED, completedAt: now },
      });
      return row;
    });

  let service: Service;
  try {
    service = await persistService();
  } catch (err) {
    // Phase 9.1: panel success + DB failure must never strand the user.
    logger.error("provisioning persistence failed after panel success", {
      orderId: order.id,
      panelId: panel.id,
      username: created.username ?? username,
      error: errorMessage(err),
    });
    return recoverOrRefundAfterPanelSuccess(order, panel, created.username ?? username, persistService);
  }
  logger.info("provisioning succeeded", {
    orderId: order.id,
    serviceId: service.id,
    panelId: panel.id,
  });
  return { ok: true, service, alreadyExisted: false };
}

/** Completes an order that still sits in the provisioning pipeline. */
async function completeOrder(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING] } },
    data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
  });
}

/**
 * Phase 9.1: recovery ladder for "panel account exists but DB persistence
 * threw". In order:
 *
 *   1. a Service for this order already exists -> complete the order, done;
 *   2. a Service with this username exists and belongs to this user (orderId
 *      null or this order) -> link/repair it, complete the order, done -
 *      another user's service is never touched;
 *   3. otherwise retry the identical persistence transaction ONCE;
 *   4. still failing -> Order FAILED + wallet refund (panel delete/revoke is
 *      not implemented yet, so the refund is the safe business outcome; the
 *      possibly-orphaned panel account is logged for manual cleanup).
 *
 * The order is never left stuck in PROVISIONING without a service or refund.
 */
async function recoverOrRefundAfterPanelSuccess(
  order: OrderForProvisioning,
  panel: Panel,
  username: string,
  persistService: () => Promise<Service>,
): Promise<ProvisionOutcome> {
  let usernameTakenByOtherUser = false;
  try {
    const byOrder = await prisma.service.findFirst({ where: { orderId: order.id } });
    if (byOrder !== null) {
      await completeOrder(order.id);
      return { ok: true, service: byOrder, alreadyExisted: true };
    }
    const byUsername = await prisma.service.findUnique({ where: { username } });
    if (byUsername !== null) {
      if (
        byUsername.userId === order.userId &&
        (byUsername.orderId === null || byUsername.orderId === order.id)
      ) {
        const repaired =
          byUsername.orderId === null
            ? await prisma.service.update({
                where: { id: byUsername.id },
                data: { orderId: order.id },
              })
            : byUsername;
        await completeOrder(order.id);
        logger.info("provisioning recovery: existing service repaired", {
          orderId: order.id,
          serviceId: repaired.id,
        });
        return { ok: true, service: repaired, alreadyExisted: true };
      }
      // Foreign service owns this username - never touch it, and a retry
      // would hit the same unique constraint, so skip straight to refund.
      usernameTakenByOtherUser = true;
    }
    if (!usernameTakenByOtherUser) {
      // One retry of the identical transaction (covers transient DB errors).
      const service = await persistService();
      logger.info("provisioning persistence retry succeeded", {
        orderId: order.id,
        serviceId: service.id,
      });
      return { ok: true, service, alreadyExisted: false };
    }
  } catch (err) {
    logger.error("provisioning recovery attempt failed", {
      orderId: order.id,
      error: errorMessage(err),
    });
  }

  // Refund is the safe outcome; the panel account may be orphaned until an
  // admin cleans it up manually (delete/revoke arrives in a later phase).
  logger.warn("possible orphan panel account - manual cleanup may be needed", {
    orderId: order.id,
    panelId: panel.id,
    username,
  });
  const refunded = await failOrderWithRefund(
    order,
    "service persistence failed after panel success",
  );
  return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
}

/**
 * Provisions up to `limit` of the oldest PAID SERVICE_PURCHASE orders.
 * Foundation for a future worker; nothing schedules it automatically yet.
 */
export async function provisionNextPaidOrders(
  limit: number,
): Promise<Array<{ orderId: string; outcome: ProvisionOutcome }>> {
  const orders = await prisma.order.findMany({
    where: { status: OrderStatus.PAID, type: OrderType.SERVICE_PURCHASE },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 50)),
  });
  const results: Array<{ orderId: string; outcome: ProvisionOutcome }> = [];
  for (const order of orders) {
    results.push({ orderId: order.id, outcome: await provisionPaidOrder(order.id) });
  }
  return results;
}

const MAX_CONFIG_LINKS_SHOWN = 10;

/** HTML service-info message for the user after successful provisioning. */
export function buildServiceInfoMessage(service: Service): string {
  const gb = service.volumeBytes > 0n ? Number(service.volumeBytes / (1024n * 1024n * 1024n)) : 0;
  const lines = [
    "سرویس شما با موفقیت ساخته شد ✅",
    "",
    `نام سرویس: ${escapeHtml(service.productNameSnapshot ?? "-")}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `حجم: ${service.volumeBytes > 0n ? `${gb} گیگابایت` : "نامحدود"}`,
    `مدت: ${service.durationDays > 0 ? `${service.durationDays} روز` : "نامحدود"}`,
  ];
  if (service.expiresAt !== null) {
    lines.push(`تاریخ انقضا: ${service.expiresAt.toISOString().slice(0, 10)}`);
  }
  if (service.subscriptionUrl !== null) {
    lines.push("", "لینک اشتراک:", `<code>${escapeHtml(service.subscriptionUrl)}</code>`);
  }
  const links = Array.isArray(service.configLinks)
    ? service.configLinks.filter((l): l is string => typeof l === "string" && l !== "")
    : [];
  if (links.length > 0) {
    lines.push("", "کانفیگ‌ها:");
    for (const link of links.slice(0, MAX_CONFIG_LINKS_SHOWN)) {
      lines.push(`<code>${escapeHtml(link)}</code>`);
    }
    if (links.length > MAX_CONFIG_LINKS_SHOWN) {
      lines.push(`(+${links.length - MAX_CONFIG_LINKS_SHOWN} کانفیگ دیگر)`);
    }
  }
  if (service.subscriptionUrl === null && links.length === 0) {
    lines.push("", "اطلاعات اتصال کامل از پنل دریافت نشد؛ لطفاً با پشتیبانی تماس بگیرید.");
  }
  return lines.join("\n");
}
