import { prisma } from "@zedbot/database";
import {
  buildStarsSubscriptionPayload,
  errorMessage,
  parseStarsSubscriptionPayload,
  STARS_CURRENCY,
} from "@zedbot/shared";
import { buildStarsSubscriptionInvoice } from "@zedbot/payments";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { getProductByShortId } from "../../services/product.service.js";
import { getRenewableServiceByShortId } from "../../services/renewal-checkout.service.js";
import {
  beginStarsEnrollment,
  getOwnedSubscriptionByShortId,
  getSubscriptionByPayloadId,
  getSubscriptionForService,
  isStarsSubscriptionsOperational,
  isSubscriptionProductEligible,
  listUserSubscriptions,
  subscriptionPlansForService,
  subscriptionShortId,
} from "../../services/stars-subscription.service.js";
import { settleTelegramStarsSubscriptionCharge } from "../../services/stars-subscription-settlement.service.js";
import {
  cancelTelegramExtension,
  refundStarsSubscriptionCharge,
  type StarsBotApi,
} from "../../services/stars-subscription-refund.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  starsConsentText,
  starsIntroKeyboard,
  starsIntroText,
  starsPlansKeyboard,
  starsStatusKeyboard,
  starsStatusText,
  starsSubscriptionsListKeyboard,
  STARS_LIST_EMPTY_TEXT,
  subCb,
  walletConflictKeyboard,
  WALLET_CONFLICT_TEXT,
} from "./stars-subscription-views.js";

// =============================================================================
// Telegram Stars subscriptions — user handler (Phase 2). Owns the recurring
// pre_checkout_query and successful_payment updates for `zedbot:sub:` payloads
// (the one-time stars handler defers them), plus the enrollment/status/cancel UI.
// The one-time Stars path is untouched. Every update handler always answers
// safely and never exposes internal reasons.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const NOT_FOUND = "مورد یافت نشد.";
const INVALID_PRECHECKOUT_TEXT = "این اشتراک دیگر معتبر نیست. لطفاً دوباره از صفحه سرویس اقدام کنید.";

/** The gated user-area composer (enrollment / status / cancel callbacks). */
export const starsSubscriptionHandler = new Composer<BotContext>();

/**
 * The pre-gate composer for the recurring Telegram payment updates (pre_checkout
 * + successful_payment). Registered BEFORE the access gates (like the one-time
 * stars handler) so a paying user always reaches settlement.
 */
export const starsSubscriptionPaymentHandler = new Composer<BotContext>();

// --- pre_checkout (Part K) ---------------------------------------------------

starsSubscriptionPaymentHandler.on("pre_checkout_query", async (ctx, next) => {
  const query = ctx.preCheckoutQuery;
  const payloadId = parseStarsSubscriptionPayload(query.invoice_payload);
  if (payloadId === null) {
    return next();
  }
  try {
    const ok = await validateSubscriptionPreCheckout(payloadId, query);
    await ctx.answerPreCheckoutQuery(ok, ok ? undefined : { error_message: INVALID_PRECHECKOUT_TEXT });
  } catch (err) {
    logger.error("stars subscription pre-checkout failed", { error: errorMessage(err) });
    try {
      await ctx.answerPreCheckoutQuery(false, { error_message: INVALID_PRECHECKOUT_TEXT });
    } catch {
      /* already answered / unreachable */
    }
  }
});

async function validateSubscriptionPreCheckout(
  payloadId: string,
  query: { from: { id: number }; currency: string; total_amount: number },
): Promise<boolean> {
  if (query.currency !== STARS_CURRENCY) {
    return false;
  }
  if (!(await isStarsSubscriptionsOperational())) {
    return false;
  }
  const sub = await getSubscriptionByPayloadId(payloadId);
  if (sub === null || sub.status === "CANCELLED" || sub.status === "EXPIRED") {
    return false;
  }
  if (query.total_amount !== sub.starsAmount) {
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: sub.userId } });
  if (user === null || user.telegramId !== BigInt(query.from.id)) {
    return false;
  }
  // The live Product must still be subscription-enabled at the FROZEN version.
  const product = await prisma.product.findUnique({
    where: { id: sub.productId },
    include: { category: true, panel: true },
  });
  const service = await prisma.service.findUnique({ where: { id: sub.serviceId } });
  if (
    product === null ||
    service === null ||
    product.telegramStarsSubscriptionVersion !== sub.productVersion ||
    !isSubscriptionProductEligible(product, service, user.group)
  ) {
    return false;
  }
  // No open financial reconciliation may block enrollment.
  const openReview = await prisma.financialReconciliationCase.count({
    where: { userId: sub.userId, status: { in: ["OPEN", "IN_REVIEW"] } },
  });
  return openReview === 0;
}

// --- successful_payment (Parts L/M/N/R) --------------------------------------

