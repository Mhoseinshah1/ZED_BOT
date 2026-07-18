import { prisma, LogGroupSetupStatus, LogDeliveryStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-activation-tests-secret";

import {
  getLogGroupSettings,
} from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  clearSetupLock,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  DUMMY_BOT_TOKEN,
  makeFetchMock,
  makeJob,
  resetOpsTopicBindings,
  seedOpsTopics,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 44-51: worker activation. The direct SYSTEM test send fires while
// the group is still only STAGED (before any Settings write); only after
// Telegram accepts it does the atomic transaction switch the log-group
// Settings AND all 11 LogTopic bindings together and mark the attempt ACTIVE
// (slot freed, directTestOk true). A normal queued log_group.connected
// SystemLog + its SystemLogDelivery (targeting the SYSTEM topic) then verify
// the whole pipeline, and the bot reads the new group with no restart.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_050;
const CHAT = "-1002000720011";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function jsonResponse(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => body };
}

describe.runIf(hasDb && hasRedis)("worker activation - scenarios 44-51", () => {
  let owner: Admin;
  let harness: WorkerHarness;
  let processor: Processor;
  const suiteStartedAt = new Date();

  beforeAll(async () => {
    process.env.BOT_TOKEN = DUMMY_BOT_TOKEN;
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG), role: "OWNER", isActive: true },
    });
    await seedOpsTopics();
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    const mod = (await import(WORKER_LOG_GROUP_SETUP_DIST)) as {
      createLogGroupSetupProcessor: (deps: unknown) => Processor;
    };
    harness = await createWorkerHarness();
    processor = mod.createLogGroupSetupProcessor({ redis: harness.redis, setupQueue: harness.queue });
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
    await clearSetupLock(harness.redis as { del: (...k: string[]) => Promise<number> });
    await prisma.systemLogDelivery.deleteMany({
      where: {
        systemLog: {
          is: {
            eventType: { in: ["log_group.connected", "log_group.topic_created"] },
            createdAt: { gte: suiteStartedAt },
          },
        },
      },
    });
    await prisma.systemLog.deleteMany({
      where: {
        eventType: { in: ["log_group.connected", "log_group.topic_created"] },
        createdAt: { gte: suiteStartedAt },
      },
    });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await harness.close();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("44. the direct SYSTEM test send fires BEFORE activation, to the SYSTEM thread", async () => {
    let settingAtSend: string | null | "unset" = "unset";
    let sendThreadId: number | undefined;
    let seq = 7000;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.includes("/createForumTopic")) {
        seq += 1;
        return jsonResponse({ ok: true, result: { message_thread_id: seq } });
      }
      // sendMessage: capture the live Settings + thread id AT SEND TIME.
      settingAtSend = await activeChatIdSetting();
      sendThreadId = typeof body.message_thread_id === "number" ? body.message_thread_id : undefined;
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    });

    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const result = await processor(makeJob(attempt.id));
    expect(result.ok).toBe(true);
    // At send time the group was NOT yet active (test precedes activation).
    expect(settingAtSend).toBeNull();
    // The test message went to the staged SYSTEM topic thread.
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const bindings = fresh.topicBindings as Record<string, number>;
    expect(sendThreadId).toBe(bindings.SYSTEM);
    // Only after success is the group active.
    expect(await activeChatIdSetting()).toBe(CHAT);
  });

  it("45. Settings + all 11 LogTopic bindings switch atomically to the new group", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    expect(await activeChatIdSetting()).toBe(CHAT);
    const title = await prisma.setting.findUnique({ where: { key: "log_group_title" } });
    expect(title?.value).not.toBe("");
    const rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
    expect(rows).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(CHAT);
      expect(row.topicId, row.key).not.toBeNull();
    }
  });

  it("46. the attempt ends ACTIVE with the slot freed and directTestOk true", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.ACTIVE);
    expect(fresh.activeSlot).toBeNull();
    expect(fresh.directTestOk).toBe(true);
    expect(fresh.completedAt).not.toBeNull();
  });

  it("47-48. a queued log_group.connected SystemLog + a delivery targeting SYSTEM are created", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    const log = await prisma.systemLog.findFirst({
      where: { eventType: "log_group.connected", createdAt: { gte: suiteStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log?.message).toContain("گروه لاگ با موفقیت متصل و فعال شد");

    const delivery = await prisma.systemLogDelivery.findFirst({ where: { systemLogId: log?.id ?? "" } });
    expect(delivery).not.toBeNull();
    // The delivery targets the SYSTEM topic (the whole pipeline's proof point).
    const systemTopic = await prisma.logTopic.findUnique({ where: { key: "SYSTEM" } });
    expect(delivery?.logTopicId).toBe(systemTopic?.id);
    expect(delivery?.status).toBe(LogDeliveryStatus.PENDING);
  });

  it("49-51. operational logs use the new group in-process (no restart required)", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    // The bot service reads the freshly-written Settings without a restart.
    clearSettingsCache();
    const settings = await getLogGroupSettings();
    expect(settings.chatId).toBe(CHAT);
  });
});
