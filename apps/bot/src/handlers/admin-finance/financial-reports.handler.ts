import type { OtherProductOrderStatus, ServiceStatus } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getAdminOrderDetail,
  getAdminPaymentDetail,
  getFinancialReport,
  listAdminOrders,
  listAdminPayments,
  REPORT_RANGE_LABEL,
  type AdminOrderDetail,
  type AdminPaymentRow,
  type ReportRange,
} from "../../services/admin-financial-report.service.js";
import {
  ORDER_TYPE_LABEL,
  orderStatusInfo,
  paymentMethodLabel,
  paymentPurposeTitle,
  paymentStatusInfo,
} from "../../services/user-history.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «گزارش مالی 📊» (Phase 31) - admin-only READ-ONLY reporting UI under
// مالی 💎: ranged dashboard (today / 7d / 30d / all), latest payments and
// latest orders with detail pages that LINK to the existing receipt-review
// and manual-order screens instead of duplicating them. No financial row is
// mutated; no stock content, receipt media or adapter errors are shown.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

const REP_CB = {
  root: "admin:fin:reports",
  range: (range: ReportRange): string => `admin:fin:rep:${range}`,
  payments: (page: number): string => `admin:fin:payments:${page}`,
  orders: (page: number): string => `admin:fin:orders:${page}`,
  payment: (sid: string): string => `admin:fin:pay:${sid}`,
  order: (sid: string): string => `admin:fin:ord:${sid}`,
} as const;

// Persian labels for the linked-record status lines (raw enums never render).
// Wording matches the existing user/admin views (service-views.ts and the
// manual-orders handler).
const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  ACTIVE: "فعال ✅",
  DISABLED: "غیرفعال ⏸",
  EXPIRED: "منقضی ⌛",
  LIMITED: "اتمام حجم 📦",
  FAILED: "ناموفق ❌",
  CREATING: "در حال ساخت ⏳",
  DELETED: "حذف‌شده 🗑",
};

const MANUAL_ORDER_STATUS_LABEL: Record<OtherProductOrderStatus, string> = {
  PAID: "پرداخت‌شده 💰",
  WAITING_USER_INFO: "در انتظار اطلاعات کاربر 📝",
  WAITING_ADMIN_DELIVERY: "آماده تحویل 📦",
  DELIVERED: "تحویل شده ✅",
  CANCELLED: "لغوشده 🚫",
  REFUNDED: "برگشت‌خورده ↩️",
  DELIVERY_CANCELLED_REFUNDED: "تحویل لغو و مبلغ برگشت داده شد ↩️",
  DELIVERY_REJECTED_NO_REFUND: "تحویل رد شد (بدون برگشت وجه) ❌",
  // Specialized-workflows phase statuses (paid stock order without inventory
  // + the transient reservation window before the delivery send).
  AWAITING_STOCK: "در انتظار تامین موجودی ⏳",
  STOCK_RESERVED: "موجودی رزرو شده (در حال تحویل) 📦",
};

const ORDER_TYPE_ICON: Record<string, string> = {
  SERVICE_PURCHASE: "🔐",
  SERVICE_RENEWAL: "♻️",
  EXTRA_VOLUME: "➕",
  EXTRA_TIME: "⏳",
  LOCATION_CHANGE: "📍",
  OTHER_PRODUCT: "🛍",
};

export const financialReportsHandler = new Composer<BotContext>();

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function userLabel(user: { telegramId: bigint; username: string | null }): string {
  return user.username === null || user.username === ""
    ? user.telegramId.toString()
    : `@${user.username}`;
}

