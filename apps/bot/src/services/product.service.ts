import { prisma, type Prisma, type Product, type ProductType } from "@zedbot/database";
import type { ProductWithRelations } from "@zedbot/service-renewal";

import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

export const PRODUCTS_PAGE_SIZE = 8;

// The shape lives in @zedbot/service-renewal because the catalog predicates that
// consume it do, and the Mini App API needs both. Re-exported under the same
// name so every existing bot import is unchanged.
export type { ProductWithRelations };

/** S/O/A by type; V (active) / X (inactive) by status (Fix C). */
export type ProductListFilter = "S" | "O" | "A" | "V" | "X";

export interface ProductListPage {
  products: ProductWithRelations[];
  page: number;
  pages: number;
  total: number;
}

function filterWhere(filter: ProductListFilter): Prisma.ProductWhereInput {
  if (filter === "S") {
    return { type: "SERVICE_PRODUCT" };
  }
  if (filter === "O") {
    return { type: "OTHER_PRODUCT" };
  }
  if (filter === "V") {
    return { isActive: true };
  }
  if (filter === "X") {
    return { isActive: false };
  }
  return {};
}

/** Admin list: includes inactive products, grouped by category position. */
export async function listProducts(
  filter: ProductListFilter,
  page: number,
): Promise<ProductListPage> {
  const where = filterWhere(filter);
  const total = await prisma.product.count({ where });
  const pages = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const products = await prisma.product.findMany({
    where,
    include: { category: true, panel: true },
    orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { createdAt: "asc" }],
    skip: (safePage - 1) * PRODUCTS_PAGE_SIZE,
    take: PRODUCTS_PAGE_SIZE,
  });
  return { products, page: safePage, pages, total };
}

export async function getProductById(id: string): Promise<ProductWithRelations | null> {
  return prisma.product.findUnique({ where: { id }, include: { category: true, panel: true } });
}

/** Resolve from the 8-char short id used in callback data (unique prefix). */
export async function getProductByShortId(shortId: string): Promise<ProductWithRelations | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.product.findMany({
    where: { id: { startsWith: shortId } },
    include: { category: true, panel: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function productShortId(product: Pick<Product, "id">): string {
  return product.id.slice(0, 8);
}

/**
 * Repositions a product among the products of the SAME category.
 * newOrder <= 0 or beyond the end appends; siblings are renumbered 1..n so
 * duplicate display orders can never survive.
 */
export async function setProductDisplayOrder(productId: string, newOrder: number): Promise<void> {
  const target = await prisma.product.findUnique({ where: { id: productId } });
  if (target === null) {
    return;
  }
  const siblings = await prisma.product.findMany({
    where: { categoryId: target.categoryId },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  const rest = siblings.filter((p) => p.id !== productId);
  const index = newOrder <= 0 || newOrder > rest.length + 1 ? rest.length : newOrder - 1;
  rest.splice(index, 0, target);
  await prisma.$transaction(
    rest.map((p, i) => prisma.product.update({ where: { id: p.id }, data: { displayOrder: i + 1 } })),
  );
}

/** Creates a product at the requested position within its category (0 = end). */
export async function createProductAtOrder(
  data: Prisma.ProductUncheckedCreateInput,
  requestedOrder: number,
): Promise<ProductWithRelations> {
  const count = await prisma.product.count({ where: { categoryId: data.categoryId } });
  const created = await prisma.product.create({
    data: { ...data, displayOrder: count + 1 },
  });
  if (requestedOrder > 0 && requestedOrder <= count) {
    await setProductDisplayOrder(created.id, requestedOrder);
  }
  const withRelations = await getProductById(created.id);
  if (withRelations === null) {
    throw new Error("Product disappeared right after creation.");
  }
  return withRelations;
}

export async function updateProduct(
  id: string,
  data: Prisma.ProductUncheckedUpdateInput,
): Promise<ProductWithRelations> {
  await prisma.product.update({ where: { id }, data });
  const updated = await getProductById(id);
  if (updated === null) {
    throw new Error("Product disappeared during update.");
  }
  return updated;
}

/** Soft delete: the row is kept for history, the product just deactivates. */
export async function softDeleteProduct(id: string): Promise<ProductWithRelations> {
  return updateProduct(id, { isActive: false });
}

export type ProductTypeShort = "S" | "O";

export function productTypeOf(short: ProductTypeShort): ProductType {
  return short === "S" ? "SERVICE_PRODUCT" : "OTHER_PRODUCT";
}

export type SetRepresentativeEligibleResult =
  | { ok: true; product: ProductWithRelations; changed: boolean }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_TYPE" };

/**
 * The ONE authoritative writer for `Product.representativeEligible` — the OWNER's
 * opt-in per SERVICE_PRODUCT for reseller sale (§8). Both the product-management
 * flow and the representative admin console reuse THIS function; no second
 * eligibility writer exists (§12).
 *
 * It performs a single ATOMIC conditional update guarded by
 * `(id, type = SERVICE_PRODUCT, representativeEligible = expectedCurrent)`:
 *   - a fresh confirm flips the flag to `!expectedCurrent` → `changed: true`;
 *   - a duplicate / stale confirm (the flag is ALREADY at the desired value, or
 *     was flipped by a concurrent write) matches nothing → converges idempotently
 *     to the current state with `changed: false`; no double-flip is possible;
 *   - a missing product → `NOT_FOUND`; a non-SERVICE_PRODUCT → `WRONG_TYPE`.
 *
 * It ONLY flips the flag. It never changes `Product.isActive`, deletes
 * `RepresentativeProductPrice` rows, activates a price, recalculates fixed
 * prices, rewrites `CheckoutSession` snapshots, or touches any
 * Payment/Order/Wallet/Referral record (§11). Turning eligibility off blocks
 * NEW reseller catalogs/checkouts only; it never invalidates a settled Payment,
 * a paid Order, or a provisioned Service (§10, §16). Enabling it only MARKS the
 * product eligible — the product must still satisfy every normal
 * catalog/panel/readiness/group check to actually be sellable, and no tier price
 * is created automatically.
 *
 * The audit marker is privacy-safe (§13/§24): action + enabled flag + product
 * TYPE + an 8-char correlation id only — never the description, price, panel URL
 * or any token. `writeSystemLog` never throws.
 */
export async function setProductRepresentativeEligible(args: {
  productId: string;
  expectedCurrent: boolean;
  adminId: string;
}): Promise<SetRepresentativeEligibleResult> {
  const desired = !args.expectedCurrent;
  const updated = await prisma.product.updateMany({
    where: {
      id: args.productId,
      type: "SERVICE_PRODUCT",
      representativeEligible: args.expectedCurrent,
    },
    data: { representativeEligible: desired },
  });
  const product = await getProductById(args.productId);
  if (product === null) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (product.type !== "SERVICE_PRODUCT") {
    return { ok: false, reason: "WRONG_TYPE" };
  }
  const changed = updated.count === 1;
  if (changed) {
    await writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.PRODUCT_REP_ELIGIBILITY_CHANGED,
      message: OPS_EVENTS.PRODUCT_REP_ELIGIBILITY_CHANGED,
      adminId: args.adminId,
      metadata: {
        enabled: desired,
        productType: "SERVICE_PRODUCT",
        productShort: productShortId(product),
      },
    });
  }
  return { ok: true, product, changed };
}
