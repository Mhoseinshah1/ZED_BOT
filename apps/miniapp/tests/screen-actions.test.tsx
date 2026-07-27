// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DashboardScreen,
  ProfileScreen,
  ServiceDetailScreen,
  ServicesScreen,
  WalletScreen,
} from "../src/screens";
import { UI } from "../src/i18n";
import type { UserDto } from "../src/api";

// =============================================================================
// G1 — the way back into the bot has to be on the screen that needs it.
//
// The component existed and all four actions worked; they were simply not
// MOUNTED anywhere except the dashboard and (partly) the service list. So a
// user reading "this service expires in 2 days" on the detail screen, or a
// short balance on the wallet screen, was told the flow lives in the bot and
// given nothing to tap — they had to guess that navigating back to the
// dashboard would surface it.
//
// That is exactly the class of defect a catalogue test cannot see: every
// action existed, every label was right, every link was well-formed. The
// missing thing was PLACEMENT. So these tests mount the real screens against
// real responses and assert on rendered labels, not on source text.
//
// Two properties are asserted everywhere, because they are what these buttons
// must never do: reach a write-capable endpoint (there is none, and this is the
// one surface that would plausibly grow one), and produce a link to anywhere
// but the configured bot.
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
let calls: Array<{ url: string; method: string }> = [];

const USER: UserDto = {
  firstName: "زد",
  lastName: null,
  username: "zed",
  status: "ACTIVE",
  group: "NORMAL",
  balanceToman: 12_000,
  joinedAt: "2026-01-01T00:00:00.000Z",
};

const SERVICE = {
  id: "a1b2c3d4",
  username: "user_a1b2",
  status: "ACTIVE",
  productName: "پلن یک‌ماهه",
  panelName: "پنل ۱",
  location: "IR",
  volumeBytes: "107374182400",
  usedBytes: "10737418240",
  remainingBytes: "96636764160",
  durationDays: 30,
  remainingDays: 2,
  startsAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2026-07-29T00:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  lastSyncedAt: "2026-07-27T00:00:00.000Z",
  userNote: null,
  source: "PURCHASE",
  firstConnectedAt: null,
  lastConnectedAt: null,
  lastSubscriptionUpdateAt: null,
};

