import { prisma, type Prisma, type ProductCategory, type ProductType } from "@zedbot/database";

export const CATEGORIES_PAGE_SIZE = 8;

export interface CategoryListPage {
  categories: ProductCategory[];
  page: number;
  pages: number;
  total: number;
}

/** Admin list: includes inactive categories, ordered by position. */
export async function listCategories(type: ProductType, page: number): Promise<CategoryListPage> {
  const total = await prisma.productCategory.count({ where: { type } });
  const pages = Math.max(1, Math.ceil(total / CATEGORIES_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const categories = await prisma.productCategory.findMany({
    where: { type },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    skip: (safePage - 1) * CATEGORIES_PAGE_SIZE,
    take: CATEGORIES_PAGE_SIZE,
  });
  return { categories, page: safePage, pages, total };
}

/** Picker list: active categories only (no pagination - pickers stay small). */
export async function activeCategories(type: ProductType): Promise<ProductCategory[]> {
  return prisma.productCategory.findMany({
    where: { type, isActive: true },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function getCategoryById(id: string): Promise<ProductCategory | null> {
  return prisma.productCategory.findUnique({ where: { id } });
}

/** Resolve from the 8-char short id used in callback data (unique prefix). */
export async function getCategoryByShortId(shortId: string): Promise<ProductCategory | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.productCategory.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function categoryShortId(category: Pick<ProductCategory, "id">): string {
  return category.id.slice(0, 8);
}

/**
 * Repositions a category among the categories of the SAME type.
 * newOrder <= 0 or beyond the end appends; every sibling is renumbered
 * 1..n afterwards, so duplicate display orders can never survive.
 */
export async function setCategoryDisplayOrder(categoryId: string, newOrder: number): Promise<void> {
  const target = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (target === null) {
    return;
  }
  const siblings = await prisma.productCategory.findMany({
    where: { type: target.type },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  const rest = siblings.filter((c) => c.id !== categoryId);
  const index = newOrder <= 0 || newOrder > rest.length + 1 ? rest.length : newOrder - 1;
  rest.splice(index, 0, target);
  await prisma.$transaction(
    rest.map((c, i) =>
      prisma.productCategory.update({ where: { id: c.id }, data: { displayOrder: i + 1 } }),
    ),
  );
}

/** Creates a category and places it at the requested position (0 = end). */
export async function createCategoryAtOrder(
  type: ProductType,
  name: string,
  requestedOrder: number,
): Promise<ProductCategory> {
  const count = await prisma.productCategory.count({ where: { type } });
  const category = await prisma.productCategory.create({
    data: { type, name, displayOrder: count + 1, isActive: true },
  });
  if (requestedOrder > 0 && requestedOrder <= count) {
    await setCategoryDisplayOrder(category.id, requestedOrder);
  }
  return category;
}

export async function updateCategory(
  id: string,
  data: Prisma.ProductCategoryUpdateInput,
): Promise<ProductCategory> {
  return prisma.productCategory.update({ where: { id }, data });
}

export async function categoryProductCount(categoryId: string): Promise<number> {
  return prisma.product.count({ where: { categoryId } });
}
