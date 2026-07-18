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
  NOTIFICATION_JOB_NAMES,
  buildCustomerLapseCycleFingerprint,
  buildCustomerWinbackDedupeKey,
  type CustomerLifecycleSnapshot,
} from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "winback-delivery-tests-secret-0123456789";
process.env.BOT_TOKEN = "333444:winback-delivery-token";

import { createNotificationDeliveryProcessor } from "../../worker/src/notifications/delivery.js";

// =============================================================================
// Customer win-back DELIVERY re-validation (real DB, fake Telegram). The delivery
// worker reloads authoritative live state and CANCELS/SUPPRESSES a stale
// marketing notice before sending: a new usable service, a changed lapse cycle
// (renewal / new purchase), marketing opt-out, snooze, a new checkout /
// reconciliation, or a customer no longer paying. Plus the happy path, the
// uncertain-service defer, CAS single-send, and a no-secret-leak check.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 24 * 3_600_000;

let sentBodies: Array<Record<string, unknown>>;
function installFetchStub(): void {
  sentBodies = [];
  global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    sentBodies.push(init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 88 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function setEnabled(on: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "automated_notifications_enabled" },
    create: { key: "automated_notifications_enabled", value: on ? "true" : "false", type: "BOOLEAN" },
    update: { value: on ? "true" : "false" },
  });
}

function deliverJob(notificationId: string) {
  return { name: NOTIFICATION_JOB_NAMES.DELIVER_AUTOMATED_NOTIFICATION, data: { notificationId }, opts: { attempts: 5 }, attemptsMade: 0 } as never;
}

/** Fingerprint for the given anchor order id + effective-end (matches the worker). */
function fingerprint(orderId: string, effectiveEnd: Date): string {
  const snap = {
    latestCompletedPaidServiceOrderId: orderId,
    latestPaidServiceEffectiveEndAt: effectiveEnd,
  } as unknown as CustomerLifecycleSnapshot;
  const fp = buildCustomerLapseCycleFingerprint(snap);
  if (fp === null) {
    throw new Error("unexpected null fingerprint");
  }
  return fp;
}

