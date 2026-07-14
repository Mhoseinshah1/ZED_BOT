import {
  CheckoutStatus,
  type CheckoutSession,
  type PaymentGateway,
  type User,
} from "@zedbot/database";
import { decryptSecret, errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  notifyAdminsAboutReceipt,
  type ReceiptKind,
} from "../../services/admin-receipt-notification.service.js";
import {
  checkoutShortId,
  getCheckoutByShortId,
  getOwnedCheckout,
} from "../../services/checkout.service.js";
import {
  fulfillSettledGatewayOrder,
  getOrCreateGatewayPayment,
  getUserGatewayPaymentByShortId,
  isOnlineProvider,
  settleGatewayPayment,
} from "../../services/gateway-payment.service.js";
import { paymentPageNotice } from "../../services/payment-settings.service.js";
import {
  getAvailablePaymentMethods,
  getGatewayByShortId,
  getPendingReviewPayment,
  hasDormantOnlineGateways,
  pickCardAccountForGateway,
  submitReceipt,
} from "../../services/payment-method.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { clearCheckoutState } from "./checkout-state.js";
import {
  CARD_INFO_INCOMPLETE_TEXT,
  cardToCardKeyboard,
  cardToCardText,
  CHECKOUT_EXPIRED_TEXT,
  formatCardNumber,
  gatewayFailedKeyboard,
  gatewayPaymentKeyboard,
  gatewayPaymentText,
  NO_METHODS_TEXT,
  PAY_CB,
  paycb,
  paymentMethodsKeyboard,
  paymentMethodsText,
  RECEIPT_WAITING_TEXT,
  receiptRegisteredKeyboard,
} from "./payment-views.js";

const HTML = { parseMode: "HTML" as const };
const RECEIPT_PROMPT = "لطفاً تصویر یا فایل رسید پرداخت را ارسال کنید.";
const RECEIPT_KIND_ERROR = "لطفاً رسید را به صورت عکس، فایل یا متن ارسال کنید.";

export const paymentHandler = new Composer<BotContext>();

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("منوی اصلی", CB.USER_MENU);
}

function checkoutIsExpired(checkout: CheckoutSession): boolean {
  return checkout.expiresAt.getTime() <= Date.now();
}

/**
 * Renders the payment-method list for a PENDING, unexpired checkout.
 * Exported for the checkout handler (shown right after checkout creation).
 */
