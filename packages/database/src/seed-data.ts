// =============================================================================
// Seed registry for operator-editable texts (single source of truth).
//
// MessageTemplate rows: stable key, Persian default aligned with the Master
// Requirements document (ZED_BOT_Master_Requirements_FA.docx), explicit
// allowed-variable list (empty = the template takes no variables), and a
// human title for the admin editor. ButtonText rows: stable key + Persian
// default label. Callback data NEVER derives from these labels.
//
// The seed creates missing rows and refreshes DEFAULTS of existing rows;
// operator-customized current values are never overwritten (seed.ts).
// =============================================================================

export interface MessageTemplateSeed {
  key: string;
  title: string;
  category: string;
  defaultContent: string;
  /** Explicit allowed variables; edits may never introduce others. */
  allowedVariables: string[];
}

export interface ButtonTextSeed {
  key: string;
  title: string;
  text: string;
}

export const INITIAL_MESSAGE_TEMPLATES: MessageTemplateSeed[] = [
  // --- general / access gates ------------------------------------------------
  {
    key: "start_text",
    title: "پیام شروع",
    category: "general",
    defaultContent:
      "سلام {first_name} عزیز 👋\n" +
      "\n" +
      "به {bot_name} خوش آمدید.\n" +
      "\n" +
      "از طریق این ربات می‌توانید سرویس VPN، محصولات دیجیتال، کیف پول، سفارش‌ها و پشتیبانی خود را مدیریت کنید.\n" +
      "\n" +
      "وضعیت فروش: {sales_status}",
    allowedVariables: ["first_name", "username", "bot_name", "sales_status"],
  },
  {
    key: "bot_off_text",
    title: "پیام حالت تعمیرات",
    category: "general",
    defaultContent: "ربات در حال بروزرسانی است. لطفاً کمی بعد دوباره تلاش کنید.",
    allowedVariables: [],
  },
  {
    key: "blocked_text",
    title: "پیام کاربر مسدود",
    category: "general",
    defaultContent:
      "حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید.",
    allowedVariables: [],
  },
  {
    key: "terms_text",
    title: "متن قوانین",
    category: "general",
    defaultContent: "برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید.",
    allowedVariables: [],
  },
  {
    key: "force_join_text",
    title: "پیام عضویت اجباری",
    category: "general",
    defaultContent: "برای ادامه، ابتدا در کانال‌های مشخص‌شده عضو شوید.",
    allowedVariables: [],
  },
  {
    key: "support_text",
    title: "پیام پشتیبانی",
    category: "support",
    defaultContent: "برای ارتباط با پشتیبانی پیام خود را ارسال کنید.",
    allowedVariables: [],
  },
  {
    key: "faq_text",
    title: "سوالات متداول",
    category: "general",
    defaultContent: "سوالات متداول به زودی تکمیل می‌شود.",
    allowedVariables: [],
  },
  // --- wallet ------------------------------------------------------------------
  {
    key: "wallet_header_text",
    title: "عنوان صفحه کیف پول",
    category: "wallet",
    defaultContent: "کیف پول و حساب کاربری 🏦",
    allowedVariables: [],
  },
  {
    key: "wallet_topup_amount_prompt",
    title: "درخواست مبلغ شارژ کیف پول",
    category: "wallet",
    defaultContent: "مبلغ موردنظر برای افزایش موجودی را به تومان وارد کنید.",
    allowedVariables: [],
  },
  {
    key: "wallet_topup_preview_note",
    title: "توضیح پیش‌فاکتور شارژ کیف پول",
    category: "wallet",
    defaultContent: "پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد.",
    allowedVariables: [],
  },
  {
    key: "wallet_empty_transactions_text",
    title: "پیام نبود تراکنش",
    category: "wallet",
    defaultContent: "هنوز تراکنشی برای کیف پول شما ثبت نشده است.",
    allowedVariables: [],
  },
  // --- empty states --------------------------------------------------------------
  {
    key: "no_services_text",
    title: "پیام نبود سرویس",
    category: "empty_state",
    defaultContent: "هنوز سرویسی برای شما ثبت نشده است.",
    allowedVariables: [],
  },
  {
    key: "no_orders_text",
    title: "پیام نبود سفارش",
    category: "empty_state",
    defaultContent: "هنوز سفارشی ثبت نکرده‌اید.",
    allowedVariables: [],
  },
  {
    key: "no_tickets_text",
    title: "پیام نبود تیکت",
    category: "empty_state",
    defaultContent: "هنوز تیکتی ثبت نکرده‌اید.",
    allowedVariables: [],
  },
  {
    key: "no_payments_text",
    title: "پیام نبود پرداخت",
    category: "empty_state",
    defaultContent: "هنوز پرداختی برای شما ثبت نشده است.",
    allowedVariables: [],
  },
  {
    key: "no_other_product_orders_text",
    title: "پیام نبود سفارش محصولات دیگر",
    category: "empty_state",
    defaultContent: "هنوز سفارش محصول دیگری ثبت نکرده‌اید.",
    allowedVariables: [],
  },
  // --- support ---------------------------------------------------------------------
  {
    key: "support_landing_text",
    title: "متن صفحه پشتیبانی",
    category: "support",
    defaultContent:
      "از این بخش می‌توانید با پشتیبانی در ارتباط باشید و پاسخ تیکت‌های قبلی را پیگیری کنید.",
    allowedVariables: [],
  },
  {
    key: "support_subject_prompt",
    title: "درخواست موضوع تیکت",
    category: "support",
    defaultContent: "موضوع تیکت را وارد کنید. ({min} تا {max} کاراکتر)",
    allowedVariables: ["min", "max"],
  },
  {
    key: "support_message_prompt",
    title: "درخواست متن تیکت",
    category: "support",
    defaultContent: "پیام خود را برای پشتیبانی ارسال کنید. (حداکثر {max} کاراکتر)",
    allowedVariables: ["max"],
  },
  {
    key: "support_reply_prompt",
    title: "درخواست پاسخ تیکت",
    category: "support",
    defaultContent: "پاسخ خود را ارسال کنید. (حداکثر {max} کاراکتر)",
    allowedVariables: ["max"],
  },
  {
    key: "support_empty_tickets_text",
    title: "پیام نبود تیکت (پشتیبانی)",
    category: "support",
    defaultContent: "هنوز تیکتی ثبت نکرده‌اید.",
    allowedVariables: [],
  },
  {
    key: "support_ticket_created_text",
    title: "پیام ثبت تیکت",
    category: "support",
    defaultContent: "تیکت شما با موفقیت ثبت شد ✅",
    allowedVariables: [],
  },
  // --- history --------------------------------------------------------------------
  {
    key: "history_landing_text",
    title: "متن صفحه سوابق",
    category: "history",
    defaultContent:
      "سوابق سفارش‌ها، پرداخت‌ها و تراکنش‌های کیف پول شما در این بخش قابل مشاهده است.",
    allowedVariables: [],
  },
];

