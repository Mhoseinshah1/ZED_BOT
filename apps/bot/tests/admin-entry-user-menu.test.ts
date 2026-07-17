import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INITIAL_BUTTON_TEXTS, prisma, type Admin, type User } from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "admin-entry-user-menu-tests-secret-01";

import { Composer } from "grammy";

import { CB } from "../src/core/callbacks.js";
import type { BotContext } from "../src/core/context.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { ADMIN_MENU_TEXT, adminHandler, showAdminMenu } from "../src/handlers/admin.handler.js";
import { adminMenuTextRouter } from "../src/handlers/admin-menu-actions.js";
import {
  MENU_MODE_CHANGED_TEXT,
  menuHandler,
  showUserMenu,
} from "../src/handlers/menu.handler.js";
import { userMenuTextRouter } from "../src/handlers/user-menu-actions.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import {
  buildUserMainMenuDefinition,
  buildUserMainReplyKeyboard,
  MAIN_MENU_ACTION_WIRING,
  MAIN_MENU_BUTTON_KEYS,
  resolveMainMenuAction,
} from "../src/keyboards/user-menu-definition.js";
import {
  ADMIN_DENIED_TEXT,
  adminAuthMiddleware,
  ensureActiveAdminAccess,
} from "../src/middlewares/admin-auth.middleware.js";
import { ACCESS_DENIED_TEXT } from "../src/middlewares/user-access.middleware.js";
import { getActiveAdminByTelegramId } from "../src/services/admin.service.js";
import {
  DUPLICATE_MAIN_MENU_LABEL_TEXT,
  updateButtonText,
} from "../src/services/admin-text-settings.service.js";
import { setFreeTrialEnabled } from "../src/services/free-trial-settings.service.js";
import {
  ADMIN_MENU_MODE_KEY,
  setAdminMenuMode,
  setUserMenuMode,
  USER_MENU_MODE_KEY,
} from "../src/services/menu-mode.service.js";
import { clearSettingsCache, deleteSetting } from "../src/services/settings.service.js";
import { OPS_EVENTS } from "../src/services/system-log.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// feat/admin-entry-in-user-menu: the active-admin-only «پنل مدیریت 🛠» entry
// as the FINAL full-width row of the user main menu, in BOTH keyboard modes.
// Locks: fail-closed visibility (default viewer never sees the row), the
// stable CB.ADMIN_MENU wiring into the EXISTING admin panel, viewer-blind
// label resolution with authorization at dispatch (ensureActiveAdminAccess:
// exact denial + SECURITY ops event; a label match NEVER authorizes), the
// four user/admin mode combinations, flow priority, the untouched
// pre-feature layout/free-trial policy and the duplicate-label guard scope.
// Requires real PostgreSQL (ButtonText/Setting/Admin rows); skips without it
// (docs/testing.md). Fixtures are runTag-unique and cleaned up in afterAll.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

