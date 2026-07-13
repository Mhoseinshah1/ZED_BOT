import type { Service, User } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { RenewalDraft } from "../../core/session.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import type { RenewableListPage } from "../../services/renewal-checkout.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import {
  formatGb,
  remainingDays,
  statusLabel,
} from "../user-services/service-views.js";

// =============================================================================
// "تمدید سرویس ♻️" rendering (Phase 12). Selection is read-only; the
// pre-invoice mirrors the purchase pre-invoice with a renewal header.
// =============================================================================

export const NO_RENEWABLE_TEXT = "سرویسی برای تمدید وجود ندارد.";
export const NO_RENEWAL_PLAN_TEXT = "پلنی برای تمدید این سرویس موجود نیست.";

export const rncb = {
  list: (page: number): string => `user:renew:list:${page}`,
  service: (svcSid: string): string => `user:renew:svc:${svcSid}`,
  plan: (svcSid: string, prodSid: string): string => `user:renew:plan:${svcSid}:${prodSid}`,
  discount: "user:renew:discount",
  discountClear: "user:renew:discount:clear",
  continue: "user:renew:continue",
  back: "user:renew:back",
  // Phase 15: pay the renewal pre-invoice from the wallet balance.
  wallet: "user:renew:wallet",
  walletConfirm: "user:renew:wallet:yes",
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

export function renewableListKeyboard(pageData: RenewableListPage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const service of pageData.services) {
    kb.text(listButtonLabel(service), rncb.service(serviceShortId(service))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", rncb.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, rncb.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", rncb.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/** Service summary shown above the renewal plan list. */
export function renewServiceSummaryText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  const unlimitedVolume = service.volumeBytes === 0n;
  return [
    `♻️ <b>تمدید سرویس</b>`,
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
      unlimitedVolume
        ? "نامحدود"
        : `${formatGb(service.remainingBytes)} از ${formatGb(service.volumeBytes)} گیگابایت باقی‌مانده`
    }`,
    "",
    "بسته تمدید را انتخاب کنید.",
  ].join("\n");
}

export function renewalPlansKeyboard(
  service: Service,
  plans: ProductWithRelations[],
): InlineKeyboard {
  const svcSid = serviceShortId(service);
  const kb = new InlineKeyboard();
  for (const plan of plans) {
    kb.text(`${plan.name} | ${formatToman(plan.priceToman)}`, rncb.plan(svcSid, productShortId(plan))).row();
  }
  kb.text("بازگشت", rncb.list(1)).text("منوی اصلی", CB.USER_MENU);
  return kb;
}

function volumeLabel(volumeGb: number | null): string {
  return volumeGb === null || volumeGb === 0 ? "نامحدود" : `${volumeGb} گیگ`;
}

function durationLabel(durationDays: number | null): string {
  return durationDays === null || durationDays === 0 ? "نامحدود" : `${durationDays} روز`;
}

/** Renewal pre-invoice (no DB writes until continue). */
export function renewalPreInvoiceText(
  service: Service,
  product: ProductWithRelations,
  user: User,
  draft: RenewalDraft,
): string {
  const lines = [
    "🧾 <b>پیش‌فاکتور تمدید</b>",
    "",
    "نوع: تمدید سرویس ♻️",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `پلن تمدید: ${escapeHtml(product.name)}`,
    `پنل: ${escapeHtml(product.panel?.name ?? "-")}`,
    `دسته‌بندی: ${escapeHtml(product.category.name)}`,
    `مدت: ${durationLabel(product.durationDays)}`,
    `حجم: ${volumeLabel(product.volumeGb)}`,
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
    `<b>مبلغ قابل پرداخت: ${formatToman(draft.finalPriceToman)}</b>`,
    "",
    `موجودی کیف پول شما: ${formatToman(user.balanceToman)}`,
  );
  if (draft.finalPriceToman > 0 && user.balanceToman < draft.finalPriceToman) {
    lines.push("موجودی کیف پول برای پرداخت کافی نیست.");
  }
  return lines.join("\n");
}

export function renewalPreInvoiceKeyboard(
  draft: RenewalDraft,
  user: User,
  walletPaymentEnabled = true,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("ادامه و انتخاب روش پرداخت ✅", rncb.continue).row();
  if (walletPaymentEnabled && draft.finalPriceToman > 0 && user.balanceToman >= draft.finalPriceToman) {
    kb.text("پرداخت با کیف پول 🏦", rncb.wallet).row();
  }
  if (draft.discountCode === undefined) {
    kb.text("وارد کردن کد تخفیف 🎁", rncb.discount).row();
  } else {
    kb.text("حذف کد تخفیف ❌", rncb.discountClear).row();
  }
  kb.text("بازگشت", rncb.service(draft.serviceId.slice(0, 8))).text("منوی اصلی", CB.USER_MENU);
  return kb;
}
