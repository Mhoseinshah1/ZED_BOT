import {
  LogGroupSetupStatus,
  Prisma,
  SystemLogLevel,
  prisma,
  type LogGroupSetupAttempt,
} from "@zedbot/database";
import {
  LOG_GROUP_CHAT_ID_SETTING_KEY,
  LOG_GROUP_SETUP_JOB_NAME,
  LOG_GROUP_SETUP_LOCK_KEY,
  LOG_GROUP_TITLE_SETTING_KEY,
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
  createLogger,
  errorMessage,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import type { Job, Queue } from "bullmq";

import { botToken } from "./config.js";
import { writeOpsLog } from "./ops-log.js";
import { acquireLock, releaseLock, type HeldLock, type RawRedis } from "./redis.js";
import { createTelegramForumTopic, sendTelegramMessage } from "./telegram.js";

// =============================================================================
// Worker consumer for the telegram-log-group-setup queue (PROVISION_LOG_GROUP).
// The bot enqueues one job per LogGroupSetupAttempt after the OWNER confirms a
// validated numeric-ID target; here we CREATE the default forum topics, SEND
// the direct SYSTEM test and ACTIVATE the group atomically - never inline in a
// Telegram callback.
//
// Resume-safe: the attempt row's topicBindings is written after EACH created
// topic, so a retried/crashed job re-reads it and never recreates a topic.
// The active group is switched ONLY inside the activation transaction, which
// is conditional on the attempt still being in a running state - a cancel or
// concurrent activation can never produce a partial switch, and a failed
// setup leaves the previously active group untouched.
// =============================================================================

const logger = createLogger("worker:log-group-setup");

/** Lock TTL comfortably above provisioning 11 topics + one test send. */
const SETUP_LOCK_TTL_MS = 5 * 60_000;

const RUNNING_STATUSES: LogGroupSetupStatus[] = [
  LogGroupSetupStatus.QUEUED,
  LogGroupSetupStatus.PROVISIONING,
  LogGroupSetupStatus.TESTING,
];

export interface LogGroupSetupDeps {
  redis: RawRedis;
  setupQueue: Queue;
}

type TopicBindings = Record<string, number>;

function parseBindings(value: Prisma.JsonValue | null): TopicBindings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: TopicBindings = {};
  for (const [key, v] of Object.entries(value)) {
    if ((OPS_LOG_TOPIC_KEYS as readonly string[]).includes(key) && typeof v === "number") {
      out[key] = v;
    }
  }
  return out;
}

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Marks the attempt FAILED, frees the active slot; never throws. */
async function failAttempt(attemptId: string, safeErrorCode: string): Promise<void> {
  try {
    await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: { in: RUNNING_STATUSES } },
      data: {
        status: LogGroupSetupStatus.FAILED,
        activeSlot: null,
        safeErrorCode,
        failedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn("failAttempt update failed", { attemptId, error: errorMessage(err) });
  }
}

/**
 * Creates every missing default forum topic for the staged chat, persisting
 * each binding to the attempt IMMEDIATELY so a restart resumes. Returns the
 * merged bindings or a safe failure. A retryable Telegram failure throws so
 * BullMQ backs off and the next attempt resumes from the saved bindings.
 */
async function provisionStagedTopics(
  attempt: LogGroupSetupAttempt,
  token: string,
): Promise<{ ok: true; bindings: TopicBindings } | { ok: false; safeErrorCode: string; retryable: boolean }> {
  const chatId = attempt.chatId.toString();
  const bindings = parseBindings(attempt.topicBindings);
  for (const key of OPS_LOG_TOPIC_KEYS) {
    if (typeof bindings[key] === "number") {
      continue; // Already staged - never recreate.
    }
    const result = await createTelegramForumTopic({
      token,
      chatId,
      name: OPS_LOG_TOPIC_TITLES[key],
    });
    if (!result.ok) {
      return { ok: false, safeErrorCode: result.safeErrorCode, retryable: result.retryable };
    }
    bindings[key] = result.messageThreadId;
    // Durable per-topic persist: write the binding + count before the next
    // create, so a crash here never loses a created topic.
    await prisma.logGroupSetupAttempt.update({
      where: { id: attempt.id },
      data: { topicBindings: bindings, createdTopicCount: Object.keys(bindings).length },
    });
    await writeOpsLog({
      level: SystemLogLevel.INFO,
      topicKey: "SECURITY",
      eventType: "log_group.topic_created",
      message: "staged log-group topic created",
      metadata: { attemptId: attempt.id, topicKey: key },
    }).catch(() => undefined);
  }
  return { ok: true, bindings };
}

