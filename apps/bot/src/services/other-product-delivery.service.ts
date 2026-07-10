import {
  OrderStatus,
  OrderType,
  prisma,
  type Order,
  type OtherProductOrder,
  type Prisma,
  type Product,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";

// =============================================================================
// OTHER_PRODUCT manual delivery (Phase 23). After payment the PAID Order gets
// ONE OtherProductOrder record (the schema had the full model - no
// migration): WAITING_USER_INFO when the product asks for user info, else
// WAITING_ADMIN_DELIVERY. An admin delivers text; the user receives it and
// the record becomes DELIVERED (Order -> COMPLETED). NO Service row, NO
// panel call, NO provisioning, NO refunds/cancellation - manual text
// delivery only.
// =============================================================================

export const USER_INFO_MIN = 1;
export const USER_INFO_MAX = 2000;
export const DELIVERY_TEXT_MIN = 1;
export const DELIVERY_TEXT_MAX = 4000;
export const MANUAL_ORDERS_PAGE_SIZE = 10;

export const INVALID_USER_INFO_TEXT = `اطلاعات باید متنی بین ${USER_INFO_MIN} تا ${USER_INFO_MAX} کاراکتر باشد.`;
export const INVALID_DELIVERY_TEXT = `متن تحویل باید بین ${DELIVERY_TEXT_MIN} تا ${DELIVERY_TEXT_MAX} کاراکتر باشد.`;
export const ALREADY_DELIVERED_TEXT = "این سفارش قبلاً تحویل شده است.";
export const NOT_READY_TEXT = "این سفارش هنوز آماده تحویل نیست.";
export const DELIVERY_SEND_FAILED_TEXT = "ارسال پیام به کاربر ناموفق بود؛ سفارش تحویل‌خورده نشد.";
export const USER_INFO_SAVED_TEXT =
  "اطلاعات سفارش ثبت شد ✅\nسفارش شما در انتظار تحویل توسط ادمین است.";
export const WAITING_DELIVERY_USER_TEXT = "سفارش شما ثبت شد و در انتظار تحویل توسط ادمین است.";

export type ManualOrderWithRelations = OtherProductOrder & {
  order: Order;
  user: User;
  product: Product;
};

export function manualOrderShortId(record: Pick<OtherProductOrder, "id">): string {
  return record.id.slice(0, 8);
}

/** The user-facing «تکمیل اطلاعات سفارش 📝» button (order short id based). */
export function userInfoButtonKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard().text("تکمیل اطلاعات سفارش 📝", `user:op:info:${orderId.slice(0, 8)}`);
}

/** The prompt asking the user for the product's required information. */
export function userInfoPromptText(promptText: string | null): string {
  const lines = ["برای تکمیل سفارش، اطلاعات زیر را ارسال کنید:"];
  if (promptText !== null && promptText !== "") {
    lines.push("", promptText);
  }
  return lines.join("\n");
}

// --- initialization (after payment) ----------------------------------------------------

export type InitManualDeliveryOutcome =
  | {
      ok: true;
      record: ManualOrderWithRelations;
      created: boolean;
      requiresInfo: boolean;
      promptText: string | null;
    }
  | { ok: false; error: string };

/**
 * Creates THE OtherProductOrder for a PAID OTHER_PRODUCT order (idempotent -
 * orderId is unique, a repeated approval/init returns the existing record).
 * Status: WAITING_USER_INFO when the product requires info and none was
 * submitted yet, else WAITING_ADMIN_DELIVERY.
 */
