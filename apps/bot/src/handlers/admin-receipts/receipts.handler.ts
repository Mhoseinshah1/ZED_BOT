import { OrderType, PaymentStatus, type User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  getPaymentByShortId,
  listPendingReviewPayments,
  paymentShortId,
  type PaymentWithRelations,
} from "../../services/payment-method.service.js";
import {
  buildServiceInfoMessage,
  PROVISION_FAILED_USER_TEXT,
  provisionPaidOrder,
} from "../../services/provisioning.service.js";
import {
  buildExtraTimeSuccessMessage,
  executeExtraTimeOrder,
  EXTRA_TIME_FAILED_USER_TEXT,
} from "../../services/extra-time.service.js";
import {
  buildExtraVolumeSuccessMessage,
  executeExtraVolumeOrder,
  EXTRA_VOLUME_FAILED_USER_TEXT,
} from "../../services/extra-volume.service.js";
import {
  buildRenewalSuccessMessage,
  executeRenewalOrder,
  RENEWAL_FAILED_USER_TEXT,
} from "../../services/service-renewal.service.js";
import {
  approvalUserNotice,
  approveReceiptPayment,
  REJECT_REASON_MAX,
  rejectionUserNotice,
  rejectReceiptPayment,
  walletTopupSuccessNotice,
} from "../../services/receipt-review.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Admin "رسیدهای تایید نشده" - Phase 8: list + detail + approve / reject.
// Approval requires an explicit confirmation step (Phase 8.1) before the
// service creates the PAID Order and finalizes discount usage; rejection
// first asks the admin for a reason ("receipt:reject" flow) and sends it
// verbatim to the user. No Service / provisioning here - that is Phase 9.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const REJECT_REASON_PROMPT =
  "دلیل رد رسید را بنویسید (۱ تا ۱۰۰۰ کاراکتر).\n" +
  "همین متن عیناً برای کاربر ارسال می‌شود.";