starsSubscriptionPaymentHandler.on("message:successful_payment", async (ctx, next) => {
  const sp = ctx.message.successful_payment;
  const payloadId = parseStarsSubscriptionPayload(sp.invoice_payload);
  if (payloadId === null) {
    return next();
  }
  try {
    if (sp.currency !== STARS_CURRENCY || sp.is_recurring !== true) {
      logger.warn("stars subscription payment missing recurring metadata");
      return;
    }
    if (sp.subscription_expiration_date === undefined) {
      logger.warn("stars subscription payment missing expiration");
      return;
    }
    const sub = await getSubscriptionByPayloadId(payloadId);
    if (sub === null) {
      logger.error("stars subscription payment for unknown payload");
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: sub.userId } });
    if (user === null || user.telegramId !== BigInt(ctx.from.id)) {
      logger.error("stars subscription payment did not match an owned subscription");
      return;
    }
    const result = await settleTelegramStarsSubscriptionCharge(ctx.api, sub, {
      telegramPaymentChargeId: sp.telegram_payment_charge_id,
      providerPaymentChargeId: sp.provider_payment_charge_id ?? null,
      starsAmount: sp.total_amount,
      isFirstRecurring: sp.is_first_recurring === true,
      subscriptionExpirationDate: new Date(sp.subscription_expiration_date * 1000),
    });
    if (result.kind === "refund-required") {
      await refundStarsSubscriptionCharge(ctx.api as unknown as StarsBotApi, result.chargeId);
    }
  } catch (err) {
    logger.error("stars subscription successful_payment failed", { error: errorMessage(err) });
  }
});

// --- enrollment UI (Part H) --------------------------------------------------

async function renderServiceSubscription(ctx: BotContext, shortId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(shortId, user.id);
  if (service === null || service.expiresAt === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const existing = await getSubscriptionForService(user.id, service.id);
  await safeAnswerCallback(ctx);
  if (existing !== null && existing.status !== "CANCELLED" && existing.status !== "EXPIRED" && existing.status !== "PENDING_PAYMENT") {
    await safeEditOrReply(ctx, starsStatusText(existing, service), starsStatusKeyboard(existing), HTML);
    return;
  }
  if (!(await isStarsSubscriptionsOperational())) {
    await safeEditOrReply(ctx, "اشتراک ماهانه Stars در حال حاضر در دسترس نیست.", new InlineKeyboard().text("بازگشت", `user:svc:view:${shortId}`));
    return;
  }
  await safeEditOrReply(ctx, starsIntroText(service), starsIntroKeyboard(service), HTML);
}

starsSubscriptionHandler.callbackQuery(/^user:sub:svc:([0-9a-f-]+)$/, async (ctx) => {
  await renderServiceSubscription(ctx, ctx.match[1]);
});

starsSubscriptionHandler.callbackQuery(/^user:sub:start:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const plans = await subscriptionPlansForService(service, user.group);
  await safeAnswerCallback(ctx);
  if (plans.length === 0) {
    await safeEditOrReply(ctx, "پلن اشتراکی برای این سرویس موجود نیست.", new InlineKeyboard().text("بازگشت", subCb.svc(ctx.match[1])));
    return;
  }
  await safeEditOrReply(ctx, "پلن اشتراک ماهانه را انتخاب کنید:", starsPlansKeyboard(service, plans), HTML);
});

/** Plan chosen → consent review + (build pending enrollment on confirm). */
starsSubscriptionHandler.callbackQuery(/^user:sub:plan:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
  const product = await getProductByShortId(ctx.match[2]);
  if (service === null || product === null || !isSubscriptionProductEligible(product, service, user.group)) {
    await safeAnswerCallback(ctx, "این پلن در دسترس نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("تایید شرایط و ساخت فاکتور ⭐", subCb.confirm(ctx.match[1], ctx.match[2], false))
    .row()
    .text("تغییر پلن", subCb.start(ctx.match[1]))
    .row()
    .text("انصراف", subCb.svc(ctx.match[1]));
  await safeEditOrReply(ctx, starsConsentText(service, product), kb, HTML);
});

// Confirm → create/reuse pending enrollment → createInvoiceLink → URL button.
starsSubscriptionHandler.callbackQuery(
  /^user:sub:confirm:([0-9a-f-]+):([0-9a-f-]+):(0|1)$/,
  async (ctx) => {
    const user = ctx.dbUser;
    if (user === null) {
      return;
    }
    const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
    const product = await getProductByShortId(ctx.match[2]);
    if (service === null || product === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const supersedeWallet = ctx.match[3] === "1";
    let outcome;
    try {
      outcome = await beginStarsEnrollment(user, { service, product, supersedeWallet });
    } catch (err) {
      logger.error("stars enrollment failed", { error: errorMessage(err) });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
      return;
    }
    if (outcome.status === "wallet-conflict") {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, WALLET_CONFLICT_TEXT, walletConflictKeyboard(ctx.match[1], ctx.match[2]), HTML);
      return;
    }
    if (outcome.status === "already-subscribed") {
      await safeAnswerCallback(ctx, "برای این سرویس اشتراک فعال است.");
      await renderServiceSubscription(ctx, ctx.match[1]);
      return;
    }
    if (outcome.status !== "ready") {
      await safeAnswerCallback(ctx, "امکان فعال‌سازی اشتراک وجود ندارد.");
      return;
    }
    // Build the recurring invoice link (createInvoiceLink, subscription_period).
    const invoice = buildStarsSubscriptionInvoice({
      title: `اشتراک ${product.name}`,
      description: `تمدید خودکار ماهانه سرویس با پلن ${product.name}`,
      payload: buildStarsSubscriptionPayload(outcome.subscription.publicPayloadId),
      starsAmount: outcome.subscription.starsAmount,
    });
    if (!invoice.ok) {
      await safeAnswerCallback(ctx, "ساخت فاکتور اشتراک ناموفق بود.");
      return;
    }
    try {
      const link = await ctx.api.createInvoiceLink(
        invoice.params.title,
        invoice.params.description,
        invoice.params.payload,
        "",
        invoice.params.currency,
        invoice.params.prices,
        { subscription_period: invoice.params.subscriptionPeriod },
      );
      await safeAnswerCallback(ctx);
      await safeEditOrReply(
        ctx,
        "برای فعال‌سازی اشتراک ماهانه، روی دکمهٔ زیر بزنید و پرداخت را کامل کنید ⭐",
        new InlineKeyboard().url("پرداخت اشتراک ⭐", link).row().text("بازگشت", subCb.svc(ctx.match[1])),
      );
    } catch (err) {
      logger.error("createInvoiceLink failed", { error: errorMessage(err) });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, "ساخت لینک پرداخت ناموفق بود. لطفاً دوباره تلاش کنید.");
    }
  },
);

