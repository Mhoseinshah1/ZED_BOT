import {
  PanelStatus,
  prisma,
  type Panel,
  type ProductCategory,
  type User,
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
  // Audit fix (feat/public-pricing-catalog §6): the LIST must apply the SAME
  // authoritative predicate as the product-click handler, so a product that
  // would be rejected on click (unready panel / invalid XUI inbound) never
  // appears here either. `isProductVisible` is a strict superset of
  // `groupMatches`, so this only removes already-unbuyable products.
  return products.filter((p) => isProductVisible(p, group));
}

/** All other-products the user may buy. */
export async function visibleOtherProducts(group: UserGroup): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: { type: "OTHER_PRODUCT", isActive: true, category: { isActive: true } },
    include: { category: true, panel: true },
    orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { createdAt: "asc" }],
  });
  // Same authoritative predicate as the click handler (see above). For
  // OTHER_PRODUCT this equals the group filter plus the active checks the query
  // already applied, so behaviour is unchanged - it just routes through the one
  // predicate.
  return products.filter((p) => isProductVisible(p, group));
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
 * Structural sellability of a product, INDEPENDENT of any user group: the
 * product is active, its category is active, and (for a SERVICE_PRODUCT) its
 * panel exists, is visible, is sellable (provisioning-ready), and its XUI
 * inbound selection is valid. This is the group-agnostic core of
 * `isProductVisible` — reused by admin surfaces that need to explain WHY a
 * product cannot currently reach checkout (readiness), where the per-audience
 * group filter is not meaningful. There is exactly ONE copy of these checks.
 */
export function isProductStructurallySellable(product: ProductWithRelations): boolean {
  if (!product.isActive || !product.category.isActive) {
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

/**
 * Re-checks that one specific product is still visible/purchasable for the
 * user (used when resolving callbacks and before checkout creation). This is
 * the SINGLE authoritative catalog predicate: group visibility on top of the
 * structural sellability core above.
 */
export function isProductVisible(product: ProductWithRelations, group: UserGroup): boolean {
  if (!groupMatches(product.displayGroups, group)) {
    return false;
  }
  return isProductStructurallySellable(product);
}

// =============================================================================
// Authoritative user retail catalog (feat/public-pricing-catalog §6).
//
// ONE loader assembles the full purchasable tree for a user in exactly two
// queries (no N+1): a panel-first SERVICE hierarchy and a flat OTHER-product
// grouping. Every returned Product passes `isProductVisible`; group filtering
// happens BEFORE any count / minimum-price / pagination; a Panel or Category
// with zero purchasable products is dropped entirely, so the pricing page can
// never show a panel/category whose products all fail on click.
// =============================================================================

export interface RetailCatalogCategory {
  category: ProductCategory;
  products: ProductWithRelations[];
}

export interface RetailCatalogServicePanel {
  panel: Panel;
  categories: RetailCatalogCategory[];
}

export interface UserRetailCatalog {
  servicePanels: RetailCatalogServicePanel[];
  otherProductCategories: RetailCatalogCategory[];
}

/** Total purchasable products across a grouped catalog node. */
export function countCatalogProducts(node: {
  categories: RetailCatalogCategory[];
}): number {
  return node.categories.reduce((sum, c) => sum + c.products.length, 0);
}

/** Minimum current retail price across a product list (0 when empty). */
export function minRetailPrice(products: ProductWithRelations[]): number {
  if (products.length === 0) {
    return 0;
  }
  return products.reduce((min, p) => (p.priceToman < min ? p.priceToman : min), products[0].priceToman);
}

/**
 * Loads the authoritative purchasable retail catalog for one user. The two
 * findMany calls are ordered deterministically so the in-memory grouping (which
 * preserves first-seen order) yields a stable Panel → Category → Product tree.
 */
export async function loadUserRetailCatalog(
  user: Pick<User, "group">,
): Promise<UserRetailCatalog> {
  // --- Service products: one query across every ACTIVE + visible panel. ------
  const serviceProducts = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE, isVisible: true },
    },
    include: { category: true, panel: true },
    orderBy: [
      { panel: { displayOrder: "asc" } },
      { panel: { createdAt: "asc" } },
      { category: { displayOrder: "asc" } },
      { category: { createdAt: "asc" } },
      { displayOrder: "asc" },
      { priceToman: "asc" },
      { createdAt: "asc" },
    ],
  });

  const servicePanelMap = new Map<
    string,
    { panel: Panel; categories: Map<string, RetailCatalogCategory> }
  >();
  for (const product of serviceProducts) {
    // Structural readiness + group filter BEFORE the product counts anywhere.
    if (product.panel === null || !isProductVisible(product, user.group)) {
      continue;
    }
    const panelEntry = servicePanelMap.get(product.panel.id) ?? {
      panel: product.panel,
      categories: new Map<string, RetailCatalogCategory>(),
    };
    const catEntry = panelEntry.categories.get(product.categoryId) ?? {
      category: product.category,
      products: [],
    };
    catEntry.products.push(product);
    panelEntry.categories.set(product.categoryId, catEntry);
    servicePanelMap.set(product.panel.id, panelEntry);
  }
  const servicePanels: RetailCatalogServicePanel[] = [...servicePanelMap.values()]
    .map((entry) => ({ panel: entry.panel, categories: [...entry.categories.values()] }))
    .filter((entry) => entry.categories.length > 0);

  // --- Other products: reuse the flat visible list, grouped by category. -----
  const otherProducts = await visibleOtherProducts(user.group);
  const otherMap = new Map<string, RetailCatalogCategory>();
  for (const product of otherProducts) {
    const entry = otherMap.get(product.categoryId) ?? {
      category: product.category,
      products: [],
    };
    entry.products.push(product);
    otherMap.set(product.categoryId, entry);
  }

  return {
    servicePanels,
    otherProductCategories: [...otherMap.values()],
  };
}