/** The pre-feature normal-user contract (user-menu-placeholders.test.ts). */
const PRE_FEATURE_CALLBACK_ROWS: string[][] = [
  [CB.USER_BUY, CB.USER_RENEW],
  [CB.USER_SERVICES, CB.USER_WALLET],
  [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
  [CB.USER_SUPPORT],
];

/** ButtonText keys behind the pre-feature rows, in the approved order. */
const PRE_FEATURE_KEY_ROWS: string[][] = [
  ["buy_subscription", "renew_service"],
  ["my_services", "wallet"],
  ["other_products", "my_orders"],
  ["support"],
];

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

interface CtxOptions {
  admin?: Admin | null;
  user?: User | null;
  session?: SessionData;
}

/** Minimal BotContext stand-in for text updates (no callback query). */
function fakeTextCtx(telegramId: bigint, text: string, options: CtxOptions = {}) {
  const sent: SentMessage[] = [];
  const message = {
    message_id: 1,
    date: 0,
    chat: { id: Number(telegramId), type: "private" },
    from: { id: Number(telegramId), is_bot: false, first_name: "Tester" },
    text,
  };
  const ctx = {
    session: options.session ?? initialSession(),
    dbUser: options.user ?? null,
    admin: options.admin ?? null,
    from: { id: Number(telegramId), first_name: "Tester" },
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

/** Command update (entities included so grammY's command filter matches). */
function fakeCommandCtx(telegramId: bigint, text: string, options: CtxOptions = {}) {
  const sent: SentMessage[] = [];
  const command = text.split(" ")[0];
  const message = {
    message_id: 2,
    date: 0,
    chat: { id: Number(telegramId), type: "private" },
    from: { id: Number(telegramId), is_bot: false, first_name: "Tester" },
    text,
    entities: [{ type: "bot_command", offset: 0, length: command.length }],
  };
  const ctx = {
    session: options.session ?? initialSession(),
    dbUser: options.user ?? null,
    admin: options.admin ?? null,
    from: { id: Number(telegramId), first_name: "Tester" },
    message,
    update: { update_id: 2, message },
    callbackQuery: undefined,
    reply: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    answerCallbackQuery: async () => ({}),
  };
  return { ctx: ctx as never, sent, session: ctx.session };
}

/** Minimal BotContext stand-in for callback-query updates. */
function fakeCallbackCtx(telegramId: bigint, data: string, options: CtxOptions = {}) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const callbackQuery = {
    id: "cbq-1",
    chat_instance: "ci-1",
    from: { id: Number(telegramId), is_bot: false, first_name: "Tester" },
    data,
  };
  const ctx = {
    session: options.session ?? initialSession(),
    dbUser: options.user ?? null,
    admin: options.admin ?? null,
    from: { id: Number(telegramId), first_name: "Tester" },
    callbackQuery,
    update: { update_id: 3, callback_query: callbackQuery },
    reply: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { ctx: ctx as never, sent, toasts, session: ctx.session };
}

/** The gated admin area exactly as app.ts builds it: auth first, then /admin + admin:menu. */
function gatedAdminArea(): Composer<BotContext> {
  const area = new Composer<BotContext>();
  area.use(adminAuthMiddleware());
  area.use(adminHandler);
  return area;
}

/** Runs the app.ts text-router order: admin router first, then user router. */
async function runMenuRouters(ctx: never): Promise<boolean> {
  let fellThrough = false;
  await adminMenuTextRouter.middleware()(ctx, async () => {
    await userMenuTextRouter.middleware()(ctx, async () => {
      fellThrough = true;
    });
  });
  return fellThrough;
}

function inlineRows(kb: {
  inline_keyboard: Array<Array<Record<string, unknown>>>;
}): Array<Array<{ label: string; callback: string }>> {
  return kb.inline_keyboard.map((row) =>
    row.map((b) => ({
      label: String(b.text ?? ""),
      callback: String(b.callback_data ?? ""),
    })),
  );
}

function replyRows(kb: unknown): string[][] {
  const markup = kb as { keyboard: Array<Array<{ text: string }>> };
  return markup.keyboard.map((row) => row.map((b) => b.text));
}

function markupOf(message: SentMessage): Record<string, unknown> {
  return (message.other?.reply_markup ?? {}) as Record<string, unknown>;
}

async function currentLabel(key: string): Promise<string> {
  const row = await prisma.buttonText.findUniqueOrThrow({ where: { key } });
  return row.currentText;
}

async function buttonRowId(key: string): Promise<string> {
  const row = await prisma.buttonText.findUniqueOrThrow({ where: { key } });
  return row.id;
}

/** The SECURITY denial ops event is fire-and-forget - poll briefly for it. */
async function countDeniedEvents(telegramId: bigint, expectAtLeast: number): Promise<number> {
  const where = {
    eventType: OPS_EVENTS.SECURITY_ADMIN_DENIED,
    metadata: { path: ["telegramId"], equals: String(telegramId) },
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const count = await prisma.systemLog.count({ where });
    if (count >= expectAtLeast) {
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return prisma.systemLog.count({ where });
}

describe.runIf(hasDb)("admin entry in the user main menu", () => {
  let owner: Admin;
  let inactiveAdmin: Admin;
  const userIds: string[] = [];
  const adminIds: string[] = [];
  const panelIds: string[] = [];
  const deniedTelegramIds: bigint[] = [];
  let adminPanelLabel = "";

  async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
    seq += 1;
    const user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), ...overrides },
    });
    userIds.push(user.id);
    return user;
  }

  async function createAdmin(overrides: Record<string, unknown> = {}): Promise<Admin> {
    seq += 1;
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 800_000_000n + BigInt(seq), role: "SUPPORT", ...overrides },
    });
    adminIds.push(admin.id);
    return admin;
  }

  beforeAll(async () => {
    owner = await createAdmin({ role: "OWNER", isActive: true });
    inactiveAdmin = await createAdmin({ role: "SUPPORT", isActive: false });
    await setFreeTrialEnabled(false); // repo default: trial row hidden
    clearSettingsCache();
    adminPanelLabel = await currentLabel("admin_panel");
  });

  beforeEach(async () => {
    await deleteSetting(USER_MENU_MODE_KEY);
    await deleteSetting(ADMIN_MENU_MODE_KEY);
    clearSettingsCache();
    clearTextCache();
  });

  afterAll(async () => {
    await deleteSetting(USER_MENU_MODE_KEY);
    await deleteSetting(ADMIN_MENU_MODE_KEY);
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    // Belt over the in-test finally restores: labels back to their defaults.
    for (const key of ["admin_panel", "wallet"]) {
      const row = await prisma.buttonText.findUnique({ where: { key } });
      if (row !== null && row.currentText !== row.defaultText) {
        await prisma.buttonText.update({
          where: { key },
          data: { currentText: row.defaultText },
        });
      }
    }
    clearTextCache();
    for (const telegramId of deniedTelegramIds) {
      await prisma.systemLog.deleteMany({
        where: {
          eventType: OPS_EVENTS.SECURITY_ADMIN_DENIED,
          metadata: { path: ["telegramId"], equals: String(telegramId) },
        },
      });
    }
    await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.$disconnect();
  });

  // --- visibility (1-4) -----------------------------------------------------------------------

  it("1. normal-user inline menu lacks the admin button (explicit non-admin viewer AND default)", async () => {
    for (const keyboard of [
      await buildUserMainKeyboard({ isActiveAdmin: false }),
      await buildUserMainKeyboard(), // no viewer = fail closed
    ]) {
      const flat = inlineRows(keyboard).flat();
      expect(flat.map((b) => b.callback)).not.toContain(CB.ADMIN_MENU);
      expect(flat.map((b) => b.label)).not.toContain(adminPanelLabel);
    }
    for (const definition of [
      await buildUserMainMenuDefinition({ isActiveAdmin: false }),
      await buildUserMainMenuDefinition(),
    ]) {
      expect(definition.flat().map((b) => b.action)).not.toContain("ADMIN_PANEL");
    }
  });

  it("2. normal-user reply menu lacks the admin row (explicit non-admin viewer AND default)", async () => {
    for (const keyboard of [
      await buildUserMainReplyKeyboard({ isActiveAdmin: false }),
      await buildUserMainReplyKeyboard(),
    ]) {
      expect(replyRows(keyboard).flat()).not.toContain(adminPanelLabel);
    }
  });

  it("3. active-admin inline menu renders the admin entry as the FINAL full-width row", async () => {
    const rows = inlineRows(await buildUserMainKeyboard({ isActiveAdmin: true }));
    // The pre-feature rows stay untouched; the admin row is appended LAST.
    expect(rows.map((row) => row.map((b) => b.callback))).toEqual([
      ...PRE_FEATURE_CALLBACK_ROWS,
      [CB.ADMIN_MENU],
    ]);
    const finalRow = rows[rows.length - 1];
    expect(finalRow).toHaveLength(1); // full-width: alone in its row
    expect(finalRow[0].label).toBe(adminPanelLabel);
    expect(finalRow[0].callback).toBe(CB.ADMIN_MENU);
  });

  it("4. active-admin reply menu mirrors it: same final full-width row, labels only", async () => {
    const inline = inlineRows(await buildUserMainKeyboard({ isActiveAdmin: true }));
    const reply = await buildUserMainReplyKeyboard({ isActiveAdmin: true });
    const rows = replyRows(reply);
    expect(rows).toEqual(inline.map((row) => row.map((b) => b.label)));
    expect(rows[rows.length - 1]).toEqual([adminPanelLabel]);
    expect(JSON.stringify(reply)).not.toContain("callback_data");
    const markup = reply as unknown as {
      resize_keyboard?: boolean;
      is_persistent?: boolean;
      one_time_keyboard?: boolean;
    };
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.is_persistent).toBe(true);
    expect(markup.one_time_keyboard ?? false).toBe(false);
  });

  // --- wiring contract (5-7) ------------------------------------------------------------------

  it("5. the admin-entry callback is exactly admin:menu and within Telegram's 64-byte bound", async () => {
    expect(CB.ADMIN_MENU).toBe("admin:menu");
    expect(Buffer.byteLength(CB.ADMIN_MENU, "utf8")).toBeLessThanOrEqual(64);
    expect(MAIN_MENU_ACTION_WIRING.ADMIN_PANEL).toEqual({
      buttonKey: "admin_panel",
      callback: CB.ADMIN_MENU,
    });
    const button = inlineRows(await buildUserMainKeyboard({ isActiveAdmin: true }))
      .flat()
      .find((b) => b.label === adminPanelLabel);
    expect(button?.callback).toBe(CB.ADMIN_MENU);
  });

  it("6. the seeded default label resolves to ADMIN_PANEL (resolution is viewer-blind)", async () => {
    const seed = INITIAL_BUTTON_TEXTS.find((b) => b.key === "admin_panel");
    expect(seed?.text).toBe("پنل مدیریت 🛠");
    expect(await resolveMainMenuAction("پنل مدیریت 🛠")).toBe("ADMIN_PANEL");
    expect(await resolveMainMenuAction("  پنل مدیریت 🛠  ")).toBe("ADMIN_PANEL"); // trimmed match
    // Near-misses never resolve - arbitrary text is never navigation.
    expect(await resolveMainMenuAction("پنل مدیریت")).toBeNull();
  });

  it("7. an edited admin_panel label keeps resolving; the old label stops", async () => {
    const rowId = await buttonRowId("admin_panel");
    const original = adminPanelLabel;
    const edited = `ورود مدیران ${runTag}`;
    const outcome = await updateButtonText(rowId, edited, owner.id);
    expect(outcome.ok).toBe(true);
    clearTextCache();
    try {
      expect(await resolveMainMenuAction(edited)).toBe("ADMIN_PANEL");
      expect(await resolveMainMenuAction(original)).toBeNull();
      // Both renderers pick the edited label up immediately.
      const inline = inlineRows(await buildUserMainKeyboard({ isActiveAdmin: true })).flat();
      expect(inline.some((b) => b.label === edited && b.callback === CB.ADMIN_MENU)).toBe(true);
      expect(replyRows(await buildUserMainReplyKeyboard({ isActiveAdmin: true })).flat()).toContain(
        edited,
      );
    } finally {
      await updateButtonText(rowId, original, owner.id);
      clearTextCache();
    }
    expect(await resolveMainMenuAction(original)).toBe("ADMIN_PANEL");
  });

  // --- authorization (8-10) -------------------------------------------------------------------

  it("8. a normal user typing the label gets the exact admin denial and never the panel", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    deniedTelegramIds.push(user.telegramId);
    const { ctx, sent } = fakeTextCtx(user.telegramId, adminPanelLabel, { user });
    const fellThrough = await runMenuRouters(ctx);
    expect(fellThrough).toBe(false); // recognized, not ignored
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(ADMIN_DENIED_TEXT);
    expect(sent[0].other).toBeUndefined(); // no keyboard, no admin content
    expect(sent.map((m) => m.text)).not.toContain(ADMIN_MENU_TEXT);
    // The denial writes the SECURITY ops event (fire-and-forget - polled).
    expect(await countDeniedEvents(user.telegramId, 1)).toBeGreaterThanOrEqual(1);
  });

  it("9. a deactivated admin (stale reply keyboard) is denied exactly like a normal user", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    // The attach middleware resolves ACTIVE admins only - a deactivated row
    // yields ctx.admin = null, which is what a stale keyboard tap carries.
    expect(await getActiveAdminByTelegramId(inactiveAdmin.telegramId)).toBeNull();
    expect(await getActiveAdminByTelegramId(owner.telegramId)).not.toBeNull();
    deniedTelegramIds.push(inactiveAdmin.telegramId);
    const { ctx, sent } = fakeTextCtx(inactiveAdmin.telegramId, adminPanelLabel, {
      admin: null,
    });
    const fellThrough = await runMenuRouters(ctx);
    expect(fellThrough).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(ADMIN_DENIED_TEXT);
    expect(sent.map((m) => m.text)).not.toContain(ADMIN_MENU_TEXT);
    expect(await countDeniedEvents(inactiveAdmin.telegramId, 1)).toBeGreaterThanOrEqual(1);
  });

  it("10. a forged admin:menu callback without an active admin is denied by the gated area", async () => {
    // adminAuthMiddleware delegates to the ONE shared gate (no drift).
    const middlewareSource = readFileSync(
      path.join(repoRoot, "apps/bot/src/middlewares/admin-auth.middleware.ts"),
      "utf8",
    );
    expect(middlewareSource).toMatch(
      /adminAuthMiddleware[\s\S]*ensureActiveAdminAccess\(ctx\)/,
    );

    seq += 1;
    const forgedTelegramId = runTag + 900_000_000n + BigInt(seq);
    deniedTelegramIds.push(forgedTelegramId);
    const forged = fakeCallbackCtx(forgedTelegramId, CB.ADMIN_MENU, { admin: null });
    await gatedAdminArea().middleware()(forged.ctx, async () => {});
    expect(forged.sent).toHaveLength(1);
    expect(forged.sent[0].text).toBe(ADMIN_DENIED_TEXT);
    expect(forged.sent.map((m) => m.text)).not.toContain(ADMIN_MENU_TEXT);
    expect(forged.toasts).toHaveLength(1); // spinner stopped, no toast text
    expect(await countDeniedEvents(forgedTelegramId, 1)).toBeGreaterThanOrEqual(1);

    // The same gate, called directly: false for null, true for an active admin.
    const direct = fakeCallbackCtx(forgedTelegramId, CB.ADMIN_MENU, { admin: null });
    expect(await ensureActiveAdminAccess(direct.ctx)).toBe(false);
    const allowed = fakeCallbackCtx(owner.telegramId, CB.ADMIN_MENU, { admin: owner });
    expect(await ensureActiveAdminAccess(allowed.ctx)).toBe(true);
    expect(allowed.sent).toHaveLength(0); // success path sends nothing itself

    // And through the SAME gated composer an active admin reaches the panel.
    const real = fakeCallbackCtx(owner.telegramId, CB.ADMIN_MENU, { admin: owner });
    await gatedAdminArea().middleware()(real.ctx, async () => {});
    expect(real.sent.map((m) => m.text)).toContain(ADMIN_MENU_TEXT);
  });

  // --- the existing /admin entry (11-12) ------------------------------------------------------

  it("11. /admin stays registered and renders the panel for an active admin", async () => {
    const app = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
    expect(app).toContain('bot.command("admin", adminArea.middleware())');
    const { ctx, sent, session } = fakeCommandCtx(owner.telegramId, "/admin", { admin: owner });
    await gatedAdminArea().middleware()(ctx, async () => {});
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(ADMIN_MENU_TEXT);
    expect(Array.isArray(markupOf(sent[0]).inline_keyboard)).toBe(true); // default INLINE mode
    expect(session.lastMenu).toBe("admin_main");
  });

  it("12. the menu button and /admin invoke the SAME admin menu - even for a blocked user row", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    // An active admin whose USER account is blocked: the ADMIN_PANEL branch
    // runs BEFORE the customer gates, so the panel must still open.
    const blockedAdmin = await createAdmin({ role: "OWNER", isActive: true });
    const blockedUser = await createUser({
      telegramId: blockedAdmin.telegramId,
      status: "BLOCKED",
    });

    const viaButton = fakeTextCtx(blockedAdmin.telegramId, adminPanelLabel, {
      admin: blockedAdmin,
      user: blockedUser,
    });
    await runMenuRouters(viaButton.ctx);
    expect(viaButton.sent).toHaveLength(1);
    expect(viaButton.sent[0].text).toBe(ADMIN_MENU_TEXT);
    expect(viaButton.sent.map((m) => m.text)).not.toContain(ACCESS_DENIED_TEXT);
    expect(viaButton.session.lastMenu).toBe("admin_main");

    const viaCommand = fakeCommandCtx(blockedAdmin.telegramId, "/admin", {
      admin: blockedAdmin,
      user: blockedUser,
    });
    await gatedAdminArea().middleware()(viaCommand.ctx, async () => {});
    expect(viaCommand.sent).toHaveLength(1);

    // Both paths land in showAdminMenu: identical heading and session state.
    expect(viaButton.sent[0].text).toBe(viaCommand.sent[0].text);
    expect(viaCommand.session.lastMenu).toBe("admin_main");
  });

  // --- keyboard-mode combinations (13-14) -----------------------------------------------------

  it("13. all four user/admin mode combinations render the admin menu in ITS configured mode", async () => {
    const combos = [
      ["REPLY", "REPLY"],
      ["REPLY", "INLINE"],
      ["INLINE", "REPLY"],
      ["INLINE", "INLINE"],
    ] as const;
    for (const [userMode, adminMode] of combos) {
      const tag = `user=${userMode}/admin=${adminMode}`;
      await setUserMenuMode(userMode);
      await setAdminMenuMode(adminMode);
      clearSettingsCache();

      // 1) Render the user menu for the active admin (fresh session).
      const menu = fakeTextCtx(owner.telegramId, "/start", { admin: owner });
      await showUserMenu(menu.ctx);
      const session = menu.session;
      expect(menu.sent, tag).toHaveLength(1);
      if (userMode === "REPLY") {
        expect(replyRows(markupOf(menu.sent[0])).flat(), tag).toContain(adminPanelLabel);
        expect(session.replyMenuKeyboardActive, tag).toBe(true);
      } else {
        const flat = inlineRows(
          markupOf(menu.sent[0]) as { inline_keyboard: Array<Array<Record<string, unknown>>> },
        ).flat();
        expect(flat.map((b) => b.callback), tag).toContain(CB.ADMIN_MENU);
      }

      // 2) Enter the admin panel via the mode's own entry path.
      let sent: SentMessage[];
      if (userMode === "REPLY") {
        const tap = fakeTextCtx(owner.telegramId, adminPanelLabel, { admin: owner, session });
        await runMenuRouters(tap.ctx);
        sent = tap.sent;
      } else {
        const click = fakeCallbackCtx(owner.telegramId, CB.ADMIN_MENU, { admin: owner, session });
        await gatedAdminArea().middleware()(click.ctx, async () => {});
        sent = click.sent;
      }

      // 3) The admin menu renders in ITS configured mode with the exact
      //    session keyboard-flag transitions of menu.handler/admin.handler.
      if (adminMode === "REPLY") {
        expect(sent, tag).toHaveLength(1); // reply keyboards replace silently
        expect(sent[0].text, tag).toBe(ADMIN_MENU_TEXT);
        expect(markupOf(sent[0]).is_persistent, tag).toBe(true);
        expect(session.adminReplyMenuKeyboardActive, tag).toBe(true);
        expect(session.replyMenuKeyboardActive, tag).toBe(false);
      } else if (userMode === "REPLY") {
        // Stale user reply keyboard is removed exactly once, then inline.
        expect(sent.map((m) => m.text), tag).toEqual([MENU_MODE_CHANGED_TEXT, ADMIN_MENU_TEXT]);
        expect(markupOf(sent[0]).remove_keyboard, tag).toBe(true);
        expect(Array.isArray(markupOf(sent[1]).inline_keyboard), tag).toBe(true);
        expect(session.adminReplyMenuKeyboardActive, tag).toBe(false);
        expect(session.replyMenuKeyboardActive, tag).toBe(false);
      } else {
        expect(sent.map((m) => m.text), tag).toEqual([ADMIN_MENU_TEXT]);
        expect(Array.isArray(markupOf(sent[0]).inline_keyboard), tag).toBe(true);
        expect(session.adminReplyMenuKeyboardActive ?? false, tag).toBe(false);
        expect(session.replyMenuKeyboardActive ?? false, tag).toBe(false);
      }
      expect(session.lastMenu, tag).toBe("admin_main");
    }
  });

  it("14. back-to-user restores the user mode; the admin row reappears only for an active admin", async () => {
    await setUserMenuMode("REPLY");
    await setAdminMenuMode("REPLY");
    clearSettingsCache();

    // Inside the admin panel (persistent admin keyboard up)...
    const adminRender = fakeTextCtx(owner.telegramId, "/admin", { admin: owner });
    await showAdminMenu(adminRender.ctx);
    const session = adminRender.session;
    expect(session.adminReplyMenuKeyboardActive).toBe(true);

    // ...the registered back callback restores the USER menu in ITS mode.
    const back = fakeCallbackCtx(owner.telegramId, CB.COMMON_BACK, { admin: owner, session });
    await menuHandler.middleware()(back.ctx, async () => {});
    expect(back.sent).toHaveLength(1); // reply keyboards replace silently
    const rows = replyRows(markupOf(back.sent[0]));
    expect(rows[rows.length - 1]).toEqual([adminPanelLabel]); // still the final row
    expect(session.replyMenuKeyboardActive).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);
    expect(session.lastMenu).toBe("user_main");

    // A normal user going back never sees the admin row.
    const user = await createUser();
    const userBack = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { user });
    await menuHandler.middleware()(userBack.ctx, async () => {});
    expect(userBack.sent).toHaveLength(1);
    expect(replyRows(markupOf(userBack.sent[0])).flat()).not.toContain(adminPanelLabel);

    // INLINE user mode: back removes the stale admin keyboard once, and the
    // inline menu carries the admin entry for the active admin.
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    session.adminReplyMenuKeyboardActive = true;
    const inlineBack = fakeCallbackCtx(owner.telegramId, CB.COMMON_BACK, {
      admin: owner,
      session,
    });
    await menuHandler.middleware()(inlineBack.ctx, async () => {});
    expect(inlineBack.sent[0].text).toBe(MENU_MODE_CHANGED_TEXT);
    const inlineFlat = inlineRows(
      markupOf(inlineBack.sent[1]) as { inline_keyboard: Array<Array<Record<string, unknown>>> },
    ).flat();
    expect(inlineFlat.map((b) => b.callback)).toContain(CB.ADMIN_MENU);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);
  });

  // --- priority + unchanged behavior (15-17) --------------------------------------------------

  it("15. an active conversational flow is never intercepted by the admin label", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    for (const flow of ["payment:receipt", "customer_input:form"]) {
      // Active admin mid-flow: the label falls through untouched.
      const adminTap = fakeTextCtx(owner.telegramId, adminPanelLabel, { admin: owner });
      adminTap.session.currentFlow = flow;
      expect(await runMenuRouters(adminTap.ctx), flow).toBe(true);
      expect(adminTap.sent, flow).toHaveLength(0);
      // Normal user mid-flow: no denial either - the router never acts.
      const userTap = fakeTextCtx(user.telegramId, adminPanelLabel, { user });
      userTap.session.currentFlow = flow;
      expect(await runMenuRouters(userTap.ctx), flow).toBe(true);
      expect(userTap.sent, flow).toHaveLength(0);
    }
  });

  it("16. the pre-feature normal-user layout is unchanged (labels AND callbacks)", async () => {
    const expectedLabels: string[][] = [];
    for (const keyRow of PRE_FEATURE_KEY_ROWS) {
      expectedLabels.push(await Promise.all(keyRow.map((key) => currentLabel(key))));
    }
    for (const definition of [
      await buildUserMainMenuDefinition(),
      await buildUserMainMenuDefinition({ isActiveAdmin: false }),
    ]) {
      expect(definition.map((row) => row.map((b) => b.callback))).toEqual(
        PRE_FEATURE_CALLBACK_ROWS,
      );
      expect(definition.map((row) => row.map((b) => b.label))).toEqual(expectedLabels);
    }
    // The pinned seed labels of user-menu-placeholders.test.ts still hold.
    const flatLabels = (await buildUserMainMenuDefinition()).flat().map((b) => b.label);
    expect(flatLabels).toContain("خرید اشتراک 🔐");
    expect(flatLabels).toContain("محصولات دیگر 🛍");
  });

  it("17. free-trial row conditionality is unchanged and independent of the viewer", async () => {
    // A config-complete trial-ready panel (free-trial-visibility fixture shape).
    seq += 1;
    const panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `admin-entry-trial-${runTag}-${seq}`,
        baseUrl: "https://admin-entry-config-only.example.com:8443",
        username: "admin",
        passwordEncrypted: `admin-entry-enc-${runTag}`,
        status: "ACTIVE",
        testEnabled: true,
        testDurationMinutes: 120,
        testVolumeMb: 512,
        templateUsername: "tpl",
      },
    });
    panelIds.push(panel.id);
    try {
      await setFreeTrialEnabled(true);
      clearSettingsCache();
      // Visible: the trial row renders for BOTH viewers; the admin row still
      // renders ONLY for the active admin - the policies are independent.
      const normal = await buildUserMainMenuDefinition();
      expect(normal.map((row) => row.map((b) => b.callback))).toEqual([
        [CB.USER_BUY, CB.USER_RENEW],
        [CB.USER_SERVICES, CB.USER_WALLET],
        [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
        [CB.USER_FREE_TEST],
        [CB.USER_SUPPORT],
      ]);
      const admin = await buildUserMainMenuDefinition({ isActiveAdmin: true });
      expect(admin.map((row) => row.map((b) => b.callback))).toEqual([
        [CB.USER_BUY, CB.USER_RENEW],
        [CB.USER_SERVICES, CB.USER_WALLET],
        [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
        [CB.USER_FREE_TEST],
        [CB.USER_SUPPORT],
        [CB.ADMIN_MENU],
      ]);
    } finally {
      await setFreeTrialEnabled(false);
      clearSettingsCache();
      await prisma.panel.update({ where: { id: panel.id }, data: { testEnabled: false } });
    }
    // Hidden again: trial row gone for both viewers, admin row untouched.
    const hiddenAdmin = await buildUserMainMenuDefinition({ isActiveAdmin: true });
    expect(hiddenAdmin.map((row) => row.map((b) => b.callback))).toEqual([
      ...PRE_FEATURE_CALLBACK_ROWS,
      [CB.ADMIN_MENU],
    ]);
    expect(
      (await buildUserMainMenuDefinition()).map((row) => row.map((b) => b.callback)),
    ).toEqual(PRE_FEATURE_CALLBACK_ROWS);
  });

  // --- duplicate-label guard (18) -------------------------------------------------------------

  it("18. the duplicate-label guard covers admin_panel inside the user-menu scope", async () => {
    // admin_panel is a guarded main-menu key now (9 keys, one per action).
    expect(MAIN_MENU_BUTTON_KEYS).toContain("admin_panel");
    expect(MAIN_MENU_BUTTON_KEYS).toHaveLength(
      Object.keys(MAIN_MENU_ACTION_WIRING).length,
    );

    // Another user-menu button may not take the admin_panel label...
    const walletId = await buttonRowId("wallet");
    const walletOriginal = await currentLabel("wallet");
    const dup = await updateButtonText(walletId, adminPanelLabel, owner.id);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
    }
    expect(await currentLabel("wallet")).toBe(walletOriginal);

    // ...and admin_panel may not take another user-menu button's label.
    const adminPanelId = await buttonRowId("admin_panel");
    const reverse = await updateButtonText(adminPanelId, walletOriginal, owner.id);
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) {
      expect(reverse.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
    }
    expect(await currentLabel("admin_panel")).toBe(adminPanelLabel);
  });
});

describe.skipIf(hasDb)("admin entry in the user main menu (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