async function renderDashboard(ctx: BotContext, range: ReportRange): Promise<void> {
  const report = await getFinancialReport(range);
  await safeAnswerCallback(ctx);
  const lines = [
    "گزارش مالی 📊",
    `بازه: ${REPORT_RANGE_LABEL[range]}`,
    "",
    "فروش سفارش‌ها:",
    `✅ تعداد: ${report.orders.revenueCount}`,
    `💰 مبلغ: ${formatToman(report.orders.revenueAmountToman)}`,
  ];
  const breakdown = Object.entries(report.orders.byType).filter(
    ([, value]) => value.count > 0,
  );
  if (breakdown.length > 0) {
    lines.push("", "به تفکیک:");
    for (const [type, value] of breakdown) {
      lines.push(
        `${ORDER_TYPE_ICON[type] ?? "•"} ${ORDER_TYPE_LABEL[type as keyof typeof ORDER_TYPE_LABEL]}: ${value.count} / ${formatToman(value.amountToman)}`,
      );
    }
  }
  if (report.orders.closedCount > 0) {
    lines.push(`❌ ناموفق/لغو/استرداد: ${report.orders.closedCount}`);
  }
  lines.push(
    "",
    "شارژ کیف پول:",
    `✅ تاییدشده: ${report.walletTopup.approvedCount} / ${formatToman(report.walletTopup.approvedAmountToman)}`,
    `⏳ در انتظار: ${report.walletTopup.pendingCount} / ${formatToman(report.walletTopup.pendingAmountToman)}`,
    "",
    "پرداخت‌ها:",
    `⏳ در انتظار بررسی: ${report.payments.pendingReviewCount}`,
    `✅ تاییدشده: ${report.payments.approvedCount}`,
    `❌ ردشده: ${report.payments.rejectedCount}`,
  );

  const kb = new InlineKeyboard()
    .text("امروز", REP_CB.range("today"))
    .text("۷ روز اخیر", REP_CB.range("7d"))
    .row()
    .text("۳۰ روز اخیر", REP_CB.range("30d"))
    .text("همه زمان‌ها", REP_CB.range("all"))
    .row()
    .text("آخرین پرداخت‌ها 💳", REP_CB.payments(1))
    .row()
    .text("آخرین سفارش‌ها 🧾", REP_CB.orders(1))
    .row()
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

financialReportsHandler.callbackQuery(REP_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderDashboard(ctx, "today");
});

financialReportsHandler.callbackQuery(/^admin:fin:rep:(today|7d|30d|all)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderDashboard(ctx, ctx.match[1] as ReportRange);
});

// --- latest payments -------------------------------------------------------------------------

