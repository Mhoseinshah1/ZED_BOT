import { LogGroupSetupStatus, prisma, type Admin } from "@zedbot/database";
import {
  getRedisOptions,
  LOG_DELIVERY_QUEUE_NAME,
  LOG_GROUP_SETUP_QUEUE_NAME,
  LOG_GROUP_STARTGROUP_PAYLOAD,
  OPS_LOG_TOPIC_KEYS,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-group-wizard-tests-secret-001";

import { CB } from "../src/core/callbacks.js";
import { initialSession } from "../src/core/session.js";
import {
  LGSET_CB,
  logGroupSetupHandler,
  SETUP_CANCELLED_TEXT,
  SETUP_CONFIRM_TEXT,
} from "../src/handlers/admin-settings/log-group-setup.handler.js";
import { LG_CB, logGroupHandler } from "../src/handlers/admin-settings/log-group.handler.js";
import { SETUP_ALREADY_RUNNING_TEXT } from "../src/services/log-group-connection.service.js";
import {
  buildAdminMainKeyboard,
} from "../src/keyboards/admin-main.keyboard.js";
import {
  ADMIN_MAIN_MENU_ACTION_WIRING,
  buildAdminMainMenuDefinition,
  buildAdminMainReplyKeyboard,
  resolveAdminMainMenuAction,
} from "../src/keyboards/admin-menu-definition.js";
import {
  BOT_NOT_ADMIN_TEXT,
  BOT_RIGHTS_INCOMPLETE_TEXT,
  getLogGroupSettings,
  LOG_GROUP_TITLE_KEY,
  maskChatId,
  NOT_FORUM_TEXT,
  NOT_IN_GROUP_TEXT,
  saveLogGroup,
} from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  clearSettingsCache,
  deleteSetting,
} from "../src/services/settings.service.js";
import {
  LOG_GROUP_CHAT_ID_KEY,
  OPS_EVENTS,
} from "../src/services/system-log.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Log-group setup wizard (legacy-upgrade / log-group-wizard phase). Covers:
// the state-dependent admin page (unconfigured wizard-only keyboard vs the
// full 8-button toolset), the start-group deep link built from the LIVE bot
// username, both group-side entries (/setloggroup and "/start zedlog"),
// OWNER-only enforcement for senders without an admin row and for SUPPORT
// admins, environment validation (forum + bot rights), the end-to-end bind
// with idempotent default-topic creation, replacement of a different bound
// group behind an explicit warning, and General-Settings reachability in
// BOTH admin menu modes. Requires the real test PostgreSQL; skips without it.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const NOT_GROUP_MEMBER_TEXT = "برای تایید اتصال باید عضو همین گروه باشید.";

const BOT_ID = 4_242_000_001;
const BOT_USERNAME = "zedlog_wizard_fixture_bot";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

// Distinct candidate chats (forum supergroups A/B plus invalid shapes).
const chatA = { id: -1_002_000_000_011, type: "supergroup", title: "Ops Log A", is_forum: true };
const chatB = { id: -1_002_000_000_022, type: "supergroup", title: "Ops Log B", is_forum: true };
const nonForumChat = { id: -1_002_000_000_033, type: "supergroup", title: "Flat Group", is_forum: false };
const basicGroupChat = { id: -400_123, type: "group", title: "Small Group" };
const privateChat = { id: 555_001, type: "private", first_name: "Owner" };

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

interface InlineButton {
  text?: string;
  callback_data?: string;
  url?: string;
}

/** Recording stand-in for the grammY Api surface the flow uses. */
interface FakeApi {
  createForumTopicCalls: Array<{ chatId: string; name: string }>;
  sendMessageCalls: Array<{ chatId: string; text: string; threadId: number | undefined }>;
  createForumTopic(chatId: number | string, name: string): Promise<{ message_thread_id: number }>;
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { message_thread_id?: number },
  ): Promise<unknown>;
}

