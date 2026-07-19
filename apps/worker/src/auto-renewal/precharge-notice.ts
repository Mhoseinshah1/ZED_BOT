import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  AutomatedNotificationType,
  Prisma,
  prisma,
  type Service,
  type ServiceAutoRenewalMandate,
} from "@zedbot/database";
import {
  AUTO_RENEWAL_PRECHARGE_DELIVERY_UNCONFIRMED_REASON,
  AUTO_RENEWAL_PRECHARGE_GATE_MAX_DEFER_MS,
  AUTO_RENEWAL_PRECHARGE_GATE_STEP_MS,
  AUTO_RENEWAL_PRECHARGE_WINDOW_MISSED_REASON,
  NOTIF_AUTO_RENEWAL_UPCOMING_TEMPLATE_KEY,
  WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS,
  autoRenewalUpcomingDedupeKey,
  autoRenewalUpcomingNotificationButtons,
  buildAutoRenewalCycleFingerprint,
  createLogger,
  errorMessage,
  resolveAutoRenewalNoticeSchedule,
  type WalletAutoRenewalConfig,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery } from "../notifications/queues.js";
import { writeOpsLog } from "../ops-log.js";

// =============================================================================
// Wallet auto-renewal PRE-CHARGE NOTICE (Corrective Phase). The scan creates ONE
// durable AutomatedNotification (type AUTO_RENEWAL_UPCOMING, category PAYMENT) per
// Service expiry cycle, normally ~24h BEFORE the expected wallet deduction, with
// scheduledFor = prechargeNoticeAt and availableUntil = expectedChargeAt. The
// existing notification reconciler delivers it (no second engine, no second
// queue); this module only persists the row and the charge-race gate reads it.
//
// It NEVER moves money, NEVER renews a Service, NEVER creates a wallet Attempt and
// NEVER writes the wallet balance / full ids / telegram id / service username /
// panel data into the snapshot. A failed/suppressed/expired notice NEVER revokes a
// valid mandate — the charge path is guarded, not cancelled, by a missing delivery.
// =============================================================================

const log = createLogger("worker:war-precharge");

/** The 8-hex mandate short id the notice buttons resolve back to the mandate. */
export function mandateShort(mandateId: string): string {
  return mandateId.slice(0, 8);
}

/** Safe service display name for the snapshot: the FROZEN plan-name snapshot, never
 * the remote technical username. */
function safeServiceDisplayName(service: Pick<Service, "productNameSnapshot">): string {
  const name = service.productNameSnapshot;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return "سرویس شما";
}

/** Compact, unambiguous instant for the notice text (UTC, minute precision). The
 * delivery revalidation re-renders this from the live expected charge instant. */
