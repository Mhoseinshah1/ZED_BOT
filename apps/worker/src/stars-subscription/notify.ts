import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  Prisma,
  prisma,
} from "@zedbot/database";
import {
  NOTIF_STARS_SUBSCRIPTION_TEMPLATE_KEYS,
  starsSubscriptionDedupeKey,
  starsSubscriptionNotificationButtons,
  type NotificationType,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery } from "../notifications/queues.js";

// =============================================================================
// Durable Stars subscription notifications (Phase 2.1). Creates ONE persistent
// AutomatedNotification (category PAYMENT) per real event, deduped on a safe key,
// and — when a delivery queue is available (worker side) — enqueues delivery. When
// created from a context without the delivery queue the maintenance reconciler
// picks the SCHEDULED row up. The payload snapshot carries ONLY safe display
// variables + the subscription SHORT id (never a charge id, payload or Telegram id).
// =============================================================================

/** The 8-hex subscription short id used to resolve the subscription from a button. */
export function subscriptionShort(subscriptionId: string): string {
  return subscriptionId.slice(0, 8);
}

export interface StarsNotificationInput {
  subscriptionId: string;
  userId: string;
  type: NotificationType;
  /** Event anchor for dedupe (period-end ISO / order short / state / version). */
  cycleKey: string;
  serviceName: string;
  starsAmount: number;
  currentPeriodEnd: string;
}

/**
 * Creates one durable Stars subscription notification (idempotent on the dedupe
 * key). Returns false when a row already exists for the same event (P2002) or the
 * type has no template. When `deliveryQueue` is provided the delivery is enqueued
 * immediately; otherwise the SCHEDULED row is delivered by the maintenance
 * reconciler.
 */
export async function createStarsNotification(
  deliveryQueue: Queue | null,
  input: StarsNotificationInput,
): Promise<boolean> {
  const templateKey = NOTIF_STARS_SUBSCRIPTION_TEMPLATE_KEYS[input.type];
  if (templateKey === undefined) {
    return false;
  }
  const dedupeKey = starsSubscriptionDedupeKey(input.subscriptionId, input.type, input.cycleKey);
  const payloadSnapshot: Prisma.InputJsonObject = {
    templateKey,
    variables: {
      service_name: input.serviceName,
      stars_amount: input.starsAmount,
      current_period_end: input.currentPeriodEnd,
    },
    buttons: starsSubscriptionNotificationButtons(input.type) as unknown as Prisma.InputJsonArray,
    // Safe non-rendered meta: the subscription SHORT id resolves the subscription
    // for a button action + drives delivery revalidation. NEVER a charge id.
    meta: { subShort: subscriptionShort(input.subscriptionId) },
  };
  try {
    const notif = await prisma.automatedNotification.create({
      data: {
        type: input.type as AutomatedNotificationType,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: input.userId,
        serviceId: null,
        dedupeKey,
        ruleVersion: 1,
        scheduledFor: new Date(),
        payloadSnapshot,
      },
      select: { id: true },
    });
    if (deliveryQueue !== null) {
      await enqueueNotificationDelivery(deliveryQueue, notif.id);
    }
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false;
    }
    throw err;
  }
}