function makeApi(): FakeApi {
  let nextThreadId = 1000;
  const api: FakeApi = {
    createForumTopicCalls: [],
    sendMessageCalls: [],
    async createForumTopic(chatId, name) {
      nextThreadId += 1;
      api.createForumTopicCalls.push({ chatId: String(chatId), name });
      return { message_thread_id: nextThreadId };
    },
    async sendMessage(chatId, text, other) {
      api.sendMessageCalls.push({
        chatId: String(chatId),
        text,
        threadId: other?.message_thread_id,
      });
      return {};
    },
  };
  return api;
}

interface CtxOptions {
  admin?: Admin | null;
  api?: FakeApi;
  botUsername?: string;
  /** getChatMember result for the BOT's own id (chat environment probe). */
  botMember?: Record<string, unknown>;
  /** getChatMember result for any other id (the confirm presser). */
  presserMember?: Record<string, unknown>;
  /** Makes every getChatMember call fail like a Telegram API error. */
  memberLookupFails?: boolean;
}

function buildBase(chat: Record<string, unknown>, options: CtxOptions) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const baseApi = options.api ?? makeApi();
  const me = {
    id: BOT_ID,
    is_bot: true,
    first_name: "ZedBot",
    username: options.botUsername ?? BOT_USERNAME,
  };
  // The durable connection pipeline probes via ctx.api.getChat +
  // ctx.api.getChatMember(chatId, userId) (the SAME shared policy the
  // numeric-ID flow uses); augment the recording FakeApi with those reads so
  // the group-side confirm drives the unified flow.
  const api = Object.assign(baseApi, {
    async getChat(_chatId: number | string) {
      return {
        type: chat.type as string,
        is_forum: chat.is_forum as boolean | undefined,
        title: chat.title as string | undefined,
        username: chat.username as string | undefined,
      };
    },
    async getChatMember(_chatId: number | string, userId: number) {
      if (options.memberLookupFails === true) {
        throw new Error("Bad Request: chat not found");
      }
      if (userId === me.id) {
        return options.botMember ?? { status: "administrator", can_manage_topics: true };
      }
      return options.presserMember ?? { status: "member" };
    },
  });
  const from = {
    id: Number(options.admin?.telegramId ?? 999_999_001n),
    is_bot: false,
    first_name: "Sender",
  };
  const shared = {
    chat,
    from,
    me,
    api,
    admin: options.admin ?? null,
    dbUser: null,
    session: initialSession(),
    reply: async (text: string, other?: Record<string, unknown>) => {
      sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
    getChatMember: async (userId: number) => {
      if (options.memberLookupFails === true) {
        throw new Error("Bad Request: chat not found");
      }
      if (userId === me.id) {
        return options.botMember ?? { status: "administrator", can_manage_topics: true };
      }
      return options.presserMember ?? { status: "member" };
    },
  };
  return { shared, sent, toasts, api, from };
}

/** Command update inside `chat` (entities included so grammY matches). */
function commandCtx(text: string, chat: Record<string, unknown>, options: CtxOptions = {}) {
  const { shared, sent, toasts, api, from } = buildBase(chat, options);
  const command = text.split(" ")[0];
  const message = {
    message_id: 10,
    date: 0,
    chat,
    from,
    text,
    entities: [{ type: "bot_command", offset: 0, length: command.length }],
  };
  const ctx = { ...shared, message, update: { update_id: 1, message } };
  return { ctx: ctx as never, sent, toasts, api };
}

/** Callback-query update (no message payload - replies are recorded). */
function callbackCtx(data: string, chat: Record<string, unknown>, options: CtxOptions = {}) {
  const { shared, sent, toasts, api, from } = buildBase(chat, options);
  const callbackQuery = { id: "cbq-1", chat_instance: "ci-1", from, data };
  const ctx = {
    ...shared,
    callbackQuery,
    update: { update_id: 2, callback_query: callbackQuery },
  };
  return { ctx: ctx as never, sent, toasts, api };
}

