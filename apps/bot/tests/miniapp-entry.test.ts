import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "@zedbot/database";
import { afterAll, afterEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "miniapp-entry-tests-secret-0123456789";

import { CB } from "../src/core/callbacks.js";
import {
  miniAppUrl,
  MINIAPP_BUTTON_TEXT,
  MINIAPP_UNAVAILABLE_TEXT,
} from "../src/handlers/miniapp.handler.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import {
  buildUserMainMenuDefinition,
  buildUserMainReplyKeyboard,
  MAIN_MENU_ACTION_WIRING,
  resolveMainMenuAction,
} from "../src/keyboards/user-menu-definition.js";
import { clearTextCache, getButtonText } from "../src/services/text.service.js";

// =============================================================================
// The bot's Mini App entry point (B01-B10).
//
// Two things are under test, and the second one is why B06 was rewritten.
//
// GATING (B01-B03). Configuration, not a database flag: Telegram refuses a
// `web_app` button whose URL is not https and rejects the whole keyboard with
// it, so a misconfiguration must produce a missing button rather than a menu
// that fails to render.
//
// DISCOVERABILITY (B06-B10). The entry used to be reachable only by typing
// `/app` — a command nothing in the interface mentions — so in practice the
// Mini App did not exist for users. It now lives in the ONE shared main-menu
// definition, which is what makes it appear identically in INLINE and REPLY
// mode. The definition is still not allowed to carry a `web_app` button
// (a reply keyboard's buttons are text only); it carries an ordinary callback
// that opens the intro page, and the `web_app` button lives there.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const previous = process.env.MINIAPP_PUBLIC_URL;
const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

afterEach(() => {
  if (previous === undefined) {
    delete process.env.MINIAPP_PUBLIC_URL;
  } else {
    process.env.MINIAPP_PUBLIC_URL = previous;
  }
});

