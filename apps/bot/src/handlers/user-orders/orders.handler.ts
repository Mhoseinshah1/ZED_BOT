import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getUserHistoryOrderDetail,
  getUserPaymentDetail,
  listUserHistory,
  listUserPayments,
  ORDER_TYPE_LABEL,
  orderStatusInfo,
  paymentMethodLabel,
  paymentPurposeTitle,
  paymentStatusInfo,
  type UserHistoryOrderDetail,
  type UserPaymentRow,
} from "../../services/user-history.service.js";
import {
  deriveUserOrderStatus,
  getDeliveredStockContentForUser,
  getUserOtherProductOrderDetail,
  listUserOtherProductOrders,
  orderProductName,
  USER_ORDER_STATUS_ICON,
  USER_ORDER_STATUS_LABEL,
  visibleManualDeliveryText,
  type UserOtherProductOrderRow,
} from "../../services/user-other-product-orders.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «سفارش‌ها و سوابق من 🧾» - the Phase 29 READ-ONLY OTHER_PRODUCT tracking
// (list + detail, required-info resume via the Phase 23 user:op:info
// callback, delivered manual text / stock content re-decrypted for the
// owner) plus the Phase 30 general history: a hub, a unified order+payment
// list (user:hist), and the payment history (user:payhist) with
// card-to-card / wallet method and review status. Everything is scoped to
// ctx.dbUser.id; no payment/order/wallet/delivery mutation lives here.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

const OD_CB = {
  list: (page: number): string => `user:orders:list:${page}`,
  view: (sid: string): string => `user:orders:view:${sid}`,
} as const;

const HIST_CB = {
  list: (page: number): string => `user:hist:list:${page}`,
  viewOrder: (sid: string): string => `user:hist:view:o:${sid}`,
  viewPayment: (sid: string): string => `user:hist:view:p:${sid}`,
} as const;

const PAY_CB = {
  list: (page: number): string => `user:payhist:list:${page}`,
  view: (sid: string): string => `user:payhist:view:${sid}`,
} as const;

export const userOrdersHandler = new Composer<BotContext>();

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function orderShortId(row: UserOtherProductOrderRow): string {
  return row.id.slice(0, 8);
}

function listRowLabel(row: UserOtherProductOrderRow): string {
  const name = orderProductName(row);
  const shortName = name.length > 24 ? `${name.slice(0, 24)}…` : name;
  const date = (row.paidAt ?? row.createdAt).toISOString().slice(5, 10);
  return `${USER_ORDER_STATUS_ICON[deriveUserOrderStatus(row)]} ${shortName} | ${formatToman(row.finalPriceToman)} | ${date}`;
}

