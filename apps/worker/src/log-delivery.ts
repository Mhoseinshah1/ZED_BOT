import {
  LogDeliveryStatus,
  prisma,
  type LogTopic,
  type SystemLog,
  type SystemLogDelivery,
} from "@zedbot/database";
import {
  LOG_DELIVERY_JOB_NAME,
  createLogger,
  errorMessage,
  sanitizeOpsMetadata,
} from "@zedbot/shared";
import { Worker, type Job, type Queue } from "bullmq";

import { botToken } from "./config.js";
import { bumpLogAggregation, logAggregationHash, type RawRedis } from "./redis.js";
import { sendTelegramMessage } from "./telegram.js";
import type { LogDeliveryJobData } from "./queues.js";

// =============================================================================
// Telegram log-delivery consumer (LOG_DELIVERY_QUEUE_NAME).
//
// ANTI-RECURSION INVARIANT: nothing in this module ever creates SystemLog
// rows. Every failure here is reported ONLY through the local JSON logger
// and the SystemLogDelivery row itself - otherwise a broken log group would
// generate logs about failing to deliver logs, forever.
// =============================================================================

const logger = createLogger("worker:log-delivery");

/** Telegram-side chat id: the topic's own mapping wins, else the global
 * "log_group_chat_id" Setting. */
async function resolveChatId(topic: LogTopic): Promise<string | null> {
  if (topic.telegramChatId !== null) {
    return topic.telegramChatId.toString();
  }
  const setting = await prisma.setting.findUnique({ where: { key: "log_group_chat_id" } });
  const value = setting?.value.trim() ?? "";
  return value === "" ? null : value;
}

const LEVEL_EMOJI: Record<string, string> = { INFO: "ℹ️", WARN: "⚠️", ERROR: "🛑" };

/**
 * emoji + #eventType + message + compact metadata lines. Metadata was
 * sanitized at write time; sanitizeOpsMetadata runs again here as defense in
 * depth. Raw payloads are never rendered.
 */
export function composeLogMessage(log: SystemLog): string {
  const tag = log.eventType.replace(/[^A-Za-z0-9_]/g, "_");
  const lines: string[] = [`${LEVEL_EMOJI[log.level] ?? "ℹ️"} #${tag}`, "", log.message];
  const metadata = sanitizeOpsMetadata(log.metadata);
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const entries = Object.entries(metadata as Record<string, unknown>).slice(0, 10);
    if (entries.length > 0) {
      lines.push("");
      for (const [key, value] of entries) {
        const rendered =
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value);
        lines.push(`• ${key}: ${(rendered ?? "null").slice(0, 200)}`);
      }
    }
  }
  return lines.join("\n").slice(0, 3900);
}

async function markSkipped(deliveryId: string, safeErrorCode: string): Promise<void> {
  await prisma.systemLogDelivery.update({
    where: { id: deliveryId },
    data: { status: LogDeliveryStatus.SKIPPED, safeErrorCode },
  });
}

export interface LogDeliveryDeps {
  redis: RawRedis;
  logQueue: Queue;
}

