import type { Service, ServiceAutoRenewalMandate } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { mandateShortId } from "../../services/auto-renewal.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { remainingDays } from "../user-services/service-views.js";

// =============================================================================
// Wallet auto-renewal — user-facing rendering (Phase 1). The consent flow is
// deliberately explicit: choose the renewal plan → set a maximum wallet charge
// (ceiling) → review the exact terms → confirm. Nothing here moves money; the
// worker scan + bot execute engine act later, only for an ACTIVE mandate.
// =============================================================================

export const arnCb = {
  /** Per-service auto-renewal status / entry page. */
  svc: (sid: string): string => `user:arn:svc:${sid}`,
  /** Begin consent (choose a plan). */
  start: (sid: string): string => `user:arn:start:${sid}`,
  /** Chose a plan → ceiling step. */
  plan: (sid: string, prodSid: string): string => `user:arn:plan:${sid}:${prodSid}`,
  /** Use the current live price as the ceiling. */
  ceilCurrent: "user:arn:ceilcur",
  /** Final consent confirmation → create the mandate. */
  confirm: "user:arn:confirm",
  /** My auto-renewals list. */
  list: "user:arn:list",
  /** Mandate detail (short id). */
  detail: (mid: string): string => `user:arn:m:${mid}`,
  pause: (mid: string): string => `user:arn:pause:${mid}`,
  resume: (mid: string): string => `user:arn:resume:${mid}`,
  cancel: (mid: string): string => `user:arn:cancel:${mid}`,
  cancelYes: (mid: string): string => `user:arn:cancel:${mid}:yes`,
} as const;

export const AUTO_RENEWAL_BUTTON_TEXT = "تمدید خودکار 🔁";
export const AUTO_RENEWAL_LIST_BUTTON_TEXT = "تمدیدهای خودکار من 🔁";

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

const MANDATE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "فعال ✅",
  PAUSED: "متوقف ⏸",
  CANCELLED: "لغوشده ❌",
};

const PAUSE_REASON_LABEL: Record<string, string> = {
  USER_PAUSED: "متوقف‌شده توسط شما",
  ADMIN_PAUSED: "متوقف‌شده توسط پشتیبانی",
  INSUFFICIENT_BALANCE: "کمبود موجودی کیف پول",
  PRICE_ABOVE_LIMIT: "قیمت بیشتر از سقف مجاز",
  PRODUCT_UNAVAILABLE: "در دسترس نبودن طرح",
  PANEL_UNAVAILABLE: "در دسترس نبودن سرور",
  SERVICE_INELIGIBLE: "عدم واجد شرایط بودن سرویس",
  SERVICE_STATE_UNCERTAIN: "نامشخص بودن وضعیت سرویس",
  FINANCIAL_REVIEW: "بررسی مالی",
  FULFILLMENT_REVIEW: "بررسی تمدید",
  SYSTEM_DISABLED: "غیرفعال بودن سامانه",
};

export function mandateStatusLabel(status: string): string {
  return MANDATE_STATUS_LABEL[status] ?? status;
}

/** The per-service page shown when NO mandate exists yet (the pitch + start). */
export function autoRenewalIntroText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  return [
    "🔁 <b>تمدید خودکار</b>",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    service.expiresAt === null
      ? "انقضا: نامحدود"
      : `انقضا: ${service.expiresAt.toISOString().slice(0, 10)}${days === null ? "" : ` (${days} روز مانده)`}`,
    "",
    "با فعال‌سازی تمدید خودکار، این سرویس پیش از انقضا به‌صورت خودکار و از موجودی کیف پول شما تمدید می‌شود.",
    "",
    "• فقط تا سقفی که تعیین می‌کنید از کیف پول برداشت می‌شود.",
    "• همین سرویس تمدید می‌شود؛ سرویس جدیدی ساخته نمی‌شود.",
    "• هر زمان می‌توانید آن را متوقف یا لغو کنید.",
    "",
    "برای شروع، دکمهٔ زیر را بزنید.",
  ].join("\n");
}

export function autoRenewalIntroKeyboard(service: Service): InlineKeyboard {
  const sid = serviceShortId(service);
  return new InlineKeyboard()
    .text("فعال‌سازی تمدید خودکار 🔁", arnCb.start(sid))
    .row()
    .text("تمدیدهای خودکار من 🔁", arnCb.list)
    .row()
    .text("بازگشت", `user:svc:view:${sid}`);
}

/** Plan selection (same-panel renewal plans, identical to manual renewal). */
export function autoRenewalPlanText(service: Service): string {
  return [
    "🔁 <b>تمدید خودکار</b> — انتخاب طرح",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    "",
    "طرحی که هر بار برای تمدید خودکار استفاده شود را انتخاب کنید.",
  ].join("\n");
}

export function autoRenewalPlansKeyboard(
  service: Service,
  plans: ProductWithRelations[],
): InlineKeyboard {
  const sid = serviceShortId(service);
  const kb = new InlineKeyboard();
  for (const plan of plans) {
    kb.text(`${plan.name} | ${formatToman(plan.priceToman)}`, arnCb.plan(sid, productShortId(plan))).row();
  }
  kb.text("بازگشت", arnCb.svc(sid));
  return kb;
}