d("winback reminder delivery", () => {
  let seq = 0;
  let panel: Panel;
  const processor = createNotificationDeliveryProcessor({
    deliveryQueue: { rateLimit: vi.fn(), remove: vi.fn(), add: vi.fn() } as never,
    serviceSyncQueue: { add: vi.fn() } as never,
  });

  beforeAll(async () => {
    await setEnabled(true);
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `wb-del-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(() => {
    installFetchStub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: {
        telegramId: runTag + BigInt(seq),
        status: "ACTIVE",
        group: "F",
        marketingMessagesEnabled: true,
        cronNotificationsEnabled: true,
        paidOrdersCount: 1,
        ...overrides,
      },
    });
  }

  async function makePurchaseOrder(user: User): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: {
        userId: user.id, type: "SERVICE_PURCHASE", status: "COMPLETED", finalPriceToman: 120000,
        completedAt: new Date(Date.now() - 41 * DAY), productNameSnapshot: "پلن دلیوری",
      },
    });
  }

  async function makeService(user: User, daysLapsed: number, overrides: Partial<Service> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id, panelId: panel.id, panelType: "MARZBAN", username: `wb-del-svc-${runTag}-${seq}`,
        source: "PAID", status: "EXPIRED", expiresAt: new Date(Date.now() - daysLapsed * DAY),
        lastSubscriptionUpdateAt: new Date(), note: "پلن من", ...overrides,
      },
    });
  }

  async function makeNotification(user: User, fp: string, stageDays = 30): Promise<string> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "CUSTOMER_WINBACK",
        category: AutomatedNotificationCategory.MARKETING,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: user.id,
        dedupeKey: buildCustomerWinbackDedupeKey(user.id, fp, stageDays),
        scheduledFor: new Date(),
        payloadSnapshot: {
          templateKey: "notification_customer_winback",
          variables: { inactive_days: "۴۰", last_service_name: "پلن من" },
          buttons: [],
          meta: { kind: "winback", stageKey: `s${stageDays}`, cycle: fp },
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function statusOf(id: string) {
    return (await prisma.automatedNotification.findUniqueOrThrow({ where: { id } })).status;
  }

  /** The common eligible fixture: returns [user, order, service, notificationId]. */
  async function eligibleFixture(daysLapsed = 40): Promise<{ user: User; order: Order; service: Service; id: string }> {
    const user = await makeUser();
    const order = await makePurchaseOrder(user);
    const service = await makeService(user, daysLapsed);
    const fp = fingerprint(order.id, service.expiresAt as Date);
    const id = await makeNotification(user, fp);
    return { user, order, service, id };
  }

  it("sends a win-back reminder for a cleanly lapsed paying customer", async () => {
    const { id } = await eligibleFixture();
    expect(await processor(deliverJob(id))).toMatchObject({ sent: true });
    expect(sentBodies).toHaveLength(1);
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.SENT);
  });

  it("cancels once the customer has a usable service again", async () => {
    const { user, id } = await eligibleFixture();
    await makeService(user, -10, { status: "ACTIVE" }); // future expiry
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "winback-active-service" });
    expect(sentBodies).toHaveLength(0);
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.CANCELLED);
  });

  it("cancels once the lapse cycle changed (renewal / new purchase)", async () => {
    const { service, id } = await eligibleFixture();
    // The service's effective end moves -> fingerprint changes -> old cycle done.
    await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() - 20 * DAY) } });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "winback-cycle-changed" });
    expect(sentBodies).toHaveLength(0);
  });

  it("suppresses once the customer snoozed win-back", async () => {
    const { user, id } = await eligibleFixture();
    await prisma.customerRetentionPreference.create({ data: { userId: user.id, winbackSnoozedUntil: new Date(Date.now() + 10 * DAY) } });
    expect(await processor(deliverJob(id))).toMatchObject({ suppressed: "winback-snoozed" });
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.SUPPRESSED);
  });

  it("cancels when the customer opted out of marketing (category gate)", async () => {
    const { user, id } = await eligibleFixture();
    await prisma.user.update({ where: { id: user.id }, data: { marketingMessagesEnabled: false } });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "user-opted-out" });
    expect(sentBodies).toHaveLength(0);
  });

  it("cancels once a resumable checkout appears (purchase-in-progress)", async () => {
    const { user, id } = await eligibleFixture();
    await prisma.checkoutSession.create({
      data: { userId: user.id, purpose: "ORDER_PAYMENT", finalPriceToman: 120000, status: "PENDING", expiresAt: new Date(Date.now() + 6 * 3_600_000) },
    });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "winback-purchase-in-progress" });
  });

  it("cancels once a reconciliation opens (financial-hold)", async () => {
    const { user, id } = await eligibleFixture();
    const dup = await prisma.payment.create({
      data: { userId: user.id, purpose: "ORDER_PAYMENT", amountToman: 120000, payableAmountToman: 120000, status: "APPROVED", provider: "ZARINPAL" },
    });
    await prisma.financialReconciliationCase.create({
      data: { type: "DUPLICATE_CHECKOUT_PAYMENT", status: "OPEN", checkoutSessionId: `co-${runTag}-${seq}`, duplicatePaymentId: dup.id, userId: user.id, expectedAmountToman: 120000 },
    });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "winback-financial-hold" });
  });

  it("cancels when the customer is no longer a paying customer", async () => {
    const { order, id } = await eligibleFixture();
    // The anchoring paid order is voided -> not a paying customer AND cycle gone.
    await prisma.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
    const res = await processor(deliverJob(id));
    expect(res.cancelled).toMatch(/^winback-/);
    expect(sentBodies).toHaveLength(0);
  });

  it("defers (does not send) when the service state becomes uncertain", async () => {
    const { service, id } = await eligibleFixture();
    // Make the service state stale -> uncertain -> re-arm rather than guess.
    await prisma.service.update({ where: { id: service.id }, data: { lastSubscriptionUpdateAt: new Date(Date.now() - 2 * DAY) } });
    expect(await processor(deliverJob(id))).toMatchObject({ deferred: "winback-uncertain" });
    expect(sentBodies).toHaveLength(0);
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.SCHEDULED);
  });

  it("cancels while the master switch is off", async () => {
    const { id } = await eligibleFixture();
    await setEnabled(false);
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "system-disabled" });
    await setEnabled(true);
  });

  it("re-delivering an already-sent notice is an idempotent no-op", async () => {
    const { id } = await eligibleFixture();
    expect(await processor(deliverJob(id))).toMatchObject({ sent: true });
    // A duplicate delivery job (e.g. a BullMQ retry after the send) never
    // re-sends: the row is already in a terminal SENT state.
    expect(await processor(deliverJob(id))).toMatchObject({ skipped: "already-terminal" });
    expect(sentBodies).toHaveLength(1);
  });

  it("never leaks the anchor order id or a raw fingerprint into the message", async () => {
    const { order, service, id } = await eligibleFixture();
    const fp = fingerprint(order.id, service.expiresAt as Date);
    await processor(deliverJob(id));
    const body = JSON.stringify(sentBodies[0] ?? {});
    expect(body).not.toContain(order.id);
    expect(body).not.toContain(fp);
  });
});
