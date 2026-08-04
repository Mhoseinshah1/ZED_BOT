import {
  PanelStatus,
  prisma,
  type Panel,
  type Prisma,
  type PrismaClient,
  type ProductCategory,
  type UserGroup,
} from "@zedbot/database";

import { isProductVisible, type ProductWithRelations } from "./catalog.js";

// =============================================================================
// The catalog, as a browser is allowed to see it.
//
// SAME VISIBILITY RULES AS THE BOT, because they are the same function:
// `isProductVisible` decides here exactly as it decides in
// `loadUserRetailCatalog`. What differs is only the shape that leaves the
// server — the bot renders Persian into a Telegram message, this returns an
// allowlisted DTO.
//
// A PANEL OR CATEGORY WITH NOTHING PURCHASABLE IN IT IS DROPPED ENTIRELY, so the
// Mini App can never show a location that leads to an empty screen, or a
// category whose every product would be refused on tap.
//
// TWO QUERIES, NOT N+1. The whole tree is assembled from one product query with
// its relations included; the grouping happens in memory over a deterministically
// ordered result, so the Panel → Category → Product order is stable between
// requests without a second round trip per node.
//
// PUBLIC IDS ONLY. Panels, categories and products are addressed by the same
// 8-hex prefix convention as everything else. A uuid never leaves this module.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

export const CATALOG_PUBLIC_ID_LENGTH = 8;

const CATALOG_PUBLIC_ID_PATTERN = /^[0-9a-f]{8}$/i;

export function catalogPublicId(row: { id: string }): string {
  return row.id.slice(0, CATALOG_PUBLIC_ID_LENGTH);
}

export function isCatalogPublicId(value: unknown): value is string {
  return typeof value === "string" && CATALOG_PUBLIC_ID_PATTERN.test(value);
}

export interface CatalogProductDto {
  productId: string;
  label: string;
  description: string;
  priceToman: number;
  currency: "IRT";
  durationDays: number | null;
  trafficGb: number | null;
  /** Operator-authored location label, or null when the product spans all. */
  location: string | null;
  allLocations: boolean;
}

export interface CatalogCategoryDto {
  categoryId: string;
  label: string;
  products: CatalogProductDto[];
}

export interface CatalogLocationDto {
  /** The Panel, addressed publicly. Users read this as "location". */
  locationId: string;
  label: string;
  categories: CatalogCategoryDto[];
  /** Cheapest purchasable product here, for a "from X" line. */
  fromPriceToman: number;
  productCount: number;
}

export interface CatalogDto {
  locations: CatalogLocationDto[];
}

function toProductDto(product: ProductWithRelations): CatalogProductDto {
  return {
    productId: catalogPublicId(product),
    label: product.name,
    // The operator's own invoice line. Shown as-is; it is not user input.
    description: product.invoiceDescription ?? "",
    priceToman: product.priceToman,
    currency: "IRT",
    durationDays: product.durationDays ?? null,
    trafficGb: product.volumeGb ?? null,
    location: product.allLocations ? null : product.serviceLocation,
    allLocations: product.allLocations,
  };
}

/**
 * The purchasable catalog for one user.
 *
 * Only SERVICE_PRODUCTs on ACTIVE + visible panels. OTHER_PRODUCTs are absent on
 * purpose: their checkout needs the customer-information form that layer 3 owns,
 * and offering something that cannot be fulfilled is worse than not offering it.
 */
export async function loadMiniAppCatalog(db: Db, group: UserGroup): Promise<CatalogDto> {
  const products = await db.product.findMany({
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

  const byPanel = new Map<
    string,
    { panel: Panel; categories: Map<string, { category: ProductCategory; products: ProductWithRelations[] }> }
  >();
  for (const product of products) {
    // The authoritative predicate, applied BEFORE the product counts anywhere —
    // so a hidden product cannot inflate a count or set a "from" price.
    if (product.panel === null || !isProductVisible(product, group)) {
      continue;
    }
    const panelEntry = byPanel.get(product.panel.id) ?? {
      panel: product.panel,
      categories: new Map(),
    };
    const categoryEntry = panelEntry.categories.get(product.categoryId) ?? {
      category: product.category,
      products: [],
    };
    categoryEntry.products.push(product);
    panelEntry.categories.set(product.categoryId, categoryEntry);
    byPanel.set(product.panel.id, panelEntry);
  }

  const locations: CatalogLocationDto[] = [];
  for (const entry of byPanel.values()) {
    const categories: CatalogCategoryDto[] = [];
    let productCount = 0;
    let fromPriceToman = Number.POSITIVE_INFINITY;
    for (const categoryEntry of entry.categories.values()) {
      if (categoryEntry.products.length === 0) {
        continue;
      }
      productCount += categoryEntry.products.length;
      for (const product of categoryEntry.products) {
        fromPriceToman = Math.min(fromPriceToman, product.priceToman);
      }
      categories.push({
        categoryId: catalogPublicId(categoryEntry.category),
        label: categoryEntry.category.name,
        products: categoryEntry.products.map(toProductDto),
      });
    }
    if (categories.length === 0) {
      continue;
    }
    locations.push({
      locationId: catalogPublicId(entry.panel),
      // The panel's operator-facing NAME, which is what the bot shows users as
      // the location. Never the base URL, and never the uuid.
      label: entry.panel.name,
      categories,
      fromPriceToman: Number.isFinite(fromPriceToman) ? fromPriceToman : 0,
      productCount,
    });
  }
  return { locations };
}

export type PurchasableProductResolution =
  | { ok: true; product: ProductWithRelations }
  | { ok: false; code: "PRODUCT_UNAVAILABLE" };

/**
 * Resolves one product a user may actually buy, by its public id.
 *
 * ONE ANSWER FOR EVERY REFUSAL, and for the same reason the service resolver has
 * one: malformed, unknown, hidden from this group, inactive, on a hidden or
 * unready panel, and an ambiguous prefix all return `PRODUCT_UNAVAILABLE`. A
 * caller who could tell them apart could map the catalog of every other
 * audience one probe at a time.
 *
 * The eligible set is searched rather than the row fetched-then-validated, so an
 * unbuyable product is never loaded by id on this path.
 */
export async function resolvePurchasableProduct(
  db: Db,
  group: UserGroup,
  publicProductId: string,
): Promise<PurchasableProductResolution> {
  if (!isCatalogPublicId(publicProductId)) {
    return { ok: false, code: "PRODUCT_UNAVAILABLE" };
  }
  const matches = await db.product.findMany({
    where: {
      id: { startsWith: publicProductId.toLowerCase() },
      type: "SERVICE_PRODUCT",
      isActive: true,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE, isVisible: true },
    },
    include: { category: true, panel: true },
    take: 2,
  });
  const eligible = matches.filter((p) => isProductVisible(p, group));
  // Exactly one, or nothing. A collision refuses rather than selling whichever
  // row the planner happened to return first.
  if (eligible.length !== 1) {
    return { ok: false, code: "PRODUCT_UNAVAILABLE" };
  }
  return { ok: true, product: eligible[0] };
}

/** Convenience wrapper for callers outside a transaction. */
export async function loadMiniAppCatalogForUser(group: UserGroup): Promise<CatalogDto> {
  return loadMiniAppCatalog(prisma, group);
}
