import { OrderType, PaymentStatus, type User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { dispatchPaidOrderFulfillment } from "../../services/order-fulfillment.service.js";
import {
  getPaymentByShortId,
  listPendingReviewPayments,
  paymentShortId,
  type PaymentWithRelations,
} from "../../services/payment-method.service.js";
import {
  approveReceiptPayment,
  REJECT_REASON_MAX,
  rejectionUserNotice,
  rejectReceiptPayment,
  walletTopupSuccessNotice,
} from "../../services/receipt-review.service.js";
import { listUserWalletTransactionsForAdmin } from "../../services/admin-user-wallet.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  userProfileKeyboard,
  userProfileText,
  userShortId,
  userWalletKeyboard,
  userWalletText,
} from "../admin-users/admin-users-views.js";

// =============================================================================
// Admin "رسیدهای تایید نشده" - Phase 8: list + detail + approve / reject.
// Approval requires an explicit confirmation step (Phase 8.1) before the
// service creates the PAID Order and finalizes discount usage; rejection
// first asks the admin for a reason ("receipt:reject" flow) and sends it
// verbatim to the user. No Service / provisioning here - that is Phase 9.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const REJECT_REASON_PROMPT =
  "دلیل رد پرداخت را وارد کنید. (۱ تا ۱۰۰۰ کاراکتر)\n" +
  "همین متن عیناً برای کاربر ارسال می‌شود.";

