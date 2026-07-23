import { prisma, type Panel, type ProductCategory, type User } from "@zedbot/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "pricing-bounds-test-secret-pricing-bounds-secret";

import { initialSession, type SessionData } from "../src/core/session.js";
import type { ProductWithRelations } from "../src/services/product.service.js";
import { clearTextCache } from "../src/services/text.service.js";
import {
  boundHtmlText,
  boundPlainText,
  boundToast,
  CALLBACK_TOAST_SAFE_LIMIT,
  PRICING_DETAIL_SAFE_LIMIT,
  PRICING_EMPTY_SAFE_LIMIT,
  PRICING_ROOT_SAFE_LIMIT,
  withinTelegramLimit,
} from "../src/handlers/user-pricing/pricing-bounds.js";
import {
  emptyStateBody,
  pricingHandler,
  pricingRootBody,
} from "../src/handlers/user-pricing/pricing.handler.js";
import { otherDetailBody, serviceDetailBody } from "../src/handlers/user-pricing/pricing-views.js";
import { PRICE_CB } from "../src/handlers/user-pricing/pricing-cb.js";

// =============================================================================
// Post-merge hotfix regression (fix/pricing-catalog-post-merge-safety):
//   §B checkout-state exit contract (entering Pricing abandons incompatible
//      checkout/payment input flows), and
//   §A/§C Telegram message-budget contract (root/detail/empty pages + the
//      callback toast stay within their real sink limits for any operator edit).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// --- pure helpers ------------------------------------------------------------

function fakeProduct(overrides: Record<string, unknown> = {}): ProductWithRelations {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    type: "SERVICE_PRODUCT",
    name: "plan",
    priceToman: 100_000,
    allLocations: true,
    serviceLocation: null,
    volumeGb: 0,
    durationDays: 0,
    invoiceDescription: null,
    deliveryType: null,
    requiredUserInfoEnabled: false,
    requiredUserInfoPromptText: null,
    category: { name: "cat" },
    panel: { name: "panel" },
    ...overrides,
  } as unknown as ProductWithRelations;
}

/** No dangling HTML entity: every `&` starts a complete known entity. */
function hasNoBrokenEntity(html: string): boolean {
  return !/&(?!(amp|lt|gt|quot);)/.test(html);
}

/** `<b>` / `</b>` tags are balanced (no half-cut tag). */
function boldTagsBalanced(html: string): boolean {
  return (html.match(/<b>/g)?.length ?? 0) === (html.match(/<\/b>/g)?.length ?? 0);
}

describe("bound helpers (pure)", () => {
  it("boundPlainText keeps short text and truncates long text with one ellipsis", () => {
    expect(boundPlainText("hello", 10)).toBe("hello");
    const out = boundPlainText("a".repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.split("…").length - 1).toBe(1);
  });

  it("boundPlainText never splits a surrogate pair (emoji)", () => {
    // Each 😀 is 2 UTF-16 units; bounding to an odd limit must not cut one.
    const out = boundPlainText("😀".repeat(20), 7);
    expect(out.length).toBeLessThanOrEqual(7);
    // No lone surrogate remains.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("boundHtmlText escapes, bounds, and never cuts an entity", () => {
    const out = boundHtmlText('<b>x</b> & "y"', 999);
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;");
    expect(out).not.toContain("<b>");
    // 4000 quote chars → escaped 6x, must still bound and keep entities whole.
    const heavy = boundHtmlText('"'.repeat(4000), 200);
    expect(heavy.length).toBeLessThanOrEqual(200);
    expect(hasNoBrokenEntity(heavy)).toBe(true);
  });

  it("boundToast falls back on blank and bounds long text", () => {
    expect(boundToast("", "fallback")).toBe("fallback");
    expect(boundToast("   ", "fallback")).toBe("fallback");
    const out = boundToast("x".repeat(4000), "fallback");
    expect(out.length).toBeLessThanOrEqual(CALLBACK_TOAST_SAFE_LIMIT);
  });

  it("withinTelegramLimit checks the completed payload", () => {
    expect(withinTelegramLimit("short", 4096)).toBe(true);
    expect(withinTelegramLimit("x".repeat(5000), 4096)).toBe(false);
  });
});

