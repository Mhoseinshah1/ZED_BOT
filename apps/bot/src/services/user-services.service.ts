import { prisma, ServiceStatus, type Service } from "@zedbot/database";

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