export const INITIAL_BUTTON_TEXTS: ButtonTextSeed[] = [
  { key: "buy_subscription", title: "خرید اشتراک", text: "خرید اشتراک 🔐" },
  { key: "renew_service", title: "تمدید سرویس", text: "تمدید سرویس ♻️" },
  { key: "extra_volume", title: "خرید حجم اضافه", text: "خرید حجم اضافه ➕" },
  { key: "extra_time", title: "خرید زمان اضافه", text: "خرید زمان اضافه ⏳" },
  { key: "my_services", title: "سرویس‌های من", text: "سرویس‌های من 🛍" },
  { key: "wallet", title: "کیف پول", text: "کیف پول + شارژ 🏦" },
  { key: "support", title: "پشتیبانی", text: "پشتیبانی ☎️" },
  { key: "tutorials", title: "آموزش", text: "آموزش 📚" },
  { key: "free_test", title: "اشتراک رایگان تست", text: "اشتراک رایگان {تست}" },
  { key: "referral", title: "زیرمجموعه گیری", text: "زیرمجموعه گیری 👥" },
  { key: "other_products", title: "محصولات دیگر", text: "محصولات دیگر 🛍" },
  { key: "my_orders", title: "سفارش‌های من", text: "سفارش‌های من 🧾" },
  { key: "pricing", title: "تعرفه اشتراک‌ها", text: "تعرفه اشتراک‌ها 💵" },
  { key: "representative_request", title: "درخواست نمایندگی", text: "درخواست نمایندگی 👨‍💼" },
  { key: "lucky_wheel", title: "گردونه شانس", text: "گردونه شانس 🎲" },
  { key: "back", title: "بازگشت", text: "بازگشت" },
  { key: "back_to_list", title: "بازگشت به لیست", text: "بازگشت به لیست" },
  { key: "main_menu", title: "بازگشت به منوی اصلی", text: "بازگشت به منوی اصلی" },
  { key: "back_to_admin", title: "بازگشت به پنل ادمین", text: "بازگشت به پنل ادمین" },
  { key: "cancel", title: "لغو", text: "لغو ❌" },
  { key: "confirm", title: "تایید", text: "تایید ✅" },
  { key: "next", title: "بعدی", text: "بعدی »" },
  { key: "previous", title: "قبلی", text: "« قبلی" },
  { key: "new_ticket", title: "ایجاد تیکت جدید", text: "ایجاد تیکت جدید ➕" },
  { key: "my_tickets", title: "تیکت‌های من", text: "تیکت‌های من 📋" },
  { key: "reply_ticket", title: "پاسخ به تیکت", text: "پاسخ به تیکت ✍️" },
  { key: "refresh", title: "بروزرسانی", text: "بروزرسانی ♻️" },
  { key: "all_orders", title: "همه سفارش‌ها", text: "همه سفارش‌ها 📋" },
  { key: "subscription_orders", title: "خرید اشتراک‌ها", text: "خرید اشتراک‌ها 🔐" },
  { key: "other_product_orders", title: "سفارش‌های محصولات دیگر", text: "محصولات دیگر 🛍" },
  { key: "payments", title: "پرداخت‌ها", text: "پرداخت‌ها 💳" },
  { key: "wallet_transactions", title: "تراکنش‌های کیف پول", text: "تراکنش‌های کیف پول 🏦" },
  { key: "back_to_support", title: "بازگشت به پشتیبانی", text: "بازگشت به پشتیبانی" },
  { key: "back_to_history", title: "بازگشت به سوابق", text: "بازگشت به سوابق" },
];
