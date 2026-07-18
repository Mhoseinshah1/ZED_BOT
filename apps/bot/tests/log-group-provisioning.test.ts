import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS, OPS_LOG_TOPIC_TITLES } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-provisioning-tests-sec";

import {
  confirmLogGroupConnection,
  createLogGroupSetupAttempt,
  SETUP_QUEUE_UNAVAILABLE_TEXT,
} from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
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
  makeProbeApi,
  resetOpsTopicBindings,
  seedOpsTopics,
  ERR,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 33-43: confirmation claims the single active slot idempotently,
// and the WORKER PROCESSOR (imported from apps/worker/dist - the exact code
// the worker runs) provisions the 11 default forum topics from the shared
// registry, persists each binding durably (resume-safe: a re-run creates only
// the MISSING keys), rejects an unknown job name, fails-soft when Redis is
// unavailable at enqueue time, and on a non-retryable Telegram failure marks
// the attempt FAILED without ever activating the group.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_040;
const CHAT = "-1002000710011";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

describe.runIf(hasDb && hasRedis)("provisioning + worker processor - scenarios 33-43", () => {
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
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
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

  // --- confirmation claims the single slot (33-34) ---------------------------

  it("33. confirmation moves the ONE attempt VALIDATED -> QUEUED + claims the active slot", async () => {
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    expect(result.ok).toBe(true);
    const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: created.attempt.id } });
    expect(attempt?.status).toBe(LogGroupSetupStatus.QUEUED);
    expect(attempt?.activeSlot).toBe(1);
    const all = await prisma.logGroupSetupAttempt.count({ where: { requestedByAdminId: owner.id } });
    expect(all).toBe(1);
  });

  it("34. a repeated confirmation is idempotent - same attempt, no second slot", async () => {
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    if (!created.ok) throw new Error("setup");
    const first = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    const second = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    expect(first.ok && second.ok).toBe(true);
    expect(second.attempt?.id).toBe(created.attempt.id);
    const slots = await prisma.logGroupSetupAttempt.count({
      where: { requestedByAdminId: owner.id, activeSlot: 1 },
    });
    expect(slots).toBe(1);
  });

  // --- the worker provisioning loop (35-38) ----------------------------------

  it("35. the processor creates all 11 default topics with the shared registry titles", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const result = await processor(makeJob(attempt.id));
    expect(result.ok).toBe(true);
    expect(fetchMock.createTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    // Names are the shared OPS_LOG_TOPIC_TITLES, in stable key order.
    expect(fetchMock.createTopicCalls.map((c) => c.name)).toEqual(
      OPS_LOG_TOPIC_KEYS.map((k) => OPS_LOG_TOPIC_TITLES[k]),
    );
    // Every create targeted the staged chat id (as a string, never a float).
    expect(fetchMock.createTopicCalls.every((c) => c.chatId === CHAT)).toBe(true);
  });

  it("36. every created topic id is persisted to attempt.topicBindings + the LogTopic rows", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const bindings = fresh.topicBindings as Record<string, unknown>;
    expect(Object.keys(bindings).sort()).toEqual([...OPS_LOG_TOPIC_KEYS].sort());
    for (const key of OPS_LOG_TOPIC_KEYS) {
      expect(typeof bindings[key], key).toBe("number");
    }
    expect(fresh.createdTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);

    // The active LogTopic rows are bound to the same chat + thread ids.
    const rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(CHAT);
      expect(row.topicId, row.key).toBe(bindings[row.key]);
    }
  });

  it("37. a re-run resumes from saved bindings - only MISSING keys are created", async () => {
    const preset = { SYSTEM: 5001, ERROR: 5002, PAYMENT: 5003 };
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id, bindings: preset });

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const result = await processor(makeJob(attempt.id));
    expect(result.ok).toBe(true);

    // The 3 pre-staged keys are never recreated; only the 8 missing ones are.
    const missing = OPS_LOG_TOPIC_KEYS.filter((k) => !(k in preset));
    expect(fetchMock.createTopicCalls).toHaveLength(missing.length);
    expect(fetchMock.createTopicCalls.map((c) => c.name).sort()).toEqual(
      missing.map((k) => OPS_LOG_TOPIC_TITLES[k]).sort(),
    );
    // The preset bindings are preserved verbatim.
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const bindings = fresh.topicBindings as Record<string, number>;
    expect(bindings.SYSTEM).toBe(5001);
    expect(bindings.ERROR).toBe(5002);
    expect(bindings.PAYMENT).toBe(5003);
    expect(fresh.status).toBe(LogGroupSetupStatus.ACTIVE);
  });

  // --- guardrails (40-43) ----------------------------------------------------

  it("40. an unknown job name throws (never silently processed)", async () => {
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await expect(processor(makeJob(attempt.id, { name: "SOME_OTHER_JOB" }))).rejects.toThrow(
      /unknown job/,
    );
  });

  it("41. Redis unavailable at enqueue -> confirm returns SETUP_QUEUE_UNAVAILABLE, no activation", async () => {
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    if (!created.ok) throw new Error("setup");

    const savedUrl = process.env.REDIS_URL;
    const savedHost = process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    await resetOpsQueueForTests();
    try {
      const result = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
      expect(result.ok).toBe(false);
      expect(result.safeMessage).toBe(SETUP_QUEUE_UNAVAILABLE_TEXT);
      const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: created.attempt.id } });
      // The claim is rolled back: FAILED, slot freed, group NOT activated.
      expect(attempt?.status).toBe(LogGroupSetupStatus.FAILED);
      expect(attempt?.activeSlot).toBeNull();
      expect(attempt?.safeErrorCode).toBe("redis-unavailable");
      expect(await activeChatIdSetting()).toBeNull();
    } finally {
      if (savedUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = savedUrl;
      if (savedHost === undefined) delete process.env.REDIS_HOST;
      else process.env.REDIS_HOST = savedHost;
      await resetOpsQueueForTests();
    }
  });

  it("42. a non-retryable createForumTopic failure on the final attempt -> FAILED, group untouched", async () => {
    const fetchMock = makeFetchMock({
      createForumTopic: () => ERR(403, "Forbidden: bot is not a member"),
    });
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const result = await processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }));
    expect(result.failed).toBe("topic-provision");

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.FAILED);
    expect(fresh.activeSlot).toBeNull(); // slot freed for the next setup
    expect(fresh.safeErrorCode).toBe("forbidden"); // a safe code, not a raw description
    // The group was never activated.
    expect(await activeChatIdSetting()).toBeNull();
    const bound = await prisma.logTopic.count({
      where: { key: { in: [...OPS_LOG_TOPIC_KEYS] }, telegramChatId: { not: null } },
    });
    expect(bound).toBe(0);
  });
});