/** Exported for tests and for the admin-users "بازگشت به رسید 🧾" button. */
export const rcb = {
  list: (page: number): string => `admin:rec:list:${page}`,
  view: (sid: string): string => `admin:rec:view:${sid}`,
  approveAsk: (sid: string): string => `admin:rec:ap:${sid}`,
  approveConfirm: (sid: string): string => `admin:rec:ap:${sid}:yes`,
  reject: (sid: string): string => `admin:rec:rj:${sid}`,
  // Corrective Fix B: on-demand media/details + jumps into the existing
  // admin user-management pages for the paying user.
  media: (sid: string): string => `admin:rec:media:${sid}`,
  userView: (sid: string): string => `admin:rec:user:${sid}`,
  userWallet: (sid: string): string => `admin:rec:uwallet:${sid}`,
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

/** Leaves the reject-reason flow (if any) without touching other flows. */
function clearReceiptReviewFlow(ctx: BotContext): void {
  if (ctx.session.currentFlow === "receipt:reject") {
    ctx.session.currentFlow = null;
  }
  ctx.session.temp.rejectingPaymentId = undefined;
}

/** Current receipt-list page from the session (Fix B), fallback 1. */
function receiptListPage(ctx: BotContext): number {
  const page = ctx.session.temp.adminReceiptListPage;
  return typeof page === "number" && page >= 1 ? page : 1;
}

/** After approve/reject: back to the receipt list (same page) or finance. */
export function reviewResultKeyboard(page: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("بازگشت به لیست رسیدها", rcb.list(page))
    .row()
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
}

function backKeyboard(ctx: BotContext): InlineKeyboard {
  return reviewResultKeyboard(receiptListPage(ctx));
}

/**
 * Sends a review-result notice to the paying user. Failures never roll back
 * the review - they are logged (without file ids / card numbers) and reported
 * to the admin.
 */
async function notifyUserSafe(
  ctx: BotContext,
  user: User,
  text: string,
  parseMode?: "HTML",
  keyboard?: InlineKeyboard,
): Promise<boolean> {
  try {
    await ctx.api.sendMessage(user.telegramId.toString(), text, {
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
    });
    return true;
  } catch (err) {
    logger.warn("receipt review: user notification failed", {
      userId: user.id,
      error: errorMessage(err),
    });
    return false;
  }
}

/** Admin-facing outcome lines per service-type fulfillment op. */
const SERVICE_ADMIN_TEXTS = {
  provision: {
    ok: "سرویس ساخته شد ✅",
    refunded: "ساخت سرویس ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
  },
  renew: {
    ok: "سرویس تمدید شد ✅",
    refunded: "تمدید سرویس ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
  },
  extra_volume: {
    ok: "حجم سرویس افزایش یافت ✅",
    refunded: "افزایش حجم ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
  },
  extra_time: {
    ok: "زمان سرویس افزایش یافت ✅",
    refunded: "افزایش زمان ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
  },
} as const;

/**
 * Post-approval fulfillment through the UNIFIED dispatcher (shared with the
 * wallet and gateway payment paths - the user-facing notifications live
 * there). This helper only renders the ADMIN-side outcome summary; failures
 * never roll back the already-committed approval.
 */
async function runFulfillmentAfterApproval(
  ctx: BotContext,
  orderId: string,
  user: User,
  fallbackAdminMessage: string,
): Promise<void> {
  const dispatch = await dispatchPaidOrderFulfillment(ctx.api, orderId, {
    source: "RECEIPT",
    user,
  });
  if (dispatch.kind === "SERVICE") {
    const texts = SERVICE_ADMIN_TEXTS[dispatch.op];
    if (dispatch.ok) {
      await safeReply(ctx, texts.ok, backKeyboard(ctx));
    } else if (dispatch.refunded) {
      await safeReply(ctx, texts.refunded, backKeyboard(ctx));
    } else {
      await safeReply(
        ctx,
        dispatch.error ?? "وضعیت سفارش را از بخش سفارش‌ها بررسی کنید.",
        backKeyboard(ctx),
      );
    }
    return;
  }
  if (dispatch.kind === "OTHER_PRODUCT") {
    if (dispatch.auto === "DELIVERED" || dispatch.auto === "ALREADY_DELIVERED") {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش استاک به صورت خودکار تحویل شد 🎟",
        backKeyboard(ctx),
      );
      return;
    }
    if (dispatch.manual === null || !dispatch.manual.ok || dispatch.manual.recordShortId === null) {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش ثبت شد اما ساخت سفارش دستی با خطا مواجه شد؛ از بخش سفارش‌های دستی پیگیری کنید.",
        backKeyboard(ctx),
      );
      return;
    }
    await safeEditOrReply(
      ctx,
      [
        "رسید تایید شد ✅",
        "",
        ...(dispatch.auto === "SEND_FAILED"
          ? ["⚠️ تحویل خودکار ناموفق شد؛ سفارش برای تحویل دستی ثبت شد."]
          : dispatch.auto === "NO_STOCK"
            ? ["🚨 موجودی محصول تمام شده و سفارش برای تحویل دستی ثبت شد."]
            : ["سفارش دستی ساخته شد 📦"]),
        dispatch.manual.requiresInfo
          ? "از کاربر اطلاعات موردنیاز خواسته شد."
          : "سفارش آماده تحویل است.",
      ].join("\n"),
      new InlineKeyboard()
        .text("مشاهده سفارش 📦", `admin:mo:view:${dispatch.manual.recordShortId}`)
        .row()
        .text("بازگشت به لیست رسیدها", rcb.list(receiptListPage(ctx)))
        .row()
        .text("بازگشت به مالی", CB.ADMIN_FINANCE),
    );
    return;
  }
  // NONE: unsupported type (user already notified by the dispatcher) or a
  // crashed dispatch (logged there) - show the caller's fallback summary.
  await safeEditOrReply(ctx, fallbackAdminMessage, backKeyboard(ctx));
}

export const receiptsHandler = new Composer<BotContext>();

