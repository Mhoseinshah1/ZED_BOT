// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { UI } from "../src/i18n";
import { applyTelegramTheme, subscribeToThemeChanges } from "../src/telegram";

// =============================================================================
// Theme lifecycle and logout lifecycle (L01-L12).
//
// Two defects, both of which only show up while the app is RUNNING — which is
// why these render the real component into a real DOM and drive it, rather than
// asserting on shapes.
//
//   THEME. The theme was applied once at startup. A user switching their client
//   between light and dark mid-session got no update at all: Telegram announces
//   it with a `themeChanged` event and does not reload the WebView, so the page
//   kept whatever colours it was born with — dark text on a dark background.
//
//   LOGOUT. Signing out called `signIn()` again. `initData` is still sitting in
//   the WebView, so the app immediately minted a fresh cookie and the user
//   watched their own logout undo itself. L07-L10 count the requests: one
//   logout must produce exactly one logout call and ZERO authentications.
// =============================================================================

interface FakeWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  close?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
}

const LIGHT = { bg_color: "#ffffff", text_color: "#000000" };
const DARK = { bg_color: "#17212b", text_color: "#f5f5f5" };

let listeners: Array<{ event: string; handler: () => void }>;
let removed: Array<{ event: string; handler: () => void }>;
let closed: number;
let requests: string[];

function installTelegram(overrides: Partial<FakeWebApp> = {}): FakeWebApp {
  listeners = [];
  removed = [];
  closed = 0;
  const app: FakeWebApp = {
    initData: "auth_date=1&user=%7B%22id%22%3A7%7D&hash=deadbeef",
    colorScheme: "light",
    themeParams: { ...LIGHT },
    ready: () => {},
    expand: () => {},
    close: () => {
      closed += 1;
    },
    onEvent: (event, handler) => listeners.push({ event, handler }),
    offEvent: (event, handler) => removed.push({ event, handler }),
    ...overrides,
  };
  (window as unknown as { Telegram?: unknown }).Telegram = { WebApp: app };
  return app;
}

/** Fires Telegram's `themeChanged` to every subscriber, as the host would. */
function emitThemeChanged(): void {
  for (const l of listeners) {
    if (l.event === "themeChanged") {
      l.handler();
    }
  }
}

const USER = {
  firstName: "Ali",
  lastName: null,
  username: "ali",
  status: "ACTIVE",
  group: "F",
  balanceToman: 0,
  joinedAt: "2026-01-01T00:00:00.000Z",
};

/** Records every request path and answers each endpoint with its real shape. */
function installFetch(): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      const body = url.endsWith("/auth")
        ? { ok: true, user: USER }
        : url.endsWith("/dashboard")
          ? {
              ok: true,
              user: USER,
              services: { total: 0, byStatus: {}, expiringWithin7Days: 0, recent: [] },
              wallet: { balanceToman: 0, recentTransactions: [] },
            }
          : { ok: true };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

function themeVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

// --- theme -------------------------------------------------------------------

