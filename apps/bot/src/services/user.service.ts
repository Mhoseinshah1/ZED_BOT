import { prisma, type User } from "@zedbot/database";

/** The subset of Telegram's User object the bot persists. */
export interface TelegramUserLike {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

/**
 * Registers a new user or refreshes the profile of an existing one.
 * referralCode defaults to the telegramId as a string.
 */
export async function registerOrUpdateUser(from: TelegramUserLike): Promise<User> {
  const telegramId = BigInt(from.id);
  const profile = {
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    languageCode: from.language_code ?? null,
    isBot: from.is_bot,
    lastSeenAt: new Date(),
  };
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: profile,
    create: {
      telegramId,
      ...profile,
      referralCode: String(from.id),
    },
  });
  // Older rows (or collisions during create) may lack a referral code.
  if (user.referralCode === null) {
    return prisma.user.update({
      where: { id: user.id },
      data: { referralCode: String(from.id) },
    });
  }
  return user;
}

export async function getUserByTelegramId(telegramId: bigint): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

/** Marks the user as seen; failures are the caller's concern (fire-and-forget). */
export async function touchLastSeen(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}
