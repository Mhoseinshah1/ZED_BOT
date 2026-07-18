import {
  AutomatedNotificationStatus,
  Prisma,
  prisma,
  type UserGroup,
} from "@zedbot/database";
import {
  buildCustomerLapseCycleFingerprint,
  classifyPaidServiceForWinback,
  evaluateCustomerWinbackEligibility,
  type CustomerLifecycleSnapshot,
  type PaidServiceView,
  type WinbackConfig,
  type WinbackExclusionReason,
} from "@zedbot/shared";

import { getWinbackConfig } from "./notification/notification-settings.service.js";

// =============================================================================
// Customer win-back BOT service (Phase 3). It owns the user-driven state changes
// the win-back notification buttons trigger, plus the admin dry-run audience
// preview. Mirrors the Phase-2 checkout-notification service exactly:
//   1. snoozeWinback     - a temporary, idempotent stamp on the user's
//      CustomerRetentionPreference (win-back ONLY; never marketing/service prefs).
//   2. optOutMarketing   - flips User.marketingMessagesEnabled off (idempotent)
//      and suppresses the user's pending CUSTOMER_WINBACK rows.
//   3. suppressPendingWinback - the shared "stop future sends" primitive.
//   4. previewWinbackAudience - a read-only dry-run that mirrors the worker scan's
//      WHERE filters, assembles the SAME safe CustomerLifecycleSnapshot and calls
//      the SAME pure @zedbot/shared evaluator, so the admin estimate can never
//      diverge from what the worker would schedule. Creates NO rows, enqueues
//      nothing, writes nothing.
// Every path reads only authoritative rows; none reads financial truth from a
// notification snapshot, and none touches a Service / Order / Payment / receipt.
// =============================================================================

const DAY_MS = 24 * 3_600_000;

// --- snooze ------------------------------------------------------------------

/**
 * Temporarily pauses win-back reminders for `snoozeDays` days, stamping the
 * CustomerRetentionPreference row (win-back ONLY; marketingMessagesEnabled and
 * every other preference are left untouched). Idempotent: a repeated snooze from
 * the SAME notification whose window is still in the future is a no-op (it never
 * extends the window), so a callback retry cannot keep pushing the date out.
 */
export async function snoozeWinback(
  userId: string,
  snoozeDays: number,
  notificationId: string,
): Promise<void> {
  const now = new Date();
  const existing = await prisma.customerRetentionPreference.findUnique({
    where: { userId },
    select: { winbackSnoozedUntil: true, lastSnoozedByNotificationId: true },
  });
  if (
    existing !== null &&
    existing.lastSnoozedByNotificationId === notificationId &&
    existing.winbackSnoozedUntil !== null &&
    existing.winbackSnoozedUntil.getTime() > now.getTime()
  ) {
    return; // same notification, window still active -> do not extend.
  }
  const snoozedUntil = new Date(now.getTime() + snoozeDays * DAY_MS);
  try {
    await prisma.customerRetentionPreference.upsert({
      where: { userId },
      create: {
        userId,
        winbackSnoozedUntil: snoozedUntil,
        lastSnoozedByNotificationId: notificationId,
      },
      update: {
        winbackSnoozedUntil: snoozedUntil,
        lastSnoozedByNotificationId: notificationId,
      },
    });
  } catch (err) {
    // A concurrent first-write won the unique userId; apply as an update.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.customerRetentionPreference.update({
        where: { userId },
        data: {
          winbackSnoozedUntil: snoozedUntil,
          lastSnoozedByNotificationId: notificationId,
        },
      });
      return;
    }
    throw err;
  }
}

/** The user's active win-back snooze end (null when none, or already elapsed). */
export async function getActiveWinbackSnooze(userId: string): Promise<Date | null> {
  const pref = await prisma.customerRetentionPreference.findUnique({
    where: { userId },
    select: { winbackSnoozedUntil: true },
  });
  const until = pref?.winbackSnoozedUntil ?? null;
  if (until === null || until.getTime() <= Date.now()) {
    return null;
  }
  return until;
}

/**
 * Clears the user's win-back snooze (the «لغو توقف موقت» settings button).
 * Touches ONLY winbackSnoozedUntil; updateMany is a no-op when no row exists.
 */
export async function clearWinbackSnooze(userId: string): Promise<void> {
  await prisma.customerRetentionPreference.updateMany({
    where: { userId },
    data: { winbackSnoozedUntil: null },
  });
}

// --- opt-out + suppression ---------------------------------------------------

/**
 * Permanent marketing opt-out (the «عدم دریافت پیشنهادها» button). Flips ONLY
 * User.marketingMessagesEnabled (idempotent) and suppresses the user's pending
 * win-back rows so nothing already scheduled is delivered. Never touches the
 * service / payment / support preferences.
 */
