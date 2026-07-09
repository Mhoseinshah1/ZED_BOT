import { prisma, type Admin } from "@zedbot/database";

/** Returns the admin row when the Telegram user is an ACTIVE admin. */
export async function getActiveAdminByTelegramId(telegramId: bigint): Promise<Admin | null> {
  const admin = await prisma.admin.findUnique({ where: { telegramId } });
  if (admin === null || !admin.isActive) {
    return null;
  }
  return admin;
}
