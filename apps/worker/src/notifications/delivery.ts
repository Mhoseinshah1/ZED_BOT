import {
  AutoRenewalFundingMethod,
  AutoRenewalMandateStatus,
  AutomatedNotificationStatus,
  ServiceSource,
  prisma,
  type AutomatedNotification,
} from "@zedbot/database";
import {
  NOTIFICATION_JOB_NAMES,
  buildAutoRenewalCycleFingerprint,
  computeTrafficUsage,
  createLogger,
  evaluateQuietHours,
  expiryCycleFingerprint,
  localMinutesInZone,
  quotaCycleFingerprint,
  resolveAutoRenewalCharge,
  resolveAutoRenewalExpectedChargeAt,
  type NotificationPayloadSnapshot,
  type ServiceNotificationKind,
} from "@zedbot/shared";
import { Worker, type Job, type Queue } from "bullmq";

import { botToken } from "../config.js";
import { sendTelegramMessage } from "../telegram.js";
import {
  revalidateAbandonedForDelivery,
  revalidateFailedPaymentForDelivery,
} from "./checkout-eligibility.js";
import { revalidateWinbackForDelivery } from "./winback-eligibility.js";
import { enqueuePanelSync, type NotificationDeliveryJobData } from "./queues.js";
import {
  loadUserGates,
  resolveEffectiveDeliveryPreferences,
  serviceKindGateOpen,
  userGateOpen,
} from "./preferences.js";
import { renderNotification } from "./render.js";
import { formatNoticeInstant } from "../auto-renewal/precharge-notice.js";
import { isWalletAutoRenewalEnabled } from "../auto-renewal/settings.js";
import {
  getAbandonedCheckoutConfig,
  getFailedPaymentConfig,
  getWinbackConfig,
  isNotificationSystemEnabled,
} from "./settings.js";

// =============================================================================
// Automated-notification DELIVERY (feat/notification-retention-engine, Phase 1).
// Mirrors the log-delivery CAS lifecycle: re-validate EVERYTHING at send time
// (master switch, user + per-service preferences, the source condition that
// justified the notification, quiet hours, the daily cap), claim SCHEDULED ->
// SENDING atomically, render the SAFE snapshot, send with the inline keyboard,
// then SENT / retry / DEAD_LETTER / 429-rate-limit. A notification whose reason
// no longer holds (service renewed, usage reset, user opted out, master switch
// off) is CANCELLED before any message is sent - never a stale alert. The bot
// token lives only in the request URL; every failure collapses to a safe code.
// =============================================================================

const log = createLogger("worker:notif-delivery");

/** Terminal statuses: a delivery job for one of these is a no-op. */
const TERMINAL: AutomatedNotificationStatus[] = [
  AutomatedNotificationStatus.SENT,
  AutomatedNotificationStatus.DEAD_LETTER,
  AutomatedNotificationStatus.CANCELLED,
  AutomatedNotificationStatus.SUPPRESSED,
  AutomatedNotificationStatus.EXPIRED,
];

type Terminal =
  | { kind: "cancel"; reason: string }
  | { kind: "suppress"; reason: string }
  | { kind: "expire"; reason: string };

/** The safe meta the scan stamped for source re-validation. */
interface RevalMeta {
  kind?: string;
  cycle?: string;
  percent?: number;
  trial?: number;
  /** Abandoned-checkout reminder stage (Phase 2). */
  stage?: number;
  /** Win-back stage key, e.g. "s30" (Phase 3). */
  stageKey?: string;
}

/** The minimal live service state delivery re-checks against. */
interface LiveService {
  id: string;
  status: string;
  source: ServiceSource;
  convertedToPaidAt: Date | null;
  volumeBytes: bigint;
  usedBytes: bigint;
  expiresAt: Date | null;
  deletedAt: Date | null;
}

function metaKindToServiceKind(kind: string | undefined): ServiceNotificationKind {
  if (kind === "traffic") {
    return "traffic";
  }
  if (kind === "limited") {
    return "status";
  }
  return "expiry";
}