/** Receipt list keyboard (Fix B): back goes to the finance landing. */
export function receiptListKeyboard(pageData: {
  payments: PaymentWithRelations[];
  page: number;
  pages: number;
}): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const payment of pageData.payments) {
    kb.text(
      `${formatToman(payment.amountToman)} | ${userLabel(payment)} | ${shortDate(payment.createdAt)}`,
      rcb.view(paymentShortId(payment)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", rcb.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, rcb.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", rcb.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به مالی", CB.ADMIN_FINANCE);
  return kb;
}

receiptsHandler.callbackQuery([CB.ADMIN_RECEIPTS, /^admin:rec:list:(\d+)$/], async (ctx) => {
  clearReceiptReviewFlow(ctx);
  const page = ctx.match !== undefined && typeof ctx.match !== "string"
    ? Number.parseInt(ctx.match[1] ?? "1", 10)
    : 1;
  const pageData = await listPendingReviewPayments(page);
  ctx.session.temp.adminReceiptListPage = pageData.page;
  await safeAnswerCallback(ctx);

  const title =
    pageData.total === 0
      ? "رسید در انتظار بررسی وجود ندارد ✅"
      : `رسیدهای تاییدنشده 💵 (${pageData.total})\n\nبرای بررسی روی یک رسید بزنید.`;
  await safeEditOrReply(ctx, title, receiptListKeyboard(pageData));
});

function statusLabel(status: PaymentStatus): string {
  switch (status) {
    case PaymentStatus.PENDING_REVIEW:
      return "در انتظار بررسی ⏳";
    case PaymentStatus.APPROVED:
      return "تایید شده ✅";
    case PaymentStatus.REJECTED:
      return "رد شده ❌";
    default:
      return status;
  }
}

function latestReceipt(payment: PaymentWithRelations) {
  return payment.receipts[payment.receipts.length - 1];
}

function formatUtc(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

/** «جزئیات رسید 🧾» (Fix B) - readable, fully escaped, no secrets. */
export function receiptDetailText(payment: PaymentWithRelations): string {
  const receipt = latestReceipt(payment);
  const snapshot = (payment.checkoutSession?.productSnapshot ?? {}) as Record<string, unknown>;
  const receiptKind =
    receipt === undefined
      ? "-"
      : receipt.fileId !== null
        ? "فایل/عکس (فایل رسید ثبت شده است)"
        : "متن";

  const isWalletTopup = payment.purpose === "WALLET_CHARGE";
  const lines = [
    `جزئیات رسید 🧾 <b>${escapeHtml(paymentShortId(payment))}</b>`,
    "",
    `نوع پرداخت: ${isWalletTopup ? "شارژ کیف پول 🏦" : "پرداخت سفارش"}`,
    `وضعیت: ${escapeHtml(statusLabel(payment.status))}`,
    `کاربر: ${escapeHtml(userLabel(payment))} | <code>${payment.user.telegramId}</code>`,
    `نام: ${escapeHtml([payment.user.firstName, payment.user.lastName].filter(Boolean).join(" ") || "-")}`,
    `مبلغ: <b>${formatToman(payment.amountToman)}</b>`,
    `روش پرداخت: ${escapeHtml(payment.gateway?.name ?? "-")} (${payment.gateway?.type ?? "-"})`,
    `پیش‌فاکتور: <code>${escapeHtml(payment.checkoutSessionId?.slice(0, 8) ?? "-")}</code>`,
    ...(payment.orderId === null
      ? []
      : [`سفارش: <code>${escapeHtml(payment.orderId.slice(0, 8))}</code>`]),
    ...(isWalletTopup ? [] : [`محصول: ${escapeHtml(String(snapshot.productName ?? "-"))}`]),
    `نوع رسید: ${receiptKind}`,
  ];
  if (receipt?.text != null && receipt.text !== "") {
    lines.push(`متن رسید: ${escapeHtml(receipt.text)}`);
  }
  if (payment.status === PaymentStatus.REJECTED && payment.rejectReason !== null) {
    lines.push(`دلیل رد: ${escapeHtml(payment.rejectReason)}`);
  }
  lines.push(`ثبت: ${formatUtc(payment.createdAt)}`);
  if (payment.reviewedAt !== null) {
    lines.push(`بررسی: ${formatUtc(payment.reviewedAt)}`);
  }
  return lines.join("\n");
}

/**
 * Receipt detail keyboard (Fix B). Approve/reject only while PENDING_REVIEW;
 * media/details and the user-management jumps always; backs go to the
 * current list page and the finance landing. No wallet mutation and no user
 * block happens here - those buttons only NAVIGATE to the existing admin
 * user pages with their own confirmation flows.
 */
export function receiptDetailKeyboard(
  payment: PaymentWithRelations,
  listPage: number,
): InlineKeyboard {
  const sid = paymentShortId(payment);
  const kb = new InlineKeyboard();
  if (payment.status === PaymentStatus.PENDING_REVIEW) {
    kb.text("تایید پرداخت ✅", rcb.approveAsk(sid)).text("رد پرداخت ❌", rcb.reject(sid)).row();
  }
  kb.text("مشاهده رسید و مشخصات 🧾", rcb.media(sid)).row();
  kb.text("مدیریت کیف پول کاربر 💰", rcb.userWallet(sid))
    .text("مدیریت/مسدودسازی کاربر 👤", rcb.userView(sid))
    .row();
  kb.text("بازگشت به لیست", rcb.list(listPage)).text("بازگشت به مالی", CB.ADMIN_FINANCE);
  return kb;
}

receiptsHandler.callbackQuery(/^admin:rec:view:([0-9a-f-]+)$/, async (ctx) => {
  clearReceiptReviewFlow(ctx);
  // A return-to-receipt jump (if any) is consumed by arriving here.
  delete ctx.session.temp.adminUserReturnContext;
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  // Fix B: the stored media is NOT auto-forwarded on every render anymore -
  // «مشاهده رسید و مشخصات 🧾» sends it on demand.
  await safeEditOrReply(
    ctx,
    receiptDetailText(payment),
    receiptDetailKeyboard(payment, receiptListPage(ctx)),
    HTML,
  );
});

// --- on-demand receipt media / details (Fix B) ---------------------------------

export type ReceiptMediaOutcome =
  | { kind: "photo" | "document" }
  | { kind: "text"; text: string }
  | { kind: "none" }
  | { kind: "failed" };

/**
 * Sends the stored receipt media (photo first, document fallback) or returns
 * the receipt text. Never throws; never logs file ids.
 */
export async function sendReceiptMedia(
  api: Pick<BotContext["api"], "sendPhoto" | "sendDocument">,
  chatId: number | string,
  payment: PaymentWithRelations,
): Promise<ReceiptMediaOutcome> {
  const receipt = latestReceipt(payment);
  if (receipt === undefined) {
    return { kind: "none" };
  }
  if (receipt.fileId === null || receipt.fileId === "") {
    if (receipt.text !== null && receipt.text !== "") {
      return { kind: "text", text: receipt.text };
    }
    return { kind: "none" };
  }
  const caption = `رسید ${paymentShortId(payment)} 🧾 | ${userLabel(payment)} | ${formatToman(payment.amountToman)}`;
  try {
    await api.sendPhoto(chatId, receipt.fileId, { caption });
    return { kind: "photo" };
  } catch {
    try {
      await api.sendDocument(chatId, receipt.fileId, { caption });
      return { kind: "document" };
    } catch (err) {
      logger.warn("receipt media send failed", {
        paymentId: payment.id,
        error: errorMessage(err),
      });
      return { kind: "failed" };
    }
  }
}

receiptsHandler.callbackQuery(/^admin:rec:media:([0-9a-f-]+)$/, async (ctx) => {
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null || ctx.chat === undefined) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  const outcome = await sendReceiptMedia(ctx.api, ctx.chat.id, payment);
  if (outcome.kind === "none") {
    await safeAnswerCallback(ctx, "فایل یا متن رسید ثبت نشده است.");
    return;
  }
  if (outcome.kind === "failed") {
    await safeAnswerCallback(ctx, "ارسال فایل رسید ناموفق بود ⚠️");
    return;
  }
  if (outcome.kind === "text") {
    await safeAnswerCallback(ctx);
    await safeReply(
      ctx,
      `متن رسید ${paymentShortId(payment)} 🧾\n${userLabel(payment)} | ${formatToman(payment.amountToman)}\n\n${outcome.text}`,
    );
    return;
  }
  await safeAnswerCallback(ctx, "رسید ارسال شد ✅");
});

// --- jumps into the existing admin user management (Fix B) ----------------------
// NAVIGATION ONLY: no wallet mutation and no block happens from the receipt
// pages. The existing Phase 20 pages own the increase/decrease confirmation
// flow; the return context brings the admin back to this receipt.

function setReceiptReturnContext(ctx: BotContext, paymentId: string): void {
  ctx.session.temp.adminUserReturnContext = {
    kind: "receipt",
    receiptId: paymentId,
    receiptPage: receiptListPage(ctx),
  };
}

// «مدیریت/مسدودسازی کاربر 👤» -> the existing user profile page.
receiptsHandler.callbackQuery(/^admin:rec:user:([0-9a-f-]+)$/, async (ctx) => {
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  setReceiptReturnContext(ctx, payment.id);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    userProfileText(payment.user),
    userProfileKeyboard(userShortId(payment.user), false, paymentShortId(payment)),
    HTML,
  );
});

// «مدیریت کیف پول کاربر 💰» -> the existing user wallet page (its own
// increase/decrease buttons + confirmation flow).
receiptsHandler.callbackQuery(/^admin:rec:uwallet:([0-9a-f-]+)$/, async (ctx) => {
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  setReceiptReturnContext(ctx, payment.id);
  await safeAnswerCallback(ctx);
  const transactions = await listUserWalletTransactionsForAdmin(payment.user.id, 5);
  await safeEditOrReply(
    ctx,
    userWalletText(payment.user, transactions),
    userWalletKeyboard(userShortId(payment.user), paymentShortId(payment)),
    HTML,
  );
});

// --- approval (confirmation first, Phase 8.1) -----------------------------------

// Step 1: «تایید پرداخت ✅» only opens a confirmation screen - nothing changes yet.
receiptsHandler.callbackQuery(/^admin:rec:ap:([0-9a-f-]+)$/, async (ctx) => {
  clearReceiptReviewFlow(ctx);
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  if (payment.status !== PaymentStatus.PENDING_REVIEW) {
    await safeAnswerCallback(ctx, "این رسید قبلاً بررسی شده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = paymentShortId(payment);
  await safeEditOrReply(
    ctx,
    "آیا از تایید این پرداخت مطمئن هستید؟",
    new InlineKeyboard()
      .text("تایید نهایی ✅", rcb.approveConfirm(sid))
      .row()
      .text("انصراف", rcb.view(sid)),
  );
});

// Step 2: only «تایید نهایی ✅» actually approves.
receiptsHandler.callbackQuery(/^admin:rec:ap:([0-9a-f-]+):yes$/, async (ctx) => {
  clearReceiptReviewFlow(ctx);
  const admin = ctx.admin;
  if (admin === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }

  try {
    const result = await approveReceiptPayment(payment.id, admin);
    if (!result.ok) {
      await safeAnswerCallback(ctx, result.error);
      return;
    }
    await safeAnswerCallback(ctx, "تایید شد ✅");

    // Notifications go out after the transaction; failures never roll back.
    if (result.kind === "WALLET_TOPUP") {
      // Phase 14: the balance already moved inside the approval transaction.
      logger.info("wallet topup approved", {
        paymentId: result.payment.id,
        adminId: admin.id,
      });
      await notifyUserSafe(
        ctx,
        result.user,
        walletTopupSuccessNotice(result.amountToman, result.newBalanceToman),
      );
      await safeEditOrReply(ctx, result.message, backKeyboard(ctx));
      return;
    }

    logger.info("receipt approved", {
      paymentId: result.payment.id,
      orderId: result.order.id,
      adminId: admin.id,
    });
    // The per-type "started" notice keeps the admin informed while the
    // dispatcher runs; OTHER_PRODUCT renders its full summary at the end.
    if (result.orderType === OrderType.SERVICE_PURCHASE) {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش ساخته شد.\nساخت سرویس شروع شد.",
        backKeyboard(ctx),
      );
    } else if (result.orderType === OrderType.SERVICE_RENEWAL) {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش ساخته شد.\nتمدید سرویس شروع شد.",
        backKeyboard(ctx),
      );
    } else if (result.orderType === OrderType.EXTRA_VOLUME) {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش ساخته شد.\nافزایش حجم سرویس شروع شد.",
        backKeyboard(ctx),
      );
    } else if (result.orderType === OrderType.EXTRA_TIME) {
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش ساخته شد.\nافزایش زمان سرویس شروع شد.",
        backKeyboard(ctx),
      );
    }
    // Money already committed by approveReceiptPayment - fulfillment goes
    // through the UNIFIED dispatcher shared with wallet and gateway payments
    // (stock/manual delivery for OTHER_PRODUCT, executors for services).
    await runFulfillmentAfterApproval(ctx, result.order.id, result.user, result.message);
  } catch (err) {
    logger.error("receipt approval failed", { paymentId: payment.id, error: errorMessage(err) });
    await safeAnswerCallback(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// --- rejection (asks for a reason first) --------------------------------------------

receiptsHandler.callbackQuery(/^admin:rec:rj:([0-9a-f-]+)$/, async (ctx) => {
  clearReceiptReviewFlow(ctx);
  const payment = await getPaymentByShortId(ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  if (payment.status !== PaymentStatus.PENDING_REVIEW) {
    await safeAnswerCallback(ctx, "این رسید قبلاً بررسی شده است.");
    return;
  }
  ctx.session.currentFlow = "receipt:reject";
  ctx.session.temp.rejectingPaymentId = payment.id;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    REJECT_REASON_PROMPT,
    new InlineKeyboard().text("انصراف", rcb.view(paymentShortId(payment))),
  );
});

/**
 * Reject-reason intake ("receipt:reject" flow). Routed from app.ts before the
 * user text flows; only active admins ever reach it. Slash commands cancel the
 * flow and continue normally (/admin itself already clears every flow when it
 * renders the admin menu).
 */
export const receiptReviewTextHandler = new Composer<BotContext>();

receiptReviewTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "receipt:reject") {
    return next();
  }
  const admin = ctx.admin;
  if (admin === null) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearReceiptReviewFlow(ctx);
    return next();
  }

  const paymentId = ctx.session.temp.rejectingPaymentId;
  if (paymentId === undefined) {
    clearReceiptReviewFlow(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره از لیست رسیدها شروع کنید.", backKeyboard(ctx));
    return;
  }
  const reason = text.trim();
  if (reason.length === 0 || reason.length > REJECT_REASON_MAX) {
    // Stay in the flow so the admin can retype the reason.
    await safeReply(ctx, "دلیل رد باید بین ۱ تا ۱۰۰۰ کاراکتر باشد. دوباره وارد کنید.");
    return;
  }

  clearReceiptReviewFlow(ctx);
  try {
    const result = await rejectReceiptPayment(paymentId, admin, reason);
    if (!result.ok) {
      await safeReply(ctx, result.error, backKeyboard(ctx));
      return;
    }
    logger.info("receipt rejected", { paymentId: result.payment.id, adminId: admin.id });
    const notified = await notifyUserSafe(
      ctx,
      result.user,
      rejectionUserNotice(result.reason, result.payment.purpose),
    );
    await safeReply(
      ctx,
      notified ? result.message : "رسید رد شد ❌\nاما ارسال پیام به کاربر ناموفق بود.",
      backKeyboard(ctx),
    );
  } catch (err) {
    logger.error("receipt rejection failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.", backKeyboard(ctx));
  }
});
