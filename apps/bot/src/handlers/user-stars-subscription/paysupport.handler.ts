import {
  prisma,
  type TelegramStarsServiceSubscription,
  type TelegramStarsSubscriptionCharge,
  type TelegramStarsSubscriptionChargeStatus,
  type TelegramStarsSubscriptionStatus,
} from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  createSupportTicket,
  notifyAdminsAboutNewTicket,
  TICKET_SUBJECT_MAX,
} from "../../services/support-ticket.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «پشتیبانی پرداخت 💳» — /paysupport (Part T). A read-only, MASKED window into
// the user's own Telegram Stars charges plus a one-tap "report a payment
// problem" flow that opens a structured support ticket via the EXISTING ticket
// service (never the free-text subject/message wizard).
//
// SECURITY: every callback resolves its target SERVER-SIDE and re-verifies
// ownership (charge.subscription.userId === ctx.dbUser.id). Nothing sensitive
// is ever shown or logged — no telegram_payment_charge_id, invoice payload,
// Payment/Checkout/Order UUID, token, panel or service identity. The only
// reference exposed is a masked `charge.id.slice(0, 6)`; callbacks carry the
// 8-char id prefix purely as an owner-scoped lookup key. Persian text is UI
// only and never authorizes anything.
// =============================================================================

const NOT_FOUND = "یافت نشد.";

const LANDING_TEXT =
  "💳 پشتیبانی پرداخت\n\nدر این بخش می‌توانید مشکلات پرداخت‌های Telegram Stars، پرداخت‌های اینترنتی، کارت‌به‌کارت و کیف پول را پیگیری کنید.";

const CHARGE_STATUS_FA: Record<TelegramStarsSubscriptionChargeStatus, string> = {
  RECEIVED: "دریافت شده",
  SETTLING: "در حال تسویه",
  FULFILLING: "در حال فعال‌سازی",
  COMPLETED: "تکمیل شده",
  RECONCILIATION_REQUIRED: "نیازمند بررسی مالی",
  REFUND_PENDING: "بازپرداخت در حال بررسی",
  REFUNDED: "بازپرداخت شده",
  FAILED: "ناموفق",
  IGNORED: "نادیده گرفته شده",
};

const SUB_STATUS_FA: Record<TelegramStarsSubscriptionStatus, string> = {
  PENDING_PAYMENT: "در انتظار پرداخت",
  ACTIVE: "فعال",
  CANCEL_AT_PERIOD_END: "لغو در پایان دوره",
  REACTIVATION_ALLOWED: "قابل فعال‌سازی مجدد",
  PAST_DUE: "معوق",
  EXPIRED: "منقضی شده",
  REQUIRES_ACTION: "نیازمند اقدام",
  CANCELLED: "لغو شده",
};

type CategoryCode = "norenew" | "dup" | "refund" | "cancel" | "other";

const CATEGORY_FA: Record<CategoryCode, string> = {
  norenew: "مبلغ کم شده ولی سرویس تمدید نشده",
  dup: "پرداخت تکراری",
  refund: "وضعیت بازپرداخت",
  cancel: "لغو یا فعال‌سازی مجدد اشتراک",
  other: "مشکل دیگری دارم",
};

function isCategoryCode(code: string): code is CategoryCode {
  return (
    code === "norenew" ||
    code === "dup" ||
    code === "refund" ||
    code === "cancel" ||
    code === "other"
  );
}

type ChargeWithSubscription = TelegramStarsSubscriptionCharge & {
  subscription: TelegramStarsServiceSubscription;
};

export const paysupportHandler = new Composer<BotContext>();

// --- helpers -----------------------------------------------------------------

/** YYYY-MM-DD (UTC) — safe, non-sensitive. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:MM" (UTC) for the ticket body timestamp. */
function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** Masked reference shown to the user (NEVER the telegram charge id). */
function maskedRef(charge: { id: string }): string {
  return charge.id.slice(0, 6);
}