/**
 * Whether the reason the notification was created STILL holds. A mismatch means
 * the service was renewed / gained volume / had its usage reset / converted /
 * recovered from LIMITED since the scan - the notification is stale and must be
 * cancelled, never sent.
 */
function sourceStillValid(meta: RevalMeta, service: LiveService): boolean {
  if (service.deletedAt !== null) {
    return false;
  }
  const trial = meta.trial === 1;
  if (trial && (service.source !== ServiceSource.FREE_TRIAL || service.convertedToPaidAt !== null)) {
    // The trial converted to paid: trial notices stop.
    return false;
  }
  switch (meta.kind) {
    case "expiry":
    case "expired": {
      if (service.expiresAt === null) {
        return false; // now never-expiring.
      }
      return expiryCycleFingerprint(service.expiresAt) === meta.cycle;
    }
    case "traffic": {
      if (quotaCycleFingerprint(service.volumeBytes, service.expiresAt) !== meta.cycle) {
        return false; // renewed or extra volume -> new quota cycle.
      }
      const usage = computeTrafficUsage(service.usedBytes, service.volumeBytes);
      if (usage.unlimited) {
        return false;
      }
      return typeof meta.percent === "number" ? usage.rawPercent >= meta.percent : true;
    }
    case "limited":
      return service.status === "LIMITED" && expiryCycleFingerprint(service.expiresAt) === meta.cycle;
    default:
      return true;
  }
}

/**
 * Re-validates a checkout/payment reminder against LIVE authoritative financial
 * state at send time (Phase 2). Reuses the SAME shared evaluator as the scan +
 * preview. Returns a cancel decision when the reason no longer holds (settled,
 * order created, receipt pending, reconciliation opened, competing success,
 * expired, suppressed, or the user re-engaged), else null to proceed. NEVER
 * mutates a financial row - read-only.
 */
async function revalidateCheckoutSource(
  notification: { type: string; checkoutSessionId: string | null; paymentId: string | null },
  meta: RevalMeta,
  now: Date,
): Promise<Terminal | null> {
  if (notification.type === "ABANDONED_CHECKOUT") {
    if (notification.checkoutSessionId === null) {
      return { kind: "cancel", reason: "checkout-missing" };
    }
    const config = await getAbandonedCheckoutConfig();
    const stage = typeof meta.stage === "number" ? meta.stage : 1;
    const res = await revalidateAbandonedForDelivery(notification.checkoutSessionId, stage, config, now);
    if (res === null) {
      return { kind: "cancel", reason: "checkout-gone" };
    }
    if (!res.eligibility.eligible) {
      return { kind: "cancel", reason: `checkout-${res.eligibility.reason}` };
    }
    return null;
  }
  // PAYMENT_RETRY
  if (notification.paymentId === null) {
    return { kind: "cancel", reason: "payment-missing" };
  }
  const config = await getFailedPaymentConfig();
  const res = await revalidateFailedPaymentForDelivery(notification.paymentId, config, now);
  if (res === null) {
    return { kind: "cancel", reason: "payment-gone" };
  }
  if (!res.eligibility.eligible) {
    return { kind: "cancel", reason: `payment-${res.eligibility.reason}` };
  }
  return null;
}

/**
 * Re-validates a CUSTOMER_WINBACK (marketing) notification against LIVE state at
 * send time (Phase 3). Reuses the SAME shared resolver as the scan + preview.
 * Returns a terminal decision when it must not send (a new usable service, opt-
 * out, snooze, a changed lapse cycle, or a financial/purchase-in-progress state),
 * "defer" when the service state is UNCERTAIN (re-arm after a priority sync), or
 * null to proceed. Read-only.
 */
