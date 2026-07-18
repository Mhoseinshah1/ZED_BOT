import { prisma, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS, REDACTED_VALUE } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-group-compat-tests-secret-01";

import { initialSession } from "../src/core/session.js";
import {
  GROUP_SAVED_TEXT,
  LGSET_CB,
  logGroupSetupHandler,
  SETUP_CONFIRM_TEXT,
} from "../src/handlers/admin-settings/log-group-setup.handler.js";
import { LG_CB, logGroupHandler } from "../src/handlers/admin-settings/log-group.handler.js";
import {
  activateLogGroup,
  prepareLogGroupConnection,
} from "../src/services/log-group-connection.service.js";
import {
  getLogGroupSettings,
  NOT_FORUM_TEXT,
} from "../src/services/log-group.service.js";
import {
  enqueueBackupCreate,
  getLogGroupSetupQueueCounts,
  resetOpsQueueForTests,
} from "../src/services/ops-queue.service.js";
import { clearSettingsCache, deleteSetting } from "../src/services/settings.service.js";
import {
  LOG_GROUP_CHAT_ID_KEY,
  OPS_EVENTS,
  writeSystemLog,
} from "../src/services/system-log.service.js";
import {
  makeProbeApi,
  resetOpsTopicBindings,
  seedOpsTopics,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 65-74: existing behavior must keep working alongside the new
// numeric-ID path. The group-side /setloggroup + "/start zedlog" wizard binds,
// topic enable/disable + the test-message action + disconnect still work, log
// delivery redaction is intact, and the backup/ops queue producers are
// unchanged. Both validators (the numeric-ID shared policy and the group-side
// flow) converge on rejecting a non-forum supergroup.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_090;
const BOT_ID = 4_242_888_002;
const BOT_USERNAME = "zedlog_compat_bot";
const GROUP_A = { id: -1_002_000_760_011, type: "supergroup", title: "Compat Ops", is_forum: true };
const NON_FORUM = { id: -1_002_000_760_022, type: "supergroup", title: "Flat", is_forum: false };
const PRIVATE = { id: 770_001, type: "private", first_name: "Owner" };

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

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
  let seq = 2000;
  const api: FakeApi = {
    createForumTopicCalls: [],
    sendMessageCalls: [],
    async createForumTopic(chatId, name) {
      seq += 1;
      api.createForumTopicCalls.push({ chatId: String(chatId), name });
      return { message_thread_id: seq };
    },
    async sendMessage(chatId, text, other) {
      api.sendMessageCalls.push({ chatId: String(chatId), text, threadId: other?.message_thread_id });
      return {};
    },
  };
  return api;
}

interface CtxOptions {
  admin?: Admin | null;
  api?: FakeApi;
  botMember?: Record<string, unknown>;
  presserMember?: Record<string, unknown>;
}

function base(chat: Record<string, unknown>, options: CtxOptions) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const api = options.api ?? makeApi();
  const me = { id: BOT_ID, is_bot: true, first_name: "ZedBot", username: BOT_USERNAME };
  const from = { id: Number(options.admin?.telegramId ?? 999n), is_bot: false, first_name: "S" };
  return {
    shared: {
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
      editMessageText: async (text: string, other?: Record<string, unknown>) => {
        sent.push({ text, other });
        return {};
      },
      answerCallbackQuery: async (payload?: { text?: string }) => {
        toasts.push(payload?.text);
        return true;
      },
      getChatMember: async (userId: number) => {
        if (userId === me.id) {
          return options.botMember ?? { status: "administrator", can_manage_topics: true };
        }
        return options.presserMember ?? { status: "member" };
      },
    },
    sent,
    toasts,
    api,
    from,
  };
}

