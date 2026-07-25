import type { CheckoutSession, Panel, ProductCategory, User } from "@zedbot/database";
import {
  SERVICE_NOTE_MAX_CODE_POINTS,
  SERVICE_USERNAME_MAX_LENGTH,
  SERVICE_USERNAME_MIN_LENGTH,
  type ServiceNoteRejectReason,
  type ServiceUsernameAvailabilityOutcome,
  type ServiceUsernameRejectReason,
} from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { CheckoutDraft } from "../../core/session.js";
import { categoryShortId } from "../../services/category.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { PRICE_CB } from "../user-pricing/pricing-cb.js";
import { ccb, coNonce, CO_CB } from "./checkout-cb.js";

export const EMPTY_CATALOG_TEXT = "فعلاً محصولی برای این بخش فعال نیست.";

// Phase 11.1 panel-first purchase texts.
export const NO_PANEL_TEXT = "در حال حاضر پنلی برای خرید فعال نیست.";
export const PICK_PANEL_TEXT = "انتخاب پنل / لوکیشن";
export const PICK_CATEGORY_TEXT = "انتخاب دسته‌بندی";
export const PICK_PRODUCT_TEXT = "انتخاب پلن";
export const NO_CATEGORY_TEXT = "برای این پنل دسته‌بندی فعالی وجود ندارد.";
export const NO_PRODUCT_TEXT = "پلنی برای این دسته‌بندی موجود نیست.";
export const LEGACY_STEP_TEXT = "این مرحله حذف شده است. لطفاً دوباره خرید اشتراک را انتخاب کنید.";

const LOCATION_LABEL: Record<string, string> = {
  MULTI_LOCATION: "مولتی لوکیشن 🚀",
  DEDICATED_LOCATION: "تک لوکیشن اختصاصی 🚀",
  TEST: "تست",
};

const DELIVERY_LABEL: Record<string, string> = {
  MANUAL_ADMIN: "تحویل دستی ادمین",
  STOCK_ITEM: "آیتم آماده/استوک",
};

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function volumeLabel(volumeGb: number | null): string {
  if (volumeGb === null) {
    return "-";
  }
  return volumeGb === 0 ? "نامحدود" : `${volumeGb} گیگ`;
}

function durationLabel(durationDays: number | null): string {
  if (durationDays === null) {
    return "-";
  }
  return durationDays === 0 ? "نامحدود" : `${durationDays} روز`;
}

// --- Buy flow: panel + category + product lists -----------------------------
// There is deliberately NO hardcoded "service type" step (Phase 11.1): real
// ACTIVE + visible panels are the first (and skippable) choice.

export function panelListKeyboard(panels: Panel[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const panel of panels) {
    kb.text(panel.name, ccb.buyPanel(panel.id.slice(0, 8))).row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

export function categoryListKeyboard(
  categories: ProductCategory[],
  buildCb: (catSid: string) => string,
  backCb: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const category of categories) {
    kb.text(category.name, buildCb(categoryShortId(category))).row();
  }
  kb.text("بازگشت", backCb);
  return kb;
}

export function productListKeyboard(
  products: ProductWithRelations[],
  buildCb: (prodSid: string) => string,
  backCb: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const product of products) {
    kb.text(`${product.name} | ${formatToman(product.priceToman)}`, buildCb(productShortId(product))).row();
  }
  kb.text("بازگشت", backCb);
  return kb;
}

// --- Pre-invoice -----------------------------------------------------------------

