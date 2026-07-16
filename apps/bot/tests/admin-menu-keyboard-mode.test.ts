import { prisma, type Admin, type User } from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "admin-menu-keyboard-mode-tests-secret-01";

import { CB } from "../src/core/callbacks.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { ADMIN_MENU_TEXT, showAdminMenu } from "../src/handlers/admin.handler.js";
import {
  ADMIN_MENU_ACCESS_DENIED_TEXT,
  adminMenuTextRouter,
} from "../src/handlers/admin-menu-actions.js";
import { adminTextSettingsHandler } from "../src/handlers/admin-settings/text-settings.handler.js";
import { MENU_MODE_CHANGED_TEXT, showUserMenu } from "../src/handlers/menu.handler.js";
import { userMenuTextRouter } from "../src/handlers/user-menu-actions.js";
import { buildAdminMainKeyboard } from "../src/keyboards/admin-main.keyboard.js";
import {
  ADMIN_MAIN_MENU_ACTION_WIRING,
  buildAdminMainMenuDefinition,
  buildAdminMainReplyKeyboard,
  resolveAdminMainMenuAction,
} from "../src/keyboards/admin-menu-definition.js";
import { buildUserMainMenuDefinition } from "../src/keyboards/user-menu-definition.js";
import {
  DUPLICATE_MAIN_MENU_LABEL_TEXT,
  updateButtonText,
} from "../src/services/admin-text-settings.service.js";
import {
  ADMIN_MENU_MODE_KEY,
  getAdminMenuMode,
  getUserMenuMode,
  MENU_MODE_LABELS,
  setAdminMenuMode,
  setUserMenuMode,
  USER_MENU_MODE_KEY,
} from "../src/services/menu-mode.service.js";
import { setFreeTrialEnabled } from "../src/services/free-trial-settings.service.js";
import {
  clearSettingsCache,
  deleteSetting,
  setSetting,
} from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// feat/configurable-admin-menu-keyboard: the INDEPENDENT admin main-menu
// keyboard mode next to the user one (4 combinations), the ONE shared admin
// menu definition consumed by both renderers, ButtonText-based admin reply
// routing where a label match NEVER authorizes anything, the per-menu
// duplicate-label guard, cross-menu persistent-keyboard replacement/removal
// and the combined «نوع نمایش منوها» settings page. Requires real PostgreSQL
// (ButtonText/Setting/Admin rows); skips without it (docs/testing.md).
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

/** The historical hardcoded admin inline menu - now the seeded defaults. */
const HISTORICAL_ADMIN_ROWS: Array<Array<{ label: string; callback: string }>> = [
  [
    { label: "مالی 💎", callback: CB.ADMIN_FINANCE },
    { label: "مدیریت کاربران 👤", callback: CB.ADMIN_USERS },
  ],
  [
    { label: "مدیریت محصولات/پلن‌ها 📦", callback: CB.ADMIN_PRODUCTS },
    { label: "مدیریت پنل‌ها 🖥", callback: CB.ADMIN_PANELS },
  ],
  [{ label: "محصولات دیگر / سفارش‌های محصولات دیگر", callback: CB.ADMIN_OTHER_PRODUCTS }],
  [
    { label: "تیکت‌های پشتیبانی 🎫", callback: CB.ADMIN_SUPPORT },
    { label: "پیام همگانی 📣", callback: CB.ADMIN_BROADCAST },
  ],
  [
    { label: "تنظیمات عمومی ⚙️", callback: CB.ADMIN_GENERAL_SETTINGS },
    { label: "گزارشات / بکاپ 📊", callback: CB.ADMIN_REPORTS_BACKUP },
  ],
];

const ADMIN_BUTTON_SEEDS: Record<string, string> = Object.fromEntries(
  HISTORICAL_ADMIN_ROWS.flat().map(({ label, callback }) => {
    const entry = Object.values(ADMIN_MAIN_MENU_ACTION_WIRING).find(
      (w) => w.callback === callback,
    );
    if (entry === undefined) {
      throw new Error(`no wiring for callback ${callback}`);
    }
    return [entry.buttonKey, label];
  }),
);

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

