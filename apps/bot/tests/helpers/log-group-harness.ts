import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  LogGroupSetupStatus,
  prisma,
  type Admin,
  type LogGroupSetupAttempt,
  type Prisma,
} from "@zedbot/database";
import {
  getRedisOptions,
  LOG_GROUP_SETUP_JOB_NAME,
  LOG_GROUP_SETUP_LOCK_KEY,
  LOG_GROUP_SETUP_QUEUE_NAME,
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { GrammyError } from "grammy";

import { initialSession } from "../../src/core/session.js";
import type { LogGroupProbeApi } from "../../src/services/log-group-connection.service.js";
import { clearSettingsCache } from "../../src/services/settings.service.js";
import { LOG_GROUP_CHAT_ID_KEY } from "../../src/services/system-log.service.js";
import { LOG_GROUP_TITLE_KEY } from "../../src/services/log-group.service.js";

// =============================================================================
// Shared harness for the direct numeric-ID log-group setup test matrix.
// Provides: a configurable fake grammY probe api (LogGroupProbeApi), fake
// grammY contexts to drive the id handler composers, a real BullMQ
// queue/RawRedis + a mocked global fetch to drive the worker processor
// (imported from apps/worker/dist), and DB fixture helpers. Every helper is
// dependency-free of the tests so all suites converge on ONE harness.
// =============================================================================

// The worker's config reads BOT_TOKEN (NOT TELEGRAM_BOT_TOKEN) - a dummy value
// makes botToken() return non-null so the processor reaches provisioning.
export const DUMMY_BOT_TOKEN = "123456:worker-test-token";

/** Path to the BUILT worker processor - the exact code the worker runs. */
export const WORKER_LOG_GROUP_SETUP_DIST = fileURLToPath(
  new URL("../../../worker/dist/log-group-setup.js", import.meta.url),
);

// --- fake grammY probe api ---------------------------------------------------

export interface FakeChat {
  type: string;
  is_forum?: boolean;
  username?: string;
  title?: string;
}

export interface ProbeApiConfig {
  botId?: number;
  /** getChat result, or "not-found" to throw a chat-not-found GrammyError. */
  chat?: FakeChat | "not-found";
  /** getChatMember(bot) result, or "throw" to fail the lookup. */
  botMember?: Record<string, unknown> | "throw";
  /** getChatMember(owner) result, or "throw" to fail the lookup. */
  ownerMember?: Record<string, unknown> | "throw";
}

export interface RecordingProbeApi extends LogGroupProbeApi {
  getChatCalls: Array<number | string>;
  getChatMemberCalls: Array<{ chatId: number | string; userId: number }>;
}

function chatNotFoundError(): GrammyError {
  return new GrammyError(
    "Call to 'getChat' failed!",
    { ok: false, error_code: 400, description: "Bad Request: chat not found" },
    "getChat",
    {},
  );
}

/** Builds a configurable LogGroupProbeApi that records every call. */
export function makeProbeApi(config: ProbeApiConfig = {}): RecordingProbeApi {
  const botId = config.botId ?? 4_242_777_001;
  const chat = config.chat ?? {
    type: "supergroup",
    is_forum: true,
    title: "Private Ops Log",
  };
  const botMember = config.botMember ?? { status: "administrator", can_manage_topics: true };
  const ownerMember = config.ownerMember ?? { status: "member" };

  const api: RecordingProbeApi = {
    getChatCalls: [],
    getChatMemberCalls: [],
    me: { id: botId },
    async getChat(chatId) {
      api.getChatCalls.push(chatId);
      if (chat === "not-found") {
        throw chatNotFoundError();
      }
      return chat;
    },
    async getChatMember(chatId, userId) {
      api.getChatMemberCalls.push({ chatId, userId });
      if (userId === botId) {
        if (botMember === "throw") {
          throw chatNotFoundError();
        }
        return botMember as { status: string; can_manage_topics?: boolean };
      }
      if (ownerMember === "throw") {
        throw chatNotFoundError();
      }
      return ownerMember as { status: string };
    },
  };
  return api;
}

// --- fake grammY contexts (drive the id handler composers) -------------------

export interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

export interface InlineButton {
  text?: string;
  callback_data?: string;
  url?: string;
}

export const BOT_ID = 4_242_777_001;
export const BOT_USERNAME = "zedlog_id_fixture_bot";

export interface CtxOptions {
  admin?: Admin | null;
  probe?: ProbeApiConfig;
  botId?: number;
  session?: ReturnType<typeof initialSession>;
}

interface CtxRecorders {
  sent: SentMessage[];
  toasts: Array<string | undefined>;
  edits: SentMessage[];
}

function buildSharedCtx(options: CtxOptions, recorders: CtxRecorders) {
  const botId = options.botId ?? BOT_ID;
  const probeApi = makeProbeApi({ botId, ...options.probe });
  const me = { id: botId, is_bot: true, first_name: "ZedBot", username: BOT_USERNAME };
  const from = {
    id: Number(options.admin?.telegramId ?? 999_777_001n),
    is_bot: false,
    first_name: "Owner",
  };
  return {
    from,
    me,
    admin: options.admin ?? null,
    dbUser: null,
    session: options.session ?? initialSession(),
    api: {
      getChat: (chatId: number | string) => probeApi.getChat(chatId),
      getChatMember: (chatId: number | string, userId: number) =>
        probeApi.getChatMember(chatId, userId),
    },
    reply: async (text: string, other?: Record<string, unknown>) => {
      recorders.sent.push({ text, other });
      return {};
    },
    editMessageText: async (text: string, other?: Record<string, unknown>) => {
      recorders.edits.push({ text, other });
      recorders.sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      recorders.toasts.push(payload?.text);
      return true;
    },
  };
}

/** Callback-query update (no message payload - replies are recorded). */
export function callbackCtx(data: string, options: CtxOptions = {}) {
  const recorders: CtxRecorders = { sent: [], toasts: [], edits: [] };
  const shared = buildSharedCtx(options, recorders);
  const callbackQuery = { id: "cbq-1", chat_instance: "ci-1", from: shared.from, data };
  const ctx = { ...shared, callbackQuery, update: { update_id: 2, callback_query: callbackQuery } };
  return { ctx: ctx as never, ...recorders, session: shared.session };
}

/** Plain text message update (drives the "lg:chat_id" input flow). */
export function textCtx(text: string, options: CtxOptions = {}) {
  const recorders: CtxRecorders = { sent: [], toasts: [], edits: [] };
  const shared = buildSharedCtx(options, recorders);
  const message = {
    message_id: 11,
    date: 0,
    chat: { id: shared.from.id, type: "private" },
    from: shared.from,
    text,
  };
  const ctx = { ...shared, message, update: { update_id: 1, message } };
  return { ctx: ctx as never, ...recorders, session: shared.session };
}

export function inlineButtons(sent: SentMessage): InlineButton[][] {
  const markup = sent.other?.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return markup?.inline_keyboard ?? [];
}

export function flatButtons(sent: SentMessage): InlineButton[] {
  return inlineButtons(sent).flat();
}

// --- worker processor harness (real queue + RawRedis, mocked fetch) ----------

export interface WorkerHarness {
  queue: Queue;
  redis: unknown;
  close: () => Promise<void>;
}

/** Builds the real BullMQ queue + RawRedis the worker processor needs. */
export async function createWorkerHarness(): Promise<WorkerHarness> {
  const options = getRedisOptions();
  if (options === null) {
    throw new Error("REDIS_URL must be set for the worker processor harness");
  }
  const queue = new Queue(LOG_GROUP_SETUP_QUEUE_NAME, {
    connection: { ...options, maxRetriesPerRequest: null },
  });
  queue.on("error", () => undefined);
  const redis = await queue.client;
  return {
    queue,
    redis,
    close: async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    },
  };
}

