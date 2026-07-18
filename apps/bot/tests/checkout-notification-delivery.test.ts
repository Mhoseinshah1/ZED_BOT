import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import { NOTIFICATION_JOB_NAMES } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "checkout-delivery-tests-secret-0123456789";
process.env.BOT_TOKEN = "111222:checkout-delivery-token";

import { createNotificationDeliveryProcessor } from "../../worker/src/notifications/delivery.js";

// =============================================================================
// Checkout-payment reminder DELIVERY re-validation (real DB, fake Telegram).
// The delivery worker reloads authoritative live financial state and CANCELS a
// stale reminder before sending: settlement, order, receipt-pending,
// reconciliation, competing success, expiry, suppression, or a payment no
// longer failed. Plus the happy path and a no-secret-leak check.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const MIN = 60_000;
const HOUR = 60 * MIN;

let sentBodies: Array<Record<string, unknown>>;
function installFetchStub(): void {
  sentBodies = [];
  global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    sentBodies.push(init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) } as unknown as Response;
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

async function backdate(table: string, id: string, at: Date): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "createdAt" = $1, "updatedAt" = $1 WHERE id = $2`, at, id);
}

d("checkout-payment reminder delivery", () => {
  let seq = 0;
  const processor = createNotificationDeliveryProcessor({ deliveryQueue: { rateLimit: vi.fn(), remove: vi.fn(), add: vi.fn() } as never });

  beforeAll(async () => {
    await setEnabled(true);
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
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
  }

  async function makeCheckout(user: User, inactiveMinutes: number, overrides: Partial<CheckoutSession> = {}): Promise<CheckoutSession> {
    seq += 1;
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        finalPriceToman: 90000,
        productSnapshot: { productName: "پلن دلیوری" },
        expiresAt: new Date(Date.now() + 6 * HOUR),
        status: "PENDING",
        ...overrides,
      },
    });
    await backdate("CheckoutSession", checkout.id, new Date(Date.now() - inactiveMinutes * MIN));
    return checkout;
  }

  async function abandonedNotification(user: User, checkout: CheckoutSession): Promise<string> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "ABANDONED_CHECKOUT",
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: user.id,
        checkoutSessionId: checkout.id,
        dedupeKey: `co-del-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: {
          templateKey: "notification_abandoned_checkout",
          variables: { product_name: "پلن دلیوری", payable_amount: "۹۰٬۰۰۰ تومان", checkout_reference: "abcd1234" },
          buttons: [],
          meta: { kind: "abandoned", stage: 1, checkout: checkout.id.slice(0, 8) },
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function makeFailedPayment(user: User, checkout: CheckoutSession, overrides: Partial<Payment> = {}): Promise<Payment> {
    seq += 1;
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        amountToman: 90000,
        payableAmountToman: 90000,
        status: "FAILED",
        provider: "ZARINPAL",
        ...overrides,
      },
    });
    await backdate("Payment", payment.id, new Date(Date.now() - 20 * MIN));
    return payment;
  }

  async function paymentNotification(user: User, checkout: CheckoutSession, payment: Payment): Promise<string> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "PAYMENT_RETRY",
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: user.id,
        checkoutSessionId: checkout.id,
        paymentId: payment.id,
        dedupeKey: `pay-del-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: {
          templateKey: "notification_payment_retry",
          variables: { product_name: "پلن دلیوری", payable_amount: "۹۰٬۰۰۰ تومان", checkout_reference: "abcd1234", payment_method: "زرین‌پال" },
          buttons: [],
          meta: { kind: "payment_retry", checkout: checkout.id.slice(0, 8) },
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function statusOf(id: string) {
    return (await prisma.automatedNotification.findUniqueOrThrow({ where: { id } })).status;
  }

  it("sends an abandoned reminder for a still-pending checkout", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    expect(await processor(deliverJob(id))).toMatchObject({ sent: true });
    expect(sentBodies).toHaveLength(1);
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.SENT);
  });

  it("cancels an abandoned reminder once the checkout is settled", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    const pay = await makeFailedPayment(user, checkout, { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({ where: { id: checkout.id }, data: { settledByPaymentId: pay.id, status: "PAID" } });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "checkout-settled" });
    expect(sentBodies).toHaveLength(0);
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.CANCELLED);
  });

  it("cancels an abandoned reminder once a receipt is pending review", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    await makeFailedPayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "checkout-receipt-pending" });
    expect(sentBodies).toHaveLength(0);
  });

  it("cancels an abandoned reminder once a reconciliation case opens", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    const dup = await makeFailedPayment(user, checkout, { status: "APPROVED" });
    await prisma.financialReconciliationCase.create({
      data: { type: "DUPLICATE_CHECKOUT_PAYMENT", status: "OPEN", checkoutSessionId: checkout.id, duplicatePaymentId: dup.id, userId: user.id, expectedAmountToman: 90000 },
    });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "checkout-reconciliation" });
  });

  it("cancels an abandoned reminder once suppressed", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    await prisma.checkoutNotificationPreference.create({ data: { checkoutSessionId: checkout.id, abandonedReminderSuppressedAt: new Date() } });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "checkout-suppressed" });
  });

  it("cancels an abandoned reminder once the checkout expired", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40, { expiresAt: new Date(Date.now() - 1 * MIN) });
    const id = await abandonedNotification(user, checkout);
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "checkout-expired" });
  });

  it("cancels when the user opted out of payment notifications", async () => {
    const user = await makeUser({ paymentNotificationsEnabled: false });
    const checkout = await makeCheckout(user, 40);
    const id = await abandonedNotification(user, checkout);
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "user-opted-out" });
  });

  it("sends a payment-retry reminder for a still-failed online payment", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    const payment = await makeFailedPayment(user, checkout);
    const id = await paymentNotification(user, checkout, payment);
    expect(await processor(deliverJob(id))).toMatchObject({ sent: true });
    expect(await statusOf(id)).toBe(AutomatedNotificationStatus.SENT);
  });

  it("cancels a payment-retry reminder when a competing payment succeeded", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    const payment = await makeFailedPayment(user, checkout);
    const id = await paymentNotification(user, checkout, payment);
    await makeFailedPayment(user, checkout, { status: "APPROVED", provider: "NOWPAYMENTS", settlementStatus: "SETTLED" });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "payment-competing-success" });
    expect(sentBodies).toHaveLength(0);
  });

  it("cancels a payment-retry reminder when the payment is no longer failed", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    const payment = await makeFailedPayment(user, checkout);
    const id = await paymentNotification(user, checkout, payment);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "APPROVED" } });
    expect(await processor(deliverJob(id))).toMatchObject({ cancelled: "payment-not-failed" });
  });

  it("never leaks a provider authority/secret into the message", async () => {
    const secret = "AUTH-SECRET-zarinpal-abcdef123456";
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    const payment = await makeFailedPayment(user, checkout, { authority: secret, externalReference: secret });
    const id = await paymentNotification(user, checkout, payment);
    await processor(deliverJob(id));
    expect(JSON.stringify(sentBodies[0])).not.toContain(secret);
  });
});
