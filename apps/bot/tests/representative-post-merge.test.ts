import { randomUUID } from "node:crypto";

import { prisma, type Panel, type User } from "@zedbot/database";
import { isRepresentativeStatus } from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "representative-post-merge-tests-secret-0001";

import type { BotContext } from "../src/core/context.js";
import type { CheckoutDraft, SessionData } from "../src/core/session.js";
import { initialSession } from "../src/core/session.js";
import { representativeHandler } from "../src/handlers/user-representative/representative.handler.js";
import {
  isProductStructurallySellable,
  isProductVisible,
} from "../src/services/catalog.service.js";
import { createCheckoutSession } from "../src/services/checkout.service.js";
import {
  setProductRepresentativeEligible,
  type ProductWithRelations,
} from "../src/services/product.service.js";
import {
  listEligibleRepresentativeProducts,
  resolveEffectiveProductPrice,
} from "../src/services/representative-pricing.service.js";
import {
  approveRepresentativeApplication,
  findOpenApplication,
  getRepresentativeDashboardStats,
} from "../src/services/representative.service.js";
import {
  setRepresentativeApplicationsEnabled,
  setRepresentativeCheckoutEnabled,
  setRepresentativeProgramEnabled,
} from "../src/services/representative-settings.service.js";
import {
  createRepresentativeTier,
  listTierProductPrices,
  upsertRepresentativeProductPrice,
} from "../src/services/representative-tier.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { OPS_EVENTS } from "../src/services/system-log.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";

// =============================================================================
// Representative Program — post-merge gap fixes (PR #121 follow-up):
//   F. OWNER product-eligibility control (Product.representativeEligible).
//   G. Reseller catalog filtered by the ONE authoritative purchasability
//      predicate (isProductVisible) — hidden/inactive/unready/invalid never show.
//   H. TERMINATED representatives get a read-only terminal page (no apply/buy
//      loop) via an exhaustive typed status switch.
// Plus the external-payment settlement policy regression (a later product
// opt-out never cancels an already-paid reseller fulfillment).
// Real PostgreSQL + password-Redis; DB blocks skip without DATABASE_URL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const RETAIL = 100_000;
const REP_PRICE = 60_000;

let sellablePanelId: string;
let serviceCategoryId: string;
let adminId: string;

function tgId(): bigint {
  return runTag + BigInt(Math.floor(Math.random() * 1_000_000_000));
}

async function createUser(): Promise<User> {
  return prisma.user.create({ data: { telegramId: tgId(), balanceToman: 1_000_000, group: "F" } });
}

async function createServiceProduct(
  overrides: Record<string, unknown> = {},
): Promise<ProductWithRelations> {
  const created = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: serviceCategoryId,
      panelId: sellablePanelId,
      name: `pm-svc-${runTag}-${randomUUID().slice(0, 8)}`,
      priceToman: RETAIL,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
      displayGroups: ["ALL"],
      representativeEligible: true,
      ...overrides,
    },
  });
  return prisma.product.findUniqueOrThrow({
    where: { id: created.id },
    include: { category: true, panel: true },
  });
}

async function makeTier(): Promise<string> {
  const t = await createRepresentativeTier({
    name: `tier-${runTag}-${randomUUID().slice(0, 8)}`,
    description: null,
    adminId,
  });
  if (!t.ok) throw new Error("tier create failed");
  return t.tier.id;
}

async function addPrice(tierId: string, productId: string): Promise<void> {
  const p = await upsertRepresentativeProductPrice({
    tierId,
    productId,
    adminId,
    mode: "FIXED_TOMAN",
    fixedPriceToman: REP_PRICE,
    percentValue: null,
  });
  if (!p.ok) throw new Error(`price set failed: ${p.code}`);
}

/** Approve a fresh PENDING_REVIEW application for `user` on `tierId`. */
async function makeActiveRep(user: User, tierId: string): Promise<string> {
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
  const result = await approveRepresentativeApplication({ applicationId: app.id, adminId, tierId });
  if (!result.ok) throw new Error(`approve failed: ${result.code}`);
  return result.representative.id;
}

// --- fake grammY context (drives the real user handler) ----------------------

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

