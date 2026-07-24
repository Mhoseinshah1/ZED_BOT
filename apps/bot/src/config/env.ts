import { getTelegramBotToken } from "@zedbot/shared";

/**
 * Returns the Telegram bot token or null when unset/conflicting. Delegates to the
 * ONE shared resolver (`resolveTelegramBotTokenFromEnv`) so the bot and worker can
 * never diverge on env precedence: `TELEGRAM_BOT_TOKEN` is canonical, `BOT_TOKEN`
 * is a legacy fallback, an equal duplicate uses the canonical, and a conflicting
 * pair fails closed (null). Never log this value.
 */
export function getBotToken(): string | null {
  return getTelegramBotToken();
}
