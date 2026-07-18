import { INITIAL_BUTTON_TEXTS, prisma, type Admin, type User } from "@zedbot/database";
import { Composer } from "grammy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "admin-return-to-user-menu-tests-secret-01";

import { CB } from "../src/core/callbacks.js";
import type { BotContext } from "../src/core/context.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { ADMIN_MENU_TEXT, adminHandler, showAdminMenu } from "../src/handlers/admin.handler.js";
import {
  ADMIN_MENU_ACCESS_DENIED_TEXT,
  adminMenuTextRouter,
} from "../src/handlers/admin-menu-actions.js";
import { MENU_MODE_CHANGED_TEXT, menuHandler } from "../src/handlers/menu.handler.js";
import { userMenuTextRouter } from "../src/handlers/user-menu-actions.js";
import { buildAdminMainKeyboard } from "../src/keyboards/admin-main.keyboard.js";
import {
  ADMIN_MAIN_MENU_BUTTON_KEYS,
  buildAdminMainMenuDefinition,
  buildAdminMainReplyKeyboard,
  resolveAdminMainMenuAction,
} from "../src/keyboards/admin-menu-definition.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import { buildUserMainReplyKeyboard } from "../src/keyboards/user-menu-definition.js";
import { adminAuthMiddleware } from "../src/middlewares/admin-auth.middleware.js";
import { userAccessMiddleware } from "../src/middlewares/user-access.middleware.js";
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
import {
  clearSettingsCache,
  deleteSetting,
  setSetting,
} from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// feat/admin-return-to-user-menu: the final full-width «بازگشت به منوی کاربر 👤»
// row that completes the two-way User/Admin navigation. It reuses the EXISTING
// user-area entry (CB.USER_MENU inline; showUserMenu after ensureUserAccess in
// REPLY) - no new callback, no duplicated rendering, no gate bypass. Covers the
// layout, both mode routes, all four keyboard-mode transitions, the user-access
// gates (an active admin never bypasses them), /menu parity, active-flow
// priority and authorization-by-action (never by the Persian label). Requires
// real PostgreSQL (ButtonText/Setting/Admin rows); skips without it.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const RETURN_LABEL = "بازگشت به منوی کاربر 👤";
const RETURN_KEY = "admin_return_user_menu";
const MAINTENANCE_KEY = "maintenance_mode";
const TERMS_KEY = "terms_required";
const FORCE_JOIN_KEY = "force_join_enabled";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const ADMIN_DEFAULTS: Record<string, string> = Object.fromEntries(
  INITIAL_BUTTON_TEXTS.filter((b) => ADMIN_MAIN_MENU_BUTTON_KEYS.includes(b.key)).map((b) => [
    b.key,
    b.text,
  ]),
);

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}
interface CtxOptions {
  admin?: Admin | null;
  user?: User | null;
  session?: SessionData;
}

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

/** The gated user area exactly as app.ts builds it: user-access gate, then menuHandler. */
function gatedUserArea(): Composer<BotContext> {
  const area = new Composer<BotContext>();
  area.use(userAccessMiddleware());
  area.use(menuHandler);
  return area;
}
/** The gated admin area: admin auth, then adminHandler (/admin + admin:menu). */
function gatedAdminArea(): Composer<BotContext> {
  const area = new Composer<BotContext>();
  area.use(adminAuthMiddleware());
  area.use(adminHandler);
  return area;
}
/** The app.ts text-router order: admin router first, then the user router. */
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
    row.map((b) => ({ label: String(b.text ?? ""), callback: String(b.callback_data ?? "") })),
  );
}
function replyRows(kb: unknown): string[][] {
  const markup = kb as { keyboard: Array<Array<{ text: string }>> };
  return markup.keyboard.map((row) => row.map((b) => b.text));
}
function markupOf(m: SentMessage): Record<string, unknown> {
  return (m.other?.reply_markup ?? {}) as Record<string, unknown>;
}
async function currentLabel(key: string): Promise<string> {
  return (await prisma.buttonText.findUniqueOrThrow({ where: { key } })).currentText;
}
async function buttonRowId(key: string): Promise<string> {
  return (await prisma.buttonText.findUniqueOrThrow({ where: { key } })).id;
}

