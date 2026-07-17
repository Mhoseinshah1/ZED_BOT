import { AdminRole, SettingType } from "@prisma/client";

import { connectDatabase, disconnectDatabase, prisma } from "./client.js";
import {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  OPS_LOG_TOPIC_SEEDS,
} from "./seed-data.js";

// =============================================================================
// ZED_BOT seed - idempotent baseline data.
//
// Rules:
//   - Admins from ADMIN_TELEGRAM_IDS are upserted as OWNER (role/isActive are
//     re-asserted on every run so an OWNER can always recover access).
//   - Settings and log topics are create-if-missing only.
//   - Message templates / button texts: created when missing; when the
//     registry default changes, the stored DEFAULT is refreshed so
//     reset-to-default returns the approved copy - but the CURRENT value is
//     only moved along when the operator never customized it (current ===
//     old default). Operator-edited texts are NEVER overwritten.
//   - Product categories and products are intentionally NOT seeded: the
//     operator creates them manually (with their own names) from the admin
//     panel. A fresh install has an empty catalog. Payment gateways and card
//     accounts are likewise not seeded.
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
  // Legacy topics + ops topics (see seed-data.ts): create-if-missing ONLY,
  // so existing rows - including operator edits - are never modified.
  for (const topic of [...INITIAL_LOG_TOPICS, ...OPS_LOG_TOPIC_SEEDS]) {
    const existing = await prisma.logTopic.findUnique({ where: { key: topic.key } });
    if (existing === null) {
      await prisma.logTopic.create({ data: { key: topic.key, title: topic.title } });
      created += 1;
    }
  }
  return created;
}

async function seedMessageTemplates(): Promise<{ created: number; refreshed: number }> {
  let created = 0;
  let refreshed = 0;
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
          allowedVariables: template.allowedVariables,
        },
      });
      created += 1;
      continue;
    }
    const defaultChanged = existing.defaultContent !== template.defaultContent;
    const variablesChanged =
      JSON.stringify(existing.allowedVariables ?? []) !==
      JSON.stringify(template.allowedVariables);
    if (!defaultChanged && !variablesChanged) {
      continue;
    }
    // Refresh the registry-owned fields. The operator's customized CURRENT
    // value is untouched; an uncustomized current (=== old default) moves
    // along with the approved default.
    const uncustomized = existing.currentContent === existing.defaultContent;
    await prisma.messageTemplate.update({
      where: { key: template.key },
      data: {
        title: template.title,
        category: template.category,
        defaultContent: template.defaultContent,
        allowedVariables: template.allowedVariables,
        ...(uncustomized && defaultChanged
          ? { currentContent: template.defaultContent }
          : {}),
      },
    });
    refreshed += 1;
  }
  return { created, refreshed };
}

async function seedButtonTexts(): Promise<{ created: number; refreshed: number }> {
  let created = 0;
  let refreshed = 0;
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
      continue;
    }
    if (existing.defaultText === button.text) {
      continue;
    }
    // Same preserve-customizations rule as message templates.
    const uncustomized = existing.currentText === existing.defaultText;
    await prisma.buttonText.update({
      where: { key: button.key },
      data: {
        title: button.title,
        defaultText: button.text,
        ...(uncustomized ? { currentText: button.text } : {}),
      },
    });
    refreshed += 1;
  }
  return { created, refreshed };
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

async function main(): Promise<void> {
  await connectDatabase();
  const adminCount = await seedAdmins();
  const settingsCreated = await seedSettings();
  const logTopicsCreated = await seedLogTopics();
  const templates = await seedMessageTemplates();
  const buttons = await seedButtonTexts();
  const starsCreated = await seedStarsPricingSetting();
  console.log(
    `[seed] done: ${adminCount} OWNER admin(s) upserted, ` +
      `${settingsCreated}/${INITIAL_SETTINGS.length} setting(s) created, ` +
      `${logTopicsCreated}/${INITIAL_LOG_TOPICS.length + OPS_LOG_TOPIC_SEEDS.length} log topic(s) created, ` +
      `${templates.created} template(s) created + ${templates.refreshed} default(s) refreshed, ` +
      `${buttons.created} button text(s) created + ${buttons.refreshed} default(s) refreshed, ` +
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
