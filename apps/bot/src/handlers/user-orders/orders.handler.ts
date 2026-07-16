import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getUserHistoryOrderDetail,
  getUserPaymentDetail,
  listUserHistory,
  listUserPayments,
  listUserSubscriptionOrders,
  ORDER_TYPE_LABEL,
  orderStatusInfo,
  paymentMethodLabel,
  paymentPurposeTitle,
  paymentStatusInfo,
  type UserHistoryOrderDetail,
  type UserPaymentRow,
} from "../../services/user-history.service.js";
import { listWalletTransactions } from "../../services/wallet.service.js";
import { DELIVERY_REFERENCE_LABEL } from "../../services/other-product-naming.service.js";
import { transactionHistoryText } from "../user-wallet/wallet-views.js";
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
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
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
  // Fix D: subscription-orders filter + wallet transactions from history.
  sub: (page: number): string => `user:hist:sub:${page}`,
  wtx: (page: number): string => `user:hist:wtx:${page}`,
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
    await safeEditOrReply(
      ctx,
      `سفارش‌های محصولات دیگر 🛍\n\n${await getMessageTemplate("no_other_product_orders_text")}`,
      kb,
    );
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
    ...(row.deliveryReference !== null && row.deliveryReference !== ""
      ? [`${DELIVERY_REFERENCE_LABEL} <code>${escapeHtml(row.deliveryReference)}</code>`]
      : []),
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

// --- history landing (Fix D layout; CB.USER_ORDERS opens it) --------------------------------

/** Fix D landing rows - exported for tests (labels are ButtonText-backed). */
export async function buildHistoryLandingKeyboard(): Promise<InlineKeyboard> {
  const [allOrders, subOrders, otherOrders, payments, walletTx] = await Promise.all([
    getButtonText("all_orders"),
    getButtonText("subscription_orders"),
    getButtonText("other_product_orders"),
    getButtonText("payments"),
    getButtonText("wallet_transactions"),
  ]);
  return new InlineKeyboard()
    .text(allOrders, HIST_CB.list(1))
    .row()
    .text(subOrders, HIST_CB.sub(1))
    .text(otherOrders, OD_CB.list(1))
    .row()
    .text(payments, PAY_CB.list(1))
    .text(walletTx, HIST_CB.wtx(1))
    .row()
    .text("بازگشت به منوی اصلی", CB.USER_MENU);
}

export async function renderOrdersHub(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  // Fix D: operator-editable landing text.
  const notice = await getMessageTemplate("history_landing_text");
  await safeEditOrReply(
    ctx,
    `سفارش‌های من 🧾\n\n${notice}`,
    await buildHistoryLandingKeyboard(),
  );
}

userOrdersHandler.callbackQuery(CB.USER_ORDERS, async (ctx) => {
  await renderOrdersHub(ctx);
  ctx.session.lastMenu = CB.USER_ORDERS;
});