// --- my subscriptions list + detail + cancel ---------------------------------

starsSubscriptionHandler.callbackQuery(subCb.list, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const subs = await listUserSubscriptions(user.id);
  await safeAnswerCallback(ctx);
  if (subs.length === 0) {
    await safeEditOrReply(ctx, STARS_LIST_EMPTY_TEXT, new InlineKeyboard().text("بازگشت به منو", CB.USER_MENU));
    return;
  }
  const services = await prisma.service.findMany({
    where: { id: { in: subs.map((s) => s.serviceId) } },
    select: { id: true, username: true },
  });
  const nameById = new Map(services.map((s) => [s.id, s.username]));
  await safeEditOrReply(
    ctx,
    "⭐ اشتراک‌های Stars شما",
    starsSubscriptionsListKeyboard(subs.map((s) => ({ sub: s, username: nameById.get(s.serviceId) ?? "-" }))),
  );
});

async function renderSubscriptionDetail(ctx: BotContext, shortId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const sub = await getOwnedSubscriptionByShortId(shortId, user.id);
  if (sub === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const service = await prisma.service.findUnique({ where: { id: sub.serviceId } });
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, starsStatusText(sub, service), starsStatusKeyboard(sub), HTML);
}

starsSubscriptionHandler.callbackQuery(/^user:sub:m:([0-9a-f-]+)$/, async (ctx) => {
  await renderSubscriptionDetail(ctx, ctx.match[1]);
});

starsSubscriptionHandler.callbackQuery(/^user:sub:cancel:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const sub = await getOwnedSubscriptionByShortId(ctx.match[1], user.id);
  if (sub === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "آیا تمدید دوره‌های بعدی این اشتراک لغو شود؟\n\nسرویس تا پایان دوره‌ای که پرداخت شده فعال باقی می‌ماند و مبلغ دوره فعلی بازپرداخت نمی‌شود.",
    new InlineKeyboard().text("لغو تمدید دوره‌های بعدی", subCb.cancelYes(ctx.match[1])).row().text("انصراف", subCb.detail(ctx.match[1])),
  );
});

starsSubscriptionHandler.callbackQuery(/^user:sub:cancel:([0-9a-f-]+):yes$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const sub = await getOwnedSubscriptionByShortId(ctx.match[1], user.id);
  if (sub === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // Cancel future extension via Telegram FIRST; only persist on API success.
  const ok = await cancelTelegramExtension(ctx.api as unknown as StarsBotApi, sub);
  if (!ok) {
    await safeAnswerCallback(ctx, "لغو در تلگرام انجام نشد. لطفاً دوباره تلاش کنید.");
    return;
  }
  await prisma.telegramStarsServiceSubscription.updateMany({
    where: { id: sub.id, userId: user.id, status: { in: ["ACTIVE", "PAST_DUE", "REQUIRES_ACTION"] } },
    data: { status: "CANCEL_AT_PERIOD_END", telegramExtensionCanceled: true, cancellationRequestedAt: new Date(), cancellationConfirmedAt: new Date() },
  });
  logger.info("stars subscription cancelled by user", { subscriptionId: sub.id.slice(0, 8) });
  await safeAnswerCallback(ctx, "تمدید دوره‌های بعدی لغو شد.");
  await renderSubscriptionDetail(ctx, ctx.match[1]);
});

export { subscriptionShortId };
