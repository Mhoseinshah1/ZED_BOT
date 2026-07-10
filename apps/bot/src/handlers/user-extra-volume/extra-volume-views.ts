import type { Service, User } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { ExtraVolumeDraft } from "../../core/session.js";
import type { EligibleServicePage } from "../../services/extra-volume.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { formatGb, remainingDays, statusLabel } from "../user-services/service-views.js";

// =============================================================================
// "خرید حجم اضافه ➕" rendering (Phase 16). Selection is read-only; the
// pre-invoice mirrors the purchase/renewal pre-invoices.
// =============================================================================

export const NO_ELIGIBLE_SERVICE_TEXT = "سرویسی برای خرید حجم اضافه وجود ندارد.";
export const NO_PACKAGE_TEXT = "بسته‌ای برای خرید حجم اضافه این سرویس موجود نیست.";

export const evcb = {
  list: (page: number): string => `user:ev:list:${page}`,
  service: (svcSid: string): string => `user:ev:svc:${svcSid}`,
  pkg: (svcSid: string, prodSid: string): string => `user:ev:pkg:${svcSid}:${prodSid}`,
  discount: "user:ev:discount",
  discountClear: "user:ev:discount:clear",
  continue: "user:ev:continue",
  wallet: "user:ev:wallet",
  walletConfirm: "user:ev:wallet:yes",
  back: "user:ev:back",
} as const;

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function listButtonLabel(service: Service): string {
  const name = service.productNameSnapshot ?? service.username;
  const days = remainingDays(service.expiresAt);
  const time = days === null ? "نامحدود" : `${days} روز`;
  return `${name} | ${time} | ${formatGb(service.remainingBytes)}GB`;
}

export function eligibleListKeyboard(pageData: EligibleServicePage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const service of pageData.services) {
    kb.text(listButtonLabel(service), evcb.service(serviceShortId(service))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", evcb.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, evcb.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", evcb.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/** Service summary shown above the package list. */
export function extraVolumeSummaryText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  return [
    "➕ <b>خرید حجم اضافه</b>",
    "",
    `سرویس: ${escapeHtml(service.productNameSnapshot ?? service.username)}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `وضعیت: ${statusLabel(service.status)}`,
    `پنل: ${escapeHtml(service.panelNameSnapshot ?? "-")}`,
    `انقضا: ${
      service.expiresAt === null
        ? "نامحدود"
        : `${service.expiresAt.toISOString().slice(0, 10)} (${days} روز مانده)`
    }`,
    `حجم: ${formatGb(service.remainingBytes)} از ${formatGb(service.volumeBytes)} گیگابایت باقی‌مانده`,
    "",
    "بسته حجم اضافه را انتخاب کنید:",
  ].join("\n");
}

export function packageListKeyboard(
  service: Service,
  packages: ProductWithRelations[],
): InlineKeyboard {
  const svcSid = serviceShortId(service);
  const kb = new InlineKeyboard();
  for (const pkg of packages) {
    kb.text(
      `${pkg.volumeGb} گیگ | ${formatToman(pkg.priceToman)}`,
      evcb.pkg(svcSid, productShortId(pkg)),
    ).row();
  }
  kb.text("بازگشت", evcb.list(1)).text("منوی اصلی", CB.USER_MENU);
  return kb;
}

/** Extra-volume pre-invoice (no DB writes until continue/wallet confirm). */
export function extraVolumePreInvoiceText(
  service: Service,
  product: ProductWithRelations,
  user: User,
  draft: ExtraVolumeDraft,
): string {
  const lines = [
    "🧾 <b>پیش‌فاکتور خرید حجم اضافه ➕</b>",
    "",
    "نوع: خرید حجم اضافه",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `بسته حجم: ${escapeHtml(product.name)}`,
    `حجم اضافه: ${product.volumeGb} گیگابایت`,
    `پنل: ${escapeHtml(product.panel?.name ?? "-")}`,
    `دسته‌بندی: ${escapeHtml(product.category.name)}`,
    "",
    `قیمت: ${formatToman(draft.originalPriceToman)}`,
  ];
  if (draft.discountCode !== undefined) {
    lines.push(
      `کد تخفیف: <code>${escapeHtml(draft.discountCode)}</code>`,
      `مبلغ تخفیف: ${formatToman(draft.discountAmountToman)}`,
    );
  }
  lines.push(
    `<b>مبلغ نهایی: ${formatToman(draft.finalPriceToman)}</b>`,
    "",
    `موجودی کیف پول شما: ${formatToman(user.balanceToman)}`,
  );
  if (draft.finalPriceToman > 0 && user.balanceToman < draft.finalPriceToman) {
    lines.push("موجودی کیف پول برای پرداخت کافی نیست.");
  }
  return lines.join("\n");
}

export function extraVolumePreInvoiceKeyboard(
  draft: ExtraVolumeDraft,
  user: User,
  walletPaymentEnabled = true,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("ادامه و انتخاب روش پرداخت ✅", evcb.continue).row();
  if (walletPaymentEnabled && draft.finalPriceToman > 0 && user.balanceToman >= draft.finalPriceToman) {
    kb.text("پرداخت با کیف پول 🏦", evcb.wallet).row();
  }
  if (draft.discountCode === undefined) {
    kb.text("وارد کردن کد تخفیف 🎁", evcb.discount).row();
  } else {
    kb.text("حذف کد تخفیف ❌", evcb.discountClear).row();
  }
  kb.text("بازگشت", evcb.service(draft.serviceId.slice(0, 8))).text("منوی اصلی", CB.USER_MENU);
  return kb;
}