userOrdersHandler.callbackQuery("user:hist", async (ctx) => {
  await renderOrdersHub(ctx);
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

/** Shared pagination + back rows for the Fix D history lists. */
async function appendHistoryListFooter(
  kb: InlineKeyboard,
  build: (page: number) => string,
  pageData: { page: number; pages: number },
): Promise<InlineKeyboard> {
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text(await getButtonText("previous"), build(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, build(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text(await getButtonText("next"), build(pageData.page + 1));
    }
    kb.row();
  }
  kb.text(await getButtonText("back_to_history"), CB.USER_ORDERS).text(
    "بازگشت به منوی اصلی",
    CB.USER_MENU,
  );
  return kb;
}

async function renderHistoryList(
  ctx: BotContext,
  page: number,
  kind: "all" | "sub",
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const build = kind === "all" ? HIST_CB.list : HIST_CB.sub;
  const title = kind === "all" ? "همه سفارش‌ها 📋" : "خرید اشتراک‌ها 🔐";

  const kb = new InlineKeyboard();
  let pageInfo: { page: number; pages: number; total: number };
  if (kind === "all") {
    const pageData = await listUserHistory(user.id, page);
    pageInfo = pageData;
    for (const item of pageData.items) {
      const icon =
        item.kind === "order" ? orderStatusInfo(item.status).icon : paymentStatusInfo(item.status).icon;
      const itemTitle = item.title.length > 24 ? `${item.title.slice(0, 24)}…` : item.title;
      const date = item.sortAt.toISOString().slice(5, 10);
      kb.text(
        `${icon} ${itemTitle} | ${formatToman(item.amountToman)} | ${date}`,
        item.kind === "order"
          ? HIST_CB.viewOrder(item.id.slice(0, 8))
          : HIST_CB.viewPayment(item.id.slice(0, 8)),
      ).row();
    }
  } else {
    const pageData = await listUserSubscriptionOrders(user.id, page);
    pageInfo = pageData;
    for (const order of pageData.orders) {
      const status = orderStatusInfo(order.status);
      const name = order.productNameSnapshot ?? ORDER_TYPE_LABEL[order.type];
      const shortName = name.length > 24 ? `${name.slice(0, 24)}…` : name;
      const date = (order.paidAt ?? order.createdAt).toISOString().slice(5, 10);
      kb.text(
        `${status.icon} ${shortName} | ${formatToman(order.finalPriceToman)} | ${date}`,
        HIST_CB.viewOrder(order.id.slice(0, 8)),
      ).row();
    }
  }
  // Fix D: order details return to this exact list/page.
  ctx.session.temp.userHistListKind = kind;
  ctx.session.temp.userHistListPage = pageInfo.page;
  await safeAnswerCallback(ctx);
  if (pageInfo.total === 0) {
    const kbEmpty = new InlineKeyboard();
    await appendHistoryListFooter(kbEmpty, build, pageInfo);
    await safeEditOrReply(
      ctx,
      `${title}\n\n${await getMessageTemplate("no_orders_text")}`,
      kbEmpty,
    );
    return;
  }
  await appendHistoryListFooter(kb, build, pageInfo);
  await safeEditOrReply(ctx, `${title} — ${pageInfo.total} مورد`, kb);
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
  // Only ever set for OTHER_PRODUCT orders (the naming phase).
  if (order.deliveryReference !== null && order.deliveryReference !== "") {
    lines.push(`${DELIVERY_REFERENCE_LABEL} <code>${escapeHtml(order.deliveryReference)}</code>`);
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
  // Fix D: back to the SAME list (all/subscription) and page.
  const kind = ctx.session.temp.userHistListKind ?? "all";
  const backPage = ctx.session.temp.userHistListPage ?? 1;
  kb.text("بازگشت به لیست", kind === "sub" ? HIST_CB.sub(backPage) : HIST_CB.list(backPage))
    .row()
    .text(await getButtonText("back_to_history"), CB.USER_ORDERS);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

userOrdersHandler.callbackQuery(/^user:hist:list:(\d+)$/, async (ctx) => {
  await renderHistoryList(ctx, Number.parseInt(ctx.match[1], 10), "all");
});

// Fix D: subscription-related orders only (OTHER_PRODUCT stays separate).
userOrdersHandler.callbackQuery(/^user:hist:sub:(\d+)$/, async (ctx) => {
  await renderHistoryList(ctx, Number.parseInt(ctx.match[1], 10), "sub");
});

// Fix D: wallet transactions entered FROM history - same read-only data as
// the wallet page, but backs return to the history landing (the wallet's
// own user:wallet:tx route keeps returning to the wallet landing).
userOrdersHandler.callbackQuery(/^user:hist:wtx:(\d+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const [pageData, emptyText] = await Promise.all([
    listWalletTransactions(user.id, Number.parseInt(ctx.match[1], 10)),
    getMessageTemplate("wallet_empty_transactions_text"),
  ]);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  await appendHistoryListFooter(kb, HIST_CB.wtx, pageData);
  await safeEditOrReply(ctx, transactionHistoryText(pageData, emptyText), kb, HTML);
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
  // Fix D: back to the SAME payment-list page.
  kb.text("بازگشت به پرداخت‌ها", PAY_CB.list(ctx.session.temp.userPayListPage ?? 1))
    .row()
    .text(await getButtonText("back_to_history"), CB.USER_ORDERS);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

userOrdersHandler.callbackQuery(/^user:payhist:list:(\d+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserPayments(user.id, Number.parseInt(ctx.match[1], 10));
  // Fix D: payment details return to this exact page.
  ctx.session.temp.userPayListPage = pageData.page;
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const kb = new InlineKeyboard();
    await appendHistoryListFooter(kb, PAY_CB.list, pageData);
    await safeEditOrReply(
      ctx,
      `پرداخت‌ها 💳\n\n${await getMessageTemplate("no_payments_text")}`,
      kb,
    );
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
  await appendHistoryListFooter(kb, PAY_CB.list, pageData);
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
