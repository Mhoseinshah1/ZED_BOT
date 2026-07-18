import {
  prisma,
  type Prisma,
  type UserGroup,
} from "@zedbot/database";
import {
  buildCustomerLapseCycleFingerprint,
  classifyPaidServiceForWinback,
  evaluateCustomerWinbackEligibility,
  type CustomerLifecycleSnapshot,
  type PaidServiceView,
  type WinbackConfig,
  type WinbackEligibility,
} from "@zedbot/shared";

import { toFaDigits } from "./rules.js";

// =============================================================================
// Customer win-back ELIGIBILITY loader (Phase 3). Assembles the SAFE
// CustomerLifecycleSnapshot the pure @zedbot/shared resolver consumes, from
// authoritative live rows - the SAME code path for the scan, the delivery
// re-validation and the admin dry-run preview (one resolver, no divergence).
//
// Win-back is a NEGATIVE assertion (the customer has NO usable paid service), so
// it never guesses: a paid service whose panel-backed state is stale becomes
// SERVICE_STATE_UNCERTAIN, a priority sync is enqueued, and the candidate is
// skipped until a later scan re-evaluates it on fresh data. Loaders read only;
// they never mutate a Service / Order / Payment / CheckoutSession / receipt /
// reconciliation row and never read financial truth from a notification snapshot.
// =============================================================================

/** Safe, non-secret display fields the scan renders (no ids, prices, tokens). */
export interface WinbackDisplay {
  inactiveDays: number;
  /** User's own service label (note), safe to show; empty when none. */
  lastServiceName: string;
  /** Latest purchased product name (snapshot), safe to show; empty when none. */
  lastProductName: string;
}

export interface WinbackCandidate {
  userId: string;
  eligibility: WinbackEligibility;
  display: WinbackDisplay;
  lapseCycleFingerprint: string | null;
  /** Panels whose stale service state must be re-synced before re-evaluation. */
  needsSyncPanelIds: string[];
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

/**
 * Loads a cursor page of narrowed candidate users, assembles each snapshot from
 * batch-loaded authoritative rows (no N+1), and evaluates eligibility. Returns
 * every scanned candidate (eligible or not) so the caller can tally exclusions.
 */
export async function loadWinbackCandidatePage(
  config: WinbackConfig,
  now: Date,
  batchSize: number,
  cursor: string | undefined,
): Promise<WinbackCandidate[]> {
  // Query narrowing ONLY (final eligibility is authoritative below): ACTIVE users
  // in an allowed group who have opted into marketing + cron and whose cached
  // paid-order counter suggests a prior purchase.
  const users = (await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      group: { in: config.allowedUserGroups as UserGroup[] },
      marketingMessagesEnabled: true,
      cronNotificationsEnabled: true,
      paidOrdersCount: { gte: config.minimumCompletedPaidOrders },
      ...(cursor !== undefined ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: batchSize,
    select: {
      id: true,
      status: true,
      group: true,
      cronNotificationsEnabled: true,
      marketingMessagesEnabled: true,
    },
  })) as UserRow[];

