import {
  Prisma,
  prisma,
  type Product,
  type RepresentativeProductPrice,
  type RepresentativeTier,
} from "@zedbot/database";
import {
  isRepresentativePriceMode,
  isValidRepTierName,
  REP_TIER_DESC_MAX,
  representativeTierSlug,
  resolveRepresentativeBasePrice,
  type RepresentativeErrorCode,
  type RepresentativePriceMode,
} from "@zedbot/shared";

import { isProductStructurallySellable } from "./catalog.service.js";
import { writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Representative Program — tier + per-product price management (§18, §19).
//
// OWNER-only data operations for reseller pricing tiers and their product
// prices. Tiers and prices are NEVER hard-deleted while history exists — they
// are archived (isActive=false). A tier cannot be archived while ACTIVE/SUSPENDED
// representatives still reference it (§18: safe blocking). Every price is exactly
// one row per (tier, product); editing updates in place (§5 unique constraint).
// All mutations are audited with relational IDs + codes only (§24).
// =============================================================================

type Ok<T> = { ok: true } & T;
type Err = { ok: false; code: RepresentativeErrorCode };

function err(code: RepresentativeErrorCode): Err {
  return { ok: false, code };
}

// --- tiers (§18) -------------------------------------------------------------

export async function listRepresentativeTiers(
  includeArchived = true,
): Promise<RepresentativeTier[]> {
  return prisma.representativeTier.findMany({
    where: includeArchived ? {} : { isActive: true },
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function getRepresentativeTierById(
  id: string,
): Promise<RepresentativeTier | null> {
  return prisma.representativeTier.findUnique({ where: { id } });
}

/** Resolves a tier by its 8-char short id (callback-safe). Ambiguity → null. */
export async function getRepresentativeTierByShortId(
  shortId: string,
): Promise<RepresentativeTier | null> {
  const matches = await prisma.representativeTier.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function countRepresentativesUsingTier(tierId: string): Promise<number> {
  return prisma.representative.count({
    where: { tierId, status: { in: ["ACTIVE", "SUSPENDED"] } },
  });
}

export type TierResult = Ok<{ tier: RepresentativeTier }> | Err;

/** Creates a tier with a stable, unique slug derived from the name. A slug
 * collision retries with a numeric suffix. */
export async function createRepresentativeTier(args: {
  name: string;
  description: string | null;
  adminId: string;
}): Promise<TierResult> {
  if (!isValidRepTierName(args.name)) {
    return err("VALIDATION");
  }
  if (args.description !== null && args.description.length > REP_TIER_DESC_MAX) {
    return err("VALIDATION");
  }
  const base = representativeTierSlug(args.name, "tier");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 40);
    try {
      const maxOrder = await prisma.representativeTier.aggregate({ _max: { sortOrder: true } });
      const tier = await prisma.representativeTier.create({
        data: {
          slug,
          name: args.name,
          description: args.description,
          isActive: true,
          sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
          createdByAdminId: args.adminId,
        },
      });
      await audit("representative.tier_created", args.adminId, { tierId: tier.id });
      return { ok: true, tier };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        continue; // slug collision → next suffix
      }
      throw e;
    }
  }
  return err("CONFLICTING_OPERATION");
}

export async function editRepresentativeTier(args: {
  tierId: string;
  adminId: string;
  name?: string;
  description?: string | null;
  sortOrder?: number;
}): Promise<TierResult> {
  const tier = await prisma.representativeTier.findUnique({ where: { id: args.tierId } });
  if (tier === null) {
    return err("NOT_FOUND");
  }
  if (args.name !== undefined && !isValidRepTierName(args.name)) {
    return err("VALIDATION");
  }
  if (
    args.description !== undefined &&
    args.description !== null &&
    args.description.length > REP_TIER_DESC_MAX
  ) {
    return err("VALIDATION");
  }
  const updated = await prisma.representativeTier.update({
    where: { id: tier.id },
    data: {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.sortOrder !== undefined ? { sortOrder: args.sortOrder } : {}),
    },
  });
  await audit("representative.tier_edited", args.adminId, { tierId: tier.id });
  return { ok: true, tier: updated };
}

/** Archives (isActive=false) or reactivates a tier. Archiving is BLOCKED while
 * active/suspended representatives still use it (§18 safe blocking). */
export async function setRepresentativeTierActive(args: {
  tierId: string;
  adminId: string;
  active: boolean;
}): Promise<TierResult> {
  const tier = await prisma.representativeTier.findUnique({ where: { id: args.tierId } });
  if (tier === null) {
    return err("NOT_FOUND");
  }
  if (!args.active) {
    const inUse = await countRepresentativesUsingTier(tier.id);
    if (inUse > 0) {
      return err("CONFLICTING_OPERATION");
    }
  }
  const updated = await prisma.representativeTier.update({
    where: { id: tier.id },
    data: { isActive: args.active, archivedAt: args.active ? null : new Date() },
  });
  await audit(
    args.active ? "representative.tier_reactivated" : "representative.tier_archived",
    args.adminId,
    { tierId: tier.id },
  );
  return { ok: true, tier: updated };
}

// --- per-tier product prices (§19) -------------------------------------------

export type PricedProductRow = {
  product: Pick<Product, "id" | "name" | "priceToman" | "isActive">;
  /** Structural sellability (active + category active + panel ready + valid XUI
   * inbound), group-agnostic — an opted-in product can still be unsellable, and
   * the OWNER needs to SEE that on the price page rather than have it silently
   * vanish (§11). Uses the ONE shared catalog predicate, not an imitation. */
  sellable: boolean;
  price: RepresentativeProductPrice | null;
};

/** All representative-eligible SERVICE_PRODUCTs + their price row for this tier
 * (null when unset). Opted-in but inactive/unready products are RETAINED here,
 * flagged `sellable: false`, so the OWNER can see why they cannot yet be sold
 * (§11). Deterministic catalog order. Read-only. */
export async function listTierProductPrices(tierId: string): Promise<PricedProductRow[]> {
  const [products, prices] = await Promise.all([
    prisma.product.findMany({
      where: { type: "SERVICE_PRODUCT", representativeEligible: true },
      include: { category: true, panel: true },
      orderBy: [
        { category: { displayOrder: "asc" } },
        { displayOrder: "asc" },
        { priceToman: "asc" },
        { createdAt: "asc" },
      ],
    }),
    prisma.representativeProductPrice.findMany({ where: { tierId } }),
  ]);
  const byProduct = new Map(prices.map((p) => [p.productId, p]));
  return products.map((product) => ({
    product: {
      id: product.id,
      name: product.name,
      priceToman: product.priceToman,
      isActive: product.isActive,
    },
    sellable: isProductStructurallySellable(product),
    price: byProduct.get(product.id) ?? null,
  }));
}

export type PriceResult = Ok<{ price: RepresentativeProductPrice }> | Err;

/**
 * Upserts (create or edit in place) the reseller price for one (tier, product).
 * Validates the product is an eligible active SERVICE_PRODUCT, the tier exists,
 * and the resolved price is valid against the CURRENT retail (a FIXED above
 * retail is rejected; PERCENT bounded 1..95). One row per (tier, product) via
 * the unique constraint; concurrent edits converge (P2002 → reload + update).
 */
export async function upsertRepresentativeProductPrice(args: {
  tierId: string;
  productId: string;
  adminId: string;
  mode: string;
  fixedPriceToman: number | null;
  percentValue: number | null;
  isActive?: boolean;
}): Promise<PriceResult> {
  if (!isRepresentativePriceMode(args.mode)) {
    return err("PRICE_INVALID");
  }
  const [tier, product] = await Promise.all([
    prisma.representativeTier.findUnique({ where: { id: args.tierId }, select: { id: true } }),
    prisma.product.findUnique({
      where: { id: args.productId },
      select: { id: true, type: true, isActive: true, representativeEligible: true, priceToman: true },
    }),
  ]);
  if (tier === null) {
    return err("NOT_FOUND");
  }
  if (
    product === null ||
    product.type !== "SERVICE_PRODUCT" ||
    !product.isActive ||
    !product.representativeEligible
  ) {
    return err("PRODUCT_INELIGIBLE");
  }
  // Validate the resolved price against CURRENT retail (fail closed on stale).
  const resolved = resolveRepresentativeBasePrice({
    mode: args.mode as RepresentativePriceMode,
    retailToman: product.priceToman,
    fixedPriceToman: args.fixedPriceToman,
    percentDiscount: args.percentValue,
  });
  if (!resolved.ok) {
    return err(resolved.reason === "ABOVE_RETAIL" ? "PRICE_ABOVE_RETAIL" : "PRICE_INVALID");
  }

  const data = {
    priceMode: args.mode,
    fixedPriceToman: args.mode === "FIXED_TOMAN" ? args.fixedPriceToman : null,
    percentValue: args.mode === "PERCENT_DISCOUNT" ? args.percentValue : null,
    isActive: args.isActive ?? true,
    createdByAdminId: args.adminId,
  };
  const price = await prisma.representativeProductPrice.upsert({
    where: { tierId_productId: { tierId: args.tierId, productId: args.productId } },
    create: { tierId: args.tierId, productId: args.productId, ...data },
    update: {
      priceMode: data.priceMode,
      fixedPriceToman: data.fixedPriceToman,
      percentValue: data.percentValue,
      isActive: data.isActive,
    },
  });
  await audit("representative.price_set", args.adminId, {
    tierId: args.tierId,
    productId: args.productId,
    priceMode: args.mode,
  });
  return { ok: true, price };
}

/** Archives (disables) or reactivates a single tier/product price row. */
export async function setRepresentativeProductPriceActive(args: {
  tierId: string;
  productId: string;
  adminId: string;
  active: boolean;
}): Promise<PriceResult> {
  const existing = await prisma.representativeProductPrice.findUnique({
    where: { tierId_productId: { tierId: args.tierId, productId: args.productId } },
  });
  if (existing === null) {
    return err("NOT_FOUND");
  }
  const price = await prisma.representativeProductPrice.update({
    where: { id: existing.id },
    data: { isActive: args.active, archivedAt: args.active ? null : new Date() },
  });
  await audit(
    args.active ? "representative.price_reactivated" : "representative.price_archived",
    args.adminId,
    { tierId: args.tierId, productId: args.productId },
  );
  return { ok: true, price };
}

async function audit(
  eventType: string,
  adminId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeSystemLog({ level: "INFO", eventType, message: eventType, adminId, metadata });
}