export async function showPaymentMethods(
  ctx: BotContext,
  checkout: CheckoutSession,
  options: { created: boolean },
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  if (checkout.status !== CheckoutStatus.PENDING || checkoutIsExpired(checkout)) {
    await safeEditOrReply(ctx, CHECKOUT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const pending = await getPendingReviewPayment(checkout.id);
  if (pending !== null) {
    await safeEditOrReply(ctx, RECEIPT_WAITING_TEXT, menuKeyboard());
    return;
  }
  const gateways = await getAvailablePaymentMethods(user, checkout);
  if (gateways.length === 0) {
    // Provider-management phase: online gateway rows that exist but are
    // admin-disabled (or adapter-unavailable) get the dedicated empty state.
    const text = (await hasDormantOnlineGateways())
      ? await getMessageTemplate("payment_no_online_methods_text")
      : NO_METHODS_TEXT;
    await safeEditOrReply(ctx, text, paymentMethodsKeyboard(checkout, []));
    return;
  }
  // Phase 22: operator notice under the method list (escaped inside the view).
  const notice = await paymentPageNotice();
  await safeEditOrReply(
    ctx,
    paymentMethodsText(options.created, checkout.finalPriceToman, notice),
    paymentMethodsKeyboard(checkout, gateways),
    HTML,
  );
}

// --- method list -------------------------------------------------------------------

paymentHandler.callbackQuery(/^user:pay:m:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const checkout = await getCheckoutByShortId(ctx.match[1], user.id);
  if (checkout === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  await showPaymentMethods(ctx, checkout, { created: false });
});

// --- gateway selection ---------------------------------------------------------------

paymentHandler.callbackQuery(/^user:pay:g:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const checkout = await getCheckoutByShortId(ctx.match[1], user.id);
  if (checkout === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  if (checkout.status !== CheckoutStatus.PENDING || checkoutIsExpired(checkout)) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, CHECKOUT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const gateway = await getGatewayByShortId(ctx.match[2]);
  if (gateway === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  // Provider-management phase: an admin-disabled provider can never be
  // selected manually - stale buttons answer with the unavailable template.
  if (!gateway.isEnabled) {
    await safeAnswerCallback(ctx, await getMessageTemplate("payment_gateway_unavailable_text"));
    return;
  }
  // Re-validate eligibility so stale buttons cannot bypass the filters.
  const available = await getAvailablePaymentMethods(user, checkout);
  if (!available.some((g) => g.id === gateway.id)) {
    await safeAnswerCallback(ctx, "این روش پرداخت در دسترس نیست.");
    return;
  }

  if (gateway.type !== "CARD_TO_CARD") {
    if (isOnlineProvider(gateway.type)) {
      await startOnlineGatewayPayment(ctx, user, checkout, gateway);
      return;
    }
    // PLISIO / AGHAYEPARDAKHT / CUSTOM have no adapter yet.
    await safeAnswerCallback(ctx, await getMessageTemplate("payment_gateway_unavailable_text"));
    return;
  }

  const pending = await getPendingReviewPayment(checkout.id);
  if (pending !== null) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, RECEIPT_WAITING_TEXT, menuKeyboard());
    return;
  }

  const account = await pickCardAccountForGateway(gateway.id);
  if (account === null) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, NO_METHODS_TEXT, paymentMethodsKeyboard(checkout, []));
    return;
  }

  let cardNumber: string;
  try {
    cardNumber = decryptSecret(account.cardNumberEncrypted);
  } catch (err) {
    logger.error("card number decryption failed", {
      cardAccountId: account.id,
      error: errorMessage(err),
    });
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, CARD_INFO_INCOMPLETE_TEXT, paymentMethodsKeyboard(checkout, []));
    return;
  }

  ctx.session.currentFlow = null;
  ctx.session.temp.paymentDraft = {
    checkoutSessionId: checkout.id,
    paymentGatewayId: gateway.id,
    cardAccountId: account.id,
    cardNumber,
    amountToman: checkout.finalPriceToman,
  };
  await safeAnswerCallback(ctx);
  const text =
    gateway.instructionText !== null && gateway.instructionText !== ""
      ? `${cardToCardText(checkout, account, cardNumber)}\n\n${escapeHtml(gateway.instructionText)}`
      : cardToCardText(checkout, account, cardNumber);
  await safeEditOrReply(ctx, text, cardToCardKeyboard(checkout, cardNumber), HTML);
});

// --- online gateways (Zarinpal / NOWPayments / Telegram Stars) --------------------------

/**
 * Creates (or reuses) the gateway payment for the checkout and renders the
 * provider-specific screen: redirect URL button for Zarinpal/NOWPayments, a
 * Telegram Stars invoice for TELEGRAM_STARS. Money NEVER moves here - the
 * settlement service owns that, triggered by callbacks/updates/the check
 * button.
 */