export async function optOutMarketing(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { marketingMessagesEnabled: false },
  });
  await suppressPendingWinback(userId, "winback-opt-out");
}

/** Statuses that are already terminal (never re-suppressed). */
const WINBACK_TERMINAL_STATUSES = [
  AutomatedNotificationStatus.SENT,
  AutomatedNotificationStatus.DEAD_LETTER,
  AutomatedNotificationStatus.CANCELLED,
  AutomatedNotificationStatus.SUPPRESSED,
  AutomatedNotificationStatus.EXPIRED,
] as const;

/**
 * Suppresses this user's still-pending CUSTOMER_WINBACK notifications (SCHEDULED
 * / READY / SENDING / FAILED). Idempotent: already-terminal rows are excluded, so
 * a repeat call updates nothing. Never a delivery, never a financial mutation.
 */
export async function suppressPendingWinback(userId: string, reason: string): Promise<void> {
  await prisma.automatedNotification.updateMany({
    where: {
      userId,
      type: "CUSTOMER_WINBACK",
      status: { notIn: [...WINBACK_TERMINAL_STATUSES] },
    },
    data: {
      status: AutomatedNotificationStatus.SUPPRESSED,
      safeErrorCode: reason,
      suppressedAt: new Date(),
    },
  });
}

// --- dry-run audience preview ------------------------------------------------

/** Hard bound on a single preview sweep; counts above it are labelled تخمینی. */
const PREVIEW_LIMIT = 2000;

export interface WinbackAudiencePreview {
  scanned: number;
  eligible: number;
  perStage: Record<string, number>;
  capped: boolean;
  exclusions: Partial<Record<WinbackExclusionReason, number>>;
}

/** Paid-service order types that count toward "previous paying customer" spend. */
const PAID_SERVICE_ORDER_TYPES = [
  "SERVICE_PURCHASE",
  "SERVICE_RENEWAL",
  "EXTRA_VOLUME",
  "EXTRA_TIME",
  "LOCATION_CHANGE",
] as const;

/** Order statuses that mean "still converging" (defer win-back). */
const UNRESOLVED_ORDER_STATUSES = ["PENDING_REVIEW", "PROVISIONING"] as const;

interface UserRow {
  id: string;
  status: string;
  group: string;
  cronNotificationsEnabled: boolean;
  marketingMessagesEnabled: boolean;
}

interface ServiceRow {
  userId: string;
  status: string;
  source: string;
  expiresAt: Date | null;
  deletedAt: Date | null;
  lastSubscriptionUpdateAt: Date | null;
  panelId: string | null;
  orderId: string | null;
  note: string | null;
}

interface OrderRow {
  userId: string;
  type: string;
  finalPriceToman: number;
  createdAt: Date;
  id: string;
  productNameSnapshot: string | null;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr === undefined) {
      map.set(k, [item]);
    } else {
      arr.push(item);
    }
  }
  return map;
}

interface BuildInput {
  user: UserRow;
  services: ServiceRow[];
  orders: OrderRow[];
  hasActiveTrial: boolean;
  hasTrialProvisioning: boolean;
  hasResumableCheckout: boolean;
  hasPendingReceiptReview: boolean;
  hasOpenFinancialReconciliation: boolean;
  hasUnresolvedProvisioningOrder: boolean;
  winbackSnoozedUntil: Date | null;
  winbackDedupeKeys: string[];
  config: WinbackConfig;
  now: Date;
}

/**
 * Rebuilds ONE user's lifecycle snapshot exactly as the worker loader does
 * (apps/worker/src/notifications/winback-eligibility.ts) and returns the shared
 * evaluator's verdict. Kept structurally identical so the preview tally cannot
 * diverge from the scan.
 */
