import { fileURLToPath } from "node:url";

import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS, WORKER_CAPABILITIES_KEY } from "@zedbot/shared";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "telegram-token-worker-tests-secret-01234";

import {
  confirmLogGroupConnection,
  createLogGroupSetupAttempt,
  evaluateWorkerTelegramTokenReadiness,
  WORKER_TOKEN_CONFLICT_TEXT,
  WORKER_TOKEN_MISSING_TEXT,
} from "../src/services/log-group-connection.service.js";
import { readWorkerCapabilities, resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  clearSetupLock,
  clearWorkerToken,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  makeFetchMock,
  makeJob,
  makeProbeApi,
  resetOpsTopicBindings,
  seedOpsTopics,
  setCanonicalWorkerToken,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// fix/worker-telegram-token-env-contract — worker-facing behaviour that the
// unified token contract turns on:
//   §9 createForumTopic error classification (permission wording is NOT a
//      forum-disabled error);
//   §5 the worker capability snapshot carries safe token readiness (key-name
//      only, never bytes) and the bot reads it back;
//   §6 the log-group preflight refuses to queue an attempt while the WORKER
//      reports a MISSING/CONFLICTing token;
//   §8 a `bot-token-missing` FAILED attempt recovers: once the token is set the
//      SAME durable pipeline provisions all 11 topics and activates.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

// --- §9 classification (pure, no DB) -----------------------------------------

const WORKER_TELEGRAM_DIST = fileURLToPath(
  new URL("../../worker/dist/telegram.js", import.meta.url),
);
type Classified = { safeErrorCode: string; retryable: boolean };
type ClassifyFn = (status: number, body: { description?: string }) => Classified;

describe("§9 classifyCreateForumTopicError (built worker code)", () => {
  let classify: ClassifyFn;

  beforeAll(async () => {
    const mod = (await import(WORKER_TELEGRAM_DIST)) as {
      classifyCreateForumTopicError: ClassifyFn;
    };
    classify = mod.classifyCreateForumTopicError;
  });

  it("a missing-permission error is manage-topics-required, NEVER topics-disabled", () => {
    // Telegram phrases the permission failure with the word "forum" — a bare
    // includes("forum") would misfile it as a disabled-forum error. The fixed
    // order checks permission wording first.
    for (const description of [
      "Bad Request: not enough rights to create a forum topic",
      "Bad Request: not enough rights to manage topics",
      "Bad Request: CHAT_ADMIN_REQUIRED",
      "Bad Request: need to be an administrator",
    ]) {
      const result = classify(400, { description });
      expect(result.safeErrorCode, description).toBe("manage-topics-required");
      expect(result.retryable).toBe(false);
    }
  });

  it("a genuinely forum-disabled chat maps to topics-disabled", () => {
    for (const description of [
      "Bad Request: the chat is not a forum",
      "Bad Request: TOPICS_DISABLED",
      "Bad Request: forum topics are disabled in this chat",
    ]) {
      const result = classify(400, { description });
      expect(result.safeErrorCode, description).toBe("topics-disabled");
      expect(result.retryable).toBe(false);
    }
  });

  it("chat-not-found stays its own code and never leaks the raw description", () => {
    const result = classify(400, { description: "Bad Request: chat not found" });
    expect(result.safeErrorCode).toBe("chat-not-found");
    expect(result.retryable).toBe(false);
    // The safe code carries no free-form text.
    expect(JSON.stringify(result)).not.toContain("Bad Request");
  });
});

// --- §5/§6 capability snapshot + log-group preflight (DB + Redis) -------------

const OWNER_TG = 999_777_050;
const CHAT = "-1002000710055";

describe.runIf(hasDb && hasRedis)("§5/§6 worker token readiness snapshot + preflight", () => {
  let owner: Admin;
  let harness: WorkerHarness;
  let redis: Redis;

  beforeAll(async () => {
    // The bot itself always resolves a token in these tests; the SNAPSHOT below
    // (not the bot's env) is what drives the preflight verdict.
    setCanonicalWorkerToken();
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG), role: "OWNER", isActive: true },
    });
    await seedOpsTopics();
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    harness = await createWorkerHarness();
    redis = new Redis(process.env.REDIS_URL ?? "");
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
    await redis.del(WORKER_CAPABILITIES_KEY).catch(() => undefined);
    await harness.queue.obliterate({ force: true }).catch(() => undefined);
    await clearSetupLock(harness.redis as { del: (...k: string[]) => Promise<number> });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await harness.close();
    redis.disconnect();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  async function publishCapabilities(overrides: Record<string, unknown>): Promise<void> {
    await redis.set(
      WORKER_CAPABILITIES_KEY,
      JSON.stringify({
        pgDumpVersion: "pg_dump (PostgreSQL) 16.4",
        backupDirWritable: true,
        backupDir: "/var/lib/zedbot/backups",
        checkedAt: new Date().toISOString(),
        ...overrides,
      }),
      "EX",
      45,
    );
  }

  it("readWorkerCapabilities round-trips the safe token fields (key-name only)", async () => {
    await publishCapabilities({
      telegramBotTokenConfigured: true,
      telegramBotTokenSource: "TELEGRAM_BOT_TOKEN",
    });
    const caps = await readWorkerCapabilities();
    expect(caps?.telegramBotTokenConfigured).toBe(true);
    expect(caps?.telegramBotTokenSource).toBe("TELEGRAM_BOT_TOKEN");
    // The snapshot carries the SOURCE key name, never the token itself.
    expect(JSON.stringify(caps)).not.toContain(":worker-test-token");
  });

  it("evaluateWorkerTelegramTokenReadiness mirrors every snapshot state", async () => {
    await publishCapabilities({ telegramBotTokenSource: "TELEGRAM_BOT_TOKEN" });
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({ ok: true });

    await publishCapabilities({ telegramBotTokenSource: "BOT_TOKEN" });
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({ ok: true });

    await publishCapabilities({ telegramBotTokenSource: "MISSING" });
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({
      ok: false,
      safeMessage: WORKER_TOKEN_MISSING_TEXT,
    });

    await publishCapabilities({ telegramBotTokenSource: "CONFLICT" });
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({
      ok: false,
      safeMessage: WORKER_TOKEN_CONFLICT_TEXT,
    });

    // No snapshot / an older worker that does not publish the field → defer.
    await redis.del(WORKER_CAPABILITIES_KEY);
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({ ok: true });
    await publishCapabilities({}); // snapshot present, token field absent
    expect(await evaluateWorkerTelegramTokenReadiness()).toEqual({ ok: true });
  });

  it("confirm REFUSES to queue while the worker token is MISSING (attempt stays VALIDATED)", async () => {
    await publishCapabilities({ telegramBotTokenSource: "MISSING" });
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    if (!created.ok) throw new Error("setup");
    const result = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    expect(result.ok).toBe(false);
    expect(result.safeMessage).toBe(WORKER_TOKEN_MISSING_TEXT);
    // No slot claimed, no job enqueued, group untouched.
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({
      where: { id: created.attempt.id },
    });
    expect(fresh.status).toBe(LogGroupSetupStatus.VALIDATED);
    expect(fresh.activeSlot).toBeNull();
    expect(await activeChatIdSetting()).toBeNull();
    expect((await harness.queue.getWaitingCount()) + (await harness.queue.getActiveCount())).toBe(0);
  });

  it("confirm REFUSES to queue while the worker token CONFLICTs", async () => {
    await publishCapabilities({ telegramBotTokenSource: "CONFLICT" });
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    if (!created.ok) throw new Error("setup");
    const result = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    expect(result.ok).toBe(false);
    expect(result.safeMessage).toBe(WORKER_TOKEN_CONFLICT_TEXT);
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({
      where: { id: created.attempt.id },
    });
    expect(fresh.status).toBe(LogGroupSetupStatus.VALIDATED);
    expect(await activeChatIdSetting()).toBeNull();
  });

  it("confirm PROCEEDS to QUEUED when the worker reports a configured token", async () => {
    await publishCapabilities({ telegramBotTokenSource: "TELEGRAM_BOT_TOKEN" });
    const created = await createLogGroupSetupAttempt({
      chatId: CHAT,
      title: "Ops Log",
      adminId: owner.id,
      previous: null,
    });
    if (!created.ok) throw new Error("setup");
    const result = await confirmLogGroupConnection(makeProbeApi(), created.attempt.id, OWNER_TG);
    expect(result.ok).toBe(true);
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({
      where: { id: created.attempt.id },
    });
    expect(fresh.status).toBe(LogGroupSetupStatus.QUEUED);
    expect(fresh.activeSlot).toBe(1);
  });
});