  if (users.length === 0) {
    return [];
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
    // Paid services (source PAID) — the effective-end evidence.
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
    // Completed paid-Service orders (finalPriceToman > 0) — authoritative history.
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
        completedAt: true,
        createdAt: true,
        id: true,
        productNameSnapshot: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    // Live trial claims (defer).
    prisma.freeTrialClaim.findMany({
      where: { userId: { in: userIds }, status: { in: ["CLAIMED", "PROVISIONING", "ACTIVE", "MANUAL_REVIEW"] } },
      select: { userId: true, status: true },
    }),
    // Trial services still usable / provisioning.
    prisma.service.findMany({
      where: { userId: { in: userIds }, source: "FREE_TRIAL", status: { in: ["ACTIVE", "CREATING", "LIMITED"] } },
      select: { userId: true, status: true },
    }),
    // Resumable pending checkouts (defer).
    prisma.checkoutSession.findMany({
      where: { userId: { in: userIds }, status: "PENDING", expiresAt: { gt: now } },
      select: { userId: true },
    }),
    // Pending-review payments / receipts (defer).
    prisma.payment.findMany({
      where: { userId: { in: userIds }, status: { in: ["PENDING_REVIEW", "PROCESSING"] } },
      select: { userId: true },
    }),
    // Open / in-review financial reconciliation (defer).
    prisma.financialReconciliationCase.findMany({
      where: { userId: { in: userIds }, status: { in: ["OPEN", "IN_REVIEW"] } },
      select: { userId: true },
    }),
    // Orders still converging (defer).
    prisma.order.findMany({
      where: {
        userId: { in: userIds },
        status: { in: UNRESOLVED_ORDER_STATUSES as unknown as Prisma.EnumOrderStatusFilter["in"] },
      },
      select: { userId: true },
    }),
    // Per-user win-back snooze.
    prisma.customerRetentionPreference.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, winbackSnoozedUntil: true },
    }),
    // Existing win-back notifications (for cycle count + sent stages).
    prisma.automatedNotification.findMany({
      where: { userId: { in: userIds }, type: "CUSTOMER_WINBACK" },
      select: { userId: true, dedupeKey: true },
    }),
  ]);

  // --- index the batch rows by userId ---------------------------------------
  const servicesByUser = groupBy(services, (s) => s.userId);
  const ordersByUser = groupBy(completedOrders, (o) => o.userId);
  const trialProvisioningByUser = new Set<string>([
    ...trialClaims
      .filter((t) => t.status === "CLAIMED" || t.status === "PROVISIONING" || t.status === "MANUAL_REVIEW")
      .map((t) => t.userId),
    ...trialServices.filter((s) => s.status === "CREATING").map((s) => s.userId),
  ]);
  const activeTrialByUser = new Set<string>([
    ...trialClaims.filter((t) => t.status === "ACTIVE").map((t) => t.userId),
    ...trialServices.filter((s) => s.status === "ACTIVE" || s.status === "LIMITED").map((s) => s.userId),
  ]);
  const openCheckoutByUser = new Set(openCheckouts.map((c) => c.userId));
  const pendingReceiptByUser = new Set(pendingReceipts.map((p) => p.userId));
  const reconByUser = new Set(reconciliations.map((r) => r.userId));
  const unresolvedOrderByUser = new Set(unresolvedOrders.map((o) => o.userId));
  const snoozeByUser = new Map(retentionPrefs.map((r) => [r.userId, r.winbackSnoozedUntil]));
  const winbackKeysByUser = groupBy(winbackNotifications, (n) => n.userId);

  const candidates: WinbackCandidate[] = [];
  for (const user of users) {
    candidates.push(
      buildCandidate({
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
      }),
    );
  }
  return candidates;
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
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  productNameSnapshot: string | null;
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
  /**
   * Delivery re-validation only asks "is this customer STILL win-back eligible?"
   * - the stage was already chosen at scan time and the notification being
   * delivered is itself in the DB. Zeroing the cycle counters stops it from
   * self-counting as an already-sent stage (which would wrongly read as
   * no-stage-due / max-cycle-reached).
   */
  zeroCycleCounts?: boolean;
}