async function dispatchSetup(ctx: never): Promise<boolean> {
  let fellThrough = false;
  await logGroupSetupHandler.middleware()(ctx, async () => {
    fellThrough = true;
  });
  return fellThrough;
}

async function dispatchAdminPage(ctx: never): Promise<void> {
  await logGroupHandler.middleware()(ctx, async () => {});
}

function inlineButtons(sent: SentMessage): InlineButton[][] {
  const markup = sent.other?.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return markup?.inline_keyboard ?? [];
}

function flatButtons(sent: SentMessage): InlineButton[] {
  return inlineButtons(sent).flat();
}

async function boundChatId(): Promise<string | null> {
  clearSettingsCache();
  return (await getLogGroupSettings()).chatId;
}

async function opsTopicRows() {
  return prisma.logTopic.findMany({
    where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
    orderBy: { key: "asc" },
  });
}

async function resetOpsTopicBindings(): Promise<void> {
  await prisma.logTopic.updateMany({
    where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
    data: { topicId: null, telegramChatId: null, isEnabled: true },
  });
}

/** Directly binds every ops topic to `chatId` (arrange helper - no Telegram). */
async function bindOpsTopicsTo(chatId: string): Promise<void> {
  let thread = 7000;
  for (const key of OPS_LOG_TOPIC_KEYS) {
    thread += 1;
    await prisma.logTopic.update({
      where: { key },
      data: { topicId: thread, telegramChatId: BigInt(chatId) },
    });
  }
}

/** Empties the durable setup queue so a prior test's job never lingers. */
async function obliterateSetupQueue(): Promise<void> {
  const options = getRedisOptions();
  if (options === null) {
    return;
  }
  const queue = new Queue(LOG_GROUP_SETUP_QUEUE_NAME, {
    connection: { ...options, maxRetriesPerRequest: null },
  });
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
}

const RUNNING_SETUP_STATUSES = [
  LogGroupSetupStatus.QUEUED,
  LogGroupSetupStatus.PROVISIONING,
  LogGroupSetupStatus.TESTING,
];

/** The newest durable setup attempt staged for a given chat id. */
async function latestAttemptFor(chatId: string) {
  return prisma.logGroupSetupAttempt.findFirst({
    where: { chatId: BigInt(chatId) },
    orderBy: { createdAt: "desc" },
  });
}

