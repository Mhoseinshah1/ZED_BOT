import { LogDeliveryStatus, LogGroupSetupStatus, prisma, type Admin } from "@zedbot/database";
import {
  getRedisOptions,
  LOG_DELIVERY_JOB_NAME,
  LOG_DELIVERY_QUEUE_NAME,
  LOG_GROUP_SETUP_JOB_NAME,
  LOG_GROUP_SETUP_QUEUE_NAME,
  logGroupSetupJobId,
  OPS_LOG_TOPIC_KEYS,
} from "@zedbot/shared";
import { Queue, Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-reliability-tests-secret";

import { getSetupAttemptByShortId } from "../src/services/log-group-connection.service.js";
import {
  getLogGroupStatus,
  invalidateStaleTopic,
  testLogGroup,
  type LogGroupApi,
} from "../src/services/log-group.service.js";
import {
  ensureLogGroupSetupJob,
  resetOpsQueueForTests,
} from "../src/services/ops-queue.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import { LOG_GROUP_CHAT_ID_KEY } from "../src/services/system-log.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  setCanonicalWorkerToken,
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
// Reliability hardening (§3/§4 BullMQ lifecycle, §7 429 retry_after, §8
// truthful test sends, §9 truthful status counts, §11 topic invalidation, §14
// short-id ambiguity). Requires the real test PostgreSQL + Redis.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_500;
const CHAT = "-1002000715001";
const OTHER_CHAT = "-1002000715999";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

/** A grammY-ish send/topic api that records + optionally throws. */
function recordingApi(onSend?: (thread: number | undefined) => void): LogGroupApi & {
  sends: Array<{ chatId: string; text: string; thread: number | undefined }>;
} {
  const sends: Array<{ chatId: string; text: string; thread: number | undefined }> = [];
  return {
    sends,
    async createForumTopic() {
      return { message_thread_id: 1 };
    },
    async sendMessage(chatId, text, other) {
      const thread = other?.message_thread_id;
      sends.push({ chatId: String(chatId), text, thread });
      onSend?.(thread);
      return {};
    },
  };
}

describe.runIf(hasDb && hasRedis)("log-group reliability hardening", () => {
  let owner: Admin;
  let harness: WorkerHarness;
  let processor: Processor;

  beforeAll(async () => {
    // Canonical worker env (TELEGRAM_BOT_TOKEN only, no legacy BOT_TOKEN) so a
    // CI-global TELEGRAM_BOT_TOKEN never CONFLICTs with a legacy value.
    setCanonicalWorkerToken();
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
    processor = mod.createLogGroupSetupProcessor({
      redis: harness.redis,
      setupQueue: harness.queue,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await deleteAttemptsFor([owner.id]);
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    await harness.queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    await harness.close();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  // --- §3/§4 BullMQ job lifecycle ------------------------------------------------

  describe("§3 ensureLogGroupSetupJob", () => {
    it("adds a fresh executable job when none exists", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      const result = await ensureLogGroupSetupJob(attempt.id);
      expect(result).toEqual({ ok: true, state: "added" });
      const job = await harness.queue.getJob(logGroupSetupJobId(attempt.id));
      expect(job).not.toBeUndefined();
      const state = await job?.getState();
      expect(["waiting", "delayed", "prioritized", "active"]).toContain(state);
      // The producer set removeOnComplete/removeOnFail + attempts explicitly.
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.removeOnComplete).toBe(true);
      expect(job?.opts.removeOnFail).toBe(true);
    });

    it("does NOT duplicate an existing waiting job", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      await ensureLogGroupSetupJob(attempt.id);
      const again = await ensureLogGroupSetupJob(attempt.id);
      expect(again).toEqual({ ok: true, state: "already-queued" });
      const counts = await harness.queue.getJobCounts("waiting", "delayed", "active");
      expect((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0)).toBe(1);
    });

    it("does NOT duplicate an existing delayed job", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      await harness.queue.add(
        LOG_GROUP_SETUP_JOB_NAME,
        { attemptId: attempt.id },
        { jobId: logGroupSetupJobId(attempt.id), delay: 60_000 },
      );
      const result = await ensureLogGroupSetupJob(attempt.id);
      expect(result).toEqual({ ok: true, state: "already-queued" });
      const counts = await harness.queue.getJobCounts("waiting", "delayed");
      expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
    });

    it("removes a retained COMPLETED legacy job and re-enqueues an executable one", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      const jobId = logGroupSetupJobId(attempt.id);
      // Legacy producer: no removeOnComplete, so a completed job LINGERS.
      await harness.queue.add(LOG_GROUP_SETUP_JOB_NAME, { attemptId: attempt.id }, { jobId });
      const worker = await drainOneJobToTerminal(false);
      await waitForState(jobId, "completed");
      await worker.close();

      const result = await ensureLogGroupSetupJob(attempt.id);
      expect(result).toEqual({ ok: true, state: "requeued" });
      // The fresh job is executable (not terminal), never the old completed one.
      const job = await harness.queue.getJob(jobId);
      const state = await job?.getState();
      expect(["waiting", "delayed", "prioritized", "active"]).toContain(state);
    });

    it("removes a retained FAILED legacy job and re-enqueues an executable one", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      const jobId = logGroupSetupJobId(attempt.id);
      await harness.queue.add(
        LOG_GROUP_SETUP_JOB_NAME,
        { attemptId: attempt.id },
        { jobId, attempts: 1 },
      );
      const worker = await drainOneJobToTerminal(true);
      await waitForState(jobId, "failed");
      await worker.close();

      const result = await ensureLogGroupSetupJob(attempt.id);
      expect(result).toEqual({ ok: true, state: "requeued" });
      const job = await harness.queue.getJob(jobId);
      const state = await job?.getState();
      expect(["waiting", "delayed", "prioritized", "active"]).toContain(state);
    });

    it("returns a typed safe failure when the queue is unavailable", async () => {
      const savedUrl = process.env.REDIS_URL;
      const savedHost = process.env.REDIS_HOST;
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      await resetOpsQueueForTests();
      try {
        const result = await ensureLogGroupSetupJob("some-attempt-id");
        expect(result).toEqual({ ok: false, reason: "queue-unavailable" });
      } finally {
        if (savedUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = savedUrl;
        if (savedHost === undefined) delete process.env.REDIS_HOST;
        else process.env.REDIS_HOST = savedHost;
        await resetOpsQueueForTests();
      }
    });
  });

  // --- §7 429 retry_after --------------------------------------------------------

  describe("§7 Telegram 429 retry_after", () => {
    it("a 429 after several created topics resumes from the next missing topic and activates", async () => {
      // Run 1: 429 on the 5th create -> keys 1-4 persisted, RateLimitError
      // thrown WITHOUT consuming an attempt.
      const run1 = makeFetchMock({
        createForumTopic: (n) => (n === 5 ? ERR(429, "Too Many Requests", 1) : OK_TOPIC(5100 + n)),
      });
      vi.stubGlobal("fetch", run1.fn);
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      await expect(
        processor(makeJob(attempt.id, { attemptsMade: 0, attempts: 3 })),
      ).rejects.toThrow(/rateLimit/i);
      const mid = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(mid.status).toBe(LogGroupSetupStatus.PROVISIONING);
      expect(mid.createdTopicCount).toBe(4);

      // Run 2 (same attemptsMade=0, since the 429 consumed none): full success
      // resumes and creates ONLY the remaining keys.
      vi.unstubAllGlobals();
      const run2 = makeFetchMock();
      vi.stubGlobal("fetch", run2.fn);
      const result = await processor(makeJob(attempt.id, { attemptsMade: 0, attempts: 3 }));
      expect(result.ok).toBe(true);
      expect(run2.createTopicCalls).toHaveLength(OPS_LOG_TOPIC_KEYS.length - 4);
      const done = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(done.status).toBe(LogGroupSetupStatus.ACTIVE);
      expect(await activeChatIdSetting()).toBe(CHAT);
    });

    it("a 429 on the direct test send re-queues without consuming an attempt", async () => {
      const run1 = makeFetchMock({
        sendMessage: () => ERR(429, "Too Many Requests", 1),
      });
      vi.stubGlobal("fetch", run1.fn);
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      await expect(
        processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 })),
      ).rejects.toThrow(/rateLimit/i);
      // All topics persisted, attempt still TESTING/PROVISIONING (not FAILED).
      const mid = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(mid.status).not.toBe(LogGroupSetupStatus.FAILED);
      expect(mid.createdTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);

      // Resume: the send succeeds and the group activates.
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", makeFetchMock().fn);
      const result = await processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }));
      expect(result.ok).toBe(true);
      expect(await activeChatIdSetting()).toBe(CHAT);
    });
  });

  // --- §8 truthful test sends ----------------------------------------------------

  describe("§8 truthful testLogGroup", () => {
    it("returns topic-unmapped (no send) when SYSTEM is missing", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      // SYSTEM has no topicId bound -> unmapped.
      const api = recordingApi();
      const result = await testLogGroup(api, "SYSTEM");
      expect(result.ok).toBe(false);
      expect(result.safeCode).toBe("topic-unmapped");
      expect(api.sends).toHaveLength(0); // never sent to General
    });

    it("returns topic-unmapped when SYSTEM is bound to a DIFFERENT (old) group", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      await prisma.logTopic.update({
        where: { key: "SYSTEM" },
        data: { topicId: 555, telegramChatId: BigInt(OTHER_CHAT) },
      });
      const api = recordingApi();
      const result = await testLogGroup(api, "SYSTEM");
      expect(result.ok).toBe(false);
      expect(result.safeCode).toBe("topic-unmapped");
      expect(api.sends).toHaveLength(0);
    });

    it("sends to the EXACT SYSTEM thread when correctly bound", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      await prisma.logTopic.update({
        where: { key: "SYSTEM" },
        data: { topicId: 4242, telegramChatId: BigInt(CHAT) },
      });
      const api = recordingApi();
      const result = await testLogGroup(api, "SYSTEM");
      expect(result.ok).toBe(true);
      expect(api.sends).toHaveLength(1);
      expect(api.sends[0].chatId).toBe(CHAT);
      expect(api.sends[0].thread).toBe(4242); // exact thread, never undefined
    });
  });

  // --- §9 truthful status counts -------------------------------------------------

  describe("§9 getLogGroupStatus.enabledTopicCount", () => {
    it("counts topics from an OLD group as zero ready for the current group", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      // Every topic bound to a DIFFERENT group.
      await prisma.logTopic.updateMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
        data: { topicId: 10, telegramChatId: BigInt(OTHER_CHAT) },
      });
      const status = await getLogGroupStatus();
      expect(status.enabledTopicCount).toBe(0);
      expect(status.boundTopicCount).toBe(0);
      expect(status.invalidatedTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);
    });

    it("counts current-group mappings correctly", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      let n = 100;
      for (const key of OPS_LOG_TOPIC_KEYS) {
        n += 1;
        await prisma.logTopic.update({
          where: { key },
          data: { topicId: n, telegramChatId: BigInt(CHAT), isEnabled: true },
        });
      }
      // Disable one -> bound but not "ready".
      await prisma.logTopic.update({ where: { key: "ORDER" }, data: { isEnabled: false } });
      const status = await getLogGroupStatus();
      expect(status.boundTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);
      expect(status.enabledTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length - 1);
      expect(status.invalidatedTopicCount).toBe(0);
    });

    it("reports zero ready when no group is configured", async () => {
      await clearLogGroupSettings();
      await prisma.logTopic.updateMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
        data: { topicId: 9, telegramChatId: BigInt(CHAT) },
      });
      const status = await getLogGroupStatus();
      expect(status.configured).toBe(false);
      expect(status.enabledTopicCount).toBe(0);
      expect(status.boundTopicCount).toBe(0);
    });

    it("fails safe (zero ready) on a corrupted chat-id setting", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, "not-a-chat-id", "STRING");
      clearSettingsCache();
      await prisma.logTopic.updateMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
        data: { topicId: 9, telegramChatId: BigInt(CHAT) },
      });
      const status = await getLogGroupStatus();
      expect(status.enabledTopicCount).toBe(0);
      expect(status.boundTopicCount).toBe(0);
    });
  });

  // --- §11 topic invalidation ----------------------------------------------------

  describe("§11 topic invalidation", () => {
    it("invalidateStaleTopic CAS clears ONLY the exact stale mapping", async () => {
      const system = await prisma.logTopic.update({
        where: { key: "SYSTEM" },
        data: { topicId: 700, telegramChatId: BigInt(CHAT) },
      });
      const error = await prisma.logTopic.update({
        where: { key: "ERROR" },
        data: { topicId: 701, telegramChatId: BigInt(CHAT) },
      });
      // Wrong expected topicId -> no-op.
      expect(
        await invalidateStaleTopic({ id: system.id, expectedTopicId: 999, expectedChatId: BigInt(CHAT) }),
      ).toBe(false);
      // Exact match -> invalidated.
      expect(
        await invalidateStaleTopic({ id: system.id, expectedTopicId: 700, expectedChatId: BigInt(CHAT) }),
      ).toBe(true);
      const freshSystem = await prisma.logTopic.findUniqueOrThrow({ where: { key: "SYSTEM" } });
      expect(freshSystem.topicId).toBeNull();
      expect(freshSystem.key).toBe("SYSTEM"); // key/title/isEnabled preserved
      // The other healthy topic is untouched.
      const freshError = await prisma.logTopic.findUniqueOrThrow({ where: { id: error.id } });
      expect(freshError.topicId).toBe(701);
    });

    it("a delivery to a deleted topic returns topic-missing and invalidates that mapping", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
      clearSettingsCache();
      const system = await prisma.logTopic.update({
        where: { key: "SYSTEM" },
        data: { topicId: 820, telegramChatId: BigInt(CHAT), isEnabled: true },
      });
      const healthy = await prisma.logTopic.update({
        where: { key: "ERROR" },
        data: { topicId: 821, telegramChatId: BigInt(CHAT), isEnabled: true },
      });

      const { deliveryId } = await seedDelivery("SYSTEM");
      const deliveryHarness = await buildDeliveryHarness();
      try {
        const fetchMock = makeFetchMock({
          sendMessage: () => ERR(400, "Bad Request: message thread not found"),
        });
        vi.stubGlobal("fetch", fetchMock.fn);
        // A non-final attempt so a permanent topic-missing dead-letters (and
        // returns) immediately rather than re-throwing for a BullMQ retry.
        const result = await deliveryHarness.processor(
          deliveryJob(deliveryId, { attemptsMade: 0, attempts: 5 }),
        );
        expect(result.deadLetter).toBe("topic-missing");

        // The exact SYSTEM mapping is invalidated; the healthy ERROR topic is not.
        const freshSystem = await prisma.logTopic.findUniqueOrThrow({ where: { id: system.id } });
        expect(freshSystem.topicId).toBeNull();
        const freshHealthy = await prisma.logTopic.findUniqueOrThrow({ where: { id: healthy.id } });
        expect(freshHealthy.topicId).toBe(821);
        // The failed delivery is DEAD_LETTER (never blindly resent).
        const delivery = await prisma.systemLogDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
        expect(delivery.status).toBe(LogDeliveryStatus.DEAD_LETTER);
      } finally {
        await deliveryHarness.close();
      }
    });
  });

  // --- §14 short-id ambiguity ----------------------------------------------------

  describe("§14 getSetupAttemptByShortId", () => {
    it("returns not-found for zero matches", async () => {
      const lookup = await getSetupAttemptByShortId("deadbeef");
      expect(lookup.status).toBe("not-found");
    });

    it("returns the single match", async () => {
      const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
      const lookup = await getSetupAttemptByShortId(attempt.id.slice(0, 8));
      expect(lookup.status).toBe("found");
      if (lookup.status === "found") {
        expect(lookup.attempt.id).toBe(attempt.id);
      }
    });

    it("returns ambiguous (never silently chooses) when two rows share a prefix", async () => {
      // Force two attempts whose ids share a 4-char prefix.
      const prefix = "abcd";
      const a = await forceAttemptId(`${prefix}1111-1111-1111-1111-111111111111`);
      const b = await forceAttemptId(`${prefix}2222-2222-2222-2222-222222222222`);
      try {
        const lookup = await getSetupAttemptByShortId(prefix);
        expect(lookup.status).toBe("ambiguous");
      } finally {
        await prisma.logGroupSetupAttempt.deleteMany({ where: { id: { in: [a, b] } } });
      }
    });
  });

  // --- §15 lock extension (compare-and-expire by token) --------------------------

  describe("§15 extendLock", () => {
    it("extends only a lock we still own, never another worker's", async () => {
      const redisMod = (await import("../../worker/dist/redis.js")) as unknown as {
        acquireLock: (r: unknown, key: string, ttl: number) => Promise<{ key: string; token: string } | null>;
        extendLock: (r: unknown, lock: { key: string; token: string }, ttl: number) => Promise<boolean>;
        releaseLock: (r: unknown, lock: { key: string; token: string }) => Promise<void>;
      };
      const key = `zedbot:test:lock:${OWNER_TG}`;
      const lock = await redisMod.acquireLock(harness.redis, key, 5_000);
      expect(lock).not.toBeNull();
      if (lock === null) return;
      // We own it -> extend succeeds.
      expect(await redisMod.extendLock(harness.redis, lock, 5_000)).toBe(true);
      // A different token (another worker) -> refuse to extend.
      expect(
        await redisMod.extendLock(harness.redis, { key, token: "someone-else" }, 5_000),
      ).toBe(false);
      await redisMod.releaseLock(harness.redis, lock);
      // After release, extending our old token no longer works.
      expect(await redisMod.extendLock(harness.redis, lock, 5_000)).toBe(false);
    });
  });

  // --- helpers -----------------------------------------------------------------

  /** A throwaway worker that takes ONE job to a terminal state then stops. */
  async function drainOneJobToTerminal(shouldFail: boolean): Promise<Worker> {
    const options = getRedisOptions();
    if (options === null) throw new Error("redis required");
    const worker = new Worker(
      LOG_GROUP_SETUP_QUEUE_NAME,
      async () => {
        if (shouldFail) throw new Error("legacy job failed");
        return {};
      },
      { connection: { ...options, maxRetriesPerRequest: null }, concurrency: 1 },
    );
    worker.on("error", () => undefined);
    return worker;
  }

  async function waitForState(jobId: string, target: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const job = await harness.queue.getJob(jobId);
      if (job !== undefined && (await job.getState()) === target) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`job ${jobId} never reached ${target}`);
  }

  async function forceAttemptId(id: string): Promise<string> {
    const created = await createAttempt({ chatId: CHAT, adminId: owner.id, activeSlot: null });
    await prisma.$executeRaw`UPDATE "LogGroupSetupAttempt" SET "id" = ${id} WHERE "id" = ${created.id}`;
    return id;
  }

  async function seedDelivery(topicKey: string): Promise<{ deliveryId: string }> {
    await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT, "STRING");
    const topic = await prisma.logTopic.findUniqueOrThrow({ where: { key: topicKey } });
    const log = await prisma.systemLog.create({
      data: { level: "INFO", eventType: `reliability.deliver.${Date.now()}`, message: "test" },
    });
    const delivery = await prisma.systemLogDelivery.create({
      data: { systemLogId: log.id, logTopicId: topic.id, status: LogDeliveryStatus.FAILED, attempts: 4 },
    });
    return { deliveryId: delivery.id };
  }

  async function buildDeliveryHarness(): Promise<{ processor: Processor; close: () => Promise<void> }> {
    const options = getRedisOptions();
    if (options === null) throw new Error("redis required");
    const queue = new Queue(LOG_DELIVERY_QUEUE_NAME, {
      connection: { ...options, maxRetriesPerRequest: null },
    });
    queue.on("error", () => undefined);
    const redis = await queue.client;
    const mod = (await import("../../worker/dist/log-delivery.js")) as {
      createLogDeliveryProcessor: (deps: unknown) => Processor;
    };
    const processor = mod.createLogDeliveryProcessor({ redis, logQueue: queue });
    return {
      processor,
      close: async () => {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      },
    };
  }

  function deliveryJob(
    deliveryId: string,
    opts: { attemptsMade: number; attempts: number },
  ): unknown {
    return {
      name: LOG_DELIVERY_JOB_NAME,
      data: { deliveryId },
      attemptsMade: opts.attemptsMade,
      opts: { attempts: opts.attempts },
    };
  }
});

describe.skipIf(hasDb && hasRedis)("log-group reliability (skipped)", () => {
  it("requires DATABASE_URL + Redis", () => {
    expect(hasDb && hasRedis).toBe(false);
  });
});
