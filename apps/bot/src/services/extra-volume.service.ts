import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PanelStatus,
  prisma,
  ServiceStatus,
  type CheckoutSession,
  type Prisma,
  type Service,
  type User,
  type UserGroup,
} from "@zedbot/database";
import { type AddServiceVolumeResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { ExtraVolumeDraft } from "../core/session.js";
import { groupMatches } from "./catalog.service.js";
import { buildProductSnapshot, checkoutExpiryMinutes } from "./checkout.service.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import { panelOperationAvailable, panelTypesSupporting } from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";
import { failOrderWithRefund, type OrderForProvisioning } from "./provisioning.service.js";
import {
  acquireServiceLock,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_LOST_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceOperationLockKey,
  type ServiceLock,
} from "./service-lock.service.js";
import { escapeHtml } from "../utils/html.js";

// =============================================================================
// Extra volume (Phase 16): adds purchased volume to an EXISTING finite-volume
// service. Browsing/pre-invoice writes nothing; the PENDING CheckoutSession
// (orderType EXTRA_VOLUME) appears on card-to-card continue, and the wallet
// path settles atomically via wallet-payment.service. Execution updates the
// EXISTING panel account + EXISTING Service row - never a new Service.
//
// Apply method (the only one): ADD_PURCHASED_VOLUME_TO_CURRENT_REMAINING -
// new total = max(current remaining, 0) + purchased bytes, usage resets to
// zero, expiry/duration/startsAt unchanged. Meaningful only for finite
// volume, so unlimited services are excluded from eligibility (and rejected
// on stale buttons).
//
// Failure after payment = Order FAILED + the shared idempotent wallet
// refund. The user is never left charged without applied volume or refund.
// =============================================================================

export const EXTRA_VOLUME_EVENT_TYPE = "EXTRA_VOLUME_APPLIED";

export const EXTRA_VOLUME_FAILED_USER_TEXT =
  "پرداخت حجم اضافه شما تایید شد ✅\n" +
  "اما افزایش حجم سرویس با خطا مواجه شد.\n" +
  "مبلغ پرداختی به کیف پول شما برگشت داده شد.";

export const UNLIMITED_SERVICE_TEXT =
  "این سرویس حجم نامحدود دارد و نیاز به خرید حجم اضافه ندارد.";

export const EXTRA_VOLUME_PAGE_SIZE = 5;

const GIB = 1024n * 1024n * 1024n;

// --- eligibility + browsing (read-only) ---------------------------------------------

/** Eligible: owned, ACTIVE/LIMITED, finite volume, panel ACTIVE. */
function eligibleWhere(userId: string): Prisma.ServiceWhereInput {
  return {
    userId,
    deletedAt: null,
    status: { in: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED] },
    volumeBytes: { gt: 0n },
    // Capability model: services on panels whose adapter cannot add volume
    // (XUI) are never offered extra volume - blocked before payment.
    panel: { status: PanelStatus.ACTIVE, type: { in: panelTypesSupporting("addVolume") } },
  };
}

export interface EligibleServicePage {
  services: Service[];
  page: number;
  pages: number;
  total: number;
}

export async function listExtraVolumeServices(
  userId: string,
  page: number,
): Promise<EligibleServicePage> {
  const where = eligibleWhere(userId);
  const total = await prisma.service.count({ where });
  const pages = Math.max(1, Math.ceil(total / EXTRA_VOLUME_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const services = await prisma.service.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * EXTRA_VOLUME_PAGE_SIZE,
    take: EXTRA_VOLUME_PAGE_SIZE,
  });
  return { services, page: safePage, pages, total };
}

/** Owner-scoped short-id resolution; ineligible/foreign/unknown -> null. */
export async function getExtraVolumeServiceByShortId(
  shortId: string,
  userId: string,
): Promise<Service | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: { id: { startsWith: shortId }, ...eligibleWhere(userId) },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Extra-volume packages: active same-panel SERVICE_PRODUCTs with
 * volumeGb > 0 and priceToman > 0 in an active category, visible to the
 * user's group. (The product model has no explicit package kind yet - Phase
 * 16 treats these as the extra-volume packages; a future `product.intent`
 * migration can refine this.) Ordered by volume, then price/displayOrder.
 */
