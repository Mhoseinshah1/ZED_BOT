import { PanelStatus, prisma, ServiceStatus, type Service } from "@zedbot/database";

import { RENEWABLE_STATUSES } from "./renewal-checkout.service.js";
import { linkRegenerationEligibility } from "./service-link.service.js";
import { availableToggleAction, type ToggleAction } from "./service-toggle.service.js";

// =============================================================================
// User "My Services" data access (Phase 10) - strictly read-only. Every
// lookup is scoped by userId so one user can never reach another user's
// service, and soft-deleted services are always excluded.
// =============================================================================

export const SERVICES_PAGE_SIZE = 5;

/** Filter shared by every user-facing service query. */
function ownedVisibleWhere(userId: string) {
  return {
    userId,
    deletedAt: null,
    status: { not: ServiceStatus.DELETED },
  } as const;
}

export interface ServiceListPage {
  services: Service[];
  page: number;
  pages: number;
  total: number;
}

/** Newest-first page of the user's non-deleted services. */
export async function listUserServices(userId: string, page: number): Promise<ServiceListPage> {
  const where = ownedVisibleWhere(userId);
  const total = await prisma.service.count({ where });
  const pages = Math.max(1, Math.ceil(total / SERVICES_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const services = await prisma.service.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * SERVICES_PAGE_SIZE,
    take: SERVICES_PAGE_SIZE,
  });
  return { services, page: safePage, pages, total };
}

/**
 * Resolves a service by uuid-prefix short id, scoped to the owner. Returns
 * null for unknown, ambiguous, deleted or foreign services - the caller
 * answers «مورد یافت نشد.» without revealing which case it was.
 */
export async function getOwnedServiceByShortId(
  shortId: string,
  userId: string,
): Promise<Service | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: { id: { startsWith: shortId }, ...ownedVisibleWhere(userId) },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function serviceShortId(service: Pick<Service, "id">): string {
  return service.id.slice(0, 8);
}

/** Action buttons the detail page may show for one service (Phase 18.1/19). */
export interface ServiceDetailActions {
  /** Phase 18 enable/disable toggle, or null for none. */
  toggleAction: ToggleAction | null;
  /** «خرید حجم اضافه ➕» - mirrors the Phase 16 eligibility rules. */
  canBuyExtraVolume: boolean;
  /** «خرید زمان اضافه ⏳» - mirrors the Phase 17 eligibility rules. */
  canBuyExtraTime: boolean;
  /** «تغییر لینک اشتراک 🔄» - Phase 19 link regeneration eligibility. */
  canRegenerateLink: boolean;
  /** «تمدید سرویس ♻️» - mirrors the Phase 12 renewal eligibility rules. */
  canRenew: boolean;
}

const EXTRA_VOLUME_STATUSES: ServiceStatus[] = [ServiceStatus.ACTIVE, ServiceStatus.LIMITED];
const EXTRA_TIME_STATUSES: ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.EXPIRED,
  ServiceStatus.LIMITED,
  ServiceStatus.DISABLED,
];

/**
 * Resolves every detail-page action with ONE panel read. The routes clicking
 * through (`user:ev:svc`/`user:et:svc`/toggle) re-validate on their own, so
 * these flags only gate what renders - a stale button still fails safely.
 * Unlimited-volume services never offer extra volume; never-expiring
 * services never offer extra time; a non-ACTIVE (or missing) panel offers
 * nothing.
 */
export async function resolveServiceDetailActions(service: Service): Promise<ServiceDetailActions> {
  const panel = await prisma.panel.findUnique({
    where: { id: service.panelId },
    select: { status: true },
  });
  if (panel === null) {
    return {
      toggleAction: null,
      canBuyExtraVolume: false,
      canBuyExtraTime: false,
      canRegenerateLink: false,
      canRenew: false,
    };
  }
  const panelActive = panel.status === PanelStatus.ACTIVE;
  return {
    toggleAction: availableToggleAction(service, panel.status),
    canBuyExtraVolume:
      panelActive && EXTRA_VOLUME_STATUSES.includes(service.status) && service.volumeBytes > 0n,
    canBuyExtraTime:
      panelActive && EXTRA_TIME_STATUSES.includes(service.status) && service.expiresAt !== null,
    canRegenerateLink: linkRegenerationEligibility(service, panel.status).eligible,
    // Same conditions as renewableWhere (deletedAt is already excluded by
    // every detail-page lookup); rncb.service re-validates on click.
    canRenew: panelActive && RENEWABLE_STATUSES.includes(service.status),
  };
}
