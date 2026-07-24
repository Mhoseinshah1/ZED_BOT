import { LogGroupSetupStatus, prisma, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-cache-repair-tests-secret";

import {
  createLogGroupSetupAttempt,
  getActiveSetupAttempt,
  queueLogGroupRepair,
} from "../src/services/log-group-connection.service.js";
import {
  SETUP_SAFE_ERROR_MESSAGES,
  SETUP_UNKNOWN_ERROR_MESSAGE,
  mapSetupSafeError,
} from "../src/handlers/admin-settings/log-group-error-map.js";
import {
  getLogGroupSettings,
  loadLogGroupRoutingSnapshot,
  readLogGroupBindingFresh,
} from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import { getSetting, setSetting, clearSettingsCache } from "../src/services/settings.service.js";
import { LOG_GROUP_CHAT_ID_KEY } from "../src/services/system-log.service.js";
import { LOG_GROUP_TITLE_KEY } from "../src/services/log-group.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  createWorkerHarness,
  deleteAttemptsFor,
  setCanonicalWorkerToken,
  makeFetchMock,
  makeJob,
  makeProbeApi,
  resetOpsTopicBindings,
  seedOpsTopics,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Post-activation cache + durable-repair hotfix regressions:
//   §2/§7 database-authoritative fresh reads (immediate post-activation state);
//   P1 §4/§5 durable repair that can never target/restore the previous group;
//   §8 exhaustive safe-error mapping.
// Real PostgreSQL + Redis + the worker processor from apps/worker/dist.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_610;
const GROUP_A = "-1002000716001";
const GROUP_B = "-1002000716002";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

/** Directly bind every ops topic to `chatId` (simulates a completed activation). */
async function bindAllTopicsTo(chatId: string, base = 5000): Promise<void> {
  let n = base;
  for (const key of OPS_LOG_TOPIC_KEYS) {
    n += 1;
    await prisma.logTopic.update({
      where: { key },
      data: { topicId: n, telegramChatId: BigInt(chatId), isEnabled: true },
    });
  }
}

/** Write the chat-id Setting directly (bypasses this process's cache - mimics
 * the worker activating in a separate process). */
async function activateGroupInWorkerProcess(chatId: string, title: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: LOG_GROUP_CHAT_ID_KEY },
    update: { value: chatId, type: "STRING" },
    create: { key: LOG_GROUP_CHAT_ID_KEY, value: chatId, type: "STRING" },
  });
  await prisma.setting.upsert({
    where: { key: LOG_GROUP_TITLE_KEY },
    update: { value: title, type: "STRING" },
    create: { key: LOG_GROUP_TITLE_KEY, value: title, type: "STRING" },
  });
  await bindAllTopicsTo(chatId);
}