describe("mini app bot entry point", () => {
  it("B01 accepts a configured https URL", () => {
    process.env.MINIAPP_PUBLIC_URL = "https://bot.example.com/miniapp";
    expect(miniAppUrl()).toBe("https://bot.example.com/miniapp");
  });

  it("B02 refuses anything Telegram would reject", () => {
    for (const bad of [
      "",
      "   ",
      "http://bot.example.com/miniapp", // Telegram requires TLS
      "bot.example.com/miniapp", // not a URL
      "ftp://bot.example.com/miniapp",
      "javascript:alert(1)",
      "not a url at all",
    ]) {
      process.env.MINIAPP_PUBLIC_URL = bad;
      expect(miniAppUrl(), JSON.stringify(bad)).toBeNull();
    }
  });

  it("B03 an unset variable hides the entry entirely", () => {
    delete process.env.MINIAPP_PUBLIC_URL;
    expect(miniAppUrl()).toBeNull();
    // ...and the user is told, rather than shown a button that opens a 404.
    expect(MINIAPP_UNAVAILABLE_TEXT.length).toBeGreaterThan(0);
    expect(MINIAPP_UNAVAILABLE_TEXT).toMatch(/[؀-ۿ]/);
  });

  it("B04 the callback identity is stable and namespaced", () => {
    // Old inline keyboards keep living in user chats, so this value can never
    // be renamed.
    expect(CB.USER_MINIAPP).toBe("user:miniapp");
    // `user:` prefixed, so it routes through the gated user area like every
    // other user surface.
    expect(CB.USER_MINIAPP.startsWith("user:")).toBe(true);
    expect(Buffer.byteLength(CB.USER_MINIAPP, "utf8")).toBeLessThanOrEqual(64);
  });

  it("B05 /app runs behind the same access gates as /menu", () => {
    const app = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
    // Both commands are dispatched into the SAME composer, which is where
    // maintenance, account status, terms and force-join are enforced.
    expect(app).toContain('bot.command("menu", userArea.middleware());');
    expect(app).toContain('bot.command("app", userArea.middleware());');
    // ...and the handler is registered before the placeholder catch-all, so the
    // callback reaches the real entry point.
    const miniIndex = app.indexOf("userArea.use(miniAppHandler);");
    const placeholderIndex = app.indexOf("userArea.use(userPlaceholdersHandler);");
    expect(miniIndex).toBeGreaterThan(0);
    expect(miniIndex).toBeLessThan(placeholderIndex);
  });

  it("B06 is wired into the ONE shared menu definition, not a second copy", () => {
    // A duplicated menu definition is how INLINE and REPLY drift apart. There
    // is exactly one, and the Mini App action is in it with an ORDINARY
    // callback — never a web_app URL, which a reply keyboard could not render.
    expect(MAIN_MENU_ACTION_WIRING.MINIAPP).toEqual({
      buttonKey: "miniapp",
      callback: CB.USER_MINIAPP,
    });
    const definition = readFileSync(
      path.join(repoRoot, "apps/bot/src/keyboards/user-menu-definition.ts"),
      "utf8",
    );
    // No `.webApp(...)` call anywhere in the definition (prose mentioning the
    // field is fine — B07 asserts the RENDERED keyboards carry none).
    expect(definition).not.toMatch(/\.webApp\s*\(/);
    expect(MINIAPP_BUTTON_TEXT).toMatch(/[؀-ۿ]/);
  });

  const describeDb = hasDb ? describe : describe.skip;

  describeDb("main-menu integration", () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("B07 appears in BOTH keyboard modes with the same label", async () => {
      process.env.MINIAPP_PUBLIC_URL = "https://bot.example.com/miniapp";
      clearTextCache();
      const label = await getButtonText("miniapp");
      expect(label.length).toBeGreaterThan(0);

      // INLINE: the definition carries the action, and the rendered inline
      // keyboard carries a callback button with that label.
      const rows = await buildUserMainMenuDefinition();
      const entry = rows.flat().find((b) => b.action === "MINIAPP");
      expect(entry).toBeDefined();
      expect(entry?.label).toBe(label);
      expect(entry?.callback).toBe(CB.USER_MINIAPP);

      const inline = await buildUserMainKeyboard();
      const inlineButtons = inline.inline_keyboard.flat();
      const inlineEntry = inlineButtons.find((b) => b.text === label);
      expect(inlineEntry).toBeDefined();
      expect(inlineEntry).toMatchObject({ callback_data: CB.USER_MINIAPP });
      // A reply keyboard cannot render this, so it must not be here either.
      expect(JSON.stringify(inline)).not.toContain("web_app");

      // REPLY: the same label, as plain text.
      const reply = await buildUserMainReplyKeyboard();
      expect(reply.keyboard.flat().map((b) => (typeof b === "string" ? b : b.text))).toContain(
        label,
      );
    });

    it("B08 routes the reply label to the Mini App action", async () => {
      process.env.MINIAPP_PUBLIC_URL = "https://bot.example.com/miniapp";
      clearTextCache();
      const label = await getButtonText("miniapp");
      expect(await resolveMainMenuAction(label)).toBe("MINIAPP");
      // Arbitrary text still never becomes navigation.
      expect(await resolveMainMenuAction(`${label} extra`)).toBeNull();
    });

    it("B09 hides the row when the URL is missing or not https", async () => {
      for (const bad of ["", "http://bot.example.com/miniapp", "not a url"]) {
        process.env.MINIAPP_PUBLIC_URL = bad;
        clearTextCache();
        const rows = await buildUserMainMenuDefinition();
        expect(
          rows.flat().some((b) => b.action === "MINIAPP"),
          JSON.stringify(bad),
        ).toBe(false);
        const reply = await buildUserMainReplyKeyboard();
        const label = await getButtonText("miniapp");
        expect(
          reply.keyboard.flat().map((b) => (typeof b === "string" ? b : b.text)),
          JSON.stringify(bad),
        ).not.toContain(label);
      }
    });

    it("B10 still refuses safely for a stale reply keyboard after the URL is removed", async () => {
      // The row is gone from newly rendered menus, but a persistent reply
      // keyboard already sitting in someone's chat is not. Resolving the label
      // means they get the explicit "not enabled yet" answer rather than having
      // their tap silently ignored as unrecognised text.
      delete process.env.MINIAPP_PUBLIC_URL;
      clearTextCache();
      const label = await getButtonText("miniapp");
      expect(await resolveMainMenuAction(label)).toBe("MINIAPP");
      expect(miniAppUrl()).toBeNull();
      expect(MINIAPP_UNAVAILABLE_TEXT.length).toBeGreaterThan(0);
    });
  });
});
