import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  ALREADY_DELIVERED_TEXT,
  DELIVERY_TEXT_MAX,
  deliverManualOrder,
  getManualOrderByShortId,
  INVALID_DELIVERY_TEXT,
  listManualOrders,
  manualOrderShortId,
  remindUserInfo,
  type ManualOrderWithRelations,
  type ManualOrdersPage,
} from "../../services/other-product-delivery.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «سفارش‌های دستی 📦» (Phase 23) - the admin-menu «محصولات دیگر /
// سفارش‌های محصولات دیگر» button now opens the real manual-order list:
// pending OTHER_PRODUCT orders (waiting for user info / ready for delivery),
// a detail page, an info reminder, and the text-delivery flow. Admin-only;
// nothing here creates payments/orders or touches provisioning.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const DELIVER_FLOW = "admin_manual:deliver_text";

const MO_CB = {
  list: (page: number): string => `admin:mo:list:${page}`,
  view: (sid: string): string => `admin:mo:view:${sid}`,
  deliver: (sid: string): string => `admin:mo:deliver:${sid}`,
  deliverConfirm: "admin:mo:deliver_confirm",
  deliverCancel: "admin:mo:deliver_cancel",
  remind: (sid: string): string => `admin:mo:remind:${sid}`,
} as const;

export const manualOrdersHandler = new Composer<BotContext>();

/** Full Phase 23 admin state cleanup - called on list/menu/cancel. */
export function clearManualOrderState(ctx: BotContext): void {
  if (ctx.session.currentFlow === DELIVER_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminDeliveryDraft;
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
    default:
      return status;
  }
}

function userLabel(record: ManualOrderWithRelations): string {
  return record.user.username !== null && record.user.username !== ""
    ? `@${record.user.username}`
    : `${record.user.telegramId}`;
}

function listKeyboard(pageData: ManualOrdersPage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const record of pageData.records) {
    const mark = record.status === "WAITING_USER_INFO" ? "📝" : "📦";
    kb.text(
      `${mark} ${formatToman(record.order.finalPriceToman)} | ${record.product.name} | ${userLabel(record)} | ${record.createdAt.toISOString().slice(0, 10)}`,
      MO_CB.view(manualOrderShortId(record)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", MO_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, MO_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", MO_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", CB.ADMIN_MENU);
  return kb;
}

async function renderList(ctx: BotContext, page: number): Promise<void> {
  clearManualOrderState(ctx);
  const pageData = await listManualOrders(page);
  await safeAnswerCallback(ctx);
  const lines = [
    "سفارش‌های دستی 📦",
    "",
    `در انتظار اطلاعات کاربر: ${pageData.waitingInfoCount}`,
    `آماده تحویل: ${pageData.readyCount}`,
    `تحویل‌شده: ${pageData.deliveredCount}`,
  ];
  if (pageData.total === 0) {
    lines.push("", "سفارشی در انتظار وجود ندارد ✅");
  } else {
    lines.push("", "برای بررسی روی یک سفارش بزنید:");
  }
  await safeEditOrReply(ctx, lines.join("\n"), listKeyboard(pageData));
}

function detailText(record: ManualOrderWithRelations): string {
  const fullName = [record.user.firstName, record.user.lastName].filter(Boolean).join(" ");
  const lines = [
    `📦 <b>سفارش ${escapeHtml(record.order.id.slice(0, 8))}</b>`,
    "",
    `وضعیت: ${statusLabel(record.status)}`,
    `محصول: ${escapeHtml(record.product.name)}`,
    `مبلغ: <b>${formatToman(record.order.finalPriceToman)}</b>`,
    `کاربر: <code>${record.user.telegramId}</code>${
      record.user.username === null || record.user.username === ""
        ? ""
        : ` (@${escapeHtml(record.user.username)})`
    }${fullName === "" ? "" : ` | ${escapeHtml(fullName)}`}`,
    `پرداخت: ${record.order.paidAt === null ? "-" : `${record.order.paidAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`}`,
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
    lines.push(
      "",
      `تحویل: ${record.deliveredAt === null ? "-" : `${record.deliveredAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`}`,
    );
    if (record.adminDeliveryText !== null && record.adminDeliveryText !== "") {
      lines.push(`متن تحویل: ${escapeHtml(record.adminDeliveryText)}`);
    }
  }
  return lines.join("\n");
}

function detailKeyboard(record: ManualOrderWithRelations): InlineKeyboard {
  const sid = manualOrderShortId(record);
  const kb = new InlineKeyboard();
  if (record.status === "WAITING_ADMIN_DELIVERY") {
    kb.text("تحویل سفارش 📦", MO_CB.deliver(sid)).row();
  }
  if (record.status === "WAITING_USER_INFO") {
    kb.text("پیام به کاربر برای تکمیل اطلاعات 📝", MO_CB.remind(sid)).row();
  }
  kb.text("بازگشت", MO_CB.list(1));
  return kb;
}

async function renderDetail(ctx: BotContext, record: ManualOrderWithRelations): Promise<void> {
  await safeEditOrReply(ctx, detailText(record), detailKeyboard(record), HTML);
}

// The existing admin-menu button opens the real list now.
manualOrdersHandler.callbackQuery(CB.ADMIN_OTHER_PRODUCTS, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderList(ctx, 1);
  ctx.session.lastMenu = CB.ADMIN_OTHER_PRODUCTS;
});

manualOrdersHandler.callbackQuery(/^admin:mo:list:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderList(ctx, Number.parseInt(ctx.match[1], 10));
});

manualOrdersHandler.callbackQuery(/^admin:mo:view:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearManualOrderState(ctx);
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
  clearManualOrderState(ctx);
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
  await safeEditOrReply(
    ctx,
    `متن تحویل سفارش را وارد کنید. (حداکثر ${DELIVERY_TEXT_MAX} کاراکتر)`,
    new InlineKeyboard().text("انصراف", MO_CB.view(ctx.match[1])),
  );
});

manualOrdersHandler.callbackQuery(MO_CB.deliverCancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const recordId = ctx.session.temp.adminDeliveryDraft?.recordId;
  clearManualOrderState(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  const record = recordId === undefined ? null : await getManualOrderByShortId(recordId.slice(0, 8));
  if (record === null) {
    await renderList(ctx, 1);
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
  clearManualOrderState(ctx);
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

// --- delivery text input ---------------------------------------------------------------

export const manualOrdersTextHandler = new Composer<BotContext>();

manualOrdersTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.admin === null || ctx.session.currentFlow !== DELIVER_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearManualOrderState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminDeliveryDraft;
  if (draft === undefined) {
    clearManualOrderState(ctx);
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
    clearManualOrderState(ctx);
    await safeReply(ctx, record === null ? NOT_FOUND : ALREADY_DELIVERED_TEXT);
    return;
  }
  draft.deliveryText = deliveryText;
  ctx.session.currentFlow = null;
  const preview =
    deliveryText.length > 300 ? `${deliveryText.slice(0, 300)}…` : deliveryText;
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