function fakeCallbackCtx(
  user: User,
  data: string,
): { ctx: BotContext; sent: SentMessage[]; toasts: Array<string | undefined>; session: SessionData } {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const session = initialSession();
  const callbackQuery = {
    id: "cbq-1",
    chat_instance: "ci-1",
    from: { id: Number(user.telegramId), is_bot: false, first_name: "Tester" },
    data,
  };
  const ctx = {
    session,
    dbUser: user,
    admin: null,
    from: { id: Number(user.telegramId), first_name: "Tester" },
    callbackQuery,
    update: { update_id: 3, callback_query: callbackQuery },
    reply: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { ctx: ctx as unknown as BotContext, sent, toasts, session };
}

async function runRep(ctx: BotContext): Promise<void> {
  await representativeHandler.middleware()(ctx, async () => {});
}

/** All callback datas across the inline keyboard of the LAST sent message. */
function lastKeyboardCallbacks(sent: SentMessage[]): string[] {
  const last = sent.at(-1);
  const markup = last?.other?.reply_markup as
    | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    | undefined;
  if (markup?.inline_keyboard === undefined) return [];
  return markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `pm-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
      isVisible: true,
      username: "admin",
      passwordEncrypted: "enc",
      templateUsername: "tpl",
    },
  });
  sellablePanelId = panel.id;
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `pm-cat-${runTag}`, isActive: true },
  });
  serviceCategoryId = category.id;
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

// --- pure predicate: the ONE reused catalog contract (Fix G, P2@282) ---------

describe("catalog visibility predicate (Fix G reuse — no DB)", () => {
  const marzbanPanel: Panel = {
    type: "MARZBAN",
    status: "ACTIVE",
    isVisible: true,
    username: "admin",
    passwordEncrypted: "enc",
    templateUsername: "tpl",
    protocolSettings: null,
    tokenEncrypted: null,
    authMode: null,
    apiVariant: null,
    inboundIds: null,
    provisioningReady: null,
  } as unknown as Panel;

  const xuiPanel: Panel = {
    type: "XUI",
    status: "ACTIVE",
    isVisible: true,
    username: "admin",
    passwordEncrypted: "enc",
    tokenEncrypted: null,
    authMode: null,
    apiVariant: null,
    inboundIds: [3, 5, 8],
    provisioningReady: null,
  } as unknown as Panel;

  function svc(overrides: Record<string, unknown> = {}, panel: Panel = marzbanPanel): ProductWithRelations {
    return {
      type: "SERVICE_PRODUCT",
      isActive: true,
      displayGroups: ["ALL"],
      inboundIds: null,
      panel,
      category: { isActive: true },
      ...overrides,
    } as unknown as ProductWithRelations;
  }

  it("a fully-sellable eligible product is visible to the group", () => {
    expect(isProductVisible(svc(), "F")).toBe(true);
    expect(isProductStructurallySellable(svc())).toBe(true);
  });

  it("hidden from the user's group is excluded (but structurally still sellable)", () => {
    const p = svc({ displayGroups: ["N"] });
    expect(isProductVisible(p, "F")).toBe(false);
    expect(isProductVisible(p, "N")).toBe(true);
    // group is NOT a structural concern — the shared helper ignores it.
    expect(isProductStructurallySellable(p)).toBe(true);
  });

  it("inactive product is excluded", () => {
    expect(isProductVisible(svc({ isActive: false }), "F")).toBe(false);
  });

  it("inactive category is excluded", () => {
    expect(isProductVisible(svc({ category: { isActive: false } }), "F")).toBe(false);
  });

  it("null / hidden / inactive / unready panel is excluded", () => {
    expect(isProductVisible(svc({ panel: null }), "F")).toBe(false);
    expect(isProductVisible(svc({}, { ...marzbanPanel, isVisible: false } as Panel), "F")).toBe(false);
    expect(isProductVisible(svc({}, { ...marzbanPanel, status: "DISABLED" } as Panel), "F")).toBe(false);
    expect(isProductVisible(svc({}, { ...marzbanPanel, provisioningReady: false } as Panel), "F")).toBe(
      false,
    );
  });

  it("invalid XUI inbound selection (outside the panel allowlist) is excluded", () => {
    expect(isProductVisible(svc({ inboundIds: [99] }, xuiPanel), "F")).toBe(false);
    // a valid subset of the same panel stays visible
    expect(isProductVisible(svc({ inboundIds: [5] }, xuiPanel), "F")).toBe(true);
  });
});

// --- Fix F: OWNER product-eligibility mutation (financial isolation) ----------

describe.skipIf(!hasDb)("OWNER product-eligibility control (Fix F, P1@763)", () => {
  it("enables, then disables, an eligible SERVICE_PRODUCT and audits privacy-safely", async () => {
    const product = await createServiceProduct({ representativeEligible: false });
    const enable = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: false,
      adminId,
    });
    expect(enable.ok).toBe(true);
    if (!enable.ok) return;
    expect(enable.changed).toBe(true);
    expect(enable.product.representativeEligible).toBe(true);

    const disable = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: true,
      adminId,
    });
    expect(disable.ok).toBe(true);
    if (!disable.ok) return;
    expect(disable.changed).toBe(true);
    expect(disable.product.representativeEligible).toBe(false);

    // privacy-safe audit: ids + coarse flags only, never name/price/panel URL.
    const logs = await prisma.systemLog.findMany({
      where: { eventType: OPS_EVENTS.PRODUCT_REP_ELIGIBILITY_CHANGED, adminId },
      orderBy: { createdAt: "desc" },
      take: 2,
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const log of logs) {
      const meta = (log.metadata ?? {}) as Record<string, unknown>;
      expect(typeof meta.enabled).toBe("boolean");
      expect(meta.productType).toBe("SERVICE_PRODUCT");
      expect(typeof meta.productShort).toBe("string");
      const blob = JSON.stringify(meta);
      expect(blob).not.toContain(product.name);
      expect(blob).not.toContain(String(RETAIL));
      expect(blob).not.toContain("http");
    }
  });

  it("a stale / duplicate confirm converges idempotently (no double-flip)", async () => {
    const product = await createServiceProduct({ representativeEligible: false });
    const first = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: false,
      adminId,
    });
    expect(first.ok && first.changed).toBe(true);
    // a second confirm carrying the SAME expected (now stale) state does NOT
    // flip it back — it converges to the current value.
    const second = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: false,
      adminId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
    expect(second.product.representativeEligible).toBe(true);
  });

  it("rejects an OTHER_PRODUCT and a missing product safely", async () => {
    const otherCat = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `pm-ocat-${runTag}-${randomUUID().slice(0, 6)}`, isActive: true },
    });
    const other = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: otherCat.id,
        name: `pm-other-${runTag}-${randomUUID().slice(0, 6)}`,
        priceToman: RETAIL,
        isActive: true,
      },
    });
    const wrong = await setProductRepresentativeEligible({
      productId: other.id,
      expectedCurrent: false,
      adminId,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("WRONG_TYPE");
    // the flag is never written for a non-service product
    const reloaded = await prisma.product.findUniqueOrThrow({ where: { id: other.id } });
    expect(reloaded.representativeEligible).toBe(false);

    const missing = await setProductRepresentativeEligible({
      productId: randomUUID(),
      expectedCurrent: false,
      adminId,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("NOT_FOUND");
  });

  it("toggling eligibility never touches isActive, tier prices, or any financial record", async () => {
    const product = await createServiceProduct({ representativeEligible: true });
    const tierId = await makeTier();
    await addPrice(tierId, product.id);

    const beforeCheckouts = await prisma.checkoutSession.count();
    const beforePayments = await prisma.payment.count();
    const beforeOrders = await prisma.order.count();
    const beforeWallet = await prisma.walletTransaction.count();
    const beforeReferral = await prisma.referralCommission.count();

    const off = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: true,
      adminId,
    });
    expect(off.ok && !off.product.representativeEligible).toBe(true);

    const reloaded = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(reloaded.isActive).toBe(true); // isActive is untouched
    // the tier price row survives an opt-out (never deleted, §11)
    const price = await prisma.representativeProductPrice.findUnique({
      where: { tierId_productId: { tierId, productId: product.id } },
    });
    expect(price).not.toBeNull();
    // no financial side effects whatsoever
    expect(await prisma.checkoutSession.count()).toBe(beforeCheckouts);
    expect(await prisma.payment.count()).toBe(beforePayments);
    expect(await prisma.order.count()).toBe(beforeOrders);
    expect(await prisma.walletTransaction.count()).toBe(beforeWallet);
    expect(await prisma.referralCommission.count()).toBe(beforeReferral);
  });
});

// --- Fix G: reseller catalog filtered by real purchasability -----------------

describe.skipIf(!hasDb)("reseller catalog purchasability filter (Fix G, P2@282)", () => {
  it("returns only products that can actually reach pre-invoice, in one authoritative set", async () => {
    const user = await createUser();
    const tierId = await makeTier();
    await makeActiveRep(user, tierId);

    // A fully-sellable, eligible, priced product → INCLUDED.
    const good = await createServiceProduct();
    await addPrice(tierId, good.id);

    // Hidden from the user's F group → excluded (visibility runs before pricing).
    const hidden = await createServiceProduct({ displayGroups: ["N"] });
    await addPrice(tierId, hidden.id);

    // Eligible + sellable but NO tier price → excluded (resolves to retail).
    const noPrice = await createServiceProduct();

    // Not opted in → excluded.
    const notEligible = await createServiceProduct({ representativeEligible: false });

    // On an unready panel → excluded (panel readiness fails).
    const unreadyPanel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `pm-unready-${runTag}-${randomUUID().slice(0, 6)}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        isVisible: true,
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        provisioningReady: false,
      },
    });
    const unready = await createServiceProduct({ panelId: unreadyPanel.id });
    await addPrice(tierId, unready.id);

    // A second good product AFTER the invalid ones → still visible, no cap.
    const good2 = await createServiceProduct();
    await addPrice(tierId, good2.id);

    const eligible = await listEligibleRepresentativeProducts(user);
    const ids = eligible.map((p) => p.productId);

    expect(ids).toContain(good.id);
    expect(ids).toContain(good2.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(noPrice.id);
    expect(ids).not.toContain(notEligible.id);
    expect(ids).not.toContain(unready.id);

    // no duplicate rows
    expect(new Set(ids).size).toBe(ids.length);
    // the good product carries the reseller price, not retail
    const goodRow = eligible.find((p) => p.productId === good.id);
    expect(goodRow?.finalPriceToman).toBe(REP_PRICE);
    expect(goodRow?.retailPriceToman).toBe(RETAIL);

    // buy list and tariff list consume the SAME authoritative result.
    const again = await listEligibleRepresentativeProducts(user);
    expect(again.map((p) => p.productId).sort()).toEqual(ids.slice().sort());
  });

  it("an OTHER_PRODUCT never appears in the reseller catalog", async () => {
    const user = await createUser();
    const tierId = await makeTier();
    await makeActiveRep(user, tierId);
    const good = await createServiceProduct();
    await addPrice(tierId, good.id);
    const eligible = await listEligibleRepresentativeProducts(user);
    // every returned row is one of our eligible SERVICE_PRODUCTs
    for (const row of eligible) {
      const p = await prisma.product.findUniqueOrThrow({ where: { id: row.productId } });
      expect(p.type).toBe("SERVICE_PRODUCT");
    }
  });
});

