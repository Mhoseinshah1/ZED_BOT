import { optionalEnv } from "@zedbot/shared";

// =============================================================================
// Mini App availability.
//
// One question, asked from three places (the main-menu definition, the entry
// screen, and the `/app` command), so it lives in a service rather than being
// re-derived: is the Mini App actually deployed?
//
// The answer is CONFIGURATION, not a database flag. Telegram rejects a
// `web_app` button whose URL is not https — and rejects the whole keyboard with
// it, so a misconfiguration would turn into a menu that fails to render at all
// rather than a missing button. Validating here means the worst case is one
// absent row.
// =============================================================================

/** The configured public URL, or `null` when the Mini App is not deployed. */
export function miniAppUrl(): string | null {
  const raw = optionalEnv("MINIAPP_PUBLIC_URL", "").trim();
  if (raw === "") {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when the main menu may render a Mini App entry. */
export function isMiniAppAvailable(): boolean {
  return miniAppUrl() !== null;
}
