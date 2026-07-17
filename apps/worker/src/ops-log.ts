import { prisma, type Prisma, type SystemLogLevel } from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  sanitizeOpsMetadata,
  scrubSecretsFromText,
  type OpsLogTopicKey,
} from "@zedbot/shared";

// =============================================================================
// Worker-side ops-log writer (shared by every worker module): sanitize ->
// persist the SystemLog row (source of truth) -> create the per-topic
// SystemLogDelivery tracker -> enqueue the Telegram delivery job. Writing a
// log must NEVER break the operation that emitted it, so this helper catches
// everything and reports failures only via the local JSON logger.
// =============================================================================

const logger = createLogger("worker:ops-log");

type DeliveryEnqueuer = (deliveryId: string) => Promise<void>;

// Injected at bootstrap (queue mode) or left null (CLI without Redis): the
// SystemLog + PENDING delivery rows are still persisted and a later worker
// sweep/retry can pick them up.
let deliveryEnqueuer: DeliveryEnqueuer | null = null;

export function setLogDeliveryEnqueuer(enqueuer: DeliveryEnqueuer | null): void {
  deliveryEnqueuer = enqueuer;
}

export interface OpsLogInput {
  level: SystemLogLevel;
  topicKey: OpsLogTopicKey;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes one operational SystemLog and schedules its Telegram delivery for
 * the mapped, enabled LogTopic (matched by stable key). Never throws.
 */
export async function writeOpsLog(input: OpsLogInput): Promise<void> {
  try {
    const metadata =
      input.metadata === undefined
        ? undefined
        : (sanitizeOpsMetadata(input.metadata) as Prisma.InputJsonValue);
    const systemLog = await prisma.systemLog.create({
      data: {
        level: input.level,
        eventType: input.eventType,
        message: scrubSecretsFromText(input.message),
        ...(metadata === undefined ? {} : { metadata }),
      },
    });

    const topic = await prisma.logTopic.findUnique({ where: { key: input.topicKey } });
    if (topic === null || !topic.isEnabled) {
      // No mapped/enabled topic: the SystemLog row remains the full record.
      return;
    }

    // skipDuplicates + the [systemLogId, logTopicId] unique make re-entrant
    // calls safe; the follow-up findUnique recovers the row id either way.
    await prisma.systemLogDelivery.createMany({
      data: [{ systemLogId: systemLog.id, logTopicId: topic.id }],
      skipDuplicates: true,
    });
    const delivery = await prisma.systemLogDelivery.findUnique({
      where: { systemLogId_logTopicId: { systemLogId: systemLog.id, logTopicId: topic.id } },
    });
    if (delivery === null) {
      return;
    }

    if (deliveryEnqueuer !== null) {
      await deliveryEnqueuer(delivery.id);
    }
  } catch (err) {
    logger.warn("failed to write ops log", {
      eventType: input.eventType,
      error: errorMessage(err),
    });
  }
}
