import type { Service, TelegramStarsServiceSubscription } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { subscriptionShortId } from "../../services/stars-subscription.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { remainingDays } from "../user-services/service-views.js";

// =============================================================================
// Telegram Stars subscriptions — user-facing rendering (Phase 2). Enrollment is
// explicit: choose plan → review the FIXED Stars amount + 30-day terms → confirm
// → pay the recurring invoice. No internal identifiers are ever shown.
// =============================================================================

export const subCb = {
  svc: (sid: string): string => `user:sub:svc:${sid}`,
  start: (sid: string): string => `user:sub:start:${sid}`,
  plan: (sid: string, prodSid: string): string => `user:sub:plan:${sid}:${prodSid}`,
  confirm: (sid: string, prodSid: string, supersede: boolean): string =>
    `user:sub:confirm:${sid}:${prodSid}:${supersede ? "1" : "0"}`,
  list: "user:sub:list",
  detail: (subShort: string): string => `user:sub:m:${subShort}`,
  cancel: (subShort: string): string => `user:sub:cancel:${subShort}`,
  cancelYes: (subShort: string): string => `user:sub:cancel:${subShort}:yes`,
} as const;

export const STARS_SUBSCRIPTION_BUTTON_TEXT = "اشتراک ماهانه Stars ⭐";
export const STARS_LIST_BUTTON_TEXT = "اشتراک‌های Stars من ⭐";
export const STARS_LIST_EMPTY_TEXT = "هنوز هیچ اشتراک ماهانه‌ای ندارید.";

export const WALLET_CONFLICT_TEXT =
  "این سرویس هم‌اکنون تمدید خودکار از کیف پول دارد.\n\n" +
  "با فعال‌سازی اشتراک Stars، تمدید خودکار از کیف پول برای این سرویس غیرفعال می‌شود.\n\n" +
  "آیا ادامه می‌دهید؟";

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "در انتظار پرداخت اول ⏳",
  ACTIVE: "فعال ✅",
  CANCEL_AT_PERIOD_END: "لغو در پایان دوره ⏸",
  REACTIVATION_ALLOWED: "قابل فعال‌سازی مجدد ▶️",
  PAST_DUE: "پرداخت عقب‌افتاده ⚠️",
  EXPIRED: "منقضی‌شده ⌛",
  REQUIRES_ACTION: "نیازمند بررسی 🔎",
  CANCELLED: "لغوشده ❌",
};

export function starsStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function starsIntroText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  return [
    "⭐ <b>اشتراک ماهانه Telegram Stars</b>",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    service.expiresAt === null
      ? "انقضا: نامحدود"
      : `انقضا: ${service.expiresAt.toISOString().slice(0, 10)}${days === null ? "" : ` (${days} روز مانده)`}`,
    "",
    "با فعال‌سازی، این سرویس هر ۳۰ روز به‌صورت خودکار و از طریق Telegram Stars تمدید می‌شود.",
    "",
    "• مبلغ استاری این اشتراک ثابت است و تغییر قیمت‌های بعدی محصول، مبلغ اشتراک فعلی را تغییر نمی‌دهد.",
    "• همین سرویس تمدید می‌شود؛ سرویس جدیدی ساخته نمی‌شود.",
    "• هر زمان می‌توانید تمدید دوره‌های بعدی را لغو کنید؛ سرویس تا پایان دوره پرداخت‌شده فعال می‌ماند.",
  ].join("\n");
}

export function starsIntroKeyboard(service: Service): InlineKeyboard {
  const sid = serviceShortId(service);
  return new InlineKeyboard()
    .text("فعال‌سازی اشتراک", subCb.start(sid))
    .row()
    .text(STARS_LIST_BUTTON_TEXT, subCb.list)
    .row()
    .text("بازگشت", `user:svc:view:${sid}`);
}

export function starsPlansKeyboard(service: Service, plans: ProductWithRelations[]): InlineKeyboard {
  const sid = serviceShortId(service);
  const kb = new InlineKeyboard();
  for (const plan of plans) {
    kb.text(`${plan.name} | ${plan.telegramStarsSubscriptionPrice} ⭐`, subCb.plan(sid, productShortId(plan))).row();
  }
  kb.text("بازگشت", subCb.svc(sid));
  return kb;
}

export function starsConsentText(service: Service, product: ProductWithRelations): string {
  const volume = product.volumeGb === null || product.volumeGb === 0 ? "نامحدود" : `${product.volumeGb} گیگ`;
  return [
    "⭐ <b>فعال‌سازی اشتراک ماهانه Telegram Stars</b>",
    "",
    `سرویس: <code>${escapeHtml(service.username)}</code>`,
    `پلن: ${escapeHtml(product.name)} (۳۰ روز / ${volume})`,
    `هزینه هر دوره: ${product.telegramStarsSubscriptionPrice} استار`,
    "دوره پرداخت: هر ۳۰ روز",
    "",
    "پس از هر پرداخت موفق، همان سرویس با همین پلن تمدید می‌شود.",
    "قیمت استاری این اشتراک ثابت است و تغییر قیمت‌های بعدی محصول، مبلغ اشتراک فعلی را تغییر نمی‌دهد.",
    "می‌توانید تمدید دوره‌های بعدی را لغو کنید؛ سرویس تا پایان دوره پرداخت‌شده فعال باقی می‌ماند.",
  ].join("\n");
}

export function walletConflictKeyboard(sid: string, prodSid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("بله، ادامه بده و اشتراک بساز", subCb.confirm(sid, prodSid, true))
    .row()
    .text("انصراف", subCb.svc(sid));
}

export function starsStatusText(
  sub: TelegramStarsServiceSubscription,
  service: Service | null,
): string {
  const lines = [
    "⭐ <b>اشتراک ماهانه Telegram Stars</b>",
    "",
    `وضعیت: ${starsStatusLabel(sub.status)}`,
    service !== null ? `سرویس: <code>${escapeHtml(service.username)}</code>` : "سرویس: -",
    `مبلغ هر دوره: ${sub.starsAmount} استار`,
  ];
  if (sub.currentPeriodEndsAt !== null) {
    lines.push(`پایان دوره فعلی: ${sub.currentPeriodEndsAt.toISOString().slice(0, 10)}`);
  }
  lines.push(`تمدید دوره‌های بعدی: ${sub.telegramExtensionCanceled ? "لغوشده" : "فعال"}`);
  if (sub.lastChargeAt !== null) {
    lines.push(`آخرین پرداخت: ${sub.lastChargeAt.toISOString().slice(0, 10)}`);
  }
  return lines.join("\n");
}

export function starsStatusKeyboard(sub: TelegramStarsServiceSubscription): InlineKeyboard {
  const short = subscriptionShortId(sub);
  const svc = sub.serviceId.slice(0, 8);
  const kb = new InlineKeyboard();
  if ((sub.status === "ACTIVE" || sub.status === "PAST_DUE" || sub.status === "REQUIRES_ACTION") && !sub.telegramExtensionCanceled) {
    kb.text("لغو تمدید دوره‌های بعدی", subCb.cancel(short)).row();
  }
  kb.text(STARS_LIST_BUTTON_TEXT, subCb.list).row();
  kb.text("مشاهده سرویس", `user:svc:view:${svc}`).row();
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

export function starsSubscriptionsListKeyboard(
  rows: { sub: TelegramStarsServiceSubscription; username: string }[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(`${row.username} — ${starsStatusLabel(row.sub.status)}`, subCb.detail(subscriptionShortId(row.sub))).row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}