describe.runIf(hasDb)("log-group setup wizard", () => {
  let owner: Admin;
  let support: Admin;
  const suiteStartedAt = new Date();

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: runTag + 1n, role: "OWNER", isActive: true },
    });
    support = await prisma.admin.create({
      data: { telegramId: runTag + 2n, role: "SUPPORT", isActive: true },
    });
    // Every stable ops topic key must have its seeded row.
    const existing = await opsTopicRows();
    expect(existing).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
  });

  beforeEach(async () => {
    // Deterministic start: unconfigured binding, unbound seeded topics, no
    // durable setup attempt occupying the single active slot, empty setup queue.
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    await deleteSetting(LOG_GROUP_TITLE_KEY);
    clearSettingsCache();
    await resetOpsTopicBindings();
    await prisma.logGroupSetupAttempt.deleteMany({
      where: { requestedByAdminId: { in: [owner.id, support.id] } },
    });
    await obliterateSetupQueue();
  });

  afterAll(async () => {
    // Undo every global mutation so the shared test DB stays sane.
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    await deleteSetting(LOG_GROUP_TITLE_KEY);
    clearSettingsCache();
    await resetOpsTopicBindings();
    await prisma.systemLogDelivery.deleteMany({
      where: {
        systemLog: {
          is: {
            eventType: OPS_EVENTS.LOG_GROUP_CHANGED,
            createdAt: { gte: suiteStartedAt },
          },
        },
      },
    });
    await prisma.systemLog.deleteMany({
      where: { eventType: OPS_EVENTS.LOG_GROUP_CHANGED, createdAt: { gte: suiteStartedAt } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityType: "LogGroupSetupAttempt",
        actorTelegramId: { in: [owner.telegramId, support.telegramId] },
      },
    });
    await prisma.logGroupSetupAttempt.deleteMany({
      where: { requestedByAdminId: { in: [owner.id, support.id] } },
    });
    await prisma.admin.deleteMany({ where: { id: { in: [owner.id, support.id] } } });
    // Remove the log-delivery jobs the SECURITY ops log enqueued + any setup jobs.
    const options = getRedisOptions();
    if (options !== null) {
      const queue = new Queue(LOG_DELIVERY_QUEUE_NAME, {
        connection: { ...options, maxRetriesPerRequest: null },
      });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await obliterateSetupQueue();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  /** Runs the full valid group-side bind in `chat` and returns the records. */
  async function bindGroup(chat: Record<string, unknown>, api = makeApi()) {
    const press = callbackCtx(LGSET_CB.yes, chat, { admin: owner, api });
    await dispatchSetup(press.ctx);
    return press;
  }

  // --- the admin page (items 11 + the configured toolset) ---------------------------------------

  it("11. unconfigured page offers ONLY the numeric-ID + wizard actions - no test/topic buttons", async () => {
    // Direct-log-group-setup rework: the numeric-ID entry is FIRST, then the
    // add-bot wizard / guide / recheck. Still NO test/topic actions unbound.
    const { ctx, sent } = callbackCtx(LG_CB.root, privateChat, { admin: owner });
    await dispatchAdminPage(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("وضعیت اتصال: تنظیم نشده");
    const rows = inlineButtons(sent[0]);
    expect(
      rows.map((row) => row.map((b) => ({ text: b.text, callback: b.callback_data }))),
    ).toEqual([
      [{ text: "اتصال با آیدی عددی گروه 🔢", callback: LG_CB.id }],
      [{ text: "افزودن ربات به گروه ➕", callback: LG_CB.connect }],
      [{ text: "راهنمای ساخت گروه", callback: LG_CB.guide }],
      [{ text: "بررسی مجدد اتصال ♻️", callback: LG_CB.recheck }],
      [{ text: "بازگشت", callback: CB.ADMIN_GENERAL_SETTINGS }],
    ]);
    // Explicitly: nothing test- or topic-related exists while unbound.
    const callbacks = flatButtons(sent[0]).map((b) => b.callback_data);
    for (const absent of [LG_CB.check, LG_CB.test, LG_CB.ensure, LG_CB.sync, LG_CB.topics, LG_CB.disconnect]) {
      expect(callbacks).not.toContain(absent);
    }
  });

  it("configured page shows exactly the 9-button toolset", async () => {
    await saveLogGroup(String(chatA.id), chatA.title);
    const { ctx, sent } = callbackCtx(LG_CB.root, privateChat, { admin: owner });
    await dispatchAdminPage(ctx);
    expect(sent[0].text).toContain("وضعیت اتصال: متصل ✅");
    expect(sent[0].text).toContain(maskChatId(String(chatA.id)));
    expect(sent[0].text).not.toContain(String(chatA.id)); // masked, never raw
    const rows = inlineButtons(sent[0]);
    expect(
      rows.map((row) => row.map((b) => ({ text: b.text, callback: b.callback_data }))),
    ).toEqual([
      [{ text: "بررسی اتصال 🧪", callback: LG_CB.check }],
      [{ text: "ارسال پیام آزمایشی", callback: LG_CB.test }],
      [{ text: "ساخت / تعمیر موضوعات پیش‌فرض", callback: LG_CB.ensure }],
      [{ text: "همگام‌سازی موضوعات", callback: LG_CB.sync }],
      [{ text: "مدیریت موضوعات", callback: LG_CB.topics }],
      [{ text: "تغییر گروه با آیدی عددی 🔄", callback: LG_CB.id }],
      [{ text: "افزودن ربات به گروه دیگر ➕", callback: LG_CB.connect }],
      [{ text: "قطع اتصال گروه", callback: LG_CB.disconnect }],
      [{ text: "بازگشت", callback: CB.ADMIN_GENERAL_SETTINGS }],
    ]);
    expect(flatButtons(sent[0])).toHaveLength(9);
  });

  // --- the wizard page + deep link (item 12) -----------------------------------------------------

  it("12. the wizard deep link is built from the LIVE bot username", async () => {
    const { ctx, sent } = callbackCtx(LG_CB.connect, privateChat, { admin: owner });
    await dispatchAdminPage(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("📝 اتصال گروه لاگ");
    for (const step of [
      "۱. یک سوپرگروه خصوصی بسازید.",
      "۲. قابلیت موضوعات یا Topics را فعال کنید.",
      "۳. ربات را با دسترسی ارسال پیام و مدیریت موضوعات، مدیر گروه کنید.",
      "۴. دکمه زیر را بزنید و گروه را انتخاب کنید.",
      "۵. داخل گروه، اتصال را تایید کنید.",
    ]) {
      expect(sent[0].text).toContain(step);
    }
    const buttons = flatButtons(sent[0]);
    const urlButton = buttons.find((b) => b.url !== undefined);
    expect(urlButton?.text).toBe("افزودن ربات به گروه ➕");
    expect(urlButton?.url).toBe(`https://t.me/${BOT_USERNAME}?startgroup=zedlog`);
    expect(urlButton?.url).toBe(
      `https://t.me/${BOT_USERNAME}?startgroup=${LOG_GROUP_STARTGROUP_PAYLOAD}`,
    );
    expect(buttons.map((b) => b.callback_data)).toContain(LG_CB.recheck);
    expect(buttons.some((b) => b.text === "بررسی مجدد اتصال ♻️")).toBe(true);
    expect(buttons.some((b) => b.text === "انصراف" && b.callback_data === LG_CB.root)).toBe(true);

    // Different live identity -> different link (never hardcoded).
    const other = callbackCtx(LG_CB.connect, privateChat, {
      admin: owner,
      botUsername: "totally_other_bot",
    });
    await dispatchAdminPage(other.ctx);
    const otherUrl = flatButtons(other.sent[0]).find((b) => b.url !== undefined)?.url;
    expect(otherUrl).toBe(`https://t.me/totally_other_bot?startgroup=zedlog`);
  });

  // --- entry points (item 13) --------------------------------------------------------------------

  it("13. group /start with the zedlog payload reaches the prompt; private /start falls through", async () => {
    // Group + payload: the ONE confirmation prompt.
    const group = commandCtx("/start zedlog", chatA, { admin: owner });
    expect(await dispatchSetup(group.ctx)).toBe(false);
    expect(group.sent).toHaveLength(1);
    expect(group.sent[0].text).toContain(SETUP_CONFIRM_TEXT);
    const buttons = flatButtons(group.sent[0]);
    expect(buttons).toEqual([
      { text: "تایید اتصال گروه ✅", callback_data: LGSET_CB.yes },
      { text: "انصراف", callback_data: LGSET_CB.no },
    ]);

    // Private chat with the same payload: untouched fall-through.
    const priv = commandCtx("/start zedlog", privateChat, { admin: owner });
    expect(await dispatchSetup(priv.ctx)).toBe(true);
    expect(priv.sent).toHaveLength(0);

    // Group /start with any OTHER payload: untouched fall-through.
    const otherPayload = commandCtx("/start ref_12345", chatA, { admin: owner });
    expect(await dispatchSetup(otherPayload.ctx)).toBe(true);
    expect(otherPayload.sent).toHaveLength(0);

    // Nothing above may have bound anything.
    expect(await boundChatId()).toBeNull();
  });

  // --- authorization (items 14 + 15) -------------------------------------------------------------

  it("14. a sender without an admin row can never bind", async () => {
    for (const text of ["/setloggroup", "/start zedlog"]) {
      const { ctx, sent } = commandCtx(text, chatA, { admin: null });
      await dispatchSetup(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe(OWNER_ONLY_TEXT);
    }
    // A forged confirm press binds nothing either.
    const press = callbackCtx(LGSET_CB.yes, chatA, { admin: null });
    await dispatchSetup(press.ctx);
    expect(press.toasts).toContain(OWNER_ONLY_TEXT);
    expect(press.sent).toHaveLength(0);
    expect(press.api.createForumTopicCalls).toHaveLength(0);
    expect(await boundChatId()).toBeNull();
  });

  it("15. a SUPPORT admin can never bind", async () => {
    for (const text of ["/setloggroup", "/start zedlog"]) {
      const { ctx, sent } = commandCtx(text, chatA, { admin: support });
      await dispatchSetup(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe(OWNER_ONLY_TEXT);
    }
    const press = callbackCtx(LGSET_CB.yes, chatA, { admin: support });
    await dispatchSetup(press.ctx);
    expect(press.toasts).toContain(OWNER_ONLY_TEXT);
    expect(press.api.createForumTopicCalls).toHaveLength(0);
    expect(await boundChatId()).toBeNull();
  });

  // --- environment validation (items 16 + 17) ----------------------------------------------------

  it("16. a non-forum supergroup is rejected with the forum error", async () => {
    const { ctx, sent } = commandCtx("/setloggroup", nonForumChat, { admin: owner });
    await dispatchSetup(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(NOT_FORUM_TEXT);

    // A basic (non-super) group is not a candidate at all.
    const basic = commandCtx("/setloggroup", basicGroupChat, { admin: owner });
    await dispatchSetup(basic.ctx);
    expect(basic.sent[0].text).toBe(NOT_IN_GROUP_TEXT);
    expect(await boundChatId()).toBeNull();
  });

  it("17. missing bot permissions are rejected", async () => {
    // Bot is a plain member.
    const notAdmin = commandCtx("/setloggroup", chatA, {
      admin: owner,
      botMember: { status: "member" },
    });
    await dispatchSetup(notAdmin.ctx);
    expect(notAdmin.sent[0].text).toBe(BOT_NOT_ADMIN_TEXT);

    // Administrator without the manage-topics right.
    const noTopics = commandCtx("/setloggroup", chatA, {
      admin: owner,
      botMember: { status: "administrator", can_manage_topics: false },
    });
    await dispatchSetup(noTopics.ctx);
    expect(noTopics.sent[0].text).toBe(BOT_RIGHTS_INCOMPLETE_TEXT);

    // Member lookup failure fails safe as "not admin".
    const lookupFails = commandCtx("/setloggroup", chatA, {
      admin: owner,
      memberLookupFails: true,
    });
    await dispatchSetup(lookupFails.ctx);
    expect(lookupFails.sent[0].text).toBe(BOT_NOT_ADMIN_TEXT);

    expect(await boundChatId()).toBeNull();
  });

  it("17b. the confirm press re-validates everything (stale prompts bind nothing)", async () => {
    // Rights degraded between prompt and press.
    const press = callbackCtx(LGSET_CB.yes, chatA, {
      admin: owner,
      botMember: { status: "administrator", can_manage_topics: false },
    });
    await dispatchSetup(press.ctx);
    expect(press.toasts).toContain(BOT_RIGHTS_INCOMPLETE_TEXT);
    expect(press.api.createForumTopicCalls).toHaveLength(0);
    expect(await boundChatId()).toBeNull();

    // A presser who left the group is refused even as OWNER.
    const leftPress = callbackCtx(LGSET_CB.yes, chatA, {
      admin: owner,
      presserMember: { status: "left" },
    });
    await dispatchSetup(leftPress.ctx);
    expect(leftPress.toasts).toContain(NOT_GROUP_MEMBER_TEXT);
    expect(await boundChatId()).toBeNull();
  });

  // --- the happy path (items 18 + 19) ------------------------------------------------------------

  it("18-19. a valid group-side confirm STARTS the durable setup without binding inline", async () => {
    // Prompt first (the real flow), then confirm.
    const prompt = commandCtx("/setloggroup", chatA, { admin: owner });
    await dispatchSetup(prompt.ctx);
    expect(prompt.sent[0].text).toContain(SETUP_CONFIRM_TEXT);
    // No replacement warning on a clean install.
    expect(prompt.sent[0].text).not.toContain("جایگزین");

    const press = await bindGroup(chatA);

    // §2: the confirm NEVER binds inline. It creates + confirms the same
    // durable attempt the numeric-ID flow uses; topics + the test send run in
    // the worker. No inline topic creation or test send from the bot.
    expect(press.api.createForumTopicCalls).toHaveLength(0);
    expect(press.api.sendMessageCalls).toHaveLength(0);
    // The active group is NOT switched yet (the worker has not activated it).
    expect(await boundChatId()).toBeNull();

    // A durable attempt for THIS chat is queued and occupies the active slot.
    const attempt = await latestAttemptFor(String(chatA.id));
    expect(attempt).not.toBeNull();
    expect(RUNNING_SETUP_STATUSES).toContain(attempt?.status);
    expect(attempt?.activeSlot).toBe(1);
    expect(attempt?.safeTitle).toBe(chatA.title);

    // The group message shows "setup started" + a URL button back to the bot,
    // never a "saved/active" claim and never the raw chat id.
    expect(press.sent).toHaveLength(1);
    expect(press.sent[0].text).toContain("راه‌اندازی گروه لاگ آغاز شد");
    expect(press.sent[0].text).not.toContain(String(chatA.id));
    const backButton = flatButtons(press.sent[0])[0];
    expect(backButton.url).toBe(`https://t.me/${BOT_USERNAME}`);

    // Audit trail records the queued setup against the attempt.
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityType: "LogGroupSetupAttempt",
        action: "log_group.setup_queued",
        actorTelegramId: owner.telegramId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  // --- idempotency (item 20) ---------------------------------------------------------------------

  it("20. a repeated group-side confirm converges on ONE active setup (no duplicate)", async () => {
    const first = await bindGroup(chatA);
    expect(first.sent[0].text).toContain("راه‌اندازی گروه لاگ آغاز شد");
    const firstAttempt = await latestAttemptFor(String(chatA.id));
    expect(firstAttempt).not.toBeNull();

    // Second press while the first is still running: no duplicate attempt - the
    // OWNER is told a setup is already in progress.
    const second = await bindGroup(chatA);
    expect(second.sent[0].text).toContain(SETUP_ALREADY_RUNNING_TEXT);
    const running = await prisma.logGroupSetupAttempt.count({
      where: { requestedByAdminId: owner.id, status: { in: RUNNING_SETUP_STATUSES } },
    });
    expect(running).toBe(1);
    expect(await boundChatId()).toBeNull();
  });

  // --- replacement (item 21) ---------------------------------------------------------------------

  it("21. replacing a DIFFERENT bound group warns and starts a durable replacement, leaving A active", async () => {
    // Arrange: group A is the fully-bound active group.
    await saveLogGroup(String(chatA.id), chatA.title);
    await bindOpsTopicsTo(String(chatA.id));

    // Prompting inside group B carries the explicit replacement warning.
    const promptB = commandCtx("/setloggroup", chatB, { admin: owner });
    await dispatchSetup(promptB.ctx);
    expect(promptB.sent[0].text).toContain("یک گروه لاگ دیگر قبلاً تنظیم شده است:");
    expect(promptB.sent[0].text).toContain(maskChatId(String(chatA.id)));
    expect(promptB.sent[0].text).toContain(chatA.title);
    expect(promptB.sent[0].text).toContain("با تایید، گروه فعلی جایگزین می‌شود.");
    expect(promptB.sent[0].text).toContain(SETUP_CONFIRM_TEXT);

    // Prompting inside the SAME bound group A shows no warning.
    const promptA = commandCtx("/setloggroup", chatA, { admin: owner });
    await dispatchSetup(promptA.ctx);
    expect(promptA.sent[0].text).not.toContain("جایگزین");

    // Confirming in B STARTS a durable replacement but leaves A fully active -
    // a not-yet-succeeded replacement never switches the group or its topics.
    const press = await bindGroup(chatB);
    expect(press.sent[0].text).toContain("راه‌اندازی گروه لاگ آغاز شد");
    expect(await boundChatId()).toBe(String(chatA.id));
    const rows = await opsTopicRows();
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(String(chatA.id));
    }
    // The durable attempt targets B and records the previous (still-active) group.
    const attempt = await latestAttemptFor(String(chatB.id));
    expect(attempt).not.toBeNull();
    expect(attempt?.previousChatId?.toString()).toBe(String(chatA.id));
    expect(RUNNING_SETUP_STATUSES).toContain(attempt?.status);
  });

  // --- cancel path (safety net) ------------------------------------------------------------------

  it("cancel press cancels for admins and stays inert for strangers", async () => {
    const stranger = callbackCtx(LGSET_CB.no, chatA, { admin: null });
    await dispatchSetup(stranger.ctx);
    expect(stranger.toasts).toEqual([undefined]); // spinner only
    expect(stranger.sent).toHaveLength(0);

    const admin = callbackCtx(LGSET_CB.no, chatA, { admin: owner });
    await dispatchSetup(admin.ctx);
    expect(admin.sent[0].text).toBe(SETUP_CANCELLED_TEXT);
    expect(await boundChatId()).toBeNull();
  });

  // --- General Settings reachability (item 22) ---------------------------------------------------

  it("22. General Settings is reachable in BOTH admin menu modes", async () => {
    clearTextCache();
    // INLINE mode: the shared definition carries the General Settings entry
    // with its stable callback, and the inline renderer emits it.
    const definition = await buildAdminMainMenuDefinition(owner);
    const entry = definition.flat().find((b) => b.action === "GENERAL_SETTINGS");
    expect(entry).toBeDefined();
    expect(entry?.callback).toBe(CB.ADMIN_GENERAL_SETTINGS);
    expect(entry?.buttonKey).toBe(ADMIN_MAIN_MENU_ACTION_WIRING.GENERAL_SETTINGS.buttonKey);
    expect(entry?.label).toContain("تنظیمات عمومی");

    const inline = await buildAdminMainKeyboard(owner);
    const inlineFlat = inline.inline_keyboard.flat() as Array<{
      text?: string;
      callback_data?: string;
    }>;
    expect(
      inlineFlat.some(
        (b) => b.callback_data === CB.ADMIN_GENERAL_SETTINGS && b.text === entry?.label,
      ),
    ).toBe(true);

    // REPLY mode: the same label is rendered as a reply button and resolves
    // back to the SAME action for an active admin.
    const reply = (await buildAdminMainReplyKeyboard(owner)) as unknown as {
      keyboard: Array<Array<{ text: string }>>;
    };
    expect(reply.keyboard.flat().map((b) => b.text)).toContain(entry?.label ?? "");
    expect(await resolveAdminMainMenuAction(entry?.label ?? "", owner)).toEqual({
      matched: true,
      authorized: true,
      action: "GENERAL_SETTINGS",
    });
    // A label match still never authorizes a non-admin.
    expect(await resolveAdminMainMenuAction(entry?.label ?? "", null)).toEqual({
      matched: true,
      authorized: false,
    });
  });
});

describe.skipIf(hasDb)("log-group setup wizard (skipped)", () => {
  it("wizard integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
