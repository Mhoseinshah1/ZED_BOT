import {
  prisma,
  type Panel,
  type Prisma,
  type Product,
  type ProductCategory,
  type ProductType,
} from "@zedbot/database";

export const PRODUCTS_PAGE_SIZE = 8;

export type ProductWithRelations = Product & {
  category: ProductCategory;
  panel: Panel | null;
};

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
