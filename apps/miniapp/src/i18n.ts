import type { ApiFailureCode } from "./api";

// =============================================================================
// Persian text.
//
// Every string the user reads is written here. The server sends codes and never
// prose, so nothing server-authored is ever rendered - which is both a
// translation decision and a safety one: an error string that travelled from a
// database driver has no business on a user's screen.
//
// Each failure gets a title, an explanation, and - where the user can actually
// do something - an action. "Contact support" is not offered for problems the
// user can fix themselves, and no message ever hints at internal structure.
// =============================================================================

export interface FailureText {
  title: string;
  body: string;
  /** Label for the "open the bot" button, when one applies. */
  action?: string;
  /** True when retrying might genuinely help. */
  retryable: boolean;
}

export const FAILURE_TEXT: Record<ApiFailureCode, FailureText> = {
  NETWORK: {
    title: "ارتباط برقرار نشد",
    body: "اتصال اینترنت خود را بررسی کنید و دوباره تلاش کنید.",
    retryable: true,
  },
  TIMEOUT: {
    title: "پاسخی دریافت نشد",
    body: "درخواست بیش از حد طول کشید. لطفاً دوباره تلاش کنید.",
    retryable: true,
  },
  UNEXPECTED: {
    title: "خطای غیرمنتظره",
    body: "پاسخ دریافت‌شده قابل پردازش نبود. لطفاً دوباره تلاش کنید.",
    retryable: true,
  },
  INVALID_INIT_DATA: {
    title: "ورود تأیید نشد",
    body: "اطلاعات ورود معتبر نبود یا منقضی شده است. لطفاً مینی‌اپ را ببندید و دوباره از داخل ربات باز کنید.",
    retryable: true,
  },
  NOT_REGISTERED: {
    title: "هنوز ثبت‌نام نکرده‌اید",
    body: "برای استفاده از این بخش ابتدا وارد ربات شوید و دستور /start را بزنید.",
    action: "باز کردن ربات",
    retryable: false,
  },
  NOT_AUTHENTICATED: {
    title: "نشست شما پایان یافت",
    body: "برای ادامه لازم است دوباره وارد شوید.",
    retryable: true,
  },
  FORBIDDEN_ORIGIN: {
    title: "درخواست نامعتبر",
    body: "این درخواست از مسیر معتبر ارسال نشده است. لطفاً مینی‌اپ را از داخل ربات باز کنید.",
    retryable: false,
  },
  RATE_LIMITED: {
    title: "تعداد تلاش‌ها زیاد بود",
    body: "کمی صبر کنید و دوباره تلاش کنید.",
    retryable: true,
  },
  BAD_REQUEST: {
    title: "درخواست نامعتبر",
    body: "درخواست ارسال‌شده معتبر نبود. لطفاً صفحه را دوباره باز کنید.",
    retryable: true,
  },
  NOT_FOUND: {
    title: "یافت نشد",
    body: "موردی که به دنبال آن هستید وجود ندارد یا دیگر در دسترس نیست.",
    retryable: false,
  },
  NOT_CONFIGURED: {
    title: "سرویس در دسترس نیست",
    body: "این بخش هنوز پیکربندی نشده است. لطفاً بعداً تلاش کنید.",
    retryable: true,
  },
  INSECURE_TRANSPORT: {
    title: "اتصال امن نیست",
    body: "این صفحه باید روی اتصال امن (HTTPS) باز شود. لطفاً مینی\u200cاپ را از داخل ربات باز کنید.",
    retryable: false,
  },
  INTERNAL: {
    title: "خطای سرور",
    body: "مشکلی در سمت سرور رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
    retryable: true,
  },
  MAINTENANCE: {
    title: "در حال به‌روزرسانی",
    body: "سامانه موقتاً در حالت تعمیر و نگهداری است. لطفاً کمی بعد دوباره سر بزنید.",
    retryable: true,
  },
  USER_BLOCKED: {
    title: "دسترسی مسدود است",
    body: "حساب شما مسدود شده است. برای پیگیری با پشتیبانی در ربات در تماس باشید.",
    action: "باز کردن ربات",
    retryable: false,
  },
  USER_DISABLED: {
    title: "حساب غیرفعال است",
    body: "حساب شما در حال حاضر غیرفعال است. برای پیگیری با پشتیبانی در ربات در تماس باشید.",
    action: "باز کردن ربات",
    retryable: false,
  },
  USER_UNAVAILABLE: {
    title: "حساب در دسترس نیست",
    body: "حساب شما در دسترس نیست. لطفاً از داخل ربات ادامه دهید.",
    action: "باز کردن ربات",
    retryable: false,
  },
  TERMS_REQUIRED: {
    title: "پذیرش قوانین لازم است",
    body: "برای استفاده از حساب خود ابتدا باید نسخهٔ جدید قوانین را در ربات بپذیرید.",
    action: "پذیرش در ربات",
    retryable: false,
  },
  FORCE_JOIN_REQUIRED: {
    title: "عضویت در کانال لازم است",
    body: "برای ادامه باید عضو کانال‌های اعلام‌شده باشید. بررسی عضویت فقط در ربات انجام می‌شود.",
    action: "بررسی در ربات",
    retryable: false,
  },
  ACCESS_CHECK_UNAVAILABLE: {
    title: "بررسی دسترسی ممکن نشد",
    body: "در حال حاضر امکان بررسی دسترسی وجود ندارد. لطفاً دوباره تلاش کنید.",
    retryable: true,
  },
};

