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
