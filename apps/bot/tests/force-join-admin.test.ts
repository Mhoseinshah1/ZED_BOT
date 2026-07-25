import { type Admin, prisma } from "@zedbot/database";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "force-join-admin-tests-secret";

import { initialSession } from "../src/core/session.js";
import {
  forceJoinAdminHandler,
  forceJoinAdminTextHandler,
  forceJoinChatSharedHandler,
  forceJoinCommandEscapeHandler,
} from "../src/handlers/admin-settings/force-join-admin.handler.js";
import {
  FORCE_JOIN_ENABLED_KEY,
  createOrRebindChannel,
  disableForceJoin,
  getChannelById,
  listAllChannels,
  setChannelActive,
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

function callbackCtx(
  data: string,
  admin: Admin | null,
  session = initialSession(),
  config: ApiConfig = {},
  chatType = "private",
) {
  const rec: Recorders = { sent: [], toasts: [] };
  const apiRec = { getChatMemberCalls: 0 };
  const api = makeApi(config, apiRec);
  const chat = { id: 1, type: chatType };
  const callback_query = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    data,
    message: { message_id: 1, date: 0, chat },
  };
  const ctx = {
    ...baseCtx(admin, session, api, rec),
    chat,
    callbackQuery: callback_query,
    update: { update_id: 1, callback_query },
  };
  return { ctx: ctx as never, rec, api, session };
}

function textCtx(
  text: string,
  admin: Admin | null,
  session = initialSession(),
  config: ApiConfig = {},
  chatType = "private",
) {
  const rec: Recorders = { sent: [], toasts: [] };
  const api = makeApi(config, { getChatMemberCalls: 0 });
  const chat = { id: Number(admin?.telegramId ?? 999n), type: chatType };
  const message = {
    message_id: 2,
    date: 0,
    chat,
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    text,
  };
  const ctx = { ...baseCtx(admin, session, api, rec), chat, message, update: { update_id: 2, message } };
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
  const chat = { id: Number(admin?.telegramId ?? 999n), type: "private" };
  const message = {
    message_id: 3,
    date: 0,
    chat,
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    chat_shared: shared,
  };
  const ctx = { ...baseCtx(admin, session, api, rec), chat, message, update: { update_id: 3, message } };
  return { ctx: ctx as never, rec, api, session };
}

