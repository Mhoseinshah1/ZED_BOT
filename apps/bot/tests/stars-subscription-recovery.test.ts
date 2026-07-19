import {
  prisma,
  type Panel,
  type Product,
  type ProductCategory,
  type Service,
  type User,
} from "@zedbot/database";
import {
  DEFAULT_STARS_SUBSCRIPTION_CONFIG,
  STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES,
  buildStarsSubscriptionPayload,
} from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The worker Telegram client is mocked so recovery consumes canned transaction
// pages instead of hitting api.telegram.org. Hoisted before the imports below.
interface FakeTx {
  id: string;
  amount: number;
  date: number;
  source?: Record<string, unknown>;
  receiver?: Record<string, unknown>;
}
const txState: { all: FakeTx[]; error: boolean } = { all: [], error: false };
vi.mock("../../worker/src/telegram.js", () => ({
  getStarTransactions: async (input: { offset?: number; limit?: number }) => {
    if (txState.error) {
      return { ok: false, safeErrorCode: "rate-limited", retryable: true };
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    return { ok: true, transactions: txState.all.slice(offset, offset + limit) };
  },
}));

import { runStarsTransactionRecovery } from "../../worker/src/stars-subscription/recovery.js";
import {
  runStarsChargeCleanup,
  runStarsFulfillmentReconcile,
  runStarsPastDueDetection,
  runStarsRefundRetry,
} from "../../worker/src/stars-subscription/reconcile.js";
import { settleRecoveredStarsCharge } from "../src/services/stars-subscription-settlement.service.js";
import {
  handleRefundedPayment,
  handleSubscriptionUpdate,
} from "../src/handlers/user-stars-subscription/stars-subscription-updates.handler.js";
import { getStarsSubscriptionReport, buildStarsReportCsv } from "../src/services/admin-stars-report.service.js";
import type { DeliverySendApi } from "../src/services/other-product-delivery.service.js";

// =============================================================================
// Telegram Stars subscription RECOVERY + OPERATIONS tests (Phase 2.1). Real
// migrated PostgreSQL. Proves: getStarTransactions recovery (only valid
// zedbot:sub: invoice payments, one charge id → one settle job, no duplicates,
// cursor survives + never resets on error), subscription-state Updates
// (canceled/active/failed, ownership, no Payment/Order), RefundedPayment (idempotent,
// no WalletTransaction), PAST_DUE (period+grace, no fabricated payment), refund
// retry selection, cleanup, and Stars-not-Toman reporting.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
// Telegram ids stay < 2^53 so Number(telegramId)↔BigInt round-trips exactly (real
// Telegram user ids are well within this; the huge time-based ids elsewhere are not).
const runTag = BigInt(Date.now());
let seq = 0;
const STARS = 150;

let panel: Panel;
let category: ProductCategory;
let product: Product;

const sendCalls: string[] = [];
const deliverApi: DeliverySendApi = {
  sendMessage: async (chatId: string) => {
    sendCalls.push(chatId);
    return undefined;
  },
};

interface FakeQueue {
  added: { name: string; data: unknown }[];
  add: (name: string, data: unknown) => Promise<unknown>;
}
function fakeQueue(): FakeQueue {
  const added: { name: string; data: unknown }[] = [];
  return {
    added,
    add: async (name: string, data: unknown) => {
      added.push({ name, data });
      return {};
    },
  };
}

async function makeUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag * 1000n + BigInt(seq), status: "ACTIVE", group: "F", balanceToman: 0 },
  });
}

async function makeService(user: User): Promise<Service> {
  seq += 1;
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: `srec-${runTag}-${seq}`,
      source: "PAID",
      status: "ACTIVE",
      volumeBytes: 10n * 1024n * 1024n * 1024n,
      remainingBytes: 5n * 1024n * 1024n * 1024n,
      usedBytes: 5n * 1024n * 1024n * 1024n,
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
      durationDays: 30,
      startsAt: new Date(Date.now() - 28 * 86_400_000),
      lastSubscriptionUpdateAt: new Date(),
    },
  });
}

function snapshot(): Record<string, unknown> {
  return {
    productId: product.id,
    productVersion: 1,
    starsAmount: STARS,
    durationDays: 30,
    volumeGb: 10,
    panelId: panel.id,
    categoryId: category.id,
    productName: product.name,
    panelName: panel.name,
    categoryName: category.name,
  };
}

