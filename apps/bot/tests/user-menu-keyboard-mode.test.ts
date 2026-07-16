import { prisma, type User } from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "menu-keyboard-mode-tests-secret-01";

import { CB } from "../src/core/callbacks.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { MENU_MODE_CHANGED_TEXT, showUserMenu } from "../src/handlers/menu.handler.js";
import { userMenuTextRouter } from "../src/handlers/user-menu-actions.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import {
  buildUserMainMenuDefinition,
  buildUserMainReplyKeyboard,
  MAIN_MENU_ACTION_WIRING,
  resolveMainMenuAction,
} from "../src/keyboards/user-menu-definition.js";
import {
  DUPLICATE_MAIN_MENU_LABEL_TEXT,
  updateButtonText,
} from "../src/services/admin-text-settings.service.js";
import {
  getUserMenuMode,
  setUserMenuMode,
  USER_MENU_MODE_KEY,
} from "../src/services/menu-mode.service.js";
import { deleteSetting, clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import { setFreeTrialEnabled } from "../src/services/free-trial-settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Configurable user main-menu keyboard mode: setting semantics, shared
// definition parity between INLINE and REPLY renderers, ButtonText-based
// reply routing (edited labels keep working; duplicates rejected),
// conversational-flow priority, and mode-transition keyboard removal.
// Requires real PostgreSQL (ButtonText/Setting rows); skips without it.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

/** Minimal BotContext stand-in for text updates (no callback query). */
function fakeTextCtx(user: User, text: string, session?: SessionData) {
  const sent: SentMessage[] = [];
  const message = {
    message_id: 1,
    date: 0,
    chat: { id: Number(user.telegramId), type: "private" },
    from: { id: Number(user.telegramId), is_bot: false, first_name: "Tester" },
    text,
  };
  const ctx = {
    session: session ?? initialSession(),
    dbUser: user,
    from: { id: Number(user.telegramId), first_name: "Tester" },
    message,
    update: { update_id: 1, message },
    callbackQuery: undefined,
    reply: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    answerCallbackQuery: async () => ({}),
  };
  return { ctx: ctx as never, sent, session: ctx.session };
}

async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), ...overrides },
  });
}

async function currentLabel(key: string): Promise<string> {
  const row = await prisma.buttonText.findUniqueOrThrow({ where: { key } });
  return row.currentText;
}

async function buttonRowId(key: string): Promise<string> {
  const row = await prisma.buttonText.findUniqueOrThrow({ where: { key } });
  return row.id;
}

