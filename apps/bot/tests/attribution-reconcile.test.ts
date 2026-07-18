import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  prisma,
  type Order,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import {
  NOTIF_ANALYTICS_ENABLED_KEY,
  NOTIF_ANALYTICS_STARTED_AT_KEY,
} from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "attribution-reconcile-tests-secret-0123456789";

import {
  reconcileOrderAttribution,
  runAttributionBatch,
  runAttributionCleanup,
  runAttributionReversals,
} from "../../worker/src/notifications/attribution.js";

// =============================================================================
// Evidence-based conversion attribution against a REAL DB. Verifies the worker
// reconciler writes exactly one attribution per completed Order backed by a
// recorded click, is idempotent, honours the analytics-start gate, reverses on
// refund, sweeps completions the hook missed, and prunes past retention.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setAnalytics(on: boolean, startedAt: Date | null): Promise<void> {
  await prisma.setting.upsert({
    where: { key: NOTIF_ANALYTICS_ENABLED_KEY },
    create: { key: NOTIF_ANALYTICS_ENABLED_KEY, value: on ? "true" : "false", type: "BOOLEAN" },
    update: { value: on ? "true" : "false" },
  });
  if (startedAt === null) {
    await prisma.setting.deleteMany({ where: { key: NOTIF_ANALYTICS_STARTED_AT_KEY } });
  } else {
    await prisma.setting.upsert({
      where: { key: NOTIF_ANALYTICS_STARTED_AT_KEY },
      create: { key: NOTIF_ANALYTICS_STARTED_AT_KEY, value: startedAt.toISOString(), type: "STRING" },
      update: { value: startedAt.toISOString() },
    });
  }
  // The worker settings reader has no cache; nothing else to clear.
}

