import {
  OrderStatus,
  OrderType,
  prisma,
  ServiceStatus,
  type Prisma,
  type Service,
} from "@zedbot/database";
import { type RenewServiceAccountResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_OPERATION_TEXT,
} from "./panel-readiness.service.js";
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

// =============================================================================
// Service renewal execution (Phase 12): turns a PAID SERVICE_RENEWAL Order
// into an UPDATE of the existing panel account + existing Service row - a
// renewal NEVER creates a new Service. Failure = Order FAILED + wallet
// refund via the shared Phase 9 path. The user is never left charged
// without a renewal or a refund.
//
// Default (and only) method: ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD -
// the new quota equals previous remaining + purchased volume with usage
// reset to zero, and time extends from the current expiry (or now, if
// already expired). Admin-configurable renewal methods are a later phase.
//
// Idempotency: PAID -> PROVISIONING claim is a compare-and-set; a
// ServiceEventLog row (eventType RENEWAL_APPLIED, metadata.orderId) is
// written in the same transaction as the Service update and checked first,
// so a renewal can never be applied twice for one order.
// =============================================================================

export const RENEWAL_EVENT_TYPE = "RENEWAL_APPLIED";

/** Customer-facing failure/refund notice (never contains adapter errors). */
export const RENEWAL_FAILED_USER_TEXT =
  "پرداخت تمدید شما تایید شد ✅\n" +
  "اما تمدید سرویس با خطا مواجه شد.\n" +
  "مبلغ پرداختی به کیف پول شما برگشت داده شد.";

export interface RenewalComputation {
  /** New total quota in bytes; null = unlimited. */
  totalBytes: bigint | null;
  /** New remaining quota; null = unlimited. */
  remainingBytes: bigint | null;
  /** New expiry; null = never expires. */
  expiresAt: Date | null;
}

export type RenewalOutcome =
  | { ok: true; service: Service; alreadyApplied: boolean; trialConverted?: boolean }
  | { ok: false; refunded: boolean; error: string };

const GIB = 1024n * 1024n * 1024n;

/**
 * ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD:
 *   time   - base = current expiry while still in the future, otherwise now;
 *            plan days > 0 extend from that base; plan days = 0 keep the
 *            existing expiry (null stays null = unlimited).
 *   volume - plan 0 GB = unlimited; otherwise the new quota = previous
 *            remaining (0 when the service was unlimited or exhausted)
 *            + purchased bytes, and usage restarts at zero.
 */
export function calculateRenewal(
  service: Pick<Service, "expiresAt" | "volumeBytes" | "remainingBytes">,
  plan: { volumeGb: number; durationDays: number },
  now: Date = new Date(),
): RenewalComputation {
  let expiresAt: Date | null;
  if (plan.durationDays > 0) {
    const base =
      service.expiresAt !== null && service.expiresAt.getTime() > now.getTime()
        ? service.expiresAt
        : now;
    expiresAt = new Date(base.getTime() + plan.durationDays * 86_400_000);
  } else {
    expiresAt = service.expiresAt;
  }

  if (plan.volumeGb <= 0) {
    return { totalBytes: null, remainingBytes: null, expiresAt };
  }
  const purchased = BigInt(plan.volumeGb) * GIB;
  // Remaining only counts for previously-limited services; unlimited (0n
  // total) contributes 0 under this method.
  const currentRemaining =
    service.volumeBytes > 0n && service.remainingBytes > 0n ? service.remainingBytes : 0n;
  const total = currentRemaining + purchased;
  return { totalBytes: total, remainingBytes: total, expiresAt };
}

/** Days shown on the Service row after renewal (from startsAt to new expiry). */
function renewedDurationDays(startsAt: Date, expiresAt: Date | null): number {
  if (expiresAt === null) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAt.getTime() - startsAt.getTime()) / 86_400_000));
}

async function findAppliedRenewal(orderId: string) {
  return prisma.serviceEventLog.findFirst({
    where: { eventType: RENEWAL_EVENT_TYPE, metadata: { path: ["orderId"], equals: orderId } },
  });
}