export function formatNoticeInstant(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export interface PrechargeSnapshotInput {
  mandateId: string;
  serviceDisplayName: string;
  productDisplayName: string;
  currentPriceToman: number;
  maximumChargeToman: number;
  expectedChargeAtEpoch: number;
  serviceExpiresAtEpoch: number;
  expiryCycleFingerprint: string;
}

/**
 * The SAFE payload snapshot for an upcoming-renewal notice. Allowlisted display
 * variables + the mandate SHORT id + the cycle fingerprint + the expected-charge
 * epoch only — never the wallet balance, a full id, a telegram id, a service
 * username, a URL/token, panel/order/payment data or credentials. Exported so the
 * admin dry-run preview and the tests render exactly what the scan would create.
 */
export function buildAutoRenewalPrechargeSnapshot(input: PrechargeSnapshotInput): Prisma.InputJsonObject {
  return {
    templateKey: NOTIF_AUTO_RENEWAL_UPCOMING_TEMPLATE_KEY,
    variables: {
      service_name: input.serviceDisplayName,
      product_name: input.productDisplayName,
      current_price: input.currentPriceToman,
      maximum_charge: input.maximumChargeToman,
      expected_charge_time: formatNoticeInstant(new Date(input.expectedChargeAtEpoch)),
      service_expiry: formatNoticeInstant(new Date(input.serviceExpiresAtEpoch)),
    },
    buttons: autoRenewalUpcomingNotificationButtons() as unknown as Prisma.InputJsonArray,
    // Non-rendered safe meta: drives delivery revalidation + button resolution.
    meta: {
      mandateShort: mandateShort(input.mandateId),
      cycle: input.expiryCycleFingerprint,
      expectedChargeEpoch: input.expectedChargeAtEpoch,
    },
  };
}

export type PrechargeNoticeOutcome =
  | { kind: "scheduled" | "catch-up"; created: boolean }
  | { kind: "missed" | "disabled" | "product-unavailable" | "no-cycle" };

/**
 * Ensures the ONE advance pre-charge notice for a mandate's current expiry cycle
 * exists (idempotent on the cycle dedupe key). Called from the scan's not-yet-due
 * branch. Cancels any stale SCHEDULED notice for a DIFFERENT cycle of the same
 * service (a manual renewal moved the expiry). Loads the product only when actually
 * creating a row, so repeat scans of an unchanged cycle cost a single indexed
 * lookup. When the notice is a catch-up (delivery window already open) and a
 * delivery queue is available the delivery is enqueued immediately; otherwise the
 * reconciler picks the SCHEDULED row up at scheduledFor.
 */
export async function ensureAutoRenewalPrechargeNotice(
  mandate: ServiceAutoRenewalMandate,
  service: Pick<Service, "id" | "productNameSnapshot" | "expiresAt">,
  config: WalletAutoRenewalConfig,
  deliveryQueue: Queue | null,
  now: Date,
): Promise<PrechargeNoticeOutcome> {
  const expiresAtEpoch = service.expiresAt?.getTime() ?? null;
  const schedule = resolveAutoRenewalNoticeSchedule({
    expiresAtEpoch,
    chargeLeadMinutes: mandate.chargeLeadMinutes,
    prechargeNoticeMinutes: config.prechargeNoticeMinutes,
    nowEpoch: now.getTime(),
  });
  if (schedule.kind === "disabled" || schedule.kind === "missed") {
    return { kind: schedule.kind };
  }
  const fingerprint = buildAutoRenewalCycleFingerprint({
    serviceId: service.id,
    expiresAtEpoch,
    productId: mandate.productId,
  });
  if (fingerprint === null || schedule.scheduledForEpoch === null || schedule.expectedChargeAtEpoch === null) {
    return { kind: "no-cycle" };
  }
  const dedupeKey = autoRenewalUpcomingDedupeKey(mandate.id, fingerprint);

  // Idempotent per cycle: a row already exists -> nothing to do (repeat scans, a
  // worker restart or a concurrent scan all converge on the one row).
  const existing = await prisma.automatedNotification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing !== null) {
    return { kind: schedule.kind, created: false };
  }

  // Only now (first creation) load the product for the safe price + name snapshot.
  const product = await prisma.product.findUnique({
    where: { id: mandate.productId },
    select: { priceToman: true, name: true },
  });
  if (product === null) {
    return { kind: "product-unavailable" };
  }

  const snapshot = buildAutoRenewalPrechargeSnapshot({
    mandateId: mandate.id,
    serviceDisplayName: safeServiceDisplayName(service),
    productDisplayName: product.name,
    currentPriceToman: product.priceToman,
    maximumChargeToman: mandate.maximumChargeToman,
    expectedChargeAtEpoch: schedule.expectedChargeAtEpoch,
    serviceExpiresAtEpoch: expiresAtEpoch ?? schedule.expectedChargeAtEpoch,
    expiryCycleFingerprint: fingerprint,
  });

  // Cancel any SCHEDULED notice for a DIFFERENT cycle of this service (a manual
  // renewal moved the expiry). Delivery revalidation is the authoritative guard;
  // this is the eager cleanup so a stale future notice never fires.
  await cancelStaleUpcomingNotices(service.id, dedupeKey, now);

  try {
    const notif = await prisma.automatedNotification.create({
      data: {
        type: AutomatedNotificationType.AUTO_RENEWAL_UPCOMING,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: mandate.userId,
        serviceId: service.id,
        dedupeKey,
        ruleVersion: 1,
        scheduledFor: new Date(schedule.scheduledForEpoch),
        availableUntil: new Date(schedule.expectedChargeAtEpoch),
        payloadSnapshot: snapshot,
      },
      select: { id: true },
    });
    // Catch-up: the delivery window is already open -> enqueue immediately so the
    // user is warned before the (still future) charge, rather than waiting a scan.
    if (schedule.kind === "catch-up" && deliveryQueue !== null) {
      await enqueueNotificationDelivery(deliveryQueue, notif.id).catch(() => undefined);
    }
    await logPrechargeEvent(
      schedule.kind === "catch-up"
        ? WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS.prechargeCatchUp
        : WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS.prechargeScheduled,
      { cycle: fingerprint.slice(0, 8) },
    );
    return { kind: schedule.kind, created: true };
  } catch (err) {
    // A concurrent scan created the row first -> converge (still the one notice).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { kind: schedule.kind, created: false };
    }
    throw err;
  }
}

