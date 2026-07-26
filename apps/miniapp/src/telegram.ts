// =============================================================================
// The Telegram WebApp bridge.
//
// Exactly ONE value crosses from Telegram into anything that matters: the raw
// `initData` string. It is opaque here and stays opaque - it is forwarded to
// the server once, and the server's HMAC over the bot token is what decides who
// the caller is.
//
// `initDataUnsafe` is read for NOTHING that affects a decision. Telegram named
// it honestly: it is ordinary page state, and anyone with a devtools console
// can set `id` to someone else's. It is not read here at all, so there is no
// path by which it could become an identity by accident. Names shown in the UI
// come from the authenticated `/me` response, which the server built from the
// database row.
//
// The SDK is not bundled. Telegram injects `window.Telegram.WebApp` into every
// Mini App WebView, and pulling in a script from telegram.org would mean a
// third-party origin in the CSP for an object that is already there.
// =============================================================================

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
}

interface TelegramWebApp {
  initData?: string;
  colorScheme?: "light" | "dark";
  themeParams?: TelegramThemeParams;
  ready?: () => void;
  expand?: () => void;
  openTelegramLink?: (url: string) => void;
  close?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function webApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** True when running inside a real Telegram WebView. */
export function isTelegramEnvironment(): boolean {
  const app = webApp();
  return app !== null && typeof app.initData === "string" && app.initData.length > 0;
}

/**
 * The raw signed payload.
 *
 * Returned verbatim - not parsed, not trimmed, not re-encoded. Every one of
 * those would change the bytes Telegram signed and turn a valid payload into a
 * rejected one.
 */
export function rawInitData(): string {
  return webApp()?.initData ?? "";
}

/** Tells Telegram the app has painted, and asks for the full viewport height. */
export function signalReady(): void {
  const app = webApp();
  app?.ready?.();
  app?.expand?.();
}

export function colorScheme(): "light" | "dark" {
  return webApp()?.colorScheme === "dark" ? "dark" : "light";
}

/**
 * Applies Telegram's theme to CSS custom properties.
 *
 * Only colour strings are copied, and only into custom properties consumed by
 * the stylesheet - never into `innerHTML` or a `style` attribute built by
 * concatenation. Theme params arrive from the host and are treated as
 * untrusted like anything else that crosses the boundary.
 */
export function applyTelegramTheme(): void {
  const params = webApp()?.themeParams;
  if (params === undefined) {
    return;
  }
  const root = document.documentElement;
  const mapping: Array<[keyof TelegramThemeParams, string]> = [
    ["bg_color", "--tg-bg"],
    ["text_color", "--tg-text"],
    ["hint_color", "--tg-hint"],
    ["link_color", "--tg-link"],
    ["button_color", "--tg-button"],
    ["button_text_color", "--tg-button-text"],
    ["secondary_bg_color", "--tg-secondary-bg"],
  ];
  for (const [key, property] of mapping) {
    const value = params[key];
    // A strict colour shape: anything else is discarded rather than written.
    if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)) {
      root.style.setProperty(property, value);
    }
  }
  root.dataset.theme = colorScheme();
}

/**
 * Opens a t.me link in Telegram itself.
 *
 * Used for the gates the Mini App cannot clear - accepting terms and joining a
 * mandatory channel both require the bot. Falls back to a normal navigation
 * outside Telegram so the link is never a dead button.
 */
export function openInTelegram(url: string): void {
  const app = webApp();
  if (app?.openTelegramLink !== undefined) {
    app.openTelegramLink(url);
    return;
  }
  window.location.href = url;
}