/** Service lifecycle states, in the same words the bot uses. */
export const SERVICE_STATUS_TEXT: Record<string, string> = {
  CREATING: "در حال ساخت",
  ACTIVE: "فعال",
  DISABLED: "غیرفعال",
  EXPIRED: "منقضی",
  LIMITED: "محدود شده",
  DELETED: "حذف‌شده",
  FAILED: "ناموفق",
};

export const WALLET_TYPE_TEXT: Record<string, string> = {
  CHARGE: "شارژ کیف پول",
  SPEND: "پرداخت",
  REFUND: "بازگشت وجه",
  CASHBACK: "بازگشت نقدی",
  COMMISSION: "پورسانت",
  MANUAL_ADD: "افزایش دستی",
  MANUAL_DEDUCT: "کسر دستی",
  DEBT_ADD: "ثبت بدهی",
  DEBT_PAYMENT: "تسویه بدهی",
  DISCOUNT: "تخفیف",
  SYSTEM_ADJUSTMENT: "اصلاح سیستمی",
};

export const USER_GROUP_TEXT: Record<string, string> = {
  F: "کاربر عادی",
  N: "نماینده",
  N2: "نمایندهٔ ویژه",
};

export const SERVICE_SOURCE_TEXT: Record<string, string> = {
  PAID: "خریداری‌شده",
  FREE_TRIAL: "تست رایگان",
};

/** Falls back to the raw code so an unmapped value is visible, not blank. */
export function lookup(table: Record<string, string>, key: string): string {
  return table[key] ?? key;
}

export const UI = {
  appName: "پنل کاربری",
  loading: "در حال بارگذاری…",
  retry: "تلاش دوباره",
  refresh: "به‌روزرسانی",
  loadMore: "نمایش بیشتر",
  empty: "موردی برای نمایش وجود ندارد",
  navDashboard: "خانه",
  navServices: "سرویس‌ها",
  navWallet: "کیف پول",
  navProfile: "حساب من",
  back: "بازگشت",
  balance: "موجودی کیف پول",
  toman: "تومان",
  servicesTotal: "همهٔ سرویس‌ها",
  servicesActive: "سرویس‌های فعال",
  expiringSoon: "نزدیک به انقضا (۷ روز)",
  recentServices: "آخرین سرویس‌ها",
  recentTransactions: "آخرین تراکنش‌ها",
  serviceUsername: "نام کاربری سرویس",
  product: "محصول",
  panel: "سرور",
  volume: "حجم کل",
  used: "مصرف‌شده",
  remaining: "باقی‌مانده",
  duration: "مدت",
  startsAt: "شروع",
  expiresAt: "انقضا",
  neverExpires: "بدون انقضا",
  firstConnected: "اولین اتصال",
  lastConnected: "آخرین اتصال",
  note: "یادداشت",
  origin: "نوع",
  location: "موقعیت",
  createdAt: "تاریخ ایجاد",
  notConnectedYet: "هنوز متصل نشده",
  balanceAfter: "موجودی پس از تراکنش",
  joinedAt: "تاریخ عضویت",
  accountGroup: "نوع حساب",
  accountStatus: "وضعیت حساب",
  telegramUsername: "نام کاربری تلگرام",
  noUsername: "ثبت نشده",
  logout: "خروج از حساب",
  readOnlyNotice:
    "این بخش فقط برای مشاهده است. خرید، پرداخت و تغییر سرویس‌ها در ربات انجام می‌شود.",
  openBot: "باز کردن ربات",
  outsideTelegram: "این صفحه فقط داخل تلگرام کار می‌کند",
  outsideTelegramBody: "لطفاً مینی‌اپ را از داخل ربات باز کنید.",
  days: "روز",
} as const;