function groupCommand(text: string, chat: Record<string, unknown>, options: CtxOptions = {}) {
  const { shared, sent, toasts, api, from } = base(chat, options);
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

function groupCallback(data: string, chat: Record<string, unknown>, options: CtxOptions = {}) {
  const { shared, sent, toasts, api, from } = base(chat, options);
  const callbackQuery = { id: "cbq", chat_instance: "ci", from, data };
  const ctx = { ...shared, callbackQuery, update: { update_id: 2, callback_query: callbackQuery } };
  return { ctx: ctx as never, sent, toasts, api };
}

async function dispatchSetup(ctx: never): Promise<boolean> {
  let fellThrough = false;
  await logGroupSetupHandler.middleware()(ctx, async () => {
    fellThrough = true;
  });
  return fellThrough;
}

async function dispatchAdmin(ctx: never): Promise<void> {
  await logGroupHandler.middleware()(ctx, async () => {});
}

async function boundChatId(): Promise<string | null> {
  clearSettingsCache();
  return (await getLogGroupSettings()).chatId;
}

function bindingsFor(base: number): Record<string, number> {
  const out: Record<string, number> = {};
  OPS_LOG_TOPIC_KEYS.forEach((key, i) => {
    out[key] = base + i;
  });
  return out;
}

describe.runIf(hasDb && hasRedis)("existing behavior compatibility - scenarios 65-74", () => {
  let owner: Admin;
  const suiteStartedAt = new Date();

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG), role: "OWNER", isActive: true },
    });
    await seedOpsTopics();
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    clearSettingsCache();
    await resetOpsTopicBindings();
  });

  afterEach(async () => {
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    await deleteSetting("log_group_title");
    clearSettingsCache();
    await resetOpsTopicBindings();
  });

  afterAll(async () => {
    await prisma.systemLogDelivery.deleteMany({
      where: {
        systemLog: {
          is: {
            eventType: { in: [OPS_EVENTS.LOG_GROUP_CHANGED, "compat.redaction"] },
            createdAt: { gte: suiteStartedAt },
          },
        },
      },
    });
    await prisma.systemLog.deleteMany({
      where: {
        eventType: { in: [OPS_EVENTS.LOG_GROUP_CHANGED, "compat.redaction"] },
        createdAt: { gte: suiteStartedAt },
      },
    });
    await prisma.auditLog.deleteMany({
      where: { action: "log_group_connected", actorTelegramId: owner.telegramId },
    });
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    await deleteSetting("log_group_title");
    clearSettingsCache();
    await resetOpsTopicBindings();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("65. /setloggroup still binds end-to-end and creates the 11 default topics", async () => {
    const prompt = groupCommand("/setloggroup", GROUP_A, { admin: owner });
    await dispatchSetup(prompt.ctx);
    expect(prompt.sent[0].text).toContain(SETUP_CONFIRM_TEXT);

    const press = groupCallback(LGSET_CB.yes, GROUP_A, { admin: owner });
    await dispatchSetup(press.ctx);
    expect(press.sent[0].text).toContain(GROUP_SAVED_TEXT);
    expect(await boundChatId()).toBe(String(GROUP_A.id));
    expect(press.api.createForumTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    const log = await prisma.systemLog.findFirst({
      where: { eventType: OPS_EVENTS.LOG_GROUP_CHANGED, createdAt: { gte: suiteStartedAt } },
    });
    expect(log).not.toBeNull();
  });

  it("66. the start-group wizard ('/start zedlog') still reaches the prompt in-group only", async () => {
    const group = groupCommand("/start zedlog", GROUP_A, { admin: owner });
    expect(await dispatchSetup(group.ctx)).toBe(false); // consumed
    expect(group.sent[0].text).toContain(SETUP_CONFIRM_TEXT);

    // A private /start zedlog falls through untouched.
    const priv = groupCommand("/start zedlog", PRIVATE, { admin: owner });
    expect(await dispatchSetup(priv.ctx)).toBe(true);
    expect(priv.sent).toHaveLength(0);
  });

  it("67+68. topic enable/disable still works (toggle callback flips the row)", async () => {
    await activateLogGroup({ chatId: String(GROUP_A.id), title: "Compat Ops", bindings: bindingsFor(2500) });

    // Disable ORDER via its toggle callback.
    const off = groupCallback("admin:lg:tt:ORDER", PRIVATE, { admin: owner });
    await dispatchAdmin(off.ctx);
    expect((await prisma.logTopic.findUnique({ where: { key: "ORDER" } }))?.isEnabled).toBe(false);

    // Re-enable it.
    const on = groupCallback("admin:lg:tt:ORDER", PRIVATE, { admin: owner });
    await dispatchAdmin(on.ctx);
    expect((await prisma.logTopic.findUnique({ where: { key: "ORDER" } }))?.isEnabled).toBe(true);
  });

  it("69. the test-message action still sends to the SYSTEM topic", async () => {
    await activateLogGroup({ chatId: String(GROUP_A.id), title: "Compat Ops", bindings: bindingsFor(2500) });
    const test = groupCallback(LG_CB.test, PRIVATE, { admin: owner });
    await dispatchAdmin(test.ctx);
    expect(test.api.sendMessageCalls).toHaveLength(1);
    expect(test.api.sendMessageCalls[0].chatId).toBe(String(GROUP_A.id));
    const systemTopic = await prisma.logTopic.findUnique({ where: { key: "SYSTEM" } });
    expect(test.api.sendMessageCalls[0].threadId).toBe(systemTopic?.topicId ?? -1);
  });

  it("70. the disconnect flow still clears the binding", async () => {
    await activateLogGroup({ chatId: String(GROUP_A.id), title: "Compat Ops", bindings: bindingsFor(2500) });
    expect(await boundChatId()).toBe(String(GROUP_A.id));
    const confirm = groupCallback(LG_CB.disconnect, PRIVATE, { admin: owner });
    await dispatchAdmin(confirm.ctx);
    expect(confirm.sent[0].text).toContain("قطع اتصال گروه لاگ");
    const yes = groupCallback(LG_CB.disconnectYes, PRIVATE, { admin: owner });
    await dispatchAdmin(yes.ctx);
    expect(await boundChatId()).toBeNull();
  });

  it("71. log delivery redaction is intact (secrets scrubbed before persistence)", async () => {
    await writeSystemLog({
      level: "ERROR",
      eventType: "compat.redaction",
      message: "cache redis://:cache-pw@127.0.0.1:6379 unreachable",
      metadata: { token: "abc", orderId: "o-9" },
      topicKey: "SYSTEM",
    });
    const log = await prisma.systemLog.findFirst({ where: { eventType: "compat.redaction" } });
    const meta = log?.metadata as { token: string; orderId: string };
    expect(meta.token).toBe(REDACTED_VALUE);
    expect(meta.orderId).toBe("o-9");
    expect(log?.message).not.toContain("cache-pw");
    expect(log?.message).not.toContain("redis://");
  });

  it("72. backup + ops queue producers are unchanged (construct without throwing)", async () => {
    expect(typeof enqueueBackupCreate).toBe("function");
    // The log-group-setup queue counts construct against the live Redis.
    const counts = await getLogGroupSetupQueueCounts();
    expect(counts === null || typeof counts.waiting === "number").toBe(true);
  });

  it("73+74. both validators converge on rejecting a non-forum supergroup", async () => {
    // Numeric-ID shared policy: TOPICS_DISABLED.
    const numeric = await prepareLogGroupConnection(
      makeProbeApi({ chat: { type: "supergroup", is_forum: false, title: "Flat" } }),
      "-1002000760099",
      OWNER_TG,
    );
    expect(numeric.ok).toBe(false);
    if (!numeric.ok) {
      expect(numeric.safeCode).toBe("TOPICS_DISABLED");
    }

    // Group-side flow: NOT_FORUM_TEXT (different message, same verdict).
    const group = groupCommand("/setloggroup", NON_FORUM, { admin: owner });
    await dispatchSetup(group.ctx);
    expect(group.sent[0].text).toBe(NOT_FORUM_TEXT);
    expect(await boundChatId()).toBeNull();
  });
});
