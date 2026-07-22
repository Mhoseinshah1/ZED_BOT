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
import { Worker, type Job, type Queue } from "bullmq";

import { botToken } from "./config.js";
import { writeOpsLog } from "./ops-log.js";
import { acquireLock, extendLock, releaseLock, type HeldLock, type RawRedis } from "./redis.js";
import { createTelegramForumTopic, sendTelegramMessage } from "./telegram.js";

// =============================================================================
// Worker consumer for the telegram-log-group-setup queue (PROVISION_LOG_GROUP).
// The bot enqueues one job per LogGroupSetupAttempt after the OWNER confirms a
// validated numeric-ID target; here we CREATE the default forum topics, SEND
// the direct SYSTEM test and ACTIVATE the group atomically - never inline in a
// Telegram callback.
//
// Resume-safe: the attempt row's topicBindings is written after EACH created
// topic, so a retried/crashed job re-reads it and never recreates a PERSISTED
// topic. (A crash in the narrow window between a createForumTopic response and
// its persist can orphan ONE empty, never-bound topic - see
// provisionStagedTopics; Telegram's Bot API exposes no list/dedupe to
// reconcile it, so this is accepted, bounded and harmless.)
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
type ProvisionResult =
  | { ok: true; bindings: TopicBindings }
  | { ok: false; safeErrorCode: string; retryable: boolean; retryAfterMs?: number };

