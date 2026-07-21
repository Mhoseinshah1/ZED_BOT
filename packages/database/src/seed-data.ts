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
  // Automated notification / retention engine (feat/notification-retention-
  // engine, Phase 1). Keys duplicated from @zedbot/shared NOTIF_TEMPLATE_KEYS
  // (this package carries no workspace deps). Every message is transactional +
  // safe: only the friendly service name + a remaining-time / percentage
  // variable, never a subscription link, token, panel data or price.
  {
    key: "notif_service_expiry",
    title: "اعلان نزدیک شدن انقضای سرویس",
    category: "notification",
    defaultContent:
      "⏳ یادآوری تمدید سرویس\n" +
      "\n" +
      "سرویس «{service_name}» تا {time_left} دیگر منقضی می‌شود.\n" +
      "برای جلوگیری از قطع شدن، همین حالا آن را تمدید کنید.",
    allowedVariables: ["service_name", "time_left"],
  },
  {
    key: "notif_service_expired",
    title: "اعلان انقضای سرویس",
    category: "notification",
    defaultContent:
      "🔴 سرویس شما منقضی شد\n" +
      "\n" +
      "سرویس «{service_name}» منقضی شده است.\n" +
      "برای فعال‌سازی مجدد، آن را تمدید کنید.",
    allowedVariables: ["service_name"],
  },
  {
    key: "notif_service_traffic",
    title: "اعلان مصرف حجم سرویس",
    category: "notification",
    defaultContent:
      "📊 هشدار مصرف حجم\n" +
      "\n" +
      "مصرف حجم سرویس «{service_name}» به {percent}٪ رسید.\n" +
      "برای جلوگیری از محدود شدن، حجم اضافه تهیه کنید.",
    allowedVariables: ["service_name", "percent"],
  },
  {
    key: "notif_service_limited",
    title: "اعلان محدود شدن سرویس",
    category: "notification",
    defaultContent:
      "🚫 سرویس محدود شد\n" +
      "\n" +
      "سرویس «{service_name}» به دلیل اتمام حجم محدود شده است.\n" +
      "برای ادامه استفاده، حجم اضافه تهیه کنید یا سرویس را تمدید کنید.",
    allowedVariables: ["service_name"],
  },
  {
    key: "notif_trial_near_expiry",
    title: "اعلان نزدیک شدن انقضای سرویس تست",
    category: "notification",
    defaultContent:
      "⏳ سرویس تست شما رو به پایان است\n" +
      "\n" +
      "سرویس تست «{service_name}» تا {time_left} دیگر منقضی می‌شود.\n" +
      "برای ادامه، می‌توانید یک اشتراک تهیه کنید.",
    allowedVariables: ["service_name", "time_left"],
  },
  {
    key: "notif_trial_expired",
    title: "اعلان انقضای سرویس تست",
    category: "notification",
    defaultContent:
      "🔴 سرویس تست شما منقضی شد\n" +
      "\n" +
      "سرویس تست «{service_name}» به پایان رسید.\n" +
      "برای ادامه استفاده، یک اشتراک تهیه کنید.",
    allowedVariables: ["service_name"],
  },
  // Checkout-payment reminders phase (Phase 2). Keys duplicated from
  // @zedbot/shared NOTIF_CHECKOUT_TEMPLATE_KEYS. Safe display variables only -
  // never a checkout id, provider authority, receipt content, card data or
  // customer-form values.
  {
    key: "notification_abandoned_checkout",
    title: "اعلان سفارش ناقص",
    category: "notification",
    defaultContent:
      "سفارش شما هنوز تکمیل نشده است 🛒\n" +
      "\n" +
      "محصول:\n" +
      "{product_name}\n" +
      "\n" +
      "مبلغ قابل پرداخت:\n" +
      "{payable_amount}\n" +
      "\n" +
      "در صورت تمایل می‌توانید پرداخت این سفارش را ادامه دهید.",
    allowedVariables: ["checkout_reference", "product_name", "payable_amount", "expires_in"],
  },
  {
    key: "notification_payment_retry",
    title: "اعلان پرداخت ناموفق",
    category: "notification",
    defaultContent:
      "پرداخت سفارش شما تکمیل نشد.\n" +
      "\n" +
      "محصول:\n" +
      "{product_name}\n" +
      "\n" +
      "مبلغ:\n" +
      "{payable_amount}\n" +
      "\n" +
      "می‌توانید دوباره یک روش پرداخت انتخاب کنید.",
    allowedVariables: ["checkout_reference", "product_name", "payable_amount", "payment_method"],
  },
  // Customer win-back (Phase 3, category MARKETING). Only safe display variables:
  // no price, no service username when sensitive, no lifetime spend. Every
  // variable renders safely when missing (the optional last-service line is only
  // shown by the worker when a safe display name exists).
  {
    key: "notification_customer_winback",
    title: "اعلان بازگشت مشتری",
    category: "notification",
    defaultContent:
      "مدتی است سرویس فعالی ندارید 👋\n" +
      "\n" +
      "پلن‌ها و لوکیشن‌های فعال برای خرید در دسترس هستند.\n" +
      "\n" +
      "برای استفاده دوباره می‌توانید پلن‌های موجود را مشاهده کنید.",
    allowedVariables: ["inactive_days", "last_service_name", "last_product_name"],
  },
  // Telegram Stars subscription lifecycle (Phase 2.1, category PAYMENT). Only safe
  // display variables: service name, fixed Stars amount, current period end. No
  // charge id, payload, order id or panel data. Every variable renders safely when
  // missing.
  {
    key: "notification_stars_subscription_activated",
    title: "اعلان فعال‌سازی اشتراک استاری",
    category: "notification",
    defaultContent:
      "اشتراک ماهانه Telegram Stars فعال شد ⭐\n" +
      "\n" +
      "سرویس:\n{service_name}\n" +
      "\n" +
      "مبلغ هر دوره:\n{stars_amount} استار\n" +
      "\n" +
      "پایان دوره فعلی:\n{current_period_end}",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_renewed",
    title: "اعلان تمدید اشتراک استاری",
    category: "notification",
    defaultContent:
      "اشتراک ماهانه با موفقیت تمدید شد ⭐\n" +
      "\n" +
      "سرویس:\n{service_name}\n" +
      "\n" +
      "مبلغ:\n{stars_amount} استار\n" +
      "\n" +
      "پایان دوره جدید:\n{current_period_end}",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_cancelled",
    title: "اعلان لغو اشتراک استاری",
    category: "notification",
    defaultContent:
      "اشتراک ماهانه Telegram Stars لغو شد ⭐\n" +
      "\n" +
      "تمدید خودکار دوره‌های بعدی متوقف شد.\n" +
      "دوره فعلی تا {current_period_end} فعال می‌ماند.",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_past_due",
    title: "اعلان عقب‌افتادگی اشتراک استاری",
    category: "notification",
    defaultContent:
      "پرداخت دوره جدید اشتراک دریافت نشد ⚠️\n" +
      "\n" +
      "تمدید جدیدی روی سرویس اعمال نشده است.\n" +
      "\n" +
      "وضعیت Stars و اشتراک خود را بررسی کنید.",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_requires_action",
    title: "اعلان نیازمند بررسی اشتراک استاری",
    category: "notification",
    defaultContent:
      "اشتراک ماهانه شما نیازمند بررسی است ⚠️\n" +
      "\n" +
      "برای جلوگیری از مشکل در تمدیدهای بعدی، وضعیت اشتراک را بررسی کنید.",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_refunded",
    title: "اعلان بازپرداخت اشتراک استاری",
    category: "notification",
    defaultContent:
      "مبلغ استاری این دوره بازپرداخت شد ✅\n" +
      "\n" +
      "تمدید این دوره انجام نشد و پرداخت دوره‌های بعدی متوقف شده است.",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  {
    key: "notification_stars_subscription_price_version_changed",
    title: "اعلان تغییر شرایط اشتراک استاری",
    category: "notification",
    defaultContent:
      "شرایط اشتراک ماهانه به‌روزرسانی شد ⭐\n" +
      "\n" +
      "اشتراک فعلی شما با همان مبلغ و شرایط قبلی ادامه می‌یابد.\n" +
      "برای استفاده از شرایط جدید می‌توانید اشتراک جدیدی بسازید.",
    allowedVariables: ["service_name", "stars_amount", "current_period_end"],
  },
  // Corrective Phase — durable advance notice before a wallet auto-renewal
  // deduction (category PAYMENT, normally ~24h ahead). Only safe display
  // variables: service/plan display name, the current price, the user's ceiling,
  // the expected charge time and the service expiry. NEVER the wallet balance,
  // full ids, a service username, a panel/order/payment reference or credentials.
  {
    key: "notification_wallet_auto_renewal_upcoming",
    title: "اعلان تمدید خودکار پیش‌رو (کیف پول)",
    category: "notification",
    defaultContent:
      "تمدید خودکار سرویس شما به‌زودی از کیف پول انجام می‌شود ♻️\n" +
      "\n" +
      "سرویس:\n{service_name}\n" +
      "\n" +
      "پلن تمدید:\n{product_name}\n" +
      "\n" +
      "مبلغ قابل کسر از کیف پول:\n{current_price} تومان\n" +
      "(سقف مجاز شما: {maximum_charge} تومان)\n" +
      "\n" +
      "زمان تقریبی کسر:\n{expected_charge_time}\n" +
      "\n" +
      "پایان دوره فعلی سرویس:\n{service_expiry}\n" +
      "\n" +
      "اگر نمی‌خواهید این تمدید انجام شود، می‌توانید تا پیش از زمان کسر، تمدید خودکار را لغو کنید.",
    allowedVariables: [
      "service_name",
      "product_name",
      "current_price",
      "maximum_charge",
      "expected_charge_time",
      "service_expiry",
    ],
  },
  // Device connection guides (feat/device-connection-guides). Pure operator copy;
  // control-flow/validation text stays as code constants. {service_name}/{device}/
  // {app} are safe, non-secret display values — never a subscription URL or config.
  {
    key: "connection_guides_disabled",
    title: "راهنمای اتصال - غیرفعال",
    category: "empty_state",
    defaultContent: "راهنمای اتصال در حال حاضر در دسترس نیست.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_choose_platform",
    title: "راهنمای اتصال - انتخاب دستگاه",
    category: "general",
    defaultContent:
      "آموزش اتصال سرویس 📱\n" +
      "نام سرویس: {service_name}\n" +
      "\n" +
      "دستگاه خود را انتخاب کنید:",
    allowedVariables: ["service_name"],
  },
  {
    key: "connection_guides_choose_app",
    title: "راهنمای اتصال - انتخاب برنامه",
    category: "general",
    defaultContent:
      "آموزش اتصال — {device}\n" +
      "نام سرویس: {service_name}\n" +
      "\n" +
      "برنامه مورد نظر را انتخاب کنید:",
    allowedVariables: ["device", "service_name"],
  },
  {
    key: "connection_guides_app_page_intro",
    title: "راهنمای اتصال - سربرگ برنامه",
    category: "general",
    defaultContent: "آموزش اتصال با {app}\n\nنام سرویس:\n{service_name}",
    allowedVariables: ["app", "service_name"],
  },
  {
    key: "connection_guides_no_apps",
    title: "راهنمای اتصال - بدون برنامه",
    category: "empty_state",
    defaultContent: "هنوز راهنمای اتصالی برای این بخش تنظیم نشده است.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_no_payload",
    title: "راهنمای اتصال - بدون اطلاعات اتصال",
    category: "empty_state",
    defaultContent: "برای این سرویس اطلاعات اتصالی ثبت نشده است.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_stale_app",
    title: "راهنمای اتصال - برنامه نامعتبر",
    category: "empty_state",
    defaultContent: "این برنامه دیگر در دسترس نیست؛ لطفاً یکی دیگر را انتخاب کنید.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_support_handoff",
    title: "راهنمای اتصال - ارجاع به پشتیبانی",
    category: "support",
    defaultContent:
      "اگر هنوز وصل نمی‌شوید، پیام خود را بنویسید تا پشتیبانی بررسی کند.\n" +
      "\n" +
      "سرویس: {service_name}\n" +
      "دستگاه: {device}\n" +
      "برنامه: {app}",
    allowedVariables: ["service_name", "device", "app"],
  },
  {
    key: "connection_guides_service_active",
    title: "راهنمای اتصال - وضعیت فعال",
    category: "general",
    defaultContent: "وضعیت سرویس: فعال ✅ — سرویس شما آماده اتصال است.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_service_disabled",
    title: "راهنمای اتصال - وضعیت غیرفعال",
    category: "general",
    defaultContent: "وضعیت سرویس: غیرفعال ⏸ — ابتدا سرویس را روشن کنید.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_service_expired",
    title: "راهنمای اتصال - وضعیت منقضی",
    category: "general",
    defaultContent: "وضعیت سرویس: منقضی ⌛ — برای اتصال، ابتدا سرویس را تمدید کنید.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_service_limited",
    title: "راهنمای اتصال - اتمام حجم",
    category: "general",
    defaultContent: "وضعیت سرویس: اتمام حجم 📦 — حجم اضافه بخرید یا سرویس را تمدید کنید.",
    allowedVariables: [],
  },
  {
    key: "connection_guides_service_unavailable",
    title: "راهنمای اتصال - غیرقابل استفاده",
    category: "general",
    defaultContent: "این سرویس در حال حاضر قابل استفاده نیست؛ لطفاً با پشتیبانی در تماس باشید.",
    allowedVariables: [],
  },
  // Service self-diagnostics (feat/service-self-diagnostics). Operator-editable
  // wrapper copy only; the per-check lines + machine codes are code constants
  // (behaviour never depends on an editable label). Rendered as escaped plain
  // text and clamped under Telegram's limit.
  {
    key: "service_diagnostics_disabled",
    title: "عیب‌یابی سرویس - غیرفعال",
    category: "diagnostics",
    defaultContent: "بررسی مشکل سرویس در حال حاضر در دسترس نیست.",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_running",
    title: "عیب‌یابی سرویس - در حال بررسی",
    category: "diagnostics",
    defaultContent: "در حال بررسی سرویس... لطفاً چند لحظه صبر کنید ⏳",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_stale",
    title: "عیب‌یابی سرویس - گزارش منقضی",
    category: "diagnostics",
    defaultContent: "این گزارش دیگر معتبر نیست؛ لطفاً دوباره «بررسی مشکل سرویس 🛠» را بزنید.",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_report_intro",
    title: "عیب‌یابی سرویس - سربرگ گزارش",
    category: "diagnostics",
    defaultContent: "بررسی خودکار سرویس 🛠\nنام سرویس: {service_name}",
    allowedVariables: ["service_name"],
  },
  {
    key: "service_diagnostics_healthy",
    title: "عیب‌یابی سرویس - نتیجه سالم",
    category: "diagnostics",
    defaultContent: "نتیجه کلی: سرویس سالم است ✅",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_action_required",
    title: "عیب‌یابی سرویس - نیازمند اقدام",
    category: "diagnostics",
    defaultContent: "نتیجه کلی: برای رفع مشکل نیاز به یک اقدام است 🔧",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_degraded",
    title: "عیب‌یابی سرویس - وضعیت ناقص",
    category: "diagnostics",
    defaultContent: "نتیجه کلی: سرویس فعال است اما نکاتی برای بررسی وجود دارد ⚠️",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_unavailable",
    title: "عیب‌یابی سرویس - عدم دسترسی",
    category: "diagnostics",
    defaultContent:
      "نتیجه کلی: امکان بررسی لحظه‌ای سرویس فراهم نشد ⚠️ لطفاً کمی بعد دوباره تلاش کنید.",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_needs_support",
    title: "عیب‌یابی سرویس - نیازمند پشتیبانی",
    category: "diagnostics",
    defaultContent: "نتیجه کلی: برای بررسی بیشتر لطفاً با پشتیبانی در تماس باشید 🎫",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_live_evidence",
    title: "عیب‌یابی سرویس - بررسی لحظه‌ای",
    category: "diagnostics",
    defaultContent: "اطلاعات بررسی: بررسی لحظه‌ای انجام شد | زمان بررسی: {checked_at}",
    allowedVariables: ["checked_at"],
  },
  {
    key: "service_diagnostics_stored_evidence",
    title: "عیب‌یابی سرویس - اطلاعات ذخیره‌شده",
    category: "diagnostics",
    defaultContent:
      "اطلاعات بررسی: آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود | زمان بررسی: {checked_at}",
    allowedVariables: ["checked_at"],
  },
  {
    key: "service_diagnostics_cooldown",
    title: "عیب‌یابی سرویس - محدودیت زمانی",
    category: "diagnostics",
    defaultContent: "به‌تازگی بررسی انجام شده است. لطفاً {seconds} ثانیه دیگر دوباره تلاش کنید.",
    allowedVariables: ["seconds"],
  },
  {
    key: "service_diagnostics_support_preview",
    title: "عیب‌یابی سرویس - پیش‌نمایش پشتیبانی",
    category: "diagnostics",
    defaultContent:
      "گزارش زیر به‌همراه پیام شما برای پشتیبانی ارسال می‌شود (بدون هیچ اطلاعات محرمانه‌ای):",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_support_prompt",
    title: "عیب‌یابی سرویس - درخواست پیام پشتیبانی",
    category: "diagnostics",
    defaultContent: "لطفاً توضیح مشکل خود را بنویسید تا به‌همراه این گزارش برای پشتیبانی ارسال شود.",
    allowedVariables: [],
  },
  {
    key: "service_diagnostics_limitations",
    title: "عیب‌یابی سرویس - محدودیت‌های بررسی",
    category: "diagnostics",
    defaultContent:
      "این بررسی فقط وضعیت سمت سرور را می‌سنجد و نمی‌تواند تنظیمات گوشی، اینترنت، فیلترینگ یا برنامهٔ شما را بررسی کند.",
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
  // Two-way User/Admin navigation: the final admin main-menu row returns to
  // the user surface. Its inline callback is the existing CB.USER_MENU; in
  // REPLY mode the label routes via the RETURN_TO_USER_MENU action. Editable
  // like every other main-menu label (kept in the admin duplicate-label scope).
  {
    key: "admin_return_user_menu",
    title: "منوی ادمین: بازگشت به منوی کاربر",
    text: "بازگشت به منوی کاربر 👤",
  },
  // Automated notification / retention engine (Phase 1). Keys duplicated from
  // @zedbot/shared NOTIF_BUTTON_KEYS. Rendered by the worker into a notification
  // inline keyboard; the callback data is ntf:<shortId>:<action>, never derived
  // from these labels.
  { key: "notif_btn_open_service", title: "اعلان: مشاهده سرویس", text: "مشاهده سرویس 👁" },
  { key: "notif_btn_renew_service", title: "اعلان: تمدید سرویس", text: "تمدید سرویس ♻️" },
  { key: "notif_btn_buy_extra_volume", title: "اعلان: خرید حجم اضافه", text: "خرید حجم اضافه ➕" },
  { key: "notif_btn_dismiss", title: "اعلان: بستن", text: "بستن ✖️" },
  // Checkout-payment reminders phase (Phase 2). Keys duplicated from
  // @zedbot/shared NOTIF_BUTTON_KEYS. Callback data is ntf:<shortId>:<action>.
  { key: "notif_btn_continue_checkout", title: "اعلان: ادامه پرداخت", text: "ادامه پرداخت 💳" },
  { key: "notif_btn_checkout_details", title: "اعلان: مشاهده جزئیات سفارش", text: "مشاهده جزئیات سفارش 🧾" },
  { key: "notif_btn_stop_checkout_reminders", title: "اعلان: دیگر یادآوری نکن", text: "دیگر یادآوری نکن 🔕" },
  { key: "notif_btn_reselect_payment", title: "اعلان: انتخاب روش پرداخت", text: "انتخاب روش پرداخت 💳" },
  { key: "notif_btn_view_order", title: "اعلان: مشاهده سفارش", text: "مشاهده سفارش 🧾" },
  { key: "notif_btn_stop_payment_reminders", title: "اعلان: عدم یادآوری این سفارش", text: "عدم یادآوری این سفارش 🔕" },
  // Customer win-back (Phase 3). Keys duplicated from @zedbot/shared
  // NOTIF_BUTTON_KEYS. Callback data is ntf:<shortId>:<action>, never the label.
  { key: "notif_btn_winback_view_plans", title: "اعلان: مشاهده پلن‌ها", text: "مشاهده پلن‌ها 🔐" },
  { key: "notif_btn_winback_wallet", title: "اعلان: کیف پول من", text: "کیف پول من 🏦" },
  { key: "notif_btn_winback_snooze", title: "اعلان: توقف موقت یادآوری بازگشت", text: "فعلاً یادآوری نکن" },
  { key: "notif_btn_winback_opt_out", title: "اعلان: عدم دریافت پیشنهادها", text: "عدم دریافت پیشنهادها" },
  // Telegram Stars subscription (Phase 2.1). Callback data ntf:<shortId>:<action>.
  { key: "notif_btn_stars_view_subscription", title: "اعلان: مشاهده اشتراک", text: "مشاهده اشتراک ⭐" },
  { key: "notif_btn_stars_view_service", title: "اعلان: مشاهده سرویس اشتراک", text: "مشاهده سرویس 👁" },
  { key: "notif_btn_stars_reactivate", title: "اعلان: فعال‌سازی مجدد اشتراک", text: "اجازه فعال‌سازی مجدد ⭐" },
  { key: "notif_btn_stars_payment_support", title: "اعلان: پشتیبانی پرداخت", text: "پشتیبانی پرداخت 💳" },
  // Corrective Phase — wallet auto-renewal upcoming notice. Callback data is
  // ntf:<shortId>:<action> (e/k/w); the visible label is never authorization.
  {
    key: "notif_btn_auto_renewal_view_settings",
    title: "اعلان: تنظیمات تمدید خودکار",
    text: "مشاهده تنظیمات تمدید خودکار ⚙️",
  },
  { key: "notif_btn_auto_renewal_cancel", title: "اعلان: لغو تمدید خودکار", text: "غیرفعال کردن تمدید خودکار 🚫" },
  { key: "notif_btn_auto_renewal_wallet", title: "اعلان: کیف پول من", text: "کیف پول من 🏦" },
  // Device connection guides (feat/device-connection-guides). Editable LABELS only;
  // routing is by fixed callback (never the label). Platform labels power the
  // platform-selection keyboard; download/support/back power the guide pages.
  { key: "service_connection_guide", title: "راهنمای اتصال دستگاه", text: "آموزش اتصال 📱" },
  { key: "guide_platform_ios", title: "راهنما: آیفون/آیپد", text: "آیفون / آیپد 🍎" },
  { key: "guide_platform_android", title: "راهنما: اندروید", text: "اندروید 🤖" },
  { key: "guide_platform_windows", title: "راهنما: ویندوز", text: "ویندوز 🪟" },
  { key: "guide_platform_macos", title: "راهنما: مک", text: "مک 🍏" },
  { key: "guide_platform_linux", title: "راهنما: لینوکس", text: "لینوکس 🐧" },
  { key: "guide_platform_android_tv", title: "راهنما: اندروید تی‌وی", text: "اندروید تی‌وی 📺" },
  { key: "guide_download_primary", title: "راهنما: دانلود برنامه", text: "دانلود برنامه ⬇️" },
  { key: "guide_download_alternate", title: "راهنما: دانلود جایگزین", text: "دانلود جایگزین ⬇️" },
  { key: "guide_support", title: "راهنما: پشتیبانی", text: "هنوز وصل نمی‌شود؟ پشتیبانی 🛠" },
  { key: "guide_back_platforms", title: "راهنما: بازگشت به دستگاه‌ها", text: "بازگشت به انتخاب دستگاه" },
  { key: "guide_back_apps", title: "راهنما: بازگشت به برنامه‌ها", text: "بازگشت به برنامه‌ها" },
  // Service self-diagnostics (feat/service-self-diagnostics). Editable LABELS
  // only — callback routing never depends on an editable label.
  { key: "service_diagnostics", title: "عیب‌یابی سرویس", text: "بررسی مشکل سرویس 🛠" },
  { key: "diagnostics_retry", title: "عیب‌یابی: بررسی دوباره", text: "بررسی دوباره 🔄" },
  { key: "diagnostics_send_support", title: "عیب‌یابی: ارسال به پشتیبانی", text: "ارسال گزارش به پشتیبانی 🎫" },
  { key: "diagnostics_open_guide", title: "عیب‌یابی: راهنمای اتصال", text: "آموزش اتصال 📱" },
  { key: "diagnostics_refresh", title: "عیب‌یابی: بروزرسانی سرویس", text: "بروزرسانی اطلاعات ♻️" },
  { key: "diagnostics_back_service", title: "عیب‌یابی: بازگشت به سرویس", text: "بازگشت به سرویس" },
];