interface SubOpts {
  status?: string;
  currentPeriodEndsAt?: Date | null;
  initialChargeId?: string | null;
  telegramExtensionCanceled?: boolean;
}

/** Creates a mandate + subscription row directly (bypasses enrollment/payment). */
async function makeSubscription(user: User, service: Service, opts: SubOpts = {}): Promise<{ id: string; payloadId: string }> {
  seq += 1;
  const payloadId = `rec${runTag}x${seq}`.slice(0, 40);
  const mandate = await prisma.serviceAutoRenewalMandate.create({
    data: {
      userId: user.id,
      serviceId: service.id,
      productId: product.id,
      fundingMethod: "TELEGRAM_STARS",
      status: "ACTIVE",
      maximumChargeToman: 0,
      consentedPriceToman: 0,
      chargeLeadMinutes: 180,
      consentVersion: 1,
      consentedAt: new Date(),
    },
  });
  const sub = await prisma.telegramStarsServiceSubscription.create({
    data: {
      mandateId: mandate.id,
      userId: user.id,
      serviceId: service.id,
      productId: product.id,
      status: (opts.status ?? "PENDING_PAYMENT") as never,
      publicPayloadId: payloadId,
      starsAmount: STARS,
      subscriptionPeriodSeconds: 2_592_000,
      productVersion: 1,
      entitlementSnapshot: snapshot() as never,
      consentVersion: 1,
      consentedAt: new Date(),
      termsAcceptedAt: new Date(),
      currentPeriodEndsAt: opts.currentPeriodEndsAt ?? null,
      initialTelegramPaymentChargeId: opts.initialChargeId ?? null,
      telegramExtensionCanceled: opts.telegramExtensionCanceled ?? false,
    },
  });
  return { id: sub.id, payloadId };
}

async function makeCharge(
  subscriptionId: string,
  status: string,
  extra: { starsAmount?: number; isFirst?: boolean; refundAttempts?: number; chargeId?: string; updatedAgoMs?: number } = {},
): Promise<string> {
  seq += 1;
  const charge = await prisma.telegramStarsSubscriptionCharge.create({
    data: {
      subscriptionId,
      telegramPaymentChargeId: extra.chargeId ?? `chg-${runTag}-${seq}`,
      starsAmount: extra.starsAmount ?? STARS,
      isFirstRecurring: extra.isFirst ?? false,
      subscriptionExpirationDate: new Date(Date.now() + 30 * 86_400_000),
      status: status as never,
      refundAttempts: extra.refundAttempts ?? 0,
    },
    select: { id: true },
  });
  if (extra.updatedAgoMs !== undefined) {
    // Force an older updatedAt for stuck/retry-window assertions.
    await prisma.$executeRaw`UPDATE "TelegramStarsSubscriptionCharge" SET "updatedAt" = ${new Date(Date.now() - extra.updatedAgoMs)} WHERE id = ${charge.id}`;
  }
  return charge.id;
}

function starTx(user: User, payloadId: string, over: Partial<FakeTx> = {}): FakeTx {
  return {
    id: over.id ?? `tx-${runTag}-${seq++}`,
    amount: over.amount ?? STARS,
    date: over.date ?? Math.floor(Date.now() / 1000),
    source: {
      type: "user",
      transaction_type: "invoice_payment",
      user: { id: Number(user.telegramId) },
      invoice_payload: buildStarsSubscriptionPayload(payloadId),
      subscription_period: 2_592_000,
      ...(over.source ?? {}),
    },
  };
}

