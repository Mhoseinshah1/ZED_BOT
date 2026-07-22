import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-failcancel-tests-secret";

import {
  logGroupIdHandler,
} from "../src/handlers/admin-settings/log-group-id.handler.js";
import {
  activateLogGroup,
  attemptShortId,
  cancelSetupAttempt,
} from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  activeChatIdSetting,
  callbackCtx,
  clearLogGroupSettings,
  clearSetupLock,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  DUMMY_BOT_TOKEN,
  ERR,
  makeFetchMock,
  makeJob,
  OK_TOPIC,
  resetOpsTopicBindings,
  seedOpsTopics,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 58-64: failure + cancellation safety. Partial topic creation is
// resume-safe (a mid-loop retryable failure leaves the attempt PROVISIONING
// with the topics made so far; a re-run finishes the rest). A direct-test
// failure prevents activation. Failures surface a SAFE error code, never a raw
// Telegram description. Retry reuses the SAME durable attempt (and its staged
// bindings). Cancellation aborts activation, preserves the previously active
// group and never writes the cancelled attempt's staged topics into the active
// LogTopic mapping.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_070;
const CHAT = "-1002000740011";
const GROUP_A = "-1002000740001";

const SAFE_ERROR_CODES = new Set([
  "forbidden",
  "chat-not-found",
  "rate-limited",
  "telegram-timeout",
  "telegram-server-error",
  "bot-not-member",
  "bot-not-admin",
  "manage-topics-required",
  "topics-disabled",
  "topic-missing",
  "topic-closed",
  "bad-request",
  "network-error",
  "bad-response",
  "bot-token-missing",
  "redis-unavailable",
  "setup-error",
]);

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

function bindingsFor(base: number): Record<string, number> {
  const out: Record<string, number> = {};
  OPS_LOG_TOPIC_KEYS.forEach((key, i) => {
    out[key] = base + i;
  });
  return out;
}