function serviceUpdateData(
  computed: RenewalComputation,
  panelResult: RenewServiceAccountResult,
  startsAt: Date,
  now: Date,
): Prisma.ServiceUpdateInput {
  const expiresAt = panelResult.expiresAt !== undefined ? panelResult.expiresAt : computed.expiresAt;
  const data: Prisma.ServiceUpdateInput = {
    status: ServiceStatus.ACTIVE,
    volumeBytes: computed.totalBytes ?? 0n,
    usedBytes: panelResult.usedBytes ?? 0n,
    remainingBytes: computed.remainingBytes ?? 0n,
    expiresAt,
    durationDays: renewedDurationDays(startsAt, expiresAt),
    lastSubscriptionUpdateAt: now,
  };
  if (panelResult.subscriptionUrl !== undefined && panelResult.subscriptionUrl !== "") {
    data.subscriptionUrl = panelResult.subscriptionUrl;
  }
  if (panelResult.subscriptionToken !== undefined && panelResult.subscriptionToken !== "") {
    data.subscriptionToken = panelResult.subscriptionToken;
  }
  if (panelResult.configLinks !== undefined && panelResult.configLinks.length > 0) {
    data.configLinks = panelResult.configLinks;
  }
  return data;
}

/**
 * Executes one PAID SERVICE_RENEWAL order. Safe to call repeatedly. All
 * returned error strings are admin-safe Persian; adapter internals only go
 * to logs.
 *
 * CONCURRENCY: the whole critical sequence (fresh reads -> renewal
 * calculation -> panel write -> persistence) runs under the per-service
 * distributed lock, so a renewal can never race another mutation on the
 * same service and lose either paid effect. Contention or an unavailable
 * lock backend leaves the order PAID and retryable - no panel call, no
 * refund, no event log.
 */
