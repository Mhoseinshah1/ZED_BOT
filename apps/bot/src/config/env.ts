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

/**
 * Optional grammY Bot API endpoint. This is primarily useful for bounded,
 * network-local integration fixtures and self-hosted Telegram Bot API servers.
 * The value is trusted configuration, but still fail-closed: credentials,
 * fragments, queries, non-HTTP protocols, and non-root paths are rejected.
 */
export function getTelegramApiRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.TELEGRAM_API_ROOT?.trim();
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TELEGRAM_API_ROOT is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("TELEGRAM_API_ROOT is invalid");
  }
  return url.origin;
}