/** Owner-scoped resolve by the 8-char id prefix; ambiguity/none → null. */
async function resolveOwnedCharge(
  shortId: string,
  userId: string,
): Promise<ChargeWithSubscription | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.telegramStarsSubscriptionCharge.findMany({
    where: { id: { startsWith: shortId }, subscription: { userId } },
    include: { subscription: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

function refundStateFa(charge: TelegramStarsSubscriptionCharge): string {
  if (charge.refundedAt !== null) {
    return `بازپرداخت شده (${isoDay(charge.refundedAt)})`;
  }
  if (charge.status === "REFUND_PENDING") {
    return "در حال بررسی";
  }
  return "بدون بازپرداخت";
}

function kindFa(charge: TelegramStarsSubscriptionCharge): string {
  return charge.isFirstRecurring ? "اولین پرداخت" : "تمدید";
}

// --- landing -----------------------------------------------------------------

function landingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("پرداخت‌های اخیر من", "user:psup:recent")
    .row()
    .text("اشتراک‌های Stars من", "user:psup:subs")
    .row()
    .text("وضعیت بازپرداخت", "user:psup:refunds")
    .row()
    .text("گزارش مشکل پرداخت", "user:psup:report")
    .row()
    .text("تیکت‌های پشتیبانی من", "user:sup:list:0")
    .row()
    .text("بازگشت", CB.USER_MENU);
}

async function renderLanding(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, LANDING_TEXT, landingKeyboard());
}

paysupportHandler.command("paysupport", async (ctx) => {
  if (ctx.dbUser === null) {
    return;
  }
  await renderLanding(ctx);
});

paysupportHandler.callbackQuery("user:psup:home", async (ctx) => {
  if (ctx.dbUser === null) {
    return;
  }
  await renderLanding(ctx);
});

// --- charge list (subs / recent) ---------------------------------------------

function chargeRowLabel(charge: TelegramStarsSubscriptionCharge): string {
  const kind = charge.isFirstRecurring ? "اول" : "تمدید";
  return `${isoDay(charge.receivedAt)} · ${charge.starsAmount}⭐ · ${kind} · ${CHARGE_STATUS_FA[charge.status]} · #${maskedRef(charge)}`;
}

async function renderChargeList(ctx: BotContext, userId: string): Promise<void> {
  const charges = await prisma.telegramStarsSubscriptionCharge.findMany({
    where: { subscription: { userId } },
    orderBy: { receivedAt: "desc" },
    take: 10,
  });
  await safeAnswerCallback(ctx);
  if (charges.length === 0) {
    await safeEditOrReply(
      ctx,
      "هنوز پرداخت اشتراک Stars برای شما ثبت نشده است.",
      new InlineKeyboard().text("بازگشت", "user:psup:home"),
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const charge of charges) {
    kb.text(chargeRowLabel(charge), `user:psup:charge:${charge.id.slice(0, 8)}`).row();
  }
  kb.text("بازگشت", "user:psup:home");
  await safeEditOrReply(ctx, "⭐ پرداخت‌های اخیر اشتراک شما\n\nبرای مشاهده جزئیات، هر مورد را انتخاب کنید:", kb);
}

paysupportHandler.callbackQuery("user:psup:subs", async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await renderChargeList(ctx, user.id);
});

paysupportHandler.callbackQuery("user:psup:recent", async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await renderChargeList(ctx, user.id);
});

// --- charge detail -----------------------------------------------------------

function chargeDetailText(charge: ChargeWithSubscription): string {
  return [
    "💳 جزئیات پرداخت",
    "",
    `تاریخ: ${isoDay(charge.receivedAt)}`,
    `مبلغ: ${charge.starsAmount} ⭐`,
    `نوع: ${kindFa(charge)}`,
    `وضعیت تسویه: ${CHARGE_STATUS_FA[charge.status]}`,
    `تمدید تا: ${isoDay(charge.subscriptionExpirationDate)}`,
    `وضعیت اشتراک: ${SUB_STATUS_FA[charge.subscription.status]}`,
    `وضعیت بازپرداخت: ${refundStateFa(charge)}`,
    `کد پیگیری: #${maskedRef(charge)}`,
  ].join("\n");
}

paysupportHandler.callbackQuery(/^user:psup:charge:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const charge = await resolveOwnedCharge(ctx.match[1], user.id);
  if (charge === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("گزارش مشکل این پرداخت", `user:psup:report:${charge.id.slice(0, 8)}`)
    .row()
    .text("بازگشت", "user:psup:subs");
  await safeEditOrReply(ctx, chargeDetailText(charge), kb);
});

// --- refunds -----------------------------------------------------------------