describe.runIf(hasDb)("user main-menu keyboard mode", () => {
  let admin = { id: "" };

  beforeAll(async () => {
    seq += 1;
    const row = await prisma.admin.create({
      data: { telegramId: runTag + 700_000_000n, role: "OWNER", isActive: true },
    });
    admin = { id: row.id };
    await setFreeTrialEnabled(false);
  });

  beforeEach(async () => {
    await deleteSetting(USER_MENU_MODE_KEY);
    clearSettingsCache();
    clearTextCache();
  });

  afterAll(async () => {
    await deleteSetting(USER_MENU_MODE_KEY);
    await prisma.$disconnect();
  });

  // --- setting semantics (1-6) --------------------------------------------------------------

  it("1-6. default INLINE, switchable, idempotent, unknown values fail closed", async () => {
    // Absent row (existing installations after migration) -> INLINE.
    expect(await getUserMenuMode()).toBe("INLINE");
    await setUserMenuMode("REPLY");
    expect(await getUserMenuMode()).toBe("REPLY");
    await setUserMenuMode("INLINE");
    expect(await getUserMenuMode()).toBe("INLINE");
    // Repeated selection stays stable.
    await setUserMenuMode("INLINE");
    expect(await getUserMenuMode()).toBe("INLINE");
    // Garbage values resolve to INLINE, never crash.
    await setSetting(USER_MENU_MODE_KEY, "SOMETHING_ELSE", "STRING");
    clearSettingsCache();
    expect(await getUserMenuMode()).toBe("INLINE");
  });

  // --- rendering parity (7-16) -----------------------------------------------------------------

  it("7-16. inline layout unchanged; reply keyboard mirrors it with no callback data", async () => {
    const inline = await buildUserMainKeyboard();
    const inlineRows = inline.inline_keyboard.map((row) =>
      row.map((b) => [("text" in b ? b.text : ""), ("callback_data" in b ? b.callback_data : "")]),
    );
    // The approved inline contract: 4 rows, exact callbacks, in order.
    expect(inlineRows.map((row) => row.map(([, cb]) => cb))).toEqual([
      [CB.USER_BUY, CB.USER_RENEW],
      [CB.USER_SERVICES, CB.USER_WALLET],
      [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
      [CB.USER_SUPPORT],
    ]);

    const reply = await buildUserMainReplyKeyboard();
    const markup = reply as unknown as {
      keyboard: Array<Array<{ text: string }>>;
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
      is_persistent?: boolean;
    };
    // Same rows, same labels, same order - no callback data anywhere.
    expect(markup.keyboard.map((row) => row.map((b) => b.text))).toEqual(
      inlineRows.map((row) => row.map(([label]) => label)),
    );
    expect(JSON.stringify(markup.keyboard)).not.toContain("callback_data");
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.is_persistent).toBe(true);
    expect(markup.one_time_keyboard ?? false).toBe(false);
    // Telegram-practical label length bound.
    for (const row of markup.keyboard) {
      for (const button of row) {
        expect(button.text.length).toBeLessThanOrEqual(64);
      }
    }
  });

  // --- routing (17-23) ---------------------------------------------------------------------------

  it("17-23. labels route to stable actions; edits keep working; duplicates rejected", async () => {
    // Every visible label resolves to its wired action.
    const definition = await buildUserMainMenuDefinition();
    for (const button of definition.flat()) {
      expect(await resolveMainMenuAction(button.label)).toBe(button.action);
      expect(MAIN_MENU_ACTION_WIRING[button.action].buttonKey).toBe(button.buttonKey);
    }
    // Unknown text, commands and admin-looking text never resolve.
    expect(await resolveMainMenuAction(`random text ${runTag}`)).toBeNull();
    expect(await resolveMainMenuAction("/menu")).toBeNull();
    expect(await resolveMainMenuAction("پنل ادمین")).toBeNull();
    // Hidden free-trial: its label must not resolve while invisible.
    expect(await resolveMainMenuAction(await currentLabel("free_test"))).toBeNull();

    // Edited label keeps routing; the old label stops routing.
    const walletId = await buttonRowId("wallet");
    const original = await currentLabel("wallet");
    const edited = `کیف پول ویژه ${runTag}`;
    const outcome = await updateButtonText(walletId, edited, admin.id);
    expect(outcome.ok).toBe(true);
    clearTextCache();
    try {
      expect(await resolveMainMenuAction(edited)).toBe("WALLET");
      expect(await resolveMainMenuAction(original)).toBeNull();

      // A second main-menu button editing to the SAME text is rejected.
      const ordersId = await buttonRowId("my_orders");
      const dup = await updateButtonText(ordersId, edited, admin.id);
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
      }
      expect(await currentLabel("my_orders")).not.toBe(edited);
    } finally {
      await updateButtonText(walletId, original, admin.id);
      clearTextCache();
    }
  });

  // --- state priority + security (24-28, 34-35) ---------------------------------------------------

  it("24-28. active flows and commands keep priority; router acts only in REPLY mode", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    const supportLabel = await currentLabel("support");

    // Active conversational flow: text falls through untouched.
    for (const flow of ["support:message", "checkout:discount", "other_product:info", "admin_texts:button"]) {
      const { ctx, sent, session } = fakeTextCtx(user, supportLabel);
      session.currentFlow = flow;
      let fellThrough = false;
      await userMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // Commands always fall through.
    {
      const { ctx, sent } = fakeTextCtx(user, "/menu");
      let fellThrough = false;
      await userMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // INLINE mode: typed labels fall through (no reply-routing at all).
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    {
      const { ctx, sent } = fakeTextCtx(user, supportLabel);
      let fellThrough = false;
      await userMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // REPLY mode + no flow: the label routes to the same support landing.
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    {
      const { ctx, sent } = fakeTextCtx(user, supportLabel);
      await userMenuTextRouter.middleware()(ctx, async () => {});
      expect(sent.length).toBeGreaterThan(0);
      // Unknown arbitrary text still falls through silently.
      const { ctx: ctx2, sent: sent2 } = fakeTextCtx(user, `دلخواه ${runTag}`);
      let fellThrough = false;
      await userMenuTextRouter.middleware()(ctx2, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent2).toHaveLength(0);
    }
  });

  it("34-35. blocked users cannot navigate; hidden features cannot be forged by text", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const blocked = await createUser({ status: "BLOCKED" });
    const { ctx, sent } = fakeTextCtx(blocked, await currentLabel("support"));
    await userMenuTextRouter.middleware()(ctx, async () => {});
    // The access gate answers with the blocked notice - the section never renders.
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent.map((m) => m.other ?? {}))).not.toContain("user:support:");

    // Forged free-trial label while the feature is hidden: falls through.
    const user = await createUser();
    const { ctx: ctx2, sent: sent2 } = fakeTextCtx(user, await currentLabel("free_test"));
    let fellThrough = false;
    await userMenuTextRouter.middleware()(ctx2, async () => {
      fellThrough = true;
    });
    expect(fellThrough).toBe(true);
    expect(sent2).toHaveLength(0);
  });

  // --- transitions (29-33) --------------------------------------------------------------------------

  it("29-33. /start //menu render the current mode; INLINE removes stale reply keyboards once", async () => {
    const user = await createUser();

    // REPLY mode: fresh message with the persistent keyboard.
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const { ctx: replyCtx, sent: replySent, session } = fakeTextCtx(user, "/start");
    await showUserMenu(replyCtx);
    expect(replySent).toHaveLength(1);
    const replyMarkup = replySent[0].other?.reply_markup as Record<string, unknown>;
    expect(replyMarkup.is_persistent).toBe(true);
    expect(session.replyMenuKeyboardActive).toBe(true);

    // Back to INLINE: one transition message with remove_keyboard, then the
    // inline menu - and no repeated transition notices afterwards.
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const { ctx: inlineCtx, sent: inlineSent, session: s2 } = fakeTextCtx(user, "/menu", session);
    await showUserMenu(inlineCtx);
    expect(inlineSent[0].text).toBe(MENU_MODE_CHANGED_TEXT);
    expect((inlineSent[0].other?.reply_markup as Record<string, unknown>).remove_keyboard).toBe(
      true,
    );
    const menuMarkup = inlineSent[1].other?.reply_markup as Record<string, unknown>;
    expect(Array.isArray(menuMarkup.inline_keyboard)).toBe(true);
    expect(s2.replyMenuKeyboardActive).toBe(false);

    const { ctx: againCtx, sent: againSent } = fakeTextCtx(user, "/menu", s2);
    await showUserMenu(againCtx);
    expect(againSent).toHaveLength(1); // no second transition notice
    expect(
      Array.isArray((againSent[0].other?.reply_markup as Record<string, unknown>).inline_keyboard),
    ).toBe(true);
  });
});

describe.skipIf(hasDb)("user main-menu keyboard mode (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
