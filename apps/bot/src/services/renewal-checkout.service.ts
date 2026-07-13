import {
  CheckoutStatus,
  PanelStatus,
  prisma,
  ServiceStatus,
  type CheckoutSession,
  type Prisma,
  type Service,
  type User,
  type UserGroup,
} from "@zedbot/database";

import type { RenewalDraft } from "../core/session.js";
import { groupMatches } from "./catalog.service.js";
import { buildProductSnapshot, checkoutExpiryMinutes } from "./checkout.service.js";
import {
  panelOperationAvailable,
  panelTypesSupporting,
  serviceSupportsGlobalLifecycle,
} from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";

// =============================================================================
// Renewal browsing + checkout creation (Phase 12). Strictly read-only until
// the user confirms the renewal pre-invoice - the CheckoutSession (orderType
// SERVICE_RENEWAL) is the ONLY write. No Order/Payment/Service/panel change
// here; those follow the existing Phase 7/8 payment path.
// =============================================================================

export const RENEWABLE_PAGE_SIZE = 5;

/**
 * Statuses a user may renew from. CREATING/FAILED/DELETED are never
 * renewable. Exported as the single source of truth - the service-detail
 * «تمدید سرویس ♻️» button (Corrective Fix A) gates on the same list instead
 * of duplicating it.
 */
export const RENEWABLE_STATUSES: ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.EXPIRED,
  ServiceStatus.LIMITED,
  ServiceStatus.DISABLED,
];

function renewableWhere(userId: string) {
  return {
    userId,
    deletedAt: null,
    status: { in: RENEWABLE_STATUSES },
    // Only panels whose adapter implements renewal (capability model):
    // services on renew-incapable panels never appear as renewable.
    panel: { status: PanelStatus.ACTIVE, type: { in: panelTypesSupporting("renewService") } },
  } as const;
}

export interface RenewableListPage {
  services: Service[];
  page: number;
  pages: number;
  total: number;
}

/** Newest-first page of the user's renewable services (active panels only). */
export async function listRenewableServices(
  userId: string,
  page: number,
): Promise<RenewableListPage> {
  // The XUI remote-model gate (GLOBAL_CLIENT only) needs stored metadata, so
  // filtering happens in memory; per-user service counts are small.
  const rows = await prisma.service.findMany({
    where: renewableWhere(userId),
    orderBy: { createdAt: "desc" },
  });
  const eligible = rows.filter((s) => serviceSupportsGlobalLifecycle(s));
  const total = eligible.length;
  const pages = Math.max(1, Math.ceil(total / RENEWABLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const services = eligible.slice(
    (safePage - 1) * RENEWABLE_PAGE_SIZE,
    safePage * RENEWABLE_PAGE_SIZE,
  );
  return { services, page: safePage, pages, total };
}

/**
 * Resolves a renewable service by uuid-prefix short id, scoped to the owner.
 * Unknown/ambiguous/foreign/non-renewable ids all return null.
 */
export async function getRenewableServiceByShortId(
  shortId: string,
  userId: string,
): Promise<Service | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: { id: { startsWith: shortId }, ...renewableWhere(userId) },
    take: 2,
  });
  const match = matches.length === 1 ? matches[0] : null;
  // Legacy per-inbound XUI services are never renewable through the
  // global-client endpoints - same null contract as any other ineligibility.
  return match !== null && serviceSupportsGlobalLifecycle(match) ? match : null;
}

/**
 * Renewal plans for a service: active SERVICE_PRODUCTs of the SAME panel,
 * active category, visible to the user's group. Panel visibility to new
 * buyers (isVisible) is deliberately NOT required - the owner of an existing
 * service may renew it as long as the panel is ACTIVE.
 */
export async function renewalPlansForPanel(
  group: UserGroup,
  panelId: string,
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [
      { category: { displayOrder: "asc" } },
      { displayOrder: "asc" },
      { priceToman: "asc" },
      { createdAt: "asc" },
    ],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/** Re-check that one plan is still valid for renewing this service. */
export function isRenewalPlanValid(
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
    // Capability gate: a panel whose adapter cannot renew must be blocked
    // HERE, before payment - never discovered post-payment.
    panelOperationAvailable(product.panel, "renewService") &&
    // Remote-model gate: only GLOBAL_CLIENT XUI services may be renewed.
    serviceSupportsGlobalLifecycle(service) &&
    groupMatches(product.displayGroups, group)
  );
}

/** Renewal checkout snapshot (shared with the Phase 15 wallet payment). */
export function buildRenewalSnapshot(
  product: ProductWithRelations,
  service: Service,
  draft: RenewalDraft,
): Prisma.InputJsonObject {
  const baseSnapshot = buildProductSnapshot(product, {
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
    ...baseSnapshot,
    renewalTargetServiceId: service.id,
    renewalTargetUsername: service.username,
    renewalMethod: "ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD",
    renewalTargetStatus: service.status,
    renewalTargetExpiresAt: service.expiresAt?.toISOString() ?? null,
    renewalTargetRemainingBytes: service.remainingBytes.toString(),
    renewalTargetVolumeBytes: service.volumeBytes.toString(),
  };
}

/**
 * The ONLY write of the renewal browse flow: a PENDING CheckoutSession with
 * orderType SERVICE_RENEWAL targeting the existing service. Older PENDING
 * checkouts of the same user+service are cancelled first.
 */
export async function createRenewalCheckoutSession(
  user: User,
  service: Service,
  product: ProductWithRelations,
  draft: RenewalDraft,
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
      orderType: "SERVICE_RENEWAL",
      productSnapshot: buildRenewalSnapshot(product, service, draft),
      originalPriceToman: draft.originalPriceToman,
      discountAmountToman: draft.discountAmountToman,
      finalPriceToman: draft.finalPriceToman,
      discountCodeId: draft.discountCodeId ?? null,
      status: CheckoutStatus.PENDING,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    },
  });
}
