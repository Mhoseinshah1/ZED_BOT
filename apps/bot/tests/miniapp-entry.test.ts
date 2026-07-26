import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CB } from "../src/core/callbacks.js";
import { miniAppUrl, MINIAPP_BUTTON_TEXT, MINIAPP_UNAVAILABLE_TEXT } from "../src/handlers/miniapp.handler.js";

// =============================================================================
// The bot's Mini App entry point (B01-B06).
//
// The gate is CONFIGURATION, not a database flag: Telegram refuses a `web_app`
// button whose URL is not https and rejects the whole keyboard with it, so a
// misconfiguration must produce a missing button rather than a menu that fails
// to render.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const previous = process.env.MINIAPP_PUBLIC_URL;

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

  it("B06 the entry stays out of the shared main-menu definition", () => {
    // The main menu renders from one definition consumed by BOTH an inline and
    // a reply-keyboard renderer. A reply keyboard cannot carry a web_app URL,
    // so adding the Mini App there would mean reshaping an OWNER-controlled
    // layout contract this feature has no business touching.
    const definition = readFileSync(
      path.join(repoRoot, "apps/bot/src/keyboards/user-menu-definition.ts"),
      "utf8",
    );
    expect(definition).not.toContain("MINIAPP");
    expect(definition).not.toContain("miniapp");
    expect(MINIAPP_BUTTON_TEXT).toMatch(/[؀-ۿ]/);
  });
});