export async function executeRenewalOrder(orderId: string): Promise<RenewalOutcome> {
  // Pre-lock reads touch only immutable order fields (type, serviceId).
  const head = await prisma.order.findUnique({
    where: { id: orderId },
    select: { type: true, serviceId: true },
  });
  if (head === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (head.type !== OrderType.SERVICE_RENEWAL) {
    return { ok: false, refunded: false, error: "این سفارش از نوع تمدید نیست." };
  }
  if (head.serviceId === null) {
    // No shared service state to protect - the body refunds via its
    // existing service-missing dead end.
    return executeRenewalOrderUnlocked(orderId, null);
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
    return await executeRenewalOrderUnlocked(orderId, acquisition.lock);
  } finally {
    await acquisition.lock.release();
  }
}

async function executeRenewalOrderUnlocked(
  orderId: string,
  lock: ServiceLock | null,
): Promise<RenewalOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } } },
  })) as OrderForProvisioning | null;
  if (order === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  if (order.type !== OrderType.SERVICE_RENEWAL) {
    return { ok: false, refunded: false, error: "این سفارش از نوع تمدید نیست." };
  }

  // Idempotency: an already-applied renewal wins over everything.
  const applied = await findAppliedRenewal(order.id);
  if (applied !== null) {
    if (order.status !== OrderStatus.COMPLETED) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
    }
    const service = await prisma.service.findUnique({ where: { id: applied.serviceId } });
    if (service !== null) {
      return { ok: true, service, alreadyApplied: true };
    }
  }

  if (order.status === OrderStatus.PROVISIONING) {
    return { ok: false, refunded: false, error: "تمدید این سفارش هم‌اکنون در حال انجام است." };
  }
  if (order.status === OrderStatus.FAILED) {
    return { ok: false, refunded: false, error: "این سفارش قبلاً ناموفق شده است." };
  }
  if (order.status !== OrderStatus.PAID) {
    return { ok: false, refunded: false, error: "وضعیت سفارش برای تمدید معتبر نیست." };
  }

  // Target service + panel. Any dead end after payment refunds - never a
  // silent charge.
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
    const refunded = await failOrderWithRefund(order, "renewal target service missing");
    return { ok: false, refunded, error: "تمدید سرویس ناموفق بود." };
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
  const panel = service.panel;
  if (panel.status !== "ACTIVE") {
    const refunded = await failOrderWithRefund(order, `panel status is ${panel.status}`);
    return { ok: false, refunded, error: "تمدید سرویس ناموفق بود." };
  }

  // Claim the order: only one caller wins PAID -> PROVISIONING.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: OrderStatus.PAID },
    data: { status: OrderStatus.PROVISIONING },
  });
  if (claimed.count === 0) {
    return { ok: false, refunded: false, error: "سفارش توسط فرایند دیگری در حال پردازش است." };
  }
  logger.info("renewal started", {
    orderId: order.id,
    serviceId: service.id,
    panelId: panel.id,
    panelType: panel.type,
  });

  // Immutable sold values: order snapshots first, live Product as fallback.
  const volumeGb = order.volumeGbSnapshot ?? order.product?.volumeGb ?? 0;
  const durationDays = order.durationDaysSnapshot ?? order.product?.durationDays ?? 0;
  const now = new Date();
  const computed = calculateRenewal(service, { volumeGb, durationDays }, now);

  let panelResult: RenewServiceAccountResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    panelResult = await adapter.renewServiceAccount({
      username: service.username,
      totalBytes: computed.totalBytes,
      expiresAt: computed.expiresAt,
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
    logger.error("renewal panel outcome unknown - deferring to reconciliation", {
      orderId: order.id,
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }
  if (!panelResult.ok) {
    logger.warn("renewal panel update failed", {
      orderId: order.id,
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    const refunded = await failOrderWithRefund(
      order,
      panelResult.errorMessage ?? "unknown adapter error",
    );
    return { ok: false, refunded, error: "تمدید سرویس ناموفق بود." };
  }

  // Confirmed lock loss after the panel write: persisting could interleave
  // with a new lock owner. Leave the order PROVISIONING - startup
  // reconciliation resolves it from panel truth under the lock.
  if (lock !== null && lock.isLost()) {
    logger.error("renewal: lock ownership lost after panel call - deferring to reconciliation", {
      orderId: order.id,
      serviceId: service.id,
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }

  // Panel account is renewed. Persist with one retry; the user must end up
  // with an updated Service + COMPLETED order, or a refund (Phase 9.1 rule).
  const persist = (): Promise<{ service: Service; trialConverted: boolean }> =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.service.update({
        where: { id: service.id },
        data: serviceUpdateData(computed, panelResult, service.startsAt, now),
      });
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PROVISIONING },
        data: { status: OrderStatus.COMPLETED, completedAt: now },
      });
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: order.userId,
          panelId: panel.id,
          eventType: RENEWAL_EVENT_TYPE,
          metadata: {
            orderId: order.id,
            volumeGb,
            durationDays,
            totalBytes: (computed.totalBytes ?? 0n).toString(),
            expiresAt: computed.expiresAt?.toISOString() ?? null,
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
    logger.error("renewal persistence failed after panel success", {
      orderId: order.id,
      serviceId: service.id,
      error: errorMessage(err),
    });
    try {
      persisted = await persist();
    } catch (retryErr) {
      logger.error("renewal persistence retry failed", {
        orderId: order.id,
        error: errorMessage(retryErr),
      });
      // The panel account may already be renewed - manual review required.
      logger.warn("possible unrecorded panel renewal - manual review may be needed", {
        orderId: order.id,
        serviceId: service.id,
        panelId: panel.id,
      });
      const refunded = await failOrderWithRefund(
        order,
        "renewal persistence failed after panel success",
      );
      return { ok: false, refunded, error: "تمدید سرویس ناموفق بود." };
    }
  }
  logger.info("renewal succeeded", {
    orderId: order.id,
    serviceId: persisted.service.id,
    panelId: panel.id,
  });
  return {
    ok: true,
    service: persisted.service,
    alreadyApplied: false,
    trialConverted: persisted.trialConverted,
  };
}

/** HTML success message for the user after a completed renewal. */
export function buildRenewalSuccessMessage(service: Service): string {
  const lines = [
    "سرویس شما با موفقیت تمدید شد ✅",
    "",
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `حجم جدید: ${
      service.volumeBytes > 0n
        ? `${Math.round((Number(service.volumeBytes) / Number(GIB)) * 100) / 100} گیگابایت`
        : "نامحدود"
    }`,
    `تاریخ انقضای جدید: ${
      service.expiresAt === null ? "نامحدود" : service.expiresAt.toISOString().slice(0, 10)
    }`,
  ];
  if (service.subscriptionUrl !== null && service.subscriptionUrl !== "") {
    lines.push("", "لینک اشتراک:", `<code>${escapeHtml(service.subscriptionUrl)}</code>`);
  }
  return lines.join("\n");
}