export async function extraVolumePackages(
  group: UserGroup,
  panelId: string,
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      volumeGb: { gt: 0 },
      priceToman: { gt: 0 },
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [{ volumeGb: "asc" }, { priceToman: "asc" }, { displayOrder: "asc" }],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/** Re-check one package against the target service and user group. */
export function isExtraVolumePackageValid(
  product: ProductWithRelations,
  service: Service,
  group: UserGroup,
): boolean {
  return (
    product.type === "SERVICE_PRODUCT" &&
    product.isActive &&
    product.category.isActive &&
    product.panelId === service.panelId &&
    product.panel !== null &&
    panelOperationAvailable(product.panel, "addVolume") &&
    (product.volumeGb ?? 0) > 0 &&
    product.priceToman > 0 &&
    groupMatches(product.displayGroups, group)
  );
}

// --- checkout (card-to-card path) ------------------------------------------------------

/** Extra-volume checkout snapshot (also used by the wallet payment). */
export function buildExtraVolumeSnapshot(
  product: ProductWithRelations,
  service: Service,
  draft: ExtraVolumeDraft,
): Prisma.InputJsonObject {
  const base = buildProductSnapshot(product, {
    productId: product.id,
    categoryId: product.categoryId,
    panelId: product.panelId ?? undefined,
    flowType: product.type,
    discountCode: draft.discountCode,
    discountCodeId: draft.discountCodeId,
    originalPriceToman: draft.originalPriceToman,
    discountAmountToman: draft.discountAmountToman,
    finalPriceToman: draft.finalPriceToman,
  });
  return {
    ...base,
    flowType: "EXTRA_VOLUME",
    extraVolumeTargetServiceId: service.id,
    extraVolumeTargetUsername: service.username,
    extraVolumeGb: product.volumeGb ?? 0,
    extraVolumeTargetRemainingBytes: service.remainingBytes.toString(),
    extraVolumeTargetVolumeBytes: service.volumeBytes.toString(),
  };
}

/** The ONLY write of the card-to-card browse flow: a PENDING EXTRA_VOLUME checkout. */
export async function createExtraVolumeCheckout(
  user: User,
  service: Service,
  product: ProductWithRelations,
  draft: ExtraVolumeDraft,
): Promise<CheckoutSession> {
  const minutes = await checkoutExpiryMinutes();
  await prisma.checkoutSession.updateMany({
    where: { userId: user.id, serviceId: service.id, status: CheckoutStatus.PENDING },
    data: { status: CheckoutStatus.CANCELLED },
  });
  return prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "ORDER_PAYMENT",
      productId: product.id,
      serviceId: service.id,
      orderType: "EXTRA_VOLUME",
      productSnapshot: buildExtraVolumeSnapshot(product, service, draft),
      originalPriceToman: draft.originalPriceToman,
      discountAmountToman: draft.discountAmountToman,
      finalPriceToman: draft.finalPriceToman,
      discountCodeId: draft.discountCodeId ?? null,
      status: CheckoutStatus.PENDING,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    },
  });
}

// --- execution (after payment) -------------------------------------------------------------

export interface ExtraVolumeComputation {
  /** New total quota in bytes. */
  totalBytes: bigint;
  /** New remaining quota (= total under this method). */
  remainingBytes: bigint;
}

/** ADD_PURCHASED_VOLUME_TO_CURRENT_REMAINING (usage resets to zero). */
export function calculateExtraVolume(
  service: Pick<Service, "remainingBytes">,
  volumeGb: number,
): ExtraVolumeComputation {
  const purchased = BigInt(volumeGb) * GIB;
  const currentRemaining = service.remainingBytes > 0n ? service.remainingBytes : 0n;
  const total = currentRemaining + purchased;
  return { totalBytes: total, remainingBytes: total };
}

export type ExtraVolumeOutcome =
  | { ok: true; service: Service; addedVolumeGb: number; alreadyApplied: boolean }
  | { ok: false; refunded: boolean; error: string };

async function findAppliedExtraVolume(orderId: string) {
  return prisma.serviceEventLog.findFirst({
    where: { eventType: EXTRA_VOLUME_EVENT_TYPE, metadata: { path: ["orderId"], equals: orderId } },
  });
}

