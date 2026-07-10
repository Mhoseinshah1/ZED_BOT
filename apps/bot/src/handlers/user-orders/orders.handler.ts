import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
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
// «سفارش‌های من 🧾» (Phase 29) - READ-ONLY tracking of the user's own
// OTHER_PRODUCT orders: list + detail, resume of the Phase 23 required-info
// flow (same user:op:info callback - no duplicated submission logic), the
// delivered manual text and the auto-delivered stock content (owner-checked,
// re-decrypted on view). No payment/order/delivery mutation lives here.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

const OD_CB = {
  list: (page: number): string => `user:orders:list:${page}`,
  view: (sid: string): string => `user:orders:view:${sid}`,
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
      .text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, "سفارش‌های من 🧾\n\nشما هنوز سفارشی ندارید.", kb);
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
  kb.text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, `سفارش‌های من 🧾 — ${pageData.total} سفارش`, kb);
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

userOrdersHandler.callbackQuery(CB.USER_ORDERS, async (ctx) => {
  await renderList(ctx, 1);
  ctx.session.lastMenu = CB.USER_ORDERS;
});

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