async function renderPaymentDetail(ctx: BotContext, payment: AdminPaymentRow): Promise<void> {
  const lines = [
    `پرداخت 💳 <code>${payment.id.slice(0, 8)}</code>`,
    "",
    `نوع: ${paymentPurposeTitle(payment.purpose)}`,
    `وضعیت: ${paymentStatusInfo(payment.status).label}`,
    `مبلغ: ${formatToman(payment.amountToman)}`,
    `روش: ${paymentMethodLabel(payment, payment.gateway)}`,
    `کاربر: <code>${payment.user.telegramId}</code>${
      payment.user.username === null || payment.user.username === ""
        ? ""
        : ` (@${escapeHtml(payment.user.username)})`
    }`,
    `تاریخ ثبت: ${payment.createdAt.toISOString().slice(0, 10)}`,
  ];
  if (payment.reviewedAt !== null) {
    lines.push(`بررسی: ${payment.reviewedAt.toISOString().slice(0, 10)}`);
  }
  if (payment.reviewedByAdminId !== null) {
    lines.push(`ادمین بررسی‌کننده: <code>${payment.reviewedByAdminId.slice(0, 8)}</code>`);
  }
  lines.push(`رسید: ${payment.receipts.length > 0 ? "ارسال شده ✅" : "—"}`);
  if (payment.order !== null) {
    lines.push(
      "",
      `سفارش مرتبط: ${ORDER_TYPE_LABEL[payment.order.type]} <code>${payment.order.id.slice(0, 8)}</code> | ${orderStatusInfo(payment.order.status).label}`,
    );
  }
  if (payment.status === "REJECTED" && payment.rejectReason !== null && payment.rejectReason !== "") {
    lines.push("", `دلیل رد: ${escapeHtml(payment.rejectReason)}`);
  }

  const kb = new InlineKeyboard();
  if (payment.status === "PENDING_REVIEW") {
    // The existing Phase 8 receipt-review screen (media shown safely there).
    kb.text("بررسی رسید 💵", `admin:rec:view:${payment.id.slice(0, 8)}`).row();
  }
  if (payment.order !== null) {
    kb.text("مشاهده سفارش 🧾", REP_CB.order(payment.order.id.slice(0, 8))).row();
  }
  kb.text("بازگشت به پرداخت‌ها", REP_CB.payments(1)).row().text("بازگشت به گزارش", REP_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

financialReportsHandler.callbackQuery(/^admin:fin:payments:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const pageData = await listAdminPayments(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const payment of pageData.payments) {
    const icon = paymentStatusInfo(payment.status).icon;
    const date = (payment.paidAt ?? payment.createdAt).toISOString().slice(5, 10);
    kb.text(
      `${icon} ${formatToman(payment.amountToman)} | ${userLabel(payment.user)} | ${date}`,
      REP_CB.payment(payment.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", REP_CB.payments(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, REP_CB.payments(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", REP_CB.payments(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به گزارش", REP_CB.root);
  await safeEditOrReply(
    ctx,
    pageData.total === 0 ? "آخرین پرداخت‌ها 💳\n\nپرداختی ثبت نشده است." : `آخرین پرداخت‌ها 💳 — ${pageData.total} مورد`,
    kb,
  );
});

financialReportsHandler.callbackQuery(/^admin:fin:pay:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const payment = await getAdminPaymentDetail(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderPaymentDetail(ctx, payment);
});

// --- latest orders ---------------------------------------------------------------------------

async function renderOrderDetail(ctx: BotContext, order: AdminOrderDetail): Promise<void> {
  const productName = order.productNameSnapshot ?? order.product?.name ?? null;
  const lines = [
    `سفارش 🧾 <code>${order.id.slice(0, 8)}</code>`,
    "",
    `نوع: ${ORDER_TYPE_LABEL[order.type]}`,
    `وضعیت: ${orderStatusInfo(order.status).label}`,
    `مبلغ: ${formatToman(order.finalPriceToman)}`,
    `کاربر: <code>${order.user.telegramId}</code>${
      order.user.username === null || order.user.username === ""
        ? ""
        : ` (@${escapeHtml(order.user.username)})`
    }`,
  ];
  if (productName !== null && productName !== "") {
    lines.push(`محصول: ${escapeHtml(productName)}`);
  }
  lines.push(`تاریخ ثبت: ${order.createdAt.toISOString().slice(0, 10)}`);
  if (order.paidAt !== null) {
    lines.push(`پرداخت: ${order.paidAt.toISOString().slice(0, 10)}`);
  }
  if (order.completedAt !== null) {
    lines.push(`تکمیل: ${order.completedAt.toISOString().slice(0, 10)}`);
  }
  if (order.payment !== null) {
    lines.push(
      "",
      `پرداخت: <code>${order.payment.id.slice(0, 8)}</code> | ${paymentStatusInfo(order.payment.status).label} | ${paymentMethodLabel(order.payment, order.payment.gateway)}`,
    );
  }
  if (order.service !== null) {
    lines.push(`سرویس: <code>${escapeHtml(order.service.username)}</code> | ${SERVICE_STATUS_LABEL[order.service.status]}`);
  }
  if (order.otherProductOrder !== null) {
    lines.push(`سفارش دستی: <code>${order.otherProductOrder.id.slice(0, 8)}</code> | ${MANUAL_ORDER_STATUS_LABEL[order.otherProductOrder.status]}`);
  }
  if (order.stockDelivered) {
    lines.push("تحویل استاک: انجام شده ✅");
  }

  const kb = new InlineKeyboard();
  if (order.otherProductOrder !== null) {
    kb.text("مشاهده سفارش دستی 📦", `admin:mo:view:${order.otherProductOrder.id.slice(0, 8)}`).row();
  }
  if (order.payment !== null) {
    kb.text("مشاهده پرداخت 💳", REP_CB.payment(order.payment.id.slice(0, 8))).row();
  }
  kb.text("بازگشت به سفارش‌ها", REP_CB.orders(1)).row().text("بازگشت به گزارش", REP_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

financialReportsHandler.callbackQuery(/^admin:fin:orders:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const pageData = await listAdminOrders(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const order of pageData.orders) {
    const icon = orderStatusInfo(order.status).icon;
    kb.text(
      `${icon} ${ORDER_TYPE_LABEL[order.type]} | ${formatToman(order.finalPriceToman)} | ${userLabel(order.user)}`,
      REP_CB.order(order.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", REP_CB.orders(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, REP_CB.orders(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", REP_CB.orders(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به گزارش", REP_CB.root);
  await safeEditOrReply(
    ctx,
    pageData.total === 0 ? "آخرین سفارش‌ها 🧾\n\nسفارشی ثبت نشده است." : `آخرین سفارش‌ها 🧾 — ${pageData.total} مورد`,
    kb,
  );
});

financialReportsHandler.callbackQuery(/^admin:fin:ord:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const order = await getAdminOrderDetail(ctx.match[1]);
  if (order === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderOrderDetail(ctx, order);
});