describe.runIf(hasDb)("return to user menu from the admin panel", () => {
  let owner: Admin;
  let inactiveAdmin: Admin;
  const userIds: string[] = [];
  const adminIds: string[] = [];

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
    // Seed the admin main-menu registry (incl. the new return key) so the
    // edit/duplicate tests have real rows; layout tests would also pass on the
    // in-code fallbacks.
    for (const [key, text] of Object.entries(ADMIN_DEFAULTS)) {
      await prisma.buttonText.upsert({
        where: { key },
        create: { key, title: `منوی ادمین: ${key}`, defaultText: text, currentText: text },
        update: {},
      });
    }
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    clearTextCache();
  });

  beforeEach(async () => {
    await deleteSetting(USER_MENU_MODE_KEY);
    await deleteSetting(ADMIN_MENU_MODE_KEY);
    await deleteSetting(MAINTENANCE_KEY);
    await deleteSetting(TERMS_KEY);
    await deleteSetting(FORCE_JOIN_KEY);
    clearSettingsCache();
    clearTextCache();
  });

  afterAll(async () => {
    for (const key of [
      USER_MENU_MODE_KEY,
      ADMIN_MENU_MODE_KEY,
      MAINTENANCE_KEY,
      TERMS_KEY,
      FORCE_JOIN_KEY,
    ]) {
      await deleteSetting(key);
    }
    for (const [key, text] of Object.entries(ADMIN_DEFAULTS)) {
      await prisma.buttonText.updateMany({ where: { key }, data: { currentText: text } });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    clearSettingsCache();
    clearTextCache();
    await prisma.$disconnect();
  });

  // --- Layout (1-8) ---------------------------------------------------------------------------

  it("1-5. the return row is the FINAL full-width admin row in both renderers, callback = CB.USER_MENU", async () => {
    // 1. Active-admin INLINE menu: the final row is exactly the return button.
    const inline = inlineRows(await buildAdminMainKeyboard(owner));
    expect(inline.at(-1)).toEqual([{ label: RETURN_LABEL, callback: CB.USER_MENU }]); // 4-5
    expect(inline.at(-1)).toHaveLength(1); // 4. full-width (single button row)

    // 2. Active-admin REPLY menu: identical final row (labels only).
    const reply = replyRows(await buildAdminMainReplyKeyboard(owner));
    expect(reply.at(-1)).toEqual([RETURN_LABEL]);
    expect(reply.at(-1)).toHaveLength(1);

    // 3. The existing rows are unchanged: the return row is strictly appended.
    const definition = await buildAdminMainMenuDefinition(owner);
    expect(definition).toHaveLength(6); // 5 historical rows + the return row
    expect(definition.at(-1)?.map((b) => b.action)).toEqual(["RETURN_TO_USER_MENU"]);
    // Callback is the EXISTING user-area callback, within Telegram's 64-byte bound.
    expect(CB.USER_MENU).toBe("user:menu");
    expect(Buffer.byteLength(CB.USER_MENU, "utf8")).toBeLessThanOrEqual(64);
  });

  it("6-8. the seeded default is exact; edited labels stay routable; duplicates are rejected", async () => {
    // 6. Seeded default value.
    const seed = INITIAL_BUTTON_TEXTS.find((b) => b.key === RETURN_KEY);
    expect(seed?.text).toBe(RETURN_LABEL);
    expect(await currentLabel(RETURN_KEY)).toBe(RETURN_LABEL);

    // 7. An edited label still resolves to the stable action; the old one stops.
    const rowId = await buttonRowId(RETURN_KEY);
    const edited = `خروج به منوی کاربر ${runTag}`;
    expect((await updateButtonText(rowId, edited, owner.id)).ok).toBe(true);
    clearTextCache();
    try {
      expect(await resolveAdminMainMenuAction(edited, owner)).toEqual({
        matched: true,
        authorized: true,
        action: "RETURN_TO_USER_MENU",
      });
      expect(await resolveAdminMainMenuAction(RETURN_LABEL, owner)).toEqual({ matched: false });
      // The edited label appears in BOTH renderers immediately.
      expect(inlineRows(await buildAdminMainKeyboard(owner)).at(-1)).toEqual([
        { label: edited, callback: CB.USER_MENU },
      ]);
      expect(replyRows(await buildAdminMainReplyKeyboard(owner)).at(-1)).toEqual([edited]);
    } finally {
      await updateButtonText(rowId, RETURN_LABEL, owner.id);
      clearTextCache();
    }

    // 8. The return key is in the admin duplicate-label scope: editing it to
    // another admin label (or vice-versa) is rejected.
    const financeLabel = await currentLabel("admin_finance");
    const dup = await updateButtonText(rowId, financeLabel, owner.id);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
    }
    expect(await currentLabel(RETURN_KEY)).toBe(RETURN_LABEL);
  });

  // --- Inline behavior (9-13) -----------------------------------------------------------------

  it("9-11. inline return opens the user menu through the existing gate, respecting the USER mode", async () => {
    // 9-10. User INLINE: CB.USER_MENU -> userAccessMiddleware -> showUserMenu
    // renders the inline user menu (viewer-aware admin row present for owner).
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const inlineUser = await createUser();
    const inlineCtx = fakeCallbackCtx(inlineUser.telegramId, CB.USER_MENU, {
      admin: owner,
      user: inlineUser,
    });
    await gatedUserArea().middleware()(inlineCtx.ctx, async () => {});
    expect(inlineCtx.sent).toHaveLength(1);
    expect(Array.isArray(markupOf(inlineCtx.sent[0]).inline_keyboard)).toBe(true);
    expect(inlineCtx.session.lastMenu).toBe("user_main");

    // 11. User REPLY: the same callback sends the persistent user reply keyboard.
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const replyUser = await createUser();
    const replyCtx = fakeCallbackCtx(replyUser.telegramId, CB.USER_MENU, {
      admin: owner,
      user: replyUser,
    });
    await gatedUserArea().middleware()(replyCtx.ctx, async () => {});
    expect(markupOf(replyCtx.sent[0]).is_persistent).toBe(true);
    expect(replyCtx.session.replyMenuKeyboardActive).toBe(true);
  });

  it("12. a normal user's forged CB.USER_MENU follows the normal gates (no admin escalation)", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    const ctx = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { user });
    await gatedUserArea().middleware()(ctx.ctx, async () => {});
    // It simply renders their own user menu - the admin row is NOT present.
    expect(ctx.sent).toHaveLength(1);
    expect(replyRows(markupOf(ctx.sent[0])).flat()).not.toContain("پنل مدیریت 🛠");
    expect(ctx.session.lastMenu).toBe("user_main");
  });

  it("13. /menu behavior is unchanged and reaches the SAME showUserMenu as the return button", async () => {
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const user = await createUser();
    const viaCommand = fakeCommandCtx(user.telegramId, "/menu", { admin: owner, user });
    await gatedUserArea().middleware()(viaCommand.ctx, async () => {});
    const viaButton = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { admin: owner, user });
    await gatedUserArea().middleware()(viaButton.ctx, async () => {});
    // Both render the user menu with identical keyboard structure.
    expect(viaCommand.session.lastMenu).toBe("user_main");
    expect(viaButton.session.lastMenu).toBe("user_main");
    const cmdFlat = inlineRows(
      markupOf(viaCommand.sent[0]) as { inline_keyboard: Array<Array<Record<string, unknown>>> },
    ).flat();
    const btnFlat = inlineRows(
      markupOf(viaButton.sent[0]) as { inline_keyboard: Array<Array<Record<string, unknown>>> },
    ).flat();
    expect(btnFlat).toEqual(cmdFlat);
    expect(btnFlat.map((b) => b.callback)).toContain(CB.ADMIN_MENU); // admin row for owner
  });

  // --- Reply behavior (14-20) -----------------------------------------------------------------

  it("14-15. the return label resolves to RETURN_TO_USER_MENU and the reply action reaches showUserMenu", async () => {
    // 14. Resolution (active admin).
    expect(await resolveAdminMainMenuAction(RETURN_LABEL, owner)).toEqual({
      matched: true,
      authorized: true,
      action: "RETURN_TO_USER_MENU",
    });
    // 15. REPLY router dispatch -> the user menu is rendered.
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const user = await createUser();
    const ctx = fakeTextCtx(user.telegramId, RETURN_LABEL, { admin: owner, user });
    const fellThrough = await runMenuRouters(ctx.ctx);
    expect(fellThrough).toBe(false); // the admin router consumed it
    expect(ctx.sent.length).toBeGreaterThan(0);
    expect(ctx.session.lastMenu).toBe("user_main");
  });

  it("16-17. arbitrary text and commands are never routed as the return action", async () => {
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    // 16. Arbitrary text falls through untouched.
    const arb = fakeTextCtx(owner.telegramId, `خروج ${runTag}`, { admin: owner });
    expect(await runMenuRouters(arb.ctx)).toBe(true);
    expect(arb.sent).toHaveLength(0);
    // 17. A command falls through (never intercepted by the router).
    const cmd = fakeTextCtx(owner.telegramId, "/menu", { admin: owner });
    let fellThrough = false;
    await adminMenuTextRouter.middleware()(cmd.ctx, async () => {
      fellThrough = true;
    });
    expect(fellThrough).toBe(true);
    expect(cmd.sent).toHaveLength(0);
  });

  it("18-19. a deactivated admin and a normal user get ONLY the denial for the return label", async () => {
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("INLINE"); // no shared user label for the return text
    clearSettingsCache();
    // 18. Deactivated admin with a stale admin reply keyboard: recognized, denied.
    const deactivated = fakeTextCtx(inactiveAdmin.telegramId, RETURN_LABEL, {
      admin: inactiveAdmin,
    });
    await adminMenuTextRouter.middleware()(deactivated.ctx, async () => {});
    expect(deactivated.sent).toHaveLength(1);
    expect(deactivated.sent[0].text).toBe(ADMIN_MENU_ACCESS_DENIED_TEXT);
    // 19. A normal user typing the admin return label gains NO admin access.
    const user = await createUser();
    const forged = fakeTextCtx(user.telegramId, RETURN_LABEL, { user });
    const fellThrough = await runMenuRouters(forged.ctx);
    expect(fellThrough).toBe(false);
    expect(forged.sent).toHaveLength(1);
    expect(forged.sent[0].text).toBe(ADMIN_MENU_ACCESS_DENIED_TEXT);
    expect(forged.sent.map((m) => m.text)).not.toContain(ADMIN_MENU_TEXT);
  });

  it("20. routing depends on the stable action, not the label: an edited label routes, the old stops", async () => {
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const rowId = await buttonRowId(RETURN_KEY);
    const edited = `بازگشت ${runTag}`;
    expect((await updateButtonText(rowId, edited, owner.id)).ok).toBe(true);
    clearTextCache();
    try {
      const editedCtx = fakeTextCtx(owner.telegramId, edited, { admin: owner });
      await adminMenuTextRouter.middleware()(editedCtx.ctx, async () => {});
      expect(editedCtx.session.lastMenu).toBe("user_main"); // edited label routes
      // The OLD label no longer routes (falls through / denied, never user menu).
      const oldCtx = fakeTextCtx(owner.telegramId, RETURN_LABEL, { admin: owner });
      const fellThrough = await runMenuRouters(oldCtx.ctx);
      expect(oldCtx.session.lastMenu).not.toBe("user_main");
      expect(fellThrough || oldCtx.sent.length > 0).toBe(true);
    } finally {
      await updateButtonText(rowId, RETURN_LABEL, owner.id);
      clearTextCache();
    }
  });

  // --- Transitions (21-28) --------------------------------------------------------------------

  it("21-22. Admin INLINE -> User INLINE / User REPLY render the correct user surface", async () => {
    await setAdminMenuMode("INLINE");
    // 21. Admin INLINE -> User INLINE (inline callback, no stale reply keyboard).
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const u1 = await createUser();
    const c1 = fakeCallbackCtx(u1.telegramId, CB.USER_MENU, { admin: owner, user: u1 });
    await gatedUserArea().middleware()(c1.ctx, async () => {});
    expect(Array.isArray(markupOf(c1.sent[0]).inline_keyboard)).toBe(true);
    expect(c1.session.replyMenuKeyboardActive ?? false).toBe(false);

    // 22. Admin INLINE -> User REPLY: persistent user keyboard is sent.
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const u2 = await createUser();
    const c2 = fakeCallbackCtx(u2.telegramId, CB.USER_MENU, { admin: owner, user: u2 });
    await gatedUserArea().middleware()(c2.ctx, async () => {});
    expect(markupOf(c2.sent[0]).is_persistent).toBe(true);
    expect(c2.session.replyMenuKeyboardActive).toBe(true);
    expect(c2.session.adminReplyMenuKeyboardActive).toBe(false);
  });

  it("23. Admin REPLY -> User INLINE removes the persistent admin keyboard exactly once", async () => {
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("REPLY"); // render admin reply first, then flip user to INLINE
    clearSettingsCache();
    const user = await createUser();
    // Enter the admin panel in REPLY mode: the admin persistent keyboard is up.
    const enter = fakeTextCtx(owner.telegramId, "/admin", { admin: owner, user });
    await showAdminMenu(enter.ctx);
    const session = enter.session;
    expect(session.adminReplyMenuKeyboardActive).toBe(true);

    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const back = fakeTextCtx(owner.telegramId, RETURN_LABEL, { admin: owner, user, session });
    await adminMenuTextRouter.middleware()(back.ctx, async () => {});
    // One removal notice with remove_keyboard, then the inline user menu.
    expect(back.sent[0].text).toBe(MENU_MODE_CHANGED_TEXT);
    expect(markupOf(back.sent[0]).remove_keyboard).toBe(true);
    expect(Array.isArray(markupOf(back.sent[1]).inline_keyboard)).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);
    expect(session.replyMenuKeyboardActive).toBe(false);
    expect(session.lastMenu).toBe("user_main");
  });

  it("24-26. Admin REPLY -> User REPLY replaces the admin keyboard; session flags + lastMenu are correct", async () => {
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    const enter = fakeTextCtx(owner.telegramId, "/admin", { admin: owner, user });
    await showAdminMenu(enter.ctx);
    const session = enter.session;
    expect(session.adminReplyMenuKeyboardActive).toBe(true);

    const back = fakeTextCtx(owner.telegramId, RETURN_LABEL, { admin: owner, user, session });
    await adminMenuTextRouter.middleware()(back.ctx, async () => {});
    // 24. Direct replacement: a single message, no removal notice.
    expect(back.sent).toHaveLength(1);
    expect(back.sent.map((m) => m.text)).not.toContain(MENU_MODE_CHANGED_TEXT);
    expect(markupOf(back.sent[0]).is_persistent).toBe(true);
    // 25. Session keyboard flags flipped to the user keyboard.
    expect(session.replyMenuKeyboardActive).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);
    // 26. lastMenu becomes user_main.
    expect(session.lastMenu).toBe("user_main");
  });

  it("27-28. after returning, an active admin sees پنل مدیریت 🛠 again; a deactivated one does not", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    // 27. Active admin viewer: the user reply menu carries the admin entry row.
    const activeReply = replyRows(await buildUserMainReplyKeyboard({ isActiveAdmin: true }));
    expect(activeReply.at(-1)).toEqual(["پنل مدیریت 🛠"]);
    const activeInline = inlineRows(await buildUserMainKeyboard({ isActiveAdmin: true }))
      .flat()
      .map((b) => b.callback);
    expect(activeInline).toContain(CB.ADMIN_MENU);
    // 28. Deactivated admin viewer (isActiveAdmin false): no admin entry row.
    expect(replyRows(await buildUserMainReplyKeyboard({ isActiveAdmin: false })).flat()).not.toContain(
      "پنل مدیریت 🛠",
    );
    expect(
      inlineRows(await buildUserMainKeyboard({ isActiveAdmin: false }))
        .flat()
        .map((b) => b.callback),
    ).not.toContain(CB.ADMIN_MENU);
  });

  // --- User-access gates (29-33): an active admin NEVER bypasses them --------------------------

  it("29. a blocked user-admin cannot bypass user blocking through the return button (both modes)", async () => {
    // An active admin whose USER account is BLOCKED.
    const blockedAdmin = await createAdmin({ role: "OWNER", isActive: true });
    const blockedUser = await createUser({
      telegramId: blockedAdmin.telegramId,
      status: "BLOCKED",
    });

    // Inline path: the gate denies before showUserMenu runs.
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const inline = fakeCallbackCtx(blockedAdmin.telegramId, CB.USER_MENU, {
      admin: blockedAdmin,
      user: blockedUser,
    });
    await gatedUserArea().middleware()(inline.ctx, async () => {});
    expect(inline.session.lastMenu).not.toBe("user_main");

    // Reply path: resolved as an active admin, but ensureUserAccess still gates.
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const reply = fakeTextCtx(blockedAdmin.telegramId, RETURN_LABEL, {
      admin: blockedAdmin,
      user: blockedUser,
    });
    await adminMenuTextRouter.middleware()(reply.ctx, async () => {});
    expect(reply.session.lastMenu).not.toBe("user_main");
    expect(reply.sent.map((m) => m.text)).not.toContain(ADMIN_MENU_TEXT);
  });

  it("30. maintenance mode blocks the return for an active admin (both modes)", async () => {
    await setSetting(MAINTENANCE_KEY, "true", "BOOLEAN");
    await setUserMenuMode("INLINE");
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const user = await createUser();
    const inline = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { admin: owner, user });
    await gatedUserArea().middleware()(inline.ctx, async () => {});
    expect(inline.session.lastMenu).not.toBe("user_main");
    const reply = fakeTextCtx(user.telegramId, RETURN_LABEL, { admin: owner, user });
    await adminMenuTextRouter.middleware()(reply.ctx, async () => {});
    expect(reply.session.lastMenu).not.toBe("user_main");
  });

  it("31. the terms gate blocks the return until accepted", async () => {
    await setSetting(TERMS_KEY, "true", "BOOLEAN");
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const user = await createUser({ termsAcceptedAt: null });
    const ctx = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { admin: owner, user });
    await gatedUserArea().middleware()(ctx.ctx, async () => {});
    expect(ctx.session.lastMenu).not.toBe("user_main");
    // The accept button is offered instead of the user menu.
    const flat = inlineRows(
      markupOf(ctx.sent.at(-1) as SentMessage) as {
        inline_keyboard: Array<Array<Record<string, unknown>>>;
      },
    ).flat();
    expect(flat.map((b) => b.callback)).toContain(CB.TERMS_ACCEPT);
  });

  it("32. the force-join gate blocks the return until joined", async () => {
    await setSetting(FORCE_JOIN_KEY, "true", "BOOLEAN");
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const user = await createUser({ forceJoinBypass: false });
    const ctx = fakeCallbackCtx(user.telegramId, CB.USER_MENU, { admin: owner, user });
    await gatedUserArea().middleware()(ctx.ctx, async () => {});
    expect(ctx.session.lastMenu).not.toBe("user_main");
    const flat = inlineRows(
      markupOf(ctx.sent.at(-1) as SentMessage) as {
        inline_keyboard: Array<Array<Record<string, unknown>>>;
      },
    ).flat();
    expect(flat.map((b) => b.callback)).toContain(CB.FORCE_JOIN_CHECK);
  });

  it("33. /admin remains independently available to an active admin regardless of user gates", async () => {
    // Maintenance ON + a blocked user row: the admin area is independent.
    await setSetting(MAINTENANCE_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    const admin = await createAdmin({ role: "OWNER", isActive: true });
    const blocked = await createUser({ telegramId: admin.telegramId, status: "BLOCKED" });
    const ctx = fakeCommandCtx(admin.telegramId, "/admin", { admin, user: blocked });
    await gatedAdminArea().middleware()(ctx.ctx, async () => {});
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].text).toBe(ADMIN_MENU_TEXT);
    expect(ctx.session.lastMenu).toBe("admin_main");
  });

  // --- Flow priority (34-39): the return label is ordinary input during a flow ----------------

  it("34-39. an active flow is never interrupted by the return label", async () => {
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const flows = [
      "product:create:name", // 34. product wizard
      "panel:add:url", // 35. panel input
      "broadcast:compose", // 36. broadcast input
      "stock:import", // 37. stock import
      "reports_backup:schedule:hour", // 38. backup schedule input
      "customer_input:form", // 39. customer-information form
    ];
    for (const flow of flows) {
      const ctx = fakeTextCtx(owner.telegramId, RETURN_LABEL, { admin: owner });
      ctx.session.currentFlow = flow;
      // The reply-menu routers run AFTER the flow dispatcher, and each checks
      // currentFlow !== null first: the label falls through as ordinary input.
      const fellThrough = await runMenuRouters(ctx.ctx);
      expect(fellThrough, flow).toBe(true);
      expect(ctx.sent, flow).toHaveLength(0);
      expect(ctx.session.lastMenu, flow).not.toBe("user_main");
    }
  });
});

describe.skipIf(hasDb)("return to user menu from the admin panel (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