/** Builds the processor for the log-delivery worker. */
export function createLogDeliveryProcessor(
  deps: LogDeliveryDeps,
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job: Job): Promise<Record<string, unknown>> => {
    if (job.name !== LOG_DELIVERY_JOB_NAME) {
      throw new Error(`unknown job: ${job.name}`);
    }
    const { deliveryId } = job.data as LogDeliveryJobData;

    const delivery = (await prisma.systemLogDelivery.findUnique({
      where: { id: deliveryId },
      include: { systemLog: true },
    })) as (SystemLogDelivery & { systemLog: SystemLog }) | null;
    if (delivery === null) {
      logger.warn("delivery row missing", { deliveryId });
      return { skipped: "delivery-missing" };
    }
    if (
      delivery.status === LogDeliveryStatus.SENT ||
      delivery.status === LogDeliveryStatus.DEAD_LETTER ||
      delivery.status === LogDeliveryStatus.SKIPPED
    ) {
      return { skipped: "already-terminal", status: delivery.status };
    }

    // --- destination checks (all end in SKIPPED, never retried) -------------
    if (delivery.logTopicId === null) {
      await markSkipped(deliveryId, "topic-unmapped");
      return { skipped: "topic-unmapped" };
    }
    const topic = await prisma.logTopic.findUnique({ where: { id: delivery.logTopicId } });
    if (topic === null) {
      await markSkipped(deliveryId, "topic-unmapped");
      return { skipped: "topic-unmapped" };
    }
    if (!topic.isEnabled) {
      await markSkipped(deliveryId, "topic-disabled");
      return { skipped: "topic-disabled" };
    }
    const chatId = await resolveChatId(topic);
    if (chatId === null) {
      await markSkipped(deliveryId, "log-group-unset");
      return { skipped: "log-group-unset" };
    }
    const token = botToken();
    if (token === null) {
      await markSkipped(deliveryId, "bot-token-missing");
      return { skipped: "bot-token-missing" };
    }

    // --- idempotency CAS: PENDING/FAILED -> SENDING --------------------------
    // SENDING is included so a delivery orphaned by a crash mid-send can be
    // retried; the SENT check above (plus concurrency 1) is what guarantees
    // a known-successful send never repeats.
    const claimed = await prisma.systemLogDelivery.updateMany({
      where: {
        id: deliveryId,
        status: {
          in: [LogDeliveryStatus.PENDING, LogDeliveryStatus.FAILED, LogDeliveryStatus.SENDING],
        },
      },
      data: { status: LogDeliveryStatus.SENDING },
    });
    if (claimed.count === 0) {
      return { skipped: "cas-lost" };
    }

    // --- 5-minute aggregation of identical lines per topic -------------------
    // First occurrence in the window is delivered; repeats are SKIPPED as
    // "aggregated". Simplification (intentional): no trailing "repeated N
    // times" summary is flushed - the counter simply expires after 5 minutes.
    const hash = logAggregationHash(delivery.systemLog.eventType, delivery.systemLog.message);
    let aggregated = false;
    try {
      aggregated = (await bumpLogAggregation(deps.redis, topic.key, hash)) > 1;
    } catch (err) {
      logger.warn("aggregation counter failed, sending anyway", { error: errorMessage(err) });
    }
    if (aggregated) {
      await markSkipped(deliveryId, "aggregated");
      return { skipped: "aggregated" };
    }

    // --- send -----------------------------------------------------------------
    const result = await sendTelegramMessage({
      token,
      chatId,
      text: composeLogMessage(delivery.systemLog),
      messageThreadId: topic.topicId ?? undefined,
    });
    if (result.ok) {
      await prisma.systemLogDelivery.update({
        where: { id: deliveryId },
        data: {
          status: LogDeliveryStatus.SENT,
          telegramMessageId: result.messageId,
          sentAt: new Date(),
          attempts: delivery.attempts + 1,
          safeErrorCode: null,
          nextAttemptAt: null,
        },
      });
      return { sent: true };
    }

    // --- failure bookkeeping ----------------------------------------------------
    const attempts = delivery.attempts + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= maxAttempts;
    const status = finalAttempt ? LogDeliveryStatus.DEAD_LETTER : LogDeliveryStatus.FAILED;
    const nextAttemptAt = finalAttempt
      ? null
      : new Date(Date.now() + (result.retryAfterMs ?? 30_000 * 2 ** attempts));
    await prisma.systemLogDelivery.update({
      where: { id: deliveryId },
      data: { status, attempts, safeErrorCode: result.safeErrorCode, nextAttemptAt },
    });
    logger.warn("log delivery failed", {
      deliveryId,
      safeErrorCode: result.safeErrorCode,
      attempts,
      finalAttempt,
    });

    if (result.safeErrorCode === "rate-limited" && !finalAttempt) {
      // 429: pause the whole (limiter-enabled) queue for retry_after and put
      // the job back WITHOUT consuming one of its attempts.
      await deps.logQueue.rateLimit(result.retryAfterMs ?? 5_000);
      throw Worker.RateLimitError();
    }
    if (!result.retryable && !finalAttempt) {
      // Permanent Telegram rejection (forbidden/chat-not-found/topic-missing):
      // retrying cannot help; dead-letter immediately.
      await prisma.systemLogDelivery.update({
        where: { id: deliveryId },
        data: { status: LogDeliveryStatus.DEAD_LETTER, nextAttemptAt: null },
      });
      return { sent: false, deadLetter: result.safeErrorCode };
    }
    // Re-throw so BullMQ retries with its exponential backoff (attempts: 5).
    throw new Error(`log delivery failed: ${result.safeErrorCode}`);
  };
}
