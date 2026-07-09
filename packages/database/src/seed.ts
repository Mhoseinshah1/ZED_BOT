import { AdminRole, SettingType } from "@prisma/client";

import { connectDatabase, disconnectDatabase, prisma } from "./client.js";

// =============================================================================
// ZED_BOT seed - idempotent baseline data.
//
// Rules:
//   - Admins from ADMIN_TELEGRAM_IDS are upserted as OWNER (role/isActive are
//     re-asserted on every run so an OWNER can always recover access).
//   - Everything else is create-if-missing only: operator-edited settings,
//     log topics, and message templates are NEVER overwritten.
// =============================================================================

// Parses the comma-separated ADMIN_TELEGRAM_IDS env var. Kept local so the
// database package (and therefore the migration container) stays free of
// workspace dependencies.
function parseAdminTelegramIds(raw: string | undefined): bigint[] {
  if (raw === undefined) {
    return [];
  }
  const ids: bigint[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      ids.push(BigInt(trimmed));
    }
  }
  return ids;
}

interface SettingSeed {
  key: string;
  value: string;
  type: SettingType;
  isPublic: boolean;
}

const INITIAL_SETTINGS: SettingSeed[] = [
  { key: "bot_name", value: "ZED_BOT", type: SettingType.STRING, isPublic: true },
  { key: "maintenance_mode", value: "false", type: SettingType.BOOLEAN, isPublic: true },
  { key: "support_username", value: "", type: SettingType.STRING, isPublic: true },
  { key: "force_join_enabled", value: "false", type: SettingType.BOOLEAN, isPublic: false },
  { key: "support_mode", value: "PRIVATE_CHAT", type: SettingType.STRING, isPublic: false },
];

// Log-group topics used by later phases for Telegram group reporting. Keys are
// stable identifiers; titles are the operator-facing (Persian) names.
const INITIAL_LOG_TOPICS: Array<{ key: string; title: string }> = [
  { key: "general", title: "General" },
  { key: "notifications_report", title: "گزارش اطلاع‌رسانی‌ها" },
  { key: "purchase_reports", title: "گزارش‌های خرید" },
  { key: "service_purchase_report", title: "گزارش خرید خدمات" },
  { key: "test_account_report", title: "گزارش اکانت تست" },
  { key: "financial_report", title: "گزارش مالی" },
  { key: "commission_reports", title: "گزارش پورسانت‌ها" },
  { key: "nightly_report", title: "گزارش شبانه" },
  { key: "error_report", title: "گزارش خطاها" },
  { key: "other_reports", title: "سایر گزارشات" },
  { key: "tickets", title: "تیکت‌ها" },
  { key: "main_bot_backup", title: "بکاپ اصلی ربات" },
  { key: "representative_bot_backup", title: "بکاپ ربات نماینده" },
];

// Minimal message-template baseline. Final Persian copy is refined in later
// phases; operators can already edit these safely (edits are never clobbered).
const INITIAL_MESSAGE_TEMPLATES: Array<{
  key: string;
  title: string;
  category: string;
  defaultContent: string;
}> = [
  {
    key: "start_text",
    title: "پیام شروع",
    category: "general",
    defaultContent: "به ربات خوش آمدید.",
  },
  {
    key: "bot_off_text",
    title: "پیام خاموشی ربات",
    category: "general",
    defaultContent: "ربات در حال حاضر در دسترس نیست. لطفا بعدا مراجعه کنید.",
  },
  {
    key: "support_text",
    title: "پیام پشتیبانی",
    category: "support",
    defaultContent: "برای ارتباط با پشتیبانی پیام خود را ارسال کنید.",
  },
  {
    key: "faq_text",
    title: "سوالات متداول",
    category: "general",
    defaultContent: "سوالات متداول به زودی تکمیل می‌شود.",
  },
];

async function seedAdmins(): Promise<number> {
  const ids = parseAdminTelegramIds(process.env.ADMIN_TELEGRAM_IDS);
  for (const telegramId of ids) {
    await prisma.admin.upsert({
      where: { telegramId },
      update: { role: AdminRole.OWNER, isActive: true },
      create: { telegramId, role: AdminRole.OWNER, isActive: true },
    });
  }
  return ids.length;
}

async function seedSettings(): Promise<number> {
  let created = 0;
  for (const setting of INITIAL_SETTINGS) {
    const existing = await prisma.setting.findUnique({ where: { key: setting.key } });
    if (existing === null) {
      await prisma.setting.create({ data: setting });
      created += 1;
    }
  }
  return created;
}