describe("pricing page bodies stay within limits for any operator template", () => {
  const HUGE_ASCII = "a".repeat(4000);
  const HUGE_PERSIAN = "قیمت".repeat(1000); // multi-byte
  const HUGE_EMOJI = "😀".repeat(2000); // surrogate pairs
  const HUGE_HTML = '<b>& "x"</b>'.repeat(400);

  it("root body stays within PRICING_ROOT_SAFE_LIMIT and keeps counts", () => {
    for (const [intro, disclaimer] of [
      [HUGE_ASCII, HUGE_ASCII],
      [HUGE_PERSIAN, HUGE_EMOJI],
      [HUGE_HTML, "line1\nline2\n".repeat(500)],
    ]) {
      const body = pricingRootBody(intro, disclaimer, 7, 3);
      expect(withinTelegramLimit(body, PRICING_ROOT_SAFE_LIMIT)).toBe(true);
      // Counts are never truncated / omitted.
      expect(body).toContain("قابل خرید: 7");
      expect(body).toContain("قابل خرید: 3");
      expect(body).toContain("تعرفه‌ها");
    }
  });

  it("empty-state body stays within PRICING_EMPTY_SAFE_LIMIT and keeps the title", () => {
    for (const template of [HUGE_ASCII, HUGE_PERSIAN, HUGE_EMOJI]) {
      const body = emptyStateBody("🌐 تعرفه اشتراک‌ها", template);
      expect(withinTelegramLimit(body, PRICING_EMPTY_SAFE_LIMIT)).toBe(true);
      expect(body.startsWith("🌐 تعرفه اشتراک‌ها")).toBe(true);
    }
  });

  it("service + other detail bodies stay within limit and remain valid HTML", () => {
    const product = fakeProduct({
      name: HUGE_HTML,
      invoiceDescription: HUGE_HTML,
      category: { name: HUGE_HTML },
      panel: { name: HUGE_HTML },
      requiredUserInfoEnabled: true,
      requiredUserInfoPromptText: HUGE_HTML,
      type: "OTHER_PRODUCT",
      deliveryType: "STOCK_ITEM",
    });
    const svc = serviceDetailBody(product, HUGE_ASCII);
    expect(withinTelegramLimit(svc, PRICING_DETAIL_SAFE_LIMIT)).toBe(true);
    expect(hasNoBrokenEntity(svc)).toBe(true);
    expect(boldTagsBalanced(svc)).toBe(true);
    expect(svc).not.toContain("<script");

    const other = otherDetailBody(product, HUGE_EMOJI);
    expect(withinTelegramLimit(other, PRICING_DETAIL_SAFE_LIMIT)).toBe(true);
    expect(hasNoBrokenEntity(other)).toBe(true);
    expect(boldTagsBalanced(other)).toBe(true);
  });
});

// --- DB-backed: checkout-state exit + live toast bound -----------------------

interface Captured {
  edits: Array<{ text: string; buttons: Array<{ text: string; data?: string }> }>;
  toasts: Array<string | undefined>;
}

function flatButtons(markup: unknown): Array<{ text: string; data?: string }> {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) {
    return [];
  }
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

function makeCtx(data: string, user: User | null, session: SessionData, throwOnAnswer = false) {
  const cap: Captured = { edits: [], toasts: [] };
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
      if (throwOnAnswer) {
        throw new Error("answerCallbackQuery failed");
      }
      return true;
    },
  };
  return { ctx, cap };
}

async function dispatch(
  data: string,
  user: User | null,
  session: SessionData,
  throwOnAnswer = false,
): Promise<Captured> {
  const { ctx, cap } = makeCtx(data, user, session, throwOnAnswer);
  await pricingHandler.middleware()(ctx as never, async () => undefined);
  return cap;
}

