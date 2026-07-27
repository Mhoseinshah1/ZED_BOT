// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotActions, botLink } from "../src/components";
import { UI } from "../src/i18n";

// =============================================================================
// E4 — the way back into the bot.
//
// The Mini App is READ-ONLY, which without these buttons makes it a dead end:
// a user looks at an expiring service and has nowhere to go. Buying, charging
// a wallet, renewing and opening a support ticket all have real business logic
// behind them — pricing, stock, gates, notifications, an audit trail — and all
// of it lives in the bot. So each action does exactly one thing: OPEN THE BOT.
//
// The two properties worth proving are what these buttons must NEVER do:
// call a write-capable API (there is none, and adding one is the failure mode
// this guards), and produce a link to anywhere but the configured bot.
// =============================================================================

interface FakeWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  openTelegramLink?: (url: string) => void;
}

let container: HTMLDivElement;
let root: Root;
let opened: string[] = [];
let fetchCalls: Array<{ url: string; method: string }> = [];

function installTelegram(overrides: Partial<FakeWebApp> = {}): void {
  const app: FakeWebApp = {
    initData: "user=%7B%22id%22%3A1%7D&hash=abc",
    colorScheme: "light",
    themeParams: {},
    ready: () => {},
    expand: () => {},
    openTelegramLink: (url: string) => opened.push(url),
    ...overrides,
  };
  (window as unknown as { Telegram?: { WebApp: FakeWebApp } }).Telegram = { WebApp: app };
}

/** Sets the ONE build-time value this app reads, for the duration of a test. */
function setBotUsername(value: string | undefined): void {
  const env = import.meta.env as unknown as Record<string, unknown>;
  if (value === undefined) {
    delete env.VITE_BOT_USERNAME;
  } else {
    env.VITE_BOT_USERNAME = value;
  }
}

const originalUsername = (import.meta.env as unknown as Record<string, unknown>)
  .VITE_BOT_USERNAME as string | undefined;

beforeEach(() => {
  opened = [];
  fetchCalls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  installTelegram();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? "GET" });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setBotUsername(originalUsername);
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

describe("bot-return actions", () => {
  // E4-1 -----------------------------------------------------------------
  it("E4-1: all four flows are offered, and each is a distinct labelled action", () => {
    setBotUsername("zedbot_public");
    render(<BotActions />);

    const labels = buttons().map((b) => b.textContent);
    expect(labels).toEqual([
      UI.botActionBuy,
      UI.botActionCharge,
      UI.botActionRenew,
      UI.botActionSupport,
    ]);
    expect(new Set(labels).size).toBe(4);
  });

  // E4-2 -----------------------------------------------------------------
  it("E4-2: a screen may offer only the actions that make sense there", () => {
    setBotUsername("zedbot_public");
    render(<BotActions actions={["charge", "support"]} />);
    expect(buttons().map((b) => b.textContent)).toEqual([
      UI.botActionCharge,
      UI.botActionSupport,
    ]);
  });

  // E4-3 -----------------------------------------------------------------
  it("E4-3: every action opens the bot and NOTHING else — no API call at all", () => {
    setBotUsername("zedbot_public");
    render(<BotActions />);

    for (const button of buttons()) {
      act(() => button.click());
    }

    expect(opened).toHaveLength(4);
    // The failure mode this guards: an action that "helpfully" performs the
    // operation. There is no write-capable Mini App API, and these must never
    // be the reason one gets added.
    expect(fetchCalls).toHaveLength(0);
  });

  // E4-4 -----------------------------------------------------------------
  it("E4-4: the opened URL is an allowlisted Telegram bot link, nothing else", () => {
    setBotUsername("zedbot_public");
    render(<BotActions />);
    for (const button of buttons()) {
      act(() => button.click());
    }

    for (const url of opened) {
      expect(url).toBe("https://t.me/zedbot_public");
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.host).toBe("t.me");
      // No query string at all. `?start=` is consumed by REFERRAL attribution,
      // so a made-up value would be read as a referral code — a quiet lie in
      // someone else's data to save a user one tap.
      expect(parsed.search).toBe("");
    }
  });

  // E4-5 -----------------------------------------------------------------
  it("E4-5: it opens THROUGH Telegram's bridge, not by navigating the WebView away", () => {
    setBotUsername("zedbot_public");
    render(<BotActions actions={["buy"]} />);
    act(() => buttons()[0].click());
    // `openTelegramLink` keeps the Mini App alive behind the chat; a raw
    // `location.href` would tear it down.
    expect(opened).toEqual(["https://t.me/zedbot_public"]);
  });

  // E4-6 -----------------------------------------------------------------
  it("E4-6: with no configured username there is NO button — an explanation instead", () => {
    setBotUsername(undefined);
    render(<BotActions />);

    expect(botLink()).toBeNull();
    // A dead button is worse than no button: it looks like the app is broken.
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain(UI.botActionsUnavailable);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  // E4-7 -----------------------------------------------------------------
  it("E4-7: a malformed username is treated as absent, never rendered into a link", () => {
    for (const bad of ["", "   ", "ab", "has spaces", "بات", "a".repeat(33), "bot/../evil"]) {
      setBotUsername(bad);
      expect(botLink(), bad).toBeNull();
      render(<BotActions />);
      expect(buttons(), bad).toHaveLength(0);
      expect(container.textContent, bad).toContain(UI.botActionsUnavailable);
    }
  });

  // E4-8 -----------------------------------------------------------------
  it("E4-8: a leading @ is accepted and normalised, since that is how people write it", () => {
    setBotUsername("@zedbot_public");
    expect(botLink()).toBe("https://t.me/zedbot_public");
    render(<BotActions actions={["support"]} />);
    act(() => buttons()[0].click());
    expect(opened).toEqual(["https://t.me/zedbot_public"]);
  });

  // E4-9 -----------------------------------------------------------------
  it("E4-9: no production bot username is hard-coded anywhere in the app", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // `import.meta.url` is an http URL under jsdom, so the source tree is
    // located from the runner's working directory (this package's root).
    const srcDir = join(process.cwd(), "src");
    const names = await readdir(srcDir, { recursive: true });
    let checked = 0;
    for (const name of names) {
      if (!/\.(ts|tsx)$/.test(String(name))) {
        continue;
      }
      const text = await readFile(join(srcDir, String(name)), "utf8");
      checked += 1;
      // The only t.me link the bundle may contain is the one BUILT from the
      // configured handle.
      const literals = text.match(/https:\/\/t\.me\/[A-Za-z0-9_]+/g) ?? [];
      expect(literals, String(name)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });

  // E4-10 ----------------------------------------------------------------
  it("E4-10: outside Telegram the link still resolves rather than dying silently", () => {
    setBotUsername("zedbot_public");
    // No `openTelegramLink` on the host bridge — the desktop-browser case.
    installTelegram({ openTelegramLink: undefined });
    const assigned: string[] = [];
    const location = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...location,
        set href(value: string) {
          assigned.push(value);
        },
        get href() {
          return "http://localhost/";
        },
      },
    });
    try {
      render(<BotActions actions={["buy"]} />);
      act(() => buttons()[0].click());
      expect(assigned).toEqual(["https://t.me/zedbot_public"]);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: location });
    }
  });
});
