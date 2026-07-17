import { prisma, type Admin, type OrderStatus } from "@zedbot/database";
import { errorMessage, maskSecretEdges } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  decodeValuesEncrypted,
  renderSafeSummary,
  validateCustomerInputSchema,
  type CustomerInputSchema,
} from "../../services/customer-input-schema.service.js";
import {
  ALREADY_DELIVERED_TEXT,
  DELIVERY_TEXT_MAX,
  deliverManualOrder,
  getManualOrderByShortId,
  INVALID_DELIVERY_TEXT,
  listManualOrders,
  manualOrderShortId,
  remindUserInfo,
  SEARCH_QUERY_MAX,
  searchManualOrders,
  type ManualOrderDetail,
  type ManualOrderFilter,
  type ManualOrdersPage,
} from "../../services/other-product-delivery.service.js";
import { DELIVERY_REFERENCE_LABEL } from "../../services/other-product-naming.service.js";
import { kindLabel, profileLabel } from "../../services/other-product-profile.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «سفارش‌های دستی 📦» (Phase 23 delivery + Phase 24 navigation) - the admin
// menu «محصولات دیگر / سفارش‌های محصولات دیگر» button opens a landing hub
// with status counters; from there: filtered lists (open / waiting-info /
// ready / delivered history), free-text search, an enriched detail page,
// the info reminder and the atomic text-delivery flow. Admin-only; nothing
// here mutates payments/orders/provisioning beyond the Phase 23 delivery
// transitions.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const NO_SEARCH_RESULT_TEXT = "نتیجه‌ای پیدا نشد.";
const SEARCH_PROMPT_TEXT =
  "شناسه سفارش، آیدی تلگرام کاربر، یوزرنیم یا نام محصول را وارد کنید.";
const HTML = { parseMode: "HTML" as const };
const DELIVER_FLOW = "admin_manual:deliver_text";
const SEARCH_FLOW = "admin_manual:search";

const MO_CB = {
  landing: CB.ADMIN_OTHER_PRODUCTS,
  list: (filter: ManualOrderFilter, page: number): string => `admin:mo:list:${filter}:${page}`,
  view: (sid: string): string => `admin:mo:view:${sid}`,
  deliver: (sid: string): string => `admin:mo:deliver:${sid}`,
  deliverConfirm: "admin:mo:deliver_confirm",
  deliverCancel: "admin:mo:deliver_cancel",
  // Specialized-workflows phase: mark a PERSONALIZED_SERVICE order done
  // without credentials, and the audited customer-input viewer.
  deliverDone: (sid: string): string => `admin:mo:deliver_done:${sid}`,
  customerInfo: (sid: string): string => `admin:mo:cinfo:${sid}`,
  customerInfoFull: (sid: string): string => `admin:mo:cinfo_full:${sid}`,
  remind: (sid: string): string => `admin:mo:remind:${sid}`,
  search: "admin:mo:search",
  searchAgain: "admin:mo:search:again",
} as const;

export const manualOrdersHandler = new Composer<BotContext>();

/** Clears ONLY the delivery flow/draft (keeps search context for back-nav). */
function clearDeliveryFlowState(ctx: BotContext): void {
  if (ctx.session.currentFlow === DELIVER_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminDeliveryDraft;
}

/**
 * Full Phase 23/24 state cleanup (delivery flow/draft + search flow/query +
 * stored list position). Called on the landing and from showAdminMenu.
 */
export function clearManualOrderState(ctx: BotContext): void {
  clearDeliveryFlowState(ctx);
  if (ctx.session.currentFlow === SEARCH_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminManualOrderSearchQuery;
  delete ctx.session.temp.adminManualOrderLastFilter;
  delete ctx.session.temp.adminManualOrderLastPage;
}

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "WAITING_USER_INFO":
      return "در انتظار اطلاعات کاربر 📝";
    case "WAITING_ADMIN_DELIVERY":
      return "آماده تحویل 📦";
    case "DELIVERED":
      return "تحویل شده ✅";
    // Specialized-workflows phase statuses (additive).
    case "AWAITING_STOCK":
      return "در انتظار شارژ موجودی ⏳";
    case "STOCK_RESERVED":
      return "در حال تحویل از موجودی 🎟";
    default:
      return status;
  }
}