describe.skipIf(hasDb)("pricing bounds (skipped without DATABASE_URL)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});

describe.runIf(hasDb)("pricing hotfix (DB-backed)", () => {
  let user: User;
  let panel: Panel;
  let serviceCategory: ProductCategory;
  let serviceProduct: ProductWithRelations;
  const created: { products: string[]; categories: string[]; panels: string[]; users: string[] } = {
    products: [],
    categories: [],
    panels: [],
    users: [],
  };
  const templateKeys = [
    "pricing_page_intro",
    "pricing_page_disclaimer",
    "pricing_page_empty_services",
    "pricing_page_empty_other",
    "pricing_page_product_unavailable",
  ];
  const originalTemplates = new Map<string, string>();

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq++), balanceToman: 5_000_000, group: "F" },
    });
    created.users.push(user.id);
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `pb-panel-${runTag}`,
        baseUrl: "https://panel.internal.example.com:8443",
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        status: "ACTIVE",
        isVisible: true,
      },
    });
    created.panels.push(panel.id);
    serviceCategory = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `pb-cat-${runTag}`, isActive: true },
    });
    created.categories.push(serviceCategory.id);
    const sp = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: serviceCategory.id,
        panelId: panel.id,
        name: `pb-svc-${runTag}`,
        priceToman: 150_000,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
        displayGroups: ["ALL"],
      },
    });
    created.products.push(sp.id);
    serviceProduct = await prisma.product.findUniqueOrThrow({
      where: { id: sp.id },
      include: { category: true, panel: true },
    });
    for (const key of templateKeys) {
      const row = await prisma.messageTemplate.findUnique({ where: { key } });
      if (row !== null) {
        originalTemplates.set(key, row.currentContent);
      }
    }
  });

  afterEach(async () => {
    // Restore any template mutation a test made (quarantine pattern).
    for (const [key, content] of originalTemplates) {
      await prisma.messageTemplate.update({ where: { key }, data: { currentContent: content } });
    }
    clearTextCache();
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: created.products } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.panel.deleteMany({ where: { id: { in: created.panels } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    clearTextCache();
    await prisma.$disconnect();
  });

  // §B — checkout-state exit contract ----------------------------------------

  const INCOMPATIBLE_FLOWS: Array<{ flow: string; draftKey: string }> = [
    { flow: "checkout:discount", draftKey: "checkoutDraft" },
    { flow: "payment:receipt", draftKey: "paymentDraft" },
    { flow: "wallet:topup:amount", draftKey: "walletTopupDraft" },
    { flow: "renew:discount", draftKey: "renewalDraft" },
    { flow: "extra_volume:discount", draftKey: "extraVolumeDraft" },
    { flow: "extra_time:discount", draftKey: "extraTimeDraft" },
  ];

  function armedSession(flow: string, draftKey: string): SessionData {
    const session = initialSession();
    session.currentFlow = flow;
    (session.temp as Record<string, unknown>)[draftKey] = { marker: true };
    session.temp.checkoutDraft = { marker: true } as never;
    return session;
  }

  it("opening the Pricing root clears every incompatible checkout/payment flow + draft", async () => {
    for (const { flow, draftKey } of INCOMPATIBLE_FLOWS) {
      const session = armedSession(flow, draftKey);
      await dispatch(PRICE_CB.root, user, session);
      expect(session.currentFlow, `${flow} currentFlow cleared`).toBeNull();
      expect((session.temp as Record<string, unknown>)[draftKey], `${draftKey} cleared`).toBeUndefined();
      expect(session.temp.checkoutDraft, "checkoutDraft cleared").toBeUndefined();
    }
  });

  it("a stale user:price:* navigation callback also clears the old checkout state", async () => {
    const session = armedSession("checkout:discount", "checkoutDraft");
    await dispatch(PRICE_CB.serviceRoot, user, session);
    expect(session.currentFlow).toBeNull();
    expect(session.temp.checkoutDraft).toBeUndefined();
  });

  it("opening a Product detail creates no draft (and clears any stale one)", async () => {
    const session = armedSession("checkout:discount", "checkoutDraft");
    const before = await prisma.checkoutSession.count({ where: { userId: user.id } });
    await dispatch(
      PRICE_CB.serviceDetail(
        serviceProduct.id.slice(0, 8),
        panel.id.slice(0, 8),
        serviceCategory.id.slice(0, 8),
        1,
      ),
      user,
      session,
    );
    expect(session.currentFlow).toBeNull();
    expect(session.temp.checkoutDraft).toBeUndefined();
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(before);
  });

  it("Pricing Buy seeds exactly one fresh retail draft (no financial record)", async () => {
    const session = initialSession();
    const before = await prisma.checkoutSession.count({ where: { userId: user.id } });
    const payBefore = await prisma.payment.count({ where: { userId: user.id } });
    await dispatch(
      PRICE_CB.serviceBuy(
        serviceProduct.id.slice(0, 8),
        panel.id.slice(0, 8),
        serviceCategory.id.slice(0, 8),
        1,
      ),
      user,
      session,
    );
    expect(session.temp.checkoutDraft).toBeDefined();
    expect(session.temp.checkoutDraft?.representative).toBeUndefined();
    expect(session.temp.checkoutDraft?.finalPriceToman).toBe(150_000);
    expect(session.temp.checkoutDraft?.origin?.kind).toBe("PRICING_SERVICE");
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(before);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(payBefore);
  });

  // §A/§C — live message + toast bounds --------------------------------------

  it("the root renders within the limit even with 4000-char intro + disclaimer", async () => {
    await prisma.messageTemplate.update({
      where: { key: "pricing_page_intro" },
      data: { currentContent: "a".repeat(4000) },
    });
    await prisma.messageTemplate.update({
      where: { key: "pricing_page_disclaimer" },
      data: { currentContent: "ب".repeat(4000) },
    });
    clearTextCache();
    const cap = await dispatch(PRICE_CB.root, user, initialSession());
    const view = cap.edits.at(-1);
    expect(view).toBeDefined();
    expect(withinTelegramLimit(view?.text ?? "", PRICING_ROOT_SAFE_LIMIT)).toBe(true);
    // Counts + keyboard survive (no edit+reply double failure).
    expect(view?.text).toContain("قابل خرید:");
    expect(view?.buttons.some((b) => b.data === PRICE_CB.serviceRoot)).toBe(true);
    expect(cap.edits).toHaveLength(1);
  });

  it("the unavailable toast is bounded to the callback limit and falls back when blank", async () => {
    // 4000-char template → toast bounded.
    await prisma.messageTemplate.update({
      where: { key: "pricing_page_product_unavailable" },
      data: { currentContent: "x".repeat(4000) },
    });
    clearTextCache();
    const forged = PRICE_CB.serviceDetail("ffffffff", panel.id.slice(0, 8), serviceCategory.id.slice(0, 8), 1);
    const cap = await dispatch(forged, user, initialSession());
    const toast = cap.toasts.find((t) => t !== undefined) ?? "";
    expect(toast.length).toBeLessThanOrEqual(CALLBACK_TOAST_SAFE_LIMIT);
    // The stale product still refreshed to a real catalog page.
    expect(cap.edits.length).toBeGreaterThan(0);

    // Blank template → safe fallback default.
    await prisma.messageTemplate.update({
      where: { key: "pricing_page_product_unavailable" },
      data: { currentContent: "   " },
    });
    clearTextCache();
    const cap2 = await dispatch(forged, user, initialSession());
    expect((cap2.toasts.find((t) => t !== undefined) ?? "").length).toBeGreaterThan(0);
  });

  it("stale-product refresh still runs even when answering the callback throws", async () => {
    const forged = PRICE_CB.serviceDetail("ffffffff", panel.id.slice(0, 8), serviceCategory.id.slice(0, 8), 1);
    const cap = await dispatch(forged, user, initialSession(), /* throwOnAnswer */ true);
    // safeAnswerCallback swallows the failure, so the list refresh still edits.
    expect(cap.edits.length).toBeGreaterThan(0);
  });
});
