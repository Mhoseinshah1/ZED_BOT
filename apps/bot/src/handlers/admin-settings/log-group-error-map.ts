// =============================================================================
// Exhaustive, PURE mapping from a worker/enqueue safe error code to an
// actionable Persian category (§8). Every code the worker Telegram client and
// the setup pipeline can produce has an explicit, actionable message - a KNOWN
// Telegram/configuration error is NEVER reported as a database error. Kept as a
// dependency-free pure function so it is trivially unit-testable over every
// code.
// =============================================================================

/** The exact per-code Persian categories (spec §8, verbatim). */
export const SETUP_SAFE_ERROR_MESSAGES: Record<string, string> = {
  "chat-not-found": "گروه در دسترس نیست.",
  "bot-not-member": "ربات داخل گروه عضو نیست.",
  "bot-not-admin": "ربات مدیر گروه نیست.",
  "manage-topics-required": "دسترسی مدیریت موضوعات برای ربات فعال نیست.",
  "topics-disabled": "قابلیت موضوعات گروه غیرفعال است.",
  forbidden: "ربات اجازه انجام این عملیات را ندارد.",
  "topic-missing": "تاپیک موردنظر وجود ندارد.",
  "topic-closed": "تاپیک موردنظر بسته شده است.",
  "rate-limited": "تلگرام موقتاً درخواست‌ها را محدود کرده است.",
  "telegram-timeout": "پاسخی از تلگرام دریافت نشد؛ دوباره تلاش کنید.",
  "network-error": "ارتباط شبکه با تلگرام برقرار نشد.",
  "telegram-server-error": "تلگرام موقتاً در دسترس نیست.",
  "bad-response": "پاسخ نامعتبر از تلگرام دریافت شد.",
  "bad-request": "درخواست نامعتبر برای تلگرام ارسال شد.",
  "redis-unavailable": "Redis یا صف Worker در دسترس نیست.",
  "bot-token-missing": "توکن ربات در Worker تنظیم نشده است.",
  "setup-error": "راه‌اندازی با خطای داخلی متوقف شد.",
};

/** Fallback for an unknown/absent code - safe + generic, never a wrong claim. */
export const SETUP_UNKNOWN_ERROR_MESSAGE = "راه‌اندازی با خطای داخلی متوقف شد.";

/**
 * Maps a safe error code to its actionable Persian category. Unknown or null
 * codes fall back to a generic internal-error message; a KNOWN Telegram
 * configuration error is never mislabeled as a database error.
 */
export function mapSetupSafeError(code: string | null | undefined): string {
  if (code === null || code === undefined) {
    return SETUP_UNKNOWN_ERROR_MESSAGE;
  }
  return SETUP_SAFE_ERROR_MESSAGES[code] ?? SETUP_UNKNOWN_ERROR_MESSAGE;
}
