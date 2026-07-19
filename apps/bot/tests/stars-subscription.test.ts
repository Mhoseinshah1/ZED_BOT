import {
  prisma,
  type Panel,
  type Product,
  type ProductCategory,
  type Service,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  beginStarsEnrollment,
  getSubscriptionForService,
  isSubscriptionProductEligible,
} from "../src/services/stars-subscription.service.js";
import { settleTelegramStarsSubscriptionCharge } from "../src/services/stars-subscription-settlement.service.js";
import {
  refundStarsSubscriptionCharge,
  type StarsBotApi,
} from "../src/services/stars-subscription-refund.service.js";
import { createMandate } from "../src/services/auto-renewal.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// Telegram Stars subscription — DB-backed integration tests (Phase 2). Requires a
// real migrated PostgreSQL (skips otherwise). Proves the money-safety invariants:
// funding-method exclusivity, eligibility, per-charge idempotency (one charge →
// one Payment/Order, no double renewal), Stars-not-Toman (no WalletTransaction),
// and idempotent refund. The panel is unreachable so the renewal executor fails
// deterministically → the definite-failure path (refund-required) is exercised.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const STARS = 150;

let panel: Panel;
let category: ProductCategory;
let product: Product;

function productRel(): ProductWithRelations {
  return { ...product, category, panel };
}

const editCalls: { userId: number; chargeId: string; canceled: boolean }[] = [];
const refundCalls: { userId: number; chargeId: string }[] = [];
const fakeApi: StarsBotApi = {
  sendMessage: async () => undefined,
  refundStarPayment: async (userId, chargeId) => {
    refundCalls.push({ userId, chargeId });
    return undefined;
  },
  editUserStarSubscription: async (userId, chargeId, canceled) => {
    editCalls.push({ userId, chargeId, canceled });
    return undefined;
  },
};

async function enableAll(): Promise<void> {
  await setSetting("telegram_stars_subscriptions_enabled", "true", "BOOLEAN");
  clearSettingsCache();
  process.env.TELEGRAM_STARS_ENABLED = "true";
}

async function makeUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman: 0 },
  });
}