const ORDER_STATUS_LABELS: Partial<Record<OrderStatus, string>> = {
  PAID: "پرداخت‌شده 💰",
  COMPLETED: "تکمیل‌شده ✅",
  FAILED: "ناموفق ❌",
  CANCELLED: "لغوشده 🚫",
  REFUNDED: "برگشت‌خورده ↩️",
};

function orderStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

const FILTER_TITLES: Record<ManualOrderFilter, string> = {
  open: "همه سفارش‌های باز",
  info: "در انتظار اطلاعات کاربر 📝",
  ready: "آماده تحویل 📦",
  delivered: "تحویل‌شده ✅",
  stock: "در انتظار شارژ موجودی ⏳",
};

function statusIcon(status: string): string {
  return status === "WAITING_USER_INFO"
    ? "📝"
    : status === "DELIVERED"
      ? "✅"
      : status === "AWAITING_STOCK"
        ? "⏳"
        : "📦";
}

function userLabel(record: ManualOrderDetail): string {
  return record.user.username !== null && record.user.username !== ""
    ? `@${record.user.username}`
    : `${record.user.telegramId}`;
}

function shortName(name: string, max = 24): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

function rowLabel(record: ManualOrderDetail): string {
  const date = (record.status === "DELIVERED" && record.deliveredAt !== null
    ? record.deliveredAt
    : record.createdAt
  )
    .toISOString()
    .slice(5, 10);
  return `${statusIcon(record.status)} ${formatToman(record.order.finalPriceToman)} | ${shortName(record.product.name)} | ${userLabel(record)} | ${date}`;
}