/**
 * Executes one PAID EXTRA_VOLUME order: updates the EXISTING panel account
 * and EXISTING Service in place. Safe to call repeatedly (event-log guard +
 * PAID->PROVISIONING claim). Failure = FAILED + shared wallet refund.
 *
 * CONCURRENCY: the whole critical sequence (fresh reads -> quota calculation
 * -> panel write -> persistence) runs under the per-service distributed
 * lock, so two different orders on one service can never both compute from
 * the same starting quota and lose one paid mutation. Contention or an
 * unavailable lock backend leaves the order PAID and retryable - no panel
 * call, no refund, no event log.
 */
export async function executeExtraVolumeOrder(orderId: string): Promise<ExtraVolumeOutcome> {
  // Pre-lock reads touch only immutable order fields (type, serviceId).
  const head = await prisma.order.findUnique({
    where: { id: orderId },
    select: { type: true, serviceId: true },
  });
  if (head === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (head.type !== OrderType.EXTRA_VOLUME) {
    return { ok: false, refunded: false, error: "این سفارش از نوع حجم اضافه نیست." };
  }
  if (head.serviceId === null) {
    // No shared service state to protect - the body refunds via its
    // existing service-missing dead end.
    return executeExtraVolumeOrderUnlocked(orderId, null);
  }
  const acquisition = await acquireServiceLock(serviceOperationLockKey(head.serviceId));
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
    return await executeExtraVolumeOrderUnlocked(orderId, acquisition.lock);
  } finally {
    await acquisition.lock.release();
  }
}

