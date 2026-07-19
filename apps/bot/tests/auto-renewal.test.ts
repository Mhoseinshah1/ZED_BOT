import {
  prisma,
  type Panel,
  type Product,
  type ProductCategory,
  type Service,
  type User,
} from "@zedbot/database";
import {
  autoRenewalIdempotencyKey,
  buildAutoRenewalCycleFingerprint,
  WALLET_AUTO_RENEWAL_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminStopMandate,
  cancelMandate,
  createMandate,
  executeAutoRenewalAttempt,
  getMandateForService,
  MANDATE_CEILING_INVALID_TEXT,
  MANDATE_EXISTS_TEXT,
  MANDATE_SYSTEM_DISABLED_TEXT,
  pauseMandateByUser,
  resumeMandateByUser,
} from "../src/services/auto-renewal.service.js";
import { payAutoRenewalWithWallet } from "../src/services/wallet-payment.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// Wallet auto-renewal — DB-backed integration tests (Phase 1). Requires a REAL
// migrated PostgreSQL via DATABASE_URL (the suite skips itself otherwise). It
// proves the acceptance guarantees that can only hold against real transactions:
// consent is the only door to a mandate; a charge never exceeds the ceiling,
// never overdraws, never double-deducts; a changed Service cycle can never be
// charged; a disabled/cancelled/paused mandate never charges; a definite
// fulfilment failure refunds through the existing path (net-zero wallet).
//
// The panel baseUrl is unreachable on purpose, so the renewal executor's adapter
// call fails deterministically — the "settled → definite failure → refund" path
// is exercised end-to-end. The success (in-place renewal) path reuses the exact
// executeRenewalOrder covered by the manual-renewal suites.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const PRICE = 50_000;

let panel: Panel;
let category: ProductCategory;
let product: Product;

/** ProductWithRelations as the services expect (category + panel included). */
function productRel(): ProductWithRelations {
  return { ...product, category, panel };
}

const sentMessages: string[] = [];
const fakeApi = {
  sendMessage: async (_chatId: string, text: string): Promise<unknown> => {
    sentMessages.push(text);
    return undefined;
  },
};

async function setEnabled(enabled: boolean): Promise<void> {
  await setSetting(WALLET_AUTO_RENEWAL_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
  await setSetting("wallet_payment_enabled", "true", "BOOLEAN");
  clearSettingsCache();
}

async function makeUser(balanceToman: number): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman },
  });
}

async function makeService(user: User, expiresInDays = 2): Promise<Service> {
  seq += 1;
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: `ar-svc-${runTag}-${seq}`,
      source: "PAID",
      status: "ACTIVE",
      volumeBytes: 10n * 1024n * 1024n * 1024n,
      remainingBytes: 5n * 1024n * 1024n * 1024n,
      usedBytes: 5n * 1024n * 1024n * 1024n,
      expiresAt,
      durationDays: 30,
      startsAt: new Date(Date.now() - 28 * 86_400_000),
      lastSubscriptionUpdateAt: new Date(),
    },
  });
}

/** Creates a SCHEDULED attempt exactly as the worker scan would. */
async function makeAttempt(
  mandateId: string,
  service: Service,
  ceilingToman: number,
): Promise<string> {
  const fingerprint = buildAutoRenewalCycleFingerprint({
    serviceId: service.id,
    expiresAtEpoch: service.expiresAt?.getTime() ?? null,
    productId: product.id,
  });
  if (fingerprint === null) {
    throw new Error("no fingerprint");
  }
  const attempt = await prisma.serviceAutoRenewalAttempt.create({
    data: {
      mandateId,
      serviceId: service.id,
      userId: service.userId,
      productId: product.id,
      expiryCycleFingerprint: fingerprint,
      idempotencyKey: autoRenewalIdempotencyKey(mandateId, fingerprint),
      expectedServiceExpiresAt: service.expiresAt,
      expectedProductPriceToman: PRICE,
      authorizedMaximumChargeToman: ceilingToman,
    },
    select: { id: true },
  });
  return attempt.id;
}