d("notification conversion attribution — reconciler", () => {
  let seq = 0;
  let panel: Panel;

  beforeEach(async () => {
    seq += 1;
    if (seq === 1) {
      panel = await prisma.panel.create({
        data: { type: "MARZBAN", name: `attr-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
      });
    }
    // Default: analytics on, started well before any fixture.
    await setAnalytics(true, new Date(Date.now() - 30 * DAY));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser(): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F" },
    });
  }

  async function makeService(user: User): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id, panelId: panel.id, panelType: "MARZBAN", username: `attr-svc-${runTag}-${seq}`,
        source: "PAID", status: "ACTIVE", lastSubscriptionUpdateAt: new Date(),
      },
    });
  }

  /** A SENT notification with a recorded click. Timestamps are backdated so
   * sentAt < interactionAt < order.completedAt. Returns the interaction id. */
  async function makeSentClick(opts: {
    user: User;
    type: "SERVICE_EXPIRY" | "ABANDONED_CHECKOUT" | "CUSTOMER_WINBACK";
    category: AutomatedNotificationCategory;
    interactionType: "RENEW_SERVICE" | "CONTINUE_CHECKOUT" | "VIEW_PRODUCTS";
    serviceId?: string | null;
    checkoutSessionId?: string | null;
    sentAt: Date;
    clickAt: Date;
  }): Promise<{ notificationId: string; interactionId: string }> {
    seq += 1;
    const notif = await prisma.automatedNotification.create({
      data: {
        type: opts.type,
        category: opts.category,
        status: AutomatedNotificationStatus.SENT,
        userId: opts.user.id,
        serviceId: opts.serviceId ?? null,
        checkoutSessionId: opts.checkoutSessionId ?? null,
        dedupeKey: `attr-${runTag}-${seq}`,
        scheduledFor: opts.sentAt,
        sentAt: opts.sentAt,
        payloadSnapshot: {},
      },
      select: { id: true },
    });
    const interaction = await prisma.notificationInteraction.create({
      data: {
        notificationId: notif.id,
        userId: opts.user.id,
        type: opts.interactionType,
        createdAt: opts.clickAt,
      },
      select: { id: true },
    });
    return { notificationId: notif.id, interactionId: interaction.id };
  }

  async function makeCompletedOrder(opts: {
    user: User;
    type: "SERVICE_RENEWAL" | "SERVICE_PURCHASE";
    serviceId?: string | null;
    checkoutSessionId?: string | null;
    finalPriceToman?: number;
    completedAt: Date;
  }): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: {
        userId: opts.user.id,
        type: opts.type,
        status: "COMPLETED",
        serviceId: opts.serviceId ?? null,
        checkoutSessionId: opts.checkoutSessionId ?? null,
        finalPriceToman: opts.finalPriceToman ?? 150000,
        completedAt: opts.completedAt,
      },
    });
  }

  async function attributionFor(orderId: string) {
    return prisma.notificationConversionAttribution.findUnique({ where: { orderId } });
  }

  it("attributes a renewal to its same-service expiry-notice click (DIRECT_SERVICE)", async () => {
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, finalPriceToman: 150000,
      completedAt: new Date(Date.now() - 1 * HOUR),
    });
    const outcome = await reconcileOrderAttribution(order.id);
    expect(outcome).toMatchObject({ status: "attributed", kind: "DIRECT_SERVICE" });
    const row = await attributionFor(order.id);
    expect(row).not.toBeNull();
    expect(row?.grossRevenueToman).toBe(150000);
    expect(row?.netRevenueToman).toBe(150000);
    expect(row?.status).toBe("ACTIVE");
  });

  it("is idempotent — a second reconcile creates no duplicate", async () => {
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, completedAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(await reconcileOrderAttribution(order.id)).toMatchObject({ status: "attributed" });
    expect(await reconcileOrderAttribution(order.id)).toMatchObject({ status: "already-attributed" });
    const rows = await prisma.notificationConversionAttribution.count({ where: { orderId: order.id } });
    expect(rows).toBe(1);
  });

  it("attributes nothing when the order completed before analytics started (no backfill)", async () => {
    await setAnalytics(true, new Date(Date.now() - 30 * MINUTE()));
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, completedAt: new Date(Date.now() - 2 * HOUR),
    });
    expect(await reconcileOrderAttribution(order.id)).toMatchObject({
      status: "skipped",
      reason: "before-analytics-start",
    });
    expect(await attributionFor(order.id)).toBeNull();
  });

  it("no-ops when analytics is disabled", async () => {
    await setAnalytics(false, new Date(Date.now() - 30 * DAY));
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, completedAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(await reconcileOrderAttribution(order.id)).toMatchObject({
      status: "skipped",
      reason: "analytics-disabled",
    });
    expect(await attributionFor(order.id)).toBeNull();
  });

  it("reverses an attribution when the order gains a refund wallet transaction", async () => {
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, finalPriceToman: 200000,
      completedAt: new Date(Date.now() - 1 * HOUR),
    });
    await reconcileOrderAttribution(order.id);
    // A refund is signalled by a REFUND WalletTransaction on the order.
    await prisma.walletTransaction.create({
      data: {
        userId: user.id, amountToman: 200000, type: "REFUND", source: "SYSTEM",
        relatedOrderId: order.id, balanceBeforeToman: 0, balanceAfterToman: 200000,
      },
    });
    const res = await runAttributionReversals();
    expect(res.reversed).toBeGreaterThanOrEqual(1);
    const row = await attributionFor(order.id);
    expect(row?.status).toBe("REVERSED");
    expect(row?.reversedRevenueToman).toBe(200000);
    expect(row?.netRevenueToman).toBe(0);
    expect(row?.reversedAt).not.toBeNull();
    // Idempotent: a second reversal sweep does not re-stamp.
    const before = row?.reversedAt;
    await runAttributionReversals();
    const again = await attributionFor(order.id);
    expect(again?.reversedAt?.getTime()).toBe(before?.getTime());
  });

  it("batch sweep attributes a completed order the hook never saw", async () => {
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, completedAt: new Date(Date.now() - 1 * HOUR),
    });
    const result = await runAttributionBatch();
    expect(result.attributed).toBeGreaterThanOrEqual(1);
    expect(await attributionFor(order.id)).not.toBeNull();
  });

  it("cleanup prunes attributions whose order completed past retention", async () => {
    const user = await makeUser();
    const svc = await makeService(user);
    await makeSentClick({
      user, type: "SERVICE_EXPIRY", category: AutomatedNotificationCategory.SERVICE,
      interactionType: "RENEW_SERVICE", serviceId: svc.id,
      sentAt: new Date(Date.now() - 5 * HOUR), clickAt: new Date(Date.now() - 4 * HOUR),
    });
    const order = await makeCompletedOrder({
      user, type: "SERVICE_RENEWAL", serviceId: svc.id, completedAt: new Date(Date.now() - 1 * HOUR),
    });
    await reconcileOrderAttribution(order.id);
    // Backdate the attribution's orderCompletedAt far past the default retention.
    await prisma.notificationConversionAttribution.update({
      where: { orderId: order.id },
      data: { orderCompletedAt: new Date(Date.now() - 5000 * DAY) },
    });
    const res = await runAttributionCleanup();
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await attributionFor(order.id)).toBeNull();
  });
});

function MINUTE(): number {
  return 60_000;
}
