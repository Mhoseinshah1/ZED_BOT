import {
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "checkout-scan-tests-secret-0123456789";

import { runCheckoutNotificationScan } from "../../worker/src/notifications/checkout-scan.js";

// =============================================================================
// Checkout-payment SCAN against a real DB. Covers: disabled default, abandoned
// stages + dedupe + max, the financial exclusions (settled / order / receipt-
// pending / suppressed), failed-payment retry (online only), the payment-retry-
// over-abandoned conflict policy, and concurrent-scan idempotency.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const MIN = 60_000;
const HOUR = 60 * MIN;

const KEYS = {
  master: "automated_notifications_enabled",
  abandoned: "notification_abandoned_checkout_enabled",
  payment: "notification_payment_retry_enabled",
};

async function setBool(key: string, on: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: on ? "true" : "false", type: "BOOLEAN" },
    update: { value: on ? "true" : "false" },
  });
}

function fakeQueue() {
  return { add: vi.fn(async () => undefined) } as never;
}

async function backdate(table: string, id: string, createdAt: Date, updatedAt: Date): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "createdAt" = $1, "updatedAt" = $2 WHERE id = $3`,
    createdAt,
    updatedAt,
    id,
  );
}

d("checkout notification scan", () => {
  let seq = 0;

  beforeAll(async () => {
    await setBool(KEYS.master, true);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all([setBool(KEYS.master, true), setBool(KEYS.abandoned, true), setBool(KEYS.payment, true)]);
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
  }

  /** A PENDING checkout, inactive `inactiveMinutes` ago (createdAt+updatedAt backdated). */
  async function makeCheckout(
    user: User,
    inactiveMinutes: number,
    overrides: Partial<CheckoutSession> = {},
  ): Promise<CheckoutSession> {
    seq += 1;
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        finalPriceToman: 120000,
        productSnapshot: { productName: "پلن تست" },
        expiresAt: new Date(Date.now() + 6 * HOUR),
        status: "PENDING",
        ...overrides,
      },
    });
    const at = new Date(Date.now() - inactiveMinutes * MIN);
    await backdate("CheckoutSession", checkout.id, at, at);
    return checkout;
  }

  async function makePayment(
    user: User,
    checkout: CheckoutSession,
    overrides: Partial<Payment>,
    failedMinutesAgo?: number,
  ): Promise<Payment> {
    seq += 1;
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        amountToman: 120000,
        payableAmountToman: 120000,
        status: "FAILED",
        provider: "ZARINPAL",
        ...overrides,
      },
    });
    if (failedMinutesAgo !== undefined) {
      const at = new Date(Date.now() - failedMinutesAgo * MIN);
      await backdate("Payment", payment.id, at, at);
    }
    return payment;
  }

  async function notifs(checkoutId: string, type?: string) {
    return prisma.automatedNotification.findMany({
      where: { checkoutSessionId: checkoutId, ...(type !== undefined ? { type: type as never } : {}) },
    });
  }

  it("creates nothing while globally disabled", async () => {
    await setBool(KEYS.master, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const r = await runCheckoutNotificationScan(fakeQueue());
    expect(r.skipped).toBe("system-disabled");
    expect(await notifs(checkout.id)).toHaveLength(0);
  });

  it("creates nothing when neither rule is enabled", async () => {
    await Promise.all([setBool(KEYS.abandoned, false), setBool(KEYS.payment, false)]);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    const r = await runCheckoutNotificationScan(fakeQueue());
    expect(r.skipped).toBe("no-rule-enabled");
    expect(await notifs(checkout.id)).toHaveLength(0);
  });

  it("creates ONE abandoned stage-1 notice and dedupes on re-scan", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    await runCheckoutNotificationScan(fakeQueue());
    await runCheckoutNotificationScan(fakeQueue());
    const rows = await notifs(checkout.id, "ABANDONED_CHECKOUT");
    expect(rows).toHaveLength(1);
    expect((rows[0].payloadSnapshot as { meta?: { stage?: number } }).meta?.stage).toBe(1);
  });

  it("advances to stage 2 after stage 1 exists and the 6h threshold passes", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    await runCheckoutNotificationScan(fakeQueue()); // stage 1
    // Simulate 6h+ inactivity and a checkout still young enough (< 24h old).
    const at = new Date(Date.now() - 7 * HOUR);
    await backdate("CheckoutSession", checkout.id, at, at);
    await runCheckoutNotificationScan(fakeQueue());
    const rows = await notifs(checkout.id, "ABANDONED_CHECKOUT");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r.payloadSnapshot as { meta?: { stage?: number } }).meta?.stage).sort()).toEqual([1, 2]);
  });

  it("never exceeds the per-checkout maximum (2)", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    for (let i = 0; i < 4; i += 1) {
      const at = new Date(Date.now() - 8 * HOUR);
      await backdate("CheckoutSession", checkout.id, at, at);
      await runCheckoutNotificationScan(fakeQueue());
    }
    expect(await notifs(checkout.id, "ABANDONED_CHECKOUT")).toHaveLength(2);
  });

  it("excludes a settled checkout", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const settledPayment = await makePayment(user, await makeCheckout(user, 40), { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({ where: { id: settledPayment.checkoutSessionId as string }, data: { settledByPaymentId: settledPayment.id, status: "PAID" } });
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(settledPayment.checkoutSessionId as string)).toHaveLength(0);
  });

  it("excludes a checkout with a pending-review receipt", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(checkout.id)).toHaveLength(0);
  });

  it("respects per-checkout suppression", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    await prisma.checkoutNotificationPreference.create({
      data: { checkoutSessionId: checkout.id, abandonedReminderSuppressedAt: new Date() },
    });
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(checkout.id)).toHaveLength(0);
  });

  it("creates a PAYMENT_RETRY for a definitively FAILED online payment", async () => {
    await setBool(KEYS.abandoned, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5); // recent activity - abandoned would be too-early anyway
    await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    await runCheckoutNotificationScan(fakeQueue());
    const rows = await notifs(checkout.id, "PAYMENT_RETRY");
    expect(rows).toHaveLength(1);
  });

  it("does NOT create PAYMENT_RETRY for card-to-card", async () => {
    await setBool(KEYS.abandoned, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    await makePayment(user, checkout, { status: "FAILED", provider: "CARD_TO_CARD" }, 20);
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(checkout.id, "PAYMENT_RETRY")).toHaveLength(0);
  });

  it("suppresses retry when another payment succeeded (competing success)", async () => {
    await setBool(KEYS.abandoned, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 5);
    await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    await makePayment(user, checkout, { status: "APPROVED", provider: "NOWPAYMENTS", settlementStatus: "SETTLED" });
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(checkout.id, "PAYMENT_RETRY")).toHaveLength(0);
  });

  it("prefers PAYMENT_RETRY over the abandoned reminder for the same checkout", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40); // abandoned-eligible by inactivity
    await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    await runCheckoutNotificationScan(fakeQueue());
    expect(await notifs(checkout.id, "PAYMENT_RETRY")).toHaveLength(1);
    expect(await notifs(checkout.id, "ABANDONED_CHECKOUT")).toHaveLength(0);
  });

  it("two concurrent scans create exactly one abandoned row", async () => {
    await setBool(KEYS.payment, false);
    const user = await makeUser();
    const checkout = await makeCheckout(user, 40);
    await Promise.all([runCheckoutNotificationScan(fakeQueue()), runCheckoutNotificationScan(fakeQueue())]);
    expect(await notifs(checkout.id, "ABANDONED_CHECKOUT")).toHaveLength(1);
  });
});
