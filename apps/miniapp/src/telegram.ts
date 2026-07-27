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
// The SDK is loaded from telegram.org by `index.html` rather than bundled. The
// native mobile clients inject `window.Telegram` themselves, but Telegram
// Desktop and Telegram Web run a Mini App in an IFRAME where nothing is
// injected and the script is the only thing that defines it - so bundling a
// copy would mean shipping a stale snapshot of a host bridge whose contract
// Telegram controls. Every accessor below therefore treats the object as
// possibly absent.
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
  offEvent?: (event: string, handler: () => void) => void;
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
 * Keeps the page in step with the host theme for as long as it is open.
 *
 * Applying the theme once at startup is not enough: the user can switch their
 * client between light and dark while the Mini App is open, and Telegram
 * announces that with a `themeChanged` event rather than reloading the WebView.
 * Without this subscription the page keeps the colours it was born with — dark
 * text on a dark background, or the reverse.
 *
 * The same validated writer runs on every event, so a host that sends nonsense
 * on a later theme change is refused exactly as it is at startup.
 *
 * Returns an unsubscribe function. `offEvent` is optional in the bridge (older
 * hosts expose only `onEvent`), so the returned function also flips a local
 * flag: even where the listener cannot be detached, it stops touching the DOM
 * after cleanup. React's StrictMode mounts effects twice in development, which
 * is exactly the case a listener that can never be removed would leak on.
 */
export function subscribeToThemeChanges(apply: () => void = applyTelegramTheme): () => void {
  const app = webApp();
  if (app?.onEvent === undefined) {
    return () => {};
  }
  let active = true;
  const handler = (): void => {
    if (active) {
      apply();
    }
  };
  app.onEvent("themeChanged", handler);
  return () => {
    active = false;
    app.offEvent?.("themeChanged", handler);
  };
}

/**
 * Closes the Mini App through the host bridge.
 *
 * Used after signing out: the session is gone, and the honest thing to show is
 * nothing at all rather than a shell that would immediately authenticate again.
 * Returns false when the host provides no `close`, so the caller can fall back
 * to an explicit signed-out screen instead of appearing to do nothing.
 */
export function closeMiniApp(): boolean {
  const app = webApp();
  if (app?.close === undefined) {
    return false;
  }
  app.close();
  return true;
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
