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
    body: "برای ادامه باید عضو کانال‌های اعلام‌شده باشید. پس از عضویت، دوباره تلاش کنید.",
    // The bot renders the list of required channels with join buttons; this app
    // deliberately does not expose channel data. Membership itself is verified
    // here on every request, so a retry after joining is enough.
    action: "مشاهده کانال‌ها در ربات",
    retryable: true,
  },
  ACCESS_CHECK_UNAVAILABLE: {
    title: "بررسی دسترسی ممکن نشد",
    body: "در حال حاضر امکان بررسی دسترسی وجود ندارد. لطفاً دوباره تلاش کنید.",
    retryable: true,
  },
  // --- support-centre writes -------------------------------------------------
  //
  // These reach a user only when the client-side checks were bypassed or the
  // ticket changed underneath them, so each says what the SERVER decided and
  // what to do about it - never "invalid input" with no direction.
  UNSUPPORTED_MEDIA_TYPE: {
    title: "درخواست نامعتبر",
    body: "قالب درخواست ارسال‌شده پذیرفته نشد. لطفاً صفحه را دوباره باز کنید.",
    retryable: false,
  },
  INVALID_SUBJECT: {
    title: "موضوع پذیرفته نشد",
    body: "موضوع باید بین ۳ تا ۱۰۰ نویسه باشد. لطفاً آن را کوتاه‌تر یا کامل‌تر بنویسید.",
    retryable: false,
  },
  INVALID_MESSAGE: {
    title: "متن پیام پذیرفته نشد",
    body: "متن پیام باید بین ۱ تا ۳۰۰۰ نویسه باشد. لطفاً آن را اصلاح کنید.",
    retryable: false,
  },
  INVALID_CATEGORY: {
    title: "دسته‌بندی نامعتبر",
    body: "دستهٔ انتخاب‌شده معتبر نیست. لطفاً یکی از دسته‌های فهرست را انتخاب کنید.",
    retryable: false,
  },
  INVALID_SERVICE: {
    title: "سرویس نامعتبر",
    body: "سرویس انتخاب‌شده پیدا نشد. تیکت را بدون سرویس ثبت کنید یا سرویس دیگری انتخاب کنید.",
    retryable: false,
  },
  INVALID_REQUEST_ID: {
    title: "درخواست نامعتبر",
    body: "شناسهٔ این درخواست معتبر نبود. لطفاً صفحه را دوباره باز کنید و از نو تلاش کنید.",
    retryable: false,
  },
  INVALID_TICKET_ID: {
    title: "تیکت یافت نشد",
    body: "این تیکت وجود ندارد یا دیگر در دسترس شما نیست.",
    retryable: false,
  },
  TICKET_NOT_FOUND: {
    title: "تیکت یافت نشد",
    body: "این تیکت وجود ندارد یا دیگر در دسترس شما نیست.",
    retryable: false,
  },
  // A closed conversation is not an error the user caused, and retrying it can
  // never succeed - so no retry is offered and the screen says what to do
  // instead.
  TICKET_CLOSED: {
    title: "این تیکت بسته شده است",
    body: "امکان ارسال پاسخ روی تیکت بسته وجود ندارد. برای پیگیری، یک تیکت جدید باز کنید.",
    retryable: false,
  },
  // The key is known but was first used for different content: replaying it
  // would answer a question nobody asked, so the user starts a new draft.
  IDEMPOTENCY_CONFLICT: {
    title: "این درخواست قبلاً ثبت شده است",
    body: "درخواست دیگری با همین شناسه پیش‌تر ثبت شده بود. لطفاً از نو شروع کنید.",
    retryable: false,
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

// --- support tickets ---------------------------------------------------------
//
// `apps/miniapp` deliberately depends on NOTHING from the workspace: it is a
// browser bundle, and pulling in `@zedbot/shared` would drag a package built
// for Node (and everything it imports) into a Vite build for the sake of five
// strings. So the codes and their labels are written out here and MIRROR
// `SUPPORT_TICKET_CATEGORIES` / `SUPPORT_CATEGORY_LABEL_FA` in
// `packages/shared/src/support-tickets-v2.ts` exactly - same codes, same
// Persian words. Behaviour is driven by the CODE either way; the server
// re-validates whatever this app sends, so a drifted label is a wording bug
// and a drifted code is refused with INVALID_CATEGORY rather than accepted.

/** Mirrors `SUPPORT_TICKET_CATEGORIES` (`@zedbot/shared`), order included. */
export const SUPPORT_CATEGORIES = [
  "CONNECTION",
  "PAYMENT",
  "SERVICE_MANAGEMENT",
  "ACCOUNT",
  "OTHER",
] as const;

export type SupportCategoryCode = (typeof SUPPORT_CATEGORIES)[number];

/** Mirrors `SUPPORT_CATEGORY_LABEL_FA` (`@zedbot/shared`), word for word. */
export const SUPPORT_CATEGORY_TEXT: Record<string, string> = {
  CONNECTION: "اتصال",
  PAYMENT: "پرداخت و سفارش",
  SERVICE_MANAGEMENT: "مدیریت سرویس",
  ACCOUNT: "حساب کاربری",
  OTHER: "سایر",
};

/**
 * Which categories are ABOUT a particular service.
 *
 * `true` puts the service picker in front of the user straight away — a
 * connection problem or a service-management request is nearly always about one
 * account, and asking afterwards means asking again. `false` still offers the
 * link, just as an optional step: a payment question or an account question
 * usually is not about one service, and sometimes is.
 *
 * Linking is NEVER required. A person who cannot tell which service is broken —
 * or whose problem is that they have none — must still be able to reach
 * support, so every path has a way past this step.
 */
export const SUPPORT_CATEGORY_WANTS_SERVICE: Record<SupportCategoryCode, boolean> = {
  CONNECTION: true,
  SERVICE_MANAGEMENT: true,
  PAYMENT: false,
  ACCOUNT: false,
  OTHER: false,
};

/**
 * Whose turn it is, as the server decided it.
 *
 * Rendered from `waitingParty` rather than re-derived from `status` here: the
 * status vocabulary has legacy values, the mapping lives in the domain, and two
 * copies of it would eventually disagree about a ticket old enough to matter.
 */
export const TICKET_WAITING_TEXT: Record<string, string> = {
  USER: "در انتظار پاسخ شما",
  SUPPORT: "در انتظار پشتیبانی",
};

/**
 * Ticket lifecycle states.
 *
 * `ANSWERED` is a legacy value the enum still carries; it means the same thing
 * to a user as `WAITING_USER`, so it reads the same rather than leaking the
 * word "ANSWERED" onto a screen.
 */
export const TICKET_STATUS_TEXT: Record<string, string> = {
  OPEN: "باز",
  WAITING_ADMIN: "در انتظار پشتیبانی",
  WAITING_USER: "در انتظار پاسخ شما",
  ANSWERED: "در انتظار پاسخ شما",
  CLOSED: "بسته‌شده",
};

/** Who wrote a message. `SYSTEM` is the bot's own automated note. */
export const TICKET_SENDER_TEXT: Record<string, string> = {
  USER: "شما",
  ADMIN: "پشتیبانی",
  SYSTEM: "سیستم",
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
  // Bot-return actions. Every one of these OPENS THE BOT and does nothing
  // else: the Mini App is read-only, and the flow itself lives where the
  // business logic, the notifications and the audit trail already are.
  botActionsTitle: "انجام کارها در ربات",
  botActionBuy: "خرید سرویس در ربات 🛒",
  botActionCharge: "شارژ کیف پول در ربات 💳",
  botActionRenew: "تمدید و مدیریت سرویس در ربات ♻️",
  botActionSupport: "ارتباط با پشتیبانی در ربات 💬",
  botActionsUnavailable: "آدرس ربات پیکربندی نشده است؛ لطفاً از همان چتی که این صفحه را باز کردید ادامه دهید.",
  outsideTelegram: "این صفحه فقط داخل تلگرام کار می‌کند",
  outsideTelegramBody: "لطفاً مینی‌اپ را از داخل ربات باز کنید.",
  signedOutTitle: "از حساب خارج شدید",
  signedOutBody: "برای مشاهدهٔ اطلاعات حساب، دوباره وارد شوید.",
  signInAgain: "ورود مجدد",
  days: "روز",
  expired: "منقضی شده",
  lastSynced: "آخرین بروزرسانی اطلاعات",
  remainingDays: "روزهای باقی‌مانده",
  activeServices: "سرویس‌های فعال",
  totalServices: "کل سرویس‌ها",

  // --- support centre --------------------------------------------------------
  navSupport: "پشتیبانی",
  supportTitle: "مرکز پشتیبانی",
  supportTicketsTotal: "همهٔ تیکت‌ها",
  supportTicketsWaitingSupport: "در انتظار پشتیبانی",
  supportTicketsWaitingUser: "در انتظار پاسخ شما",
  supportTicketsClosed: "بسته‌شده",
  supportOpenList: "مشاهدهٔ تیکت‌ها",
  supportNewTicket: "ثبت تیکت جدید",
  supportListTitle: "تیکت‌های من",
  supportRecentTitle: "آخرین تیکت‌ها",
  supportEmpty: "هنوز تیکتی ثبت نکرده‌اید.",
  supportTicketId: "شناسهٔ تیکت",
  supportNoSubject: "بدون موضوع",
  supportCategory: "دسته‌بندی",
  supportStatus: "وضعیت",
  supportOpenedAt: "تاریخ ثبت",
  supportUpdatedAt: "آخرین تغییر",
  supportClosedAt: "تاریخ بسته شدن",
  supportRelatedService: "سرویس مرتبط",
  supportThread: "گفت‌وگو",
  supportLoadOlder: "نمایش پیام‌های قدیمی‌تر",
  supportNoMessages: "پیامی در این تیکت ثبت نشده است.",
  supportMessageHasAttachment: "این پیام فایل پیوست دارد",
  // Attachments exist in the data and are shown in the BOT, never here: this
  // app has no upload control and no download route to point one at.
  supportAttachmentsTitle: "این تیکت فایل پیوست دارد",
  supportAttachmentsBody:
    "مشاهدهٔ فایل‌های پیوست فقط در ربات ممکن است. برای دیدن آن‌ها گفت‌وگو را در ربات ادامه دهید.",
  supportAttachmentsAction: "مشاهدهٔ پیوست‌ها در ربات 📎",
  supportReplyTitle: "ارسال پاسخ",
  supportReplyPlaceholder: "پاسخ خود را بنویسید…",
  supportReplySend: "ارسال پاسخ",
  supportReplySending: "در حال ارسال…",
  supportReplySent: "پاسخ شما ثبت شد.",
  supportReplyRetry: "ارسال دوباره",
  supportClosedNotice:
    "این تیکت بسته شده است و امکان ارسال پاسخ ندارد. برای پیگیری، تیکت جدیدی باز کنید.",

  // The wizard. One decision per step, then a review of exactly what will be
  // sent, then one explicit confirmation - nothing is submitted before it.
  supportWizardTitle: "ثبت تیکت جدید",
  supportStepCategory: "گام ۱ از ۵ — دسته‌بندی مشکل",
  supportStepService: "گام ۲ از ۵ — سرویس مرتبط",
  supportStepSubject: "گام ۳ از ۵ — موضوع",
  supportStepMessage: "گام ۴ از ۵ — شرح مشکل",
  supportStepReview: "گام ۵ از ۵ — بازبینی و تأیید",
  // The service step. Optional on every path: a person whose problem is that
  // they have no working service must still be able to open a ticket.
  supportServiceLead: "اگر این تیکت دربارهٔ یکی از سرویس‌های شماست، آن را انتخاب کنید.",
  supportServiceChoose: "انتخاب سرویس مرتبط",
  supportServiceSkip: "بدون انتخاب سرویس ادامه بده",
  supportServiceNone: "هیچ سرویسی انتخاب نشده است",
  supportServiceEmpty: "سرویسی برای انتخاب ندارید. بدون انتخاب سرویس ادامه دهید.",
  supportServiceClear: "برداشتن سرویس انتخاب‌شده",
  supportSubjectLabel: "موضوع تیکت",
  supportSubjectPlaceholder: "موضوع را کوتاه بنویسید",
  supportMessageLabel: "شرح مشکل",
  supportMessagePlaceholder: "مشکل را با جزئیات بنویسید…",
  supportNext: "ادامه",
  supportPrevious: "بازگشت به گام قبل",
  supportReviewLead: "این دقیقاً همان چیزی است که ارسال می‌شود:",
  supportConfirmSend: "تأیید و ارسال تیکت",
  supportSending: "در حال ارسال…",
  supportRetrySend: "ارسال دوباره",
  supportCancel: "انصراف",
  supportCreated: "تیکت شما ثبت شد.",
  supportSubjectTooShort: "موضوع باید دست‌کم ۳ نویسه باشد.",
  supportSubjectTooLong: "موضوع نباید بیش از ۱۰۰ نویسه باشد.",
  supportMessageTooShort: "متن پیام نمی‌تواند خالی باشد.",
  supportMessageTooLong: "متن پیام نباید بیش از ۳۰۰۰ نویسه باشد.",
  supportCharacterCount: "نویسه",
  // The wizard writes; the rest of the app does not. Saying so where the user
  // is about to write keeps the read-only notice on other screens honest.
  supportWriteNotice:
    "ثبت تیکت و پاسخ در همین‌جا انجام می‌شود؛ خرید، پرداخت و تغییر سرویس‌ها همچنان در ربات است.",
} as const;
