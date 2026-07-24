import { prisma, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "log-group-security-tests-secret-0";

import { initialSession } from "../src/core/session.js";
import {
  LOG_GROUP_ID_FLOW,
  logGroupIdHandler,
  logGroupIdTextHandler,
} from "../src/handlers/admin-settings/log-group-id.handler.js";
import { attemptShortId } from "../src/services/log-group-connection.service.js";
import { maskChatId } from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  callbackCtx,
  clearLogGroupSettings,
  clearSetupLock,
  createAttempt,
  createWorkerHarness,
  deleteAttemptsFor,
  setCanonicalWorkerToken,
  flatButtons,
  makeFetchMock,
  makeJob,
  resetOpsTopicBindings,
  seedOpsTopics,
  textCtx,
  WORKER_LOG_GROUP_SETUP_DIST,
  type InlineButton,
  type SentMessage,
  type WorkerHarness,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Security invariants across the direct numeric-ID flow: the full chat id
// NEVER travels in callback data (only the 8-hex attempt short id does), audit
// rows carry ONLY the masked chat id (no full id, no secrets), and staged
// topicBindings contain numeric thread ids only.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_080;
const CHAT = "-1002000750011";
const CHAT_TAIL = "2000750011";

type Processor = (job: unknown) => Promise<Record<string, unknown>>;

function allCallbacks(sent: SentMessage[]): string[] {
  const out: string[] = [];
  for (const msg of sent) {
    for (const b of flatButtons(msg) as InlineButton[]) {
      if (typeof b.callback_data === "string") out.push(b.callback_data);
    }
  }
  return out;
}

describe.runIf(hasDb && hasRedis)("log-group security invariants", () => {
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

  it("the full chat id never appears in callback data (preview + progress pages)", async () => {
    // Preview page.
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const preview = textCtx(CHAT, { admin: owner, session });
    await logGroupIdTextHandler.middleware()(preview.ctx as never, async () => {});
    const attempt = await prisma.logGroupSetupAttempt.findFirstOrThrow({
      where: { requestedByAdminId: owner.id },
    });
    const sid = attemptShortId(attempt.id);

    // Progress page (after confirm -> QUEUED).
    const confirm = callbackCtx(`admin:lg:id_confirm:${sid}`, { admin: owner });
    await logGroupIdHandler.middleware()(confirm.ctx as never, async () => {});

    const callbacks = [...allCallbacks(preview.sent), ...allCallbacks(confirm.sent)];
    expect(callbacks.length).toBeGreaterThan(0);
    for (const cb of callbacks) {
      expect(cb.includes(CHAT), cb).toBe(false);
      expect(cb.includes(CHAT_TAIL), cb).toBe(false);
    }
    // Every attempt-scoped callback carries ONLY the 8-hex short id.
    const scoped = callbacks.filter((c) => /^admin:lg:(id_confirm|id_pubok|op|id_retry|id_cancel_op):/.test(c));
    expect(scoped.length).toBeGreaterThan(0);
    for (const cb of scoped) {
      expect(cb).toMatch(/^admin:lg:[a-z_]+:[0-9a-f]{4,12}$/);
    }
  });

  it("audit rows carry ONLY the masked chat id - no full id, no secrets", async () => {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx } = textCtx(CHAT, { admin: owner, session });
    await logGroupIdTextHandler.middleware()(ctx as never, async () => {});

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LogGroupSetupAttempt", actorTelegramId: owner.telegramId },
    });
    expect(audits.length).toBeGreaterThan(0);
    const withChat = audits.filter((a) => (a.metadata as Record<string, unknown>)?.maskedChatId);
    expect(withChat.length).toBeGreaterThan(0);
    for (const audit of audits) {
      const meta = audit.metadata as Record<string, unknown>;
      const serialized = JSON.stringify(meta);
      // The masked form only - never the full id or its raw tail.
      expect(serialized.includes(CHAT), audit.action).toBe(false);
      expect(serialized.includes(CHAT_TAIL), audit.action).toBe(false);
      if (typeof meta.maskedChatId === "string") {
        expect(meta.maskedChatId).toBe(maskChatId(CHAT));
      }
    }
  });

  it("staged topicBindings contain only numeric thread ids", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock.fn);
    const attempt = await createAttempt({ chatId: CHAT, adminId: owner.id });
    await processor(makeJob(attempt.id));

    const fresh = await prisma.logGroupSetupAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const bindings = fresh.topicBindings as Record<string, unknown>;
    expect(Object.keys(bindings)).toHaveLength(OPS_LOG_TOPIC_KEYS.length);
    for (const [key, value] of Object.entries(bindings)) {
      expect(typeof value, key).toBe("number");
      expect(Number.isInteger(value as number), key).toBe(true);
    }
  });
});
