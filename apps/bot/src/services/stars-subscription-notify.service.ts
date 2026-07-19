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

import { logger } from "../core/logger.js";

// =============================================================================
// Durable Stars subscription notifications (bot side, Phase 2.1). The bot creates
// the SCHEDULED AutomatedNotification row (category PAYMENT, deduped on a safe key)
// at each lifecycle transition it owns — activation/renewal (settlement), refund
// (refund service), cancellation (cancel flow), price-version change (admin). The
// worker's maintenance reconciler delivers SCHEDULED rows (the bot does not hold
// the delivery queue). The snapshot carries ONLY safe display variables + the
// subscription short id — never a charge id, payload or Telegram id.
// =============================================================================

export interface CreateStarsNotificationInput {
  subscriptionId: string;
  userId: string;
  type: NotificationType;
  cycleKey: string;
  serviceName: string;
  starsAmount: number;
  currentPeriodEnd: string;
}

/** Creates one durable Stars notification (idempotent on the dedupe key). */
export async function createStarsSubscriptionNotification(
  input: CreateStarsNotificationInput,
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
    meta: { subShort: input.subscriptionId.slice(0, 8) },
  };
  try {
    await prisma.automatedNotification.create({
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
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false;
    }
    logger.warn("stars subscription notification create failed", { error: String(err).slice(0, 120) });
    return false;
  }
}
