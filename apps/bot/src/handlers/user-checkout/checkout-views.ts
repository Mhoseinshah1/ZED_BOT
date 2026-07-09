import type { CheckoutSession, ProductCategory, User } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { CheckoutDraft } from "../../core/session.js";
import { categoryShortId } from "../../services/category.service.js";
import { checkoutShortId } from "../../services/checkout.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { escapeHtml } from "../../utils/html.js";
import { ccb, CO_CB } from "./checkout-cb.js";

export const EMPTY_CATALOG_TEXT = "فعلاً محصولی برای این بخش فعال نیست.";

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

// --- Buy flow: location + category + product lists -----------------------------

export function locationMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("مولتی لوکیشن 🚀", ccb.buyLocation("M"))
    .row()
    .text("تک لوکیشن اختصاصی 🚀", ccb.buyLocation("D"))
    .row()
    .text("تست", ccb.buyLocation("T"))
    .row()
    .text("همه سرویس‌ها", ccb.buyLocation("A"))
    .row()
    .text("بازگشت", CB.USER_MENU);
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
  const lines = ["🧾 <b>پیش‌فاکتور</b>", "", `محصول: ${escapeHtml(product.name)}`];
  lines.push(`دسته‌بندی: ${escapeHtml(product.category.name)}`);

  if (product.type === "SERVICE_PRODUCT") {
    lines.push(
      `پنل: ${escapeHtml(product.panel?.name ?? "-")}`,
      `موقعیت: ${product.allLocations ? "همه موقعیت‌ها" : (LOCATION_LABEL[product.serviceLocation ?? ""] ?? "-")}`,
      `حجم: ${volumeLabel(product.volumeGb)}`,
      `مدت: ${durationLabel(product.durationDays)}`,
    );
  } else {
    if (product.durationDays !== null && product.durationDays > 0) {
      lines.push(`مدت/اعتبار: ${durationLabel(product.durationDays)}`);
    }
    lines.push(
      `نوع تحویل: ${product.deliveryType === null ? "-" : DELIVERY_LABEL[product.deliveryType]}`,
    );
  }

  if (product.invoiceDescription !== null && product.invoiceDescription !== "") {
    lines.push("", escapeHtml(product.invoiceDescription));
  }

  if (product.type === "OTHER_PRODUCT" && product.requiredUserInfoEnabled) {
    lines.push(
      "",
      "بعد از پرداخت، اطلاعات زیر از شما دریافت می‌شود:",
      escapeHtml(product.requiredUserInfoPromptText ?? "-"),
    );
  }

  lines.push("", `قیمت: ${formatToman(draft.originalPriceToman)}`);
  if (draft.discountCode !== undefined) {
    lines.push(
      `کد تخفیف: <code>${escapeHtml(draft.discountCode)}</code>`,
      `مبلغ تخفیف: ${formatToman(draft.discountAmountToman)}`,
    );
  }
  lines.push(
    `<b>مبلغ قابل پرداخت: ${formatToman(draft.finalPriceToman)}</b>`,
    "",
    `موجودی کیف پول شما: ${formatToman(user.balanceToman)}`,
  );
  return lines.join("\n");
}

export function preInvoiceKeyboard(draft: CheckoutDraft): InlineKeyboard {
  const kb = new InlineKeyboard().text("ادامه و انتخاب روش پرداخت ✅", CO_CB.CONTINUE).row();
  if (draft.discountCode === undefined) {
    kb.text("وارد کردن کد تخفیف 🎁", CO_CB.DISCOUNT).row();
  } else {
    kb.text("حذف کد تخفیف ❌", CO_CB.DISCOUNT_CLEAR).row();
  }
  const backCb =
    draft.flowType === "SERVICE_PRODUCT"
      ? ccb.buyCategory(draft.locationCode ?? "A", draft.categoryId.slice(0, 8))
      : ccb.otherCategory(draft.categoryId.slice(0, 8));
  kb.text("بازگشت به محصولات", backCb).text("منوی اصلی", CB.USER_MENU);
  return kb;
}

// --- Checkout created / view --------------------------------------------------------

export function checkoutCreatedText(): string {
  return "پیش‌فاکتور ثبت شد ✅\n\nمرحله انتخاب روش پرداخت در فاز بعدی فعال می‌شود.";
}

export function checkoutCreatedKeyboard(checkout: CheckoutSession): InlineKeyboard {
  return new InlineKeyboard()
    .text("مشاهده دوباره پیش‌فاکتور", ccb.viewCheckout(checkoutShortId(checkout)))
    .row()
    .text("بازگشت به منوی اصلی", CB.USER_MENU);
}

export function checkoutViewText(checkout: CheckoutSession): string {
  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  const lines = [
    "🧾 <b>پیش‌فاکتور ثبت‌شده</b>",
    "",
    `محصول: ${escapeHtml(String(snapshot.productName ?? "-"))}`,
    `دسته‌بندی: ${escapeHtml(String(snapshot.categoryName ?? "-"))}`,
    `قیمت: ${formatToman(checkout.originalPriceToman)}`,
  ];
  if (checkout.discountAmountToman > 0) {
    lines.push(`مبلغ تخفیف: ${formatToman(checkout.discountAmountToman)}`);
  }
  lines.push(
    `<b>مبلغ قابل پرداخت: ${formatToman(checkout.finalPriceToman)}</b>`,
    "",
    `وضعیت: ${checkout.status === "PENDING" ? "در انتظار پرداخت" : checkout.status}`,
    `اعتبار تا: ${checkout.expiresAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    "",
    "مرحله انتخاب روش پرداخت در فاز بعدی فعال می‌شود.",
  );
  return lines.join("\n");
}