/** Cancels SCHEDULED upcoming notices of a service that belong to a superseded cycle. */
async function cancelStaleUpcomingNotices(serviceId: string, keepDedupeKey: string, now: Date): Promise<void> {
  const cancelled = await prisma.automatedNotification.updateMany({
    where: {
      serviceId,
      type: AutomatedNotificationType.AUTO_RENEWAL_UPCOMING,
      status: AutomatedNotificationStatus.SCHEDULED,
      dedupeKey: { not: keepDedupeKey },
    },
    data: { status: AutomatedNotificationStatus.CANCELLED, cancelledAt: now, safeErrorCode: "cycle-superseded" },
  });
  if (cancelled.count > 0) {
    await logPrechargeEvent(WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS.prechargeCancelled, { count: cancelled.count });
  }
}

// --- charge-race gate (Part J) ----------------------------------------------

export type PrechargeGateDecision =
  | { action: "proceed"; reason?: string }
  | { action: "defer"; until: Date };

/**
 * The charge-race gate: consulted right before the wallet Attempt is created. It
 * reads the cycle's upcoming-notice status and decides whether the charge may go
 * ahead now. A delivered (SENT) or terminally-undeliverable (SUPPRESSED / FAILED /
 * DEAD_LETTER / EXPIRED / CANCELLED) notice never blocks the consented charge. A
 * notice still awaiting delivery briefly defers the charge in small steps, but
 * NEVER past `expectedChargeAt + 30min` — a Telegram outage must not freeze a
 * consented renewal, so past the cap the charge proceeds and the caller records
 * `precharge-delivery-unconfirmed`. When the advance notice is disabled or the
 * window was missed there is no row and the charge proceeds unguarded.
 */
export async function evaluateAutoRenewalPrechargeGate(
  dedupeKey: string,
  expectedChargeAtEpoch: number,
  prechargeNoticeMinutes: number,
  nowEpoch: number,
): Promise<PrechargeGateDecision> {
  if (prechargeNoticeMinutes <= 0) {
    return { action: "proceed" };
  }
  const notice = await prisma.automatedNotification.findUnique({
    where: { dedupeKey },
    select: { status: true, scheduledFor: true },
  });
  if (notice === null) {
    // No advance notice for this cycle (window missed / just enabled) -> the charge
    // is not blocked; the caller records `precharge-window-missed` for the record.
    return { action: "proceed", reason: AUTO_RENEWAL_PRECHARGE_WINDOW_MISSED_REASON };
  }
  switch (notice.status) {
    case AutomatedNotificationStatus.SENT:
    case AutomatedNotificationStatus.SUPPRESSED:
    case AutomatedNotificationStatus.FAILED:
    case AutomatedNotificationStatus.DEAD_LETTER:
    case AutomatedNotificationStatus.EXPIRED:
    case AutomatedNotificationStatus.CANCELLED:
      return { action: "proceed" };
    case AutomatedNotificationStatus.SCHEDULED:
      // Defensive: a still-future scheduledFor means the notice window has not
      // opened yet -> wait for it (do not charge before the user is warned).
      if (notice.scheduledFor.getTime() > nowEpoch) {
        return { action: "defer", until: notice.scheduledFor };
      }
    // fall through: SCHEDULED-past behaves like an in-flight delivery.
    // eslint-disable-next-line no-fallthrough
    case AutomatedNotificationStatus.READY:
    case AutomatedNotificationStatus.SENDING:
    default: {
      const cap = expectedChargeAtEpoch + AUTO_RENEWAL_PRECHARGE_GATE_MAX_DEFER_MS;
      if (nowEpoch >= cap) {
        return { action: "proceed", reason: AUTO_RENEWAL_PRECHARGE_DELIVERY_UNCONFIRMED_REASON };
      }
      const until = new Date(Math.min(nowEpoch + AUTO_RENEWAL_PRECHARGE_GATE_STEP_MS, cap));
      return { action: "defer", until };
    }
  }
}

/** PII-free SystemLog for a pre-charge event (never a user/service/mandate id, no
 * balance, no message body). Never throws (a log failure must not affect the scan). */
export async function logPrechargeEvent(
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await writeOpsLog({ level: "INFO", topicKey: "PAYMENT", eventType, message: eventType, metadata });
  } catch (err) {
    log.warn("precharge ops-log failed", { error: errorMessage(err) });
  }
}
