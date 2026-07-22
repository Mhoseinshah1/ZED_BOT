import { randomUUID } from "node:crypto";

import { prisma, type User } from "@zedbot/database";
import {
  normalizeIranMobile,
  representativePercentDiscountToman,
  resolveRepresentativeBasePrice,
} from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "representative-program-tests-secret-0001";

import type { CheckoutDraft } from "../src/core/session.js";
import { creditReferralCommissionForOrder } from "../src/services/referral-commission.service.js";

// Global referral-setting keys we temporarily touch for the §17 exclusion test.
// We set them the SAME way the referral suite does (enabled + epoch horizon, NO
// explicit payout-window row so the horizon-synthesis fallback opens a window)
// and DELETE them afterwards, so we never leave a closed-window row that would
// pollute the referral-commission suite when the files run together.
const REFERRAL_KEYS = [
  "referral_system_enabled",
  "referral_commissions_started_at",
  "referral_payout_windows",
] as const;

async function withReferralEnabled<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.setting.upsert({
    where: { key: "referral_system_enabled" },
    create: { key: "referral_system_enabled", value: "true", type: "BOOLEAN" },
    update: { value: "true", type: "BOOLEAN" },
  });
  await prisma.setting.upsert({
    where: { key: "referral_commissions_started_at" },
    create: { key: "referral_commissions_started_at", value: new Date(0).toISOString(), type: "STRING" },
    update: { value: new Date(0).toISOString(), type: "STRING" },
  });
  clearSettingsCache();
  try {
    return await fn();
  } finally {
    await prisma.setting.deleteMany({ where: { key: { in: [...REFERRAL_KEYS] } } });
    clearSettingsCache();
  }
}
import {
  isRepresentativePricedCheckout,
  resolveEffectiveProductPrice,
} from "../src/services/representative-pricing.service.js";
import {
  approveRepresentativeApplication,
  findOpenApplication,
  rejectRepresentativeApplication,
  submitRepresentativeApplication,
  suspendRepresentative,
  terminateRepresentative,
  withdrawRepresentativeApplication,
} from "../src/services/representative.service.js";
import {
  setRepresentativeApplicationsEnabled,
  setRepresentativeCheckoutEnabled,
  setRepresentativeProgramEnabled,
} from "../src/services/representative-settings.service.js";
import {
  createRepresentativeTier,
  setRepresentativeTierActive,
  upsertRepresentativeProductPrice,
} from "../src/services/representative-tier.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";

// =============================================================================
// Representative Program — end-to-end integration + isolation proof (§26).
// Real PostgreSQL + password-Redis. Skips itself without DATABASE_URL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const RETAIL = 100_000;

let panelId: string;
let categoryId: string;
let serviceProductId: string;
let otherProductId: string;
let adminId: string;

function tgId(): bigint {
  return runTag + BigInt(Math.floor(Math.random() * 1_000_000_000));
}

async function createUser(balanceToman = 1_000_000): Promise<User> {
  return prisma.user.create({ data: { telegramId: tgId(), balanceToman } });
}

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fullName: "علی رضایی",
    phone: "09123456789",
    province: "تهران",
    city: "تهران",
    salesChannel: "TELEGRAM",
    expectedMonthlyCustomers: 50,
    experience: "دو سال فروش",
    explanation: "می‌خواهم به عنوان نماینده فعالیت کنم و مشتریان خود را جذب کنم.",
    ...overrides,
  };
}

async function makeActiveRep(user: User, tierId: string | null): Promise<string> {
  const app = await prisma.representativeApplication.create({
    data: {
      userId: user.id,
      status: "PENDING_REVIEW",
      fullName: "x",
      phone: "09120000000",
      province: "x",
      city: "x",
      salesChannel: "OTHER",
      expectedMonthlyCustomers: 1,
      explanation: "x".repeat(30),
      submittedAt: new Date(),
    },
  });
  const result = await approveRepresentativeApplication({
    applicationId: app.id,
    adminId,
    tierId,
  });
  if (!result.ok) throw new Error(`approve failed: ${result.code}`);
  return result.representative.id;
}