function buildCandidate(input: BuildInput): WinbackCandidate {
  const { config, now } = input;

  // Classify each paid service; aggregate the booleans + latest effective end.
  let hasUsable = false;
  let hasUncertain = false;
  let hasProvisioning = false;
  let latestEnd: Date | null = null;
  let lastServiceName = "";
  const needsSyncPanelIds = new Set<string>();
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
      if (cls.needsSync && svc.panelId !== null) {
        needsSyncPanelIds.add(svc.panelId);
      }
    } else if (cls.disposition === "LAPSED" && cls.effectiveEnd !== null) {
      if (latestEnd === null || cls.effectiveEnd.getTime() > latestEnd.getTime()) {
        latestEnd = cls.effectiveEnd;
        if (svc.note !== null && svc.note.trim() !== "") {
          lastServiceName = svc.note.trim();
        }
      }
    }
  }

  // Authoritative paying-customer stats: completed SERVICE_PURCHASE count is the
  // anchor; lifetime spend sums all completed paid-Service lifecycle orders.
  const purchaseOrders = input.orders.filter((o) => o.type === "SERVICE_PURCHASE");
  const completedPaidServiceOrderCount = purchaseOrders.length;
  const lifetimePaidServiceSpendToman = input.orders.reduce((sum, o) => sum + o.finalPriceToman, 0);
  const latestPurchase = purchaseOrders.length > 0 ? purchaseOrders[purchaseOrders.length - 1] : null;
  const lastProductName = latestPurchase?.productNameSnapshot?.trim() ?? "";

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

  // The current lapse-cycle fingerprint anchors dedupe. Count only THIS cycle's
  // already-sent stages (a returning customer's old-cycle rows do not count).
  // Delivery re-validation zeroes these (see BuildInput.zeroCycleCounts).
  const fingerprint = buildCustomerLapseCycleFingerprint(snapshot);
  if (fingerprint !== null && input.zeroCycleCounts !== true) {
    const prefix = `user:${input.user.id}:winback:${fingerprint}:`;
    const thisCycle = input.winbackDedupeKeys.filter((k) => k.startsWith(prefix));
    snapshot.existingCycleNotificationCount = thisCycle.length;
    snapshot.sentStageDaysThisCycle = thisCycle
      .map((k) => Number.parseInt(k.slice(prefix.length + 1), 10)) // strip "s"
      .filter((n) => Number.isInteger(n));
  }

  const eligibility = evaluateCustomerWinbackEligibility(snapshot, config, now);
  const inactiveDays = eligibility.eligible
    ? eligibility.inactiveDays
    : latestEnd !== null
      ? Math.max(0, Math.floor((now.getTime() - latestEnd.getTime()) / (24 * 3_600_000)))
      : 0;

  return {
    userId: input.user.id,
    eligibility,
    display: {
      inactiveDays,
      lastServiceName,
      lastProductName,
    },
    lapseCycleFingerprint: fingerprint,
    needsSyncPanelIds: [...needsSyncPanelIds],
  };
}