function evaluateCandidate(input: BuildInput): ReturnType<typeof evaluateCustomerWinbackEligibility> {
  const { config, now } = input;

  let hasUsable = false;
  let hasUncertain = false;
  let hasProvisioning = false;
  let latestEnd: Date | null = null;
  for (const svc of input.services) {
    const view: PaidServiceView = {
      status: svc.status,
      source: svc.source,
      expiresAt: svc.expiresAt,
      deletedAt: svc.deletedAt,
      lastSubscriptionUpdateAt: svc.lastSubscriptionUpdateAt,
      panelBacked: svc.panelId !== null,
      financiallySettled: svc.orderId !== null,
    };
    const cls = classifyPaidServiceForWinback(view, config.serviceStateMaxAgeMinutes, now);
    if (cls.disposition === "USABLE") {
      hasUsable = true;
    } else if (cls.disposition === "PROVISIONING") {
      hasProvisioning = true;
    } else if (cls.disposition === "UNCERTAIN") {
      hasUncertain = true;
    } else if (cls.disposition === "LAPSED" && cls.effectiveEnd !== null) {
      if (latestEnd === null || cls.effectiveEnd.getTime() > latestEnd.getTime()) {
        latestEnd = cls.effectiveEnd;
      }
    }
  }

  const purchaseOrders = input.orders.filter((o) => o.type === "SERVICE_PURCHASE");
  const completedPaidServiceOrderCount = purchaseOrders.length;
  const lifetimePaidServiceSpendToman = input.orders.reduce((sum, o) => sum + o.finalPriceToman, 0);
  const latestPurchase =
    purchaseOrders.length > 0 ? purchaseOrders[purchaseOrders.length - 1] : null;

  const snapshot: CustomerLifecycleSnapshot = {
    userStatus: input.user.status,
    userGroup: input.user.group,
    cronNotificationsEnabled: input.user.cronNotificationsEnabled,
    marketingMessagesEnabled: input.user.marketingMessagesEnabled,
    completedPaidServiceOrderCount,
    lifetimePaidServiceSpendToman,
    hasUsablePaidService: hasUsable,
    hasUncertainPaidService: hasUncertain,
    hasProvisioningService: hasProvisioning,
    latestPaidServiceEffectiveEndAt: latestEnd,
    latestCompletedPaidServiceOrderId: latestPurchase?.id ?? null,
    hasActiveTrial: input.hasActiveTrial,
    hasTrialProvisioning: input.hasTrialProvisioning,
    hasResumableCheckout: input.hasResumableCheckout,
    hasPendingReceiptReview: input.hasPendingReceiptReview,
    hasOpenFinancialReconciliation: input.hasOpenFinancialReconciliation,
    hasUnresolvedProvisioningOrder: input.hasUnresolvedProvisioningOrder,
    winbackSnoozedUntil: input.winbackSnoozedUntil,
    existingCycleNotificationCount: 0,
    sentStageDaysThisCycle: [],
  };

  const fingerprint = buildCustomerLapseCycleFingerprint(snapshot);
  if (fingerprint !== null) {
    const prefix = `user:${input.user.id}:winback:${fingerprint}:`;
    const thisCycle = input.winbackDedupeKeys.filter((k) => k.startsWith(prefix));
    snapshot.existingCycleNotificationCount = thisCycle.length;
    snapshot.sentStageDaysThisCycle = thisCycle
      .map((k) => Number.parseInt(k.slice(prefix.length + 1), 10)) // strip "s"
      .filter((n) => Number.isInteger(n));
  }

  return evaluateCustomerWinbackEligibility(snapshot, config, now);
}

/**
 * Read-only dry-run of the win-back audience. Mirrors the worker scan's narrowing
 * WHERE filters, batch-loads the SAME authoritative rows, assembles the SAME
 * snapshot and calls the SAME shared evaluator, tallying eligible + per-stage +
 * each exclusion reason. Bounded to PREVIEW_LIMIT users (capped=true when hit).
 * No writes, no enqueues, no rows created.
 */