/** Routes each read endpoint to a valid body so screens reach their loaded state. */
function route(url: string): unknown {
  if (url.includes("/wallet/transactions")) {
    return {
      ok: true,
      balanceToman: 12_000,
      items: [
        {
          amountToman: -50_000,
          type: "PURCHASE",
          source: "WALLET",
          balanceAfterToman: 12_000,
          createdAt: "2026-07-20T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
  }
  if (/\/services\/[^/?]+$/.test(url)) {
    return { ok: true, service: SERVICE };
  }
  if (url.includes("/services")) {
    return { ok: true, items: [SERVICE], nextCursor: null };
  }
  if (url.includes("/dashboard")) {
    return {
      ok: true,
      serverTimestamp: "2026-07-27T00:00:00.000Z",
      dataFreshnessTimestamp: "2026-07-27T00:00:00.000Z",
      user: USER,
      services: { total: 1, byStatus: { ACTIVE: 1 }, expiringWithin7Days: 1, recent: [SERVICE] },
      wallet: { balanceToman: 12_000, recentTransactions: [] },
    };
  }
  if (url.includes("/me")) {
    return { ok: true, user: USER, services: { active: 1, total: 1 } };
  }
  return { ok: true };
}

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
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const app: FakeWebApp = {
    initData: "user=%7B%22id%22%3A1%7D&hash=abc",
    colorScheme: "light",
    themeParams: {},
    ready: () => {},
    expand: () => {},
    openTelegramLink: (url: string) => opened.push(url),
  };
  (window as unknown as { Telegram?: { WebApp: FakeWebApp } }).Telegram = { WebApp: app };

  setBotUsername("zedbot_public");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return Promise.resolve(
      new Response(JSON.stringify(route(url)), {
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

/** Mounts a screen and lets its load settle, so assertions see the LOADED state. */
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonLabels(): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

/** Only the bot-return buttons, identified by their labels from the i18n catalogue. */
function botButtons(): HTMLButtonElement[] {
  // Explicitly `Set<string>`: the `UI` entries are string LITERAL types, so an
  // inferred set would only accept those four exact strings and `.has()` on an
  // arbitrary `textContent` would not typecheck.
  const labels = new Set<string>([
    UI.botActionBuy,
    UI.botActionCharge,
    UI.botActionRenew,
    UI.botActionSupport,
  ]);
  return [...container.querySelectorAll("button")].filter((b) =>
    labels.has(b.textContent ?? ""),
  ) as HTMLButtonElement[];
}

function botLabels(): string[] {
  return botButtons().map((b) => b.textContent ?? "");
}

describe("bot-return actions are on the screens that need them", () => {
  // G1-1 --------------------------------------------------------------------
  it("G1-1: the service detail offers renew and support once loaded", async () => {
    await mount(<ServiceDetailScreen serviceId="a1b2c3d4" />);

    // The screen really did load — otherwise absent buttons would prove nothing.
    expect(container.textContent).toContain(SERVICE.username);
    expect(container.textContent).toContain(UI.readOnlyNotice);

    expect(botLabels()).toEqual([UI.botActionRenew, UI.botActionSupport]);
    // Not a place to sell another service or top up a wallet.
    expect(buttonLabels()).not.toContain(UI.botActionBuy);
    expect(buttonLabels()).not.toContain(UI.botActionCharge);
  });

  // G1-2 --------------------------------------------------------------------
  it("G1-2: the wallet offers charge and support once loaded", async () => {
    await mount(<WalletScreen />);

    expect(container.textContent).toContain(UI.readOnlyNotice);
    expect(botLabels()).toEqual([UI.botActionCharge, UI.botActionSupport]);
    expect(buttonLabels()).not.toContain(UI.botActionBuy);
    expect(buttonLabels()).not.toContain(UI.botActionRenew);
  });

  // G1-3 --------------------------------------------------------------------
  it("G1-3: the profile offers support", async () => {
    await mount(<ProfileScreen user={USER} onSignedOut={() => {}} />);

    expect(container.textContent).toContain(UI.readOnlyNotice);
    expect(botLabels()).toEqual([UI.botActionSupport]);
    // Sign-out is still its own button and is NOT a bot action.
    expect(buttonLabels()).toContain(UI.logout);
  });

  // G1-4 --------------------------------------------------------------------
  it("G1-4: the services list still offers exactly buy and renew", async () => {
    await mount(<ServicesScreen onOpenService={() => {}} />);
    expect(botLabels()).toEqual([UI.botActionBuy, UI.botActionRenew]);
  });

  // G1-5 --------------------------------------------------------------------
  it("G1-5: the dashboard still offers all four", async () => {
    await mount(<DashboardScreen onOpenService={() => {}} />);
    expect(botLabels()).toEqual([
      UI.botActionBuy,
      UI.botActionCharge,
      UI.botActionRenew,
      UI.botActionSupport,
    ]);
  });

  // G1-6 --------------------------------------------------------------------
  it("G1-6: every screen-level action opens the configured bot and nothing else", async () => {
    const screens: Array<[string, React.ReactNode]> = [
      ["detail", <ServiceDetailScreen key="d" serviceId="a1b2c3d4" />],
      ["wallet", <WalletScreen key="w" />],
      ["profile", <ProfileScreen key="p" user={USER} onSignedOut={() => {}} />],
      ["services", <ServicesScreen key="s" onOpenService={() => {}} />],
      ["dashboard", <DashboardScreen key="b" onOpenService={() => {}} />],
    ];

    for (const [name, node] of screens) {
      opened = [];
      await mount(node);
      const buttons = botButtons();
      expect(buttons.length, `${name} has no bot actions`).toBeGreaterThan(0);
      for (const button of buttons) {
        act(() => button.click());
      }
      expect(opened, name).toHaveLength(buttons.length);
      for (const url of opened) {
        expect(url, name).toBe("https://t.me/zedbot_public");
        const parsed = new URL(url);
        expect(parsed.host, name).toBe("t.me");
        // `?start=` is referral attribution; an invented value would be
        // recorded as a referral code.
        expect(parsed.search, name).toBe("");
      }
    }
  });

  // G1-7 --------------------------------------------------------------------
  it("G1-7: clicking them issues no request beyond the screen's own read", async () => {
    await mount(<ServiceDetailScreen serviceId="a1b2c3d4" />);
    const afterLoad = calls.length;
    // The screen legitimately read its own data...
    expect(afterLoad).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    for (const button of botButtons()) {
      act(() => button.click());
    }
    // ...and clicking a bot action adds nothing at all.
    expect(calls).toHaveLength(afterLoad);
  });

  // G1-8 --------------------------------------------------------------------
  it("G1-8: no screen ever issues a write request", async () => {
    const screens: React.ReactNode[] = [
      <ServiceDetailScreen key="d" serviceId="a1b2c3d4" />,
      <WalletScreen key="w" />,
      <ServicesScreen key="s" onOpenService={() => {}} />,
      <DashboardScreen key="b" onOpenService={() => {}} />,
    ];
    for (const node of screens) {
      await mount(node);
      for (const button of botButtons()) {
        act(() => button.click());
      }
    }
    // The profile is excluded from the loop on purpose: its sign-out button is
    // the app's ONE legitimate POST, and it is not a bot action.
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([]);
  });

  // G1-9 --------------------------------------------------------------------
  it("G1-9: an unconfigured or malformed handle explains itself on every screen", async () => {
    for (const bad of [undefined, "", "   ", "ab", "has spaces", "bot/../evil"]) {
      setBotUsername(bad);
      for (const node of [
        <ServiceDetailScreen key="d" serviceId="a1b2c3d4" />,
        <WalletScreen key="w" />,
        <ProfileScreen key="p" user={USER} onSignedOut={() => {}} />,
      ]) {
        await mount(node);
        const label = String(bad);
        // A dead button reads as a broken app; an explanation reads as an
        // unconfigured one, which is what it is.
        expect(botLabels(), label).toEqual([]);
        expect(container.textContent, label).toContain(UI.botActionsUnavailable);
        expect(container.querySelectorAll("a"), label).toHaveLength(0);
      }
    }
  });

  // G1-10 -------------------------------------------------------------------
  it("G1-10: loading and failure states carry no bot actions of their own", async () => {
    // Never-resolving fetch: the screen stays in its loading state.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    await mount(<ServiceDetailScreen serviceId="a1b2c3d4" />);
    expect(botLabels()).toEqual([]);

    // A failure renders the shared FailureScreen, which owns its own
    // bot-handoff behaviour for gates that can only be cleared in the bot.
    // These screens must not staple a second set of actions onto it.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, code: "INTERNAL" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await mount(<ServiceDetailScreen serviceId="a1b2c3d4" />);
    expect(botLabels()).toEqual([]);
  });
});