export async function initManualDelivery(orderId: string): Promise<InitManualDeliveryOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { product: true, user: true },
  });
  if (order === null || order.type !== OrderType.OTHER_PRODUCT) {
    return { ok: false, error: "order is not an OTHER_PRODUCT order" };
  }
  if (order.product === null || order.productId === null) {
    return { ok: false, error: "order has no product" };
  }
  if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.COMPLETED) {
    return { ok: false, error: `order status is ${order.status}` };
  }
  const requiresInfo = order.product.requiredUserInfoEnabled;
  const promptText = order.product.requiredUserInfoPromptText ?? null;

  const existing = await prisma.otherProductOrder.findUnique({
    where: { orderId: order.id },
    include: { order: true, user: true, product: true },
  });
  if (existing !== null) {
    return {
      ok: true,
      record: existing,
      created: false,
      requiresInfo: existing.status === "WAITING_USER_INFO",
      promptText,
    };
  }
  try {
    const record = await prisma.otherProductOrder.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        status: requiresInfo ? "WAITING_USER_INFO" : "WAITING_ADMIN_DELIVERY",
      },
      include: { order: true, user: true, product: true },
    });
    logger.info("manual delivery initialized", {
      orderId: order.id,
      recordId: record.id,
      status: record.status,
    });
    return { ok: true, record, created: true, requiresInfo, promptText };
  } catch (err) {
    // Unique orderId collision from a concurrent init: load the winner.
    const raced = await prisma.otherProductOrder.findUnique({
      where: { orderId: order.id },
      include: { order: true, user: true, product: true },
    });
    if (raced !== null) {
      return {
        ok: true,
        record: raced,
        created: false,
        requiresInfo: raced.status === "WAITING_USER_INFO",
        promptText,
      };
    }
    logger.error("manual delivery init failed", { orderId, error: errorMessage(err) });
    return { ok: false, error: errorMessage(err) };
  }
}

// --- user required-info submission ------------------------------------------------------

/**
 * Owner-scoped lookup by ORDER short id for the «تکمیل اطلاعات سفارش 📝»
 * button. Only WAITING_USER_INFO records resolve; ambiguous prefixes fail.
 */