const noop = async (): Promise<void> => {};
const runCb = (c: { ctx: never }) => forceJoinAdminHandler.middleware()(c.ctx, noop);
const runText = (c: { ctx: never }) => forceJoinAdminTextHandler.middleware()(c.ctx, noop);
const runShared = (c: { ctx: never }) => forceJoinChatSharedHandler.middleware()(c.ctx, noop);
// The pre-command escape composer always calls next(); track whether it did.
async function runEscape(c: { ctx: never }): Promise<boolean> {
  let passedThrough = false;
  await forceJoinCommandEscapeHandler.middleware()(c.ctx, async () => {
    passedThrough = true;
  });
  return passedThrough;
}

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

  // --- Codex review fixes ----------------------------------------------------

  it("edit-link rejects a link resolving to a DIFFERENT channel and keeps identity (Codex P1)", async () => {
    const created = await createOrRebindChannel(publicRow("origchan", -1050n));
    if (!created.ok) throw new Error("setup");
    const sid = created.channel.id.slice(0, 8);
    const session = initialSession();
    await runCb(callbackCtx(`admin:force_join:edit:${sid}`, OWNER, session));
    expect(session.currentFlow).toBe("force_join:edit_link");
    const t = textCtx("@otherchan", OWNER, session, {
      getChat: { id: -1099, type: "channel", title: "Other", username: "otherchan" },
      botStatus: "administrator",
    });
    await runText(t);
    expect(allText(t.rec)).toContain("کانال دیگری");
    const row = await getChannelById(created.channel.id);
    expect(row?.chatId).toBe(-1050n);
    expect(row?.publicUsername).toBe("origchan");
    expect(session.currentFlow).toBe("force_join:edit_link"); // still armed to retry
  });

  it("edit-link on the SAME channel adopts the authoritative renamed identity (Codex P1)", async () => {
    const created = await createOrRebindChannel(publicRow("oldname", -1051n));
    if (!created.ok) throw new Error("setup");
    const sid = created.channel.id.slice(0, 8);
    const session = initialSession();
    await runCb(callbackCtx(`admin:force_join:edit:${sid}`, OWNER, session));
    const t = textCtx("@NewName", OWNER, session, {
      getChat: { id: -1051, type: "channel", title: "Renamed", username: "NewName" },
      botStatus: "administrator",
    });
    await runText(t);
    const row = await getChannelById(created.channel.id);
    expect(row?.chatId).toBe(-1051n);
    expect(row?.publicUsername).toBe("newname");
    expect(row?.normalizedLink).toBe("https://t.me/newname");
    expect(row?.title).toBe("Renamed");
    expect(session.currentFlow).toBeNull();
  });

  it("activating an inactive channel re-validates bot access and refuses when the bot lost admin (Codex P1)", async () => {
    const created = await createOrRebindChannel(publicRow("togglechan", -1052n));
    if (!created.ok) throw new Error("setup");
    const off = await setChannelActive(created.channel.id, false);
    expect(off.ok).toBe(true);
    const sid = created.channel.id.slice(0, 8);
    // bot no longer admin → activation refused, channel stays inactive, error recorded
    await runCb(
      callbackCtx(`admin:force_join:toggle:${sid}`, OWNER, initialSession(), {
        getChat: { id: -1052, type: "channel", title: "T", username: "togglechan" },
        botStatus: "member",
      }),
    );
    const stillOff = await getChannelById(created.channel.id);
    expect(stillOff?.isActive).toBe(false);
    expect(stillOff?.lastValidationErrorCode).not.toBeNull();
    // access restored → activates and clears the error
    await runCb(
      callbackCtx(`admin:force_join:toggle:${sid}`, OWNER, initialSession(), {
        getChat: { id: -1052, type: "channel", title: "T", username: "togglechan" },
        botStatus: "administrator",
      }),
    );
    const back = await getChannelById(created.channel.id);
    expect(back?.isActive).toBe(true);
    expect(back?.lastValidationErrorCode).toBeNull();
  });

  it("a successful access test clears a previously recorded validation error (Codex P2)", async () => {
    const created = await createOrRebindChannel(publicRow("testchan", -1053n));
    if (!created.ok) throw new Error("setup");
    await prisma.forceJoinChannel.update({
      where: { id: created.channel.id },
      data: { lastValidationErrorCode: "BOT_NOT_ADMIN" },
    });
    const sid = created.channel.id.slice(0, 8);
    const c = callbackCtx(`admin:force_join:test:${sid}`, OWNER, initialSession(), {
      getChat: { id: -1053, type: "channel", title: "T", username: "testchan" },
      botStatus: "administrator",
    });
    await runCb(c);
    const row = await getChannelById(created.channel.id);
    expect(row?.lastValidationErrorCode).toBeNull();
    expect(c.rec.toasts).toContain("دسترسی ربات تایید شد ✅");
  });

  it("re-adding an already-registered INACTIVE channel is not reported as the active-cap limit (Codex P2)", async () => {
    const created = await createOrRebindChannel(publicRow("dupchan", -1054n));
    if (!created.ok) throw new Error("setup");
    await setChannelActive(created.channel.id, false);
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    const t = textCtx("@dupchan", OWNER, session, {
      getChat: { id: -1054, type: "channel", title: "Dup", username: "dupchan" },
      botStatus: "administrator",
    });
    await runText(t);
    expect(allText(t.rec)).toContain("قبلاً ثبت شده و غیرفعال");
    expect(allText(t.rec)).not.toContain("سقف"); // NOT the 10-active-cap wording
    expect((await listAllChannels()).length).toBe(1);
  });

  it("paginates the overview so a long list never overflows the Telegram message limit (Codex P2)", async () => {
    for (let i = 0; i < 10; i += 1) {
      const r = await createOrRebindChannel(publicRow(`pg${i}`, -(1_200n + BigInt(i))));
      if (!r.ok) throw new Error("setup");
    }
    const p0 = callbackCtx("admin:force_join:root", OWNER);
    await runCb(p0);
    const page0Text = lastText(p0.rec);
    expect(page0Text.length).toBeLessThan(4096);
    expect(page0Text).toContain("صفحه 1 از 2");
    const nav = flatButtons(p0.rec.sent.at(-1)?.other);
    expect(nav.some((b) => b.callback_data === "admin:force_join:page:1")).toBe(true);
    // The second page shows the overflow rows with their global numbering.
    const p1 = callbackCtx("admin:force_join:page:1", OWNER);
    await runCb(p1);
    expect(lastText(p1.rec)).toContain("9.");
    expect(lastText(p1.rec)).toContain("10.");
  });

  it("refuses to arm the private add picker outside a private chat (Codex P2)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session, {}, "group"));
    const t = textCtx("https://t.me/+GroupHash", OWNER, session, {}, "group");
    await runText(t);
    expect(allText(t.rec)).toContain("فقط در چت خصوصی");
    expect(session.currentFlow).toBeNull();
    expect((await listAllChannels()).length).toBe(0);
    const armedPicker = t.rec.sent.some((s) => Array.isArray((s.other?.reply_markup as { keyboard?: unknown })?.keyboard));
    expect(armedPicker).toBe(false);
  });

  it("refuses the private rebind picker outside a private chat (Codex P2)", async () => {
    const created = await createOrRebindChannel({
      chatId: -1060n,
      title: "Priv",
      joinUrl: "https://t.me/+priv",
      normalizedLink: "https://t.me/+priv",
      isPrivate: true,
      publicUsername: null,
      createdByAdminId: OWNER.id,
    });
    if (!created.ok) throw new Error("setup");
    const sid = created.channel.id.slice(0, 8);
    const session = initialSession();
    const c = callbackCtx(`admin:force_join:rebind:${sid}`, OWNER, session, {}, "group");
    await runCb(c);
    expect(c.rec.toasts.some((t) => t?.includes("فقط در چت خصوصی"))).toBe(true);
    expect(session.currentFlow).toBeNull();
    expect(session.temp.forceJoin).toBeUndefined();
  });

  it("a command sent mid-flow unwinds the flow and removes the picker before the command runs (Codex P2)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    await runText(textCtx("https://t.me/+CmdHash", OWNER, session));
    expect(session.currentFlow).toBe("force_join:private_pick");
    const esc = textCtx("/start", OWNER, session);
    const passedThrough = await runEscape(esc);
    expect(passedThrough).toBe(true); // the command still reaches its own handler
    expect(session.currentFlow).toBeNull();
    const removal = esc.rec.sent.find((s) => (s.other?.reply_markup as { remove_keyboard?: boolean })?.remove_keyboard);
    expect(removal).toBeDefined();
  });

  // --- private link/identity can never diverge (P1-A) ------------------------

  /** Seeds a private channel row and returns it. */
  async function seedPrivate(hash: string, chatId: bigint) {
    const created = await createOrRebindChannel({
      chatId,
      title: `Priv ${hash}`,
      joinUrl: `https://t.me/+${hash}`,
      normalizedLink: `https://t.me/+${hash}`,
      isPrivate: true,
      publicUsername: null,
      createdByAdminId: OWNER.id,
    });
    if (!created.ok) throw new Error("setup");
    return created.channel;
  }

  it("editing a private link alone persists NOTHING until a channel is picked", async () => {
    const row = await seedPrivate("origlink", -2001n);
    const session = initialSession();
    await runCb(callbackCtx(`admin:force_join:edit:${row.id.slice(0, 8)}`, OWNER, session));
    expect(session.currentFlow).toBe("force_join:edit_link");

    // The OWNER submits a NEW invite link.
    const t = textCtx("https://t.me/+brandnewlink", OWNER, session);
    await runText(t);

    // Nothing is written yet — the row still holds the ORIGINAL link and id.
    const unchanged = await getChannelById(row.id);
    expect(unchanged?.joinUrl).toBe("https://t.me/+origlink");
    expect(unchanged?.chatId).toBe(-2001n);
    // Instead the picker is armed, carrying the new link in the draft.
    expect(session.currentFlow).toBe("force_join:private_pick");
    expect(session.temp.forceJoin?.rebindChannelId).toBe(row.id);
    expect(session.temp.forceJoin?.privatePick?.joinUrl).toBe("https://t.me/+brandnewlink");
  });

  it("completing the private edit moves link AND identity together — never link A + identity B", async () => {
    const row = await seedPrivate("linkA", -2002n);
    const session = initialSession();
    await runCb(callbackCtx(`admin:force_join:edit:${row.id.slice(0, 8)}`, OWNER, session));
    await runText(textCtx("https://t.me/+linkB", OWNER, session));
    const requestId = session.temp.forceJoin?.privatePick?.requestId as number;

    const newChatId = -2099;
    const cs = chatSharedCtx({ request_id: requestId, chat_id: newChatId }, OWNER, session, {
      getChat: { id: newChatId, type: "channel", title: "Channel B" },
      botStatus: "administrator",
    });
    await runShared(cs);

    const after = await getChannelById(row.id);
    // BOTH halves are the new ones. The forbidden combinations —
    // (old link + new identity) and (new link + old identity) — are absent.
    expect(after?.joinUrl).toBe("https://t.me/+linkB");
    expect(after?.normalizedLink).toBe("https://t.me/+linkB");
    expect(after?.chatId).toBe(BigInt(newChatId));
    expect(after?.title).toBe("Channel B");
    expect(session.currentFlow).toBeNull();
  });

  it("«انتخاب مجدد کانال» demands a fresh link instead of re-picking with the old one", async () => {
    const row = await seedPrivate("keepme", -2003n);
    const session = initialSession();
    const c = callbackCtx(`admin:force_join:rebind:${row.id.slice(0, 8)}`, OWNER, session);
    await runCb(c);

    // It does NOT jump to the picker (which would pair a NEW channel with the
    // OLD invite link); it asks for the new link first.
    expect(session.currentFlow).toBe("force_join:edit_link");
    expect(session.temp.forceJoin?.privatePick).toBeUndefined();
    const armedPicker = c.rec.sent.some((s) =>
      Array.isArray((s.other?.reply_markup as { keyboard?: unknown })?.keyboard),
    );
    expect(armedPicker).toBe(false);
  });

  it("a rebind onto a channel already configured elsewhere is refused", async () => {
    const a = await seedPrivate("dup_a", -2004n);
    await seedPrivate("dup_b", -2005n);
    const session = initialSession();
    await runCb(callbackCtx(`admin:force_join:edit:${a.id.slice(0, 8)}`, OWNER, session));
    await runText(textCtx("https://t.me/+dupattempt", OWNER, session));
    const requestId = session.temp.forceJoin?.privatePick?.requestId as number;

    // Pick the channel that the OTHER row already owns.
    const cs = chatSharedCtx({ request_id: requestId, chat_id: -2005 }, OWNER, session, {
      getChat: { id: -2005, type: "channel", title: "B" },
      botStatus: "administrator",
    });
    await runShared(cs);

    expect(allText(cs.rec)).toContain("قبلاً ثبت شده");
    const untouched = await getChannelById(a.id);
    expect(untouched?.chatId).toBe(-2004n);
    expect(untouched?.joinUrl).toBe("https://t.me/+dup_a");
  });

  // --- request_id randomness (P1-D) ------------------------------------------

  it("issues a different, cryptographically random request_id for each new picker flow", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4; i += 1) {
      const session = initialSession();
      await runCb(callbackCtx("admin:force_join:add", OWNER, session));
      await runText(textCtx(`https://t.me/+seq${i}`, OWNER, session));
      const id = session.temp.forceJoin?.privatePick?.requestId as number;
      // A positive 32-bit integer, never derived from the sender id.
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(2_147_483_647);
      seen.add(id);
    }
    // Two sequential flows from the SAME owner must not reuse an id, so an old
    // chat_shared can never satisfy a newly armed picker.
    expect(seen.size).toBe(4);
  });

  it("the command escape passes ordinary text through without clearing an armed flow (Codex P2)", async () => {
    const session = initialSession();
    await runCb(callbackCtx("admin:force_join:add", OWNER, session));
    expect(session.currentFlow).toBe("force_join:add");
    const esc = textCtx("just some text", OWNER, session);
    const passedThrough = await runEscape(esc);
    expect(passedThrough).toBe(true);
    expect(session.currentFlow).toBe("force_join:add"); // untouched
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