describe("theme lifecycle", () => {
  it("L01 applies the host theme at startup", () => {
    installTelegram();
    applyTelegramTheme();
    expect(themeVar("--tg-bg")).toBe("#ffffff");
    expect(themeVar("--tg-text")).toBe("#000000");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("L02 reapplies on a live light → dark change", () => {
    const app = installTelegram();
    applyTelegramTheme();
    const unsubscribe = subscribeToThemeChanges();

    app.themeParams = { ...DARK };
    app.colorScheme = "dark";
    emitThemeChanged();

    expect(themeVar("--tg-bg")).toBe("#17212b");
    expect(themeVar("--tg-text")).toBe("#f5f5f5");
    expect(document.documentElement.dataset.theme).toBe("dark");
    unsubscribe();
  });

  it("L03 reapplies on a live dark → light change too", () => {
    const app = installTelegram({ colorScheme: "dark", themeParams: { ...DARK } });
    applyTelegramTheme();
    const unsubscribe = subscribeToThemeChanges();
    expect(document.documentElement.dataset.theme).toBe("dark");

    app.themeParams = { ...LIGHT };
    app.colorScheme = "light";
    emitThemeChanged();

    expect(themeVar("--tg-bg")).toBe("#ffffff");
    expect(document.documentElement.dataset.theme).toBe("light");
    unsubscribe();
  });

  it("L04 detaches the listener on cleanup and stops touching the DOM", () => {
    const app = installTelegram();
    const unsubscribe = subscribeToThemeChanges();
    expect(listeners).toHaveLength(1);

    unsubscribe();
    expect(removed).toHaveLength(1);
    expect(removed[0].handler).toBe(listeners[0].handler);

    // Even if the host keeps calling it (a bridge with no `offEvent`), the
    // detached handler must not write anything.
    app.themeParams = { ...DARK };
    app.colorScheme = "dark";
    emitThemeChanged();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("L05 stays inert when the host offers no event bridge", () => {
    installTelegram({ onEvent: undefined, offEvent: undefined });
    // No throw, and a no-op unsubscribe.
    expect(() => subscribeToThemeChanges()()).not.toThrow();
  });

  it("L06 still refuses a malformed colour on a later change", () => {
    const app = installTelegram();
    applyTelegramTheme();
    const unsubscribe = subscribeToThemeChanges();

    app.themeParams = { bg_color: "url(javascript:alert(1))", text_color: "#111111" };
    emitThemeChanged();

    // The bad value is discarded, not written; the good one still lands.
    expect(themeVar("--tg-bg")).toBe("#ffffff");
    expect(themeVar("--tg-text")).toBe("#111111");
    unsubscribe();
  });

  it("L07 subscribes once the app mounts", async () => {
    installTelegram();
    installFetch();
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(listeners.filter((l) => l.event === "themeChanged")).toHaveLength(1);
  });
});

// --- logout ------------------------------------------------------------------

async function mountAndSignIn(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  expect(requests.filter((u) => u.endsWith("/auth"))).toHaveLength(1);
}

async function openProfileAndLogOut(): Promise<void> {
  const profileTab = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === UI.navProfile,
  );
  expect(profileTab).toBeDefined();
  await act(async () => {
    profileTab?.click();
  });
  const logoutButton = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === UI.logout,
  );
  expect(logoutButton).toBeDefined();
  await act(async () => {
    logoutButton?.click();
  });
}

describe("logout lifecycle", () => {
  it("L08 one logout produces one logout request and zero re-authentications", async () => {
    installTelegram();
    installFetch();
    await mountAndSignIn();
    await openProfileAndLogOut();

    // Let any stray promise chain settle before counting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(requests.filter((u) => u.endsWith("/logout"))).toHaveLength(1);
    // The whole defect in one assertion: still exactly the ONE sign-in from
    // mount. Nothing authenticated again on its own.
    expect(requests.filter((u) => u.endsWith("/auth"))).toHaveLength(1);
  });

  it("L09 closes the Mini App through the host bridge when it can", async () => {
    installTelegram();
    installFetch();
    await mountAndSignIn();
    await openProfileAndLogOut();
    expect(closed).toBe(1);
  });

  it("L10 falls back to a signed-out screen when the host has no close", async () => {
    installTelegram({ close: undefined });
    installFetch();
    await mountAndSignIn();
    await openProfileAndLogOut();

    expect(container.textContent).toContain(UI.signedOutTitle);
    expect(container.textContent).toContain(UI.signInAgain);
    // Still no automatic authentication behind that screen.
    expect(requests.filter((u) => u.endsWith("/auth"))).toHaveLength(1);
  });

  it("L11 signs in again ONLY on the explicit action", async () => {
    installTelegram({ close: undefined });
    installFetch();
    await mountAndSignIn();
    await openProfileAndLogOut();
    expect(requests.filter((u) => u.endsWith("/auth"))).toHaveLength(1);

    const again = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === UI.signInAgain,
    );
    expect(again).toBeDefined();
    await act(async () => {
      again?.click();
    });
    // Now — and only now — a second authentication happened.
    expect(requests.filter((u) => u.endsWith("/auth"))).toHaveLength(2);
    expect(container.textContent).not.toContain(UI.signedOutTitle);
  });

  it("L12 stores nothing on the way out", async () => {
    installTelegram({ close: undefined });
    installFetch();
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localSet, getItem: () => null });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet, getItem: () => null });
    await mountAndSignIn();
    await openProfileAndLogOut();
    // The signed-out state is component state, never a persisted flag: a stored
    // "logged out" marker would be one more thing that could disagree with the
    // cookie the server actually controls.
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });
});