async function revalidateWinbackSource(
  notification: { userId: string },
  meta: RevalMeta,
  now: Date,
): Promise<Terminal | { defer: true; panelIds: string[] } | null> {
  const config = await getWinbackConfig();
  const res = await revalidateWinbackForDelivery(notification.userId, config, now);
  if (res === null) {
    return { kind: "cancel", reason: "winback-user-gone" };
  }
  // Uncertain service state defers FIRST (an uncertain service yields no lapse
  // anchor, so the fingerprint would look "changed"): never guess, re-arm.
  if (!res.eligibility.eligible && res.eligibility.reason === "service-uncertain") {
    return { defer: true, panelIds: res.needsSyncPanelIds };
  }
  // A changed lapse cycle (a new purchase / renewal happened) invalidates the
  // notice - the old cycle is finished.
  if (meta.cycle !== undefined && res.currentFingerprint !== meta.cycle) {
    return { kind: "cancel", reason: "winback-cycle-changed" };
  }
  if (res.eligibility.eligible) {
    return null;
  }
  const reason = res.eligibility.reason;
  if (reason === "marketing-opt-out" || reason === "snoozed") {
    return { kind: "suppress", reason: `winback-${reason}` };
  }
  return { kind: "cancel", reason: `winback-${reason}` };
}

/**
 * Re-validates a wallet AUTO_RENEWAL_UPCOMING advance notice against LIVE state at
 * send time (Corrective Phase, Part H). CANCELS a notice whose charge will NOT
 * happen as described (mandate no longer ACTIVE/WALLET, service gone/unlimited,
 * cycle changed, product unavailable, live price above the ceiling); EXPIRES it
 * once the expected charge instant has passed (never notify AFTER the money moved);
 * otherwise returns FRESH variables so the delivered message shows the CURRENT
 * price / ceiling / timestamps, never a stale snapshot amount. Read-only — it never
 * touches money, the mandate or the Attempt. A cancelled/suppressed/expired notice
 * NEVER revokes the mandate: the charge path is independently guarded, not driven,
 * by this notice.
 */
export async function revalidateAutoRenewalUpcomingForDelivery(
  notification: { userId: string; serviceId: string | null },
  meta: RevalMeta,
  now: Date,
): Promise<Terminal | { freshVariables: Record<string, string | number> }> {
  const metaCycle = typeof meta.cycle === "string" ? meta.cycle : "";
  if (notification.serviceId === null) {
    return { kind: "cancel", reason: "auto-renewal-service-missing" };
  }
  const mandate = await prisma.serviceAutoRenewalMandate.findUnique({
    where: { serviceId: notification.serviceId },
  });
  if (mandate === null || mandate.userId !== notification.userId) {
    return { kind: "cancel", reason: "auto-renewal-mandate-gone" };
  }
  if (mandate.status !== AutoRenewalMandateStatus.ACTIVE) {
    // Cancelled/paused mandate -> no upcoming charge -> the notice is stale.
    return { kind: "cancel", reason: "auto-renewal-mandate-inactive" };
  }
  if (mandate.fundingMethod !== AutoRenewalFundingMethod.WALLET) {
    return { kind: "cancel", reason: "auto-renewal-not-wallet" };
  }
  const service = await prisma.service.findUnique({
    where: { id: notification.serviceId },
    select: { expiresAt: true, deletedAt: true, status: true, productNameSnapshot: true },
  });
  if (service === null || service.deletedAt !== null || service.status === "DELETED") {
    return { kind: "cancel", reason: "auto-renewal-service-gone" };
  }
  if (service.expiresAt === null) {
    return { kind: "cancel", reason: "auto-renewal-service-unlimited" };
  }
  const expiresAtEpoch = service.expiresAt.getTime();
  const liveCycle = buildAutoRenewalCycleFingerprint({
    serviceId: notification.serviceId,
    expiresAtEpoch,
    productId: mandate.productId,
  });
  if (liveCycle === null || liveCycle !== metaCycle) {
    // A manual renewal / product change moved the cycle -> never deliver a stale one.
    return { kind: "cancel", reason: "auto-renewal-cycle-changed" };
  }
  const expectedChargeAtEpoch = resolveAutoRenewalExpectedChargeAt({
    expiresAtEpoch,
    chargeLeadMinutes: mandate.chargeLeadMinutes,
  });
  if (expectedChargeAtEpoch !== null && now.getTime() >= expectedChargeAtEpoch) {
    // The charge window has arrived -> an "upcoming" letter is no longer truthful.
    return { kind: "expire", reason: "auto-renewal-charge-window-passed" };
  }
  const product = await prisma.product.findUnique({
    where: { id: mandate.productId },
    include: { category: true, panel: true },
  });
  if (
    product === null ||
    !product.isActive ||
    product.type !== "SERVICE_PRODUCT" ||
    product.category === null ||
    !product.category.isActive ||
    product.panel === null
  ) {
    return { kind: "cancel", reason: "auto-renewal-product-unavailable" };
  }
  const charge = resolveAutoRenewalCharge(product.priceToman, mandate.maximumChargeToman);
  if (!charge.eligible) {
    // The live price now exceeds the ceiling (or is invalid): the charge would pause,
    // so notifying about it would be misleading -> cancel, never weaken the ceiling.
    return { kind: "cancel", reason: `auto-renewal-${charge.reason}` };
  }
  const displayName =
    typeof service.productNameSnapshot === "string" && service.productNameSnapshot.trim() !== ""
      ? service.productNameSnapshot.trim()
      : "سرویس شما";
  return {
    freshVariables: {
      service_name: displayName,
      product_name: product.name,
      current_price: product.priceToman,
      maximum_charge: mandate.maximumChargeToman,
      expected_charge_time: formatNoticeInstant(new Date(expectedChargeAtEpoch ?? now.getTime())),
      service_expiry: formatNoticeInstant(service.expiresAt),
    },
  };
}

