import { type Admin, prisma } from "@zedbot/database";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "force-join-admin-tests-secret";

import { initialSession } from "../src/core/session.js";
import {
  forceJoinAdminHandler,
  forceJoinAdminTextHandler,
  forceJoinChatSharedHandler,
} from "../src/handlers/admin-settings/force-join-admin.handler.js";
import {
  FORCE_JOIN_ENABLED_KEY,
  createOrRebindChannel,
  disableForceJoin,
  listAllChannels,
} from "../src/services/force-join/force-join-channel.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Phase 7 — force-join OWNER admin UI (§6): OWNER guard, add public/private
// (request_chat picker + chat_shared verification T3/T4), toggle + D3 combined
// action, enable/disable, delete-confirm, reply-keyboard removal (T1), and the
// invariant that the Telegram chat id never appears in any rendered surface.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const BOT_ID = 4_242_000_777;
const RUN_TAG = Date.now();
let seq = 0;
function nextChatId(): bigint {
  seq += 1;
  return -(1_000_000_000_000n + BigInt(RUN_TAG % 1_000_000_000) * 10n + BigInt(seq));
}

const OWNER: Admin = { id: "fj-owner-admin", role: "OWNER", isActive: true, telegramId: 555_000_1n } as unknown as Admin;
const SELLER: Admin = { id: "fj-seller-admin", role: "SELLER", isActive: true, telegramId: 555_000_2n } as unknown as Admin;

interface Recorders {
  sent: Array<{ text: string; other?: Record<string, unknown> }>;
  toasts: Array<string | undefined>;
}

interface ApiConfig {
  getChat?: { id: number; type: string; title?: string; username?: string } | "throw-notfound" | "throw-temp";
  botStatus?: string;
}

function makeApi(config: ApiConfig, rec: { getChatMemberCalls: number }) {
  return {
    getMe: vi.fn(async () => ({ id: BOT_ID })),
    getChat: vi.fn(async () => {
      if (config.getChat === "throw-notfound") throw { error_code: 400, description: "Bad Request: chat not found" };
      if (config.getChat === "throw-temp") throw { error_code: 429, description: "Too Many Requests" };
      return config.getChat ?? { id: -1001, type: "channel", title: "T", username: "chan" };
    }),
    getChatMember: vi.fn(async () => {
      rec.getChatMemberCalls += 1;
      return { status: config.botStatus ?? "administrator" };
    }),
  };
}

function baseCtx(admin: Admin | null, session: ReturnType<typeof initialSession>, api: ReturnType<typeof makeApi>, rec: Recorders) {
  return {
    admin,
    session,
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    api,
    reply: async (text: string, other?: Record<string, unknown>) => {
      rec.sent.push({ text, other });
      return {};
    },
    editMessageText: async (text: string, other?: Record<string, unknown>) => {
      rec.sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      rec.toasts.push(payload?.text);
      return true;
    },
  };
}

function callbackCtx(data: string, admin: Admin | null, session = initialSession(), config: ApiConfig = {}) {
  const rec: Recorders = { sent: [], toasts: [] };
  const apiRec = { getChatMemberCalls: 0 };
  const api = makeApi(config, apiRec);
  const callback_query = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    data,
    message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    ...baseCtx(admin, session, api, rec),
    callbackQuery: callback_query,
    update: { update_id: 1, callback_query },
  };
  return { ctx: ctx as never, rec, api, session };
}

function textCtx(text: string, admin: Admin | null, session = initialSession(), config: ApiConfig = {}) {
  const rec: Recorders = { sent: [], toasts: [] };
  const api = makeApi(config, { getChatMemberCalls: 0 });
  const message = {
    message_id: 2,
    date: 0,
    chat: { id: Number(admin?.telegramId ?? 999n), type: "private" },
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    text,
  };
  const ctx = { ...baseCtx(admin, session, api, rec), message, update: { update_id: 2, message } };
  return { ctx: ctx as never, rec, api, session };
}

function chatSharedCtx(
  shared: { request_id: number; chat_id: number },
  admin: Admin | null,
  session: ReturnType<typeof initialSession>,
  config: ApiConfig = {},
) {
  const rec: Recorders = { sent: [], toasts: [] };
  const api = makeApi(config, { getChatMemberCalls: 0 });
  const message = {
    message_id: 3,
    date: 0,
    chat: { id: Number(admin?.telegramId ?? 999n), type: "private" },
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    chat_shared: shared,
  };
  const ctx = { ...baseCtx(admin, session, api, rec), message, update: { update_id: 3, message } };
  return { ctx: ctx as never, rec, api, session };
}

const noop = async (): Promise<void> => {};
const runCb = (c: { ctx: never }) => forceJoinAdminHandler.middleware()(c.ctx, noop);
const runText = (c: { ctx: never }) => forceJoinAdminTextHandler.middleware()(c.ctx, noop);
const runShared = (c: { ctx: never }) => forceJoinChatSharedHandler.middleware()(c.ctx, noop);