async function renderList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserOtherProductOrders(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const kb = new InlineKeyboard()
      .text("محصولات دیگر 🛍", CB.USER_OTHER_PRODUCTS)
      .row()
      .text("بازگشت", CB.USER_ORDERS)
      .text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, "سفارش‌های محصولات دیگر 🛍\n\nشما هنوز سفارشی ندارید.", kb);
    return;
  }
  const kb = new InlineKeyboard();
  for (const row of pageData.rows) {
    kb.text(listRowLabel(row), OD_CB.view(orderShortId(row))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", OD_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, OD_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", OD_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", CB.USER_ORDERS).text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, `سفارش‌های محصولات دیگر 🛍 — ${pageData.total} سفارش`, kb);
}

async function renderDetail(ctx: BotContext, row: UserOtherProductOrderRow): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const status = deriveUserOrderStatus(row);
  const manual = row.otherProductOrder;
  const lines = [
    `سفارش 🧾 <code>${orderShortId(row)}</code>`,
    "",
    `محصول: ${escapeHtml(orderProductName(row))}`,
    `مبلغ: ${formatToman(row.finalPriceToman)}`,
    `وضعیت: ${USER_ORDER_STATUS_LABEL[status]}`,
    `تاریخ ثبت: ${row.createdAt.toISOString().slice(0, 10)}`,
  ];
  if (row.paidAt !== null) {
    lines.push(`پرداخت: ${row.paidAt.toISOString().slice(0, 10)}`);
  }
  if (row.completedAt !== null) {
    lines.push(`تکمیل: ${row.completedAt.toISOString().slice(0, 10)}`);
  }

  // Required-info section (prompt + what the user already submitted).
  const prompt = row.product?.requiredUserInfoPromptText;
  if (manual !== null && typeof prompt === "string" && prompt !== "") {
    lines.push("", `اطلاعات موردنیاز: ${escapeHtml(prompt)}`);
  }
  if (manual !== null && manual.userProvidedInfoText !== null && manual.userProvidedInfoText !== "") {
    lines.push(`اطلاعات ارسالی شما: ${escapeHtml(manual.userProvidedInfoText)}`);
  }

  if (status === "waiting_info") {
    lines.push("", "برای ادامه سفارش، اطلاعات موردنیاز را با دکمه زیر تکمیل کنید.");
  } else if (status === "waiting_delivery") {
    lines.push("", "سفارش شما در انتظار تحویل ادمین است.");
  } else if (status === "pending") {
    lines.push("", "سفارش در حال آماده‌سازی است.");
  }

  const manualText = visibleManualDeliveryText(row, user.id);
  if (manualText !== null) {
    lines.push("", "تحویل سفارش:", `<code>${escapeHtml(manualText)}</code>`);
  }
  const stockContent = getDeliveredStockContentForUser(row, user.id);
  if (stockContent !== null) {
    if (stockContent.ok) {
      lines.push("", "تحویل خودکار:", `<code>${escapeHtml(stockContent.content)}</code>`);
    } else {
      lines.push("", stockContent.safeMessage);
    }
  }

  const kb = new InlineKeyboard();
  if (status === "waiting_info") {
    // The exact Phase 23 resume callback - submission logic is NOT duplicated.
    kb.text("تکمیل اطلاعات سفارش 📝", `user:op:info:${orderShortId(row)}`).row();
  }
  kb.text("بازگشت به سفارش‌ها", OD_CB.list(1)).row().text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

// --- hub (Phase 30: CB.USER_ORDERS opens the hub, not the Phase 29 list) --------------------

async function renderHub(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("همه سوابق 🧾", HIST_CB.list(1))
    .row()
    .text("محصولات دیگر 🛍", OD_CB.list(1))
    .row()
    .text("پرداخت‌ها 💳", PAY_CB.list(1))
    .row()
    .text("کیف پول 🏦", CB.USER_WALLET)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(
    ctx,
    "سفارش‌ها و سوابق من 🧾\n\nسوابق خرید سرویس، تمدید، حجم/زمان اضافه، محصولات دیگر و پرداخت‌ها و شارژهای کیف پول شما.",
    kb,
  );
}

userOrdersHandler.callbackQuery(CB.USER_ORDERS, async (ctx) => {
  await renderHub(ctx);
  ctx.session.lastMenu = CB.USER_ORDERS;
});

userOrdersHandler.callbackQuery("user:hist", async (ctx) => {
  await renderHub(ctx);
});

// --- Phase 29 deep routes (unchanged behavior) -----------------------------------------------

userOrdersHandler.callbackQuery(/^user:orders:list:(\d+)$/, async (ctx) => {
  await renderList(ctx, Number.parseInt(ctx.match[1], 10));
});

userOrdersHandler.callbackQuery(/^user:orders:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const row = await getUserOtherProductOrderDetail(user.id, ctx.match[1]);
  if (row === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, row);
});

// --- unified history (Phase 30) ---------------------------------------------------------------