async function makeTierWithPrice(
  mode: "FIXED_TOMAN" | "PERCENT_DISCOUNT",
  value: number,
): Promise<string> {
  const t = await createRepresentativeTier({
    name: `tier-${randomUUID().slice(0, 8)}`,
    description: null,
    adminId,
  });
  if (!t.ok) throw new Error("tier create failed");
  const p = await upsertRepresentativeProductPrice({
    tierId: t.tier.id,
    productId: serviceProductId,
    adminId,
    mode,
    fixedPriceToman: mode === "FIXED_TOMAN" ? value : null,
    percentValue: mode === "PERCENT_DISCOUNT" ? value : null,
  });
  if (!p.ok) throw new Error(`price set failed: ${p.code}`);
  return t.tier.id;
}

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `rep-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
      username: "admin",
      passwordEncrypted: "enc",
      templateUsername: "tpl",
    },
  });
  panelId = panel.id;
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `rep-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const sp = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId,
      name: `rep-service-${runTag}`,
      priceToman: RETAIL,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
      representativeEligible: true,
    },
  });
  serviceProductId = sp.id;
  const otherCat = await prisma.productCategory.create({
    data: { type: "OTHER_PRODUCT", name: `rep-ocat-${runTag}`, isActive: true },
  });
  const op = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId: otherCat.id,
      name: `rep-other-${runTag}`,
      priceToman: RETAIL,
      isActive: true,
      representativeEligible: true,
    },
  });
  otherProductId = op.id;
  const admin = await prisma.admin.create({
    data: { telegramId: tgId(), role: "OWNER", firstName: "owner" },
  });
  adminId = admin.id;
  await setRepresentativeProgramEnabled(true);
  await setRepresentativeApplicationsEnabled(true);
  await setRepresentativeCheckoutEnabled(true);
  clearSettingsCache();
});

afterAll(async () => {
  if (!hasDb) return;
  await setRepresentativeProgramEnabled(false);
  await setRepresentativeApplicationsEnabled(false);
  await setRepresentativeCheckoutEnabled(false);
  clearSettingsCache();
});