export async function getPendingInfoOrderByShortId(
  shortId: string,
  userId: string,
): Promise<ManualOrderWithRelations | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.otherProductOrder.findMany({
    where: {
      userId,
      status: "WAITING_USER_INFO",
      order: { is: { id: { startsWith: shortId } } },
    },
    include: { order: true, user: true, product: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export type SubmitUserInfoOutcome =
  | { ok: true; record: ManualOrderWithRelations }
  | { ok: false; error: string; safeUserMessage: string };

/**
 * Stores the user's info and flips WAITING_USER_INFO ->
 * WAITING_ADMIN_DELIVERY (status-guarded updateMany, so a double submit
 * cannot overwrite info that already moved the order forward).
 */
export async function submitUserInfo(
  userId: string,
  recordId: string,
  rawText: string,
): Promise<SubmitUserInfoOutcome> {
  const text = rawText.trim();
  if (text.length < USER_INFO_MIN || text.length > USER_INFO_MAX) {
    return { ok: false, error: "invalid info length", safeUserMessage: INVALID_USER_INFO_TEXT };
  }
  const updated = await prisma.otherProductOrder.updateMany({
    where: { id: recordId, userId, status: "WAITING_USER_INFO" },
    data: { userProvidedInfoText: text, status: "WAITING_ADMIN_DELIVERY" },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      error: "record not in WAITING_USER_INFO",
      safeUserMessage: "این سفارش در انتظار اطلاعات نیست.",
    };
  }
  const record = await prisma.otherProductOrder.findUnique({
    where: { id: recordId },
    include: { order: true, user: true, product: true },
  });
  if (record === null) {
    return { ok: false, error: "record vanished", safeUserMessage: "مورد یافت نشد." };
  }
  logger.info("manual order user info submitted", { recordId, orderId: record.orderId });
  return { ok: true, record };
}

// --- admin list / detail ----------------------------------------------------------------

export interface ManualOrdersPage {
  records: ManualOrderWithRelations[];
  page: number;
  pages: number;
  total: number;
  waitingInfoCount: number;
  readyCount: number;
  deliveredCount: number;
}

/** Open (undelivered) manual orders, newest first, with status counters. */
export async function listManualOrders(page: number): Promise<ManualOrdersPage> {
  const where: Prisma.OtherProductOrderWhereInput = {
    status: { in: ["WAITING_USER_INFO", "WAITING_ADMIN_DELIVERY"] },
  };
  const [total, waitingInfoCount, readyCount, deliveredCount] = await Promise.all([
    prisma.otherProductOrder.count({ where }),
    prisma.otherProductOrder.count({ where: { status: "WAITING_USER_INFO" } }),
    prisma.otherProductOrder.count({ where: { status: "WAITING_ADMIN_DELIVERY" } }),
    prisma.otherProductOrder.count({ where: { status: "DELIVERED" } }),
  ]);
  const pages = Math.max(1, Math.ceil(total / MANUAL_ORDERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const records = await prisma.otherProductOrder.findMany({
    where,
    include: { order: true, user: true, product: true },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * MANUAL_ORDERS_PAGE_SIZE,
    take: MANUAL_ORDERS_PAGE_SIZE,
  });
  return { records, page: safePage, pages, total, waitingInfoCount, readyCount, deliveredCount };
}

/** Admin-context lookup by OtherProductOrder short id; ambiguity fails. */
export async function getManualOrderByShortId(
  shortId: string,
): Promise<ManualOrderWithRelations | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.otherProductOrder.findMany({
    where: { id: { startsWith: shortId } },
    include: { order: true, user: true, product: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- delivery ---------------------------------------------------------------------------

/** Minimal Telegram surface (mock-friendly, mirrors the receipt notifier). */
export interface DeliverySendApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

/** The message the buyer receives on delivery. */
export function buildDeliveryUserMessage(productName: string, deliveryText: string): string {
  return [
    "سفارش شما آماده شد ✅",
    "",
    `محصول: ${escapeHtml(productName)}`,
    "",
    escapeHtml(deliveryText),
  ].join("\n");
}

export type DeliverOutcome =
  | { ok: true; record: OtherProductOrder }
  | { ok: false; error: string; safeMessage: string };

/**
 * Delivers one manual order, per the required ordering: re-check status ->
 * send to the user -> ONLY on a successful send mark DELIVERED (status-
 * guarded updateMany; a concurrent delivery that marked first wins and this
 * one reports "already delivered") and complete the Order. A failed send
 * changes nothing.
 */
export async function deliverManualOrder(
  api: DeliverySendApi,
  args: { recordId: string; adminId: string; deliveryText: string },
): Promise<DeliverOutcome> {
  const deliveryText = args.deliveryText.trim();
  if (deliveryText.length < DELIVERY_TEXT_MIN || deliveryText.length > DELIVERY_TEXT_MAX) {
    return { ok: false, error: "invalid delivery text", safeMessage: INVALID_DELIVERY_TEXT };
  }
  const record = await prisma.otherProductOrder.findUnique({
    where: { id: args.recordId },
    include: { order: true, user: true, product: true },
  });
  if (record === null) {
    return { ok: false, error: "record not found", safeMessage: "مورد یافت نشد." };
  }
  if (record.status === "DELIVERED") {
    return { ok: false, error: "already delivered", safeMessage: ALREADY_DELIVERED_TEXT };
  }
  if (record.status !== "WAITING_ADMIN_DELIVERY") {
    return { ok: false, error: `record status is ${record.status}`, safeMessage: NOT_READY_TEXT };
  }

  try {
    await api.sendMessage(
      record.user.telegramId.toString(),
      buildDeliveryUserMessage(record.product.name, deliveryText),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logger.warn("manual delivery send failed", {
      recordId: record.id,
      orderId: record.orderId,
      error: errorMessage(err),
    });
    return { ok: false, error: "user send failed", safeMessage: DELIVERY_SEND_FAILED_TEXT };
  }

  const now = new Date();
  const marked = await prisma.otherProductOrder.updateMany({
    where: { id: record.id, status: "WAITING_ADMIN_DELIVERY" },
    data: {
      status: "DELIVERED",
      adminDeliveryText: deliveryText,
      deliveredByAdminId: args.adminId,
      deliveredAt: now,
    },
  });
  if (marked.count !== 1) {
    // A concurrent delivery won between our check and mark. The user may
    // have received two messages; the DB stays consistent (first wins).
    logger.warn("manual delivery lost concurrency race after send", { recordId: record.id });
    return { ok: false, error: "concurrent delivery", safeMessage: ALREADY_DELIVERED_TEXT };
  }
  await prisma.order.updateMany({
    where: { id: record.orderId, status: OrderStatus.PAID },
    data: { status: OrderStatus.COMPLETED, completedAt: now },
  });
  const updated = await prisma.otherProductOrder.findUnique({ where: { id: record.id } });
  logger.info("manual order delivered", {
    recordId: record.id,
    orderId: record.orderId,
    adminId: args.adminId,
  });
  return { ok: true, record: updated ?? record };
}

// --- reminder / admin notification --------------------------------------------------------

/**
 * Re-sends the required-info prompt (+ button) to the user and bumps the
 * reminder counters. Send failures are reported, nothing rolls back.
 */
export async function remindUserInfo(
  api: DeliverySendApi,
  recordId: string,
): Promise<{ ok: boolean }> {
  const record = await prisma.otherProductOrder.findUnique({
    where: { id: recordId },
    include: { user: true, product: true, order: true },
  });
  if (record === null || record.status !== "WAITING_USER_INFO") {
    return { ok: false };
  }
  try {
    await api.sendMessage(
      record.user.telegramId.toString(),
      userInfoPromptText(record.product.requiredUserInfoPromptText),
      { reply_markup: userInfoButtonKeyboard(record.orderId) },
    );
  } catch (err) {
    logger.warn("manual order info reminder failed", {
      recordId: record.id,
      error: errorMessage(err),
    });
    return { ok: false };
  }
  await prisma.otherProductOrder.update({
    where: { id: record.id },
    data: { userInfoReminderCount: { increment: 1 }, lastUserInfoReminderAt: new Date() },
  });
  return { ok: true };
}

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/**
 * Tells every ACTIVE admin a manual order is ready for delivery. Never
 * throws; per-admin sends are fault-isolated (mirrors the receipt
 * notification pattern). Returns how many admins were reached.
 */
export async function notifyAdminsAboutManualOrder(
  api: DeliverySendApi,
  record: ManualOrderWithRelations,
): Promise<number> {
  let reached = 0;
  try {
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { telegramId: true },
    });
    const infoLine =
      record.userProvidedInfoText === null || record.userProvidedInfoText === ""
        ? "اطلاعات کاربر: —"
        : "اطلاعات کاربر: ثبت شده ✅";
    const text = [
      "سفارش دستی جدید 📦",
      "",
      `سفارش: <code>${record.order.id.slice(0, 8)}</code>`,
      `محصول: ${escapeHtml(record.product.name)}`,
      `مبلغ: ${formatToman(record.order.finalPriceToman)}`,
      `کاربر: <code>${record.user.telegramId}</code>${
        record.user.username === null || record.user.username === ""
          ? ""
          : ` (@${escapeHtml(record.user.username)})`
      }`,
      infoLine,
    ].join("\n");
    const keyboard = new InlineKeyboard()
      .text("مشاهده سفارش 📦", `admin:mo:view:${manualOrderShortId(record)}`)
      .row()
      .text("سفارش‌های دستی 📦", CB.ADMIN_OTHER_PRODUCTS);
    for (const admin of admins) {
      try {
        await api.sendMessage(admin.telegramId.toString(), text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        reached += 1;
      } catch (err) {
        logger.warn("manual order admin notification failed", {
          recordId: record.id,
          error: errorMessage(err),
        });
      }
    }
  } catch (err) {
    logger.warn("manual order admin notification failed entirely", {
      recordId: record.id,
      error: errorMessage(err),
    });
  }
  return reached;
}
