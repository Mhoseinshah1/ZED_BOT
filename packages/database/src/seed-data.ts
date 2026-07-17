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

// Operational log-topic rows (ops phase: backups + Telegram operational
// logging). SOURCE OF TRUTH for the stable keys and default Persian titles
// is packages/shared/src/ops.ts (OPS_LOG_TOPIC_KEYS / OPS_LOG_TOPIC_TITLES);
// they are duplicated here on purpose because @zedbot/database intentionally
// carries NO workspace dependencies (the migration/seed container runs it
// standalone). Keep the two lists in sync when a topic is added.
// Seeded create-if-missing by key; the 13 legacy topics are never touched.
export const OPS_LOG_TOPIC_SEEDS: Array<{ key: string; title: string }> = [
  { key: "SYSTEM", title: "سیستم" },
  { key: "ERROR", title: "خطاها" },
  { key: "PAYMENT", title: "پرداخت‌ها" },
  { key: "ORDER", title: "سفارش‌ها" },
  { key: "SERVICE", title: "سرویس‌ها" },
  { key: "PANEL", title: "پنل‌ها" },
  { key: "SECURITY", title: "امنیت" },
  { key: "BACKUP", title: "بکاپ‌ها" },
  { key: "SUPPORT", title: "پشتیبانی" },
  { key: "BROADCAST", title: "پیام همگانی" },
  { key: "AUDIT", title: "گزارش حسابرسی" },
];

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
  // --- online payments (gateway phase) ----------------------------------------------
  {
    key: "payment_redirect_text",
    title: "متن انتقال به درگاه پرداخت",
    category: "payment",
    defaultContent: "در حال انتقال به درگاه پرداخت هستید…",
    allowedVariables: [],
  },
  {
    key: "payment_crypto_created_text",
    title: "متن ساخت پرداخت کریپتویی",
    category: "payment",
    defaultContent:
      "لینک پرداخت کریپتویی برای شما ساخته شد.\n" +
      "پس از تکمیل پرداخت، سفارش شما به‌صورت خودکار بررسی می‌شود.",
    allowedVariables: [],
  },
  {
    key: "payment_stars_ready_text",
    title: "متن آماده‌سازی پرداخت Stars",
    category: "payment",
    defaultContent:
      "پرداخت با Telegram Stars آماده است.\n" +
      "برای ادامه، پرداخت را از طریق تلگرام تکمیل کنید.",
    allowedVariables: [],
  },
  {
    key: "payment_success_text",
    title: "پیام موفقیت پرداخت آنلاین",
    category: "payment",
    defaultContent: "پرداخت شما با موفقیت تایید شد ✅",
    allowedVariables: [],
  },
  {
    key: "payment_pending_text",
    title: "پیام در انتظار بودن پرداخت آنلاین",
    category: "payment",
    defaultContent: "پرداخت شما در انتظار تایید است.",
    allowedVariables: [],
  },
  {
    key: "payment_failed_text",
    title: "پیام ناموفق بودن پرداخت آنلاین",
    category: "payment",
    defaultContent:
      "پرداخت ناموفق بود.\n" +
      "در صورت کسر مبلغ، وضعیت سفارش پس از بررسی بروزرسانی می‌شود.",
    allowedVariables: [],
  },
  {
    key: "payment_gateway_unavailable_text",
    title: "پیام در دسترس نبودن درگاه پرداخت",
    category: "payment",
    defaultContent: "این روش پرداخت در حال حاضر فعال نیست.",
    allowedVariables: [],
  },
  // --- admin payment provider management (provider-management phase) ---------------
  {
    key: "payment_methods_admin_header",
    title: "عنوان مدیریت روش‌های پرداخت",
    category: "payment",
    defaultContent: "مدیریت روش‌های پرداخت 💳",
    allowedVariables: [],
  },
  {
    key: "payment_provider_pick_text",
    title: "راهنمای انتخاب روش پرداخت در پنل ادمین",
    category: "payment",
    defaultContent: "روش پرداخت موردنظر را انتخاب کنید.",
    allowedVariables: [],
  },
  {
    key: "payment_provider_enable_confirm",
    title: "تایید فعال کردن روش پرداخت",
    category: "payment",
    defaultContent: "آیا از فعال کردن این روش پرداخت مطمئن هستید؟",
    allowedVariables: [],
  },
  {
    key: "payment_provider_disable_confirm",
    title: "تایید غیرفعال کردن روش پرداخت",
    category: "payment",
    defaultContent: "آیا از غیرفعال کردن این روش پرداخت مطمئن هستید؟",
    allowedVariables: [],
  },
  {
    key: "payment_provider_enabled_text",
    title: "پیام فعال شدن روش پرداخت",
    category: "payment",
    defaultContent: "روش پرداخت با موفقیت فعال شد ✅",
    allowedVariables: [],
  },
  {
    key: "payment_provider_disabled_text",
    title: "پیام غیرفعال شدن روش پرداخت",
    category: "payment",
    defaultContent: "روش پرداخت با موفقیت غیرفعال شد ✅",
    allowedVariables: [],
  },
  {
    key: "payment_provider_already_enabled_text",
    title: "پیام فعال بودن قبلی روش پرداخت",
    category: "payment",
    defaultContent: "این روش پرداخت از قبل فعال است.",
    allowedVariables: [],
  },
  {
    key: "payment_provider_already_disabled_text",
    title: "پیام غیرفعال بودن قبلی روش پرداخت",
    category: "payment",
    defaultContent: "این روش پرداخت از قبل غیرفعال است.",
    allowedVariables: [],
  },
  {
    key: "payment_provider_config_incomplete_text",
    title: "پیام ناقص بودن تنظیمات هنگام فعال‌سازی",
    category: "payment",
    defaultContent: "تنظیمات این درگاه کامل نیست و امکان فعال‌سازی آن وجود ندارد.",
    allowedVariables: [],
  },
  {
    key: "payment_provider_test_ok_text",
    title: "پیام موفقیت تست اتصال",
    category: "payment",
    defaultContent: "اتصال با موفقیت برقرار شد ✅",
    allowedVariables: [],
  },
  {
    key: "payment_provider_test_failed_text",
    title: "پیام ناموفق بودن تست اتصال",
    category: "payment",
    defaultContent: "اتصال به سرویس پرداخت برقرار نشد.",
    allowedVariables: [],
  },
  {
    key: "payment_provider_test_incomplete_text",
    title: "پیام ناقص بودن تنظیمات هنگام تست اتصال",
    category: "payment",
    defaultContent: "تنظیمات این درگاه ناقص است.",
    allowedVariables: [],
  },
  {
    key: "payment_no_online_methods_text",
    title: "پیام نبود روش پرداخت فعال",
    category: "payment",
    defaultContent: "در حال حاضر روش پرداخت فعالی وجود ندارد. لطفاً با پشتیبانی تماس بگیرید.",
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
  // Free-trial phase: the real main-menu label (was a literal-brace
  // placeholder «اشتراک رایگان {تست}» before the flow existed).
  { key: "free_test", title: "اکانت تست رایگان", text: "اکانت تست رایگان 🎁" },
  // Admin-entry phase: the active-admin-only final user-menu row. Editable
  // like every other label; the visible text is never authorization.
  { key: "admin_panel", title: "منوی کاربر: پنل مدیریت", text: "پنل مدیریت 🛠" },
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
  // Admin payment provider management (provider-management phase).
  { key: "pm_enable", title: "فعال کردن روش پرداخت", text: "فعال کردن" },
  { key: "pm_disable", title: "غیرفعال کردن روش پرداخت", text: "غیرفعال کردن" },
  { key: "pm_settings", title: "تنظیمات روش پرداخت", text: "تنظیمات" },
  { key: "pm_settings_wallet", title: "تنظیمات کیف پول", text: "تنظیمات کیف پول" },
  { key: "pm_settings_card", title: "تنظیمات کارت‌به‌کارت", text: "تنظیمات کارت‌به‌کارت" },
  { key: "pm_test", title: "تست اتصال روش پرداخت", text: "تست اتصال" },
  { key: "pm_back_providers", title: "بازگشت به روش‌های پرداخت", text: "بازگشت به روش‌های پرداخت" },
  // Admin-menu-keyboard-mode phase: the admin MAIN menu section labels join
  // the editable registry (defaults = the exact approved inline labels), so
  // reply-keyboard routing keeps working after operator edits. Only the
  // top-level navigation labels - deeper admin pages stay code-level.
  { key: "admin_finance", title: "منوی ادمین: مالی", text: "مالی 💎" },
  { key: "admin_users", title: "منوی ادمین: مدیریت کاربران", text: "مدیریت کاربران 👤" },
  { key: "admin_products", title: "منوی ادمین: محصولات/پلن‌ها", text: "مدیریت محصولات/پلن‌ها 📦" },
  { key: "admin_panels", title: "منوی ادمین: مدیریت پنل‌ها", text: "مدیریت پنل‌ها 🖥" },
  {
    key: "admin_other_products",
    title: "منوی ادمین: محصولات دیگر",
    text: "محصولات دیگر / سفارش‌های محصولات دیگر",
  },
  { key: "admin_support_tickets", title: "منوی ادمین: تیکت‌ها", text: "تیکت‌های پشتیبانی 🎫" },
  { key: "admin_broadcast", title: "منوی ادمین: پیام همگانی", text: "پیام همگانی 📣" },
  { key: "admin_general_settings", title: "منوی ادمین: تنظیمات عمومی", text: "تنظیمات عمومی ⚙️" },
  { key: "admin_reports_backup", title: "منوی ادمین: گزارشات / بکاپ", text: "گزارشات / بکاپ 📊" },
];