paysupportHandler.callbackQuery("user:psup:refunds", async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const charges = await prisma.telegramStarsSubscriptionCharge.findMany({
    where: {
      subscription: { userId: user.id },
      status: { in: ["REFUND_PENDING", "REFUNDED"] },
    },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });
  await safeAnswerCallback(ctx);
  if (charges.length === 0) {
    await safeEditOrReply(
      ctx,
      "درخواست بازپرداختی برای شما ثبت نشده است.",
      new InlineKeyboard().text("بازگشت", "user:psup:home"),
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const charge of charges) {
    kb.text(
      `${isoDay(charge.receivedAt)} · ${charge.starsAmount}⭐ · ${CHARGE_STATUS_FA[charge.status]} · #${maskedRef(charge)}`,
      `user:psup:charge:${charge.id.slice(0, 8)}`,
    ).row();
  }
  kb.text("بازگشت", "user:psup:home");
  await safeEditOrReply(ctx, "↩️ وضعیت بازپرداخت‌های شما", kb);
});

// --- report a problem → category picker --------------------------------------

function categoryKeyboard(shortId: string | null): InlineKeyboard {
  const suffix = shortId === null ? "" : `:${shortId}`;
  const back = shortId === null ? "user:psup:home" : `user:psup:charge:${shortId}`;
  return new InlineKeyboard()
    .text(CATEGORY_FA.norenew, `user:psup:cat:norenew${suffix}`)
    .row()
    .text(CATEGORY_FA.dup, `user:psup:cat:dup${suffix}`)
    .row()
    .text(CATEGORY_FA.refund, `user:psup:cat:refund${suffix}`)
    .row()
    .text(CATEGORY_FA.cancel, `user:psup:cat:cancel${suffix}`)
    .row()
    .text(CATEGORY_FA.other, `user:psup:cat:other${suffix}`)
    .row()
    .text("بازگشت", back);
}

paysupportHandler.callbackQuery("user:psup:report", async (ctx) => {
  if (ctx.dbUser === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "لطفاً نوع مشکل پرداخت خود را انتخاب کنید:", categoryKeyboard(null));
});

paysupportHandler.callbackQuery(/^user:psup:report:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const charge = await resolveOwnedCharge(ctx.match[1], user.id);
  if (charge === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `گزارش مشکل برای پرداخت #${maskedRef(charge)}\n\nلطفاً نوع مشکل را انتخاب کنید:`,
    categoryKeyboard(charge.id.slice(0, 8)),
  );
});

// --- category chosen → create a structured support ticket --------------------

function paymentTicketSubject(code: CategoryCode): string {
  return `پشتیبانی پرداخت — ${CATEGORY_FA[code]}`.slice(0, TICKET_SUBJECT_MAX);
}

async function submitPaymentTicket(
  ctx: BotContext,
  userId: string,
  code: CategoryCode,
  message: string,
): Promise<void> {
  const outcome = await createSupportTicket(userId, paymentTicketSubject(code), message);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    return;
  }
  // Fault-isolated inside the service; never rolls back the created ticket.
  await notifyAdminsAboutNewTicket(ctx.api, outcome.ticket.id);
  await safeAnswerCallback(ctx, "تیکت پشتیبانی ثبت شد ✅");
  const kb = new InlineKeyboard()
    .text("مشاهده تیکت 🎫", `user:sup:view:${outcome.ticket.id.slice(0, 8)}`)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(
    ctx,
    "تیکت پشتیبانی شما ثبت شد ✅\n\nکارشناسان ما در اسرع وقت پیگیری می‌کنند.",
    kb,
  );
}

paysupportHandler.callbackQuery(/^user:psup:cat:([a-z]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const code = ctx.match[1];
  if (!isCategoryCode(code)) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const charge = await resolveOwnedCharge(ctx.match[2], user.id);
  if (charge === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const message = [
    `دسته: ${CATEGORY_FA[code]}`,
    `کد پیگیری پرداخت: #${maskedRef(charge)}`,
    `وضعیت پرداخت: ${CHARGE_STATUS_FA[charge.status]}`,
    `وضعیت اشتراک: ${SUB_STATUS_FA[charge.subscription.status]}`,
    `زمان ثبت: ${nowStamp()}`,
  ].join("\n");
  await submitPaymentTicket(ctx, user.id, code, message);
});

paysupportHandler.callbackQuery(/^user:psup:cat:([a-z]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const code = ctx.match[1];
  if (!isCategoryCode(code)) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const message = [
    `دسته: ${CATEGORY_FA[code]}`,
    "این درخواست از بخش پشتیبانی پرداخت ثبت شده است.",
    `زمان ثبت: ${nowStamp()}`,
  ].join("\n");
  await submitPaymentTicket(ctx, user.id, code, message);
});