// --- Fix H: TERMINATED representative terminal state -------------------------

describe.skipIf(!hasDb)("terminated representative terminal state (Fix H, P2@136)", () => {
  async function makeTerminatedRep(status = "TERMINATED"): Promise<User> {
    const user = await createUser();
    const tierId = await makeTier();
    const repId = await makeActiveRep(user, tierId);
    await prisma.representative.update({ where: { id: repId }, data: { status, terminatedAt: new Date() } });
    return user;
  }

  it("opens a read-only terminal page with history/terms/support but NO apply/buy/tariff/reactivate", async () => {
    const user = await makeTerminatedRep();
    const { ctx, sent } = fakeCallbackCtx(user, "user:rep:menu");
    await runRep(ctx);
    const text = sent.at(-1)?.text ?? "";
    expect(text).toContain("خاتمه‌یافته");
    const cbs = lastKeyboardCallbacks(sent);
    // reachable
    expect(cbs).toContain("user:rep:buys"); // purchase history
    expect(cbs).toContain("user:rep:terms");
    expect(cbs).toContain("user:rep:support");
    expect(cbs).toContain("user:menu"); // back to main menu
    // never offered
    expect(cbs).not.toContain("user:rep:apply");
    expect(cbs).not.toContain("user:rep:buy");
    expect(cbs).not.toContain("user:rep:tariff");
  });

  it("a direct apply callback fails closed to the terminal page and creates no application", async () => {
    const user = await makeTerminatedRep();
    const { ctx, sent } = fakeCallbackCtx(user, "user:rep:apply");
    await runRep(ctx);
    expect(sent.at(-1)?.text ?? "").toContain("خاتمه‌یافته");
    expect(await findOpenApplication(user.id)).toBeNull();
    const open = await prisma.representativeApplication.count({
      where: { userId: user.id, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
    });
    expect(open).toBe(0);
  });

  it("a direct buy callback fails closed to the terminal page and creates no checkout", async () => {
    const user = await makeTerminatedRep();
    const { ctx, sent } = fakeCallbackCtx(user, "user:rep:buy");
    await runRep(ctx);
    expect(sent.at(-1)?.text ?? "").toContain("خاتمه‌یافته");
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it("retail pricing stays available to a terminated user (normal account unaffected)", async () => {
    const user = await makeTerminatedRep();
    const product = await createServiceProduct();
    const effective = await resolveEffectiveProductPrice({
      user,
      product,
      checkoutPurpose: "PURCHASE",
      mode: "PREVIEW",
    });
    expect(effective.pricingMode).toBe("RETAIL");
    expect(effective.finalPriceToman).toBe(RETAIL);
  });

  it("retained purchase history is still reachable for a terminated representative", async () => {
    const user = await makeTerminatedRep();
    const stats = await getRepresentativeDashboardStats(user.id);
    expect(stats.representative).not.toBeNull();
    expect(stats.representative?.status).toBe("TERMINATED");
  });

  it("an unknown persisted status fails closed to the terminal page", async () => {
    expect(isRepresentativeStatus("WEIRD")).toBe(false);
    const user = await makeTerminatedRep("WEIRD");
    const { ctx, sent } = fakeCallbackCtx(user, "user:rep:menu");
    await runRep(ctx);
    const cbs = lastKeyboardCallbacks(sent);
    expect(cbs).not.toContain("user:rep:apply");
    expect(cbs).not.toContain("user:rep:buy");
  });
});

// --- payment-policy regression: opt-out never cancels paid fulfillment --------

describe.skipIf(!hasDb)("settlement policy: opt-out never cancels a paid reseller order", () => {
  it("a later product opt-out leaves a settled Order/Payment/marker untouched", async () => {
    const user = await createUser();
    const tierId = await makeTier();
    await makeActiveRep(user, tierId);
    const product = await createServiceProduct();
    await addPrice(tierId, product.id);

    const effective = await resolveEffectiveProductPrice({
      user,
      product,
      checkoutPurpose: "PURCHASE",
      mode: "PREVIEW",
    });
    expect(effective.pricingMode).toBe("REPRESENTATIVE");
    const draft: CheckoutDraft = {
      productId: product.id,
      categoryId: serviceCategoryId,
      panelId: sellablePanelId,
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
    // freeze the checkout snapshot exactly like the buy flow, then settle it.
    await createCheckoutSession(user, product, draft);
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paidOrderId = result.order.id;
    const paidPaymentId = result.payment.id;
    expect(result.order.finalPriceToman).toBe(REP_PRICE);

    // OWNER opts the product OUT of representative sale AFTER settlement.
    const off = await setProductRepresentativeEligible({
      productId: product.id,
      expectedCurrent: true,
      adminId,
    });
    expect(off.ok && !off.product.representativeEligible).toBe(true);

    // the paid Order / Payment / marker are all untouched.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: paidOrderId } });
    expect(order.finalPriceToman).toBe(REP_PRICE);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paidPaymentId } });
    expect(payment.status).toBe(result.payment.status);
    const marker = await prisma.representativePurchase.findUnique({
      where: { orderId: paidOrderId },
    });
    expect(marker?.status).toBe("COMPLETED");
  });
});

// --- sanity: the tier price page surfaces eligible-but-unsellable products ----

describe.skipIf(!hasDb)("tier price page state (§11)", () => {
  it("retains an opted-in product and flags it unsellable when its panel is unready", async () => {
    const tierId = await makeTier();
    const unreadyPanel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `pm-unready2-${runTag}-${randomUUID().slice(0, 6)}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        isVisible: true,
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        provisioningReady: false,
      },
    });
    const product = await createServiceProduct({ panelId: unreadyPanel.id });
    await addPrice(tierId, product.id);
    const rows = await listTierProductPrices(tierId);
    const row = rows.find((r) => r.product.id === product.id);
    expect(row).toBeDefined();
    // opted-in but NOT sellable — it stays visible so the OWNER can see why.
    expect(row?.sellable).toBe(false);
  });
});
