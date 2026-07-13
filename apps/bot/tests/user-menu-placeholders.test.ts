import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INITIAL_BUTTON_TEXTS, INITIAL_MESSAGE_TEMPLATES } from "@zedbot/database";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "menu-fix-test-secret-menu-fix-test-secret";

import { CB } from "../src/core/callbacks.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import { getButtonText, getMessageTemplate } from "../src/services/text.service.js";

// =============================================================================
// Fix A regression fix: the pre-Fix-A revert made the six unfinished user
// placeholder sections visible again. This locks the accepted 4-row user
// main menu (placeholders hidden, callbacks still answered) and the restored
// empty-state/pagination text fallbacks + seeds. Fix A behavior (finance
// nesting, wallet landing, direct renewal) is covered by
// corrective-fix-a.test.ts and untouched here.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Button = { text: string; callback_data?: string };

const HIDDEN = [
  CB.USER_REFERRAL,
  CB.USER_FREE_TEST,
  CB.USER_WHEEL,
  CB.USER_TUTORIALS,
  CB.USER_PRICING,
  CB.USER_REPRESENTATIVE,
];

describe("user main menu (placeholders hidden)", () => {
  it("shows exactly the implemented sections in the agreed four rows", async () => {
    const kb = await buildUserMainKeyboard();
    const rows = kb.inline_keyboard as Button[][];
    expect(rows.map((row) => row.map((b) => b.callback_data))).toEqual([
      [CB.USER_BUY, CB.USER_RENEW],
      [CB.USER_SERVICES, CB.USER_WALLET],
      [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
      [CB.USER_SUPPORT],
    ]);
    // Labels keep coming from getButtonText (fallbacks without a DB).
    const labels = rows.flat().map((b) => b.text);
    expect(labels).toContain("خرید اشتراک 🔐");
    expect(labels).toContain("محصولات دیگر 🛍");
  });

  it("hides all six unfinished placeholder sections", async () => {
    const kb = await buildUserMainKeyboard();
    const callbacks = (kb.inline_keyboard as Button[][])
      .flat()
      .map((b) => b.callback_data ?? "");
    for (const hidden of HIDDEN) {
      expect(callbacks, `${hidden} must stay hidden`).not.toContain(hidden);
    }
  });

  it("keeps the placeholder callbacks registered for old keyboards", () => {
    const handler = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/user-placeholders.handler.ts"),
      "utf8",
    );
    for (const constant of [
      "USER_REFERRAL",
      "USER_FREE_TEST",
      "USER_WHEEL",
      "USER_TUTORIALS",
      "USER_PRICING",
      "USER_REPRESENTATIVE",
    ]) {
      expect(handler, `CB.${constant} must stay in USER_SECTIONS`).toContain(`CB.${constant}`);
    }
    expect(handler).toContain("userPlaceholdersHandler.callbackQuery(section.callback");
    const app = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
    expect(app).toContain("userPlaceholdersHandler");
  });

  it("keeps the locked flows: user:buy unchanged, other_products separate", async () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
    const kb = await buildUserMainKeyboard();
    const flat = (kb.inline_keyboard as Button[][]).flat();
    expect(flat.find((b) => b.callback_data === CB.USER_BUY)).toBeDefined();
    expect(flat.find((b) => b.callback_data === CB.USER_OTHER_PRODUCTS)).toBeDefined();
  });
});

describe("restored text fallbacks, seeds and wiring", () => {
  const templates: Record<string, string> = {
    no_services_text: "هنوز سرویسی برای شما ثبت نشده است.",
    no_orders_text: "هنوز سفارشی ثبت نکرده‌اید.",
    no_tickets_text: "هنوز تیکتی ثبت نکرده‌اید.",
  };
  const buttons: Record<string, string> = {
    next: "بعدی »",
    previous: "« قبلی",
  };

  it("empty-state template registry defaults exist", async () => {
    // Fallbacks derive from the seed registry (seed-data.ts) - assert the
    // registry rows directly instead of scraping source files.
    for (const [key, value] of Object.entries(templates)) {
      const row = INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === key);
      expect(row?.defaultContent, `registry default for ${key}`).toBe(value);
      expect(await getMessageTemplate(key)).not.toBe(key);
    }
  });

  it("next/previous ButtonText registry defaults exist", async () => {
    for (const [key, value] of Object.entries(buttons)) {
      const row = INITIAL_BUTTON_TEXTS.find((b) => b.key === key);
      expect(row?.text, `registry default for ${key}`).toBe(value);
      expect(await getButtonText(key)).not.toBe(key);
    }
  });

  it("the three empty states are wired to their templates", () => {
    const wiring: Array<[string, string]> = [
      ["apps/bot/src/handlers/user-services/services.handler.ts", "no_services_text"],
      ["apps/bot/src/handlers/user-orders/orders.handler.ts", "no_orders_text"],
      // Fix D superseded no_tickets_text with the support_empty_tickets_text
      // key on the tickets list (both stay seeded with code fallbacks).
      ["apps/bot/src/handlers/user-support/support.handler.ts", "support_empty_tickets_text"],
    ];
    for (const [file, key] of wiring) {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      expect(src, `${file} must render ${key}`).toContain(`getMessageTemplate("${key}")`);
    }
  });
});
