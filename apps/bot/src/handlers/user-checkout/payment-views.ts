import type { CardToCardAccount, CheckoutSession, PaymentGateway } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import { checkoutShortId } from "../../services/checkout.service.js";
import { gatewayShortId } from "../../services/payment-method.service.js";
import { escapeHtml } from "../../utils/html.js";
import { ccb } from "./checkout-cb.js";

export const PAY_CB = {
  COPY_CARD: "user:pay:copycard",
  COPY_AMOUNT: "user:pay:copyamount",
  SEND_RECEIPT: "user:pay:receipt",
} as const;

export const paycb = {
  methods: (coSid: string): string => `user:pay:m:${coSid}`,
  gateway: (coSid: string, gwSid: string): string => `user:pay:g:${coSid}:${gwSid}`,
} as const;

export const NO_METHODS_TEXT =
  "فعلاً روش پرداختی برای این مبلغ فعال نیست. لطفاً بعداً تلاش کنید یا با پشتیبانی تماس بگیرید.";
export const CARD_INFO_INCOMPLETE_TEXT =
  "اطلاعات روش پرداخت کامل نیست. لطفاً با پشتیبانی تماس بگیرید.";
export const METHOD_LATER_TEXT = "این روش پرداخت در حال حاضر در دسترس نیست.";
export const RECEIPT_WAITING_TEXT = "رسید شما در انتظار بررسی است.";
export const CHECKOUT_EXPIRED_TEXT = "این پیش‌فاکتور منقضی شده است. لطفاً دوباره اقدام کنید.";

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/** 16-digit numbers get grouped for readability; anything else stays as-is. */
export function formatCardNumber(cardNumber: string): string {
  if (/^\d{16}$/.test(cardNumber)) {
    return cardNumber.replace(/(\d{4})(?=\d)/g, "$1-");
  }
  return cardNumber;
}

// --- Payment method selection ---------------------------------------------------

export function paymentMethodsText(
  created: boolean,
  amountToman: number,
  noticeText: string | null = null,
): string {
  const head = created ? "پیش‌فاکتور ثبت شد ✅\n\n" : "";
  const base = `${head}مبلغ قابل پرداخت: ${formatToman(amountToman)}\n\nروش پرداخت را انتخاب کنید:`;
  // Phase 22 operator notice - HTML-escaped, appended below the method list.
  return noticeText === null || noticeText === ""
    ? base
    : `${base}\n\n${escapeHtml(noticeText)}`;
}

export function paymentMethodsKeyboard(
  checkout: CheckoutSession,
  gateways: PaymentGateway[],
): InlineKeyboard {
  const coSid = checkoutShortId(checkout);
  const kb = new InlineKeyboard();
  for (const gateway of gateways) {
    kb.text(gateway.name, paycb.gateway(coSid, gatewayShortId(gateway))).row();
  }
  kb.text("مشاهده پیش‌فاکتور", ccb.viewCheckout(coSid)).row();
  kb.text("منوی اصلی", CB.USER_MENU);
  return kb;
}

// --- Card-to-card screen ----------------------------------------------------------

export function cardToCardText(
  checkout: CheckoutSession,
  account: CardToCardAccount,
  cardNumber: string,
): string {
  return [
    `برای تکمیل پرداخت، مبلغ ${formatToman(checkout.finalPriceToman)} را واریز کنید:`,
    "",
    "====================",
    `<code>${escapeHtml(formatCardNumber(cardNumber))}</code>`,
    escapeHtml(account.ownerName),
    "====================",
    "",
    "سپس روی «پرداخت کردم» بزنید و رسید را ارسال کنید.",
    "",
    `⏱ مهلت پرداخت: ${checkout.expiresAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
  ].join("\n");
}

/**
 * Card-to-card actions. The copy buttons are Telegram `copy_text` buttons
 * (Bot API 7.11+): the client writes the RAW value straight to the
 * clipboard - no callback round-trip and no extra chat message. The visible
 * message shows the dashed card number; the button copies raw digits and
 * the plain numeric amount (copy_text is limited to 1..256 chars - both
 * values are far below that).
 */
export function cardToCardKeyboard(
  checkout: CheckoutSession,
  cardNumber: string,
): InlineKeyboard {
  const coSid = checkoutShortId(checkout);
  return new InlineKeyboard()
    .copyText("کپی مبلغ", String(checkout.finalPriceToman))
    .copyText("کپی شماره کارت", cardNumber)
    .row()
    .text("پرداخت کردم ✅", PAY_CB.SEND_RECEIPT)
    .text("بازگشت", paycb.methods(coSid))
    .row()
    .text("منوی اصلی", CB.USER_MENU);
}

export function receiptRegisteredKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منوی اصلی", CB.USER_MENU);
}