async function seedLogTopics(): Promise<number> {
  let created = 0;
  for (const topic of INITIAL_LOG_TOPICS) {
    const existing = await prisma.logTopic.findUnique({ where: { key: topic.key } });
    if (existing === null) {
      await prisma.logTopic.create({ data: { key: topic.key, title: topic.title } });
      created += 1;
    }
  }
  return created;
}

// Baseline main-menu / navigation button texts. Final button set arrives
// with the menu phase; operator edits are never clobbered.
const INITIAL_BUTTON_TEXTS: Array<{ key: string; title: string; text: string }> = [
  { key: "buy_subscription", title: "خرید اشتراک", text: "خرید اشتراک 🔐" },
  { key: "renew_service", title: "تمدید سرویس", text: "تمدید سرویس ♻️" },
  { key: "my_services", title: "سرویس‌های من", text: "سرویس‌های من 🛍" },
  { key: "wallet", title: "کیف پول", text: "کیف پول + شارژ 🏦" },
  { key: "support", title: "پشتیبانی", text: "پشتیبانی ☎️" },
  { key: "tutorials", title: "آموزش", text: "آموزش 📚" },
  { key: "free_test", title: "اشتراک رایگان تست", text: "اشتراک رایگان {تست}" },
  { key: "referral", title: "زیرمجموعه گیری", text: "زیرمجموعه گیری 👥" },
  { key: "other_products", title: "محصولات دیگر", text: "محصولات دیگر 🛍" },
  { key: "pricing", title: "تعرفه اشتراک‌ها", text: "تعرفه اشتراک‌ها 💵" },
  { key: "representative_request", title: "درخواست نمایندگی", text: "درخواست نمایندگی 👨‍💼" },
  { key: "lucky_wheel", title: "گردونه شانس", text: "گردونه شانس 🎲" },
  { key: "back", title: "بازگشت", text: "بازگشت" },
  { key: "main_menu", title: "منوی اصلی", text: "منوی اصلی" },
  { key: "cancel", title: "لغو", text: "لغو ❌" },
  { key: "confirm", title: "تایید", text: "تایید ✅" },
];

async function seedButtonTexts(): Promise<number> {
  let created = 0;
  for (const button of INITIAL_BUTTON_TEXTS) {
    const existing = await prisma.buttonText.findUnique({ where: { key: button.key } });
    if (existing === null) {
      await prisma.buttonText.create({
        data: {
          key: button.key,
          title: button.title,
          defaultText: button.text,
          currentText: button.text,
        },
      });
      created += 1;
    }
  }
  return created;
}

// Ensures the single global Telegram Stars pricing row exists; existing
// values are never touched.
async function seedStarsPricingSetting(): Promise<number> {
  const existing = await prisma.starsPricingSetting.findUnique({
    where: { singletonKey: "default" },
  });
  if (existing !== null) {
    return 0;
  }
  await prisma.starsPricingSetting.create({ data: { singletonKey: "default" } });
  return 1;
}

async function seedMessageTemplates(): Promise<number> {
  let created = 0;
  for (const template of INITIAL_MESSAGE_TEMPLATES) {
    const existing = await prisma.messageTemplate.findUnique({ where: { key: template.key } });
    if (existing === null) {
      await prisma.messageTemplate.create({
        data: {
          key: template.key,
          title: template.title,
          category: template.category,
          defaultContent: template.defaultContent,
          currentContent: template.defaultContent,
          allowedVariables: [],
        },
      });
      created += 1;
    }
  }
  return created;
}

async function main(): Promise<void> {
  await connectDatabase();
  const adminCount = await seedAdmins();
  const settingsCreated = await seedSettings();
  const logTopicsCreated = await seedLogTopics();
  const templatesCreated = await seedMessageTemplates();
  const buttonsCreated = await seedButtonTexts();
  const starsCreated = await seedStarsPricingSetting();
  console.log(
    `[seed] done: ${adminCount} OWNER admin(s) upserted, ` +
      `${settingsCreated}/${INITIAL_SETTINGS.length} setting(s) created, ` +
      `${logTopicsCreated}/${INITIAL_LOG_TOPICS.length} log topic(s) created, ` +
      `${templatesCreated}/${INITIAL_MESSAGE_TEMPLATES.length} message template(s) created, ` +
      `${buttonsCreated}/${INITIAL_BUTTON_TEXTS.length} button text(s) created, ` +
      `${starsCreated} stars pricing row(s) created.`,
  );
  if (adminCount === 0) {
    console.warn(
      "[seed] ADMIN_TELEGRAM_IDS is empty or contains no valid numeric IDs - no admins were seeded.",
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
