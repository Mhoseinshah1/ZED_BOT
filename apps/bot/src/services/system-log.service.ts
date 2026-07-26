import { Prisma, prisma } from "@zedbot/database";
import { FORCE_JOIN_OPS_EVENTS } from "@zedbot/force-join";
import {
  sanitizeOpsMetadata,
  scrubSecretsFromText,
  type OpsLogTopicKey,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { enqueueLogDelivery } from "./ops-queue.service.js";
import { getSetting } from "./settings.service.js";

// =============================================================================
// THE shared bot-side structured ops logger (ops-logging phase). Every
// operational event is persisted as a SystemLog row FIRST (source of truth);
// when a topicKey is given AND that LogTopic is enabled AND the Telegram log
// group is configured, exactly one SystemLogDelivery row is created (unique
// [systemLogId, logTopicId]) and its id is enqueued for the worker to send.
// writeSystemLog NEVER throws and never recurses into itself - any internal
// failure goes to the local stdout logger only, so ops logging can never
// take down the operation that emitted the event. Metadata passes through
// sanitizeOpsMetadata and the message through scrubSecretsFromText as the
// last line of defense; callers must still pass allowlisted fields only
// (ids, amounts, statuses - never payloads, URLs or tokens).
// =============================================================================

/** Setting key: Telegram chat id of the operational log group (supergroup). */
export const LOG_GROUP_CHAT_ID_KEY = "log_group_chat_id";

/**
 * Event catalog wired by this phase. Stable English markers - behavior and
 * queries bind to these, never to the human-readable messages.
 */
export const OPS_EVENTS = {
  BOT_STARTED: "bot.started",
  BOT_STOPPED: "bot.stopped",
  PAYMENT_SETTLED: "payment.settled",
  PAYMENT_DUPLICATE_SUCCESS: "payment.duplicate_success",
  RECEIPT_APPROVED: "payment.receipt_approved",
  RECEIPT_REJECTED: "payment.receipt_rejected",
  ORDER_PROVISIONED: "order.provision_completed",
  ORDER_PROVISION_FAILED: "order.provision_failed",
  SERVICE_OP_COMPLETED: "service.operation_completed",
  SERVICE_OP_FAILED: "service.operation_failed",
  PANEL_CONNECTION_FAILED: "panel.connection_failed",
  SECURITY_ADMIN_DENIED: "security.admin_access_denied",
  WALLET_MANUAL_ADJUSTED: "wallet.manual_adjustment",
  BACKUP_DELETED: "backup.deleted",
  LOG_GROUP_CHANGED: "log_group.changed",
  // Versioned mandatory terms: enforcement is on while nothing is published, so
  // the gate is stepping aside rather than locking every user out.
  TERMS_ENFORCEMENT_MISCONFIGURED: "terms.enforcement_misconfigured",
  // Direct-log-group-setup phase: the normal queued log emitted right after
  // a group is activated - it proves SystemLog persistence, SystemLogDelivery
  // creation, the worker queue, topic routing and Telegram delivery all work.
  LOG_GROUP_CONNECTED: "log_group.connected",
  // Representative program: a reseller-priced checkout settled (card / gateway)
  // while its live tier/price fingerprint no longer matched the frozen snapshot.
  // Observational only - the paid Order is authoritative and is NOT invalidated
  // (§16); the OWNER gets visibility that live pricing drifted after payment.
  REPRESENTATIVE_STALE_SETTLEMENT: "representative.settled_stale_pricing",
  // Representative program: the OWNER opted a SERVICE_PRODUCT into / out of
  // reseller sale (Product.representativeEligible). Privacy-safe: action +
  // enabled flag + product TYPE + short correlation id only (§8, §13, §24).
  PRODUCT_REP_ELIGIBILITY_CHANGED: "product.representative_eligibility_changed",
  // Admin-controlled unified purchase menu: the OWNER flipped the user main-menu
  // purchase layout between SPLIT and COMBINED. Privacy-MINIMAL: metadata is
  // EXACTLY { previousLayout, nextLayout, actorRole } and the row carries NO
  // relation id (adminId/userId/… all null) — the actor is revalidated at
  // mutation time but never persisted here (fix/purchase-menu-audit-privacy).
  USER_MENU_PURCHASE_LAYOUT_CHANGED: "user_menu.purchase_layout_changed",
  // Mandatory channel membership (force join): an ACTIVE required channel became
  // unverifiable during a live membership check (bot lost access / channel
  // deleted / username changed). Deduplicated per channel per rolling window
  // (channel DB id + error class). Privacy-safe: metadata carries ONLY the
  // channel DB id, a normalized error class and the isPrivate flag — never the
  // Telegram chat id, the invite link, or the raw Telegram response (§4.11, T6).
  FORCE_JOIN_CHANNEL_UNVERIFIABLE: "force_join.channel_unverifiable",
  // Mandatory channel membership: an active channel stayed unverifiable past the
  // failure threshold AND the sustained window, so it was automatically
  // deactivated. When it was the last active channel while force join was on,
  // the master switch was disabled in the same transaction (metadata
  // forceJoinDisabled) so the bot is never enabled with nothing enforceable.
  // Same privacy envelope as the alert above: channel DB id + flags only.
  //
  // These two are NOT written by this logger. Retirement is a configuration
  // mutation reachable from the API as well as the bot, so its event is
  // committed inside the mutation's own transaction by
  // `@zedbot/force-join`'s outbox. The markers are re-exported here — not
  // retyped — so the catalog, the Telegram renderer and any query stay bound
  // to the single definition and cannot drift apart.
  FORCE_JOIN_CHANNEL_RETIRED: FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
  /** That retirement removed the last active channel, so the switch went off. */
  FORCE_JOIN_AUTO_DISABLED: FORCE_JOIN_OPS_EVENTS.AUTO_DISABLED,
} as const;
export type OpsEventType = (typeof OPS_EVENTS)[keyof typeof OPS_EVENTS];

export interface WriteSystemLogArgs {
  level: "INFO" | "WARN" | "ERROR";
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  /** When set, the log is also queued for the matching Telegram log topic. */
  topicKey?: OpsLogTopicKey;
  userId?: string;
  adminId?: string;
  orderId?: string;
  paymentId?: string;
  serviceId?: string;
}

const MESSAGE_MAX = 1_000;

/**
 * Persists one structured ops log and (best effort) queues its Telegram
 * delivery. NEVER throws - a database or queue failure is written to the
 * local logger only, never re-entered into this function.
 */
export async function writeSystemLog(args: WriteSystemLogArgs): Promise<void> {
  try {
    const message = scrubSecretsFromText(args.message).slice(0, MESSAGE_MAX);
    const metadata =
      args.metadata === undefined
        ? undefined
        : (sanitizeOpsMetadata(args.metadata) as Prisma.InputJsonValue);
    const systemLog = await prisma.systemLog.create({
      data: {
        level: args.level,
        eventType: args.eventType,
        message,
        ...(metadata === undefined ? {} : { metadata }),
        userId: args.userId ?? null,
        adminId: args.adminId ?? null,
        orderId: args.orderId ?? null,
        paymentId: args.paymentId ?? null,
        serviceId: args.serviceId ?? null,
      },
    });

    if (args.topicKey === undefined) {
      return;
    }
    const topic = await prisma.logTopic.findUnique({ where: { key: args.topicKey } });
    if (topic === null || !topic.isEnabled) {
      return;
    }
    if ((await getSetting(LOG_GROUP_CHAT_ID_KEY, "")) === "") {
      return;
    }

    let deliveryId: string;
    try {
      const delivery = await prisma.systemLogDelivery.create({
        data: { systemLogId: systemLog.id, logTopicId: topic.id },
      });
      deliveryId = delivery.id;
    } catch (err) {
      // P2002 = a concurrent writer already created this pair - reuse it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.systemLogDelivery.findUnique({
          where: {
            systemLogId_logTopicId: { systemLogId: systemLog.id, logTopicId: topic.id },
          },
        });
        if (existing === null) {
          return;
        }
        deliveryId = existing.id;
      } else {
        throw err;
      }
    }
    // Fail-soft: an unqueued delivery stays PENDING and the worker's
    // periodic requeue sweep picks it up - never blocks the caller.
    await enqueueLogDelivery(deliveryId);
  } catch (err) {
    // Local logger ONLY - never recurse into writeSystemLog from here.
    logger.warn("system log write failed", {
      eventType: args.eventType,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}
