import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { LOG_GROUP_SETUP_LOCK_KEY, OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-slot-recovery-tests-secret";

import { cancelSetupAttempt } from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import { resumeStaleLogGroupSetups } from "../src/services/startup-recovery.service.js";
import {
  activeChatIdSetting,
  clearLogGroupSettings,
  clearSetupLock,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  setCanonicalWorkerToken,
  makeJob,
  OK_TOPIC,
  resetOpsTopicBindings,
  seedOpsTopics,
  WORKER_LOG_GROUP_SETUP_DIST,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 74-78: single-active-setup slot recovery + cancel-race safety
// (regression coverage for the adversarial-review findings). The unique
// activeSlot must be FREED on any TERMINAL failure so a future setup can start,
// but HELD across non-final retries so the same durable row resumes. A lock
// that a dead worker still holds must not permanently strand the slot. A cancel
// observed during provisioning must never let the test message reach a group we
// are no longer activating. A worker that died with its job lost is resumed by
// the startup sweep (the reaper the slot invariant depends on).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_074;
const CHAT = "-1002000740741";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;
interface LockRedis {
  set: (key: string, value: string, ...args: Array<string | number>) => Promise<unknown>;
  del: (...keys: string[]) => Promise<number>;
}

describe.runIf(hasDb && hasRedis)("slot recovery + cancel race - scenarios 74-78", () => {
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
    await deleteAttemptsFor([owner.id]);
    await clearSetupLock(harness.redis as LockRedis);
    await clearLogGroupSettings();
    await resetOpsTopicBindings();
    await harness.queue.obliterate({ force: true }).catch(() => undefined);
    vi.unstubAllGlobals();
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

  it("74. lock contention on a NON-final attempt keeps the slot held (resume, no failAttempt)", async () => {
    // A dead worker's lock is still held; this is not the last attempt.
    await (harness.redis as LockRedis).set(LOG_GROUP_SETUP_LOCK_KEY, "dead-worker", "PX", 300_000);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });

    await expect(processor(makeJob(attempt.id, { attemptsMade: 0, attempts: 3 }))).rejects.toThrow(
      /setup-lock-contended/,
    );

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    // Claimed to PROVISIONING; the slot is STILL held so the retry resumes the
    // same durable row - it is never freed mid-retry.
    expect(fresh.status).toBe(LogGroupSetupStatus.PROVISIONING);
    expect(fresh.activeSlot).toBe(1);
  });

  it("75. lock contention on the FINAL attempt FREES the slot (no permanent strand)", async () => {
    // Same held lock, but this is the last BullMQ attempt: the terminal failure
    // must free the unique slot so a future setup is not blocked forever.
    await (harness.redis as LockRedis).set(LOG_GROUP_SETUP_LOCK_KEY, "dead-worker", "PX", 300_000);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });

    await expect(processor(makeJob(attempt.id, { attemptsMade: 2, attempts: 3 }))).rejects.toThrow(
      /setup-lock-contended/,
    );

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.FAILED);
    expect(fresh.activeSlot).toBeNull();

    // The slot is genuinely free: a brand-new attempt can occupy activeSlot=1.
    const next = await createAttempt({ chatId: CHAT, adminId: owner.id, activeSlot: 1 });
    expect(next.activeSlot).toBe(1);
  });

  it("76. a cancel observed during provisioning aborts BEFORE the test send (no send, no activation)", async () => {
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    const sendCalls: string[] = [];
    let createCount = 0;
    // Custom async fetch: on the LAST topic create, AWAIT the cancel so it is
    // committed before provisioning returns - then the re-read guard must skip
    // and the test sendMessage must never fire.
    const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.includes("/createForumTopic")) {
        createCount += 1;
        if (createCount === OPS_LOG_TOPIC_KEYS.length) {
          await cancelSetupAttempt(attempt.id);
        }
        return {
          ok: true,
          status: 200,
          json: async () => OK_TOPIC(7000 + createCount).body,
        } as unknown as Response;
      }
      if (url.includes("/sendMessage")) {
        sendCalls.push(String(body.chat_id));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchStub);

    const result = await processor(makeJob(attempt.id, { attemptsMade: 0, attempts: 3 }));

    expect(result.skipped).toBeDefined();
    expect(sendCalls).toHaveLength(0); // the test message never reached the cancelled group
    expect(await activeChatIdSetting()).toBeNull(); // no activation
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.CANCELLED);
  });

  it("77. the startup sweep RE-ENQUEUES a stale stuck setup (the missing reaper)", async () => {
    // A worker died with the job lost: the row is stuck PROVISIONING + slot=1
    // with no queued job. The sweep resumes it (jobId = attempt id, idempotent).
    const attempt = await createAttempt({
      chatId: CHAT,
      adminId: owner.id,
      status: LogGroupSetupStatus.PROVISIONING,
      activeSlot: 1,
    });

    // A threshold in the future makes the just-written row (updatedAt ~ now)
    // qualify as stale without touching the @updatedAt column.
    const resumed = await resumeStaleLogGroupSetups(new Date(Date.now() + 5 * 60_000));
    expect(resumed).toBeGreaterThanOrEqual(1);

    // Resume never abandons the row - it stays running for the worker to finish.
    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(fresh.status).toBe(LogGroupSetupStatus.PROVISIONING);
    expect(fresh.activeSlot).toBe(1);
  });

  it("78. the startup sweep leaves a FRESH running setup untouched (not-stale guard)", async () => {
    await createAttempt({
      chatId: CHAT,
      adminId: owner.id,
      status: LogGroupSetupStatus.PROVISIONING,
      activeSlot: 1,
    });
    // A threshold in the PAST: a row updated ~now is NOT older than it, so an
    // actively-provisioning setup is never falsely resumed/abandoned.
    const resumed = await resumeStaleLogGroupSetups(new Date(Date.now() - 5 * 60_000));
    expect(resumed).toBe(0);
  });
});
