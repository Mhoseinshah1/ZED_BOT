import { prisma } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { renderTemplate } from "../utils/template.js";

// Hardcoded Persian fallbacks for the seeded keys - used when the database is
// unavailable or a key is missing. The bot must never crash over a text.
const TEMPLATE_FALLBACKS: Record<string, string> = {
  start_text: "به ربات خوش آمدید.",
  bot_off_text: "ربات در حال حاضر در دسترس نیست. لطفا بعدا مراجعه کنید.",
  support_text: "برای ارتباط با پشتیبانی پیام خود را ارسال کنید.",
  faq_text: "سوالات متداول به زودی تکمیل می‌شود.",
  // Empty states (accepted UI texts, restored after the Phase 39 revert).
  no_services_text: "شما هنوز سرویسی ندارید.",
  no_orders_text: "شما هنوز سفارشی ندارید.",
  no_tickets_text: "هنوز تیکتی ثبت نکرده‌اید.",
  // Corrective Fix D: support + history texts ({min}/{max} render in code).
  support_landing_text:
    "از این بخش می‌توانید با پشتیبانی در ارتباط باشید و پاسخ تیکت‌های قبلی را پیگیری کنید.",
  support_subject_prompt: "موضوع تیکت را وارد کنید. ({min} تا {max} کاراکتر)",
  support_message_prompt: "متن پیام را بنویسید. (حداکثر {max} کاراکتر)",
  support_reply_prompt: "پاسخ شما را بنویسید. (حداکثر {max} کاراکتر)",
  support_empty_tickets_text: "هنوز تیکتی ثبت نکرده‌اید.",
  support_ticket_created_text: "تیکت شما ثبت شد ✅",
  history_landing_text:
    "سوابق سفارش‌ها، پرداخت‌ها و تراکنش‌های کیف پول شما در این بخش قابل مشاهده است.",
  no_payments_text: "هنوز پرداختی ثبت نشده است.",
  no_other_product_orders_text: "شما هنوز سفارشی ندارید.",
  // Corrective Fix A: wallet headings/prompts/notes (dynamic amounts stay in code).
  wallet_header_text: "کیف پول و حساب کاربری 🏦",
  wallet_topup_amount_prompt: "مبلغ شارژ کیف پول را به تومان وارد کنید.",
  wallet_topup_preview_note: "پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد.",
  wallet_empty_transactions_text: "تراکنشی ثبت نشده است.",
};

const BUTTON_FALLBACKS: Record<string, string> = {
  buy_subscription: "خرید اشتراک 🔐",
  renew_service: "تمدید سرویس ♻️",
  extra_volume: "خرید حجم اضافه ➕",
  extra_time: "خرید زمان اضافه ⏳",
  my_services: "سرویس‌های من 🛍",
  wallet: "کیف پول + شارژ 🏦",
  support: "پشتیبانی ☎️",
  tutorials: "آموزش 📚",
  free_test: "اشتراک رایگان {تست}",
  referral: "زیرمجموعه گیری 👥",
  other_products: "محصولات دیگر 🛍",
  my_orders: "سفارش‌های من 🧾",
  pricing: "تعرفه اشتراک‌ها 💵",
  representative_request: "درخواست نمایندگی 👨‍💼",
  lucky_wheel: "گردونه شانس 🎲",
  back: "بازگشت",
  main_menu: "منوی اصلی",
  cancel: "لغو ❌",
  confirm: "تایید ✅",
  next: "بعدی »",
  previous: "« قبلی",
  // Corrective Fix D: support + history buttons.
  new_ticket: "ایجاد تیکت جدید ➕",
  my_tickets: "تیکت‌های من 📋",
  reply_ticket: "پاسخ به تیکت ✍️",
  refresh: "بروزرسانی ♻️",
  all_orders: "همه سفارش‌ها 📋",
  subscription_orders: "خرید اشتراک‌ها 🔐",
  other_product_orders: "محصولات دیگر 🛍",
  payments: "پرداخت‌ها 💳",
  wallet_transactions: "تراکنش‌های کیف پول 🏦",
  back_to_support: "بازگشت به پشتیبانی",
  back_to_history: "بازگشت به سوابق",
};

const CACHE_TTL_MS = 30_000;
const templateCache = new Map<string, { value: string | null; at: number }>();
const buttonCache = new Map<string, { value: string | null; at: number }>();

/** Test hook / admin-edit hook: drops the text caches. */
export function clearTextCache(): void {
  templateCache.clear();
  buttonCache.clear();
}

/**
 * Loads a MessageTemplate's currentContent and renders `{variable}`
 * placeholders. Falls back to the given fallback, then to the built-in
 * Persian defaults. Never throws.
 */
export async function getMessageTemplate(
  key: string,
  fallback?: string,
  variables?: Record<string, string | number>,
): Promise<string> {
  const safeFallback = fallback ?? TEMPLATE_FALLBACKS[key] ?? key;
  let content = safeFallback;
  const cached = templateCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    content = cached.value ?? safeFallback;
  } else {
    try {
      const row = await prisma.messageTemplate.findUnique({ where: { key } });
      templateCache.set(key, { value: row?.currentContent ?? null, at: Date.now() });
      content = row?.currentContent ?? safeFallback;
    } catch (err) {
      logger.warn("message template lookup failed, using fallback", {
        key,
        error: errorMessage(err),
      });
    }
  }
  return renderTemplate(content, variables ?? {});
}

/**
 * Loads a ButtonText's currentText. Button texts are used verbatim (no
 * variable rendering - literal braces like "{تست}" stay intact). Never
 * throws.
 */
export async function getButtonText(key: string, fallback?: string): Promise<string> {
  const safeFallback = fallback ?? BUTTON_FALLBACKS[key] ?? key;
  const cached = buttonCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? safeFallback;
  }
  try {
    const row = await prisma.buttonText.findUnique({ where: { key } });
    buttonCache.set(key, { value: row?.currentText ?? null, at: Date.now() });
    return row?.currentText ?? safeFallback;
  } catch (err) {
    logger.warn("button text lookup failed, using fallback", { key, error: errorMessage(err) });
    return safeFallback;
  }
}