function formatDateTime(date: Date | null): string {
  return date === null ? "-" : `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

// --- OTHER_PRODUCT admin landing (Corrective Fix B) ----------------------------------------
// «محصولات دیگر 🛍» - the single logical parent for product management,
// the manual-order filters and the stock inventory. Every destination is an
// EXISTING implementation (no duplicated services): the filters are the
// Phase 24 lists, «مدیریت محصولات دیگر» opens the existing product
// management flow and «مدیریت موجودی استاک» the existing stock root.

/** Exported for tests - the exact Fix B landing rows. */
export function otherProductsLandingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("مدیریت محصولات دیگر 🛍", CB.ADMIN_PRODUCTS)
    .row()
    .text("سفارش‌های دستی 📦", MO_CB.list("open", 1))
    .text("سفارش‌های در انتظار اطلاعات 📝", MO_CB.list("info", 1))
    .row()
    .text("سفارش‌های آماده تحویل 🚚", MO_CB.list("ready", 1))
    .text("تاریخچه تحویل ✅", MO_CB.list("delivered", 1))
    .row()
    .text("مدیریت موجودی استاک 🎟", "admin:stock:products")
    .row()
    .text("بازگشت به پنل ادمین", CB.ADMIN_MENU);
}

export async function renderLanding(ctx: BotContext): Promise<void> {
  clearManualOrderState(ctx);
  const counts = await listManualOrders("open", 1);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "محصولات دیگر 🛍",
      "",
      `در انتظار اطلاعات کاربر: ${counts.waitingInfoCount}`,
      `آماده تحویل: ${counts.readyCount}`,
      `تحویل‌شده: ${counts.deliveredCount}`,
      // Specialized-workflows phase: paid stock orders parked for refill.
      ...(counts.awaitingStockCount > 0
        ? [`در انتظار شارژ موجودی: ${counts.awaitingStockCount}`]
        : []),
      `کل بازها: ${counts.waitingInfoCount + counts.readyCount}`,
    ].join("\n"),
    otherProductsLandingKeyboard(),
  );
}

// --- filtered lists ----------------------------------------------------------------------

function listKeyboard(pageData: ManualOrdersPage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const record of pageData.records) {
    kb.text(rowLabel(record), MO_CB.view(manualOrderShortId(record))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", MO_CB.list(pageData.filter, pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, MO_CB.list(pageData.filter, pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", MO_CB.list(pageData.filter, pageData.page + 1));
    }
    kb.row();
  }
  // Specialized-workflows phase: the AWAITING_STOCK filter surfaces on the
  // lists whenever paid orders are parked for a refill.
  if (pageData.filter !== "stock" && pageData.awaitingStockCount > 0) {
    kb.text(
      `در انتظار شارژ موجودی ⏳ (${pageData.awaitingStockCount})`,
      MO_CB.list("stock", 1),
    ).row();
  }
  // Fix B: search moved off the landing onto the lists it searches.
  kb.text("جستجوی سفارش 🔎", MO_CB.search).row();
  kb.text("بازگشت به محصولات دیگر", MO_CB.landing);
  return kb;
}

async function renderList(ctx: BotContext, filter: ManualOrderFilter, page: number): Promise<void> {
  clearDeliveryFlowState(ctx);
  // Browsing a list replaces any search context for back-navigation.
  delete ctx.session.temp.adminManualOrderSearchQuery;
  const pageData = await listManualOrders(filter, page);
  ctx.session.temp.adminManualOrderLastFilter = filter;
  ctx.session.temp.adminManualOrderLastPage = pageData.page;
  await safeAnswerCallback(ctx);
  const title = `${FILTER_TITLES[filter]} (${pageData.total})`;
  const body = pageData.total === 0 ? `${title}\n\nموردی وجود ندارد.` : `${title}\n\nبرای بررسی روی یک سفارش بزنید:`;
  await safeEditOrReply(ctx, body, listKeyboard(pageData));
}

manualOrdersHandler.callbackQuery(MO_CB.landing, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
  ctx.session.lastMenu = MO_CB.landing;
});

manualOrdersHandler.callbackQuery(
  /^admin:mo:list:(open|info|ready|delivered|stock):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    await renderList(ctx, ctx.match[1] as ManualOrderFilter, Number.parseInt(ctx.match[2], 10));
  },
);

// Backward compatibility: old Phase 23 keyboards used admin:mo:list:<page>.
manualOrdersHandler.callbackQuery(/^admin:mo:list:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderList(ctx, "open", Number.parseInt(ctx.match[1], 10));
});

// --- search ------------------------------------------------------------------------------

function searchResultsKeyboard(records: ManualOrderDetail[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const record of records) {
    kb.text(rowLabel(record), MO_CB.view(manualOrderShortId(record))).row();
  }
  kb.text("جستجوی جدید 🔎", MO_CB.search).row().text("بازگشت", MO_CB.landing);
  return kb;
}

async function renderSearchResults(ctx: BotContext, query: string, edit: boolean): Promise<void> {
  const records = await searchManualOrders(query);
  const send = edit ? safeEditOrReply : safeReply;
  if (records.length === 0) {
    await send(
      ctx,
      NO_SEARCH_RESULT_TEXT,
      new InlineKeyboard().text("جستجوی جدید 🔎", MO_CB.search).row().text("بازگشت", MO_CB.landing),
    );
    return;
  }
  ctx.session.temp.adminManualOrderSearchQuery = query;
  await send(ctx, `نتایج جستجو (${records.length}):`, searchResultsKeyboard(records));
}

manualOrdersHandler.callbackQuery(MO_CB.search, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearDeliveryFlowState(ctx);
  ctx.session.currentFlow = SEARCH_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    SEARCH_PROMPT_TEXT,
    new InlineKeyboard().text("انصراف", MO_CB.landing),
  );
});

// «بازگشت به نتایج جستجو» from a detail page re-runs the stored query.
manualOrdersHandler.callbackQuery(MO_CB.searchAgain, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearDeliveryFlowState(ctx);
  const query = ctx.session.temp.adminManualOrderSearchQuery;
  await safeAnswerCallback(ctx);
  if (typeof query !== "string" || query === "") {
    await renderLanding(ctx);
    return;
  }
  await renderSearchResults(ctx, query, true);
});

// --- detail ------------------------------------------------------------------------------

/**
 * Safe customer-info state line (specialized records): presence only -
 * never a value. Structured (encrypted) and legacy free-text submissions
 * both count as registered.
 */
function customerInfoLine(record: ManualOrderDetail): string {
  const submitted =
    record.customerInputSubmittedAt !== null ||
    (record.userProvidedInfoText !== null && record.userProvidedInfoText !== "");
  if (submitted) {
    return "اطلاعات مشتری: ثبت شده ✅";
  }
  if (record.status === "WAITING_USER_INFO") {
    return "اطلاعات مشتری: در انتظار ⏳";
  }
  return "اطلاعات مشتری: لازم نیست";
}

function detailText(record: ManualOrderDetail): string {
  const fullName = [record.user.firstName, record.user.lastName].filter(Boolean).join(" ");
  const lines = [
    `📦 <b>سفارش دستی ${escapeHtml(manualOrderShortId(record))}</b>`,
    "",
    `سفارش (Order): <code>${escapeHtml(record.order.id.slice(0, 8))}</code> | وضعیت: ${orderStatusLabel(record.order.status)}`,
    ...(record.order.deliveryReference !== null && record.order.deliveryReference !== ""
      ? [`${DELIVERY_REFERENCE_LABEL} <code>${escapeHtml(record.order.deliveryReference)}</code>`]
      : []),
    `وضعیت تحویل: ${statusLabel(record.status)}`,
    // Specialized-workflows phase: safe frozen-snapshot labels only.
    ...(record.kindSnapshot !== null ? [`نوع محصول: ${kindLabel(record.kindSnapshot)}`] : []),
    ...(record.fulfillmentProfileSnapshot !== null
      ? [`پروفایل تحویل: ${profileLabel(record.fulfillmentProfileSnapshot)}`]
      : []),
    ...(record.kindSnapshot !== null ? [customerInfoLine(record)] : []),
    ...(record.status === "AWAITING_STOCK" ? ["موجودی: در انتظار شارژ"] : []),
    `محصول: ${escapeHtml(record.product.name)}`,
    `دسته‌بندی: ${escapeHtml(record.product.category.name)}`,
    `مبلغ: <b>${formatToman(record.order.finalPriceToman)}</b>`,
    `کاربر: <code>${record.user.telegramId}</code>${
      record.user.username === null || record.user.username === ""
        ? ""
        : ` (@${escapeHtml(record.user.username)})`
    }${fullName === "" ? "" : ` | ${escapeHtml(fullName)}`}`,
    `پرداخت: ${formatDateTime(record.order.paidAt)}`,
    `ثبت سفارش دستی: ${formatDateTime(record.createdAt)}`,
  ];
  if (record.product.requiredUserInfoEnabled) {
    lines.push(
      "",
      `اطلاعات موردنیاز: ${escapeHtml(record.product.requiredUserInfoPromptText ?? "-")}`,
      record.userProvidedInfoText === null || record.userProvidedInfoText === ""
        ? "اطلاعات کاربر: هنوز ثبت نشده —"
        : `اطلاعات کاربر: ${escapeHtml(record.userProvidedInfoText)}`,
    );
  }
  if (record.status === "DELIVERED") {
    lines.push("", `تحویل: ${formatDateTime(record.deliveredAt)}`);
    if (record.deliveredByAdminId !== null) {
      lines.push(`تحویل توسط ادمین: <code>${escapeHtml(record.deliveredByAdminId.slice(0, 8))}</code>`);
    }
    if (record.adminDeliveryText !== null && record.adminDeliveryText !== "") {
      lines.push(`متن تحویل: ${escapeHtml(record.adminDeliveryText)}`);
    }
  }
  return lines.join("\n");
}

/** Exported for tests - back goes to the SAME filter/page (session context). */
export function manualOrderDetailKeyboard(
  ctx: BotContext,
  record: ManualOrderDetail,
): InlineKeyboard {
  const sid = manualOrderShortId(record);
  const kb = new InlineKeyboard();
  if (record.status === "WAITING_ADMIN_DELIVERY") {
    kb.text("تحویل سفارش 📦", MO_CB.deliver(sid)).row();
  }
  if (record.status === "WAITING_USER_INFO") {
    kb.text("پیام به کاربر برای تکمیل اطلاعات 📝", MO_CB.remind(sid)).row();
  }
  // Specialized-workflows phase: audited on-demand viewer for the encrypted
  // structured customer input (list/detail pages never show values).
  if (record.customerInputEncrypted !== null) {
    kb.text("مشاهده اطلاعات مشتری 🔒", MO_CB.customerInfo(sid)).row();
  }
  const hasSearch =
    typeof ctx.session.temp.adminManualOrderSearchQuery === "string" &&
    ctx.session.temp.adminManualOrderSearchQuery !== "";
  if (hasSearch) {
    kb.text("بازگشت به نتایج جستجو 🔎", MO_CB.searchAgain).row();
  } else {
    const filter = ctx.session.temp.adminManualOrderLastFilter ?? "open";
    const page = ctx.session.temp.adminManualOrderLastPage ?? 1;
    kb.text("بازگشت به لیست", MO_CB.list(filter, page)).row();
  }
  kb.text("بازگشت به محصولات دیگر", MO_CB.landing);
  return kb;
}

async function renderDetail(ctx: BotContext, record: ManualOrderDetail): Promise<void> {
  await safeEditOrReply(ctx, detailText(record), manualOrderDetailKeyboard(ctx, record), HTML);
}

manualOrdersHandler.callbackQuery(/^admin:mo:view:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearDeliveryFlowState(ctx);
  const record = await getManualOrderByShortId(ctx.match[1]);
  if (record === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, record);
});

manualOrdersHandler.callbackQuery(/^admin:mo:remind:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearDeliveryFlowState(ctx);
  const record = await getManualOrderByShortId(ctx.match[1]);
  if (record === null || record.status !== "WAITING_USER_INFO") {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sent = await remindUserInfo(ctx.api, record.id);
  await safeAnswerCallback(ctx, sent.ok ? "پیام برای کاربر ارسال شد ✅" : "ارسال پیام ناموفق بود ⚠️");
  const fresh = await getManualOrderByShortId(ctx.match[1]);
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});

// --- audited customer-input viewer (specialized-workflows phase) ---------------------------
//
// «مشاهده اطلاعات مشتری 🔒»: decrypts the structured submission ON DEMAND
// for a re-validated admin. The first page shows the SCHEMA-labeled values
// with sensitive fields masked; «نمایش کامل» is a second, separately-audited
// confirm. EVERY open/decrypt writes an AuditLog row (ids only - never
// values). Nothing here is ever logged or echoed outside this chat.

/** Audit one decrypt/view. Returns false when the audit write failed. */
async function writeCustomerInputViewAudit(
  admin: Admin,
  record: ManualOrderDetail,
  view: "masked" | "full",
): Promise<boolean> {
  try {
    await prisma.auditLog.create({
      data: {
        actorTelegramId: admin.telegramId,
        actorType: "ADMIN",
        action: "other_product_customer_input_viewed",
        entityType: "OtherProductOrder",
        entityId: record.id,
        metadata: { orderShortId: record.orderId.slice(0, 8), adminId: admin.id, view },
      },
    });
    return true;
  } catch (err) {
    logger.error("customer-input view audit write failed", {
      recordId: record.id,
      error: errorMessage(err),
    });
    return false;
  }
}

/** Full (unmasked) rendering by the SCHEMA labels; values HTML-escaped. */
function renderFullCustomerInput(
  schema: CustomerInputSchema | null,
  values: Record<string, string>,
): string {
  if (schema === null) {
    return Object.entries(values)
      .map(([key, value]) => `${escapeHtml(key)}: ${value === "" ? "—" : escapeHtml(value)}`)
      .join("\n");
  }
  return [...schema.fields]
    .sort((a, b) => a.order - b.order)
    .map((field) => {
      const raw = values[field.key];
      return `${escapeHtml(field.label)}: ${raw === undefined || raw === "" ? "—" : escapeHtml(raw)}`;
    })
    .join("\n");
}

/** Masked fallback when no valid schema snapshot survived. */
function renderMaskedWithoutSchema(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(maskSecretEdges(value))}`)
    .join("\n");
}