beforeEach(() => {
  clearSettingsCache();
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("pricing math (pure)", () => {
  it("FIXED_TOMAN resolves the exact price and saving", () => {
    const r = resolveRepresentativeBasePrice({ mode: "FIXED_TOMAN", retailToman: RETAIL, fixedPriceToman: 70_000 });
    expect(r.ok && r.representativePriceToman).toBe(70_000);
    expect(r.ok && r.savedAmountToman).toBe(30_000);
  });
  it("PERCENT_DISCOUNT floors the discount (never underpays the percentage)", () => {
    // 33% of 100001 = 33000.33 → floor 33000
    expect(representativePercentDiscountToman(100_001, 33)).toBe(33_000);
    const r = resolveRepresentativeBasePrice({ mode: "PERCENT_DISCOUNT", retailToman: 100_001, percentDiscount: 33 });
    expect(r.ok && r.representativePriceToman).toBe(100_001 - 33_000);
  });
  it("FIXED above retail fails closed (never overcharges)", () => {
    const r = resolveRepresentativeBasePrice({ mode: "FIXED_TOMAN", retailToman: RETAIL, fixedPriceToman: RETAIL + 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("ABOVE_RETAIL");
  });
  it("PERCENT out of range fails closed", () => {
    expect(resolveRepresentativeBasePrice({ mode: "PERCENT_DISCOUNT", retailToman: RETAIL, percentDiscount: 96 }).ok).toBe(false);
    expect(resolveRepresentativeBasePrice({ mode: "PERCENT_DISCOUNT", retailToman: RETAIL, percentDiscount: 0 }).ok).toBe(false);
  });
  it("normalizes Iranian mobile variants", () => {
    expect(normalizeIranMobile("+989123456789")).toBe("09123456789");
    expect(normalizeIranMobile("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
    expect(normalizeIranMobile("12345")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("effective price resolver", () => {
  it("non-representative gets RETAIL byte-identical to product.priceToman", async () => {
    const user = await createUser();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const r = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE" });
    expect(r.pricingMode).toBe("RETAIL");
    expect(r.finalPriceToman).toBe(RETAIL);
    expect(r.basePriceToman).toBe(RETAIL);
  });

  it("active representative with FIXED tier price gets REPRESENTATIVE pricing", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const r = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE", mode: "PREVIEW" });
    expect(r.pricingMode).toBe("REPRESENTATIVE");
    expect(r.finalPriceToman).toBe(60_000);
  });

  it("OTHER_PRODUCT never gets representative pricing", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("PERCENT_DISCOUNT", 30);
    await makeActiveRep(user, tierId);
    const other = await prisma.product.findUniqueOrThrow({ where: { id: otherProductId } });
    const r = await resolveEffectiveProductPrice({ user, product: other, checkoutPurpose: "PURCHASE" });
    expect(r.pricingMode).toBe("RETAIL");
  });

  it("RENEWAL purpose stays retail", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 50_000);
    await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const r = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "RENEWAL" });
    expect(r.pricingMode).toBe("RETAIL");
  });

  it("archiving an in-use tier is blocked (§18 safe blocking)", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 55_000);
    await makeActiveRep(user, tierId);
    const archive = await setRepresentativeTierActive({ tierId, adminId, active: false });
    expect(archive.ok).toBe(false);
    expect(!archive.ok && archive.code).toBe("CONFLICTING_OPERATION");
  });

  it("an inactive assigned tier defensively blocks reseller pricing (falls back to retail)", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 55_000);
    await makeActiveRep(user, tierId);
    // Force the tier inactive directly (the service guard normally prevents this
    // while a rep uses it); the resolver must still fail closed to retail.
    await prisma.representativeTier.update({ where: { id: tierId }, data: { isActive: false } });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const r = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE" });
    expect(r.pricingMode).toBe("RETAIL");
  });

  it("suspended representative gets no reseller price", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 40_000);
    const repId = await makeActiveRep(user, tierId);
    await suspendRepresentative({ representativeId: repId, adminId, reason: "test" });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const r = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE" });
    expect(r.pricingMode).toBe("RETAIL");
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("applications", () => {
  it("submits a PENDING_REVIEW application; a duplicate update converges", async () => {
    const user = await createUser();
    const updId = BigInt(Math.floor(Math.random() * 1_000_000_000));
    const first = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: updId, input: validInput() });
    expect(first.ok).toBe(true);
    const replay = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: updId, input: validInput() });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(replay.ok && replay.application.id).toBe(first.ok && first.application.id);
    const count = await prisma.representativeApplication.count({ where: { userId: user.id } });
    expect(count).toBe(1);
  });

  it("rejects invalid input", async () => {
    const user = await createUser();
    const r = await submitRepresentativeApplication({
      userId: user.id,
      sourceUpdateId: null,
      input: validInput({ explanation: "کوتاه" }),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("VALIDATION");
  });

  it("at most ONE open application per user (partial unique index converges)", async () => {
    const user = await createUser();
    const first = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: null, input: validInput() });
    expect(first.ok).toBe(true);
    // A second submit from a different update converges to the existing open row
    // (never a second pending) — the DB partial unique guard enforces it.
    const second = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: null, input: validInput() });
    expect(second.ok).toBe(true);
    const openCount = await prisma.representativeApplication.count({
      where: { userId: user.id, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
    });
    expect(openCount).toBe(1);
  });

  it("allows withdraw then reapply", async () => {
    const user = await createUser();
    const s = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: null, input: validInput() });
    expect(s.ok).toBe(true);
    const open = await findOpenApplication(user.id);
    const w = await withdrawRepresentativeApplication({ userId: user.id, applicationId: open!.id });
    expect(w.ok).toBe(true);
    const again = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: null, input: validInput() });
    expect(again.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("lifecycle", () => {
  it("approval creates exactly ONE representative even under a duplicate call", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    const app = await prisma.representativeApplication.create({
      data: {
        userId: user.id,
        status: "PENDING_REVIEW",
        fullName: "x",
        phone: "09120000000",
        province: "x",
        city: "x",
        salesChannel: "OTHER",
        expectedMonthlyCustomers: 1,
        explanation: "x".repeat(30),
        submittedAt: new Date(),
      },
    });
    const a = await approveRepresentativeApplication({ applicationId: app.id, adminId, tierId });
    const b = await approveRepresentativeApplication({ applicationId: app.id, adminId, tierId });
    expect(a.ok && b.ok).toBe(true);
    const reps = await prisma.representative.count({ where: { userId: user.id } });
    expect(reps).toBe(1);
  });

  it("rejection requires a reason and stores it", async () => {
    const user = await createUser();
    const app = await prisma.representativeApplication.create({
      data: {
        userId: user.id,
        status: "PENDING_REVIEW",
        fullName: "x",
        phone: "09120000000",
        province: "x",
        city: "x",
        salesChannel: "OTHER",
        expectedMonthlyCustomers: 1,
        explanation: "x".repeat(30),
        submittedAt: new Date(),
      },
    });
    const bad = await rejectRepresentativeApplication({ applicationId: app.id, adminId, reason: "" });
    expect(bad.ok).toBe(false);
    const ok = await rejectRepresentativeApplication({ applicationId: app.id, adminId, reason: "مدارک ناقص" });
    expect(ok.ok && ok.application.decisionReason).toBe("مدارک ناقص");
  });

  it("terminate is irreversible and retains history", async () => {
    const user = await createUser();
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    const repId = await makeActiveRep(user, tierId);
    const t = await terminateRepresentative({ representativeId: repId, adminId, reason: "violation" });
    expect(t.ok && t.representative.status).toBe("TERMINATED");
    // re-apply is blocked for a terminated user
    const reapply = await submitRepresentativeApplication({ userId: user.id, sourceUpdateId: null, input: validInput() });
    expect(reapply.ok).toBe(false);
    expect(!reapply.ok && reapply.code).toBe("TERMINATED");
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("reseller checkout + financial isolation", () => {
  it("wallet reseller purchase charges the reseller price, links a marker, adds NO extra ledger", async () => {
    const user = await createUser(1_000_000);
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const effective = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE", mode: "PREVIEW" });
    expect(effective.pricingMode).toBe("REPRESENTATIVE");

    const draft: CheckoutDraft = {
      productId: serviceProductId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: effective.basePriceToman,
      discountAmountToman: 0,
      finalPriceToman: effective.finalPriceToman,
      draftNonce: randomUUID(),
      representative:
        effective.pricingMode === "REPRESENTATIVE"
          ? {
              representativeId: effective.representativeId,
              tierId: effective.tierId,
              tierSlug: effective.tierSlug,
              priceMode: effective.priceMode,
              retailPriceToman: effective.retailPriceToman,
              basePriceToman: effective.basePriceToman,
              tierFingerprint: effective.tierFingerprint,
              priceFingerprint: effective.priceFingerprint,
            }
          : undefined,
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // charged the reseller price, not retail
    expect(result.order.finalPriceToman).toBe(60_000);
    // exactly ONE spend wallet transaction for this payment
    const walletTx = await prisma.walletTransaction.count({ where: { relatedPaymentId: result.payment.id } });
    expect(walletTx).toBe(1);
    // the checkout snapshot carries the REPRESENTATIVE marker
    expect(await isRepresentativePricedCheckout(result.checkout.id)).toBe(true);
    // a completed RepresentativePurchase links checkout+order+payment
    const marker = await prisma.representativePurchase.findUnique({
      where: { checkoutSessionId: result.checkout.id },
    });
    expect(marker?.status).toBe("COMPLETED");
    expect(marker?.orderId).toBe(result.order.id);
    expect(marker?.retailPriceToman).toBe(RETAIL);
  });

  it("a reseller-priced order earns NO referral commission (§17)", async () => {
    // referrer + referred rep
    const referrer = await createUser();
    const user = await createUser(1_000_000);
    await prisma.referral.create({
      data: { referrerUserId: referrer.id, referredUserId: user.id },
    });
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const effective = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE", mode: "PREVIEW" });
    const draft: CheckoutDraft = {
      productId: serviceProductId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: effective.basePriceToman,
      discountAmountToman: 0,
      finalPriceToman: effective.finalPriceToman,
      draftNonce: randomUUID(),
      representative:
        effective.pricingMode === "REPRESENTATIVE"
          ? {
              representativeId: effective.representativeId,
              tierId: effective.tierId,
              tierSlug: effective.tierSlug,
              priceMode: effective.priceMode,
              retailPriceToman: effective.retailPriceToman,
              basePriceToman: effective.basePriceToman,
              tierFingerprint: effective.tierFingerprint,
              priceFingerprint: effective.priceFingerprint,
            }
          : undefined,
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Enable referral (isolation-safe) so the engine proceeds PAST the master
    // switch + horizon and actually reaches the representative exclusion (§17).
    await withReferralEnabled(async () => {
      await prisma.order.update({
        where: { id: result.order.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      const credit = await creditReferralCommissionForOrder(result.order.id);
      expect(credit.status).toBe("representative-excluded");
    });
    // no PAID commission exists
    const paid = await prisma.referralCommission.count({
      where: { orderId: result.order.id, status: "PAID" },
    });
    expect(paid).toBe(0);
    // referrer balance unchanged (still the created default)
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(fresh.balanceToman).toBe(referrer.balanceToman);
  });

  it("stale reseller pricing fails closed at settlement (fingerprint mismatch)", async () => {
    const user = await createUser(1_000_000);
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const effective = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE", mode: "PREVIEW" });
    const draft: CheckoutDraft = {
      productId: serviceProductId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: 60_000,
      discountAmountToman: 0,
      finalPriceToman: 60_000,
      draftNonce: randomUUID(),
      representative:
        effective.pricingMode === "REPRESENTATIVE"
          ? {
              representativeId: effective.representativeId,
              tierId: effective.tierId,
              tierSlug: effective.tierSlug,
              priceMode: effective.priceMode,
              retailPriceToman: effective.retailPriceToman,
              basePriceToman: effective.basePriceToman,
              // corrupt the fingerprints → stale
              tierFingerprint: "stale",
              priceFingerprint: "stale",
            }
          : undefined,
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(false);
  });

  it("a paid Order remains fulfillable after the representative is suspended (§16)", async () => {
    const user = await createUser(1_000_000);
    const tierId = await makeTierWithPrice("FIXED_TOMAN", 60_000);
    const repId = await makeActiveRep(user, tierId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: serviceProductId } });
    const effective = await resolveEffectiveProductPrice({ user, product, checkoutPurpose: "PURCHASE", mode: "PREVIEW" });
    const draft: CheckoutDraft = {
      productId: serviceProductId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: effective.basePriceToman,
      discountAmountToman: 0,
      finalPriceToman: effective.finalPriceToman,
      draftNonce: randomUUID(),
      representative:
        effective.pricingMode === "REPRESENTATIVE"
          ? {
              representativeId: effective.representativeId,
              tierId: effective.tierId,
              tierSlug: effective.tierSlug,
              priceMode: effective.priceMode,
              retailPriceToman: effective.retailPriceToman,
              basePriceToman: effective.basePriceToman,
              tierFingerprint: effective.tierFingerprint,
              priceFingerprint: effective.priceFingerprint,
            }
          : undefined,
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // suspend AFTER settlement
    await suspendRepresentative({ representativeId: repId, adminId, reason: "later" });
    // the paid Order is untouched — still PAID and linked to the payment
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.order.id } });
    expect(["PAID", "COMPLETED"]).toContain(order.status);
    expect(order.paymentId).toBe(result.payment.id);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("regression: retail checkout unchanged", () => {
  it("a non-representative wallet purchase pays retail with no marker and no rep snapshot", async () => {
    const user = await createUser(1_000_000);
    const draft: CheckoutDraft = {
      productId: serviceProductId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: RETAIL,
      discountAmountToman: 0,
      finalPriceToman: RETAIL,
      draftNonce: randomUUID(),
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.finalPriceToman).toBe(RETAIL);
    expect(await isRepresentativePricedCheckout(result.checkout.id)).toBe(false);
    const marker = await prisma.representativePurchase.findUnique({
      where: { checkoutSessionId: result.checkout.id },
    });
    expect(marker).toBeNull();
  });
});
