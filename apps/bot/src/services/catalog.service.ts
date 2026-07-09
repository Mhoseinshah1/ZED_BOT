import {
  PanelStatus,
  prisma,
  type ProductCategory,
  type ServiceLocation,
  type UserGroup,
} from "@zedbot/database";

import type { ProductWithRelations } from "./product.service.js";

// =============================================================================
// User-facing catalog: which products a given user may see and buy.
// Purchasable service products require an ACTIVE + visible panel.
// =============================================================================

export type LocationCode = "M" | "D" | "T" | "A";

export const LOCATION_BY_CODE: Record<Exclude<LocationCode, "A">, ServiceLocation> = {
  M: "MULTI_LOCATION",
  D: "DEDICATED_LOCATION",
  T: "TEST",
};

/**
 * Group visibility: a product is visible when its displayGroups array
 * contains the user's group (or "ALL"). Missing/empty/invalid displayGroups
 * fall back to the SAFE default: visible to group F only.
 */
export function groupMatches(displayGroups: unknown, group: UserGroup): boolean {
  if (Array.isArray(displayGroups)) {
    const valid = displayGroups.filter(
      (g): g is string => g === "F" || g === "N" || g === "N2" || g === "ALL",
    );
    if (valid.length > 0) {
      return valid.includes("ALL") || valid.includes(group);
    }
  }
  return group === "F";
}

function locationMatches(product: ProductWithRelations, code: LocationCode): boolean {
  if (code === "A") {
    return true;
  }
  return product.allLocations || product.serviceLocation === LOCATION_BY_CODE[code];
}

/** All service products the user may buy for the selected location. */
export async function visibleServiceProducts(
  group: UserGroup,
  locationCode: LocationCode,
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE, isVisible: true },
    },
    include: { category: true, panel: true },
    orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { createdAt: "asc" }],
  });
  return products.filter(
    (p) => groupMatches(p.displayGroups, group) && locationMatches(p, locationCode),
  );
}

/** All other-products the user may buy. */
export async function visibleOtherProducts(group: UserGroup): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: { type: "OTHER_PRODUCT", isActive: true, category: { isActive: true } },
    include: { category: true, panel: true },
    orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { createdAt: "asc" }],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/** Unique categories (in display order) among a filtered product list. */
export function categoriesOf(products: ProductWithRelations[]): ProductCategory[] {
  const seen = new Map<string, ProductCategory>();
  for (const product of products) {
    if (!seen.has(product.categoryId)) {
      seen.set(product.categoryId, product.category);
    }
  }
  return [...seen.values()];
}

/**
 * Re-checks that one specific product is still visible/purchasable for the
 * user (used when resolving callbacks and before checkout creation).
 */
export function isProductVisible(
  product: ProductWithRelations,
  group: UserGroup,
  locationCode?: LocationCode,
): boolean {
  if (!product.isActive || !product.category.isActive) {
    return false;
  }
  if (!groupMatches(product.displayGroups, group)) {
    return false;
  }
  if (product.type === "SERVICE_PRODUCT") {
    if (
      product.panel === null ||
      product.panel.status !== PanelStatus.ACTIVE ||
      !product.panel.isVisible
    ) {
      return false;
    }
    if (locationCode !== undefined && !locationMatches(product, locationCode)) {
      return false;
    }
  }
  return true;
}