async function renderCustomerInfoPage(
  ctx: BotContext,
  sid: string,
  view: "masked" | "full",
): Promise<void> {
  // Server-side re-validation: the button alone is never an authorization.
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const record = await getManualOrderByShortId(sid);
  if (record === null || record.customerInputEncrypted === null) {
    await safeAnswerCallback(ctx, "اطلاعات مشتری ثبت نشده است.");
    return;
  }
  let values: Record<string, string>;
  try {
    values = decodeValuesEncrypted(record.customerInputEncrypted);
  } catch {
    // Tampered payload / rotated APP_SECRET - never log the payload itself.
    await safeAnswerCallback(ctx, "رمزگشایی اطلاعات ناموفق بود.");
    return;
  }
  // The audit row is a precondition of showing anything.
  if (!(await writeCustomerInputViewAudit(admin, record, view))) {
    await safeAnswerCallback(ctx, "ثبت لاگ بازبینی ناموفق بود؛ نمایش انجام نشد.");
    return;
  }
  const parsedSchema =
    record.customerInputSchemaSnapshot === null
      ? null
      : validateCustomerInputSchema(record.customerInputSchemaSnapshot);
  const schema = parsedSchema !== null && parsedSchema.ok ? parsedSchema.schema : null;
  const body =
    view === "full"
      ? renderFullCustomerInput(schema, values)
      : schema !== null
        ? renderSafeSummary(schema, values)
        : (record.customerInputSummary ?? renderMaskedWithoutSchema(values));
  const lines = [
    `🔒 <b>اطلاعات مشتری - سفارش ${escapeHtml(manualOrderShortId(record))}</b>`,
    view === "full"
      ? "نمایش کامل (این بازدید در لاگ بازبینی ثبت شد)"
      : "فیلدهای حساس پوشیده نمایش داده می‌شوند (بازدید در لاگ بازبینی ثبت شد)",
    "",
    body,
  ];
  const kb = new InlineKeyboard();
  if (view === "masked") {
    kb.text("نمایش کامل 🔓", MO_CB.customerInfoFull(sid)).row();
  }
  kb.text("بازگشت به سفارش", MO_CB.view(sid));
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

manualOrdersHandler.callbackQuery(/^admin:mo:cinfo:([0-9a-f-]+)$/, async (ctx) => {
  await renderCustomerInfoPage(ctx, ctx.match[1], "masked");
});

manualOrdersHandler.callbackQuery(/^admin:mo:cinfo_full:([0-9a-f-]+)$/, async (ctx) => {
  await renderCustomerInfoPage(ctx, ctx.match[1], "full");
});

// --- delivery (Phase 23 - unchanged mutation semantics) -----------------------------------

manualOrdersHandler.callbackQuery(/^admin:mo:deliver:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const record = await getManualOrderByShortId(ctx.match[1]);
  if (record === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (record.status !== "WAITING_ADMIN_DELIVERY") {
    await safeAnswerCallback(
      ctx,
      record.status === "DELIVERED" ? ALREADY_DELIVERED_TEXT : "سفارش آماده تحویل نیست.",
    );
    return;
  }
  ctx.session.temp.adminDeliveryDraft = { recordId: record.id };
  ctx.session.currentFlow = DELIVER_FLOW;
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  // Specialized-workflows phase: a PERSONALIZED_SERVICE order may complete
  // WITHOUT credentials (the service happened on the customer's account).
  if (record.fulfillmentProfileSnapshot === "PERSONALIZED_SERVICE") {
    kb.text("تکمیل بدون متن ✅", MO_CB.deliverDone(ctx.match[1])).row();
  }
  kb.text("انصراف", MO_CB.view(ctx.match[1]));
  await safeEditOrReply(
    ctx,
    `متن تحویل سفارش را وارد کنید. (حداکثر ${DELIVERY_TEXT_MAX} کاراکتر)`,
    kb,
  );
});

// «تکمیل بدون متن ✅» - PERSONALIZED_SERVICE only (re-checked in the
// service); the buyer receives «انجام شد ✅» plus the completion message.
manualOrdersHandler.callbackQuery(/^admin:mo:deliver_done:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  clearDeliveryFlowState(ctx);
  const record = await getManualOrderByShortId(ctx.match[1]);
  if (record === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await deliverManualOrder(ctx.api, {
    recordId: record.id,
    adminId: admin.id,
    deliveryText: null,
  });
  await safeAnswerCallback(ctx, outcome.ok ? "سفارش تکمیل شد ✅" : outcome.safeMessage);
  const fresh = await getManualOrderByShortId(ctx.match[1]);
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});

manualOrdersHandler.callbackQuery(MO_CB.deliverCancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const recordId = ctx.session.temp.adminDeliveryDraft?.recordId;
  clearDeliveryFlowState(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  const record = recordId === undefined ? null : await getManualOrderByShortId(recordId.slice(0, 8));
  if (record === null) {
    await renderLanding(ctx);
    return;
  }
  await renderDetail(ctx, record);
});

manualOrdersHandler.callbackQuery(MO_CB.deliverConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminDeliveryDraft;
  // Consumed BEFORE executing: a double-clicked confirm cannot deliver twice.
  clearDeliveryFlowState(ctx);
  if (draft === undefined || draft.deliveryText === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await deliverManualOrder(ctx.api, {
    recordId: draft.recordId,
    adminId: admin.id,
    deliveryText: draft.deliveryText,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    const record = await getManualOrderByShortId(draft.recordId.slice(0, 8));
    if (record !== null) {
      await renderDetail(ctx, record);
    }
    return;
  }
  await safeAnswerCallback(ctx, "سفارش تحویل شد ✅");
  const record = await getManualOrderByShortId(draft.recordId.slice(0, 8));
  if (record !== null) {
    await renderDetail(ctx, record);
  }
});

// --- text inputs (delivery text / search query) --------------------------------------------

export const manualOrdersTextHandler = new Composer<BotContext>();

manualOrdersTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (ctx.admin === null || (flow !== DELIVER_FLOW && flow !== SEARCH_FLOW)) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearManualOrderState(ctx);
    return next();
  }

  if (flow === SEARCH_FLOW) {
    const query = text.trim();
    if (query.length === 0 || query.length > SEARCH_QUERY_MAX) {
      await safeReply(
        ctx,
        `عبارت جستجو باید بین 1 تا ${SEARCH_QUERY_MAX} کاراکتر باشد.`,
        new InlineKeyboard().text("انصراف", MO_CB.landing),
      );
      return;
    }
    ctx.session.currentFlow = null;
    await renderSearchResults(ctx, query, false);
    return;
  }

  // DELIVER_FLOW
  const draft = ctx.session.temp.adminDeliveryDraft;
  if (draft === undefined) {
    clearDeliveryFlowState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const deliveryText = text.trim();
  if (deliveryText.length === 0 || deliveryText.length > DELIVERY_TEXT_MAX) {
    await safeReply(ctx, INVALID_DELIVERY_TEXT);
    return;
  }
  const record = await getManualOrderByShortId(draft.recordId.slice(0, 8));
  if (record === null || record.status !== "WAITING_ADMIN_DELIVERY") {
    clearDeliveryFlowState(ctx);
    await safeReply(ctx, record === null ? NOT_FOUND : ALREADY_DELIVERED_TEXT);
    return;
  }
  draft.deliveryText = deliveryText;
  ctx.session.currentFlow = null;
  const preview = deliveryText.length > 300 ? `${deliveryText.slice(0, 300)}…` : deliveryText;
  await safeReply(
    ctx,
    [
      "تحویل سفارش 📦",
      "",
      `سفارش: <code>${escapeHtml(record.order.id.slice(0, 8))}</code>`,
      `محصول: ${escapeHtml(record.product.name)}`,
      `کاربر: <code>${record.user.telegramId}</code>`,
      "",
      `متن تحویل:\n${escapeHtml(preview)}`,
      "",
      "آیا از ارسال این متن به کاربر مطمئن هستید؟",
    ].join("\n"),
    new InlineKeyboard()
      .text("تایید و ارسال به کاربر ✅", MO_CB.deliverConfirm)
      .row()
      .text("انصراف", MO_CB.deliverCancel),
    HTML,
  );
});
