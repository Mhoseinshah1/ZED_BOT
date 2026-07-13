import type { Service, User } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { ExtraTimeDraft } from "../../core/session.js";
import type { EligibleTimeServicePage } from "../../services/extra-time.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { formatGb, remainingDays, statusLabel } from "../user-services/service-views.js";

// =============================================================================
// "خرید زمان اضافه ⏳" rendering (Phase 17). Selection is read-only; the
// pre-invoice mirrors the purchase/renewal/extra-volume pre-invoices.
// =============================================================================

export const NO_ELIGIBLE_TIME_SERVICE_TEXT = "سرویسی برای خرید زمان اضافه وجود ندارد.";
export const NO_TIME_PACKAGE_TEXT = "بسته‌ای برای خرید زمان اضافه این سرویس موجود نیست.";

export const etcb = {
  list: (page: number): string => `user:et:list:${page}`,
  service: (svcSid: string): string => `user:et:svc:${svcSid}`,
  pkg: (svcSid: string, prodSid: string): string => `user:et:pkg:${svcSid}:${prodSid}`,
  discount: "user:et:discount",
  discountClear: "user:et:discount:clear",
  continue: "user:et:continue",
  wallet: "user:et:wallet",
  walletConfirm: "user:et:wallet:yes",
  back: "user:et:back",
} as const;

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function listButtonLabel(service: Service): string {
  const name = service.productNameSnapshot ?? service.username;
  const days = remainingDays(service.expiresAt);
  const time = days === null ? "نامحدود" : `${days} روز`;
  const volume = service.volumeBytes === 0n ? "نامحدود" : `${formatGb(service.remainingBytes)}GB`;
  return `${name} | ${time} | ${volume}`;
}

export function eligibleTimeListKeyboard(pageData: EligibleTimeServicePage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const service of pageData.services) {
    kb.text(listButtonLabel(service), etcb.service(serviceShortId(service))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", etcb.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, etcb.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", etcb.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/** Service summary shown above the package list. */
export function extraTimeSummaryText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  return [
    "⏳ <b>خرید زمان اضافه</b>",
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
    `حجم: ${
      service.volumeBytes === 0n
        ? "نامحدود"
        : `${formatGb(service.remainingBytes)} از ${formatGb(service.volumeBytes)} گیگابایت باقی‌مانده`
    }`,
    "",
    "تعداد روز اضافه را انتخاب کنید.",
  ].join("\n");
}

export function timePackageListKeyboard(
  service: Service,
  packages: ProductWithRelations[],
): InlineKeyboard {
  const svcSid = serviceShortId(service);
  const kb = new InlineKeyboard();
  for (const pkg of packages) {
    kb.text(
      `${pkg.durationDays} روز | ${formatToman(pkg.priceToman)}`,
      etcb.pkg(svcSid, productShortId(pkg)),
    ).row();
  }
  kb.text("بازگشت", etcb.list(1)).text("منوی اصلی", CB.USER_MENU);
  return kb;
}

/** Extra-time pre-invoice (no DB writes until continue/wallet confirm). */
export function extraTimePreInvoiceText(
  service: Service,
  product: ProductWithRelations,
  user: User,
  draft: ExtraTimeDraft,
): string {
  const lines = [
    "🧾 <b>پیش‌فاکتور خرید زمان اضافه ⏳</b>",
    "",
    "نوع: خرید زمان اضافه",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `بسته زمان: ${escapeHtml(product.name)}`,
    `مدت اضافه: ${product.durationDays} روز`,
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

export function extraTimePreInvoiceKeyboard(
  draft: ExtraTimeDraft,
  user: User,
  walletPaymentEnabled = true,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("ادامه و انتخاب روش پرداخت ✅", etcb.continue).row();
  if (walletPaymentEnabled && draft.finalPriceToman > 0 && user.balanceToman >= draft.finalPriceToman) {
    kb.text("پرداخت با کیف پول 🏦", etcb.wallet).row();
  }
  if (draft.discountCode === undefined) {
    kb.text("وارد کردن کد تخفیف 🎁", etcb.discount).row();
  } else {
    kb.text("حذف کد تخفیف ❌", etcb.discountClear).row();
  }
  kb.text("بازگشت", etcb.service(draft.serviceId.slice(0, 8))).text("منوی اصلی", CB.USER_MENU);
  return kb;
}
