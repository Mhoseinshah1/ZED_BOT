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
import { type AddServiceTimeResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { ExtraTimeDraft } from "../core/session.js";
import { groupMatches } from "./catalog.service.js";
import { buildProductSnapshot, checkoutExpiryMinutes } from "./checkout.service.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  panelOperationAvailable,
  panelTypesSupporting,
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_OPERATION_TEXT,
} from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";
import { failOrderWithRefund, type OrderForProvisioning } from "./provisioning.service.js";
import { markTrialConversion } from "./trial-conversion.service.js";
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
// Extra time (Phase 17): extends the expiry of an EXISTING service. The
// existing panel account + existing Service row are updated in place - never
// a new Service. Browsing/pre-invoice writes nothing; card-to-card creates
// the PENDING checkout on continue, the wallet path settles atomically.
//
// Apply method (the only one): ADD_PURCHASED_DAYS_TO_CURRENT_EXPIRY - the
// new expiry = (current expiry while still in the future, else now) +
// purchased days. Volume and usage are UNTOUCHED (no reset); a package's
// volumeGb, if any, is deliberately ignored here. Services that never
// expire (expiresAt null) are excluded - adding days would DOWNGRADE them
// to a finite expiry.
//
// Failure after payment = Order FAILED + the shared idempotent wallet
// refund. The user is never left charged without applied time or a refund.
// =============================================================================

export const EXTRA_TIME_EVENT_TYPE = "EXTRA_TIME_APPLIED";

export const EXTRA_TIME_FAILED_USER_TEXT =
  "پرداخت زمان اضافه شما تایید شد ✅\n" +
  "اما افزایش زمان سرویس با خطا مواجه شد.\n" +
  "مبلغ پرداختی به کیف پول شما برگشت داده شد.";

export const UNLIMITED_TIME_TEXT =
  "این سرویس زمان نامحدود دارد و نیاز به خرید زمان اضافه ندارد.";

export const EXTRA_TIME_PAGE_SIZE = 5;

const DAY_MS = 86_400_000;

// --- eligibility + browsing (read-only) ---------------------------------------------

/** Eligible: owned, ACTIVE/EXPIRED/LIMITED/DISABLED, finite expiry, panel ACTIVE. */
function eligibleWhere(userId: string): Prisma.ServiceWhereInput {
  return {
    userId,
    deletedAt: null,
    status: {
      in: [
        ServiceStatus.ACTIVE,
        ServiceStatus.EXPIRED,
        ServiceStatus.LIMITED,
        ServiceStatus.DISABLED,
      ],
    },
    expiresAt: { not: null },
    // Capability model: services on panels whose adapter cannot add time
    // (XUI) are never offered extra time - blocked before payment.
    panel: { status: PanelStatus.ACTIVE, type: { in: panelTypesSupporting("addTime") } },
  };
}

export interface EligibleTimeServicePage {
  services: Service[];
  page: number;
  pages: number;
  total: number;
}

