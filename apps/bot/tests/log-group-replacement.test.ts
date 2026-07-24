import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-replacement-tests-secre";

import {
  activateLogGroup,
  confirmLogGroupConnection,
  createLogGroupSetupAttempt,
  SETUP_ALREADY_RUNNING_TEXT,
} from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  clearSetupLock,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  setCanonicalWorkerToken,
  ERR,
  makeFetchMock,
  makeJob,
  makeProbeApi,
  resetOpsTopicBindings,
  seedOpsTopics,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 52-57: replacement never disturbs the live group until the staged
// group is fully provisioned + test-sent. While group B is provisioning the
// active Settings STILL point at group A; a FAILED replacement leaves A active
// with its LogTopics intact; a SUCCESSFUL one switches once. Two concurrent
// confirmations serialize on the DB-authoritative activeSlot (one wins, the
// other is told a setup is already running) so exactly one activates.
// Existing SystemLog history is never touched.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_060;
const GROUP_A = "-1002000730001";
const GROUP_B = "-1002000730002";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

/** A full 11-key bindings map (deterministic thread ids from a base). */
function bindingsFor(base: number): Record<string, number> {
  const out: Record<string, number> = {};
  OPS_LOG_TOPIC_KEYS.forEach((key, i) => {
    out[key] = base + i;
  });
  return out;
}

describe.runIf(hasDb && hasRedis)("log-group replacement - scenarios 52-57", () => {
  let owner: Admin;
  let harness: WorkerHarness;
  let processor: Processor;
  const suiteStartedAt = new Date();

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

  /** Fully activates group A (Settings + all LogTopic bindings). */
  async function activateGroupA(): Promise<void> {
    await activateLogGroup({ chatId: GROUP_A, title: "Group A", bindings: bindingsFor(3000) });
  }

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
            eventType: { in: ["log_group.connected", "log_group.topic_created", "replace.probe"] },
            createdAt: { gte: suiteStartedAt },
          },
        },
      },
    });
    await prisma.systemLog.deleteMany({
      where: {
        eventType: { in: ["log_group.connected", "log_group.topic_created", "replace.probe"] },
        createdAt: { gte: suiteStartedAt },
      },
    });
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    await harness.close();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("52+54+56. group A stays active THROUGH B's provisioning, then switches once", async () => {
    await activateGroupA();

    let settingDuringProvision: string | null | "unset" = "unset";
    let seq = 8000;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/createForumTopic")) {
        // On the FIRST staged create, the live group must still be A.
        if (settingDuringProvision === "unset") {
          settingDuringProvision = await activeChatIdSetting();
        }
        seq += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_thread_id: seq } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    });

    const attempt = await createAttempt({
      chatId: GROUP_B,
      adminId: owner.id,
      previousChatId: GROUP_A,
    });
    const result = await processor(makeJob(attempt.id));
    expect(result.ok).toBe(true);

    // The active group was untouched while B was still provisioning...
    expect(settingDuringProvision).toBe(GROUP_A);
    // ...and switched exactly once, to B, on success.
    expect(await activeChatIdSetting()).toBe(GROUP_B);
    const rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(GROUP_B);
    }
  });

  it("53. a FAILED replacement leaves group A active with its LogTopics intact", async () => {
    await activateGroupA();
    const fetchMock = makeFetchMock({
      createForumTopic: () => ERR(403, "Forbidden: not enough rights"),
    });
    vi.stubGlobal("fetch", fetchMock.fn);

    const attempt = await createAttempt({
      chatId: GROUP_B,
      adminId: owner.id,
      previousChatId: GROUP_A,
    });
    const result = await processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }));
    expect(result.failed).toBe("topic-provision");

    // A is still the active group, still bound on every topic.
    expect(await activeChatIdSetting()).toBe(GROUP_A);
    const rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
    for (const row of rows) {
      expect(row.telegramChatId?.toString(), row.key).toBe(GROUP_A);
    }
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.FAILED);
  });

  it("55. two concurrent confirmations serialize - only one claims the slot + activates", async () => {
    const a1 = await createLogGroupSetupAttempt({
      chatId: "-1002000730011",
      title: "B1",
      adminId: owner.id,
      previous: null,
    });
    const a2 = await createLogGroupSetupAttempt({
      chatId: "-1002000730012",
      title: "B2",
      adminId: owner.id,
      previous: null,
    });
    if (!a1.ok || !a2.ok) throw new Error("setup");

    const first = await confirmLogGroupConnection(makeProbeApi(), a1.attempt.id, OWNER_TG);
    const second = await confirmLogGroupConnection(makeProbeApi(), a2.attempt.id, OWNER_TG);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.safeMessage).toBe(SETUP_ALREADY_RUNNING_TEXT);

    // Exactly one attempt occupies the single active slot.
    const slots = await prisma.logGroupSetupAttempt.count({
      where: { requestedByAdminId: owner.id, activeSlot: 1 },
    });
    expect(slots).toBe(1);

    // Running BOTH processors activates exactly one (the loser is unclaimable).
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    await processor(makeJob(a1.attempt.id));
    await processor(makeJob(a2.attempt.id));

    const active = await prisma.logGroupSetupAttempt.count({
      where: { requestedByAdminId: owner.id, status: LogGroupSetupStatus.ACTIVE },
    });
    expect(active).toBe(1);
    expect(await activeChatIdSetting()).toBe("-1002000730011");
  });

  it("57. existing SystemLog history survives a replacement", async () => {
    await activateGroupA();
    const marker = await prisma.systemLog.create({
      data: { level: "INFO", eventType: "replace.probe", message: "pre-existing history row" },
    });

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({
      chatId: GROUP_B,
      adminId: owner.id,
      previousChatId: GROUP_A,
    });
    await processor(makeJob(attempt.id));

    expect(await activeChatIdSetting()).toBe(GROUP_B);
    // The pre-existing history row is untouched.
    const still = await prisma.systemLog.findUnique({ where: { id: marker.id } });
    expect(still).not.toBeNull();
    expect(still?.message).toBe("pre-existing history row");
  });
});