export function preInvoiceText(
  product: ProductWithRelations,
  user: User,
  draft: CheckoutDraft,
): string {
  const lines = ["🧾 <b>پیش‌فاکتور شما:</b>", "", `🌿 نام سرویس: ${escapeHtml(product.name)}`];

  if (product.type === "SERVICE_PRODUCT") {
    lines.push(
      `🌐 لوکیشن: ${product.allLocations ? "همه موقعیت‌ها" : (LOCATION_LABEL[product.serviceLocation ?? ""] ?? "-")}`,
      `⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`,
      `🧯 حجم سرویس: ${volumeLabel(product.volumeGb)}`,
    );
    // Service-checkout username selection (feat/service-checkout-username-note):
    // the buyer-chosen remote username and optional note, both HTML-escaped.
    const custom = draft.serviceCustomization;
    if (custom !== undefined && custom.completed) {
      lines.push(`👤 یوزرنیم: <code>${escapeHtml(custom.normalizedUsername)}</code>`);
      lines.push(
        custom.note !== null && custom.note !== ""
          ? `📝 یادداشت: ${escapeHtml(custom.note)}`
          : "📝 یادداشت: ندارد",
      );
    }
  } else {
    if (product.durationDays !== null && product.durationDays > 0) {
      lines.push(`⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`);
    }
    lines.push(
      `نوع تحویل: ${product.deliveryType === null ? "-" : DELIVERY_LABEL[product.deliveryType]}`,
    );
  }

  if (product.invoiceDescription !== null && product.invoiceDescription !== "") {
    lines.push(`📝 توضیح: ${escapeHtml(product.invoiceDescription)}`);
  }

  if (product.type === "OTHER_PRODUCT" && product.requiredUserInfoEnabled) {
    lines.push(
      "",
      "بعد از پرداخت، اطلاعات زیر از شما دریافت می‌شود:",
      escapeHtml(product.requiredUserInfoPromptText ?? "-"),
    );
  }

  lines.push("");
  if (draft.representative !== undefined) {
    // Reseller pricing (§16): retail, the representative price and the saving.
    const saved = Math.max(0, draft.representative.retailPriceToman - draft.finalPriceToman);
    lines.push(
      `🏷 قیمت عادی: <s>${formatToman(draft.representative.retailPriceToman)}</s>`,
      `🤝 قیمت نمایندگی: <b>${formatToman(draft.finalPriceToman)}</b>`,
      `💰 صرفه‌جویی شما: ${formatToman(saved)}`,
    );
  } else if (draft.discountCode !== undefined) {
    lines.push(
      `💵 قیمت اصلی: ${formatToman(draft.originalPriceToman)}`,
      `🎟 تخفیف: ${formatToman(draft.discountAmountToman)}`,
      `کد تخفیف: <code>${escapeHtml(draft.discountCode)}</code>`,
      `✅ <b>مبلغ نهایی: ${formatToman(draft.finalPriceToman)}</b>`,
    );
  } else {
    lines.push(`💵 قیمت: ${formatToman(draft.originalPriceToman)}`);
  }
  lines.push("", `🏦 موجودی کیف پول: ${formatToman(user.balanceToman)}`);
  if (
    product.type === "SERVICE_PRODUCT" &&
    draft.finalPriceToman > 0 &&
    user.balanceToman < draft.finalPriceToman
  ) {
    lines.push("موجودی کیف پول برای پرداخت کافی نیست.");
  }
  return lines.join("\n");
}

// --- Service username + optional note steps ---------------------------------
// (feat/service-checkout-username-note). Shown BEFORE the pre-invoice for every
// paid SERVICE checkout that provisions a normal VPN account. All buyer-facing
// dynamic values are HTML-escaped; every callback binds to a CO_CB constant.

// --- registry keys + fallback copy -------------------------------------------
// Operator-editable via the admin text panel (seed-if-missing). The buyer-facing
// display text comes from the registry with these constants as the fallback;
// routing always binds to CO_CB.* constants, never to any label.
export const SVC_TEXT_KEYS = {
  method: "svc_username_method",
  customPrompt: "svc_username_custom_prompt",
  notePrompt: "svc_note_prompt",
} as const;
export const SVC_BUTTON_KEYS = {
  custom: "svc_username_custom",
  random: "svc_username_random",
  regen: "svc_username_regen",
  method: "svc_username_method_back",
  confirm: "svc_username_confirm",
  noteSkip: "svc_note_skip",
} as const;

export const SERVICE_USERNAME_METHOD_TEXT = [
  "👤 <b>انتخاب یوزرنیم سرویس</b>",
  "",
  "یوزرنیم، نام کاربری واقعی حساب شما روی پنل است و پس از ساخت سرویس ثابت می‌ماند.",
  "",
  `• بین ${SERVICE_USERNAME_MIN_LENGTH} تا ${SERVICE_USERNAME_MAX_LENGTH} کاراکتر`,
  "• فقط حروف کوچک انگلیسی، عدد و زیرخط (_)",
  "• شروع با یک حرف کوچک انگلیسی",
  "",
  "می‌توانید خودتان یوزرنیم را انتخاب کنید یا یک یوزرنیم تصادفی امن دریافت کنید.",
].join("\n");