async function markTerminal(id: string, decision: Terminal): Promise<void> {
  const now = new Date();
  const status =
    decision.kind === "cancel"
      ? AutomatedNotificationStatus.CANCELLED
      : decision.kind === "suppress"
        ? AutomatedNotificationStatus.SUPPRESSED
        : AutomatedNotificationStatus.EXPIRED;
  await prisma.automatedNotification.updateMany({
    where: { id, status: { notIn: TERMINAL } },
    data: {
      status,
      safeErrorCode: decision.reason,
      cancelledAt: decision.kind === "cancel" ? now : undefined,
      suppressedAt: decision.kind === "suppress" ? now : undefined,
    },
  });
}

/** Re-schedules a not-yet-due notification (quiet hours / daily cap) for later. */
async function deferTo(id: string, when: Date): Promise<void> {
  await prisma.automatedNotification.updateMany({
    where: { id, status: { notIn: TERMINAL } },
    data: { status: AutomatedNotificationStatus.SCHEDULED, scheduledFor: when },
  });
}

/** Count of automated notifications already SENT to the user in their local day. */
async function sentTodayCount(userId: string, now: Date, timezone: string): Promise<number> {
  const localMinutes = localMinutesInZone(now, timezone);
  const dayStart = new Date(now.getTime() - localMinutes * 60_000);
  return prisma.automatedNotification.count({
    where: { userId, status: AutomatedNotificationStatus.SENT, sentAt: { gte: dayStart } },
  });
}

/** Start of the next local day (UTC instant) - where a capped notice waits. */
function nextLocalMidnight(now: Date, timezone: string): Date {
  const localMinutes = localMinutesInZone(now, timezone);
  const minutesToMidnight = 24 * 60 - localMinutes;
  return new Date(now.getTime() + minutesToMidnight * 60_000);
}

export interface NotificationDeliveryDeps {
  deliveryQueue: Queue;
  /** For re-arming a win-back notice whose service state is uncertain (Phase 3). */
  serviceSyncQueue?: Queue;
}