export async function listExtraTimeServices(
  userId: string,
  page: number,
): Promise<EligibleTimeServicePage> {
  // The XUI remote-model gate (GLOBAL_CLIENT only) needs stored metadata, so
  // filtering happens in memory; per-user service counts are small.
  const rows = await prisma.service.findMany({
    where: eligibleWhere(userId),
    orderBy: { createdAt: "desc" },
  });
  const eligible = rows.filter((s) => serviceSupportsGlobalLifecycle(s));
  const total = eligible.length;
  const pages = Math.max(1, Math.ceil(total / EXTRA_TIME_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const services = eligible.slice(
    (safePage - 1) * EXTRA_TIME_PAGE_SIZE,
    safePage * EXTRA_TIME_PAGE_SIZE,
  );
  return { services, page: safePage, pages, total };
}

/** Owner-scoped short-id resolution; ineligible/foreign/unknown -> null. */
export async function getExtraTimeServiceByShortId(
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
  const match = matches.length === 1 ? matches[0] : null;
  // Legacy per-inbound XUI services never take extra time through the
  // global-client endpoints - same null contract as any other ineligibility.
  return match !== null && serviceSupportsGlobalLifecycle(match) ? match : null;
}

/**
 * Extra-time packages: active same-panel SERVICE_PRODUCTs with
 * durationDays > 0 and priceToman > 0 in an active category, visible to the
 * user's group. (No explicit package kind exists yet - Phase 17 treats
 * these as the extra-time packages; a package's volumeGb, if set, is
 * IGNORED by the time calculation. A future `product.intent` migration can
 * refine this.) Ordered by duration, then price/displayOrder.
 */
export async function extraTimePackages(
  group: UserGroup,
  panelId: string,
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      durationDays: { gt: 0 },
      priceToman: { gt: 0 },
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [{ durationDays: "asc" }, { priceToman: "asc" }, { displayOrder: "asc" }],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/** Re-check one package against the target service and user group. */
export function isExtraTimePackageValid(
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
    panelOperationAvailable(product.panel, "addTime") &&
    // Remote-model gate: only GLOBAL_CLIENT XUI services take extra time.
    serviceSupportsGlobalLifecycle(service) &&
    (product.durationDays ?? 0) > 0 &&
    product.priceToman > 0 &&
    groupMatches(product.displayGroups, group)
  );
}

// --- checkout (card-to-card path) ------------------------------------------------------

/** Extra-time checkout snapshot (also used by the wallet payment). */
export function buildExtraTimeSnapshot(
  product: ProductWithRelations,
  service: Service,
  draft: ExtraTimeDraft,
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
    flowType: "EXTRA_TIME",
    extraTimeTargetServiceId: service.id,
    extraTimeTargetUsername: service.username,
    extraTimeDays: product.durationDays ?? 0,
    extraTimeTargetExpiresAt: service.expiresAt?.toISOString() ?? null,
  };
}

/** The ONLY write of the card-to-card browse flow: a PENDING EXTRA_TIME checkout. */
export async function createExtraTimeCheckout(
  user: User,
  service: Service,
  product: ProductWithRelations,
  draft: ExtraTimeDraft,
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
      orderType: "EXTRA_TIME",
      productSnapshot: buildExtraTimeSnapshot(product, service, draft),
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

/** ADD_PURCHASED_DAYS_TO_CURRENT_EXPIRY: extends from the future expiry, else from now. */
export function calculateExtraTime(
  service: Pick<Service, "expiresAt">,
  purchasedDays: number,
  now: Date = new Date(),
): Date {
  const base =
    service.expiresAt !== null && service.expiresAt.getTime() > now.getTime()
      ? service.expiresAt
      : now;
  return new Date(base.getTime() + purchasedDays * DAY_MS);
}

export type ExtraTimeOutcome =
  | {
      ok: true;
      service: Service;
      addedDays: number;
      alreadyApplied: boolean;
      trialConverted?: boolean;
    }
  | { ok: false; refunded: boolean; error: string };

async function findAppliedExtraTime(orderId: string) {
  return prisma.serviceEventLog.findFirst({
    where: { eventType: EXTRA_TIME_EVENT_TYPE, metadata: { path: ["orderId"], equals: orderId } },
  });
}

/**
 * Executes one PAID EXTRA_TIME order: updates the EXISTING panel account and
 * EXISTING Service in place. Safe to call repeatedly (event-log guard +
 * PAID->PROVISIONING claim). Failure = FAILED + shared wallet refund.
 *
 * CONCURRENCY: the whole critical sequence (fresh reads -> expiry
 * calculation -> panel write -> persistence) runs under the per-service
 * distributed lock, so two different orders on one service can never both
 * extend from the same starting expiry and lose one paid mutation.
 * Contention or an unavailable lock backend leaves the order PAID and
 * retryable - no panel call, no refund, no event log.
 */
export async function executeExtraTimeOrder(orderId: string): Promise<ExtraTimeOutcome> {
  // Pre-lock reads touch only immutable order fields (type, serviceId).
  const head = await prisma.order.findUnique({
    where: { id: orderId },
    select: { type: true, serviceId: true },
  });
  if (head === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (head.type !== OrderType.EXTRA_TIME) {
    return { ok: false, refunded: false, error: "این سفارش از نوع زمان اضافه نیست." };
  }
  if (head.serviceId === null) {
    // No shared service state to protect - the body refunds via its
    // existing service-missing dead end.
    return executeExtraTimeOrderUnlocked(orderId, null);
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
    return await executeExtraTimeOrderUnlocked(orderId, acquisition.lock);
  } finally {
    await acquisition.lock.release();
  }
}

async function executeExtraTimeOrderUnlocked(
  orderId: string,
  lock: ServiceLock | null,
): Promise<ExtraTimeOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } } },
  })) as OrderForProvisioning | null;
  if (order === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (order.type !== OrderType.EXTRA_TIME) {
    return { ok: false, refunded: false, error: "این سفارش از نوع زمان اضافه نیست." };
  }

  const purchasedDays = order.durationDaysSnapshot ?? order.product?.durationDays ?? 0;

  // Idempotency: an already-applied order wins over everything.
  const applied = await findAppliedExtraTime(order.id);
  if (applied !== null) {
    if (order.status !== OrderStatus.COMPLETED) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
    }
    const service = await prisma.service.findUnique({ where: { id: applied.serviceId } });
    if (service !== null) {
      return { ok: true, service, addedDays: purchasedDays, alreadyApplied: true };
    }
  }

  if (order.status === OrderStatus.PROVISIONING) {
    return { ok: false, refunded: false, error: "افزایش زمان این سفارش هم‌اکنون در حال انجام است." };
  }
  if (order.status === OrderStatus.FAILED) {
    return { ok: false, refunded: false, error: "این سفارش قبلاً ناموفق شده است." };
  }
  if (order.status !== OrderStatus.PAID) {
    return { ok: false, refunded: false, error: "وضعیت سفارش برای افزایش زمان معتبر نیست." };
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
    const refunded = await failOrderWithRefund(order, "extra-time target service missing");
    return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
  }
  if (!serviceSupportsGlobalLifecycle(service)) {
    // Legacy per-inbound XUI services are NEVER mutated through the
    // global-client endpoints and never silently migrated - a paid order
    // that slipped past the pre-payment gates dead-ends into a refund.
    const refunded = await failOrderWithRefund(
      order,
      "xui legacy per-inbound service - global lifecycle unsupported",
    );
    return { ok: false, refunded, error: XUI_LEGACY_OPERATION_TEXT };
  }
  if (service.expiresAt === null) {
    const refunded = await failOrderWithRefund(order, "target service never expires");
    return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
  }
  if (purchasedDays <= 0) {
    const refunded = await failOrderWithRefund(order, "purchased days is zero");
    return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
  }
  const panel = service.panel;
  if (panel.status !== "ACTIVE") {
    const refunded = await failOrderWithRefund(order, `panel status is ${panel.status}`);
    return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
  }

  // Claim: only one caller wins PAID -> PROVISIONING.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: OrderStatus.PAID },
    data: { status: OrderStatus.PROVISIONING },
  });
  if (claimed.count === 0) {
    return { ok: false, refunded: false, error: "سفارش توسط فرایند دیگری در حال پردازش است." };
  }
  logger.info("extra time started", {
    orderId: order.id,
    serviceId: service.id,
    panelId: panel.id,
    purchasedDays,
  });

  const now = new Date();
  const oldExpiresAt = service.expiresAt;
  const newExpiresAt = calculateExtraTime(service, purchasedDays, now);

  let panelResult: AddServiceTimeResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    panelResult = await adapter.addServiceTime({
      username: service.username,
      // Quota is passed through UNCHANGED (null = unlimited volume).
      totalBytes: service.volumeBytes > 0n ? service.volumeBytes : null,
      expiresAt: newExpiresAt,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    panelResult = { ok: false, errorMessage: errorMessage(err) };
  }

  if (!panelResult.ok && panelResult.uncertain === true) {
    // The panel outcome is UNKNOWN (timeout mid-update / unverifiable
    // post-state). NEVER refund on uncertainty: the order stays
    // PROVISIONING and startup reconciliation - which compares the exact
    // expected post-state under the same lock - completes or refunds it on
    // positive proof.
    logger.error("extra time panel outcome unknown - deferring to reconciliation", {
      orderId: order.id,
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }
  if (!panelResult.ok) {
    logger.warn("extra time panel update failed", {
      orderId: order.id,
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    const refunded = await failOrderWithRefund(
      order,
      panelResult.errorMessage ?? "unknown adapter error",
    );
    return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
  }

  // Confirmed lock loss after the panel write: persisting could interleave
  // with a new lock owner. Leave the order PROVISIONING - startup
  // reconciliation resolves it from panel truth under the lock.
  if (lock !== null && lock.isLost()) {
    logger.error("extra time: lock ownership lost after panel call - deferring to reconciliation", {
      orderId: order.id,
      serviceId: service.id,
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }

  // Status: expired/disabled services come back; exhausted finite traffic
  // stays LIMITED (time never resets usage).
  const nextStatus =
    service.volumeBytes > 0n && service.remainingBytes <= 0n
      ? ServiceStatus.LIMITED
      : ServiceStatus.ACTIVE;
  const finalExpiresAt =
    panelResult.expiresAt !== undefined && panelResult.expiresAt !== null
      ? panelResult.expiresAt
      : newExpiresAt;

  // Persist with one retry (Phase 9.1 rule); still failing -> FAILED + refund.
  const persist = (): Promise<{ service: Service; trialConverted: boolean }> =>
    prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateInput = {
        status: nextStatus,
        expiresAt: finalExpiresAt,
        durationDays: Math.max(
          0,
          Math.ceil((finalExpiresAt.getTime() - service.startsAt.getTime()) / DAY_MS),
        ),
        lastSubscriptionUpdateAt: now,
      };
      // Volume/usage stay untouched unless the panel reported values.
      if (panelResult.usedBytes !== undefined) {
        data.usedBytes = panelResult.usedBytes;
      }
      if (panelResult.remainingBytes !== undefined && panelResult.remainingBytes !== null) {
        data.remainingBytes = panelResult.remainingBytes;
      }
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
          eventType: EXTRA_TIME_EVENT_TYPE,
          metadata: {
            orderId: order.id,
            addedDays: purchasedDays,
            oldExpiresAt: oldExpiresAt.toISOString(),
            newExpiresAt: finalExpiresAt.toISOString(),
          },
        },
      });
      // Trial-lifecycle phase: the first verified paid operation converts
      // the trial - same transaction as the completion, CAS-exactly-once.
      const trialConverted = await markTrialConversion(tx, service, order.id, now);
      return { service: updated, trialConverted };
    });

  let persisted: { service: Service; trialConverted: boolean };
  try {
    persisted = await persist();
  } catch (err) {
    logger.error("extra time persistence failed after panel success", {
      orderId: order.id,
      serviceId: service.id,
      error: errorMessage(err),
    });
    try {
      persisted = await persist();
    } catch (retryErr) {
      logger.error("extra time persistence retry failed", {
        orderId: order.id,
        error: errorMessage(retryErr),
      });
      logger.warn("possible unrecorded panel expiry extension - manual review may be needed", {
        orderId: order.id,
        serviceId: service.id,
        panelId: panel.id,
      });
      const refunded = await failOrderWithRefund(
        order,
        "extra-time persistence failed after panel success",
      );
      return { ok: false, refunded, error: "افزایش زمان سرویس ناموفق بود." };
    }
  }
  logger.info("extra time succeeded", {
    orderId: order.id,
    serviceId: persisted.service.id,
    panelId: panel.id,
    purchasedDays,
  });
  return {
    ok: true,
    service: persisted.service,
    addedDays: purchasedDays,
    alreadyApplied: false,
    trialConverted: persisted.trialConverted,
  };
}

/** HTML success message for the user after applied extra time. */
export function buildExtraTimeSuccessMessage(service: Service, addedDays: number): string {
  const lines = [
    "زمان اضافه با موفقیت به سرویس شما اضافه شد ✅",
    "",
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `زمان اضافه‌شده: ${addedDays} روز`,
    `تاریخ انقضای جدید: ${
      service.expiresAt === null ? "-" : service.expiresAt.toISOString().slice(0, 10)
    }`,
  ];
  if (service.subscriptionUrl !== null && service.subscriptionUrl !== "") {
    lines.push("", "لینک اشتراک:", `<code>${escapeHtml(service.subscriptionUrl)}</code>`);
  }
  return lines.join("\n");
}