/** Ceiling step: prompt for a maximum wallet charge (with a quick default). */
export function autoRenewalCeilingText(
  service: Service,
  product: ProductWithRelations,
): string {
  return [
    "🔁 <b>تمدید خودکار</b> — سقف مبلغ",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `طرح: ${escapeHtml(product.name)}`,
    `قیمت فعلی: ${formatToman(product.priceToman)}`,
    "",
    "حداکثر مبلغی که مجاز به برداشت از کیف پول شماست را به تومان وارد کنید.",
    "اگر روزی قیمت از این سقف بیشتر شود، تمدید انجام نمی‌شود.",
    "",
    "یا از دکمهٔ زیر برای استفاده از «قیمت فعلی» به‌عنوان سقف استفاده کنید.",
  ].join("\n");
}

export function autoRenewalCeilingKeyboard(
  service: Service,
  product: ProductWithRelations,
): InlineKeyboard {
  const sid = serviceShortId(service);
  return new InlineKeyboard()
    .text(`سقف = قیمت فعلی (${formatToman(product.priceToman)})`, arnCb.ceilCurrent)
    .row()
    .text("بازگشت", arnCb.start(sid));
}

/** The explicit consent review shown before the mandate is created. */
export function autoRenewalConsentText(
  service: Service,
  product: ProductWithRelations,
  maximumChargeToman: number,
  chargeLeadMinutes: number,
): string {
  const leadHours = Math.round(chargeLeadMinutes / 60);
  const volume = product.volumeGb === null || product.volumeGb === 0 ? "نامحدود" : `${product.volumeGb} گیگ`;
  const duration =
    product.durationDays === null || product.durationDays === 0 ? "نامحدود" : `${product.durationDays} روز`;
  return [
    "🔁 <b>تایید فعال‌سازی تمدید خودکار</b>",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `پلن تمدید: ${escapeHtml(product.name)} (${duration} / ${volume})`,
    `قیمت فعلی: ${formatToman(product.priceToman)}`,
    `سقف مجاز برداشت: ${formatToman(maximumChargeToman)}`,
    `زمان تمدید: حدود ${leadHours} ساعت پیش از انقضا`,
    "",
    "<b>شرایط:</b>",
    "• هر بار حداکثر تا سقف تعیین‌شده از کیف پول برداشت می‌شود؛ اگر قیمت بیشتر شود، برداشتی انجام نمی‌شود.",
    "• اگر موجودی کیف پول کافی نباشد، تمدید انجام نمی‌شود و به شما اطلاع داده می‌شود.",
    "• همین سرویس فعلی تمدید می‌شود و سرویس جدیدی ساخته نمی‌شود.",
    "• می‌توانید هر زمان تمدید خودکار را متوقف یا لغو کنید.",
    "",
    "آیا با فعال‌سازی تمدید خودکار موافق هستید؟",
  ].join("\n");
}

export function autoRenewalConsentKeyboard(service: Service): InlineKeyboard {
  return new InlineKeyboard()
    .text("بله، فعال کن ✅", arnCb.confirm)
    .row()
    .text("انصراف", arnCb.svc(serviceShortId(service)));
}

/** Per-service status page for an EXISTING mandate (active/paused). */
export function mandateStatusText(
  mandate: ServiceAutoRenewalMandate,
  service: Service | null,
): string {
  const lines = [
    "🔁 <b>تمدید خودکار</b>",
    "",
    service !== null ? `سرویس: <code>${escapeHtml(service.username)}</code>` : "سرویس: -",
    `وضعیت: ${mandateStatusLabel(mandate.status)}`,
    `سقف مجاز برداشت: ${formatToman(mandate.maximumChargeToman)}`,
  ];
  if (mandate.status === "PAUSED" && mandate.pauseReason !== null) {
    lines.push(`علت توقف: ${PAUSE_REASON_LABEL[mandate.pauseReason] ?? mandate.pauseReason}`);
  }
  if (mandate.lastSuccessfulAt !== null) {
    lines.push(`آخرین تمدید موفق: ${mandate.lastSuccessfulAt.toISOString().slice(0, 10)}`);
  }
  return lines.join("\n");
}

export function mandateStatusKeyboard(mandate: ServiceAutoRenewalMandate): InlineKeyboard {
  const mid = mandateShortId(mandate);
  const sid = mandate.serviceId.slice(0, 8);
  const kb = new InlineKeyboard();
  if (mandate.status === "ACTIVE") {
    kb.text("توقف موقت ⏸", arnCb.pause(mid)).row();
  } else if (mandate.status === "PAUSED") {
    kb.text("فعال‌سازی مجدد ▶️", arnCb.resume(mid)).row();
  }
  if (mandate.status !== "CANCELLED") {
    kb.text("لغو تمدید خودکار ❌", arnCb.cancel(mid)).row();
  }
  kb.text("تمدیدهای خودکار من 🔁", arnCb.list).row();
  kb.text("بازگشت", `user:svc:view:${sid}`);
  return kb;
}

export function cancelConfirmKeyboard(mandate: ServiceAutoRenewalMandate): InlineKeyboard {
  const mid = mandateShortId(mandate);
  return new InlineKeyboard()
    .text("بله، لغو کن ❌", arnCb.cancelYes(mid))
    .row()
    .text("انصراف", arnCb.detail(mid));
}

export const NO_AUTO_RENEWALS_TEXT = "هنوز هیچ تمدید خودکاری ندارید.";

/** My auto-renewals list. */
export function autoRenewalListKeyboard(
  rows: { mandate: ServiceAutoRenewalMandate; username: string }[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(
      `${row.username} — ${mandateStatusLabel(row.mandate.status)}`,
      arnCb.detail(mandateShortId(row.mandate)),
    ).row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}