/** How long a win-back notice waits when the service state is uncertain. */
const WINBACK_UNCERTAIN_DEFER_MS = 30 * 60_000;

export function createNotificationDeliveryProcessor(
  deps: NotificationDeliveryDeps,
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job: Job): Promise<Record<string, unknown>> => {
    if (job.name !== NOTIFICATION_JOB_NAMES.DELIVER_AUTOMATED_NOTIFICATION) {
      throw new Error(`unknown job: ${job.name}`);
    }
    const { notificationId } = job.data as NotificationDeliveryJobData;
    const now = new Date();

    const notification = (await prisma.automatedNotification.findUnique({
      where: { id: notificationId },
    })) as AutomatedNotification | null;
    if (notification === null) {
      return { skipped: "missing" };
    }
    if (TERMINAL.includes(notification.status)) {
      return { skipped: "already-terminal", status: notification.status };
    }

    // --- availability window -------------------------------------------------
    if (notification.availableUntil !== null && notification.availableUntil.getTime() <= now.getTime()) {
      await markTerminal(notificationId, { kind: "expire", reason: "window-passed" });
      return { expired: true };
    }

    // --- master switch (fail safe: never deliver while disabled) -------------
    if (!(await isNotificationSystemEnabled())) {
      await markTerminal(notificationId, { kind: "cancel", reason: "system-disabled" });
      return { cancelled: "system-disabled" };
    }

    // --- user category gate --------------------------------------------------
    const gates = await loadUserGates(notification.userId);
    if (gates === null || !userGateOpen(gates, notification.category)) {
      await markTerminal(notificationId, { kind: "cancel", reason: "user-opted-out" });
      return { cancelled: "user-opted-out" };
    }

    const snapshot = notification.payloadSnapshot as unknown as NotificationPayloadSnapshot;
    const meta = (snapshot.meta ?? {}) as RevalMeta;

    // --- per-service gate + source re-validation -----------------------------
    // AUTO_RENEWAL_UPCOMING carries a serviceId (for stale-cycle cleanup + button
    // resolution) but is a PAYMENT-category notice, NOT a service alert — it must
    // NOT be gated by the per-service SERVICE toggles nor by the service-alert
    // source revalidator. Its own branch below revalidates the mandate/price/cycle.
    if (notification.serviceId !== null && notification.type !== "AUTO_RENEWAL_UPCOMING") {
      const service = (await prisma.service.findUnique({
        where: { id: notification.serviceId },
        select: {
          id: true,
          status: true,
          source: true,
          convertedToPaidAt: true,
          volumeBytes: true,
          usedBytes: true,
          expiresAt: true,
          deletedAt: true,
        },
      })) as LiveService | null;
      if (service === null) {
        await markTerminal(notificationId, { kind: "cancel", reason: "service-gone" });
        return { cancelled: "service-gone" };
      }
      const kind = metaKindToServiceKind(meta.kind);
      if (!(await serviceKindGateOpen(gates, service.id, kind))) {
        await markTerminal(notificationId, { kind: "cancel", reason: "service-opted-out" });
        return { cancelled: "service-opted-out" };
      }
      if (!sourceStillValid(meta, service)) {
        await markTerminal(notificationId, { kind: "cancel", reason: "source-stale" });
        return { cancelled: "source-stale" };
      }
    }

    // --- checkout / payment source re-validation (Phase 2) -------------------
    if (notification.type === "ABANDONED_CHECKOUT" || notification.type === "PAYMENT_RETRY") {
      const decision = await revalidateCheckoutSource(notification, meta, now);
      if (decision !== null) {
        await markTerminal(notificationId, decision);
        return { cancelled: decision.reason };
      }
    }

    // --- customer win-back re-validation (Phase 3) ---------------------------
    if (notification.type === "CUSTOMER_WINBACK") {
      const decision = await revalidateWinbackSource(notification, meta, now);
      if (decision !== null && "defer" in decision) {
        // Uncertain service state: enqueue a priority sync (if wired) and re-arm.
        if (deps.serviceSyncQueue !== undefined) {
          for (const panelId of decision.panelIds) {
            await enqueuePanelSync(deps.serviceSyncQueue, panelId);
          }
        }
        await deferTo(notificationId, new Date(now.getTime() + WINBACK_UNCERTAIN_DEFER_MS));
        return { deferred: "winback-uncertain" };
      }
      if (decision !== null) {
        await markTerminal(notificationId, decision);
        return decision.kind === "suppress"
          ? { suppressed: decision.reason }
          : { cancelled: decision.reason };
      }
    }

    // --- Stars subscription re-validation (Phase 2.1) ------------------------
    // Source-state revalidation: cancel a stale PAST_DUE / REQUIRES_ACTION letter
    // when the subscription has since recovered to ACTIVE (a delayed charge
    // settled). The subscription is resolved from the safe snapshot meta short id.
    if (
      notification.type === "STARS_SUBSCRIPTION_PAST_DUE" ||
      notification.type === "STARS_SUBSCRIPTION_REQUIRES_ACTION"
    ) {
      const subShort =
        typeof (meta as { subShort?: unknown }).subShort === "string"
          ? ((meta as { subShort: string }).subShort)
          : "";
      if (subShort !== "") {
        const sub = await prisma.telegramStarsServiceSubscription.findFirst({
          where: { id: { startsWith: subShort }, userId: notification.userId },
          select: { status: true },
        });
        if (sub !== null && sub.status === "ACTIVE") {
          await markTerminal(notificationId, { kind: "cancel", reason: "stars-subscription-recovered" });
          return { cancelled: "stars-subscription-recovered" };
        }
      }
    }

    // --- wallet auto-renewal upcoming re-validation (Corrective Phase) --------
    if (notification.type === "AUTO_RENEWAL_UPCOMING") {
      if (!(await isWalletAutoRenewalEnabled())) {
        // The whole system was disabled after the notice was scheduled -> the charge
        // will not happen, so the "upcoming" letter must not be sent.
        await markTerminal(notificationId, { kind: "cancel", reason: "auto-renewal-disabled" });
        return { cancelled: "auto-renewal-disabled" };
      }
      const decision = await revalidateAutoRenewalUpcomingForDelivery(notification, meta, now);
      if ("kind" in decision) {
        await markTerminal(notificationId, decision);
        return decision.kind === "suppress"
          ? { suppressed: decision.reason }
          : decision.kind === "expire"
            ? { expired: decision.reason }
            : { cancelled: decision.reason };
      }
      // Re-render with the LIVE price / ceiling / timestamps — never a stale amount.
      snapshot.variables = { ...snapshot.variables, ...decision.freshVariables };
    }

    // --- quiet hours + daily cap (delivery-time concerns) --------------------
    const prefs = await resolveEffectiveDeliveryPreferences(notification.userId);
    const quiet = evaluateQuietHours(now, prefs.quietHours, prefs.timezone);
    if (quiet.quiet && quiet.nextAllowedAt !== null) {
      if (
        notification.availableUntil !== null &&
        notification.availableUntil.getTime() <= quiet.nextAllowedAt.getTime()
      ) {
        // The quiet window outlasts the notice's usefulness -> drop it.
        await markTerminal(notificationId, { kind: "suppress", reason: "quiet-hours-window" });
        return { suppressed: "quiet-hours-window" };
      }
      await deferTo(notificationId, quiet.nextAllowedAt);
      return { deferred: "quiet-hours" };
    }

    const sentToday = await sentTodayCount(notification.userId, now, prefs.timezone);
    if (sentToday >= prefs.dailyLimit) {
      const when = nextLocalMidnight(now, prefs.timezone);
      if (notification.availableUntil !== null && notification.availableUntil.getTime() <= when.getTime()) {
        await markTerminal(notificationId, { kind: "suppress", reason: "daily-limit" });
        return { suppressed: "daily-limit" };
      }
      await deferTo(notificationId, when);
      return { deferred: "daily-limit" };
    }

    // --- CAS claim: SCHEDULED/READY/SENDING/FAILED -> SENDING ----------------
    const claimed = await prisma.automatedNotification.updateMany({
      where: {
        id: notificationId,
        status: {
          in: [
            AutomatedNotificationStatus.SCHEDULED,
            AutomatedNotificationStatus.READY,
            AutomatedNotificationStatus.SENDING,
            AutomatedNotificationStatus.FAILED,
          ],
        },
      },
      data: { status: AutomatedNotificationStatus.SENDING, claimedAt: now },
    });
    if (claimed.count === 0) {
      return { skipped: "cas-lost" };
    }

    // --- destination + token -------------------------------------------------
    const token = botToken();
    if (token === null) {
      await prisma.automatedNotification.update({
        where: { id: notificationId },
        data: { status: AutomatedNotificationStatus.SCHEDULED, safeErrorCode: "bot-token-missing" },
      });
      return { skipped: "bot-token-missing" };
    }
    const chatId = await resolveChatId(notification.userId);
    if (chatId === null) {
      await markTerminal(notificationId, { kind: "cancel", reason: "no-telegram-id" });
      return { cancelled: "no-telegram-id" };
    }

    // --- render + send -------------------------------------------------------
    const rendered = await renderNotification(snapshot, notification.id.slice(0, 8));
    const result = await sendTelegramMessage({
      token,
      chatId,
      text: rendered.text,
      replyMarkup: rendered.replyMarkup,
    });

    if (result.ok) {
      await prisma.automatedNotification.update({
        where: { id: notificationId },
        data: {
          status: AutomatedNotificationStatus.SENT,
          telegramMessageId: result.messageId,
          sentAt: new Date(),
          attempts: notification.attempts + 1,
          safeErrorCode: null,
        },
      });
      return { sent: true };
    }

    // --- failure bookkeeping -------------------------------------------------
    const attempts = notification.attempts + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= maxAttempts;

    if (result.safeErrorCode === "rate-limited" && !finalAttempt) {
      // 429: pause the whole limiter-enabled queue and requeue WITHOUT
      // consuming an attempt. Roll the status back to SCHEDULED so the retry's
      // CAS claim succeeds.
      await prisma.automatedNotification.update({
        where: { id: notificationId },
        data: { status: AutomatedNotificationStatus.SCHEDULED, safeErrorCode: "rate-limited" },
      });
      await deps.deliveryQueue.rateLimit(result.retryAfterMs ?? 5_000);
      throw Worker.RateLimitError();
    }

    if (!result.retryable || finalAttempt) {
      await prisma.automatedNotification.update({
        where: { id: notificationId },
        data: {
          status: AutomatedNotificationStatus.DEAD_LETTER,
          attempts,
          safeErrorCode: result.safeErrorCode,
          failedAt: new Date(),
        },
      });
      log.warn("notification dead-lettered", {
        notif: notificationId.slice(0, 8),
        code: result.safeErrorCode,
        attempts,
      });
      return { deadLetter: result.safeErrorCode };
    }

    // Transient: mark FAILED and re-throw so BullMQ retries with backoff.
    await prisma.automatedNotification.update({
      where: { id: notificationId },
      data: {
        status: AutomatedNotificationStatus.FAILED,
        attempts,
        safeErrorCode: result.safeErrorCode,
        failedAt: new Date(),
      },
    });
    log.warn("notification delivery failed", {
      notif: notificationId.slice(0, 8),
      code: result.safeErrorCode,
      attempts,
    });
    throw new Error(`notification delivery failed: ${result.safeErrorCode}`);
  };
}

/** Resolves the user's Telegram chat id (their telegramId). Null when unknown. */
async function resolveChatId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true },
  });
  return user === null ? null : user.telegramId.toString();
}