// --- §8 bot-token-missing terminal + retry recovery (DB + Redis) -------------

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

describe.runIf(hasDb && hasRedis)("§8 bot-token-missing terminal + retry recovery", () => {
  let owner: Admin;
  let harness: WorkerHarness;
  let processor: Processor;

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG + 1), role: "OWNER", isActive: true },
    });
    await seedOpsTopics();
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    const mod = (await import(
      fileURLToPath(new URL("../../worker/dist/log-group-setup.js", import.meta.url))
    )) as { createLogGroupSetupProcessor: (deps: unknown) => Processor };
    harness = await createWorkerHarness();
    processor = mod.createLogGroupSetupProcessor({ redis: harness.redis, setupQueue: harness.queue });
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
    await clearSetupLock(harness.redis as { del: (...k: string[]) => Promise<number> });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    vi.unstubAllGlobals();
    // Restore a valid token for the next test's default state.
    setCanonicalWorkerToken();
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await harness.close();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("no worker token → FAILED bot-token-missing, nothing created, group untouched", async () => {
    clearWorkerToken();
    // A tokenless run must fail BEFORE any Telegram call, so fetch is never used.
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const result = await processor(makeJob(attempt.id));
    expect(result.failed).toBe("bot-token-missing");
    expect(fetchMock.createTopicCalls).toHaveLength(0);

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.FAILED);
    expect(fresh.safeErrorCode).toBe("bot-token-missing");
    expect(fresh.activeSlot).toBeNull(); // slot freed for a retry
    expect(fresh.createdTopicCount).toBe(0);
    expect(await activeChatIdSetting()).toBeNull();
  });

  it("after the token is set, the SAME retried attempt provisions all 11 topics + activates", async () => {
    clearWorkerToken();
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const failed = await processor(makeJob(attempt.id));
    expect(failed.failed).toBe("bot-token-missing");

    // The bot's retry action (بررسی مجدد Worker و تلاش دوباره) rechecks the fresh
    // worker capabilities and, once the token is ready, re-queues the SAME durable
    // row (FAILED → QUEUED, error cleared). We mirror that transition here.
    setCanonicalWorkerToken();
    await prisma.logGroupSetupAttempt.update({
      where: { id: attempt.id },
      data: {
        status: LogGroupSetupStatus.QUEUED,
        activeSlot: 1,
        safeErrorCode: null,
        failedAt: null,
      },
    });

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const result = await processor(makeJob(attempt.id));
    expect(result.ok).toBe(true);

    // createdTopicCount resumed from 0 → all 11 topics created and bound.
    expect(fetchMock.createTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.ACTIVE);
    expect(fresh.createdTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);
    const bindings = fresh.topicBindings as Record<string, number>;
    expect(Object.keys(bindings).sort()).toEqual([...OPS_LOG_TOPIC_KEYS].sort());
    // The group is now the active log destination.
    expect(await activeChatIdSetting()).toBe(CHAT);
  });
});