export const SERVICE_USERNAME_CUSTOM_PROMPT_TEXT = [
  "یوزرنیم دلخواه خود را ارسال کنید:",
  "",
  `• بین ${SERVICE_USERNAME_MIN_LENGTH} تا ${SERVICE_USERNAME_MAX_LENGTH} کاراکتر`,
  "• فقط حروف کوچک انگلیسی، عدد و زیرخط (_)، شروع با حرف",
].join("\n");

export const SERVICE_NOTE_PROMPT_TEXT = [
  "📝 <b>یادداشت سرویس (اختیاری)</b>",
  "",
  "می‌توانید یک یادداشت کوتاه برای این سرویس ثبت کنید (مثلاً نام دستگاه یا کاربر).",
  `حداکثر ${SERVICE_NOTE_MAX_CODE_POINTS} کاراکتر. برای رد شدن، دکمه زیر را بزنید.`,
].join("\n");

// Button-label fallbacks (mirror the seeded ButtonText defaults).
const SVC_LABEL = {
  custom: "✍️ انتخاب یوزرنیم دلخواه",
  random: "🎲 یوزرنیم تصادفی",
  regen: "🎲 تولید مجدد",
  method: "↩️ انتخاب روش دیگر",
  confirm: "✅ تأیید و ادامه",
  noteSkip: "رد کردن (بدون یادداشت)",
  cancel: "انصراف",
  backMenu: "بازگشت به منو",
  changeUsername: "↩️ تغییر یوزرنیم",
  noteBack: "↩️ بازگشت",
} as const;

export async function serviceUsernameMethodText(): Promise<string> {
  return getMessageTemplate(SVC_TEXT_KEYS.method, SERVICE_USERNAME_METHOD_TEXT);
}
export async function serviceUsernameCustomPromptText(): Promise<string> {
  return getMessageTemplate(SVC_TEXT_KEYS.customPrompt, SERVICE_USERNAME_CUSTOM_PROMPT_TEXT);
}
export async function serviceNotePromptText(): Promise<string> {
  return getMessageTemplate(SVC_TEXT_KEYS.notePrompt, SERVICE_NOTE_PROMPT_TEXT);
}

export async function serviceUsernameMethodKeyboard(nonce: string): Promise<InlineKeyboard> {
  return new InlineKeyboard()
    .text(await getButtonText(SVC_BUTTON_KEYS.custom, SVC_LABEL.custom), coNonce.unCustom(nonce))
    .row()
    .text(await getButtonText(SVC_BUTTON_KEYS.random, SVC_LABEL.random), coNonce.unRandom(nonce))
    .row()
    .text(SVC_LABEL.backMenu, CB.USER_MENU);
}

export function serviceUsernameConfirmText(username: string, isRandom: boolean): string {
  return [
    "👤 <b>یوزرنیم انتخابی شما</b>",
    "",
    `<code>${escapeHtml(username)}</code>`,
    "",
    isRandom
      ? "این یوزرنیم به‌صورت تصادفی و امن ساخته شده است."
      : "این یوزرنیم روی پنل برای حساب شما ثبت خواهد شد.",
    "",
    "برای ادامه تأیید کنید یا یوزرنیم را تغییر دهید.",
  ].join("\n");
}

export async function serviceUsernameConfirmKeyboard(
  isRandom: boolean,
  nonce: string,
): Promise<InlineKeyboard> {
  const kb = new InlineKeyboard()
    .text(await getButtonText(SVC_BUTTON_KEYS.confirm, SVC_LABEL.confirm), coNonce.unConfirm(nonce))
    .row();
  if (isRandom) {
    kb.text(await getButtonText(SVC_BUTTON_KEYS.regen, SVC_LABEL.regen), coNonce.unRegen(nonce)).row();
  }
  // confirmation Back → username method (§10).
  kb.text(await getButtonText(SVC_BUTTON_KEYS.method, SVC_LABEL.method), coNonce.unMethod(nonce))
    .row()
    .text(SVC_LABEL.backMenu, CB.USER_MENU);
  return kb;
}