/**
 * The atomic activation: switches the active group Settings AND the active
 * LogTopic bindings AND the attempt status together, conditional on the
 * attempt still being in a running (non-cancelled) state. If a cancel or a
 * concurrent activation moved the row first, the guarded updateMany returns 0
 * and the whole transaction rolls back - NOTHING is written, so the previous
 * group stays active.
 */
async function activateStagedGroup(
  attempt: LogGroupSetupAttempt,
  bindings: TopicBindings,
): Promise<boolean> {
  const chatId = attempt.chatId.toString();
  const telegramChatId = attempt.chatId;
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.logGroupSetupAttempt.updateMany({
        where: { id: attempt.id, status: { in: [LogGroupSetupStatus.PROVISIONING, LogGroupSetupStatus.TESTING] } },
        data: {
          status: LogGroupSetupStatus.ACTIVE,
          activeSlot: null,
          directTestOk: true,
          completedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        // Cancelled or already activated by another run - abort without any
        // Settings/LogTopic write.
        throw new ActivationAbort();
      }
      await tx.setting.upsert({
        where: { key: LOG_GROUP_CHAT_ID_SETTING_KEY },
        update: { value: chatId, type: "STRING" },
        create: { key: LOG_GROUP_CHAT_ID_SETTING_KEY, value: chatId, type: "STRING" },
      });
      await tx.setting.upsert({
        where: { key: LOG_GROUP_TITLE_SETTING_KEY },
        update: { value: attempt.safeTitle.slice(0, 120), type: "STRING" },
        create: { key: LOG_GROUP_TITLE_SETTING_KEY, value: attempt.safeTitle.slice(0, 120), type: "STRING" },
      });
      for (const key of OPS_LOG_TOPIC_KEYS) {
        const topicId = bindings[key];
        if (typeof topicId !== "number") {
          continue;
        }
        await tx.logTopic.upsert({
          where: { key },
          update: { topicId, telegramChatId },
          create: {
            key,
            title: OPS_LOG_TOPIC_TITLES[key as OpsLogTopicKey],
            topicId,
            telegramChatId,
          },
        });
      }
    });
    return true;
  } catch (err) {
    if (err instanceof ActivationAbort) {
      return false;
    }
    throw err;
  }
}

class ActivationAbort extends Error {}

/**
 * Processes one PROVISION_LOG_GROUP job. Idempotent + resume-safe; the DB
 * attempt row is the source of truth.
 */