async function renderHistoryList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserHistory(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const kb = new InlineKeyboard().text("بازگشت", CB.USER_ORDERS).row().text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, "همه سوابق 🧾\n\nهنوز سابقه‌ای ثبت نشده است.", kb);
    return;
  }
  const kb = new InlineKeyboard();
  for (const item of pageData.items) {
    const icon =
      item.kind === "order" ? orderStatusInfo(item.status).icon : paymentStatusInfo(item.status).icon;
    const title = item.title.length > 24 ? `${item.title.slice(0, 24)}…` : item.title;
    const date = item.sortAt.toISOString().slice(5, 10);
    kb.text(
      `${icon} ${title} | ${formatToman(item.amountToman)} | ${date}`,
      item.kind === "order"
        ? HIST_CB.viewOrder(item.id.slice(0, 8))
        : HIST_CB.viewPayment(item.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", HIST_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, HIST_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", HIST_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", CB.USER_ORDERS).text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, `همه سوابق 🧾 — ${pageData.total} مورد`, kb);
}

async function renderHistoryOrderDetail(
  ctx: BotContext,
  order: UserHistoryOrderDetail,
): Promise<void> {
  const status = orderStatusInfo(order.status);
  const productName = order.productNameSnapshot ?? order.product?.name ?? null;
  const lines = [
    `سفارش 🧾 <code>${order.id.slice(0, 8)}</code>`,
    "",
    `نوع: ${ORDER_TYPE_LABEL[order.type]}`,
    `وضعیت: ${status.label}`,
  ];
  if (productName !== null && productName !== "") {
    lines.push(`محصول: ${escapeHtml(productName)}`);
  }
  lines.push(
    `مبلغ: ${formatToman(order.finalPriceToman)}`,
    `تاریخ ثبت: ${order.createdAt.toISOString().slice(0, 10)}`,
  );
  if (order.paidAt !== null) {
    lines.push(`پرداخت: ${order.paidAt.toISOString().slice(0, 10)}`);
  }
  if (order.completedAt !== null) {
    lines.push(`تکمیل: ${order.completedAt.toISOString().slice(0, 10)}`);
  }
  if (order.payment !== null) {
    lines.push(
      "",
      `روش پرداخت: ${paymentMethodLabel(order.payment, order.payment.gateway)}`,
      `وضعیت پرداخت: ${paymentStatusInfo(order.payment.status).label}`,
    );
  }
  if (order.service !== null) {
    lines.push("", `سرویس: <code>${escapeHtml(order.service.username)}</code>`);
  }

  const kb = new InlineKeyboard();
  if (order.service !== null) {
    kb.text("مشاهده سرویس 🛍", `user:svc:view:${order.service.id.slice(0, 8)}`).row();
  }
  if (order.type === "OTHER_PRODUCT") {
    // Delivered content (manual text / stock) lives in the Phase 29 detail.
    kb.text("مشاهده جزئیات محصول دیگر 🛍", OD_CB.view(order.id.slice(0, 8))).row();
  }
  if (order.payment !== null) {
    kb.text("مشاهده پرداخت 💳", PAY_CB.view(order.payment.id.slice(0, 8))).row();
  }
  kb.text("بازگشت به سوابق", HIST_CB.list(1)).row().text("بازگشت", CB.USER_ORDERS);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

userOrdersHandler.callbackQuery(/^user:hist:list:(\d+)$/, async (ctx) => {
  await renderHistoryList(ctx, Number.parseInt(ctx.match[1], 10));
});

userOrdersHandler.callbackQuery(/^user:hist:view:o:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const order = await getUserHistoryOrderDetail(user.id, ctx.match[1]);
  if (order === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderHistoryOrderDetail(ctx, order);
});

// --- payment history (Phase 30) ---------------------------------------------------------------

async function renderPaymentDetail(ctx: BotContext, payment: UserPaymentRow): Promise<void> {
  const status = paymentStatusInfo(payment.status);
  const lines = [
    `پرداخت 💳 <code>${payment.id.slice(0, 8)}</code>`,
    "",
    `نوع: ${paymentPurposeTitle(payment.purpose)}`,
    `وضعیت: ${status.label}`,
    `مبلغ: ${formatToman(payment.amountToman)}`,
    `روش: ${paymentMethodLabel(payment, payment.gateway)}`,
    `تاریخ ثبت: ${payment.createdAt.toISOString().slice(0, 10)}`,
  ];
  if (payment.reviewedAt !== null) {
    lines.push(`بررسی: ${payment.reviewedAt.toISOString().slice(0, 10)}`);
  }
  lines.push(`رسید: ${payment.receipts.length > 0 ? "ارسال شده ✅" : "—"}`);
  if (payment.order !== null) {
    lines.push(
      "",
      `سفارش مرتبط: ${ORDER_TYPE_LABEL[payment.order.type]} <code>${payment.order.id.slice(0, 8)}</code>`,
    );
  }
  if (payment.status === "REJECTED" && payment.rejectReason !== null && payment.rejectReason !== "") {
    lines.push("", `دلیل رد: ${escapeHtml(payment.rejectReason)}`);
  }

  const kb = new InlineKeyboard();
  if (payment.order !== null) {
    kb.text("مشاهده سفارش 🧾", HIST_CB.viewOrder(payment.order.id.slice(0, 8))).row();
  }
  if (payment.purpose === "WALLET_CHARGE" && payment.status === "APPROVED") {
    kb.text("مشاهده کیف پول 🏦", CB.USER_WALLET).row();
  }
  kb.text("بازگشت به پرداخت‌ها", PAY_CB.list(1)).row().text("بازگشت", CB.USER_ORDERS);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

userOrdersHandler.callbackQuery(/^user:payhist:list:(\d+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserPayments(user.id, Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const kb = new InlineKeyboard().text("بازگشت", CB.USER_ORDERS).row().text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, "پرداخت‌ها 💳\n\nهنوز پرداختی ثبت نشده است.", kb);
    return;
  }
  const kb = new InlineKeyboard();
  for (const payment of pageData.payments) {
    const icon = paymentStatusInfo(payment.status).icon;
    const date = (payment.paidAt ?? payment.createdAt).toISOString().slice(5, 10);
    kb.text(
      `${icon} ${paymentPurposeTitle(payment.purpose)} | ${formatToman(payment.amountToman)} | ${date}`,
      PAY_CB.view(payment.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", PAY_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, PAY_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", PAY_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", CB.USER_ORDERS).text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, `پرداخت‌ها 💳 — ${pageData.total} مورد`, kb);
});

userOrdersHandler.callbackQuery(/^user:payhist:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const payment = await getUserPaymentDetail(user.id, ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderPaymentDetail(ctx, payment);
});

// Unified-list payment rows share the payment detail renderer.
userOrdersHandler.callbackQuery(/^user:hist:view:p:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const payment = await getUserPaymentDetail(user.id, ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderPaymentDetail(ctx, payment);
});