export function serviceUsernameCustomPromptKeyboard(nonce: string): InlineKeyboard {
  return new InlineKeyboard().text(SVC_LABEL.cancel, coNonce.unMethod(nonce));
}

export async function serviceNotePromptKeyboard(nonce: string): Promise<InlineKeyboard> {
  // note Skip stores null (explicit); note Back → username confirmation (§10).
  return new InlineKeyboard()
    .text(await getButtonText(SVC_BUTTON_KEYS.noteSkip, SVC_LABEL.noteSkip), coNonce.noteSkip(nonce))
    .row()
    .text(SVC_LABEL.noteBack, coNonce.noteBack(nonce));
}

/** Safe, buyer-facing message for a rejected username (never echoes raw input). */
export function serviceUsernameRejectText(reason: ServiceUsernameRejectReason): string {
  switch (reason) {
    case "EMPTY":
      return "یوزرنیم نمی‌تواند خالی باشد. دوباره ارسال کنید.";
    case "TOO_SHORT":
      return `یوزرنیم باید حداقل ${SERVICE_USERNAME_MIN_LENGTH} کاراکتر باشد. دوباره ارسال کنید.`;
    case "TOO_LONG":
      return `یوزرنیم باید حداکثر ${SERVICE_USERNAME_MAX_LENGTH} کاراکتر باشد. دوباره ارسال کنید.`;
    case "BAD_FIRST_CHAR":
      return "یوزرنیم باید با یک حرف کوچک انگلیسی شروع شود. دوباره ارسال کنید.";
    case "BAD_CHARS":
      return "فقط حروف کوچک انگلیسی، عدد و زیرخط (_) مجاز است. دوباره ارسال کنید.";
  }
}

/** Safe, buyer-facing message for an unavailable username (never raw panel errors). */
export function serviceUsernameUnavailableText(
  outcome: Exclude<ServiceUsernameAvailabilityOutcome, "AVAILABLE">,
): string {
  switch (outcome) {
    case "TAKEN_LOCAL":
    case "TAKEN_REMOTE":
    case "RESERVED":
      return "این یوزرنیم قبلاً گرفته شده است. لطفاً یوزرنیم دیگری انتخاب کنید.";
    case "INVALID":
      return "یوزرنیم نامعتبر است. لطفاً دوباره تلاش کنید.";
    case "PANEL_UNAVAILABLE":
      return "امکان بررسی یوزرنیم روی این پنل در حال حاضر وجود ندارد. لطفاً بعداً تلاش کنید یا یوزرنیم تصادفی بگیرید.";
    case "UNVERIFIABLE":
      return "بررسی این یوزرنیم ممکن نشد. لطفاً دوباره تلاش کنید یا یوزرنیم تصادفی بگیرید.";
  }
}

/** Safe, buyer-facing message for a rejected note (never echoes raw input). */
export function serviceNoteRejectText(reason: ServiceNoteRejectReason): string {
  switch (reason) {
    case "TOO_LONG":
      return `یادداشت باید حداکثر ${SERVICE_NOTE_MAX_CODE_POINTS} کاراکتر باشد. دوباره ارسال کنید یا رد کنید.`;
    case "CONTROL_OR_BIDI":
      return "یادداشت شامل کاراکترهای غیرمجاز است. لطفاً متن دیگری ارسال کنید یا رد کنید.";
  }
}

/** True when the wallet-pay button may be offered for this draft (Phase 15). */
export function walletPayAvailable(user: User, finalPriceToman: number): boolean {
  return finalPriceToman > 0 && user.balanceToman >= finalPriceToman;
}

/** Wallet payment confirmation screen text (shared with the renewal flow). */
export function walletConfirmText(amountToman: number, balanceToman: number): string {
  return [
    "آیا از پرداخت با کیف پول مطمئن هستید؟",
    "",
    `مبلغ پرداخت: ${formatToman(amountToman)}`,
    `موجودی فعلی: ${formatToman(balanceToman)}`,
    `موجودی بعد از پرداخت: ${formatToman(balanceToman - amountToman)}`,
  ].join("\n");
}

