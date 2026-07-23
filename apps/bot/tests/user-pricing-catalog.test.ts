import { prisma, type Panel, type ProductCategory, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "pricing-catalog-test-secret-pricing-catalog-secret";

import { initialSession, type SessionData } from "../src/core/session.js";
import {
  loadUserRetailCatalog,
  minRetailPrice,
  isProductVisible,
} from "../src/services/catalog.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";
import { setRepresentativeProgramEnabled } from "../src/services/representative-settings.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { preInvoiceKeyboard } from "../src/handlers/user-checkout/checkout-views.js";
import {
  isRepresentativeSurfaceApplicable,
  pricingHandler,
  renderPricingRoot,
} from "../src/handlers/user-pricing/pricing.handler.js";
import { PRICE_CB, parsePricingPage } from "../src/handlers/user-pricing/pricing-cb.js";
import {
  boundedDescription,
  deliveryLabel,
  durationLabel,
  formatToman,
  locationLabel,
  otherProductCard,
  serviceProductCard,
  volumeLabel,
} from "../src/handlers/user-pricing/pricing-views.js";

// =============================================================================
// Public retail Pricing Catalog (feat/public-pricing-catalog). Covers the
// callback contract, the authoritative catalog loader, rendering/formatting,
// direct-checkout integration (origin + retail draft), representative
// isolation, and stock/other-product privacy.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const nextTgId = (): bigint => runTag + BigInt(seq++);

// --- fake ctx ----------------------------------------------------------------

interface Btn {
  text: string;
  data?: string;
}
interface Captured {
  edits: Array<{ text: string; buttons: Btn[] }>;
  toasts: Array<string | undefined>;
  session: SessionData;
}

function flatButtons(markup: unknown): Btn[] {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) {
    return [];
  }
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

function fakeCtx(data: string, user: User | null, session: SessionData) {
  const cap: Captured = { edits: [], toasts: [], session };
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    session,
    dbUser: user,
    admin: null,
    from: { id: 1, first_name: "T" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.edits.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.edits.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
  };
  return { ctx, cap };
}

async function run(data: string, user: User | null, session = initialSession()): Promise<Captured> {
  const { ctx, cap } = fakeCtx(data, user, session);
  await pricingHandler.middleware()(ctx as never, async () => undefined);
  return cap;
}

const lastEdit = (cap: Captured): { text: string; buttons: Btn[] } =>
  cap.edits.at(-1) ?? { text: "", buttons: [] };

// =============================================================================
// Pure (no DB) — callback contract + formatting
// =============================================================================

describe("pricing callback contract", () => {
  it("every emitted callback stays within Telegram's 64-byte limit", () => {
    const sid = "0a1b2c3d";
    const callbacks = [
      PRICE_CB.serviceRoot,
      PRICE_CB.serviceRootPage(1296),
      PRICE_CB.servicePanel(sid, 1296),
      PRICE_CB.serviceCategory(sid, sid, 1296),
      PRICE_CB.serviceDetail(sid, sid, sid, 1296),
      PRICE_CB.serviceBuy(sid, sid, sid, 1296),
      PRICE_CB.otherRoot,
      PRICE_CB.otherRootPage(1296),
      PRICE_CB.otherCategory(sid, 1296),
      PRICE_CB.otherDetail(sid, sid, 1296),
      PRICE_CB.otherBuy(sid, sid, 1296),
    ];
    for (const cb of callbacks) {
      expect(Buffer.byteLength(cb, "utf8"), cb).toBeLessThanOrEqual(64);
    }
  });

  it("uses lowercase base36 pages and never embeds a price", () => {
    expect(PRICE_CB.servicePanel("abcd1234", 36)).toBe("user:price:sp:abcd1234:10");
    expect(PRICE_CB.serviceRootPage(1)).toBe("user:price:s:1");
    // No digits-that-look-like-a-price (Toman) ever leak into a callback.
    expect(PRICE_CB.serviceBuy("abcd1234", "abcd1234", "abcd1234", 1)).not.toMatch(/000/);
  });

  it("parses pages safely (garbage/negative/missing → 1)", () => {
    expect(parsePricingPage("1")).toBe(1);
    expect(parsePricingPage("z")).toBe(35);
    expect(parsePricingPage("10")).toBe(36);
    expect(parsePricingPage(undefined)).toBe(1);
    expect(parsePricingPage("")).toBe(1);
    expect(parsePricingPage("-5")).toBe(1);
    expect(parsePricingPage("!!")).toBe(1);
  });
});

describe("pricing formatting helpers", () => {
  it("formats Toman with thousands separators", () => {
    expect(formatToman(150000)).toBe("150,000 تومان");
    expect(formatToman(0)).toBe("0 تومان");
  });

  it("renders unlimited/dash volume and duration", () => {
    expect(volumeLabel(0)).toBe("نامحدود");
    expect(volumeLabel(50)).toBe("50 گیگ");
    expect(volumeLabel(null)).toBe("—");
    expect(durationLabel(0)).toBe("نامحدود");
    expect(durationLabel(30)).toBe("30 روز");
    expect(durationLabel(null)).toBe("—");
  });

  it("renders location labels safely", () => {
    expect(locationLabel({ allLocations: true, serviceLocation: null })).toBe("همه لوکیشن‌ها");
    expect(locationLabel({ allLocations: false, serviceLocation: "MULTI_LOCATION" })).toBe(
      "مولتی لوکیشن",
    );
    expect(locationLabel({ allLocations: false, serviceLocation: "DEDICATED_LOCATION" })).toBe(
      "تک لوکیشن اختصاصی",
    );
    expect(locationLabel({ allLocations: false, serviceLocation: null })).toBe("—");
  });

  it("renders safe delivery labels that never leak stock mechanics", () => {
    expect(deliveryLabel("MANUAL_ADMIN")).toBe("تحویل توسط پشتیبانی");
    expect(deliveryLabel("STOCK_ITEM")).toBe("تحویل خودکار پس از پرداخت");
    expect(deliveryLabel(null)).toBe("طبق توضیحات محصول");
  });

  it("escapes and bounds operator descriptions", () => {
    const escaped = boundedDescription("<b>x</b> & \"y\"");
    expect(escaped).toContain("&lt;b&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).not.toContain("<b>");
    const long = boundedDescription("a".repeat(2000));
    expect(long.length).toBeLessThan(700);
    expect(long.endsWith("…")).toBe(true);
  });

  it("escapes product/panel/category names in cards (no HTML injection)", () => {
    const product = {
      name: "<script>bad</script>",
      priceToman: 1000,
      allLocations: true,
      serviceLocation: null,
      volumeGb: 0,
      durationDays: 0,
      deliveryType: null,
      requiredUserInfoEnabled: false,
      category: { name: "<i>cat</i>" },
      panel: { name: "<u>panel</u>" },
    } as unknown as ProductWithRelations;
    const svc = serviceProductCard(product);
    expect(svc).toContain("&lt;script&gt;");
    expect(svc).not.toContain("<script>");
    expect(svc).toContain("&lt;u&gt;panel&lt;/u&gt;");
    const other = otherProductCard(product);
    expect(other).toContain("&lt;script&gt;");
    expect(other).not.toContain("<script>");
  });
});

// =============================================================================
// preInvoice back navigation for pricing origins (no DB)
// =============================================================================

describe("pre-invoice back navigation honours checkout origin", () => {
  const base = {
    productId: "aaaaaaaa-1111-2222-3333-444444444444",
    categoryId: "bbbbbbbb-1111-2222-3333-444444444444",
    panelId: "cccccccc-1111-2222-3333-444444444444",
    flowType: "SERVICE_PRODUCT" as const,
    originalPriceToman: 1000,
    discountAmountToman: 0,
    finalPriceToman: 1000,
  };
  const user = { balanceToman: 0 } as User;

  const backOf = (kb: { inline_keyboard: Array<Array<Record<string, string>>> }): string | undefined =>
    kb.inline_keyboard.flat().find((b) => b.text === "بازگشت")?.callback_data;

  it("PRICING_SERVICE origin returns to the exact pricing product-list page", () => {
    const kb = preInvoiceKeyboard(
      { ...base, origin: { kind: "PRICING_SERVICE", panelId: base.panelId, categoryId: base.categoryId, page: 3 } },
      user,
      false,
    ) as unknown as { inline_keyboard: Array<Array<Record<string, string>>> };
    expect(backOf(kb)).toBe(
      PRICE_CB.serviceCategory(base.panelId.slice(0, 8), base.categoryId.slice(0, 8), 3),
    );
  });

  it("PRICING_OTHER origin returns to the exact other-product list page", () => {
    const kb = preInvoiceKeyboard(
      {
        ...base,
        flowType: "OTHER_PRODUCT",
        panelId: undefined,
        origin: { kind: "PRICING_OTHER", categoryId: base.categoryId, page: 2 },
      },
      user,
      false,
    ) as unknown as { inline_keyboard: Array<Array<Record<string, string>>> };
    expect(backOf(kb)).toBe(PRICE_CB.otherCategory(base.categoryId.slice(0, 8), 2));
  });

  it("a normal retail (or missing) origin keeps the historical back navigation", () => {
    const kb = preInvoiceKeyboard(
      { ...base, origin: { kind: "RETAIL_CATALOG" } },
      user,
      false,
    ) as unknown as { inline_keyboard: Array<Array<Record<string, string>>> };
    expect(backOf(kb)).toBe(`user:buy:cat:${base.panelId.slice(0, 8)}:${base.categoryId.slice(0, 8)}`);
    const kb2 = preInvoiceKeyboard({ ...base }, user, false) as unknown as {
      inline_keyboard: Array<Array<Record<string, string>>>;
    };
    expect(backOf(kb2)).toBe(`user:buy:cat:${base.panelId.slice(0, 8)}:${base.categoryId.slice(0, 8)}`);
  });
});

// =============================================================================
// DB-backed: catalog + handler + checkout
// =============================================================================

describe.skipIf(hasDb)("pricing catalog (skipped without DATABASE_URL)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});

describe.runIf(hasDb)("pricing catalog (DB-backed)", () => {
  let userF: User;
  let userN: User;
  let sellablePanel: Panel;
  let serviceCategory: ProductCategory;
  let otherCategory: ProductCategory;
  const createdProductIds: string[] = [];
  const createdPanelIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdUserIds: string[] = [];

  async function createUser(group: "F" | "N" | "N2"): Promise<User> {
    const u = await prisma.user.create({
      data: { telegramId: nextTgId(), balanceToman: 5_000_000, group },
    });
    createdUserIds.push(u.id);
    return u;
  }

  async function createPanel(overrides: Record<string, unknown> = {}): Promise<Panel> {
    const p = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `pc-panel-${runTag}-${seq++}`,
        baseUrl: "https://panel.internal.example.com:8443",
        username: "admin",
        passwordEncrypted: "enc-secret",
        templateUsername: "tpl",
        status: "ACTIVE",
        isVisible: true,
        ...overrides,
      },
    });
    createdPanelIds.push(p.id);
    return p;
  }

  async function createCategory(
    type: "SERVICE_PRODUCT" | "OTHER_PRODUCT",
    overrides: Record<string, unknown> = {},
  ): Promise<ProductCategory> {
    const c = await prisma.productCategory.create({
      data: { type, name: `pc-cat-${runTag}-${seq++}`, isActive: true, ...overrides },
    });
    createdCategoryIds.push(c.id);
    return c;
  }

  async function createServiceProduct(
    panelId: string,
    categoryId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<ProductWithRelations> {
    const created = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId,
        panelId,
        name: `pc-svc-${runTag}-${seq++}`,
        priceToman: 200_000,
        volumeGb: 30,
        durationDays: 30,
        allLocations: false,
        serviceLocation: "MULTI_LOCATION",
        isActive: true,
        displayGroups: ["ALL"],
        ...overrides,
      },
    });
    createdProductIds.push(created.id);
    return prisma.product.findUniqueOrThrow({
      where: { id: created.id },
      include: { category: true, panel: true },
    });
  }

  async function createOtherProduct(
    categoryId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<ProductWithRelations> {
    const created = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `pc-other-${runTag}-${seq++}`,
        priceToman: 90_000,
        isActive: true,
        displayGroups: ["ALL"],
        deliveryType: "STOCK_ITEM",
        ...overrides,
      },
    });
    createdProductIds.push(created.id);
    return prisma.product.findUniqueOrThrow({
      where: { id: created.id },
      include: { category: true, panel: true },
    });
  }

  beforeAll(async () => {
    userF = await createUser("F");
    userN = await createUser("N");
    sellablePanel = await createPanel({ displayOrder: 1 });
    serviceCategory = await createCategory("SERVICE_PRODUCT", { displayOrder: 1 });
    otherCategory = await createCategory("OTHER_PRODUCT", { displayOrder: 1 });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await prisma.panel.deleteMany({ where: { id: { in: createdPanelIds } } });
    // Representative rows reference the user (no cascade) — remove them first.
    await prisma.representative.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await setRepresentativeProgramEnabled(false);
    clearSettingsCache();
    await prisma.$disconnect();
  });

  // --- loader ---------------------------------------------------------------

  it("groups visible service products by panel → category with min prices", async () => {
    const cheap = await createServiceProduct(sellablePanel.id, serviceCategory.id, {
      priceToman: 100_000,
    });
    await createServiceProduct(sellablePanel.id, serviceCategory.id, { priceToman: 300_000 });

    const catalog = await loadUserRetailCatalog(userF);
    const panelEntry = catalog.servicePanels.find((p) => p.panel.id === sellablePanel.id);
    expect(panelEntry).toBeDefined();
    const catEntry = panelEntry?.categories.find((c) => c.category.id === serviceCategory.id);
    expect(catEntry).toBeDefined();
    expect(catEntry?.products.length).toBeGreaterThanOrEqual(2);
    expect(minRetailPrice(catEntry?.products ?? [])).toBe(100_000);
    expect(catEntry?.products.every((p) => p.id !== cheap.id || p.priceToman === 100_000)).toBe(true);
  });

  it("respects the user group before counts/min-price (F sees F/ALL; N sees N/ALL)", async () => {
    const panel = await createPanel({ displayOrder: 5 });
    const cat = await createCategory("SERVICE_PRODUCT", { displayOrder: 5 });
    const forAll = await createServiceProduct(panel.id, cat.id, { displayGroups: ["ALL"] });
    const forN = await createServiceProduct(panel.id, cat.id, { displayGroups: ["N"] });
    const forF = await createServiceProduct(panel.id, cat.id, { displayGroups: ["F"] });

    const catalogF = await loadUserRetailCatalog(userF);
    const fIds = catalogF.servicePanels
      .flatMap((p) => p.categories)
      .flatMap((c) => c.products)
      .map((p) => p.id);
    expect(fIds).toContain(forAll.id);
    expect(fIds).toContain(forF.id);
    expect(fIds).not.toContain(forN.id);

    const catalogN = await loadUserRetailCatalog(userN);
    const nIds = catalogN.servicePanels
      .flatMap((p) => p.categories)
      .flatMap((c) => c.products)
      .map((p) => p.id);
    expect(nIds).toContain(forAll.id);
    expect(nIds).toContain(forN.id);
    expect(nIds).not.toContain(forF.id);
  });

  it("excludes inactive product/category and hidden/inactive/unready panels; drops empty panels", async () => {
    // Hidden panel with an otherwise-fine product → panel + product excluded.
    const hiddenPanel = await createPanel({ isVisible: false, displayOrder: 9 });
    const hiddenCat = await createCategory("SERVICE_PRODUCT", { displayOrder: 9 });
    const onHidden = await createServiceProduct(hiddenPanel.id, hiddenCat.id);
    // Provisioning-unready panel (explicit failed check) → excluded.
    const unreadyPanel = await createPanel({ provisioningReady: false, displayOrder: 10 });
    const unreadyCat = await createCategory("SERVICE_PRODUCT", { displayOrder: 10 });
    const onUnready = await createServiceProduct(unreadyPanel.id, unreadyCat.id);
    // Inactive product + inactive category on the good panel.
    const inactiveProduct = await createServiceProduct(sellablePanel.id, serviceCategory.id, {
      isActive: false,
    });
    const inactiveCat = await createCategory("SERVICE_PRODUCT", { isActive: false, displayOrder: 11 });
    const onInactiveCat = await createServiceProduct(sellablePanel.id, inactiveCat.id);

    const catalog = await loadUserRetailCatalog(userF);
    const visibleIds = catalog.servicePanels
      .flatMap((p) => p.categories)
      .flatMap((c) => c.products)
      .map((p) => p.id);
    expect(visibleIds).not.toContain(onHidden.id);
    expect(visibleIds).not.toContain(onUnready.id);
    expect(visibleIds).not.toContain(inactiveProduct.id);
    expect(visibleIds).not.toContain(onInactiveCat.id);
    // Empty/excluded panels never appear.
    const panelIds = catalog.servicePanels.map((p) => p.panel.id);
    expect(panelIds).not.toContain(hiddenPanel.id);
    expect(panelIds).not.toContain(unreadyPanel.id);
    // The excluded product is also invisible via the single authoritative predicate.
    expect(isProductVisible(onUnready, "F")).toBe(false);
  });

  it("groups other products by category and keeps them separate from services", async () => {
    const op = await createOtherProduct(otherCategory.id, { priceToman: 60_000 });
    const catalog = await loadUserRetailCatalog(userF);
    const oc = catalog.otherProductCategories.find((c) => c.category.id === otherCategory.id);
    expect(oc).toBeDefined();
    expect(oc?.products.map((p) => p.id)).toContain(op.id);
    // No OTHER_PRODUCT ever leaks into the service tree.
    const serviceIds = catalog.servicePanels
      .flatMap((p) => p.categories)
      .flatMap((c) => c.products)
      .map((p) => p.id);
    expect(serviceIds).not.toContain(op.id);
  });

  // --- root + rendering ------------------------------------------------------

  it("root renders counts, both section buttons, disclaimer, and no rep button by default", async () => {
    await setRepresentativeProgramEnabled(false);
    clearSettingsCache();
    // Exercise the exported entry directly (used by the reply-keyboard menu action).
    const { ctx, cap } = fakeCtx(PRICE_CB.root, userF, initialSession());
    await renderPricingRoot(ctx as never);
    const view = lastEdit(cap);
    expect(view.text).toContain("تعرفه‌ها");
    expect(view.text).toContain("پیش‌فاکتور");
    const datas = view.buttons.map((b) => b.data);
    expect(datas).toContain(PRICE_CB.serviceRoot);
    expect(datas).toContain(PRICE_CB.otherRoot);
    expect(datas).not.toContain(PRICE_CB.representative);
  });

  it("section pages open a real keyboarded page (no dead-end) and empty-state templates are seeded", async () => {
    // Both sections always open a real, keyboarded page — never a dead callback.
    const services = lastEdit(await run(PRICE_CB.serviceRoot, userF));
    expect(services.text.length).toBeGreaterThan(0);
    expect(services.buttons.length).toBeGreaterThan(0);
    const other = lastEdit(await run(PRICE_CB.otherRoot, userF));
    expect(other.text.length).toBeGreaterThan(0);
    expect(other.buttons.length).toBeGreaterThan(0);
    // The empty-state copy is registered so an empty section renders real text.
    const { getMessageTemplate } = await import("../src/services/text.service.js");
    expect(await getMessageTemplate("pricing_page_empty_services")).not.toBe(
      "pricing_page_empty_services",
    );
    expect(await getMessageTemplate("pricing_page_empty_other")).not.toBe("pricing_page_empty_other");
  });

  it("service navigation renders panels→categories→products with ≤64-byte callbacks and no secrets", async () => {
    const services = await run(PRICE_CB.serviceRoot, userF);
    const view = lastEdit(services);
    // Every emitted callback is bounded.
    for (const b of view.buttons) {
      if (b.data !== undefined) {
        expect(Buffer.byteLength(b.data, "utf8"), b.data).toBeLessThanOrEqual(64);
      }
    }
    // Never leak the panel base URL / credentials anywhere.
    expect(view.text).not.toContain("panel.internal.example.com");
    expect(JSON.stringify(view.buttons)).not.toContain("panel.internal.example.com");
    expect(view.text).not.toContain("enc-secret");
  });

  // --- pagination -----------------------------------------------------------

  it("paginates products at 5/page with deterministic boundaries and safe clamping", async () => {
    const panel = await createPanel({ displayOrder: 20 });
    const cat = await createCategory("SERVICE_PRODUCT", { displayOrder: 20 });
    for (let i = 0; i < 7; i++) {
      await createServiceProduct(panel.id, cat.id, { priceToman: 100_000 + i, displayOrder: i + 1 });
    }
    const panelSid = panel.id.slice(0, 8);
    const catSid = cat.id.slice(0, 8);
    const p1 = await run(PRICE_CB.serviceCategory(panelSid, catSid, 1), userF);
    const detail1 = lastEdit(p1).buttons.filter((b) => b.data?.startsWith("user:price:sv:"));
    expect(detail1).toHaveLength(5);
    const p2 = await run(PRICE_CB.serviceCategory(panelSid, catSid, 2), userF);
    const detail2 = lastEdit(p2).buttons.filter((b) => b.data?.startsWith("user:price:sv:"));
    expect(detail2).toHaveLength(2);
    // No overlap between pages.
    const ids1 = new Set(detail1.map((b) => b.data));
    expect(detail2.every((b) => !ids1.has(b.data))).toBe(true);
    // Huge/garbage page clamps to the last valid page (still 2 items).
    const pHuge = await run(PRICE_CB.serviceCategory(panelSid, catSid, 99), userF);
    const detailHuge = lastEdit(pHuge).buttons.filter((b) => b.data?.startsWith("user:price:sv:"));
    expect(detailHuge).toHaveLength(2);
  });

  // --- direct checkout ------------------------------------------------------

  it("Buy seeds the existing retail draft with a PRICING_SERVICE origin (live price, no rep, no money)", async () => {
    const product = await createServiceProduct(sellablePanel.id, serviceCategory.id, {
      priceToman: 250_000,
    });
    const before = await prisma.checkoutSession.count({ where: { userId: userF.id } });
    const paymentsBefore = await prisma.payment.count({ where: { userId: userF.id } });
    const session = initialSession();
    const cap = await run(
      PRICE_CB.serviceBuy(
        product.id.slice(0, 8),
        sellablePanel.id.slice(0, 8),
        serviceCategory.id.slice(0, 8),
        2,
      ),
      userF,
      session,
    );
    const draft = cap.session.temp.checkoutDraft;
    expect(draft).toBeDefined();
    expect(draft?.productId).toBe(product.id);
    expect(draft?.flowType).toBe("SERVICE_PRODUCT");
    expect(draft?.finalPriceToman).toBe(250_000);
    expect(draft?.originalPriceToman).toBe(250_000);
    // Retail — never a representative-priced draft.
    expect(draft?.representative).toBeUndefined();
    expect(draft?.origin).toEqual({
      kind: "PRICING_SERVICE",
      panelId: product.panelId,
      categoryId: product.categoryId,
      page: 2,
    });
    // No money / DB rows moved.
    expect(await prisma.checkoutSession.count({ where: { userId: userF.id } })).toBe(before);
    expect(await prisma.payment.count({ where: { userId: userF.id } })).toBe(paymentsBefore);
  });

  it("browsing creates no financial records", async () => {
    const co = await prisma.checkoutSession.count({ where: { userId: userF.id } });
    const pay = await prisma.payment.count({ where: { userId: userF.id } });
    const ord = await prisma.order.count({ where: { userId: userF.id } });
    const sessionState = initialSession();
    await run(PRICE_CB.root, userF, sessionState);
    await run(PRICE_CB.serviceRoot, userF, sessionState);
    await run(PRICE_CB.otherRoot, userF, sessionState);
    expect(sessionState.temp.checkoutDraft).toBeUndefined();
    expect(await prisma.checkoutSession.count({ where: { userId: userF.id } })).toBe(co);
    expect(await prisma.payment.count({ where: { userId: userF.id } })).toBe(pay);
    expect(await prisma.order.count({ where: { userId: userF.id } })).toBe(ord);
  });

  it("rejects a forged section/type and a foreign-group product without seeding a draft", async () => {
    const service = await createServiceProduct(sellablePanel.id, serviceCategory.id);
    // `ov` (other detail) pointed at a SERVICE_PRODUCT → rejected.
    const forged = await run(
      PRICE_CB.otherDetail(service.id.slice(0, 8), serviceCategory.id.slice(0, 8), 1),
      userF,
    );
    expect(forged.session.temp.checkoutDraft).toBeUndefined();
    // Buy-other of a SERVICE_PRODUCT → rejected, no draft.
    const forgedBuy = await run(
      PRICE_CB.otherBuy(service.id.slice(0, 8), serviceCategory.id.slice(0, 8), 1),
      userF,
    );
    expect(forgedBuy.session.temp.checkoutDraft).toBeUndefined();
    // A product hidden from the user's group cannot be bought.
    const hidden = await createServiceProduct(sellablePanel.id, serviceCategory.id, {
      displayGroups: ["N"],
    });
    const foreign = await run(
      PRICE_CB.serviceBuy(
        hidden.id.slice(0, 8),
        sellablePanel.id.slice(0, 8),
        serviceCategory.id.slice(0, 8),
        1,
      ),
      userF,
    );
    expect(foreign.session.temp.checkoutDraft).toBeUndefined();
  });

  // --- other product security -----------------------------------------------

  it("other-product detail never exposes stock counts or delivery internals", async () => {
    const stockProduct = await createOtherProduct(otherCategory.id, {
      deliveryType: "STOCK_ITEM",
      stockEnabled: true,
      requiredUserInfoEnabled: true,
      requiredUserInfoPromptText: "ایمیل خود را وارد کنید",
    });
    const view = lastEdit(
      await run(PRICE_CB.otherDetail(stockProduct.id.slice(0, 8), otherCategory.id.slice(0, 8), 1), userF),
    );
    expect(view.text).toContain("تحویل خودکار پس از پرداخت");
    expect(view.text).not.toMatch(/موجود|تعداد|stock/i);
    expect(view.text).not.toContain("stockEnabled");
    // The buy button uses the existing fulfillment path (bo callback).
    expect(view.buttons.some((b) => b.data === PRICE_CB.otherBuy(stockProduct.id.slice(0, 8), otherCategory.id.slice(0, 8), 1))).toBe(true);
  });

  // --- representative isolation ---------------------------------------------

  it("representative applicability: enabled + ACTIVE/SUSPENDED only", async () => {
    await setRepresentativeProgramEnabled(false);
    clearSettingsCache();
    const repUser = await createUser("F");
    await prisma.representative.create({ data: { userId: repUser.id, status: "ACTIVE" } });
    // Program off → not applicable even for an active rep.
    expect(await isRepresentativeSurfaceApplicable(repUser.id)).toBe(false);
    await setRepresentativeProgramEnabled(true);
    clearSettingsCache();
    expect(await isRepresentativeSurfaceApplicable(repUser.id)).toBe(true);
    // Non-rep user → not applicable.
    expect(await isRepresentativeSurfaceApplicable(userN.id)).toBe(false);
    // Terminated rep → not applicable.
    const termUser = await createUser("F");
    await prisma.representative.create({ data: { userId: termUser.id, status: "TERMINATED" } });
    expect(await isRepresentativeSurfaceApplicable(termUser.id)).toBe(false);
    await setRepresentativeProgramEnabled(false);
    clearSettingsCache();
  });

  it("active representative sees a retail page: «خرید عادی این پلن» CTA that seeds a RETAIL draft", async () => {
    const repUser = await createUser("F");
    await prisma.representative.create({ data: { userId: repUser.id, status: "ACTIVE" } });
    await setRepresentativeProgramEnabled(true);
    clearSettingsCache();
    try {
      const product = await createServiceProduct(sellablePanel.id, serviceCategory.id, {
        priceToman: 275_000,
        representativeEligible: true,
      });
      // Root shows the representative-tariff link for an active rep.
      const root = lastEdit(await run(PRICE_CB.root, repUser));
      expect(root.buttons.some((b) => b.data === PRICE_CB.representative)).toBe(true);
      // Detail CTA is the disambiguated retail label, plus a link into the rep surface.
      const detail = lastEdit(
        await run(
          PRICE_CB.serviceDetail(
            product.id.slice(0, 8),
            sellablePanel.id.slice(0, 8),
            serviceCategory.id.slice(0, 8),
            1,
          ),
          repUser,
        ),
      );
      expect(detail.buttons.some((b) => b.text === "خرید عادی این پلن")).toBe(true);
      expect(detail.buttons.some((b) => b.data === PRICE_CB.representative)).toBe(true);
      // Public page shows the RETAIL price.
      expect(detail.text).toContain(formatToman(275_000));
      // Buying via the retail CTA seeds a RETAIL draft (never a representative one).
      const session = initialSession();
      const cap = await run(
        PRICE_CB.serviceBuy(
          product.id.slice(0, 8),
          sellablePanel.id.slice(0, 8),
          serviceCategory.id.slice(0, 8),
          1,
        ),
        repUser,
        session,
      );
      expect(cap.session.temp.checkoutDraft?.representative).toBeUndefined();
      expect(cap.session.temp.checkoutDraft?.finalPriceToman).toBe(275_000);
      // No representative purchase is ever created by browsing/buying retail.
      expect(await prisma.representativePurchase.count({ where: { representative: { userId: repUser.id } } })).toBe(0);
    } finally {
      await setRepresentativeProgramEnabled(false);
      clearSettingsCache();
    }
  });
});
