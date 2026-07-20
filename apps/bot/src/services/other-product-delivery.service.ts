import {
  OrderStatus,
  OrderType,
  prisma,
  type Order,
  type OtherProductOrder,
  type Prisma,
  type Product,
  type ProductCategory,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import {
  DELIVERY_REFERENCE_LABEL,
  ensureOrderDeliveryReference,
} from "./other-product-naming.service.js";

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
  "اطلاعات شما با موفقیت ثبت شد و سفارش در انتظار تحویل است.";
export const WAITING_DELIVERY_USER_TEXT = "سفارش شما ثبت شد و در انتظار تحویل توسط ادمین است.";

export type ManualOrderWithRelations = OtherProductOrder & {
  order: Order;
  user: User;
  product: Product;
};

/** Display-path variant (list/search/detail) with the product's category. */
export type ManualOrderDetail = OtherProductOrder & {
  order: Order;
  user: User;
  product: Product & { category: ProductCategory };
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
  const lines = ["اطلاعات موردنیاز برای این سفارش را ارسال کنید:"];
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
  // Naming phase: the delivery reference exists BEFORE the record enters the
  // admin queue (CAS-persisted, never throws - naming cannot block the init).
  await ensureOrderDeliveryReference(order.id);
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
    // Specialized-workflows phase: the submit handler notifies the admins
    // right after this flip, so the exactly-once notification stamp is
    // claimed HERE by the same status CAS - the specialized dispatch /
    // completion bridge can never send a second "ready" notice afterwards.
    data: {
      userProvidedInfoText: text,
      status: "WAITING_ADMIN_DELIVERY",
      fulfillmentAdminsNotifiedAt: new Date(),
    },
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

/**
 * Phase 24 list filters. "open" = both undelivered statuses. The
 * specialized-workflows phase ADDS "stock" (paid orders parked as
 * AWAITING_STOCK) without touching the four original filters' semantics.
 */
export type ManualOrderFilter = "open" | "info" | "ready" | "delivered" | "stock";

const FILTER_WHERE: Record<ManualOrderFilter, Prisma.OtherProductOrderWhereInput> = {
  open: { status: { in: ["WAITING_USER_INFO", "WAITING_ADMIN_DELIVERY"] } },
  info: { status: "WAITING_USER_INFO" },
  ready: { status: "WAITING_ADMIN_DELIVERY" },
  delivered: { status: "DELIVERED" },
  stock: { status: "AWAITING_STOCK" },
};

const DETAIL_INCLUDE = {
  order: true,
  user: true,
  product: { include: { category: true } },
} as const;

export interface ManualOrdersPage {
  filter: ManualOrderFilter;
  records: ManualOrderDetail[];
  page: number;
  pages: number;
  total: number;
  waitingInfoCount: number;
  readyCount: number;
  deliveredCount: number;
  /** Specialized-workflows phase: paid orders parked as AWAITING_STOCK. */
  awaitingStockCount: number;
}

/**
 * Manual orders by filter (Phase 24), 10/page, with global status counters.
 * open/info/ready sort by createdAt desc; delivered sorts by deliveredAt
 * desc (updatedAt/createdAt as tiebreak-fallbacks for legacy rows).
 */
export async function listManualOrders(
  filter: ManualOrderFilter,
  page: number,
): Promise<ManualOrdersPage> {
  const where = FILTER_WHERE[filter];
  const [total, waitingInfoCount, readyCount, deliveredCount, awaitingStockCount] =
    await Promise.all([
      prisma.otherProductOrder.count({ where }),
      prisma.otherProductOrder.count({ where: FILTER_WHERE.info }),
      prisma.otherProductOrder.count({ where: FILTER_WHERE.ready }),
      prisma.otherProductOrder.count({ where: FILTER_WHERE.delivered }),
      prisma.otherProductOrder.count({ where: FILTER_WHERE.stock }),
    ]);
  const pages = Math.max(1, Math.ceil(total / MANUAL_ORDERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const orderBy: Prisma.OtherProductOrderOrderByWithRelationInput[] =
    filter === "delivered"
      ? [{ deliveredAt: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }]
      : [{ createdAt: "desc" }];
  const records = await prisma.otherProductOrder.findMany({
    where,
    include: DETAIL_INCLUDE,
    orderBy,
    skip: (safePage - 1) * MANUAL_ORDERS_PAGE_SIZE,
    take: MANUAL_ORDERS_PAGE_SIZE,
  });
  return {
    filter,
    records,
    page: safePage,
    pages,
    total,
    waitingInfoCount,
    readyCount,
    deliveredCount,
    awaitingStockCount,
  };
}

export const SEARCH_QUERY_MAX = 100;

/**
 * Admin manual-order search (Phase 24), up to 10 results newest first.
 * A uuid-prefix-looking query matches the OtherProductOrder id OR the
 * parent Order id (startsWith); a reference-shaped query matches the exact
 * parent-order deliveryReference; a numeric query matches the exact user
 * telegramId; free text matches username (without @), product name or the
 * parent-order deliveryReference, all case-insensitive contains.
 */
export async function searchManualOrders(rawQuery: string): Promise<ManualOrderDetail[]> {
  const query = rawQuery.trim();
  if (query === "" || query.length > SEARCH_QUERY_MAX) {
    return [];
  }
  const or: Prisma.OtherProductOrderWhereInput[] = [];
  if (/^[0-9a-f-]{4,32}$/i.test(query)) {
    or.push({ id: { startsWith: query.toLowerCase() } });
    or.push({ order: { is: { id: { startsWith: query.toLowerCase() } } } });
  }
  if (/^[a-z0-9-]{4,40}$/i.test(query)) {
    // References are stored lowercase-normalized - exact match on the index.
    or.push({ order: { is: { deliveryReference: query.toLowerCase() } } });
  }
  if (/^\d{1,19}$/.test(query) && BigInt(query) <= 9_223_372_036_854_775_807n) {
    or.push({ user: { is: { telegramId: BigInt(query) } } });
  }
  const text = query.startsWith("@") ? query.slice(1) : query;
  if (text !== "" && !/^\d+$/.test(text)) {
    or.push({ user: { is: { username: { contains: text, mode: "insensitive" } } } });
    or.push({ product: { is: { name: { contains: text, mode: "insensitive" } } } });
    or.push({
      order: { is: { deliveryReference: { contains: text, mode: "insensitive" } } },
    });
  }
  if (or.length === 0) {
    return [];
  }
  return prisma.otherProductOrder.findMany({
    where: { OR: or },
    include: DETAIL_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}

/** Admin-context lookup by OtherProductOrder short id; ambiguity fails. */
export async function getManualOrderByShortId(shortId: string): Promise<ManualOrderDetail | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.otherProductOrder.findMany({
    where: { id: { startsWith: shortId } },
    include: DETAIL_INCLUDE,
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- delivery ---------------------------------------------------------------------------

/**
 * Minimal Telegram surface (mock-friendly, mirrors the receipt notifier).
 *
 * `sendPhoto` is OPTIONAL: the production callers always pass grammY's real `Api`
 * (which implements it), while text-only fakes stay valid unchanged. The one
 * consumer - the fail-soft post-purchase QR presentation step - checks for it and
 * simply skips QR delivery when it is absent, so a successful provision is never
 * turned into a failure by a missing photo capability. `photo` is an InputFile.
 */
export interface DeliverySendApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  sendPhoto?(chatId: string, photo: unknown, other?: Record<string, unknown>): Promise<unknown>;
}

/** The message the buyer receives on delivery. */
export function buildDeliveryUserMessage(
  productName: string,
  deliveryText: string,
  deliveryReference: string | null = null,
): string {
  const lines = ["محصول شما با موفقیت تحویل شد ✅", "", `محصول: ${escapeHtml(productName)}`];
  if (deliveryReference !== null && deliveryReference !== "") {
    lines.push(`${DELIVERY_REFERENCE_LABEL} <code>${escapeHtml(deliveryReference)}</code>`);
  }
  lines.push("", escapeHtml(deliveryText));
  return lines.join("\n");
}

export type DeliverOutcome =
  | { ok: true; record: OtherProductOrder }
  | { ok: false; error: string; safeMessage: string };

/**
 * Specialized-workflows phase: the delivery body of a PERSONALIZED_SERVICE
 * order completed WITHOUT credentials (the admin performed the service on
 * the customer's own account - there is nothing to hand over).
 */
export const PERSONALIZED_DONE_TEXT = "انجام شد ✅";
export const EMPTY_DELIVERY_NOT_ALLOWED_TEXT =
  "تحویل بدون متن فقط برای سفارش‌های سرویس شخصی‌سازی‌شده مجاز است.";

/**
 * Delivers one manual order with an ATOMIC CLAIM so the user can never
 * receive the same delivery twice:
 *
 *   1. CAS-claim the record BEFORE sending (status WAITING_ADMIN_DELIVERY
 *      and all delivery fields still null -> write adminDeliveryText +
 *      deliveredByAdminId). Exactly one concurrent admin wins; the loser
 *      returns a safe message WITHOUT sending.
 *   2. Send to the user.
 *   3. Send succeeded -> finalize (status DELIVERED + deliveredAt, Order ->
 *      COMPLETED). Send failed -> roll back ONLY our own claim (the where
 *      matches our exact claimed values, so a newer claim after the
 *      rollback window can never be cleared) and report failure - the
 *      record stays deliverable.
 *
 * Specialized-workflows phase (additive): deliveryText may be null ONLY for
 * records whose fulfillmentProfileSnapshot is PERSONALIZED_SERVICE - the
 * order is marked completed and the buyer receives «انجام شد ✅» instead of
 * credentials. After any successful delivery, a record carrying a
 * completionMessageSnapshot ALSO sends that message (escaped) to the buyer.
 */
export async function deliverManualOrder(
  api: DeliverySendApi,
  args: { recordId: string; adminId: string; deliveryText: string | null },
): Promise<DeliverOutcome> {
  const deliveryText = args.deliveryText === null ? null : args.deliveryText.trim();
  if (
    deliveryText !== null &&
    (deliveryText.length < DELIVERY_TEXT_MIN || deliveryText.length > DELIVERY_TEXT_MAX)
  ) {
    return { ok: false, error: "invalid delivery text", safeMessage: INVALID_DELIVERY_TEXT };
  }
  const record = await prisma.otherProductOrder.findUnique({
    where: { id: args.recordId },
    include: { order: true, user: true, product: true },
  });
  if (record === null) {
    return { ok: false, error: "record not found", safeMessage: "مورد یافت نشد." };
  }
  if (deliveryText === null && record.fulfillmentProfileSnapshot !== "PERSONALIZED_SERVICE") {
    return {
      ok: false,
      error: "empty delivery only for PERSONALIZED_SERVICE",
      safeMessage: EMPTY_DELIVERY_NOT_ALLOWED_TEXT,
    };
  }
  if (record.status === "DELIVERED") {
    return { ok: false, error: "already delivered", safeMessage: ALREADY_DELIVERED_TEXT };
  }
  if (record.status !== "WAITING_ADMIN_DELIVERY") {
    return { ok: false, error: `record status is ${record.status}`, safeMessage: NOT_READY_TEXT };
  }

  // Step 1 - atomic claim. The null-field conditions mean a record that is
  // mid-delivery by another admin (claimed but not yet finalized) cannot be
  // claimed again, so at most ONE send can ever happen.
  const claimed = await prisma.otherProductOrder.updateMany({
    where: {
      id: record.id,
      status: "WAITING_ADMIN_DELIVERY",
      adminDeliveryText: null,
      deliveredByAdminId: null,
      deliveredAt: null,
    },
    data: { adminDeliveryText: deliveryText, deliveredByAdminId: args.adminId },
  });
  if (claimed.count !== 1) {
    const current = await prisma.otherProductOrder.findUnique({
      where: { id: record.id },
      select: { status: true },
    });
    return {
      ok: false,
      error: "claim lost to a concurrent delivery",
      safeMessage: current?.status === "DELIVERED" ? ALREADY_DELIVERED_TEXT : NOT_READY_TEXT,
    };
  }

  // Step 2 - send. Only the claim winner ever reaches this line. The
  // delivery reference is resolved from order identifiers only - the
  // delivery secret text never reaches the naming service, and a null
  // reference never blocks the delivery.
  const deliveryReference = await ensureOrderDeliveryReference(record.orderId);
  try {
    await api.sendMessage(
      record.user.telegramId.toString(),
      buildDeliveryUserMessage(
        record.product.name,
        deliveryText ?? PERSONALIZED_DONE_TEXT,
        deliveryReference,
      ),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logger.warn("manual delivery send failed", {
      recordId: record.id,
      orderId: record.orderId,
      error: errorMessage(err),
    });
    // Roll back OUR claim only: the where repeats the exact values we
    // wrote, so a claim made by someone else after this window is safe.
    try {
      await prisma.otherProductOrder.updateMany({
        where: {
          id: record.id,
          status: "WAITING_ADMIN_DELIVERY",
          adminDeliveryText: deliveryText,
          deliveredByAdminId: args.adminId,
          deliveredAt: null,
        },
        data: { adminDeliveryText: null, deliveredByAdminId: null },
      });
    } catch (rollbackErr) {
      // A stuck claim blocks future deliveries - log loudly for manual review.
      logger.error("manual delivery claim rollback failed", {
        recordId: record.id,
        error: errorMessage(rollbackErr),
      });
    }
    return { ok: false, error: "user send failed", safeMessage: DELIVERY_SEND_FAILED_TEXT };
  }

  // Step 3 - finalize our own claim.
  const now = new Date();
  await prisma.otherProductOrder.updateMany({
    where: {
      id: record.id,
      status: "WAITING_ADMIN_DELIVERY",
      adminDeliveryText: deliveryText,
      deliveredByAdminId: args.adminId,
    },
    data: { status: "DELIVERED", deliveredAt: now },
  });
  await prisma.order.updateMany({
    where: { id: record.orderId, status: OrderStatus.PAID },
    data: { status: OrderStatus.COMPLETED, completedAt: now },
  });
  // Specialized-workflows phase: the product's frozen completion message
  // follows the delivery (best-effort - a failed extra send never rolls the
  // finished delivery back; the message is escaped, plain product copy).
  if (record.completionMessageSnapshot !== null && record.completionMessageSnapshot !== "") {
    try {
      await api.sendMessage(
        record.user.telegramId.toString(),
        escapeHtml(record.completionMessageSnapshot),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.warn("completion message send failed", {
        recordId: record.id,
        error: errorMessage(err),
      });
    }
  }
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
    // Structured submissions (specialized phase) count as registered info
    // too - the flag only ever says "present", never the values themselves.
    const hasInfo =
      (record.userProvidedInfoText !== null && record.userProvidedInfoText !== "") ||
      record.customerInputSubmittedAt !== null;
    const infoLine = hasInfo ? "اطلاعات کاربر: ثبت شده ✅" : "اطلاعات کاربر: —";
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