describe.runIf(hasDb)("stars subscription recovery + operations", () => {
  beforeAll(async () => {
    process.env.BOT_TOKEN = "test:token";
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `srec-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        renewalEnabled: true,
        provisioningReady: true,
      },
    });
    category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `srec-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `srec-prod-${runTag}`,
        priceToman: 90_000,
        durationDays: 30,
        volumeGb: 10,
        isActive: true,
        telegramStarsSubscriptionEnabled: true,
        telegramStarsSubscriptionPrice: STARS,
        telegramStarsSubscriptionVersion: 1,
      },
    });
  });

  beforeEach(async () => {
    txState.all = [];
    txState.error = false;
    sendCalls.length = 0;
    // Reset the singleton cursor so offset assertions are deterministic.
    await prisma.telegramStarsReconciliationCursor.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // --- getStarTransactions recovery (Parts E/F/G) ---------------------------

  describe("transaction recovery", () => {
    it("recovers a valid subscription transaction → one settle job, and reuses it on re-scan", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { id: subId, payloadId } = await makeSubscription(user, service);
      const tx = starTx(user, payloadId, { id: `txrec-${runTag}` });
      txState.all = [tx];
      const q = fakeQueue();

      const r1 = await runStarsTransactionRecovery({ executeQueue: q as never }, DEFAULT_STARS_SUBSCRIPTION_CONFIG);
      expect(r1.chargesRecovered).toBe(1);
      expect(q.added).toHaveLength(1);
      expect(q.added[0].name).toBe(STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.SETTLE_RECOVERED_CHARGE);
      expect((q.added[0].data as { subscriptionId: string }).subscriptionId).toBe(subId);

      // A repeated scan with the charge now materialised must NOT re-enqueue.
      await prisma.telegramStarsSubscriptionCharge.create({
        data: {
          subscriptionId: subId,
          telegramPaymentChargeId: tx.id,
          starsAmount: STARS,
          isFirstRecurring: true,
          subscriptionExpirationDate: new Date(),
          status: "COMPLETED",
        },
      });
      const q2 = fakeQueue();
      const r2 = await runStarsTransactionRecovery({ executeQueue: q2 as never }, DEFAULT_STARS_SUBSCRIPTION_CONFIG);
      expect(r2.chargesRecovered).toBe(0);
      expect(q2.added).toHaveLength(0);
    });

    it("ignores one-time, foreign, wrong-amount and wrong-user transactions", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { payloadId } = await makeSubscription(user, service);
      const other = await makeUser();
      txState.all = [
        // one-time zedbot:pay: transaction
        { id: `one-${runTag}`, amount: STARS, date: Math.floor(Date.now() / 1000), source: { type: "user", transaction_type: "invoice_payment", user: { id: Number(user.telegramId) }, invoice_payload: "zedbot:pay:xyz", subscription_period: 2_592_000 } },
        // foreign sub payload (no local subscription)
        starTx(user, "nonexistentpayload", { id: `foreign-${runTag}` }),
        // wrong amount
        starTx(user, payloadId, { id: `amt-${runTag}`, amount: STARS + 1 }),
        // wrong user
        starTx(other, payloadId, { id: `usr-${runTag}` }),
        // wrong period
        { id: `per-${runTag}`, amount: STARS, date: Math.floor(Date.now() / 1000), source: { type: "user", transaction_type: "invoice_payment", user: { id: Number(user.telegramId) }, invoice_payload: buildStarsSubscriptionPayload(payloadId), subscription_period: 999 } },
      ];
      const q = fakeQueue();
      const r = await runStarsTransactionRecovery({ executeQueue: q as never }, DEFAULT_STARS_SUBSCRIPTION_CONFIG);
      expect(r.chargesRecovered).toBe(0);
      expect(q.added).toHaveLength(0);
    });

    it("creates the cursor, advances the offset, and never resets it on an API error", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { payloadId } = await makeSubscription(user, service);
      txState.all = [starTx(user, payloadId, { id: `curs-${runTag}` })];
      const q = fakeQueue();
      await runStarsTransactionRecovery({ executeQueue: q as never }, DEFAULT_STARS_SUBSCRIPTION_CONFIG);
      const cursor = await prisma.telegramStarsReconciliationCursor.findUnique({ where: { singletonKey: "default" } });
      expect(cursor).not.toBeNull();
      expect(cursor?.bootstrapCompleted).toBe(true); // short page → caught up
      const offsetAfterOk = cursor?.nextOffset ?? -1;
      expect(offsetAfterOk).toBeGreaterThanOrEqual(1);
      // No raw charge id anywhere in the cursor row.
      expect(JSON.stringify(cursor)).not.toContain(`curs-${runTag}`);

      // An API failure must not reset the offset.
      txState.error = true;
      await runStarsTransactionRecovery({ executeQueue: fakeQueue() as never }, DEFAULT_STARS_SUBSCRIPTION_CONFIG);
      const after = await prisma.telegramStarsReconciliationCursor.findUnique({ where: { singletonKey: "default" } });
      expect(after?.nextOffset).toBe(offsetAfterOk);
      expect(after?.consecutiveFailureCount ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  // --- recovered settlement evidence (Part F/G) -----------------------------

  it("settles a recovered charge with STAR_TRANSACTION_RECOVERY + RECOVERED_DERIVED", async () => {
    const user = await makeUser();
    const service = await makeService(user);
    const { id: subId } = await makeSubscription(user, service);
    const chargeId = `recset-${runTag}`;
    const txSec = Math.floor(Date.now() / 1000);
    await settleRecoveredStarsCharge(deliverApi, {
      subscriptionId: subId,
      telegramPaymentChargeId: chargeId,
      starsAmount: STARS,
      telegramTransactionAtSec: txSec,
      isFirstRecurring: true,
    });
    const charge = await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { telegramPaymentChargeId: chargeId } });
    expect(charge?.evidenceSource).toBe("STAR_TRANSACTION_RECOVERY");
    expect(charge?.periodEndSource).toBe("RECOVERED_DERIVED");
    // Derived period end = txDate + 30d (the panel is unreachable so the charge
    // ends in REFUND_PENDING; the derived expiration is still stamped).
    const expectedEnd = new Date(txSec * 1000 + 2_592_000 * 1000);
    expect(charge?.subscriptionExpirationDate.getTime()).toBe(expectedEnd.getTime());
    // No WalletTransaction is ever created for a Stars charge.
    const walletTx = await prisma.walletTransaction.count({ where: { userId: user.id } });
    expect(walletTx).toBe(0);
  });

  // --- subscription-state Updates (Part B) ----------------------------------

  describe("subscription-state Updates", () => {
    it("canceled → CANCEL_AT_PERIOD_END, preserves period, no Payment/Order", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const end = new Date(Date.now() + 10 * 86_400_000);
      const { id: subId, payloadId } = await makeSubscription(user, service, { status: "ACTIVE", currentPeriodEndsAt: end, initialChargeId: `init-${runTag}` });
      await handleSubscriptionUpdate({ user: { id: Number(user.telegramId) }, invoice_payload: buildStarsSubscriptionPayload(payloadId), state: "canceled" });
      const sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } });
      expect(sub?.status).toBe("CANCEL_AT_PERIOD_END");
      expect(sub?.telegramExtensionCanceled).toBe(true);
      expect(sub?.currentPeriodEndsAt?.getTime()).toBe(end.getTime());
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    });

    it("active → REACTIVATION_ALLOWED, no Payment; failed → PAST_DUE, no Order", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { id: subId, payloadId } = await makeSubscription(user, service, { status: "CANCEL_AT_PERIOD_END", currentPeriodEndsAt: new Date(Date.now() + 5 * 86_400_000), initialChargeId: `i2-${runTag}`, telegramExtensionCanceled: true });
      await handleSubscriptionUpdate({ user: { id: Number(user.telegramId) }, invoice_payload: buildStarsSubscriptionPayload(payloadId), state: "active" });
      let sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } });
      expect(sub?.status).toBe("REACTIVATION_ALLOWED");
      expect(sub?.telegramExtensionCanceled).toBe(false);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);

      await handleSubscriptionUpdate({ user: { id: Number(user.telegramId) }, invoice_payload: buildStarsSubscriptionPayload(payloadId), state: "failed" });
      sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } });
      expect(sub?.status).toBe("PAST_DUE");
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    });

    it("ignores a foreign payload and a wrong-user update (idempotent)", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const other = await makeUser();
      const { id: subId, payloadId } = await makeSubscription(user, service, { status: "ACTIVE", currentPeriodEndsAt: new Date(Date.now() + 5 * 86_400_000), initialChargeId: `i3-${runTag}` });
      // Wrong user
      await handleSubscriptionUpdate({ user: { id: Number(other.telegramId) }, invoice_payload: buildStarsSubscriptionPayload(payloadId), state: "canceled" });
      // Foreign payload
      await handleSubscriptionUpdate({ user: { id: Number(user.telegramId) }, invoice_payload: "zedbot:sub:doesnotexist", state: "canceled" });
      const sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } });
      expect(sub?.status).toBe("ACTIVE"); // untouched
    });
  });

  // --- RefundedPayment Updates (Part C) -------------------------------------

  describe("RefundedPayment Updates", () => {
    it("confirms a refund idempotently and creates no WalletTransaction", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { id: subId, payloadId } = await makeSubscription(user, service, { status: "ACTIVE" });
      const chargeTgId = `ref-${runTag}`;
      await makeCharge(subId, "COMPLETED", { chargeId: chargeTgId });
      const rp = { currency: "XTR", total_amount: STARS, invoice_payload: buildStarsSubscriptionPayload(payloadId), telegram_payment_charge_id: chargeTgId };
      await handleRefundedPayment(user.telegramId, rp);
      let charge = await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { telegramPaymentChargeId: chargeTgId } });
      expect(charge?.status).toBe("REFUNDED");
      const sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } });
      expect(sub?.status).toBe("REQUIRES_ACTION");
      // Duplicate refund message is harmless.
      await handleRefundedPayment(user.telegramId, rp);
      charge = await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { telegramPaymentChargeId: chargeTgId } });
      expect(charge?.status).toBe("REFUNDED");
      expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
    });

    it("rejects wrong currency / amount / user / payload", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { id: subId, payloadId } = await makeSubscription(user, service, { status: "ACTIVE" });
      const chargeTgId = `ref2-${runTag}`;
      await makeCharge(subId, "COMPLETED", { chargeId: chargeTgId });
      const good = { currency: "XTR", total_amount: STARS, invoice_payload: buildStarsSubscriptionPayload(payloadId), telegram_payment_charge_id: chargeTgId };
      await handleRefundedPayment(user.telegramId, { ...good, total_amount: STARS + 5 }); // wrong amount
      await handleRefundedPayment(user.telegramId, { ...good, invoice_payload: "zedbot:sub:other" }); // wrong payload
      await handleRefundedPayment(9_999_999n, good); // wrong user
      const charge = await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { telegramPaymentChargeId: chargeTgId } });
      expect(charge?.status).toBe("COMPLETED"); // untouched by any invalid refund
    });
  });

  // --- PAST_DUE detection (Part K) ------------------------------------------

  describe("PAST_DUE detection", () => {
    it("marks PAST_DUE after period+grace, once, and never before grace or with a newer charge", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      // Past due: period ended 4h ago, grace is 180 min.
      const { id: dueId } = await makeSubscription(user, service, { status: "ACTIVE", currentPeriodEndsAt: new Date(Date.now() - 4 * 3_600_000) });

      const user2 = await makeUser();
      const svc2 = await makeService(user2);
      // Within grace: ended 1h ago.
      const { id: freshId } = await makeSubscription(user2, svc2, { status: "ACTIVE", currentPeriodEndsAt: new Date(Date.now() - 3_600_000) });

      const user3 = await makeUser();
      const svc3 = await makeService(user3);
      // Ended long ago BUT a newer charge covers the next cycle.
      const { id: coveredId } = await makeSubscription(user3, svc3, { status: "ACTIVE", currentPeriodEndsAt: new Date(Date.now() - 5 * 3_600_000) });
      await prisma.telegramStarsSubscriptionCharge.create({
        data: { subscriptionId: coveredId, telegramPaymentChargeId: `cov-${runTag}`, starsAmount: STARS, isFirstRecurring: false, subscriptionExpirationDate: new Date(Date.now() + 20 * 86_400_000), status: "COMPLETED" },
      });

      const q = fakeQueue();
      const r1 = await runStarsPastDueDetection(DEFAULT_STARS_SUBSCRIPTION_CONFIG, q as never);
      expect(r1.pastDue).toBeGreaterThanOrEqual(1);
      expect((await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: dueId } }))?.status).toBe("PAST_DUE");
      expect((await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: freshId } }))?.status).toBe("ACTIVE");
      expect((await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: coveredId } }))?.status).toBe("ACTIVE");

      // Exactly one PAST_DUE notification for the due subscription (dedupe).
      const notifs = await prisma.automatedNotification.count({ where: { userId: user.id, type: "STARS_SUBSCRIPTION_PAST_DUE" } });
      expect(notifs).toBe(1);
      // Re-running does not fabricate a Payment or a second notification.
      await runStarsPastDueDetection(DEFAULT_STARS_SUBSCRIPTION_CONFIG, fakeQueue() as never);
      expect(await prisma.automatedNotification.count({ where: { userId: user.id, type: "STARS_SUBSCRIPTION_PAST_DUE" } })).toBe(1);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    });
  });

  // --- refund retry selection (Part L) --------------------------------------

  describe("refund retry", () => {
    it("enqueues REFUND_PENDING charges with capacity and moves exhausted ones to REQUIRES_ACTION", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const { id: subId } = await makeSubscription(user, service, { status: "ACTIVE" });
      const retryable = await makeCharge(subId, "REFUND_PENDING", { chargeId: `rp-${runTag}`, refundAttempts: 0 });
      await makeCharge(subId, "REFUND_PENDING", { chargeId: `ex-${runTag}`, refundAttempts: DEFAULT_STARS_SUBSCRIPTION_CONFIG.refundMaxAttempts });

      const q2 = fakeQueue();
      const res = await runStarsRefundRetry(q2 as never, DEFAULT_STARS_SUBSCRIPTION_CONFIG, fakeQueue() as never);
      expect(res.refundEnqueued).toBeGreaterThanOrEqual(1);
      expect(q2.added.some((j) => j.name === STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.RETRY_REFUND && (j.data as { chargeId: string }).chargeId === retryable)).toBe(true);
      // Exhausted charge flipped its subscription to REQUIRES_ACTION.
      expect((await prisma.telegramStarsServiceSubscription.findUnique({ where: { id: subId } }))?.status).toBe("REQUIRES_ACTION");
    });
  });

  // --- fulfillment reconcile selection (Part M) -----------------------------

  it("selects stuck charges for reconcile", async () => {
    const user = await makeUser();
    const service = await makeService(user);
    const { id: subId } = await makeSubscription(user, service, { status: "ACTIVE" });
    const stuckId = await makeCharge(subId, "RECONCILIATION_REQUIRED", { chargeId: `stuck-${runTag}`, updatedAgoMs: 30 * 60_000 });
    const q = fakeQueue();
    const r = await runStarsFulfillmentReconcile(q as never);
    expect(r.reconcileEnqueued).toBeGreaterThanOrEqual(1);
    expect(q.added.some((j) => (j.data as { chargeId: string }).chargeId === stuckId)).toBe(true);
  });

  // --- cleanup (Part Y) ------------------------------------------------------

  it("cleans only terminal FAILED/IGNORED charges past retention, never financial ones", async () => {
    const user = await makeUser();
    const service = await makeService(user);
    const { id: subId } = await makeSubscription(user, service, { status: "ACTIVE" });
    const failedOld = await makeCharge(subId, "FAILED", { chargeId: `fail-${runTag}` });
    const refundPending = await makeCharge(subId, "REFUND_PENDING", { chargeId: `keep-${runTag}` });
    await prisma.$executeRaw`UPDATE "TelegramStarsSubscriptionCharge" SET "createdAt" = ${new Date(Date.now() - 999 * 86_400_000)} WHERE id IN (${failedOld}, ${refundPending})`;
    await runStarsChargeCleanup(DEFAULT_STARS_SUBSCRIPTION_CONFIG);
    expect(await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { id: failedOld } })).toBeNull();
    expect(await prisma.telegramStarsSubscriptionCharge.findUnique({ where: { id: refundPending } })).not.toBeNull();
  });

  // --- financial report (Parts U/V) -----------------------------------------

  it("reports Stars separately with gross/refunded/net and PII-free CSV", async () => {
    const user = await makeUser();
    const service = await makeService(user);
    const { id: subId } = await makeSubscription(user, service, { status: "ACTIVE" });
    await makeCharge(subId, "COMPLETED", { chargeId: `rep-a-${runTag}`, isFirst: true, starsAmount: 100 });
    await makeCharge(subId, "COMPLETED", { chargeId: `rep-b-${runTag}`, isFirst: false, starsAmount: 100 });
    await makeCharge(subId, "REFUNDED", { chargeId: `rep-c-${runTag}`, starsAmount: 100 });

    const report = await getStarsSubscriptionReport("all");
    expect(report.initialCount).toBeGreaterThanOrEqual(1);
    expect(report.recurringCount).toBeGreaterThanOrEqual(1);
    expect(report.grossStars).toBeGreaterThanOrEqual(300); // 2 completed + 1 refunded counted as received
    expect(report.refundedStars).toBeGreaterThanOrEqual(100);
    expect(report.netStars).toBe(report.grossStars - report.refundedStars);

    const csv = buildStarsReportCsv(report, "همه زمان‌ها");
    expect(csv).toContain("net_stars");
    expect(csv).not.toContain(user.id);
    expect(csv).not.toContain(subId);
  });
});
