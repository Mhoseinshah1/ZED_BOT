import { Prisma, SystemLogLevel } from "@zedbot/database";
import { sanitizeOpsMetadata, scrubSecretsFromText, type OpsLogTopicKey } from "@zedbot/shared";

// =============================================================================
// The durable operational-alert outbox for automatic Force Join configuration
// changes.
//
// WHY THIS IS NOT `writeSystemLog`. The bot's ops logger is a separate
// statement after the mutation, in a process that owns a BullMQ connection.
// The unhealthy-channel policy is now reached from BOTH the bot and the API,
// and the API has neither. That produced a hole with real consequences: the
// API can deactivate a required channel — and, when it is the last one, switch
// mandatory membership OFF for the whole platform — while the only evidence is
// a line on that process's stdout. An operator can lose Force Join entirely
// and never receive the alert their existing pipeline is supposed to deliver.
//
// So the alert is written as an OUTBOX ROW inside the SAME transaction as the
// configuration change:
//
//   * it commits with the retirement or does not exist at all;
//   * a crash immediately after commit loses nothing — the row is already
//     durable and PENDING;
//   * Telegram is never called on the request path, so delivery failure cannot
//     roll back or delay the membership decision;
//   * the worker delivers it later through the EXISTING SystemLog →
//     SystemLogDelivery → Telegram pipeline, no second mechanism.
//
// Idempotency comes from the mutation itself rather than from a dedupe key: a
// retry re-reads the row, finds it already inactive, and returns without
// reaching this code. That is why these helpers must only ever be called on
// the branch that actually performs the change.
//
// PRIVACY. Metadata carries the channel's DATABASE id, a boolean and counters
// — never the Telegram chat id, the invite link, a username or any user
// identity. `sanitizeOpsMetadata` and `scrubSecretsFromText` run as the last
// line of defence, exactly as the bot's writer does.
// =============================================================================

/**
 * Stable event markers. These strings are the contract between the writer and
 * every consumer (queries, dashboards, the Telegram renderer), so they are
 * defined once here and re-exported by the bot's `OPS_EVENTS` catalog rather
 * than typed out twice.
 */
export const FORCE_JOIN_OPS_EVENTS = {
  /** An active channel was automatically deactivated by the health policy. */
  CHANNEL_RETIRED: "force_join.channel_auto_deactivated",
  /** That retirement removed the last active channel, so the switch went off. */
  AUTO_DISABLED: "force_join.auto_disabled",
} as const;

/** The operational topic these alerts are routed to. */
export const FORCE_JOIN_OPS_TOPIC: OpsLogTopicKey = "SYSTEM";

/** Setting key naming the Telegram log group; empty means delivery is off. */
const LOG_GROUP_CHAT_ID_KEY = "log_group_chat_id";

const MESSAGE_MAX = 1_000;

/**
 * Persists one operational event and, when a delivery target is configured,
 * its PENDING delivery row — all on the CALLER'S transaction client.
 *
 * Returns nothing and throws nothing of its own: it is deliberately allowed to
 * propagate a genuine database error, because a failure to record the alert
 * must abort the configuration change rather than let it commit unannounced.
 * That is the opposite of `writeSystemLog`'s fail-soft contract, and it is the
 * point — a silent automatic disablement of mandatory membership is precisely
 * what this exists to prevent.
 */
export async function writeForceJoinOpsEvent(
  tx: Prisma.TransactionClient,
  input: {
    level: SystemLogLevel;
    eventType: string;
    message: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const metadata = sanitizeOpsMetadata(input.metadata) as Prisma.InputJsonValue;
  const systemLog = await tx.systemLog.create({
    data: {
      level: input.level,
      eventType: input.eventType,
      message: scrubSecretsFromText(input.message).slice(0, MESSAGE_MAX),
      metadata,
    },
    select: { id: true },
  });

  // A delivery row is only meaningful when there is somewhere to deliver to.
  // Without it the SystemLog row remains the durable record — which is what an
  // operator reading the ops log or the admin panel sees either way.
  const topic = await tx.logTopic.findUnique({
    where: { key: FORCE_JOIN_OPS_TOPIC },
    select: { id: true, isEnabled: true },
  });
  if (topic === null || !topic.isEnabled) {
    return;
  }
  const logGroup = await tx.setting.findUnique({
    where: { key: LOG_GROUP_CHAT_ID_KEY },
    select: { value: true },
  });
  if ((logGroup?.value ?? "").trim() === "") {
    return;
  }

  // `skipDuplicates` + the [systemLogId, logTopicId] unique makes this safe if
  // the surrounding transaction is ever retried by the driver.
  await tx.systemLogDelivery.createMany({
    data: [{ systemLogId: systemLog.id, logTopicId: topic.id }],
    skipDuplicates: true,
  });
}