export function preInvoiceKeyboard(
  draft: CheckoutDraft,
  user: User,
  walletPaymentEnabled = true,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("پرداخت / تایید خرید ✅", CO_CB.CONTINUE).row();
  // Other-product-wallet phase: the wallet button is offered for BOTH product
  // types (SERVICE_PRODUCT and OTHER_PRODUCT) - availability depends only on
  // the operator kill-switch and a sufficient balance.
  if (walletPaymentEnabled && walletPayAvailable(user, draft.finalPriceToman)) {
    kb.text("پرداخت با کیف پول 🏦", CO_CB.WALLET).row();
  }
  // Representative Program (§16): the reseller price is already applied; the
  // user-facing rep pre-invoice does NOT offer a discount-code entry (retail
  // checkouts are unchanged), and «بازگشت» returns to the rep product list.
  if (draft.representative === undefined) {
    if (draft.discountCode === undefined) {
      kb.text("ثبت کد تخفیف 🎟", CO_CB.DISCOUNT).row();
    } else {
      kb.text("حذف کد تخفیف ❌", CO_CB.DISCOUNT_CLEAR).row();
    }
  }
  // «بازگشت» destination. A Pricing-origin draft returns to the EXACT pricing
  // product-list page it was opened from (feat/public-pricing-catalog §12);
  // representative and normal-retail drafts behave exactly as before.
  const origin = draft.origin;
  let backCb: string;
  if (origin?.kind === "PRICING_SERVICE") {
    backCb = PRICE_CB.serviceCategory(
      origin.panelId.slice(0, 8),
      origin.categoryId.slice(0, 8),
      origin.page,
    );
  } else if (origin?.kind === "PRICING_OTHER") {
    backCb = PRICE_CB.otherCategory(origin.categoryId.slice(0, 8), origin.page);
  } else if (draft.representative !== undefined) {
    backCb = "user:rep:buy";
  } else if (draft.flowType === "SERVICE_PRODUCT") {
    backCb =
      draft.panelId !== undefined
        ? ccb.buyCategory(draft.panelId.slice(0, 8), draft.categoryId.slice(0, 8))
        : CO_CB.BUY;
  } else {
    backCb = ccb.otherCategory(draft.categoryId.slice(0, 8));
  }
  kb.text("بازگشت", backCb).text("منوی اصلی", CB.USER_MENU);
  return kb;
}

// --- Checkout view -------------------------------------------------------------------
// (The "created" screen now lives in payment-views: method selection follows
// checkout creation directly since Phase 7.)

/** Persian labels for EVERY CheckoutStatus member (the raw enum never renders). */
const CHECKOUT_STATUS_LABEL: Record<CheckoutSession["status"], string> = {
  PENDING: "در انتظار پرداخت",
  PAID: "پرداخت‌شده",
  CANCELLED: "لغوشده",
  EXPIRED: "منقضی‌شده",
  FAILED_REFUNDED: "پرداخت ناموفق (مبلغ برگشت داده شد)",
  COMPLETED: "تکمیل‌شده",
};

export function checkoutViewText(checkout: CheckoutSession): string {
  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  const isWalletTopup = checkout.purpose === "WALLET_CHARGE";
  const lines = [
    "🧾 <b>پیش‌فاکتور شما:</b>",
    "",
    ...(isWalletTopup
      ? [`نوع: ${escapeHtml(String(snapshot.title ?? "شارژ کیف پول"))} 🏦`]
      : [
          `محصول: ${escapeHtml(String(snapshot.productName ?? "-"))}`,
          `دسته‌بندی: ${escapeHtml(String(snapshot.categoryName ?? "-"))}`,
        ]),
    `قیمت: ${formatToman(checkout.originalPriceToman)}`,
  ];
  if (checkout.discountAmountToman > 0) {
    lines.push(`مبلغ تخفیف: ${formatToman(checkout.discountAmountToman)}`);
  }
  lines.push(
    `<b>مبلغ قابل پرداخت: ${formatToman(checkout.finalPriceToman)}</b>`,
    "",
    `وضعیت: ${CHECKOUT_STATUS_LABEL[checkout.status]}`,
    `⏱ اعتبار پیش‌فاکتور: ${checkout.expiresAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    `🔎 کد پیگیری: <code>${checkout.id.slice(0, 8)}</code>`,
  );
  return lines.join("\n");
}