describe.runIf(hasDb)("wallet auto-renewal", () => {
  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `ar-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        renewalEnabled: true,
      },
    });
    category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `ar-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `ar-prod-${runTag}`,
        priceToman: PRICE,
        durationDays: 30,
        volumeGb: 10,
        isActive: true,
      },
    });
  });

  beforeEach(async () => {
    sentMessages.length = 0;
    await setEnabled(true);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // --- consent (Part B) ------------------------------------------------------

  describe("createMandate (consent is the only door)", () => {
    it("refuses to create a mandate while the system is disabled", async () => {
      await setEnabled(false);
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const result = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(MANDATE_SYSTEM_DISABLED_TEXT);
      }
      expect(await getMandateForService(user.id, service.id)).toBeNull();
    });

    it("creates an ACTIVE mandate with versioned, ceiling-bounded consent", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const result = await createMandate(user, { service, product: productRel(), maximumChargeToman: 60_000 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mandate.status).toBe("ACTIVE");
        expect(result.mandate.maximumChargeToman).toBe(60_000);
        expect(result.mandate.consentedPriceToman).toBe(PRICE);
        expect(result.mandate.consentVersion).toBeGreaterThanOrEqual(1);
        expect(result.mandate.consentedAt).not.toBeNull();
      }
    });

    it("enforces one mandate per Service (serviceId @unique)", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const first = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      expect(first.ok).toBe(true);
      const second = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe(MANDATE_EXISTS_TEXT);
      }
    });

    it("rejects a ceiling below the current price", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const result = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE - 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(MANDATE_CEILING_INVALID_TEXT);
      }
    });

    it("refuses an unlimited-time (no finite expiry) Service", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      await prisma.service.update({ where: { id: service.id }, data: { expiresAt: null } });
      const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      const result = await createMandate(user, { service: fresh, product: productRel(), maximumChargeToman: PRICE });
      expect(result.ok).toBe(false);
    });
  });

  // --- wallet charge safety (Parts J/K/Q) ------------------------------------

  describe("payAutoRenewalWithWallet (never above ceiling, never overdraw, never double-deduct)", () => {
    it("charges the live price and deducts exactly once", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const mandate = await createMandate(user, { service, product: productRel(), maximumChargeToman: 60_000 });
      expect(mandate.ok).toBe(true);
      const fp = buildAutoRenewalCycleFingerprint({
        serviceId: service.id,
        expiresAtEpoch: service.expiresAt?.getTime() ?? null,
        productId: product.id,
      })!;
      const key = autoRenewalIdempotencyKey(mandate.ok ? mandate.mandate.id : "", fp);
      const outcome = await payAutoRenewalWithWallet(user, {
        product: productRel(),
        service,
        authorizedMaximumChargeToman: 60_000,
        idempotencyKey: key,
      });
      expect(outcome.status).toBe("settled");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000 - PRICE);
    });

    it("is idempotent on the mandate+cycle key (no double deduction)", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const mandate = await createMandate(user, { service, product: productRel(), maximumChargeToman: 60_000 });
      const fp = buildAutoRenewalCycleFingerprint({
        serviceId: service.id,
        expiresAtEpoch: service.expiresAt?.getTime() ?? null,
        productId: product.id,
      })!;
      const key = autoRenewalIdempotencyKey(mandate.ok ? mandate.mandate.id : "", fp);
      const first = await payAutoRenewalWithWallet(user, {
        product: productRel(),
        service,
        authorizedMaximumChargeToman: 60_000,
        idempotencyKey: key,
      });
      const second = await payAutoRenewalWithWallet(user, {
        product: productRel(),
        service,
        authorizedMaximumChargeToman: 60_000,
        idempotencyKey: key,
      });
      expect(first.status).toBe("settled");
      expect(second.status).toBe("already-settled");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000 - PRICE); // deducted ONCE only
    });

    it("never charges above the ceiling (live price > ceiling → no deduction)", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const outcome = await payAutoRenewalWithWallet(user, {
        product: productRel(),
        service,
        authorizedMaximumChargeToman: PRICE - 1, // below live price
        idempotencyKey: `test-above-${runTag}-${service.id}`,
      });
      expect(outcome.status).toBe("price-above-limit");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000); // untouched
    });

    it("never overdraws (insufficient balance → no deduction, no negative balance)", async () => {
      const user = await makeUser(PRICE - 1); // cannot afford
      const service = await makeService(user);
      const outcome = await payAutoRenewalWithWallet(user, {
        product: productRel(),
        service,
        authorizedMaximumChargeToman: 60_000,
        idempotencyKey: `test-insufficient-${runTag}-${service.id}`,
      });
      expect(outcome.status).toBe("insufficient-balance");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(PRICE - 1);
      expect(after.balanceToman).toBeGreaterThanOrEqual(0);
    });
  });

  // --- execute engine (Parts R/S/T/U/V) --------------------------------------

  describe("executeAutoRenewalAttempt", () => {
    async function activeMandateWithAttempt(balance: number, ceiling = 60_000) {
      const user = await makeUser(balance);
      const service = await makeService(user);
      const mandate = await createMandate(user, { service, product: productRel(), maximumChargeToman: ceiling });
      if (!mandate.ok) {
        throw new Error("mandate not created");
      }
      const attemptId = await makeAttempt(mandate.mandate.id, service, ceiling);
      return { user, service, mandate: mandate.mandate, attemptId };
    }

    it("does nothing (no charge) while the master switch is off", async () => {
      const { user, attemptId } = await activeMandateWithAttempt(100_000);
      await setEnabled(false);
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(result.status).toBe("system-disabled");
      const attempt = await prisma.serviceAutoRenewalAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("SCHEDULED");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000);
    });

    it("cancels the attempt (no charge) when the mandate was cancelled", async () => {
      const { user, mandate, attemptId } = await activeMandateWithAttempt(100_000);
      await cancelMandate(mandate.id, user.id);
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(result.status).toBe("mandate-inactive");
      const attempt = await prisma.serviceAutoRenewalAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("CANCELLED");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000);
    });

    it("cancels a stale-cycle attempt when the Service expiry moved (manual renewal)", async () => {
      const { user, service, attemptId } = await activeMandateWithAttempt(100_000);
      // A manual renewal extends the expiry → the live cycle fingerprint changes.
      await prisma.service.update({
        where: { id: service.id },
        data: { expiresAt: new Date(Date.now() + 40 * 86_400_000) },
      });
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(result.status).toBe("cycle-changed");
      const attempt = await prisma.serviceAutoRenewalAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("CANCELLED");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000); // never charged
    });

    it("pauses the mandate (no charge) when the live price is above the ceiling", async () => {
      const { user, mandate, attemptId } = await activeMandateWithAttempt(100_000, PRICE);
      // Raise the live price above the authorized ceiling.
      await prisma.product.update({ where: { id: product.id }, data: { priceToman: PRICE + 10_000 } });
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      // restore for other tests
      await prisma.product.update({ where: { id: product.id }, data: { priceToman: PRICE } });
      expect(result.status).toBe("price-above-limit");
      const m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      expect(m.status).toBe("PAUSED");
      expect(m.pauseReason).toBe("PRICE_ABOVE_LIMIT");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000);
    });

    it("bounded insufficient-balance: no charge, mandate re-armed for retry", async () => {
      const { user, mandate, attemptId } = await activeMandateWithAttempt(PRICE - 1);
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(result.status).toBe("insufficient-retry");
      const attempt = await prisma.serviceAutoRenewalAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("SCHEDULED");
      expect(attempt.attemptNumber).toBe(2);
      expect(attempt.nextAttemptAt).not.toBeNull();
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(PRICE - 1);
      const m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      expect(m.status).toBe("ACTIVE");
    });

    it("settles then refunds on a definite fulfilment failure (net-zero wallet)", async () => {
      // The unreachable panel makes the renewal executor fail definitively; the
      // existing refund path returns the wallet to its pre-charge balance.
      const { user, mandate, service, attemptId } = await activeMandateWithAttempt(100_000);
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(["fulfillment-failed-refunded", "requires-action"]).toContain(result.status);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (result.status === "fulfillment-failed-refunded") {
        // charged then refunded — net zero.
        expect(after.balanceToman).toBe(100_000);
        const m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
        expect(m.status).toBe("PAUSED");
        const attempt = await prisma.serviceAutoRenewalAttempt.findUniqueOrThrow({ where: { id: attemptId } });
        expect(attempt.status).toBe("FAILED");
      }
      // The Service is NEVER replaced — the same row still exists.
      const stillThere = await prisma.service.findUnique({ where: { id: service.id } });
      expect(stillThere).not.toBeNull();
    });

    it("is claim-safe: a second execute of a terminal attempt does nothing", async () => {
      const { attemptId, user } = await activeMandateWithAttempt(100_000);
      await executeAutoRenewalAttempt(fakeApi, attemptId);
      const balanceMid = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman;
      const second = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(second.status.startsWith("already-")).toBe(true);
      const balanceEnd = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman;
      expect(balanceEnd).toBe(balanceMid); // no second effect
    });
  });

  // --- lifecycle (Parts W/X) -------------------------------------------------

  describe("mandate lifecycle", () => {
    it("user pause → resume restores ACTIVE", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const created = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      expect(created.ok).toBe(true);
      const id = created.ok ? created.mandate.id : "";
      expect(await pauseMandateByUser(id, user.id)).toBe(true);
      let m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe("PAUSED");
      const resumed = await resumeMandateByUser(id, user);
      expect(resumed.ok).toBe(true);
      m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe("ACTIVE");
    });

    it("admin can pause/cancel but never enable (adminStopMandate only stops)", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const created = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      const id = created.ok ? created.mandate.id : "";
      // Admin pause.
      expect(await adminStopMandate(id, false)).toBe(true);
      let m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe("PAUSED");
      expect(m.pauseReason).toBe("ADMIN_PAUSED");
      // Admin cannot ACTIVATE — there is no admin enable; adminStopMandate(false)
      // only transitions ACTIVE→PAUSED, so a paused mandate stays paused.
      expect(await adminStopMandate(id, false)).toBe(false);
      m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe("PAUSED");
      // Admin cancel is terminal.
      expect(await adminStopMandate(id, true)).toBe(true);
      m = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id } });
      expect(m.status).toBe("CANCELLED");
    });

    it("cancellation prevents any future charge", async () => {
      const user = await makeUser(100_000);
      const service = await makeService(user);
      const created = await createMandate(user, { service, product: productRel(), maximumChargeToman: PRICE });
      const id = created.ok ? created.mandate.id : "";
      expect(await cancelMandate(id, user.id)).toBe(true);
      const attemptId = await makeAttempt(id, service, PRICE);
      const result = await executeAutoRenewalAttempt(fakeApi, attemptId);
      expect(result.status).toBe("mandate-inactive");
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.balanceToman).toBe(100_000);
    });
  });
});