async function startOnlineGatewayPayment(
  ctx: BotContext,
  user: User,
  checkout: CheckoutSession,
  gateway: PaymentGateway,
): Promise<void> {
  const result = await getOrCreateGatewayPayment(user, checkout, gateway);
  if (!result.ok) {
    await safeAnswerCallback(ctx, result.error);
    return;
  }
  const coSid = checkoutShortId(checkout);
  const paySid = result.payment.id.slice(0, 8);

  if (gateway.type === "ZARINPAL" || gateway.type === "NOWPAYMENTS") {
    const redirectUrl = result.create.redirectUrl;
    if (redirectUrl === undefined) {
      logger.error("gateway payment without redirect url", { paymentId: result.payment.id });
      await safeAnswerCallback(ctx, await getMessageTemplate("payment_gateway_unavailable_text"));
      return;
    }
    const isZarinpal = gateway.type === "ZARINPAL";
    const base = await getMessageTemplate(
      isZarinpal ? "payment_redirect_text" : "payment_crypto_created_text",
    );
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      isZarinpal ? gatewayPaymentText(base, checkout.finalPriceToman) : base,
      gatewayPaymentKeyboard(coSid, paySid, {
        text: isZarinpal ? "پرداخت آنلاین 🇮🇷" : "پرداخت کریپتویی 🌐",
        url: redirectUrl,
      }),
    );
    return;
  }

  // TELEGRAM_STARS: the ready-text first, then the native Telegram invoice.
  const invoice = result.create.telegramInvoice;
  if (invoice === undefined) {
    logger.error("stars payment without invoice spec", { paymentId: result.payment.id });
    await safeAnswerCallback(ctx, await getMessageTemplate("payment_gateway_unavailable_text"));
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    await getMessageTemplate("payment_stars_ready_text"),
    gatewayPaymentKeyboard(coSid, paySid),
  );
  try {
    // Stars invoices (currency XTR) take no provider token - grammY 1.44
    // types provider_token as optional, so it is omitted entirely.
    await ctx.api.sendInvoice(
      ctx.chat?.id ?? user.telegramId.toString(),
      invoice.title,
      invoice.description,
      invoice.payload,
      "XTR",
      [{ label: "پرداخت", amount: invoice.stars }],
    );
  } catch (err) {
    logger.error("stars invoice send failed", {
      paymentId: result.payment.id,
      error: errorMessage(err),
    });
    await safeReply(ctx, await getMessageTemplate("payment_gateway_unavailable_text"));
  }
}

// «بررسی وضعیت پرداخت ♻️»: manual settlement trigger. settleGatewayPayment is
// CAS-gated, so mashing the button can never settle twice.
paymentHandler.callbackQuery(/^user:pay:chk:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const payment = await getUserGatewayPaymentByShortId(user.id, ctx.match[1]);
  if (payment === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  const outcome = await settleGatewayPayment(payment.id);
  if (outcome.kind === "settled" || outcome.kind === "already") {
    await safeAnswerCallback(ctx);
    await fulfillSettledGatewayOrder(ctx.api, outcome);
    await safeEditOrReply(ctx, await getMessageTemplate("payment_success_text"), menuKeyboard());
    return;
  }
  if (outcome.kind === "pending") {
    await safeAnswerCallback(ctx, await getMessageTemplate("payment_pending_text"));
    return;
  }
  if (outcome.kind === "failed") {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      await getMessageTemplate("payment_failed_text"),
      gatewayFailedKeyboard(payment.checkoutSessionId?.slice(0, 8) ?? null),
    );
    return;
  }
  await safeAnswerCallback(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
});

// --- legacy copy callbacks (Phase 21.1) -------------------------------------------------
// New keyboards use Telegram copy_text buttons (client-side clipboard, no
// callback). These handlers remain ONLY for old messages that still carry
// the callback buttons: they answer with a popup and NEVER send a chat
// message.

paymentHandler.callbackQuery(PAY_CB.COPY_CARD, async (ctx) => {
  const draft = ctx.session.temp.paymentDraft;
  if (draft?.cardNumber === undefined) {
    await safeAnswerCallback(ctx, "برای کپی، از دکمه جدید کپی استفاده کنید.");
    return;
  }
  await safeAnswerCallback(ctx, formatCardNumber(draft.cardNumber));
});

paymentHandler.callbackQuery(PAY_CB.COPY_AMOUNT, async (ctx) => {
  const draft = ctx.session.temp.paymentDraft;
  if (draft === undefined) {
    await safeAnswerCallback(ctx, "برای کپی، از دکمه جدید کپی استفاده کنید.");
    return;
  }
  await safeAnswerCallback(ctx, `${draft.amountToman}`);
});