export interface FakeJobOptions {
  attemptsMade?: number;
  attempts?: number;
  name?: string;
}

/** Fake BullMQ job accepted by the processor (only the fields it reads). */
export function makeJob(attemptId: string, options: FakeJobOptions = {}) {
  return {
    name: options.name ?? LOG_GROUP_SETUP_JOB_NAME,
    data: { attemptId },
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 3 },
  };
}

// --- mocked global fetch (Telegram Bot API) ----------------------------------

export interface TgResp {
  status: number;
  body: unknown;
}

export interface FetchMockOptions {
  createForumTopic?: (n: number, call: { chatId: string; name: string }) => TgResp;
  sendMessage?: (n: number, call: { chatId: string; text: string; threadId?: number }) => TgResp;
}

export interface FetchMock {
  fn: typeof fetch;
  createTopicCalls: Array<{ chatId: string; name: string }>;
  sendCalls: Array<{ chatId: string; text: string; threadId?: number }>;
}

function fakeResponse(resp: TgResp): Response {
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    json: async () => resp.body,
  } as unknown as Response;
}

export const OK_TOPIC = (threadId: number): TgResp => ({
  status: 200,
  body: { ok: true, result: { message_thread_id: threadId } },
});
export const OK_SEND = (messageId: number): TgResp => ({
  status: 200,
  body: { ok: true, result: { message_id: messageId } },
});
export const ERR = (status: number, description: string, retryAfter?: number): TgResp => ({
  status,
  body: {
    ok: false,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  },
});