async function provisionStagedTopics(
  attempt: LogGroupSetupAttempt,
  token: string,
  refreshLock: () => Promise<void>,
): Promise<ProvisionResult> {
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
      // retryAfterMs is preserved through to the setup worker so a 429 becomes
      // a queue-level rate-limit (Worker.RateLimitError) that does NOT consume
      // a normal attempt and resumes from the next missing topic.
      return {
        ok: false,
        safeErrorCode: result.safeErrorCode,
        retryable: result.retryable,
        retryAfterMs: result.retryAfterMs,
      };
    }
    bindings[key] = result.messageThreadId;
    // Durable per-topic persist: write the binding + count IMMEDIATELY after
    // the create and before the next create, so a resume never recreates an
    // already-PERSISTED topic. A crash in the narrow window between the
    // createForumTopic response above and this write can orphan one empty
    // topic (Telegram's Bot API has no list/dedupe to reconcile it); that
    // topic is never bound - activation only consumes persisted bindings - so
    // the residue is a harmless empty forum topic, never a delivery target.
    await prisma.logGroupSetupAttempt.update({
      where: { id: attempt.id },
      data: { topicBindings: bindings, createdTopicCount: Object.keys(bindings).length },
    });
    // Lock safety (§15): every successful create pushes the owned lock's TTL
    // out (compare-and-expire by token), so a bounded-but-slow provisioning of
    // all topics can never let the lock expire under a healthy run.
    await refreshLock();
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

  const token = botToken();

  let lock: HeldLock | null = null;
  // Set when a Telegram 429 turned this run into a queue-level rate-limit
  // (Worker.RateLimitError). Such a deferral does NOT consume a normal BullMQ
  // attempt and MUST keep the active-setup slot held so the SAME durable row
  // resumes - the catch below re-throws without failing the attempt.
  let deferredByRateLimit = false;
  const refreshLock = async (): Promise<void> => {
    if (lock !== null) {
      await extendLock(deps.redis, lock, SETUP_LOCK_TTL_MS);
    }
  };
  try {
    // CAS claim: QUEUED/PROVISIONING/TESTING -> PROVISIONING (re-claim resumes
    // a crashed run). A FAILED row is not re-claimable here (a new attempt is
    // created for a fresh retry from the bot). Inside the try so any post-claim
    // throw frees the slot on the final attempt (see the catch below).
    const claimed = await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: { in: RUNNING_STATUSES } },
      data: {
        status: LogGroupSetupStatus.PROVISIONING,
        startedAt: existing.startedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) {
      // Already moved to a terminal/other state; nothing we claimed to free.
      return { skipped: "not-claimable", status: existing.status };
    }

    if (token === null) {
      await failAttempt(attemptId, "bot-token-missing");
      return { failed: "bot-token-missing" };
    }

    lock = await acquireLock(deps.redis, LOG_GROUP_SETUP_LOCK_KEY, SETUP_LOCK_TTL_MS);
    if (lock === null) {
      // Another provisioning holds the lock; retry via BullMQ backoff. On the
      // FINAL attempt the catch below frees the slot so a future setup can run
      // (mirroring the provision/test branches, which free it via failAttempt).
      throw new Error("setup-lock-contended");
    }

    const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
    if (attempt === null) {
      // Row deleted concurrently (the unique slot went with it) - nothing to do.
      return { skipped: "attempt-missing" };
    }
    if (attempt.status === LogGroupSetupStatus.CANCELLED) {
      return { skipped: "cancelled" };
    }

    // 1. Create/reuse all default topics (durable per-topic persistence).
    const provisioned = await provisionStagedTopics(attempt, token, refreshLock);
    if (!provisioned.ok) {
      if (provisioned.safeErrorCode === "rate-limited") {
        // Telegram 429: rate-limit the whole setup queue for the (capped)
        // retry-after and re-queue WITHOUT consuming an attempt. All topics
        // created so far are persisted, so the resume starts from the next
        // missing topic - creation never restarts from zero.
        await deps.setupQueue.rateLimit(provisioned.retryAfterMs ?? 5_000);
        deferredByRateLimit = true;
        throw Worker.RateLimitError();
      }
      if (provisioned.retryable && !isFinalAttempt(job)) {
        throw new Error(`topic-provision-retryable:${provisioned.safeErrorCode}`);
      }
      await failAttempt(attemptId, provisioned.safeErrorCode);
      return { failed: "topic-provision", code: provisioned.safeErrorCode };
    }

    // Re-read for a cancel that landed during provisioning.
    const afterProvision = await prisma.logGroupSetupAttempt.findUnique({
      where: { id: attemptId },
    });
    if (afterProvision === null) {
      return { skipped: "attempt-missing" };
    }
    if (afterProvision.status === LogGroupSetupStatus.CANCELLED) {
      return { skipped: "cancelled" };
    }

    // 2. Direct SYSTEM test send to the staged topic (mark TESTING). The
    // guarded updateMany's count IS the race check: a cancel that committed
    // CANCELLED after the re-read above matches 0 rows, and we must NOT send
    // the test message into a group we are no longer activating.
    const toTesting = await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.PROVISIONING },
      data: { status: LogGroupSetupStatus.TESTING },
    });
    if (toTesting.count === 0) {
      return { skipped: "cancelled-or-not-provisioning" };
    }
    // Lock safety (§15): refresh the owned lock immediately before the test
    // send so the final bounded Telegram call can never outlive the TTL.
    await refreshLock();
    const systemThreadId = provisioned.bindings.SYSTEM;
    // The staged SYSTEM topic MUST exist before the direct test - a test with
    // no thread id would land in General and falsely "prove" the group works.
    if (typeof systemThreadId !== "number") {
      await failAttempt(attemptId, "topic-missing");
      return { failed: "direct-test", code: "topic-missing" };
    }
    const testSend = await sendTelegramMessage({
      token,
      chatId: attempt.chatId.toString(),
      text: "پیام آزمایشی راه‌اندازی گروه لاگ ✅",
      messageThreadId: systemThreadId,
    });
    if (!testSend.ok) {
      if (testSend.safeErrorCode === "rate-limited") {
        await deps.setupQueue.rateLimit(testSend.retryAfterMs ?? 5_000);
        deferredByRateLimit = true;
        throw Worker.RateLimitError();
      }
      if (testSend.retryable && !isFinalAttempt(job)) {
        throw new Error(`direct-test-retryable:${testSend.safeErrorCode}`);
      }
      await failAttempt(attemptId, testSend.safeErrorCode);
      return { failed: "direct-test", code: testSend.safeErrorCode };
    }

    // 3. Atomic activation (guarded on non-cancelled state).
    const activatedAttempt = await prisma.logGroupSetupAttempt.findUnique({
      where: { id: attemptId },
    });
    if (activatedAttempt === null) {
      return { skipped: "attempt-missing" };
    }
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
  } catch (err) {
    // A 429-driven rate-limit deferral does NOT consume an attempt and is not a
    // failure: keep the slot held so the SAME durable row resumes from its
    // persisted bindings once the rate-limit window clears.
    if (deferredByRateLimit) {
      throw err;
    }
    // On the FINAL BullMQ attempt, ANY terminal failure after the CAS claim
    // MUST free the unique active-setup slot (activeSlot) so a future setup can
    // start: the lock-contended throw, a transient activation DB error, or any
    // other unexpected throw. Earlier attempts keep the slot held so the SAME
    // durable row resumes on retry - the slot is never freed mid-retry, only
    // when the attempt is truly terminal. failAttempt is a no-op unless the row
    // is still running, so a branch that already freed it never double-frees.
    if (isFinalAttempt(job)) {
      await failAttempt(attemptId, "setup-error");
    }
    throw err;
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