const rcb = {
  list: (page: number): string => `admin:rec:list:${page}`,
  view: (sid: string): string => `admin:rec:view:${sid}`,
  approveAsk: (sid: string): string => `admin:rec:ap:${sid}`,
  approveConfirm: (sid: string): string => `admin:rec:ap:${sid}:yes`,
  reject: (sid: string): string => `admin:rec:rj:${sid}`,
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

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به لیست", rcb.list(1)).row().text("بازگشت به ادمین", CB.ADMIN_MENU);
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
): Promise<boolean> {
  try {
    await ctx.api.sendMessage(
      user.telegramId.toString(),
      text,
      parseMode === undefined ? undefined : { parse_mode: parseMode },
    );
    return true;
  } catch (err) {
    logger.warn("receipt review: user notification failed", {
      userId: user.id,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Phase 17: synchronous extra-time application right after an EXTRA_TIME
 * approval. The executor owns the FAILED + refund path.
 */
async function runExtraTimeAfterApproval(
  ctx: BotContext,
  orderId: string,
  user: User,
): Promise<void> {
  try {
    const outcome = await executeExtraTimeOrder(orderId);
    if (outcome.ok) {
      await notifyUserSafe(
        ctx,
        user,
        buildExtraTimeSuccessMessage(outcome.service, outcome.addedDays),
        "HTML",
      );
      await safeReply(ctx, "زمان سرویس افزایش یافت ✅", backKeyboard());
      return;
    }
    if (outcome.refunded) {
      await notifyUserSafe(ctx, user, EXTRA_TIME_FAILED_USER_TEXT);
      await safeReply(
        ctx,
        "افزایش زمان ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
        backKeyboard(),
      );
      return;
    }
    await notifyUserSafe(ctx, user, approvalUserNotice(OrderType.EXTRA_TIME));
    await safeReply(ctx, outcome.error, backKeyboard());
  } catch (err) {
    logger.error("extra time after approval crashed", { orderId, error: errorMessage(err) });
    await safeReply(
      ctx,
      "خطایی در افزایش زمان سرویس رخ داد. وضعیت سفارش را بررسی کنید.",
      backKeyboard(),
    );
  }
}

/**
 * Phase 16: synchronous extra-volume application right after an EXTRA_VOLUME
 * approval. The executor owns the FAILED + refund path.
 */
async function runExtraVolumeAfterApproval(
  ctx: BotContext,
  orderId: string,
  user: User,
): Promise<void> {
  try {
    const outcome = await executeExtraVolumeOrder(orderId);
    if (outcome.ok) {
      await notifyUserSafe(
        ctx,
        user,
        buildExtraVolumeSuccessMessage(outcome.service, outcome.addedVolumeGb),
        "HTML",
      );
      await safeReply(ctx, "حجم سرویس افزایش یافت ✅", backKeyboard());
      return;
    }
    if (outcome.refunded) {
      await notifyUserSafe(ctx, user, EXTRA_VOLUME_FAILED_USER_TEXT);
      await safeReply(
        ctx,
        "افزایش حجم ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
        backKeyboard(),
      );
      return;
    }
    await notifyUserSafe(ctx, user, approvalUserNotice(OrderType.EXTRA_VOLUME));
    await safeReply(ctx, outcome.error, backKeyboard());
  } catch (err) {
    logger.error("extra volume after approval crashed", { orderId, error: errorMessage(err) });
    await safeReply(
      ctx,
      "خطایی در افزایش حجم سرویس رخ داد. وضعیت سفارش را بررسی کنید.",
      backKeyboard(),
    );
  }
}

/**
 * Phase 12: synchronous renewal right after a SERVICE_RENEWAL approval. The
 * renewal service owns the FAILED + refund path; this only relays outcomes.
 */
async function runRenewalAfterApproval(
  ctx: BotContext,
  orderId: string,
  user: User,
): Promise<void> {
  try {
    const outcome = await executeRenewalOrder(orderId);
    if (outcome.ok) {
      await notifyUserSafe(ctx, user, buildRenewalSuccessMessage(outcome.service), "HTML");
      await safeReply(ctx, "سرویس تمدید شد ✅", backKeyboard());
      return;
    }
    if (outcome.refunded) {
      await notifyUserSafe(ctx, user, RENEWAL_FAILED_USER_TEXT);
      await safeReply(
        ctx,
        "تمدید سرویس ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
        backKeyboard(),
      );
      return;
    }
    await notifyUserSafe(ctx, user, approvalUserNotice(OrderType.SERVICE_RENEWAL));
    await safeReply(ctx, outcome.error, backKeyboard());
  } catch (err) {
    logger.error("renewal after approval crashed", { orderId, error: errorMessage(err) });
    await safeReply(
      ctx,
      "خطایی در تمدید سرویس رخ داد. وضعیت سفارش را بررسی کنید.",
      backKeyboard(),
    );
  }
}

/**
 * Phase 9: synchronous provisioning right after a SERVICE_PURCHASE approval.
 * The provisioning service owns the FAILED + refund path; this only relays
 * the outcome to the user and the admin (raw adapter errors never leave the
 * logs).
 */
async function runProvisioningAfterApproval(
  ctx: BotContext,
  orderId: string,
  user: User,
): Promise<void> {
  try {
    const outcome = await provisionPaidOrder(orderId);
    if (outcome.ok) {
      await notifyUserSafe(ctx, user, buildServiceInfoMessage(outcome.service), "HTML");
      await safeReply(ctx, "سرویس ساخته شد ✅", backKeyboard());
      return;
    }
    if (outcome.refunded) {
      await notifyUserSafe(ctx, user, PROVISION_FAILED_USER_TEXT);
      await safeReply(
        ctx,
        "ساخت سرویس ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.",
        backKeyboard(),
      );
      return;
    }
    // Refused without refund (already provisioning, already failed, ...):
    // the payment stays approved, so tell the user that much.
    await notifyUserSafe(ctx, user, approvalUserNotice(OrderType.SERVICE_PURCHASE));
    await safeReply(ctx, outcome.error, backKeyboard());
  } catch (err) {
    logger.error("provisioning after approval crashed", {
      orderId,
      error: errorMessage(err),
    });
    await safeReply(
      ctx,
      "خطایی در ساخت سرویس رخ داد. وضعیت سفارش را بررسی کنید.",
      backKeyboard(),
    );
  }
}

export const receiptsHandler = new Composer<BotContext>();

receiptsHandler.callbackQuery([CB.ADMIN_RECEIPTS, /^admin:rec:list:(\d+)$/], async (ctx) => {
  clearReceiptReviewFlow(ctx);
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
      : `رسیدهای تایید نشده 💵 (${total})\n\nبرای بررسی روی یک رسید بزنید.`;
  await safeEditOrReply(ctx, title, kb);
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

receiptsHandler.callbackQuery(/^admin:rec:view:([0-9a-f-]+)$/, async (ctx) => {
  clearReceiptReviewFlow(ctx);
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

  const isWalletTopup = payment.purpose === "WALLET_CHARGE";
  const lines = [
    `🧾 <b>رسید ${escapeHtml(paymentShortId(payment))}</b>`,
    "",
    `نوع پرداخت: ${isWalletTopup ? "شارژ کیف پول 🏦" : "پرداخت سفارش"}`,
    `وضعیت: ${escapeHtml(statusLabel(payment.status))}`,
    `کاربر: ${escapeHtml(userLabel(payment))} | <code>${payment.user.telegramId}</code>`,
    `نام: ${escapeHtml([payment.user.firstName, payment.user.lastName].filter(Boolean).join(" ") || "-")}`,
    `مبلغ: <b>${formatToman(payment.amountToman)}</b>`,
    `درگاه: ${escapeHtml(payment.gateway?.name ?? "-")} (${payment.gateway?.type ?? "-"})`,
    `پیش‌فاکتور: <code>${escapeHtml(payment.checkoutSessionId?.slice(0, 8) ?? "-")}</code>`,
    ...(isWalletTopup ? [] : [`محصول: ${escapeHtml(String(snapshot.productName ?? "-"))}`]),
    `نوع رسید: ${receiptKind}`,
  ];
  if (receipt?.text != null && receipt.text !== "") {
    lines.push(`متن رسید: ${escapeHtml(receipt.text)}`);
  }
  if (payment.status === PaymentStatus.REJECTED && payment.rejectReason !== null) {
    lines.push(`دلیل رد: ${escapeHtml(payment.rejectReason)}`);
  }
  lines.push(`ثبت: ${payment.createdAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`);

  const kb = new InlineKeyboard();
  if (payment.status === PaymentStatus.PENDING_REVIEW) {
    kb.text("تایید رسید ✅", rcb.approveAsk(paymentShortId(payment)))
      .text("رد رسید ❌", rcb.reject(paymentShortId(payment)))
      .row();
  }
  kb.text("بازگشت به لیست", rcb.list(1)).row().text("بازگشت به ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
});

// --- approval (confirmation first, Phase 8.1) -----------------------------------

// Step 1: «تایید رسید ✅» only opens a confirmation screen - nothing changes yet.
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
    "آیا از تایید این رسید مطمئن هستید؟",
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
      await safeEditOrReply(ctx, result.message, backKeyboard());
      return;
    }

    logger.info("receipt approved", {
      paymentId: result.payment.id,
      orderId: result.order.id,
      adminId: admin.id,
    });
    if (result.orderType === OrderType.SERVICE_PURCHASE) {
      // Phase 9: provision the PAID order right away (synchronously).
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nOrder ساخته شد.\nساخت سرویس شروع شد.",
        backKeyboard(),
      );
      await runProvisioningAfterApproval(ctx, result.order.id, result.user);
      return;
    }
    if (result.orderType === OrderType.SERVICE_RENEWAL) {
      // Phase 12: renew the existing panel account + Service right away.
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nOrder ساخته شد.\nتمدید سرویس شروع شد.",
        backKeyboard(),
      );
      await runRenewalAfterApproval(ctx, result.order.id, result.user);
      return;
    }
    if (result.orderType === OrderType.EXTRA_VOLUME) {
      // Phase 16: apply the purchased volume right away.
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nOrder ساخته شد.\nافزایش حجم سرویس شروع شد.",
        backKeyboard(),
      );
      await runExtraVolumeAfterApproval(ctx, result.order.id, result.user);
      return;
    }
    if (result.orderType === OrderType.EXTRA_TIME) {
      // Phase 17: apply the purchased time right away.
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nOrder ساخته شد.\nافزایش زمان سرویس شروع شد.",
        backKeyboard(),
      );
      await runExtraTimeAfterApproval(ctx, result.order.id, result.user);
      return;
    }
    if (result.orderType === OrderType.OTHER_PRODUCT) {
      // No provisioning and no OtherProductOrder yet - delivery is a later phase.
      await notifyUserSafe(ctx, result.user, approvalUserNotice(result.orderType));
      await safeEditOrReply(
        ctx,
        "رسید تایید شد ✅\n\nسفارش محصول ثبت شد و تحویل در فاز بعدی انجام می‌شود.",
        backKeyboard(),
      );
      return;
    }
    await notifyUserSafe(ctx, result.user, approvalUserNotice(result.orderType));
    await safeEditOrReply(ctx, result.message, backKeyboard());
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
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره از لیست رسیدها شروع کنید.", backKeyboard());
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
      await safeReply(ctx, result.error, backKeyboard());
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
      backKeyboard(),
    );
  } catch (err) {
    logger.error("receipt rejection failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.", backKeyboard());
  }
});