/** Builds a global-fetch stand-in that records + classifies Telegram calls. */
export function makeFetchMock(options: FetchMockOptions = {}): FetchMock {
  let threadSeq = 6000;
  let msgSeq = 900;
  let createCount = 0;
  let sendCount = 0;
  const createTopicCalls: Array<{ chatId: string; name: string }> = [];
  const sendCalls: Array<{ chatId: string; text: string; threadId?: number }> = [];

  const fn = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.includes("/createForumTopic")) {
      createCount += 1;
      const call = { chatId: String(body.chat_id), name: String(body.name) };
      createTopicCalls.push(call);
      const resp =
        options.createForumTopic?.(createCount, call) ?? OK_TOPIC((threadSeq += 1));
      return fakeResponse(resp);
    }
    if (url.includes("/sendMessage")) {
      sendCount += 1;
      const call = {
        chatId: String(body.chat_id),
        text: String(body.text),
        threadId: typeof body.message_thread_id === "number" ? body.message_thread_id : undefined,
      };
      sendCalls.push(call);
      const resp = options.sendMessage?.(sendCount, call) ?? OK_SEND((msgSeq += 1));
      return fakeResponse(resp);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { fn, createTopicCalls, sendCalls };
}

// --- DB fixture helpers ------------------------------------------------------

/** Ensures every stable ops topic key has an (unbound, enabled) LogTopic row. */
export async function seedOpsTopics(): Promise<void> {
  for (const key of OPS_LOG_TOPIC_KEYS) {
    await prisma.logTopic.upsert({
      where: { key },
      update: {},
      create: { key, title: OPS_LOG_TOPIC_TITLES[key] },
    });
  }
}

/** Resets every ops LogTopic to unbound + enabled (deterministic start). */
export async function resetOpsTopicBindings(): Promise<void> {
  await prisma.logTopic.updateMany({
    where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
    data: { topicId: null, telegramChatId: null, isEnabled: true },
  });
}

/** Clears the active log-group Settings + refreshes the cache. */
export async function clearLogGroupSettings(): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: { in: [LOG_GROUP_CHAT_ID_KEY, LOG_GROUP_TITLE_KEY] } },
  });
  clearSettingsCache();
}

/** Reads the active log-group chat id Setting directly (bypasses the cache). */
export async function activeChatIdSetting(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: LOG_GROUP_CHAT_ID_KEY } });
  return row?.value ?? null;
}

export interface QueuedAttemptInput {
  chatId: string;
  title?: string;
  adminId: string;
  status?: LogGroupSetupStatus;
  activeSlot?: number | null;
  bindings?: Record<string, number>;
  attemptsMade?: number;
  previousChatId?: string | null;
}

/**
 * Creates a setup attempt directly in the DB (bypasses the bot confirm flow)
 * so processor-level tests can start from an exact staged state.
 */
export async function createAttempt(input: QueuedAttemptInput): Promise<LogGroupSetupAttempt> {
  return prisma.logGroupSetupAttempt.create({
    data: {
      chatId: BigInt(input.chatId),
      safeTitle: input.title ?? "Staged Ops Log",
      status: input.status ?? LogGroupSetupStatus.QUEUED,
      requestedByAdminId: input.adminId,
      activeSlot: input.activeSlot === undefined ? 1 : input.activeSlot,
      idempotencyKey: randomUUID(),
      previousChatId: input.previousChatId == null ? null : BigInt(input.previousChatId),
      ...(input.bindings === undefined
        ? {}
        : {
            topicBindings: input.bindings as unknown as Prisma.InputJsonValue,
            createdTopicCount: Object.keys(input.bindings).length,
          }),
    },
  });
}

/** Deletes every attempt a test admin created (afterEach cleanup). */
export async function deleteAttemptsFor(adminIds: string[]): Promise<void> {
  await prisma.logGroupSetupAttempt.deleteMany({
    where: { requestedByAdminId: { in: adminIds } },
  });
}

/** Frees the worker Redis setup lock (afterEach safety net). */
export async function clearSetupLock(redis: {
  del: (...keys: string[]) => Promise<number>;
}): Promise<void> {
  await redis.del(LOG_GROUP_SETUP_LOCK_KEY).catch(() => undefined);
}
