import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getPaymentByShortId,
  listPendingReviewPayments,
  paymentShortId,
  type PaymentWithRelations,
} from "../../services/payment-method.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Admin "رسیدهای تایید نشده" - read-only foundation. Approval/rejection is
// Phase 8; this phase only lists PENDING_REVIEW payments and shows details.
// =============================================================================

const HTML = { parseMode: "HTML" as const };

const rcb = {
  list: (page: number): string => `admin:rec:list:${page}`,
  view: (sid: string): string => `admin:rec:view:${sid}`,
} as const;

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function shortDate(date: Date): string {
  return date.toISOString().replace("T", " ").slice(5, 16);
}

function userLabel(payment: PaymentWithRelations): string {
  const user = payment.user;
  return user.username !== null ? `@${user.username}` : (user.firstName ?? String(user.telegramId));
}

export const receiptsHandler = new Composer<BotContext>();

receiptsHandler.callbackQuery([CB.ADMIN_RECEIPTS, /^admin:rec:list:(\d+)$/], async (ctx) => {
  const page = ctx.match !== undefined && typeof ctx.match !== "string"
    ? Number.parseInt(ctx.match[1] ?? "1", 10)
    : 1;
  const { payments, page: current, pages, total } = await listPendingReviewPayments(page);
  await safeAnswerCallback(ctx);

  const kb = new InlineKeyboard();
  for (const payment of payments) {
    kb.text(
      `${formatToman(payment.amountToman)} | ${userLabel(payment)} | ${shortDate(payment.createdAt)}`,
      rcb.view(paymentShortId(payment)),
    ).row();
  }
  if (pages > 1) {
    if (current > 1) {
      kb.text("« قبلی", rcb.list(current - 1));
    }
    kb.text(`${current}/${pages}`, rcb.list(current));
    if (current < pages) {
      kb.text("بعدی »", rcb.list(current + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", CB.ADMIN_MENU);

  const title =
    total === 0
      ? "رسید در انتظار بررسی وجود ندارد ✅"
      : `رسیدهای تایید نشده 💵 (${total})\n\nبررسی/تایید رسیدها در فاز بعدی فعال می‌شود.`;
  await safeEditOrReply(ctx, title, kb);
});

receiptsHandler.callbackQuery(/^admin:rec:view:([0-9a-f-]+)$/, async (ctx) => {
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx);

  const receipt = payment.receipts[payment.receipts.length - 1];
  const snapshot = (payment.checkoutSession?.productSnapshot ?? {}) as Record<string, unknown>;
  const receiptKind =
    receipt === undefined
      ? "-"
      : receipt.fileId !== null
        ? "فایل/عکس (فایل رسید ثبت شده است)"
        : "متن";

  const lines = [
    `🧾 <b>رسید ${escapeHtml(paymentShortId(payment))}</b>`,
    "",
    `کاربر: ${escapeHtml(userLabel(payment))} | <code>${payment.user.telegramId}</code>`,
    `نام: ${escapeHtml([payment.user.firstName, payment.user.lastName].filter(Boolean).join(" ") || "-")}`,
    `مبلغ: <b>${formatToman(payment.amountToman)}</b>`,
    `درگاه: ${escapeHtml(payment.gateway?.name ?? "-")} (${payment.gateway?.type ?? "-"})`,
    `پیش‌فاکتور: <code>${escapeHtml(payment.checkoutSessionId?.slice(0, 8) ?? "-")}</code>`,
    `محصول: ${escapeHtml(String(snapshot.productName ?? "-"))}`,
    `نوع رسید: ${receiptKind}`,
  ];
  if (receipt?.text != null && receipt.text !== "") {
    lines.push(`متن رسید: ${escapeHtml(receipt.text)}`);
  }
  lines.push(
    `ثبت: ${payment.createdAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    "",
    "تایید/رد رسید در فاز بعدی فعال می‌شود.",
  );

  const kb = new InlineKeyboard()
    .text("بازگشت به لیست", rcb.list(1))
    .row()
    .text("بازگشت به ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
});
