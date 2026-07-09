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
export const METHOD_LATER_TEXT = "این روش پرداخت در فاز بعدی فعال می‌شود.";
export const RECEIPT_WAITING_TEXT = "رسید شما در انتظار بررسی است.";
export const CHECKOUT_EXPIRED_TEXT = "این پیش‌فاکتور منقضی شده است. لطفاً دوباره خرید را شروع کنید.";

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

export function paymentMethodsText(created: boolean, amountToman: number): string {
  const head = created ? "پیش‌فاکتور ثبت شد ✅\n\n" : "";
  return `${head}مبلغ قابل پرداخت: ${formatToman(amountToman)}\n\nروش پرداخت را انتخاب کنید:`;
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
    "پرداخت کارت به کارت 💳",
    "",
    `مبلغ دقیق: <b>${formatToman(checkout.finalPriceToman)}</b>`,
    `شماره کارت: <code>${escapeHtml(formatCardNumber(cardNumber))}</code>`,
    `نام صاحب کارت: ${escapeHtml(account.ownerName)}`,
    `مهلت پرداخت: ${checkout.expiresAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    "",
    "⚠️ دقیقاً همین مبلغ را واریز کنید.",
    "بعد از واریز، رسید را ارسال کنید.",
  ].join("\n");
}

export function cardToCardKeyboard(checkout: CheckoutSession): InlineKeyboard {
  const coSid = checkoutShortId(checkout);
  return new InlineKeyboard()
    .text("کپی شماره کارت", PAY_CB.COPY_CARD)
    .text("کپی مبلغ", PAY_CB.COPY_AMOUNT)
    .row()
    .text("ارسال رسید 🧾", PAY_CB.SEND_RECEIPT)
    .row()
    .text("بازگشت به روش‌های پرداخت", paycb.methods(coSid))
    .text("منوی اصلی", CB.USER_MENU);
}

export function receiptRegisteredKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منوی اصلی", CB.USER_MENU);
}