async function executeExtraVolumeOrderUnlocked(
  orderId: string,
  lock: ServiceLock | null,
): Promise<ExtraVolumeOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } } },
  })) as OrderForProvisioning | null;
  if (order === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (order.type !== OrderType.EXTRA_VOLUME) {
    return { ok: false, refunded: false, error: "این سفارش از نوع حجم اضافه نیست." };
  }

  const volumeGb = order.volumeGbSnapshot ?? order.product?.volumeGb ?? 0;

  // Idempotency: an already-applied order wins over everything.
  const applied = await findAppliedExtraVolume(order.id);
  if (applied !== null) {
    if (order.status !== OrderStatus.COMPLETED) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
    }
    const service = await prisma.service.findUnique({ where: { id: applied.serviceId } });
    if (service !== null) {
      return { ok: true, service, addedVolumeGb: volumeGb, alreadyApplied: true };
    }
  }

  if (order.status === OrderStatus.PROVISIONING) {
    return { ok: false, refunded: false, error: "افزایش حجم این سفارش هم‌اکنون در حال انجام است." };
  }
  if (order.status === OrderStatus.FAILED) {
    return { ok: false, refunded: false, error: "این سفارش قبلاً ناموفق شده است." };
  }
  if (order.status !== OrderStatus.PAID) {
    return { ok: false, refunded: false, error: "وضعیت سفارش برای افزایش حجم معتبر نیست." };
  }

  // Target service; any dead end after payment refunds.
  const service =
    order.serviceId === null
      ? null
      : await prisma.service.findFirst({
          where: {
            id: order.serviceId,
            userId: order.userId,
            deletedAt: null,
            status: { not: ServiceStatus.DELETED },
          },
          include: { panel: true },
        });
  if (service === null) {
    const refunded = await failOrderWithRefund(order, "extra-volume target service missing");
    return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
  }
  if (service.volumeBytes <= 0n) {
    const refunded = await failOrderWithRefund(order, "target service has unlimited volume");
    return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
  }
  if (volumeGb <= 0) {
    const refunded = await failOrderWithRefund(order, "purchased volume is zero");
    return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
  }
  const panel = service.panel;
  if (panel.status !== "ACTIVE") {
    const refunded = await failOrderWithRefund(order, `panel status is ${panel.status}`);
    return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
  }

  // Claim: only one caller wins PAID -> PROVISIONING.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: OrderStatus.PAID },
    data: { status: OrderStatus.PROVISIONING },
  });
  if (claimed.count === 0) {
    return { ok: false, refunded: false, error: "سفارش توسط فرایند دیگری در حال پردازش است." };
  }
  logger.info("extra volume started", {
    orderId: order.id,
    serviceId: service.id,
    panelId: panel.id,
    volumeGb,
  });

  const now = new Date();
  const computed = calculateExtraVolume(service, volumeGb);

  let panelResult: AddServiceVolumeResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    panelResult = await adapter.addServiceVolume({
      username: service.username,
      totalBytes: computed.totalBytes,
      // Expiry is passed through UNCHANGED - extra volume never extends time.
      expiresAt: service.expiresAt,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    panelResult = { ok: false, errorMessage: errorMessage(err) };
  }

  if (!panelResult.ok) {
    logger.warn("extra volume panel update failed", {
      orderId: order.id,
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    const refunded = await failOrderWithRefund(
      order,
      panelResult.errorMessage ?? "unknown adapter error",
    );
    return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
  }

  // Confirmed lock loss after the panel write: persisting could interleave
  // with a new lock owner. Leave the order PROVISIONING - startup
  // reconciliation resolves it from panel truth under the lock.
  if (lock !== null && lock.isLost()) {
    logger.error("extra volume: lock ownership lost after panel call - deferring to reconciliation", {
      orderId: order.id,
      serviceId: service.id,
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }

  // Persist with one retry (Phase 9.1 rule); still failing -> FAILED + refund.
  const persist = (): Promise<Service> =>
    prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateInput = {
        status: ServiceStatus.ACTIVE,
        volumeBytes: computed.totalBytes,
        usedBytes: panelResult.usedBytes ?? 0n,
        remainingBytes: panelResult.remainingBytes ?? computed.remainingBytes,
        lastSubscriptionUpdateAt: now,
      };
      if (panelResult.subscriptionUrl !== undefined && panelResult.subscriptionUrl !== "") {
        data.subscriptionUrl = panelResult.subscriptionUrl;
      }
      if (panelResult.configLinks !== undefined && panelResult.configLinks.length > 0) {
        data.configLinks = panelResult.configLinks;
      }
      const updated = await tx.service.update({ where: { id: service.id }, data });
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PROVISIONING },
        data: { status: OrderStatus.COMPLETED, completedAt: now },
      });
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: order.userId,
          panelId: panel.id,
          eventType: EXTRA_VOLUME_EVENT_TYPE,
          metadata: {
            orderId: order.id,
            addedVolumeGb: volumeGb,
            addedBytes: (BigInt(volumeGb) * GIB).toString(),
            totalBytes: computed.totalBytes.toString(),
          },
        },
      });
      return updated;
    });

  let updatedService: Service;
  try {
    updatedService = await persist();
  } catch (err) {
    logger.error("extra volume persistence failed after panel success", {
      orderId: order.id,
      serviceId: service.id,
      error: errorMessage(err),
    });
    try {
      updatedService = await persist();
    } catch (retryErr) {
      logger.error("extra volume persistence retry failed", {
        orderId: order.id,
        error: errorMessage(retryErr),
      });
      logger.warn("possible unrecorded panel volume increase - manual review may be needed", {
        orderId: order.id,
        serviceId: service.id,
        panelId: panel.id,
      });
      const refunded = await failOrderWithRefund(
        order,
        "extra-volume persistence failed after panel success",
      );
      return { ok: false, refunded, error: "افزایش حجم سرویس ناموفق بود." };
    }
  }
  logger.info("extra volume succeeded", {
    orderId: order.id,
    serviceId: updatedService.id,
    panelId: panel.id,
    volumeGb,
  });
  return { ok: true, service: updatedService, addedVolumeGb: volumeGb, alreadyApplied: false };
}

/** HTML success message for the user after applied extra volume. */
export function buildExtraVolumeSuccessMessage(service: Service, addedVolumeGb: number): string {
  const totalGb = Math.round((Number(service.volumeBytes) / Number(GIB)) * 100) / 100;
  const lines = [
    "حجم سرویس شما با موفقیت افزایش یافت ✅",
    "",
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `حجم اضافه‌شده: ${addedVolumeGb} گیگابایت`,
    `حجم جدید: ${totalGb} گیگابایت`,
    `انقضا: ${service.expiresAt === null ? "نامحدود" : service.expiresAt.toISOString().slice(0, 10)} (بدون تغییر)`,
  ];
  if (service.subscriptionUrl !== null && service.subscriptionUrl !== "") {
    lines.push("", "لینک اشتراک:", `<code>${escapeHtml(service.subscriptionUrl)}</code>`);
  }
  return lines.join("\n");
}