// --- receipt flow ----------------------------------------------------------------------

paymentHandler.callbackQuery(PAY_CB.SEND_RECEIPT, async (ctx) => {
  const draft = ctx.session.temp.paymentDraft;
  if (draft === undefined) {
    await safeAnswerCallback(ctx, "ابتدا روش پرداخت را انتخاب کنید.");
    return;
  }
  ctx.session.currentFlow = "payment:receipt";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    RECEIPT_PROMPT,
    new InlineKeyboard().text("انصراف", paycb.methods(draft.checkoutSessionId.slice(0, 8))),
  );
});

/**
 * Receipt intake (photo / document / text) while in the payment:receipt flow.
 * Routed from app.ts; anything else falls through untouched.
 */
export const paymentReceiptHandler = new Composer<BotContext>();

paymentReceiptHandler.on("message", async (ctx, next) => {
  if (ctx.session.currentFlow !== "payment:receipt") {
    return next();
  }
  const text = ctx.message.text;
  // Commands abandon the receipt flow and run normally.
  if (text !== undefined && text.startsWith("/")) {
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.paymentDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    clearCheckoutState(ctx);
    await safeReply(ctx, CHECKOUT_EXPIRED_TEXT, menuKeyboard());
    return;
  }

  // Accepted kinds: photo (largest size), document, plain text. The kind is
  // remembered here (ManualReceipt has no kind column) so the admin
  // notification can forward the media correctly.
  let receipt: { fileId?: string; text?: string } | null = null;
  let receiptKind: ReceiptKind = "TEXT";
  const photos = ctx.message.photo;
  if (photos !== undefined && photos.length > 0) {
    receipt = { fileId: photos[photos.length - 1].file_id, text: ctx.message.caption };
    receiptKind = "PHOTO";
  } else if (ctx.message.document !== undefined) {
    receipt = { fileId: ctx.message.document.file_id, text: ctx.message.caption };
    receiptKind = "DOCUMENT";
  } else if (text !== undefined && text.trim().length > 0) {
    receipt = { text: text.trim().slice(0, 1000) };
  }
  if (receipt === null) {
    await safeReply(ctx, RECEIPT_KIND_ERROR);
    return;
  }

  try {
    const checkout = await getOwnedCheckout(draft.checkoutSessionId, user.id);
    if (
      checkout === null ||
      checkout.status !== CheckoutStatus.PENDING ||
      checkoutIsExpired(checkout)
    ) {
      clearCheckoutState(ctx);
      await safeReply(ctx, CHECKOUT_EXPIRED_TEXT, menuKeyboard());
      return;
    }
    const result = await submitReceipt(
      user,
      checkout,
      draft.paymentGatewayId,
      draft.cardAccountId,
      receipt,
    );
    clearCheckoutState(ctx);
    if (!result.ok) {
      await safeReply(ctx, result.error, menuKeyboard());
      return;
    }
    logger.info("manual receipt submitted", {
      paymentId: result.payment.id,
      checkoutSessionId: checkout.id,
      userId: user.id,
    });
    const submittedText =
      checkout.purpose === "WALLET_CHARGE"
        ? "رسید شارژ کیف پول شما با موفقیت ثبت شد و در انتظار بررسی است."
        : "رسید شما با موفقیت ثبت شد و در انتظار بررسی است.";
    await safeReply(ctx, submittedText, receiptRegisteredKeyboard());
    // Phase 21.1: forward the receipt to active admins for review. The
    // helper never throws and a failed send never rolls back the receipt.
    await notifyAdminsAboutReceipt(ctx.api, {
      payment: result.payment,
      checkout,
      user,
      receiptKind,
      receiptFileId: receipt.fileId,
      receiptText: receipt.text,
      cardNumber: draft.cardNumber,
      cardAccountId: draft.cardAccountId,
    });
  } catch (err) {
    clearCheckoutState(ctx);
    logger.error("receipt submission failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});