async function makeService(user: User): Promise<Service> {
  seq += 1;
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: `ssub-${runTag}-${seq}`,
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

describe.runIf(hasDb)("telegram stars subscriptions", () => {
  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `ssub-panel-${runTag}`,
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
      data: { type: "SERVICE_PRODUCT", name: `ssub-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `ssub-prod-${runTag}`,
        priceToman: 90_000,
        durationDays: 30,
        volumeGb: 10,
        isActive: true,
        telegramStarsSubscriptionEnabled: true,
        telegramStarsSubscriptionPrice: STARS,
        telegramStarsSubscriptionVersion: 1,
      },
    });
    // A PaymentGateway row so the one-time-gateway gate passes.
    await prisma.paymentGateway.create({
      data: { type: "TELEGRAM_STARS", name: `stars-${runTag}`, isEnabled: true },
    });
  });

  beforeEach(async () => {
    editCalls.length = 0;
    refundCalls.length = 0;
    await enableAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("eligibility", () => {
    it("accepts an active 30-day subscription-enabled product", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      expect(isSubscriptionProductEligible(productRel(), service, user.group)).toBe(true);
    });

    it("rejects a non-30-day product", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const p = { ...productRel(), durationDays: 60 };
      expect(isSubscriptionProductEligible(p, service, user.group)).toBe(false);
    });

    it("rejects an out-of-range Stars price", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      expect(isSubscriptionProductEligible({ ...productRel(), telegramStarsSubscriptionPrice: 0 }, service, user.group)).toBe(false);
      expect(isSubscriptionProductEligible({ ...productRel(), telegramStarsSubscriptionPrice: 20000 }, service, user.group)).toBe(false);
    });
  });

  describe("enrollment + exclusivity", () => {
    it("creates a PENDING_PAYMENT subscription + TELEGRAM_STARS mandate", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const r = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      expect(r.status).toBe("ready");
      const sub = await getSubscriptionForService(user.id, service.id);
      expect(sub?.status).toBe("PENDING_PAYMENT");
      expect(sub?.starsAmount).toBe(STARS);
      const mandate = await prisma.serviceAutoRenewalMandate.findUnique({ where: { serviceId: service.id } });
      expect(mandate?.fundingMethod).toBe("TELEGRAM_STARS");
    });

    it("repeated enrollment reuses the same pending subscription", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const a = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      const b = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      expect(a.status).toBe("ready");
      expect(b.status).toBe("ready");
      if (a.status === "ready" && b.status === "ready") {
        expect(b.reused).toBe(true);
        expect(b.subscription.id).toBe(a.subscription.id);
      }
      const count = await prisma.telegramStarsServiceSubscription.count({ where: { serviceId: service.id } });
      expect(count).toBe(1);
    });

    it("blocks enrollment when a wallet mandate is active (without supersede)", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      // Enable wallet auto-renewal + create a wallet mandate.
      await setSetting("wallet_auto_renewal_enabled", "true", "BOOLEAN");
      clearSettingsCache();
      const wallet = await createMandate(user, { service, product: productRel(), maximumChargeToman: 100_000 });
      expect(wallet.ok).toBe(true);
      const r = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      expect(r.status).toBe("wallet-conflict");
      // With supersede, the mandate flips to Stars.
      const r2 = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: true });
      expect(r2.status).toBe("ready");
      const mandate = await prisma.serviceAutoRenewalMandate.findUnique({ where: { serviceId: service.id } });
      expect(mandate?.fundingMethod).toBe("TELEGRAM_STARS");
    });

    it("a Stars mandate blocks a new wallet mandate (serviceId @unique exclusivity)", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      await setSetting("wallet_auto_renewal_enabled", "true", "BOOLEAN");
      clearSettingsCache();
      const wallet = await createMandate(user, { service, product: productRel(), maximumChargeToman: 100_000 });
      expect(wallet.ok).toBe(false); // the mandate already exists (now Stars)
    });
  });

  describe("charge settlement + idempotency", () => {
    async function enrolled(): Promise<{ user: User; service: Service; subId: string }> {
      const user = await makeUser();
      const service = await makeService(user);
      const r = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      if (r.status !== "ready") {
        throw new Error("enrollment failed");
      }
      return { user, service, subId: r.subscription.id };
    }

    it("creates exactly one Payment/Checkout/Order per charge (unreachable panel → refund-required)", async () => {
      const { user, subId } = await enrolled();
      const sub = await prisma.telegramStarsServiceSubscription.findUniqueOrThrow({ where: { id: subId } });
      const chargeId = `tg-charge-${runTag}-a`;
      const result = await settleTelegramStarsSubscriptionCharge(fakeApi, sub, {
        telegramPaymentChargeId: chargeId,
        starsAmount: STARS,
        isFirstRecurring: true,
        subscriptionExpirationDate: new Date(Date.now() + 30 * 86_400_000),
      });
      expect(result.kind).toBe("refund-required");
      const charge = await prisma.telegramStarsSubscriptionCharge.findUniqueOrThrow({
        where: { telegramPaymentChargeId: chargeId },
      });
      expect(charge.status).toBe("REFUND_PENDING");
      expect(charge.paymentId).not.toBeNull();
      expect(charge.orderId).not.toBeNull();
      // Exactly one financial chain.
      const payments = await prisma.payment.count({ where: { externalTransactionId: chargeId } });
      expect(payments).toBe(1);
      // Stars never becomes a WalletTransaction / never credits Toman.
      const walletTx = await prisma.walletTransaction.count({ where: { userId: user.id } });
      expect(walletTx).toBe(0);
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(fresh.balanceToman).toBe(0);
    });

    it("is idempotent: replaying the same charge id creates no second chain", async () => {
      const { subId } = await enrolled();
      const sub = await prisma.telegramStarsServiceSubscription.findUniqueOrThrow({ where: { id: subId } });
      const chargeId = `tg-charge-${runTag}-b`;
      const input = {
        telegramPaymentChargeId: chargeId,
        starsAmount: STARS,
        isFirstRecurring: true,
        subscriptionExpirationDate: new Date(Date.now() + 30 * 86_400_000),
      };
      await settleTelegramStarsSubscriptionCharge(fakeApi, sub, input);
      const second = await settleTelegramStarsSubscriptionCharge(fakeApi, sub, input);
      expect(second.kind).toBe("refund-required"); // replay returns the resolved outcome
      const charges = await prisma.telegramStarsSubscriptionCharge.count({ where: { telegramPaymentChargeId: chargeId } });
      expect(charges).toBe(1);
      const payments = await prisma.payment.count({ where: { externalTransactionId: chargeId } });
      expect(payments).toBe(1);
    });

    it("rejects a charge whose amount != the fixed subscription amount", async () => {
      const { subId } = await enrolled();
      const sub = await prisma.telegramStarsServiceSubscription.findUniqueOrThrow({ where: { id: subId } });
      const result = await settleTelegramStarsSubscriptionCharge(fakeApi, sub, {
        telegramPaymentChargeId: `tg-charge-${runTag}-c`,
        starsAmount: STARS + 50,
        isFirstRecurring: true,
        subscriptionExpirationDate: new Date(Date.now() + 30 * 86_400_000),
      });
      expect(result.kind).toBe("ignored");
    });
  });

  describe("refund (Stars, never wallet)", () => {
    it("refunds the exact charge id, marks REQUIRES_ACTION, cancels extension, no wallet tx", async () => {
      const user = await makeUser();
      const service = await makeService(user);
      const r = await beginStarsEnrollment(user, { service, product: productRel(), supersedeWallet: false });
      if (r.status !== "ready") throw new Error("enroll");
      const sub = await prisma.telegramStarsServiceSubscription.findUniqueOrThrow({ where: { id: r.subscription.id } });
      const chargeId = `tg-charge-${runTag}-refund`;
      // Give the subscription an initial charge id so cancel-extension can run.
      await prisma.telegramStarsServiceSubscription.update({
        where: { id: sub.id },
        data: { initialTelegramPaymentChargeId: `init-${runTag}` },
      });
      await settleTelegramStarsSubscriptionCharge(fakeApi, sub, {
        telegramPaymentChargeId: chargeId,
        starsAmount: STARS,
        isFirstRecurring: false,
        subscriptionExpirationDate: new Date(Date.now() + 30 * 86_400_000),
      });
      const charge = await prisma.telegramStarsSubscriptionCharge.findUniqueOrThrow({
        where: { telegramPaymentChargeId: chargeId },
      });
      const out = await refundStarsSubscriptionCharge(fakeApi, charge.id);
      expect(out.status).toBe("refunded");
      expect(refundCalls.some((c) => c.chargeId === chargeId)).toBe(true);
      expect(editCalls.some((c) => c.canceled === true)).toBe(true);
      const refunded = await prisma.telegramStarsSubscriptionCharge.findUniqueOrThrow({ where: { id: charge.id } });
      expect(refunded.status).toBe("REFUNDED");
      const freshSub = await prisma.telegramStarsServiceSubscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(freshSub.status).toBe("REQUIRES_ACTION");
      expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
      // Idempotent: a second refund does not re-call Telegram.
      const before = refundCalls.length;
      const again = await refundStarsSubscriptionCharge(fakeApi, charge.id);
      expect(again.status).toBe("already-refunded");
      expect(refundCalls.length).toBe(before);
    });
  });
});
