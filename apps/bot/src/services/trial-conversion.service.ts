import { Prisma, type Service } from "@zedbot/database";

import { logger } from "../core/logger.js";

// =============================================================================
// Trial-lifecycle phase: trial-to-paid conversion. The FIRST verified,
// COMPLETED paid operation (renewal / extra volume / extra time) on a
// FREE_TRIAL service stamps convertedToPaidAt + firstPaidOrderId exactly
// once - inside the SAME transaction that completes the Order and writes
// the operation's event anchor, guarded by a CAS on
// "convertedToPaidAt IS NULL" so replays, retries and reconciliation can
// never mark it twice. `source` is immutable (the origin stays visible);
// conversion never restores trial allowance and never permits another
// trial claim. Failed / refunded / uncertain operations never reach this
// function - callers invoke it only on the verified-apply persist path.
// =============================================================================

export const TRIAL_CONVERTED_EVENT_TYPE = "TRIAL_CONVERTED_TO_PAID";

/** One-time user notice, sent only by the operation that converted. */
export const TRIAL_CONVERTED_USER_TEXT =
  "سرویس تست شما با موفقیت به سرویس فعال تبدیل شد ✅";

/**
 * Marks the conversion inside the caller's persist transaction. Returns
 * true only when THIS call performed the conversion (the idempotency key
 * is effectively trial-conversion:<serviceId> - the CAS admits one winner;
 * firstPaidOrderId records which order won). Non-trial services and
 * already-converted services are a no-op.
 */
export async function markTrialConversion(
  tx: Prisma.TransactionClient,
  service: Pick<Service, "id" | "userId" | "panelId">,
  orderId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await tx.service.updateMany({
    where: { id: service.id, source: "FREE_TRIAL", convertedToPaidAt: null },
    data: { convertedToPaidAt: now, firstPaidOrderId: orderId },
  });
  if (updated.count !== 1) {
    return false;
  }
  await tx.serviceEventLog.create({
    data: {
      serviceId: service.id,
      userId: service.userId,
      panelId: service.panelId,
      eventType: TRIAL_CONVERTED_EVENT_TYPE,
      metadata: { orderId },
    },
  });
  logger.info("trial service converted to paid", { serviceId: service.id, orderId });
  return true;
}