function lastText(rec: Recorders): string {
  return rec.sent.at(-1)?.text ?? "";
}
function allText(rec: Recorders): string {
  return rec.sent.map((s) => s.text).join("\n") + "\n" + rec.toasts.join("\n");
}

describe.runIf(hasDb)("force-join OWNER admin UI (§6)", () => {
  beforeEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await disableForceJoin();
    clearSettingsCache();
    clearTextCache();
    seq += 1;
  });

  afterEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("denies a non-OWNER admin and makes no change", async () => {
    const c = callbackCtx("admin:force_join:root", SELLER);
    await runCb(c);
    expect(c.rec.toasts).toContain("این بخش فقط برای مالک ربات در دسترس است.");
  });

  it("adds a public channel via getChat and shows it in the overview (active)", async () => {
    const session = initialSession();
    // Open Add -> arms the flow.
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    expect(session.currentFlow).toBe("force_join:add");
    // Send the link.
    const t = textCtx("@ZedProxy", OWNER, session, {
      getChat: { id: -1009, type: "channel", title: "ZED", username: "ZedProxy" },
      botStatus: "administrator",
    });
    await runText(t);
    const rows = await listAllChannels();
    expect(rows.length).toBe(1);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].publicUsername).toBe("zedproxy");
    expect(rows[0].isPrivate).toBe(false);
    expect(session.currentFlow).toBeNull();
    // The overview never shows the chat id.
    expect(allText(t.rec)).not.toContain("-1009");
  });

  it("rejects a public add when the bot is not an admin (exact §4.3 message)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    const t = textCtx("@somechan", OWNER, session, {
      getChat: { id: -1002, type: "channel", title: "X", username: "somechan" },
      botStatus: "member",
    });
    await runText(t);
    expect(lastText(t.rec)).toBe("ابتدا ربات را در کانال ادمین کنید و دوباره تلاش کنید.");
    expect((await listAllChannels()).length).toBe(0);
    expect(session.currentFlow).toBe("force_join:add"); // still armed to retry
  });

  it("rejects a non-channel public target as an invalid link", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    const t = textCtx("@someuser", OWNER, session, {
      getChat: { id: 55, type: "private", title: "U" },
      botStatus: "administrator",
    });
    await runText(t);
    expect((await listAllChannels()).length).toBe(0);
  });

  it("opens the request_chat picker for a private link and adds on a valid chat_shared (T3/T4)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    const t = textCtx("https://t.me/+PrivHash123", OWNER, session);
    await runText(t);
    // A reply keyboard with a request_chat button was sent (T1/T2).
    const markup = t.rec.sent.at(-1)?.other?.reply_markup as { keyboard?: Array<Array<Record<string, unknown>>> };
    const btn = markup.keyboard?.[0]?.[0] as { request_chat?: { chat_is_channel?: boolean; bot_is_member?: boolean } };
    expect(btn.request_chat?.chat_is_channel).toBe(true);
    expect(btn.request_chat?.bot_is_member).toBe(true);
    expect(session.currentFlow).toBe("force_join:private_pick");
    const requestId = session.temp.forceJoin?.privatePick?.requestId as number;

    // A valid chat_shared answering THIS request adds the private channel.
    const sharedChatId = Number(nextChatId());
    const cs = chatSharedCtx({ request_id: requestId, chat_id: sharedChatId }, OWNER, session, {
      getChat: { id: sharedChatId, type: "channel", title: "Private ZED" },
      botStatus: "administrator",
    });
    await runShared(cs);
    const rows = await listAllChannels();
    expect(rows.length).toBe(1);
    expect(rows[0].isPrivate).toBe(true);
    expect(rows[0].joinUrl).toBe("https://t.me/+PrivHash123");
    // The temporary reply keyboard was removed and no "cancelled" wording on success.
    const removal = cs.rec.sent.find((s) => (s.other?.reply_markup as { remove_keyboard?: boolean })?.remove_keyboard);
    expect(removal).toBeDefined();
    expect(removal?.text).not.toBe("لغو شد.");
    expect(session.currentFlow).toBeNull();
  });

  it("rejects a chat_shared with a mismatched request_id (T3) and adds nothing", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    await runText(textCtx("https://t.me/+Hash", OWNER, session));
    const requestId = session.temp.forceJoin?.privatePick?.requestId as number;
    const cs = chatSharedCtx({ request_id: requestId + 999, chat_id: -1005 }, OWNER, session, {
      getChat: { id: -1005, type: "channel", title: "Evil" },
    });
    await runShared(cs);
    expect((await listAllChannels()).length).toBe(0);
    expect(session.currentFlow).toBeNull(); // state cleared
  });

  it("rejects a chat_shared from a different admin (T3)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    await runText(textCtx("https://t.me/+Hash", OWNER, session));
    const requestId = session.temp.forceJoin?.privatePick?.requestId as number;
    // A different OWNER admin submits the shared chat into the same session.
    const other: Admin = { id: "other-owner", role: "OWNER", isActive: true, telegramId: 555_000_9n } as unknown as Admin;
    const cs = chatSharedCtx({ request_id: requestId, chat_id: -1006 }, other, session, {
      getChat: { id: -1006, type: "channel", title: "X" },
    });
    await runShared(cs);
    expect((await listAllChannels()).length).toBe(0);
  });

  it("rejects an expired chat_shared (T3)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    await runText(textCtx("https://t.me/+Hash", OWNER, session));
    const draft = session.temp.forceJoin?.privatePick;
    if (draft) draft.expiresAtMs = Date.now() - 1; // force expiry
    const cs = chatSharedCtx({ request_id: draft?.requestId ?? 1, chat_id: -1007 }, OWNER, session);
    await runShared(cs);
    expect((await listAllChannels()).length).toBe(0);
    expect(allText(cs.rec)).toContain("منقضی");
  });

  it("removes the reply keyboard when the private flow is cancelled (T1)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    await runText(textCtx("https://t.me/+Hash", OWNER, session));
    expect(session.currentFlow).toBe("force_join:private_pick");
    const c = callbackCtx("admin:force_join:cancel", OWNER, session);
    await runCb(c);
    const removal = c.rec.sent.find((s) => (s.other?.reply_markup as { remove_keyboard?: boolean })?.remove_keyboard);
    expect(removal).toBeDefined();
    expect(removal?.text).toBe("لغو شد.");
    expect(session.currentFlow).toBeNull();
  });

  it("enable with zero active channels is rejected with the exact §4.10 message", async () => {
    const c = callbackCtx("admin:force_join:enable", OWNER);
    await runCb(c);
    expect(c.rec.toasts).toContain("ابتدا حداقل یک کانال معتبر و فعال اضافه کنید.");
    expect(await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } })).toMatchObject({ value: "false" });
  });

  it("enable succeeds with one active channel; disable works", async () => {
    await createOrRebindChannel(publicRow("enabler", nextChatId()));
    await runCb(callbackCtx("admin:force_join:enable", OWNER));
    expect((await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value).toBe("true");
    clearSettingsCache();
    await runCb(callbackCtx("admin:force_join:disable", OWNER));
    expect((await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value).toBe("false");
  });

  it("offers the D3 combined action when deactivating the last active channel while enabled", async () => {
    const created = await createOrRebindChannel(publicRow("only", nextChatId()));
    if (!created.ok) throw new Error("setup");
    await runCb(callbackCtx("admin:force_join:enable", OWNER));
    clearSettingsCache();
    const sid = created.channel.id.slice(0, 8);
    const c = callbackCtx(`admin:force_join:toggle:${sid}`, OWNER);
    await runCb(c);
    // The block screen offers the combined disable+deactivate action.
    const flat = flatButtons(c.rec.sent.at(-1)?.other);
    expect(flat.some((b) => b.callback_data === `admin:force_join:disdeact:${sid}`)).toBe(true);
    // Confirm the combined action.
    clearSettingsCache();
    const c2 = callbackCtx(`admin:force_join:disdeact:${sid}`, OWNER);
    await runCb(c2);
    expect((await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value).toBe("false");
    expect((await listAllChannels())[0].isActive).toBe(false);
  });

  it("deletes a channel through the confirm flow", async () => {
    const created = await createOrRebindChannel(publicRow("todelete", nextChatId()));
    if (!created.ok) throw new Error("setup");
    const sid = created.channel.id.slice(0, 8);
    await runCb(callbackCtx(`admin:force_join:del:${sid}`, OWNER)); // confirm screen
    await runCb(callbackCtx(`admin:force_join:delok:${sid}`, OWNER)); // confirm
    expect((await listAllChannels()).length).toBe(0);
  });

  it("re-renders the overview for a stale/ambiguous short id without throwing", async () => {
    const c = callbackCtx("admin:force_join:c:deadbeef", OWNER);
    await runCb(c);
    expect(c.rec.toasts.some((t) => t?.includes("یافت نشد"))).toBe(true);
  });

  it("never leaks a BigInt chat id in the overview or detail (T6) and renders without throwing", async () => {
    const chatId = nextChatId();
    const created = await createOrRebindChannel(publicRow("secret", chatId));
    if (!created.ok) throw new Error("setup");
    const overview = callbackCtx("admin:force_join:root", OWNER);
    await runCb(overview);
    const detail = callbackCtx(`admin:force_join:c:${created.channel.id.slice(0, 8)}`, OWNER);
    await runCb(detail);
    expect(allText(overview.rec)).not.toContain(chatId.toString());
    expect(allText(detail.rec)).not.toContain(chatId.toString());
  });
});

// --- helpers -----------------------------------------------------------------

function publicRow(username: string, chatId: bigint) {
  return {
    chatId,
    title: `Chan ${username}`,
    joinUrl: `https://t.me/${username}`,
    normalizedLink: `https://t.me/${username}`,
    isPrivate: false,
    publicUsername: username,
    createdByAdminId: OWNER.id,
  };
}

interface FlatButton {
  text?: string;
  callback_data?: string;
  url?: string;
}
function flatButtons(other: Record<string, unknown> | undefined): FlatButton[] {
  const markup = other?.reply_markup as { inline_keyboard?: FlatButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}