async function handleProvisionJob(
  job: Job,
  deps: LogGroupSetupDeps,
): Promise<Record<string, unknown>> {
  const attemptId = (job.data as { attemptId?: string }).attemptId;
  if (attemptId === undefined) {
    throw new Error("missing attemptId");
  }

  const existing = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
  if (existing === null) {
    return { skipped: "attempt-missing" };
  }
  if (
    existing.status === LogGroupSetupStatus.ACTIVE ||
    existing.status === LogGroupSetupStatus.CANCELLED
  ) {
    return { skipped: "already-terminal", status: existing.status };
  }

  // CAS claim: QUEUED/PROVISIONING/TESTING -> PROVISIONING (re-claim resumes a
  // crashed run). A FAILED row is not re-claimable here (a new attempt is
  // created for a fresh retry from the bot).
  const claimed = await prisma.logGroupSetupAttempt.updateMany({
    where: { id: attemptId, status: { in: RUNNING_STATUSES } },
    data: { status: LogGroupSetupStatus.PROVISIONING, startedAt: existing.startedAt ?? new Date() },
  });
  if (claimed.count === 0) {
    return { skipped: "not-claimable", status: existing.status };
  }

  const token = botToken();
  if (token === null) {
    await failAttempt(attemptId, "bot-token-missing");
    return { failed: "bot-token-missing" };
  }

  let lock: HeldLock | null = null;
  try {
    lock = await acquireLock(deps.redis, LOG_GROUP_SETUP_LOCK_KEY, SETUP_LOCK_TTL_MS);
    if (lock === null) {
      // Another provisioning holds the lock; retry via BullMQ backoff.
      throw new Error("setup-lock-contended");
    }

    const attempt = (await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } }))!;
    if (attempt.status === LogGroupSetupStatus.CANCELLED) {
      return { skipped: "cancelled" };
    }

    // 1. Create/reuse all default topics (durable per-topic persistence).
    const provisioned = await provisionStagedTopics(attempt, token);
    if (!provisioned.ok) {
      if (provisioned.retryable && !isFinalAttempt(job)) {
        throw new Error(`topic-provision-retryable:${provisioned.safeErrorCode}`);
      }
      await failAttempt(attemptId, provisioned.safeErrorCode);
      return { failed: "topic-provision", code: provisioned.safeErrorCode };
    }

    // Re-read for a cancel that landed during provisioning.
    const afterProvision = (await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } }))!;
    if (afterProvision.status === LogGroupSetupStatus.CANCELLED) {
      return { skipped: "cancelled" };
    }

    // 2. Direct SYSTEM test send to the staged topic (mark TESTING).
    await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.PROVISIONING },
      data: { status: LogGroupSetupStatus.TESTING },
    });
    const systemThreadId = provisioned.bindings.SYSTEM;
    const testSend = await sendTelegramMessage({
      token,
      chatId: attempt.chatId.toString(),
      text: "پیام آزمایشی راه‌اندازی گروه لاگ ✅",
      messageThreadId: typeof systemThreadId === "number" ? systemThreadId : undefined,
    });
    if (!testSend.ok) {
      if (testSend.retryable && !isFinalAttempt(job)) {
        throw new Error(`direct-test-retryable:${testSend.safeErrorCode}`);
      }
      await failAttempt(attemptId, testSend.safeErrorCode);
      return { failed: "direct-test", code: testSend.safeErrorCode };
    }

    // 3. Atomic activation (guarded on non-cancelled state).
    const activatedAttempt = (await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } }))!;
    const activated = await activateStagedGroup(activatedAttempt, provisioned.bindings);
    if (!activated) {
      return { skipped: "activation-aborted" };
    }

    // 4. The normal queued LOG_GROUP_CONNECTED event - verifies SystemLog
    // persistence, SystemLogDelivery creation, the worker queue, topic
    // routing and real Telegram delivery end to end through the SAME path as
    // every operational log.
    await writeOpsLog({
      level: SystemLogLevel.INFO,
      topicKey: "SYSTEM",
      eventType: "log_group.connected",
      message: "گروه لاگ با موفقیت متصل و فعال شد ✅",
      metadata: { attemptId },
    }).catch(() => undefined);

    return { ok: true, activated: true, topicCount: Object.keys(provisioned.bindings).length };
  } finally {
    if (lock !== null) {
      await releaseLock(deps.redis, lock);
    }
  }
}

/** BullMQ processor factory: routes PROVISION_LOG_GROUP, throws on any other. */
export function createLogGroupSetupProcessor(
  deps: LogGroupSetupDeps,
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job: Job) => {
    if (job.name !== LOG_GROUP_SETUP_JOB_NAME) {
      throw new Error(`unknown job: ${job.name}`);
    }
    return handleProvisionJob(job, deps);
  };
}