/** Renders the safe display variables (Persian digits) for the payload. */
export function winbackVariables(display: WinbackDisplay): Record<string, string | number> {
  const vars: Record<string, string | number> = {
    inactive_days: toFaDigits(display.inactiveDays),
  };
  if (display.lastServiceName !== "") {
    vars.last_service_name = display.lastServiceName;
  }
  if (display.lastProductName !== "") {
    vars.last_product_name = display.lastProductName;
  }
  return vars;
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

// --- delivery re-validation --------------------------------------------------

export interface WinbackRevalidation {
  /** Re-evaluated eligibility for the SAME user. */
  eligibility: WinbackEligibility;
  /** The user's CURRENT lapse-cycle fingerprint (null when no longer lapsed). */
  currentFingerprint: string | null;
  /** Panels needing a priority sync when the state is uncertain. */
  needsSyncPanelIds: string[];
}

/**
 * Rebuilds ONE user's lifecycle snapshot for delivery re-validation. The delivery
 * worker compares `currentFingerprint` against the notification's stored
 * fingerprint (a mismatch = the lapse cycle changed => cancel) and inspects the
 * fresh eligibility (a new usable service / opt-out / snooze => cancel/suppress).
 */
export async function revalidateWinbackForDelivery(
  userId: string,
  config: WinbackConfig,
  now: Date,
): Promise<WinbackRevalidation | null> {
  const page = await loadWinbackCandidateForUser(userId, config, now);
  if (page === null) {
    return null;
  }
  return {
    eligibility: page.eligibility,
    currentFingerprint: page.lapseCycleFingerprint,
    needsSyncPanelIds: page.needsSyncPanelIds,
  };
}

/** Single-user variant of the page loader (delivery re-validation). */
async function loadWinbackCandidateForUser(
  userId: string,
  config: WinbackConfig,
  now: Date,
): Promise<WinbackCandidate | null> {
  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      group: true,
      cronNotificationsEnabled: true,
      marketingMessagesEnabled: true,
    },
  })) as UserRow | null;
  if (user === null) {
    return null;
  }
  const [
    services,
    orders,
    trialClaims,
    trialServices,
    openCheckout,
    pendingReceipt,
    recon,
    unresolvedOrder,
    pref,
    winbackKeys,
  ] = await Promise.all([
    prisma.service.findMany({
      where: { userId, source: "PAID" },
      select: {
        userId: true, status: true, source: true, expiresAt: true, deletedAt: true,
        lastSubscriptionUpdateAt: true, panelId: true, orderId: true, note: true,
      },
    }),
    prisma.order.findMany({
      where: {
        userId, status: "COMPLETED",
        type: { in: PAID_SERVICE_ORDER_TYPES as unknown as Prisma.EnumOrderTypeFilter["in"] },
        finalPriceToman: { gt: 0 },
      },
      select: { userId: true, type: true, finalPriceToman: true, completedAt: true, createdAt: true, id: true, productNameSnapshot: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.freeTrialClaim.findMany({
      where: { userId, status: { in: ["CLAIMED", "PROVISIONING", "ACTIVE", "MANUAL_REVIEW"] } },
      select: { userId: true, status: true },
    }),
    prisma.service.findMany({
      where: { userId, source: "FREE_TRIAL", status: { in: ["ACTIVE", "CREATING", "LIMITED"] } },
      select: { userId: true, status: true },
    }),
    prisma.checkoutSession.findFirst({ where: { userId, status: "PENDING", expiresAt: { gt: now } }, select: { userId: true } }),
    prisma.payment.findFirst({ where: { userId, status: { in: ["PENDING_REVIEW", "PROCESSING"] } }, select: { userId: true } }),
    prisma.financialReconciliationCase.findFirst({ where: { userId, status: { in: ["OPEN", "IN_REVIEW"] } }, select: { userId: true } }),
    prisma.order.findFirst({
      where: { userId, status: { in: UNRESOLVED_ORDER_STATUSES as unknown as Prisma.EnumOrderStatusFilter["in"] } },
      select: { userId: true },
    }),
    prisma.customerRetentionPreference.findUnique({ where: { userId }, select: { winbackSnoozedUntil: true } }),
    prisma.automatedNotification.findMany({ where: { userId, type: "CUSTOMER_WINBACK" }, select: { dedupeKey: true } }),
  ]);

  const hasActiveTrial =
    trialClaims.some((t) => t.status === "ACTIVE") ||
    trialServices.some((s) => s.status === "ACTIVE" || s.status === "LIMITED");
  const hasTrialProvisioning =
    trialClaims.some((t) => t.status === "CLAIMED" || t.status === "PROVISIONING" || t.status === "MANUAL_REVIEW") ||
    trialServices.some((s) => s.status === "CREATING");

  return buildCandidate({
    user,
    services: services as ServiceRow[],
    orders: orders as OrderRow[],
    hasActiveTrial,
    hasTrialProvisioning,
    hasResumableCheckout: openCheckout !== null,
    hasPendingReceiptReview: pendingReceipt !== null,
    hasOpenFinancialReconciliation: recon !== null,
    hasUnresolvedProvisioningOrder: unresolvedOrder !== null,
    winbackSnoozedUntil: pref?.winbackSnoozedUntil ?? null,
    winbackDedupeKeys: winbackKeys.map((n) => n.dedupeKey),
    config,
    now,
    zeroCycleCounts: true,
  });
}
