import {
  PanelStatus,
  prisma,
  type Panel,
  type ProductCategory,
  type UserGroup,
} from "@zedbot/database";

import { isPanelSellable, resolveProductInboundIds } from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";

// =============================================================================
// User-facing catalog: which panels/products a given user may see and buy.
//
// Phase 11.1: purchases are PANEL-FIRST. There is no hardcoded "service
// type" step - real panels configured by the admin drive the selection, and
// categories/products are always filtered by the selected panel.
// =============================================================================

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

/** Panels users may buy from: ACTIVE + visible, in display order. */
export async function purchasablePanels(): Promise<Panel[]> {
  return prisma.panel.findMany({
    where: { status: PanelStatus.ACTIVE, isVisible: true },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** Resolves a purchasable panel by uuid-prefix short id (unique or null). */
export async function getPurchasablePanelByShortId(shortId: string): Promise<Panel | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.panel.findMany({
    where: { id: { startsWith: shortId }, status: PanelStatus.ACTIVE, isVisible: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** All service products of ONE panel the user may buy. */
export async function visibleServiceProducts(
  group: UserGroup,
  panelId: string,
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE, isVisible: true },
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
export function isProductVisible(product: ProductWithRelations, group: UserGroup): boolean {
  if (!product.isActive || !product.category.isActive) {
    return false;
  }
  if (!groupMatches(product.displayGroups, group)) {
    return false;
  }
  if (product.type === "SERVICE_PRODUCT") {
    // Sellability includes provisioning readiness: a panel with incomplete
    // provisioning config (or an explicitly failed readiness test) must be
    // caught HERE - before checkout/payment - never after the money moved.
    if (
      product.panel === null ||
      !product.panel.isVisible ||
      !isPanelSellable(product.panel)
    ) {
      return false;
    }
    // XUI: the product's inbound selection must stay inside the panel's
    // allowlist - a violating product is unsellable BEFORE checkout/payment.
    if (
      product.panel.type === "XUI" &&
      !resolveProductInboundIds(product.panel, product.inboundIds).ok
    ) {
      return false;
    }
  }
  return true;
}