describe.runIf(hasDb && hasRedis)("failure + cancellation - scenarios 58-64", () => {
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
    await prisma.auditLog.deleteMany({
      where: { entityType: "LogGroupSetupAttempt", actorTelegramId: owner.telegramId },
    });
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    await harness.close();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("58. a mid-loop retryable failure leaves the attempt PROVISIONING; a re-run resumes", async () => {
    // Run 1: fail (retryable, non-429) on the 5th create -> keys 1-4 persisted,
    // throw. A 5xx is a generic retryable failure that consumes a BullMQ
    // attempt (the 429 rate-limit path is covered separately below).
    const run1 = makeFetchMock({
      createForumTopic: (n) =>
        n === 5 ? ERR(500, "Internal Server Error") : OK_TOPIC(4000 + n),
    });
    vi.stubGlobal("fetch", run1.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await expect(processor(makeJob(attempt.id, { attemptsMade: 0, attempts: 3 }))).rejects.toThrow(
      /topic-provision-retryable/,
    );
    const mid = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(mid.status).toBe(LogGroupSetupStatus.PROVISIONING);
    expect(mid.createdTopicCount).toBe(4);
    expect(Object.keys(mid.topicBindings as Record<string, number>)).toHaveLength(4);

    // Run 2: full success resumes and creates ONLY the 7 remaining keys.
    vi.unstubAllGlobals();
    const run2 = makeFetchMock();
    vi.stubGlobal("fetch", run2.fn);
    const result = await processor(makeJob(attempt.id, { attemptsMade: 1, attempts: 3 }));
    expect(result.ok).toBe(true);
    expect(run2.createTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length - 4);
    const done = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done.status).toBe(LogGroupSetupStatus.ACTIVE);
    expect(Object.keys(done.topicBindings as Record<string, number>)).toHaveLength(
      OPS_LOG_TOPIC_KEYS.length,
    );
    expect(await activeChatIdSetting()).toBe(CHAT);
  });

  it("59. a direct-test failure prevents activation (no Settings write)", async () => {
    const fetchMock = makeFetchMock({
      sendMessage: () => ERR(400, "Bad Request: chat not found"),
    });
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const result = await processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }));
    expect(result.failed).toBe("direct-test");

    // All 11 topics were created, but the group never activated.
    expect(fetchMock.createTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.FAILED);
    expect(fresh.directTestOk).toBe(false);
    expect(await activeChatIdSetting()).toBeNull();
  });

  it("60. a failure records a SAFE error code, never a raw Telegram description", async () => {
    const fetchMock = makeFetchMock({
      createForumTopic: () => ERR(403, "Forbidden: bot was kicked from the supergroup chat"),
    });
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }));
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.safeErrorCode).not.toBeNull();
    expect(SAFE_ERROR_CODES.has(fresh.safeErrorCode ?? "")).toBe(true);
    // "bot was kicked" is an operation-aware bot-not-member signal (§6), still
    // a safe code - never the raw description text or spaces.
    expect(fresh.safeErrorCode).toBe("bot-not-member");
    expect(fresh.safeErrorCode?.includes(" ")).toBe(false);
    expect(fresh.safeErrorCode?.includes("kicked")).toBe(false);
  });

  it("61. retry (id_retry) reuses the SAME failed attempt and preserves its staged bindings", async () => {
    const staged = { SYSTEM: 4101, ERROR: 4102, PAYMENT: 4103, ORDER: 4104 };
    const attempt = await createAttempt({
      chatId: CHAT,
      adminId: owner.id,
      status: LogGroupSetupStatus.FAILED,
      activeSlot: null,
      bindings: staged,
    });
    await prisma.logGroupSetupAttempt.update({
      where: { id: attempt.id },
      data: { safeErrorCode: "rate-limited" },
    });

    const sid = attemptShortId(attempt.id);
    const { ctx } = callbackCtx(`admin:lg:id_retry:${sid}`, { admin: owner });
    await logGroupIdHandler.middleware()(ctx as never, async () => {});

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    // Same durable row, re-queued, error cleared, bindings intact (resume-safe).
    expect(fresh.id).toBe(attempt.id);
    expect(fresh.status).toBe(LogGroupSetupStatus.QUEUED);
    expect(fresh.activeSlot).toBe(1);
    expect(fresh.safeErrorCode).toBeNull();
    expect(fresh.topicBindings as Record<string, number>).toEqual(staged);
  });

  it("62. cancelling an in-flight attempt aborts activation (no Settings write)", async () => {
    const attempt = await createAttempt({
      chatId: CHAT,
      adminId: owner.id,
      status: LogGroupSetupStatus.PROVISIONING,
      bindings: { SYSTEM: 4201, ERROR: 4202 },
    });
    expect(await cancelSetupAttempt(attempt.id)).toBe(true);

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const result = await processor(makeJob(attempt.id));
    // The processor refuses a terminal (cancelled) attempt.
    expect(result.skipped).toBeDefined();
    expect(fetchMock.createTopicCalls).toHaveLength(0);

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.CANCELLED);
    expect(await activeChatIdSetting()).toBeNull();
  });

  it("63+64. cancellation preserves the active group and never writes staged topics", async () => {
    // Group A active; a cancelled B attempt must not disturb A's mapping.
    await activateLogGroup({ chatId: GROUP_A, title: "Group A", bindings: bindingsFor(3000) });
    const attempt = await createAttempt({
      chatId: CHAT,
      adminId: owner.id,
      status: LogGroupSetupStatus.PROVISIONING,
      bindings: { SYSTEM: 4301, ERROR: 4302, PAYMENT: 4303 },
      previousChatId: GROUP_A,
    });
    await cancelSetupAttempt(attempt.id);

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    await processor(makeJob(attempt.id));

    // A stays active; no LogTopic points at the cancelled B attempt.
    expect(await activeChatIdSetting()).toBe(GROUP_A);
    const boundToB = await prisma.logTopic.count({
      where: { key: { in: [...OPS_LOG_TOPIC_KEYS] }, telegramChatId: BigInt(CHAT) },
    });
    expect(boundToB).toBe(0);
    const rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(GROUP_A);
    }
  });
});