describe.runIf(hasDb && hasRedis)("log-group post-activation cache + durable repair", () => {
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
    processor = mod.createLogGroupSetupProcessor({ redis: harness.redis, setupQueue: harness.queue });
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

  // --- §2/§7 fresh read: immediate post-activation state ------------------------

  describe("database-authoritative fresh binding", () => {
    it("reflects a worker-process activation immediately (no 30s cache wait)", async () => {
      // Warm THIS process's generic cache with "not configured".
      clearSettingsCache();
      expect(await getSetting(LOG_GROUP_CHAT_ID_KEY, "")).toBe("");
      // Worker (other process) activates group B - bypasses this process's cache.
      await activateGroupInWorkerProcess(GROUP_B, "Group B");
      // The generic cached read is still stale...
      expect(await getSetting(LOG_GROUP_CHAT_ID_KEY, "")).toBe("");
      // ...but the authoritative fresh binding + delegating getLogGroupSettings
      // show the new group IMMEDIATELY.
      const fresh = await readLogGroupBindingFresh();
      expect(fresh.configured).toBe(true);
      expect(fresh.chatId).toBe(GROUP_B);
      expect((await getLogGroupSettings()).chatId).toBe(GROUP_B);
    });

    it("returns an explicit invalid-binding state for a corrupted chat id (never routes)", async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, "not-a-chat-id", "STRING");
      const fresh = await readLogGroupBindingFresh();
      expect(fresh.configured).toBe(false);
      expect(fresh.invalid).toBe(true);
      expect(fresh.chatId).toBeNull();
      expect((await getLogGroupSettings()).chatId).toBeNull();
    });
  });

  // --- §8 exhaustive safe-error mapping ----------------------------------------

  describe("safe error mapping", () => {
    it("maps every known safe code to an actionable Persian category", () => {
      for (const [code, message] of Object.entries(SETUP_SAFE_ERROR_MESSAGES)) {
        expect(mapSetupSafeError(code)).toBe(message);
        // A known Telegram/config error is NEVER a database error.
        expect(mapSetupSafeError(code)).not.toContain("پایگاه داده");
      }
    });

    it("topics-disabled / manage-topics-required / bot-not-member are actionable, not DB errors", () => {
      expect(mapSetupSafeError("topics-disabled")).toBe("قابلیت موضوعات گروه غیرفعال است.");
      expect(mapSetupSafeError("manage-topics-required")).toBe(
        "دسترسی مدیریت موضوعات برای ربات فعال نیست.",
      );
      expect(mapSetupSafeError("bot-not-member")).toBe("ربات داخل گروه عضو نیست.");
      expect(mapSetupSafeError("bot-not-admin")).toBe("ربات مدیر گروه نیست.");
      expect(mapSetupSafeError("telegram-timeout")).toBe("پاسخی از تلگرام دریافت نشد؛ دوباره تلاش کنید.");
      expect(mapSetupSafeError("telegram-server-error")).toBe("تلگرام موقتاً در دسترس نیست.");
      expect(mapSetupSafeError("topic-closed")).toBe("تاپیک موردنظر بسته شده است.");
    });

    it("an unknown/null code stays safely generic", () => {
      expect(mapSetupSafeError("totally-unknown")).toBe(SETUP_UNKNOWN_ERROR_MESSAGE);
      expect(mapSetupSafeError(null)).toBe(SETUP_UNKNOWN_ERROR_MESSAGE);
    });
  });

  // --- P1: stale-cache repair cannot target/restore the previous group ---------

  describe("P1 stale-cache repair regression", () => {
    it("repair after a B activation (cache stale at A) targets B, never A", async () => {
      // Warm this process's cache with OLD group A (setSetting writes DB+cache).
      await setSetting(LOG_GROUP_CHAT_ID_KEY, GROUP_A, "STRING");
      await setSetting(LOG_GROUP_TITLE_KEY, "Group A", "STRING");
      await bindAllTopicsTo(GROUP_A, 4000);
      // Worker (other process) atomically activates B - cache still says A.
      await activateGroupInWorkerProcess(GROUP_B, "Group B");
      // Make ONE topic missing in B so the repair has real work to do.
      await prisma.logTopic.update({ where: { key: "SYSTEM" }, data: { topicId: null } });

      // The repair queues NO Telegram writes itself; probe only.
      const fetchMock = makeFetchMock();
      vi.stubGlobal("fetch", fetchMock.fn);
      const api = makeProbeApi({ chat: { type: "supergroup", is_forum: true, title: "Group B" } });
      const result = await queueLogGroupRepair(api, {
        adminId: owner.id,
        ownerTelegramId: OWNER_TG,
      });
      expect(result.ok).toBe(true);
      expect(result.attempt).toBeDefined();
      // §4/§5: the repair targets the FRESH group B (never the cached A).
      expect(result.attempt?.chatId.toString()).toBe(GROUP_B);
      // No Telegram write happened in the bot callback (only the worker creates).
      expect(fetchMock.createTopicCalls).toHaveLength(0);
      expect(fetchMock.sendCalls).toHaveLength(0);

      // Run the worker: it creates ONLY the missing SYSTEM topic - in B.
      const attemptId = result.attempt?.id ?? "";
      const runMock = makeFetchMock();
      vi.stubGlobal("fetch", runMock.fn);
      const runResult = await processor(makeJob(attemptId, { attemptsMade: 0, attempts: 3 }));
      expect(runResult.ok).toBe(true);
      // Exactly one create, in group B; the SYSTEM test send also went to B.
      expect(runMock.createTopicCalls).toHaveLength(1);
      expect(runMock.createTopicCalls.every((c) => c.chatId === GROUP_B)).toBe(true);
      expect(runMock.sendCalls.every((c) => c.chatId === GROUP_B)).toBe(true);
      // NOTHING was ever sent to the old group A.
      expect(runMock.createTopicCalls.some((c) => c.chatId === GROUP_A)).toBe(false);
      expect(runMock.sendCalls.some((c) => c.chatId === GROUP_A)).toBe(false);

      // Every LogTopic + the global Setting remain B.
      expect(await activeChatIdSetting()).toBe(GROUP_B);
      const topics = await prisma.logTopic.findMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
      });
      for (const t of topics) {
        expect(t.telegramChatId?.toString(), t.key).toBe(GROUP_B);
      }
    });
  });

  // --- durable repair mechanics ------------------------------------------------

  describe("durable repair", () => {
    it("seeds healthy current-group mappings and recreates only what is broken", async () => {
      await activateGroupInWorkerProcess(GROUP_B, "Group B");
      // ORDER is missing; PANEL is mismatched (bound to A).
      await prisma.logTopic.update({ where: { key: "ORDER" }, data: { topicId: null } });
      await prisma.logTopic.update({
        where: { key: "PANEL" },
        data: { topicId: 123, telegramChatId: BigInt(GROUP_A) },
      });

      const api = makeProbeApi({ chat: { type: "supergroup", is_forum: true, title: "Group B" } });
      const result = await queueLogGroupRepair(api, { adminId: owner.id, ownerTelegramId: OWNER_TG });
      expect(result.ok).toBe(true);
      const attempt = result.attempt;
      expect(attempt).toBeDefined();
      // Seed = the healthy current-group topics (all except the 2 broken keys).
      expect(attempt?.createdTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length - 2);

      const runMock = makeFetchMock();
      vi.stubGlobal("fetch", runMock.fn);
      const runResult = await processor(makeJob(attempt?.id ?? "", { attemptsMade: 0, attempts: 3 }));
      expect(runResult.ok).toBe(true);
      // Exactly two creations (the missing + the mismatched key), both in B.
      expect(runMock.createTopicCalls).toHaveLength(2);
      expect(runMock.createTopicCalls.every((c) => c.chatId === GROUP_B)).toBe(true);
      const snapshot = await loadLogGroupRoutingSnapshot();
      expect(snapshot.chatId).toBe(GROUP_B);
      expect(snapshot.boundTopicCount).toBe(OPS_LOG_TOPIC_KEYS.length);
      expect(snapshot.missing).toHaveLength(0);
      expect(snapshot.mismatched).toHaveLength(0);
    });

    it("a failed repair preserves the entire currently active binding", async () => {
      await activateGroupInWorkerProcess(GROUP_B, "Group B");
      await prisma.logTopic.update({ where: { key: "SYSTEM" }, data: { topicId: null } });
      const beforeTopics = await prisma.logTopic.findMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
      });

      const api = makeProbeApi({ chat: { type: "supergroup", is_forum: true, title: "Group B" } });
      const result = await queueLogGroupRepair(api, { adminId: owner.id, ownerTelegramId: OWNER_TG });
      expect(result.ok).toBe(true);

      // The single missing-topic creation permanently fails on the final attempt.
      const runMock = makeFetchMock({
        createForumTopic: () => ({ status: 403, body: { ok: false, description: "Forbidden: bot is not a member" } }),
      });
      vi.stubGlobal("fetch", runMock.fn);
      const runResult = await processor(makeJob(result.attempt?.id ?? "", { attemptsMade: 2, attempts: 3 }));
      expect(runResult.failed).toBe("topic-provision");
      // The active group + every healthy binding are unchanged.
      expect(await activeChatIdSetting()).toBe(GROUP_B);
      const afterTopics = await prisma.logTopic.findMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
      });
      for (const before of beforeTopics) {
        const after = afterTopics.find((t) => t.key === before.key);
        expect(after?.telegramChatId?.toString() ?? null, before.key).toBe(
          before.telegramChatId?.toString() ?? null,
        );
      }
    });
  });

  // --- security ----------------------------------------------------------------

  describe("security", () => {
    it("a concurrent connection + repair converge on ONE active slot", async () => {
      await activateGroupInWorkerProcess(GROUP_B, "Group B");
      // A connection setup already occupies the slot.
      const first = await createLogGroupSetupAttempt({
        chatId: GROUP_A,
        title: "Group A",
        adminId: owner.id,
        previous: null,
      });
      expect(first.ok).toBe(true);
      if (first.ok) {
        await prisma.logGroupSetupAttempt.update({
          where: { id: first.attempt.id },
          data: { status: LogGroupSetupStatus.QUEUED, activeSlot: 1 },
        });
      }
      // A repair attempt cannot also claim the slot.
      const api = makeProbeApi({ chat: { type: "supergroup", is_forum: true, title: "Group B" } });
      const repair = await queueLogGroupRepair(api, { adminId: owner.id, ownerTelegramId: OWNER_TG });
      expect(repair.ok).toBe(false);
      const active = await getActiveSetupAttempt();
      expect(active?.id).toBe(first.ok ? first.attempt.id : "");
    });
  });
});

describe.skipIf(hasDb && hasRedis)("log-group cache + repair (skipped)", () => {
  it("requires DATABASE_URL + Redis", () => {
    expect(hasDb && hasRedis).toBe(false);
  });
});
