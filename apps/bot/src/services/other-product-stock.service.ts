import {
  OrderStatus,
  OrderType,
  prisma,
  type Order,
  type OtherProductStockItem,
  type Product,
  type User,
} from "@zedbot/database";
import { decryptSecret, encryptSecret, errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// OTHER_PRODUCT stock inventory + auto-delivery (Phase 25). Stock items are
// stored ENCRYPTED (encryptSecret / APP_SECRET); the raw content is never
// logged, admins only ever see a short masked preview, and the full
// decrypted content goes to exactly ONE buyer on delivery. Auto-delivery
// claims an item atomically (AVAILABLE -> RESERVED) BEFORE sending, so two
// concurrent orders can never receive the same item; a failed send rolls the
// claim back. Products with requiredUserInfoEnabled NEVER auto-deliver in
// this phase - they take the Phase 23 manual path (documented).
// No Service rows, no panel calls, no refunds.
// =============================================================================

export const STOCK_CONTENT_MIN = 1;
export const STOCK_CONTENT_MAX = 4000;
export const STOCK_LABEL_MAX = 100;
export const STOCK_ITEMS_PAGE_SIZE = 10;
const CLAIM_RETRIES = 3;

export const INVALID_STOCK_CONTENT_TEXT = `محتوای آیتم باید متنی بین ${STOCK_CONTENT_MIN} تا ${STOCK_CONTENT_MAX} کاراکتر باشد.`;
export const INVALID_STOCK_LABEL_TEXT = `برچسب حداکثر ${STOCK_LABEL_MAX} کاراکتر است.`;

/** Admin-facing preview: first 8 chars + ellipsis. NEVER the full content. */
export function stockContentPreview(content: string): string {
  return content.length > 8 ? `${content.slice(0, 8)}…` : content;
}

/** Stock-eligible product: sold from inventory instead of manual delivery. */
export function isStockDeliveryProduct(
  product: Pick<Product, "deliveryType" | "stockEnabled">,
): boolean {
  return product.deliveryType === "STOCK_ITEM" || product.stockEnabled;
}

// --- admin inventory management -----------------------------------------------------------

export interface StockCounts {
  available: number;
  reserved: number;
  delivered: number;
  disabled: number;
}

export async function getStockCounts(productId: string): Promise<StockCounts> {
  const [available, reserved, delivered, disabled] = await Promise.all([
    prisma.otherProductStockItem.count({ where: { productId, status: "AVAILABLE" } }),
    prisma.otherProductStockItem.count({ where: { productId, status: "RESERVED" } }),
    prisma.otherProductStockItem.count({ where: { productId, status: "DELIVERED" } }),
    prisma.otherProductStockItem.count({ where: { productId, status: "DISABLED" } }),
  ]);
  return { available, reserved, delivered, disabled };
}

export type StockProductRow = Product & { counts: StockCounts };

/**
 * OTHER_PRODUCT products for the stock admin - stock-eligible ones first,
 * then by name, each with its inventory counters.
 */
export async function listStockProducts(): Promise<StockProductRow[]> {
  const products = await prisma.product.findMany({
    where: { type: "OTHER_PRODUCT" },
    orderBy: [{ name: "asc" }],
  });
  const rows = await Promise.all(
    products.map(async (product) => ({ ...product, counts: await getStockCounts(product.id) })),
  );
  return rows.sort((a, b) => Number(isStockDeliveryProduct(b)) - Number(isStockDeliveryProduct(a)));
}

/** OTHER_PRODUCT lookup by short id (admin context; ambiguity fails). */
export async function getStockProductByShortId(shortId: string): Promise<Product | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.product.findMany({
    where: { id: { startsWith: shortId }, type: "OTHER_PRODUCT" },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export type AddStockOutcome =
  | { ok: true; item: OtherProductStockItem }
  | { ok: false; safeMessage: string };

/** Encrypts and stores ONE stock item (AVAILABLE). Never logs the content. */
export async function addStockItem(args: {
  productId: string;
  content: string;
  label: string | null;
  createdByAdminId: string;
}): Promise<AddStockOutcome> {
  const content = args.content.trim();
  if (content.length < STOCK_CONTENT_MIN || content.length > STOCK_CONTENT_MAX) {
    return { ok: false, safeMessage: INVALID_STOCK_CONTENT_TEXT };
  }
  const label = args.label?.trim() ?? "";
  if (label.length > STOCK_LABEL_MAX) {
    return { ok: false, safeMessage: INVALID_STOCK_LABEL_TEXT };
  }
  const product = await prisma.product.findUnique({ where: { id: args.productId } });
  if (product === null || product.type !== "OTHER_PRODUCT") {
    return { ok: false, safeMessage: "مورد یافت نشد." };
  }
  const item = await prisma.otherProductStockItem.create({
    data: {
      productId: product.id,
      status: "AVAILABLE",
      contentEncrypted: encryptSecret(content),
      label: label === "" ? null : label,
      createdByAdminId: args.createdByAdminId,
    },
  });
  logger.info("stock item added", { productId: product.id, itemId: item.id });
  return { ok: true, item };
}

// --- bulk add (Phase 27) --------------------------------------------------------------------
//
// One multiline message -> many items: each non-empty trimmed line becomes a
// stock item. Duplicates are detected only WITHIN the submitted batch (exact
// string after trim, first occurrence kept) - the DB is intentionally NOT
// searched for existing duplicates, because content is stored with randomized
// encryption and checking would require decrypting the whole inventory.
// Batches with more than 100 valid unique items are rejected so the admin
// splits them. Raw content is never logged and never echoed back.

export const STOCK_BULK_MAX_ITEMS = 100;
export const BULK_TOO_MANY_TEXT = "حداکثر ۱۰۰ آیتم در هر بار قابل ثبت است.";
export const BULK_NO_VALID_ITEMS_TEXT = "هیچ آیتم معتبری در متن پیدا نشد.";
export const BULK_CREATE_FAILED_TEXT = "ثبت گروهی آیتم‌ها ناموفق بود. دوباره تلاش کنید.";

export type BulkParseResult =
  | { ok: true; items: string[]; invalidCount: number; duplicateCount: number }
  | { ok: false; safeMessage: string; invalidCount: number; duplicateCount: number };

/**
 * Normalizes one multiline bulk submission: trims every line, drops empty
 * lines, counts over-length lines as invalid, dedupes exact strings within
 * the batch (first occurrence wins). Zero valid unique items or more than
 * STOCK_BULK_MAX_ITEMS fails with a safe message. Pure - no DB, no logging.
 */
export function parseBulkStockInput(text: string): BulkParseResult {
  const seen = new Set<string>();
  const items: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.length > STOCK_CONTENT_MAX) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(line)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(line);
    items.push(line);
  }
  if (items.length === 0) {
    return { ok: false, safeMessage: BULK_NO_VALID_ITEMS_TEXT, invalidCount, duplicateCount };
  }
  if (items.length > STOCK_BULK_MAX_ITEMS) {
    return { ok: false, safeMessage: BULK_TOO_MANY_TEXT, invalidCount, duplicateCount };
  }
  return { ok: true, items, invalidCount, duplicateCount };
}

export type AddStockBulkOutcome =
  | { ok: true; createdCount: number }
  | { ok: false; safeMessage: string };

/**
 * Encrypts and stores MANY stock items (all AVAILABLE, label null) in one
 * `createMany` - a single atomic INSERT, so a mid-batch DB failure creates
 * nothing. Inputs are re-validated and re-deduped defensively; raw content
 * never reaches the logs or the returned messages.
 */
export async function addStockItemsBulk(args: {
  productId: string;
  contents: string[];
  createdByAdminId: string;
}): Promise<AddStockBulkOutcome> {
  const contents = [...new Set(args.contents.map((content) => content.trim()))].filter(
    (content) => content.length > 0,
  );
  if (contents.length === 0) {
    return { ok: false, safeMessage: BULK_NO_VALID_ITEMS_TEXT };
  }
  if (contents.length > STOCK_BULK_MAX_ITEMS) {
    return { ok: false, safeMessage: BULK_TOO_MANY_TEXT };
  }
  if (contents.some((content) => content.length > STOCK_CONTENT_MAX)) {
    return { ok: false, safeMessage: INVALID_STOCK_CONTENT_TEXT };
  }
  const product = await prisma.product.findUnique({ where: { id: args.productId } });
  if (product === null || product.type !== "OTHER_PRODUCT") {
    return { ok: false, safeMessage: "مورد یافت نشد." };
  }
  try {
    const created = await prisma.otherProductStockItem.createMany({
      data: contents.map((content) => ({
        productId: product.id,
        status: "AVAILABLE" as const,
        contentEncrypted: encryptSecret(content),
        label: null,
        createdByAdminId: args.createdByAdminId,
      })),
    });
    logger.info("stock items bulk added", { productId: product.id, count: created.count });
    return { ok: true, createdCount: created.count };
  } catch (error) {
    logger.error("stock bulk add failed", {
      productId: product.id,
      requested: contents.length,
      error: errorMessage(error),
    });
    return { ok: false, safeMessage: BULK_CREATE_FAILED_TEXT };
  }
}

export interface StockItemsPage {
  items: OtherProductStockItem[];
  page: number;
  pages: number;
  total: number;
}

/** Latest items of one product, 10/page. Content stays encrypted here. */
export async function listStockItems(productId: string, page: number): Promise<StockItemsPage> {
  const total = await prisma.otherProductStockItem.count({ where: { productId } });
  const pages = Math.max(1, Math.ceil(total / STOCK_ITEMS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const items = await prisma.otherProductStockItem.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * STOCK_ITEMS_PAGE_SIZE,
    take: STOCK_ITEMS_PAGE_SIZE,
  });
  return { items, page: safePage, pages, total };
}

export async function getStockItemByShortId(
  shortId: string,
): Promise<(OtherProductStockItem & { product: Product }) | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.otherProductStockItem.findMany({
    where: { id: { startsWith: shortId } },
    include: { product: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * AVAILABLE -> DISABLED (no hard delete). Delivered/reserved items are not
 * actionable; the status guard makes a stale button harmless.
 */
export async function disableStockItem(itemId: string): Promise<boolean> {
  const updated = await prisma.otherProductStockItem.updateMany({
    where: { id: itemId, status: "AVAILABLE" },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  if (updated.count === 1) {
    logger.info("stock item disabled", { itemId });
    return true;
  }
  return false;
}

// --- stuck RESERVED items (Phase 26) --------------------------------------------------------
//
// A crash between the auto-delivery claim and its finalize/rollback leaves an
// item RESERVED forever. These admin actions make that state manageable. The
// safety rule: a RESERVED item whose related Order is COMPLETED is NOT
// touchable (it was most likely delivered and only the finalize write was
// lost - releasing it could hand the same content to a second buyer).
// Content is never decrypted or logged here.

export const RESERVED_RELEASED_TEXT = "رزرو آیتم آزاد شد و به موجودی برگشت ✅";
export const RESERVED_DISABLED_TEXT = "آیتم رزروشده غیرفعال شد ⏸";
export const ITEM_DELIVERED_IMMUTABLE_TEXT = "آیتم تحویل‌شده قابل تغییر نیست.";
export const ORDER_COMPLETED_IMMUTABLE_TEXT = "این سفارش تکمیل شده و آیتم قابل آزادسازی نیست.";
export const ITEM_NOT_RESERVED_TEXT = "این آیتم رزرو نیست.";

export interface ReservedActionResult {
  ok: boolean;
  safeMessage: string;
  productId?: string;
}

/**
 * Shared guard: resolves the item, refuses DELIVERED / non-RESERVED states,
 * and refuses RESERVED items whose related order already COMPLETED. A
 * missing related order is allowed (logged with ids only).
 */
async function checkReservedActionable(
  itemId: string,
): Promise<{ ok: true; item: OtherProductStockItem } | { ok: false; result: ReservedActionResult }> {
  const item = await prisma.otherProductStockItem.findUnique({ where: { id: itemId } });
  if (item === null) {
    return { ok: false, result: { ok: false, safeMessage: "مورد یافت نشد." } };
  }
  if (item.status === "DELIVERED") {
    return {
      ok: false,
      result: { ok: false, safeMessage: ITEM_DELIVERED_IMMUTABLE_TEXT, productId: item.productId },
    };
  }
  if (item.status !== "RESERVED") {
    return {
      ok: false,
      result: { ok: false, safeMessage: ITEM_NOT_RESERVED_TEXT, productId: item.productId },
    };
  }
  if (item.deliveredOrderId !== null) {
    const order = await prisma.order.findUnique({
      where: { id: item.deliveredOrderId },
      select: { status: true },
    });
    if (order === null) {
      logger.warn("reserved stock item points at a missing order - action allowed", {
        itemId: item.id,
        orderId: item.deliveredOrderId,
      });
    } else if (order.status === OrderStatus.COMPLETED) {
      return {
        ok: false,
        result: {
          ok: false,
          safeMessage: ORDER_COMPLETED_IMMUTABLE_TEXT,
          productId: item.productId,
        },
      };
    }
  }
  return { ok: true, item };
}

/** RESERVED -> AVAILABLE (claim fields cleared; content/label untouched). */
export async function releaseReservedStockItem(itemId: string): Promise<ReservedActionResult> {
  const check = await checkReservedActionable(itemId);
  if (!check.ok) {
    return check.result;
  }
  const updated = await prisma.otherProductStockItem.updateMany({
    where: { id: check.item.id, status: "RESERVED" },
    data: {
      status: "AVAILABLE",
      deliveredOrderId: null,
      deliveredToUserId: null,
      deliveredAt: null,
    },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      safeMessage: "وضعیت آیتم تغییر کرده است.",
      productId: check.item.productId,
    };
  }
  logger.info("reserved stock item released", { itemId: check.item.id });
  return { ok: true, safeMessage: RESERVED_RELEASED_TEXT, productId: check.item.productId };
}

/** RESERVED -> DISABLED (claim fields cleared, disabledAt stamped). */
export async function disableReservedStockItem(itemId: string): Promise<ReservedActionResult> {
  const check = await checkReservedActionable(itemId);
  if (!check.ok) {
    return check.result;
  }
  const updated = await prisma.otherProductStockItem.updateMany({
    where: { id: check.item.id, status: "RESERVED" },
    data: {
      status: "DISABLED",
      disabledAt: new Date(),
      deliveredOrderId: null,
      deliveredToUserId: null,
      deliveredAt: null,
    },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      safeMessage: "وضعیت آیتم تغییر کرده است.",
      productId: check.item.productId,
    };
  }
  logger.info("reserved stock item disabled", { itemId: check.item.id });
  return { ok: true, safeMessage: RESERVED_DISABLED_TEXT, productId: check.item.productId };
}

/** Toggles per-product stock delivery (Product.stockEnabled). */
export async function toggleProductStockEnabled(productId: string): Promise<Product | null> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (product === null || product.type !== "OTHER_PRODUCT") {
    return null;
  }
  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { stockEnabled: !product.stockEnabled },
  });
  logger.info("product stock delivery toggled", {
    productId: product.id,
    stockEnabled: updated.stockEnabled,
  });
  return updated;
}

// --- auto-delivery -------------------------------------------------------------------------

/** The message the buyer receives; the content is HTML-escaped, never a file. */
export function buildStockDeliveryMessage(productName: string, content: string): string {
  return [
    "سفارش شما آماده شد ✅",
    "",
    `محصول: ${escapeHtml(productName)}`,
    "",
    `<code>${escapeHtml(content)}</code>`,
  ].join("\n");
}

export type AutoDeliverOutcome =
  | { status: "DELIVERED"; item: OtherProductStockItem }
  | { status: "ALREADY_DELIVERED" }
  | { status: "NOT_ELIGIBLE" }
  | { status: "NO_STOCK" }
  | { status: "SEND_FAILED" }
  | { status: "ERROR"; error: string };

type OrderWithRelations = Order & { product: Product | null; user: User };

/** Oldest AVAILABLE item first; atomically RESERVE it for this order. */
async function claimStockItem(
  order: OrderWithRelations,
): Promise<OtherProductStockItem | null> {
  for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
    const candidate = await prisma.otherProductStockItem.findFirst({
      where: { productId: order.productId ?? "", status: "AVAILABLE" },
      orderBy: { createdAt: "asc" },
    });
    if (candidate === null) {
      return null;
    }
    const claimed = await prisma.otherProductStockItem.updateMany({
      where: { id: candidate.id, status: "AVAILABLE" },
      data: {
        status: "RESERVED",
        deliveredOrderId: order.id,
        deliveredToUserId: order.userId,
      },
    });
    if (claimed.count === 1) {
      return prisma.otherProductStockItem.findUnique({ where: { id: candidate.id } });
    }
    // Another order claimed this candidate between read and CAS - try the next.
  }
  return null;
}

/**
 * Auto-delivers one PAID OTHER_PRODUCT order from stock:
 *
 *   claim (AVAILABLE -> RESERVED, atomic - two orders can never share an
 *   item) -> decrypt + send -> finalize (RESERVED -> DELIVERED + Order ->
 *   COMPLETED in one transaction). A failed send rolls the claim back to
 *   AVAILABLE (scoped to our own order id). A RESERVED item already
 *   carrying this order id (crash between claim and finalize) is RESUMED
 *   instead of claiming a second item; that crash window means the user
 *   could receive the same item twice on resume - never two different
 *   items, never another user's item (documented).
 *
 * NOT_ELIGIBLE (not stock delivery / requiredUserInfoEnabled) and NO_STOCK
 * leave the order untouched for the Phase 23 manual path.
 */
export async function autoDeliverStockOrder(
  api: DeliverySendApi,
  orderId: string,
): Promise<AutoDeliverOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { product: true, user: true },
  })) as OrderWithRelations | null;
  if (order === null || order.type !== OrderType.OTHER_PRODUCT || order.product === null) {
    return { status: "NOT_ELIGIBLE" };
  }
  if (order.status === OrderStatus.COMPLETED) {
    return { status: "ALREADY_DELIVERED" };
  }
  if (order.status !== OrderStatus.PAID) {
    return { status: "ERROR", error: `order status is ${order.status}` };
  }
  if (!isStockDeliveryProduct(order.product) || order.product.requiredUserInfoEnabled) {
    // requiredUserInfoEnabled products always take the manual path in Phase 25.
    return { status: "NOT_ELIGIBLE" };
  }

  // Idempotency: an item already tied to this order wins over a new claim.
  const existing = await prisma.otherProductStockItem.findFirst({
    where: { deliveredOrderId: order.id, status: { in: ["RESERVED", "DELIVERED"] } },
  });
  if (existing?.status === "DELIVERED") {
    await prisma.order.updateMany({
      where: { id: order.id, status: OrderStatus.PAID },
      data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
    });
    return { status: "ALREADY_DELIVERED" };
  }

  const item = existing ?? (await claimStockItem(order));
  if (item === null) {
    return { status: "NO_STOCK" };
  }

  let content: string;
  try {
    content = decryptSecret(item.contentEncrypted);
  } catch (err) {
    logger.error("stock item decryption failed", { itemId: item.id, error: errorMessage(err) });
    // Unreadable item: release the claim and treat as no stock (the broken
    // item stays RESERVED-free but is disabled so it is never retried).
    await prisma.otherProductStockItem.updateMany({
      where: { id: item.id, status: "RESERVED", deliveredOrderId: order.id },
      data: {
        status: "DISABLED",
        disabledAt: new Date(),
        deliveredOrderId: null,
        deliveredToUserId: null,
      },
    });
    return { status: "NO_STOCK" };
  }

  try {
    await api.sendMessage(
      order.user.telegramId.toString(),
      buildStockDeliveryMessage(order.product.name, content),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logger.warn("stock auto-delivery send failed", {
      orderId: order.id,
      itemId: item.id,
      error: errorMessage(err),
    });
    // Roll back OUR claim only - the item returns to the pool untouched.
    await prisma.otherProductStockItem.updateMany({
      where: { id: item.id, status: "RESERVED", deliveredOrderId: order.id },
      data: { status: "AVAILABLE", deliveredOrderId: null, deliveredToUserId: null },
    });
    return { status: "SEND_FAILED" };
  }

  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.otherProductStockItem.updateMany({
        where: { id: item.id, status: "RESERVED", deliveredOrderId: order.id },
        data: { status: "DELIVERED", deliveredAt: now },
      }),
      prisma.order.updateMany({
        where: { id: order.id, status: OrderStatus.PAID },
        data: { status: OrderStatus.COMPLETED, completedAt: now },
      }),
    ]);
  } catch (err) {
    // Content already reached the user - retry the finalize once, then log
    // loudly (the RESERVED item still blocks re-delivery of the order).
    logger.error("stock delivery finalize failed after send", {
      orderId: order.id,
      itemId: item.id,
      error: errorMessage(err),
    });
    try {
      await prisma.$transaction([
        prisma.otherProductStockItem.updateMany({
          where: { id: item.id, status: "RESERVED", deliveredOrderId: order.id },
          data: { status: "DELIVERED", deliveredAt: now },
        }),
        prisma.order.updateMany({
          where: { id: order.id, status: OrderStatus.PAID },
          data: { status: OrderStatus.COMPLETED, completedAt: now },
        }),
      ]);
    } catch (retryErr) {
      logger.error("stock delivery finalize retry failed - manual review needed", {
        orderId: order.id,
        itemId: item.id,
        error: errorMessage(retryErr),
      });
    }
  }
  const delivered = await prisma.otherProductStockItem.findUnique({ where: { id: item.id } });
  logger.info("stock auto-delivery succeeded", { orderId: order.id, itemId: item.id });
  return { status: "DELIVERED", item: delivered ?? item };
}
