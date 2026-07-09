import { optionalEnv } from "@zedbot/shared";

/** Returns the bot token or null when unset. Never log this value. */
export function getBotToken(): string | null {
  const token = optionalEnv("TELEGRAM_BOT_TOKEN");
  return token === "" ? null : token;
}