/** Minimal BotContext stand-in for text updates (no callback query). */
function fakeTextCtx(
  telegramId: bigint,
  text: string,
  options: { admin?: Admin | null; user?: User | null; session?: SessionData } = {},
) {
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

/** Minimal BotContext stand-in for callback-query updates. */
function fakeCallbackCtx(
  telegramId: bigint,
  data: string,
  options: { admin?: Admin | null; session?: SessionData } = {},
) {
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
    dbUser: null,
    admin: options.admin ?? null,
    from: { id: Number(telegramId), first_name: "Tester" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
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

async function dispatchSettingsCallback(ctx: never): Promise<void> {
  await adminTextSettingsHandler.middleware()(ctx, async () => {});
}

async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
}

async function createAdmin(overrides: Record<string, unknown> = {}): Promise<Admin> {
  seq += 1;
  return prisma.admin.create({
    data: { telegramId: runTag + 800_000_000n + BigInt(seq), role: "SUPPORT", ...overrides },
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

describe.runIf(hasDb)("admin main-menu keyboard mode", () => {
  let owner: Admin;
  let inactiveAdmin: Admin;

  beforeAll(async () => {
    owner = await createAdmin({ role: "OWNER", isActive: true });
    inactiveAdmin = await createAdmin({ role: "SUPPORT", isActive: false });
    // The registry rows the routing/edit tests rely on. Same shape as
    // packages/database seed; never clobbers operator edits on re-run -
    // afterAll resets them to defaults for the next suite.
    for (const [key, text] of Object.entries(ADMIN_BUTTON_SEEDS)) {
      await prisma.buttonText.upsert({
        where: { key },
        create: { key, title: `منوی ادمین: ${key}`, defaultText: text, currentText: text },
        update: {},
      });
    }
    await setFreeTrialEnabled(false);
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
    for (const [key, text] of Object.entries(ADMIN_BUTTON_SEEDS)) {
      await prisma.buttonText.updateMany({ where: { key }, data: { currentText: text } });
    }
    await prisma.$disconnect();
  });

  // --- setting semantics + independence (1-7) -------------------------------------------------

  it("1-7. both settings default INLINE, fail closed and stay fully independent", async () => {
    // 1. Absent rows (existing installations) -> INLINE for BOTH.
    expect(await getAdminMenuMode()).toBe("INLINE");
    expect(await getUserMenuMode()).toBe("INLINE");
    // 2-3. Switchable and idempotent.
    await setAdminMenuMode("REPLY");
    expect(await getAdminMenuMode()).toBe("REPLY");
    await setAdminMenuMode("INLINE");
    await setAdminMenuMode("INLINE");
    expect(await getAdminMenuMode()).toBe("INLINE");
    // 4. Garbage values resolve to INLINE, never crash.
    await setSetting(ADMIN_MENU_MODE_KEY, "GARBAGE", "STRING");
    clearSettingsCache();
    expect(await getAdminMenuMode()).toBe("INLINE");
    // 5. Changing the admin mode never touches the user mode.
    await setAdminMenuMode("REPLY");
    expect(await getUserMenuMode()).toBe("INLINE");
    // 6. Changing the user mode never touches the admin mode.
    await setUserMenuMode("REPLY");
    await setAdminMenuMode("INLINE");
    expect(await getUserMenuMode()).toBe("REPLY");
    // 7. Every combination is representable.
    for (const userMode of ["INLINE", "REPLY"] as const) {
      for (const adminMode of ["INLINE", "REPLY"] as const) {
        await setUserMenuMode(userMode);
        await setAdminMenuMode(adminMode);
        expect([await getUserMenuMode(), await getAdminMenuMode()]).toEqual([
          userMode,
          adminMode,
        ]);
      }
    }
  });

  // --- shared definition + renderer parity (8-16) ---------------------------------------------

  it("8-13. inline layout is the historical contract; reply keyboard mirrors it exactly", async () => {
    // 8-9. Exact approved rows: labels AND stable callbacks, in order.
    const inline = inlineRows(await buildAdminMainKeyboard(owner));
    expect(inline).toEqual(HISTORICAL_ADMIN_ROWS);

    // 10-11. The reply rendering: same rows/labels, no callback data at all.
    const reply = await buildAdminMainReplyKeyboard(owner);
    expect(replyRows(reply)).toEqual(
      HISTORICAL_ADMIN_ROWS.map((row) => row.map((b) => b.label)),
    );
    expect(JSON.stringify(reply)).not.toContain("callback_data");

    // 12. Persistent, resized, not one-time.
    const markup = reply as unknown as {
      resize_keyboard?: boolean;
      is_persistent?: boolean;
      one_time_keyboard?: boolean;
    };
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.is_persistent).toBe(true);
    expect(markup.one_time_keyboard ?? false).toBe(false);

    // 13. Telegram-practical label bound.
    for (const row of replyRows(reply)) {
      for (const label of row) {
        expect(label.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it("14-16. visibility policy: no admin -> no menu; label edits hit BOTH renderers", async () => {
    // 14. Null admin: both renderers are empty.
    expect(await buildAdminMainMenuDefinition(null)).toEqual([]);
    expect((await buildAdminMainKeyboard(null)).inline_keyboard).toEqual([]);
    expect(replyRows(await buildAdminMainReplyKeyboard(null))).toEqual([]);
    // 15. Deactivated admin: equally empty (stale keyboards route to denial).
    expect(await buildAdminMainMenuDefinition(inactiveAdmin)).toEqual([]);

    // 16. An operator label edit appears in BOTH renderers immediately.
    const broadcastId = await buttonRowId("admin_broadcast");
    const original = await currentLabel("admin_broadcast");
    const edited = `اعلان سراسری ${runTag}`;
    const outcome = await updateButtonText(broadcastId, edited, owner.id);
    expect(outcome.ok).toBe(true);
    clearTextCache();
    try {
      const inline = inlineRows(await buildAdminMainKeyboard(owner)).flat();
      expect(inline.some((b) => b.label === edited && b.callback === CB.ADMIN_BROADCAST)).toBe(
        true,
      );
      expect(replyRows(await buildAdminMainReplyKeyboard(owner)).flat()).toContain(edited);
    } finally {
      await updateButtonText(broadcastId, original, owner.id);
      clearTextCache();
    }
  });

  // --- resolution + authorization (17-24) -----------------------------------------------------

  it("17-19. labels resolve to stable actions; edited labels keep routing", async () => {
    // 17. Every visible label resolves to its wired action for an active admin.
    const definition = await buildAdminMainMenuDefinition(owner);
    expect(definition.flat()).toHaveLength(9);
    for (const button of definition.flat()) {
      expect(await resolveAdminMainMenuAction(button.label, owner)).toEqual({
        matched: true,
        authorized: true,
        action: button.action,
      });
      expect(ADMIN_MAIN_MENU_ACTION_WIRING[button.action].buttonKey).toBe(button.buttonKey);
    }
    // 18. Unknown text, commands and empty text never match.
    expect(await resolveAdminMainMenuAction(`متن دلخواه ${runTag}`, owner)).toEqual({
      matched: false,
    });
    expect(await resolveAdminMainMenuAction("/admin", owner)).toEqual({ matched: false });
    expect(await resolveAdminMainMenuAction("   ", owner)).toEqual({ matched: false });

    // 19. Edited label routes; the old label stops routing.
    const usersId = await buttonRowId("admin_users");
    const original = await currentLabel("admin_users");
    const edited = `اعضا ${runTag}`;
    expect((await updateButtonText(usersId, edited, owner.id)).ok).toBe(true);
    clearTextCache();
    try {
      expect(await resolveAdminMainMenuAction(edited, owner)).toEqual({
        matched: true,
        authorized: true,
        action: "USERS",
      });
      expect(await resolveAdminMainMenuAction(original, owner)).toEqual({ matched: false });
    } finally {
      await updateButtonText(usersId, original, owner.id);
      clearTextCache();
    }
  });

  it("20-21. duplicates are rejected per menu; the SAME label may exist in both menus", async () => {
    // 20. Two ADMIN main-menu buttons may never share a label.
    const usersId = await buttonRowId("admin_users");
    const financeLabel = await currentLabel("admin_finance");
    const dup = await updateButtonText(usersId, financeLabel, owner.id);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
    }
    expect(await currentLabel("admin_users")).not.toBe(financeLabel);

    // 21. User menu and admin menu are separate scopes: an admin button MAY
    // carry a user main-menu label (the routers keep contexts apart).
    const userDefinition = await buildUserMainMenuDefinition();
    const userLabel = userDefinition.flat()[0].label;
    const supportId = await buttonRowId("admin_support_tickets");
    const originalSupport = await currentLabel("admin_support_tickets");
    const cross = await updateButtonText(supportId, userLabel, owner.id);
    expect(cross.ok).toBe(true);
    clearTextCache();
    await updateButtonText(supportId, originalSupport, owner.id);
    clearTextCache();
  });

  it("22-24. a label match NEVER authorizes: non-admins and deactivated admins are refused", async () => {
    const financeLabel = await currentLabel("admin_finance");
    // 22. Non-admin sender: recognized but NOT authorized.
    expect(await resolveAdminMainMenuAction(financeLabel, null)).toEqual({
      matched: true,
      authorized: false,
    });
    // 23. Deactivated admin (stale persistent keyboard): recognized, refused.
    expect(await resolveAdminMainMenuAction(financeLabel, inactiveAdmin)).toEqual({
      matched: true,
      authorized: false,
    });
    // 24. User main-menu labels never match the ADMIN resolver.
    const userDefinition = await buildUserMainMenuDefinition();
    for (const button of userDefinition.flat()) {
      expect(await resolveAdminMainMenuAction(button.label, owner)).toEqual({ matched: false });
    }
  });

  // --- the admin reply-text router (25-33) ----------------------------------------------------

  it("25-28. priority: flows and commands first; INLINE mode never routes; REPLY routes admins", async () => {
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const financeLabel = await currentLabel("admin_finance");

    // 25. Active conversational flow: text falls through untouched.
    for (const flow of ["support:message", "admin_texts:button", "checkout:discount"]) {
      const { ctx, sent, session } = fakeTextCtx(owner.telegramId, financeLabel, {
        admin: owner,
      });
      session.currentFlow = flow;
      let fellThrough = false;
      await adminMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // 26. Commands always fall through.
    {
      const { ctx, sent } = fakeTextCtx(owner.telegramId, "/admin", { admin: owner });
      let fellThrough = false;
      await adminMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // 27. INLINE admin mode: labels fall through even for active admins.
    await setAdminMenuMode("INLINE");
    clearSettingsCache();
    {
      const { ctx, sent } = fakeTextCtx(owner.telegramId, financeLabel, { admin: owner });
      let fellThrough = false;
      await adminMenuTextRouter.middleware()(ctx, async () => {
        fellThrough = true;
      });
      expect(fellThrough).toBe(true);
      expect(sent).toHaveLength(0);
    }

    // 28. REPLY + active admin + no flow: the label opens the finance
    // landing - an INLINE page (sensitive surfaces stay inline in REPLY mode).
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    {
      const { ctx, sent, session } = fakeTextCtx(owner.telegramId, financeLabel, {
        admin: owner,
      });
      await adminMenuTextRouter.middleware()(ctx, async () => {});
      expect(sent.length).toBeGreaterThan(0);
      expect(
        Array.isArray((sent[0].other?.reply_markup as Record<string, unknown>)?.inline_keyboard),
      ).toBe(true);
      expect(session.lastMenu).toBe(CB.ADMIN_FINANCE);
    }
  });

  it("29-30. every approved action dispatches to its section; arbitrary text falls through", async () => {
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    // 29. All 9 labels render their section landing (same entries the inline
    // callbacks use).
    const definition = await buildAdminMainMenuDefinition(owner);
    for (const button of definition.flat()) {
      const { ctx, sent } = fakeTextCtx(owner.telegramId, button.label, { admin: owner });
      await adminMenuTextRouter.middleware()(ctx, async () => {});
      expect(sent.length, `action ${button.action} must render`).toBeGreaterThan(0);
      expect(sent[0].text.length).toBeGreaterThan(0);
    }
    // 30. Arbitrary text falls through silently.
    const { ctx, sent } = fakeTextCtx(owner.telegramId, `متن آزاد ${runTag}`, { admin: owner });
    let fellThrough = false;
    await adminMenuTextRouter.middleware()(ctx, async () => {
      fellThrough = true;
    });
    expect(fellThrough).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("31-33. unauthorized senders get ONLY the denial; shared labels stay user actions", async () => {
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const financeLabel = await currentLabel("admin_finance");

    // 31. Plain user sends an admin label: exact denial, nothing else.
    const user = await createUser();
    {
      const { ctx, sent } = fakeTextCtx(user.telegramId, financeLabel, { user });
      const fellThrough = await runMenuRouters(ctx as never);
      expect(fellThrough).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe(ADMIN_MENU_ACCESS_DENIED_TEXT);
      expect(sent[0].other).toBeUndefined(); // no keyboard, no admin content
    }

    // 32. Deactivated admin with the stale persistent keyboard: same denial.
    {
      const { ctx, sent } = fakeTextCtx(inactiveAdmin.telegramId, financeLabel, {
        admin: inactiveAdmin,
      });
      await adminMenuTextRouter.middleware()(ctx, async () => {});
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe(ADMIN_MENU_ACCESS_DENIED_TEXT);
    }

    // 33. An admin label that ALSO is a live user-menu label keeps working
    // as the USER action for non-admins while the user menu is REPLY...
    const userDefinition = await buildUserMainMenuDefinition();
    const sharedLabel = userDefinition.flat()[0].label;
    const supportId = await buttonRowId("admin_support_tickets");
    const originalSupport = await currentLabel("admin_support_tickets");
    expect((await updateButtonText(supportId, sharedLabel, owner.id)).ok).toBe(true);
    clearTextCache();
    try {
      await setUserMenuMode("REPLY");
      clearSettingsCache();
      {
        const { ctx, sent } = fakeTextCtx(user.telegramId, sharedLabel, { user });
        await runMenuRouters(ctx as never);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.map((m) => m.text)).not.toContain(ADMIN_MENU_ACCESS_DENIED_TEXT);
      }
      // ...and is denied when the user menu is INLINE (no user context).
      await setUserMenuMode("INLINE");
      clearSettingsCache();
      {
        const { ctx, sent } = fakeTextCtx(user.telegramId, sharedLabel, { user });
        await runMenuRouters(ctx as never);
        expect(sent).toHaveLength(1);
        expect(sent[0].text).toBe(ADMIN_MENU_ACCESS_DENIED_TEXT);
      }
    } finally {
      await updateButtonText(supportId, originalSupport, owner.id);
      clearTextCache();
    }
  });

  // --- menu rendering + cross-menu transitions (34-38) ----------------------------------------

  it("34-35. /admin renders the configured mode; INLINE removes a stale keyboard exactly once", async () => {
    // 34. REPLY mode: fresh message with the persistent admin keyboard.
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const { ctx, sent, session } = fakeTextCtx(owner.telegramId, "/admin", { admin: owner });
    await showAdminMenu(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(ADMIN_MENU_TEXT);
    const markup = sent[0].other?.reply_markup as Record<string, unknown>;
    expect(markup.is_persistent).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(true);
    expect(session.replyMenuKeyboardActive).toBe(false);

    // 35. Back to INLINE: one removal notice, then the inline menu - and no
    // repeated notice on the next render.
    await setAdminMenuMode("INLINE");
    clearSettingsCache();
    const second = fakeTextCtx(owner.telegramId, "/admin", { admin: owner, session });
    await showAdminMenu(second.ctx);
    expect(second.sent[0].text).toBe(MENU_MODE_CHANGED_TEXT);
    expect(
      (second.sent[0].other?.reply_markup as Record<string, unknown>).remove_keyboard,
    ).toBe(true);
    expect(
      Array.isArray(
        (second.sent[1].other?.reply_markup as Record<string, unknown>).inline_keyboard,
      ),
    ).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);

    const third = fakeTextCtx(owner.telegramId, "/admin", { admin: owner, session });
    await showAdminMenu(third.ctx);
    expect(third.sent).toHaveLength(1); // no second transition notice
  });

  it("36-38. user/admin REPLY keyboards replace each other; user INLINE clears the admin one", async () => {
    const user = await createUser();

    // 36. Admin REPLY keyboard up -> user REPLY menu REPLACES it silently.
    await setAdminMenuMode("REPLY");
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const adminRender = fakeTextCtx(owner.telegramId, "/admin", { admin: owner });
    await showAdminMenu(adminRender.ctx);
    const session = adminRender.session;
    expect(session.adminReplyMenuKeyboardActive).toBe(true);

    const userRender = fakeTextCtx(owner.telegramId, "/menu", { user, session });
    await showUserMenu(userRender.ctx);
    expect(userRender.sent).toHaveLength(1); // no removal notice - direct replacement
    expect(userRender.sent.map((m) => m.text)).not.toContain(MENU_MODE_CHANGED_TEXT);
    expect(session.replyMenuKeyboardActive).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);

    // 37. And back: the admin REPLY menu replaces the user keyboard.
    const backToAdmin = fakeTextCtx(owner.telegramId, "/admin", { admin: owner, session });
    await showAdminMenu(backToAdmin.ctx);
    expect(backToAdmin.sent).toHaveLength(1);
    expect(session.adminReplyMenuKeyboardActive).toBe(true);
    expect(session.replyMenuKeyboardActive).toBe(false);

    // 38. User menu INLINE while the ADMIN reply keyboard is up: removed once.
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const inlineUser = fakeTextCtx(owner.telegramId, "/menu", { user, session });
    await showUserMenu(inlineUser.ctx);
    expect(inlineUser.sent[0].text).toBe(MENU_MODE_CHANGED_TEXT);
    expect(
      (inlineUser.sent[0].other?.reply_markup as Record<string, unknown>).remove_keyboard,
    ).toBe(true);
    expect(session.adminReplyMenuKeyboardActive).toBe(false);
    expect(session.replyMenuKeyboardActive).toBe(false);
  });

  // --- the combined «نوع نمایش منوها» settings page (39-41) ------------------------------------

  it("39. overview + scope pages show current modes; forged callbacks change nothing", async () => {
    // Overview: both current modes, both scope entries, back to settings.
    const { ctx, sent } = fakeCallbackCtx(owner.telegramId, "admin:menu_mode", {
      admin: owner,
    });
    await dispatchSettingsCallback(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(
      "نوع نمایش منوها\n\n" +
        `منوی کاربر:\n${MENU_MODE_LABELS.INLINE}\n\n` +
        `منوی ادمین:\n${MENU_MODE_LABELS.INLINE}`,
    );
    const overviewButtons = inlineRows(
      sent[0].other?.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> },
    ).flat();
    expect(overviewButtons).toEqual([
      { label: "تنظیم منوی کاربران", callback: "admin:menu_mode:user" },
      { label: "تنظیم منوی ادمین", callback: "admin:menu_mode:admin" },
      { label: "بازگشت به تنظیمات عمومی", callback: "admin:general_settings" },
    ]);

    // Scope pages: exact title + current mode + the two choices.
    await setAdminMenuMode("REPLY");
    clearSettingsCache();
    const adminPage = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:admin", {
      admin: owner,
    });
    await dispatchSettingsCallback(adminPage.ctx);
    expect(adminPage.sent[0].text).toBe(
      `نوع نمایش منوی ادمین\n\nنوع فعلی:\n${MENU_MODE_LABELS.REPLY}`,
    );
    const scopeButtons = inlineRows(
      adminPage.sent[0].other?.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>;
      },
    ).flat();
    expect(scopeButtons.map((b) => b.callback)).toEqual([
      "admin:menu_mode:ask:admin:inline",
      "admin:menu_mode:ask:admin:reply",
      "admin:menu_mode",
    ]);

    // Forged callback without an admin: nothing renders, nothing changes.
    const forged = fakeCallbackCtx(runTag + 999n, "admin:menu_mode:set:admin:inline", {
      admin: null,
    });
    await dispatchSettingsCallback(forged.ctx);
    expect(forged.sent).toHaveLength(0);
    expect(forged.toasts).toHaveLength(0);
    clearSettingsCache();
    expect(await getAdminMenuMode()).toBe("REPLY");
  });

  it("40. ask -> confirm -> set flips ONLY the chosen scope, with the exact Persian texts", async () => {
    // Ask for admin REPLY: the exact confirmation with تایید/انصراف.
    const ask = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:ask:admin:reply", {
      admin: owner,
    });
    await dispatchSettingsCallback(ask.ctx);
    expect(ask.sent[0].text).toBe("آیا منوی ادمین به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟");
    const confirmButtons = inlineRows(
      ask.sent[0].other?.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>;
      },
    ).flat();
    expect(confirmButtons).toEqual([
      { label: "تایید ✅", callback: "admin:menu_mode:set:admin:reply" },
      { label: "انصراف", callback: "admin:menu_mode:admin" },
    ]);

    // Confirm: the admin setting flips, the USER setting stays untouched.
    const set = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:set:admin:reply", {
      admin: owner,
    });
    await dispatchSettingsCallback(set.ctx);
    expect(set.toasts).toContain("نوع نمایش منوی ادمین با موفقیت تغییر کرد ✅");
    clearSettingsCache();
    expect(await getAdminMenuMode()).toBe("REPLY");
    expect(await getUserMenuMode()).toBe("INLINE");

    // The user scope has its own confirmation and success texts.
    const askUser = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:ask:user:reply", {
      admin: owner,
    });
    await dispatchSettingsCallback(askUser.ctx);
    expect(askUser.sent[0].text).toBe(
      "آیا منوی کاربر به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟",
    );
    const setUser = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:set:user:reply", {
      admin: owner,
    });
    await dispatchSettingsCallback(setUser.ctx);
    expect(setUser.toasts).toContain("نوع نمایش منوی کاربر با موفقیت تغییر کرد ✅");
    clearSettingsCache();
    expect(await getUserMenuMode()).toBe("REPLY");
    expect(await getAdminMenuMode()).toBe("REPLY");
  });

  it("41. selecting the already-active mode is a guarded no-op", async () => {
    // Ask for the current mode: only the toast, no confirmation page.
    const ask = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:ask:admin:inline", {
      admin: owner,
    });
    await dispatchSettingsCallback(ask.ctx);
    expect(ask.toasts).toContain("این نوع نمایش از قبل فعال است.");
    expect(ask.sent).toHaveLength(0);

    // A (stale) set for the current mode: toast + page refresh, no write.
    const set = fakeCallbackCtx(owner.telegramId, "admin:menu_mode:set:admin:inline", {
      admin: owner,
    });
    await dispatchSettingsCallback(set.ctx);
    expect(set.toasts).toContain("این نوع نمایش از قبل فعال است.");
    clearSettingsCache();
    expect(await getAdminMenuMode()).toBe("INLINE");
  });
});

describe.skipIf(hasDb)("admin main-menu keyboard mode (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
