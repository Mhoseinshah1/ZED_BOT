import { AdminRole, SettingType } from "@prisma/client";

import { connectDatabase, disconnectDatabase, prisma } from "./client.js";

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
      // Only create missing settings - never clobber values an operator has
      // already changed.
      await prisma.setting.create({ data: setting });
      created += 1;
    }
  }
  return created;
}

async function main(): Promise<void> {
  await connectDatabase();
  const adminCount = await seedAdmins();
  const settingsCreated = await seedSettings();
  console.log(
    `[seed] done: ${adminCount} OWNER admin(s) upserted from ADMIN_TELEGRAM_IDS, ` +
      `${settingsCreated} setting(s) created (${INITIAL_SETTINGS.length} defined).`,
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