export async function previewWinbackAudience(): Promise<WinbackAudiencePreview> {
  const config = await getWinbackConfig();
  const now = new Date();

  const users = (await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      group: { in: config.allowedUserGroups as UserGroup[] },
      marketingMessagesEnabled: true,
      cronNotificationsEnabled: true,
      paidOrdersCount: { gte: config.minimumCompletedPaidOrders },
    },
    orderBy: { id: "asc" },
    take: PREVIEW_LIMIT,
    select: {
      id: true,
      status: true,
      group: true,
      cronNotificationsEnabled: true,
      marketingMessagesEnabled: true,
    },
  })) as UserRow[];

  const preview: WinbackAudiencePreview = {
    scanned: users.length,
    eligible: 0,
    perStage: {},
    capped: users.length >= PREVIEW_LIMIT,
    exclusions: {},
  };
  if (users.length === 0) {
    return preview;
  }
  const userIds = users.map((u) => u.id);

  const [
    services,
    completedOrders,
    trialClaims,
    trialServices,
    openCheckouts,
    pendingReceipts,
    reconciliations,
    unresolvedOrders,
    retentionPrefs,
    winbackNotifications,
  ] = await Promise.all([
    prisma.service.findMany({
      where: { userId: { in: userIds }, source: "PAID" },
      select: {
        userId: true,
        status: true,
        source: true,
        expiresAt: true,
        deletedAt: true,
        lastSubscriptionUpdateAt: true,
        panelId: true,
        orderId: true,
        note: true,
      },
    }),
    prisma.order.findMany({
      where: {
        userId: { in: userIds },
        status: "COMPLETED",
        type: { in: PAID_SERVICE_ORDER_TYPES as unknown as Prisma.EnumOrderTypeFilter["in"] },
        finalPriceToman: { gt: 0 },
      },
      select: {
        userId: true,
        type: true,
        finalPriceToman: true,
        createdAt: true,
        id: true,
        productNameSnapshot: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.freeTrialClaim.findMany({
      where: {
        userId: { in: userIds },
        status: { in: ["CLAIMED", "PROVISIONING", "ACTIVE", "MANUAL_REVIEW"] },
      },
      select: { userId: true, status: true },
    }),
    prisma.service.findMany({
      where: {
        userId: { in: userIds },
        source: "FREE_TRIAL",
        status: { in: ["ACTIVE", "CREATING", "LIMITED"] },
      },
      select: { userId: true, status: true },
    }),
    prisma.checkoutSession.findMany({
      where: { userId: { in: userIds }, status: "PENDING", expiresAt: { gt: now } },
      select: { userId: true },
    }),
    prisma.payment.findMany({
      where: { userId: { in: userIds }, status: { in: ["PENDING_REVIEW", "PROCESSING"] } },
      select: { userId: true },
    }),
    prisma.financialReconciliationCase.findMany({
      where: { userId: { in: userIds }, status: { in: ["OPEN", "IN_REVIEW"] } },
      select: { userId: true },
    }),
    prisma.order.findMany({
      where: {
        userId: { in: userIds },
        status: {
          in: UNRESOLVED_ORDER_STATUSES as unknown as Prisma.EnumOrderStatusFilter["in"],
        },
      },
      select: { userId: true },
    }),
    prisma.customerRetentionPreference.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, winbackSnoozedUntil: true },
    }),
    prisma.automatedNotification.findMany({
      where: { userId: { in: userIds }, type: "CUSTOMER_WINBACK" },
      select: { userId: true, dedupeKey: true },
    }),
  ]);

  const servicesByUser = groupBy(services as ServiceRow[], (s) => s.userId);
  const ordersByUser = groupBy(completedOrders as OrderRow[], (o) => o.userId);
  const trialProvisioningByUser = new Set<string>([
    ...trialClaims
      .filter(
        (t) => t.status === "CLAIMED" || t.status === "PROVISIONING" || t.status === "MANUAL_REVIEW",
      )
      .map((t) => t.userId),
    ...trialServices.filter((s) => s.status === "CREATING").map((s) => s.userId),
  ]);
  const activeTrialByUser = new Set<string>([
    ...trialClaims.filter((t) => t.status === "ACTIVE").map((t) => t.userId),
    ...trialServices
      .filter((s) => s.status === "ACTIVE" || s.status === "LIMITED")
      .map((s) => s.userId),
  ]);
  const openCheckoutByUser = new Set(openCheckouts.map((c) => c.userId));
  const pendingReceiptByUser = new Set(pendingReceipts.map((p) => p.userId));
  const reconByUser = new Set(reconciliations.map((r) => r.userId));
  const unresolvedOrderByUser = new Set(unresolvedOrders.map((o) => o.userId));
  const snoozeByUser = new Map(retentionPrefs.map((r) => [r.userId, r.winbackSnoozedUntil]));
  const winbackKeysByUser = groupBy(winbackNotifications, (n) => n.userId);

  for (const user of users) {
    const eligibility = evaluateCandidate({
      user,
      services: servicesByUser.get(user.id) ?? [],
      orders: ordersByUser.get(user.id) ?? [],
      hasActiveTrial: activeTrialByUser.has(user.id),
      hasTrialProvisioning: trialProvisioningByUser.has(user.id),
      hasResumableCheckout: openCheckoutByUser.has(user.id),
      hasPendingReceiptReview: pendingReceiptByUser.has(user.id),
      hasOpenFinancialReconciliation: reconByUser.has(user.id),
      hasUnresolvedProvisioningOrder: unresolvedOrderByUser.has(user.id),
      winbackSnoozedUntil: snoozeByUser.get(user.id) ?? null,
      winbackDedupeKeys: (winbackKeysByUser.get(user.id) ?? []).map((n) => n.dedupeKey),
      config,
      now,
    });
    if (eligibility.eligible) {
      preview.eligible += 1;
      const key = String(eligibility.stageDays);
      preview.perStage[key] = (preview.perStage[key] ?? 0) + 1;
    } else {
      preview.exclusions[eligibility.reason] = (preview.exclusions[eligibility.reason] ?? 0) + 1;
    }
  }
  return preview;
}
