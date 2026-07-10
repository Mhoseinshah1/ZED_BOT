import {
  OrderType,
  prisma,
  type Order,
  type OtherProductOrder,
  type OtherProductStockItem,
  type Product,
} from "@zedbot/database";
import { decryptSecret, errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";

// =============================================================================
// «سفارش‌های من 🧾» (Phase 29) - READ-ONLY user history over OTHER_PRODUCT
// orders. Every query is scoped to the current user's id; ambiguous short
// ids fail. Covers all three fulfilment shapes: the Phase 23 manual record,
// the Phase 25 stock auto-delivery (no OtherProductOrder row - the stock
// item is the history), and the paid-but-not-yet-initialized edge. Stock
// content is decrypted ONLY for the owner of the exact delivered item; a
// decrypt failure shows a safe message and logs ids only. Nothing here
// mutates payments, orders, deliveries or stock.
// =============================================================================

export const USER_ORDERS_PAGE_SIZE = 10;
export const STOCK_CONTENT_UNAVAILABLE_TEXT =
  "محتوای تحویل قابل نمایش نیست. لطفاً با پشتیبانی تماس بگیرید.";

/** One order with everything the user view needs (product may be deleted). */
export type UserOtherProductOrderRow = Order & {
  product: Product | null;
  otherProductOrder: OtherProductOrder | null;
  /** The DELIVERED stock item of this order (auto-delivery history), if any. */
  stockItem: OtherProductStockItem | null;
};

export interface UserOtherProductOrdersPage {
  rows: UserOtherProductOrderRow[];
  page: number;
  pages: number;
  total: number;
}

/** Product name for display - snapshot first, live product as fallback. */
export function orderProductName(row: UserOtherProductOrderRow): string {
  const snapshot = row.productNameSnapshot;
  if (snapshot !== null && snapshot !== "") {
    return snapshot;
  }
  return row.product?.name ?? "محصول";
}

export type UserOrderDisplayStatus =
  | "waiting_info"
  | "waiting_delivery"
  | "delivered_manual"
  | "delivered_stock"
  | "pending"
  | "closed";

/**
 * Collapses the three fulfilment shapes into one user-facing status. The
 * manual record wins when present; a DELIVERED stock item marks the
 * auto-delivery path; otherwise the parent Order status decides.
 */
export function deriveUserOrderStatus(row: UserOtherProductOrderRow): UserOrderDisplayStatus {
  const manual = row.otherProductOrder;
  if (manual !== null) {
    switch (manual.status) {
      case "WAITING_USER_INFO":
        return "waiting_info";
      case "PAID":
      case "WAITING_ADMIN_DELIVERY":
        return "waiting_delivery";
      case "DELIVERED":
        return "delivered_manual";
      default:
        // CANCELLED / REFUNDED / ... - read-only display, no flows exist.
        return "closed";
    }
  }
  if (row.stockItem !== null) {
    return "delivered_stock";
  }
  switch (row.status) {
    case "COMPLETED":
      return "delivered_stock";
    case "FAILED":
    case "CANCELLED":
    case "REFUNDED":
      return "closed";
    default:
      // PAID (approval done, init pending) and any pre-payment edge.
      return "pending";
  }
}

export const USER_ORDER_STATUS_ICON: Record<UserOrderDisplayStatus, string> = {
  waiting_info: "📝",
  waiting_delivery: "⏳",
  delivered_manual: "✅",
  delivered_stock: "✅",
  pending: "⏳",
  closed: "❌",
};

export const USER_ORDER_STATUS_LABEL: Record<UserOrderDisplayStatus, string> = {
  waiting_info: "در انتظار اطلاعات شما 📝",
  waiting_delivery: "در انتظار تحویل ادمین ⏳",
  delivered_manual: "تحویل‌شده ✅",
  delivered_stock: "تحویل‌شده (خودکار) ✅",
  pending: "در حال آماده‌سازی ⏳",
  closed: "بسته‌شده ❌",
};

/** Attaches each order's DELIVERED stock item (auto-delivery history). */
async function attachStockItems(
  orders: (Order & { product: Product | null; otherProductOrder: OtherProductOrder | null })[],
): Promise<UserOtherProductOrderRow[]> {
  if (orders.length === 0) {
    return [];
  }
  const items = await prisma.otherProductStockItem.findMany({
    where: { deliveredOrderId: { in: orders.map((order) => order.id) }, status: "DELIVERED" },
  });
  const byOrder = new Map(items.map((item) => [item.deliveredOrderId, item]));
  return orders.map((order) => ({ ...order, stockItem: byOrder.get(order.id) ?? null }));
}

/** The current user's OTHER_PRODUCT orders, newest first, 10/page. */
export async function listUserOtherProductOrders(
  userId: string,
  page: number,
): Promise<UserOtherProductOrdersPage> {
  const where = { userId, type: OrderType.OTHER_PRODUCT };
  const total = await prisma.order.count({ where });
  const pages = Math.max(1, Math.ceil(total / USER_ORDERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const orders = await prisma.order.findMany({
    where,
    include: { product: true, otherProductOrder: true },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * USER_ORDERS_PAGE_SIZE,
    take: USER_ORDERS_PAGE_SIZE,
  });
  return { rows: await attachStockItems(orders), page: safePage, pages, total };
}

/**
 * Owner-scoped detail lookup by ORDER short id. Only the current user's
 * OTHER_PRODUCT orders resolve; an ambiguous prefix fails (take 2).
 */
export async function getUserOtherProductOrderDetail(
  userId: string,
  orderShortId: string,
): Promise<UserOtherProductOrderRow | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(orderShortId)) {
    return null;
  }
  const matches = await prisma.order.findMany({
    where: { id: { startsWith: orderShortId }, userId, type: OrderType.OTHER_PRODUCT },
    include: { product: true, otherProductOrder: true },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  const [row] = await attachStockItems(matches);
  return row;
}

/**
 * The delivered MANUAL text, only when it is really the current user's
 * delivered record (null otherwise - nothing to show).
 */
export function visibleManualDeliveryText(
  row: UserOtherProductOrderRow,
  userId: string,
): string | null {
  const manual = row.otherProductOrder;
  if (
    manual === null ||
    manual.userId !== userId ||
    manual.status !== "DELIVERED" ||
    manual.adminDeliveryText === null ||
    manual.adminDeliveryText === ""
  ) {
    return null;
  }
  return manual.adminDeliveryText;
}

export type DeliveredStockContent =
  | { ok: true; content: string }
  | { ok: false; safeMessage: string };

/**
 * Decrypts the auto-delivered stock content for its owner - and ONLY then:
 * the order must belong to the user, the item must be DELIVERED, and its
 * deliveredOrderId/deliveredToUserId must match this exact order and user.
 * Returns null when there is nothing to show; a decrypt failure returns the
 * safe support message and logs ids only (never content).
 */
export function getDeliveredStockContentForUser(
  row: UserOtherProductOrderRow,
  userId: string,
): DeliveredStockContent | null {
  const item = row.stockItem;
  if (
    item === null ||
    row.userId !== userId ||
    item.status !== "DELIVERED" ||
    item.deliveredOrderId !== row.id ||
    item.deliveredToUserId !== userId
  ) {
    return null;
  }
  try {
    return { ok: true, content: decryptSecret(item.contentEncrypted) };
  } catch (err) {
    logger.warn("delivered stock content decrypt failed for user view", {
      orderId: row.id,
      itemId: item.id,
      error: errorMessage(err),
    });
    return { ok: false, safeMessage: STOCK_CONTENT_UNAVAILABLE_TEXT };
  }
}
