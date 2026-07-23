import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  countCatalogProducts,
  isProductVisible,
  loadUserRetailCatalog,
  minRetailPrice,
  type RetailCatalogServicePanel,
  type UserRetailCatalog,
} from "../../services/catalog.service.js";
import { getProductByShortId } from "../../services/product.service.js";
import { isRepresentativeProgramEnabled } from "../../services/representative-settings.service.js";
import { getRepresentativeByUserId } from "../../services/representative.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import { startRetailPreInvoice } from "../user-checkout/checkout.handler.js";
import { PRICE_CB, parsePricingPage } from "./pricing-cb.js";
import {
  buttonName,
  categorySummaryLine,
  formatToman,
  otherDetailBody,
  otherProductCard,
  panelSummaryLine,
  serviceDetailBody,
  serviceProductCard,
} from "./pricing-views.js";

// =============================================================================
// The public retail Pricing Catalog (feat/public-pricing-catalog, roadmap
// item 3). A READ-ONLY catalog + navigation surface: it displays current retail
// prices straight from active Product.priceToman via the ONE authoritative
// `loadUserRetailCatalog`, respects the user's group + panel/category/panel
// readiness, and lets the user enter the EXISTING retail pre-invoice through the
// shared `startRetailPreInvoice`. Browsing creates NO financial or stock record;
// pressing Buy only seeds the in-session draft. Representative pricing stays
// entirely inside the existing Representative surface.
// =============================================================================

const HTML = { parseMode: "HTML" as const };

// Deterministic bounded pagination (task §14).
const PANELS_PAGE_SIZE = 8;
const CATEGORIES_PAGE_SIZE = 8;
const PRODUCTS_PAGE_SIZE = 5;

const BACK_TO_MENU = "بازگشت به منوی اصلی";

/** Short spinner toast when a re-resolved product is stale/forged/hidden. */
async function unavailableToast(): Promise<string> {
  return getMessageTemplate("pricing_page_product_unavailable");
}

export const pricingHandler = new Composer<BotContext>();

// --- shared helpers ----------------------------------------------------------

interface PageSlice<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** Deterministic in-memory pagination; under/overflow clamps to a valid page. */
function paginate<T>(items: T[], page: number, size: number): PageSlice<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const safe = Math.min(Math.max(1, page), pages);
  return { items: items.slice((safe - 1) * size, safe * size), page: safe, pages, total };
}

type Resolved<T> = { ok: true; value: T } | { ok: false; reason: "not_found" | "ambiguous" };

/**
 * Ambiguity-safe short-id resolution within an already-loaded set: zero → not
 * found, two+ → ambiguous, never silently the newest (task §15).
 */
function resolveByShortId<T>(items: T[], shortId: string, idOf: (t: T) => string): Resolved<T> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return { ok: false, reason: "not_found" };
  }
  const matches = items.filter((it) => idOf(it).startsWith(shortId));
  if (matches.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, value: matches[0] };
}

/** Appends a bounded «قبلی/صفحه/بعدی» pagination row when there is >1 page. */
async function appendPageFooter(
  kb: InlineKeyboard,
  build: (page: number) => string,
  slice: PageSlice<unknown>,
): Promise<void> {
  if (slice.pages <= 1) {
    return;
  }
  if (slice.page > 1) {
    kb.text(await getButtonText("previous"), build(slice.page - 1));
  }
  kb.text(`${slice.page}/${slice.pages}`, build(slice.page));
  if (slice.page < slice.pages) {
    kb.text(await getButtonText("next"), build(slice.page + 1));
  }
  kb.row();
}

/**
 * Whether the EXISTING representative surface currently applies to the user
 * (task §5/§7): the program master switch is on AND the user is an ACTIVE or
 * SUSPENDED representative. Never resolves or snapshots any representative price
 * here — it only decides whether to render a NAVIGATION link into that surface.
 */
export async function isRepresentativeSurfaceApplicable(userId: string): Promise<boolean> {
  if (!(await isRepresentativeProgramEnabled())) {
    return false;
  }
  const rep = await getRepresentativeByUserId(userId);
  return rep !== null && (rep.status === "ACTIVE" || rep.status === "SUSPENDED");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// --- Pricing root ------------------------------------------------------------

/**
 * Renders the pricing root: safe summary counts + section buttons. Entry for
 * BOTH the inline callback (CB.USER_PRICING) and the reply-keyboard menu action.
 */
export async function renderPricingRoot(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const [catalog, intro, disclaimer, repApplicable] = await Promise.all([
    loadUserRetailCatalog(user),
    getMessageTemplate("pricing_page_intro"),
    getMessageTemplate("pricing_page_disclaimer"),
    isRepresentativeSurfaceApplicable(user.id),
  ]);
  const serviceCount = catalog.servicePanels.reduce(
    (sum, p) => sum + countCatalogProducts(p),
    0,
  );
  const otherCount = catalog.otherProductCategories.reduce((sum, c) => sum + c.products.length, 0);

  const body = [
    "💰 تعرفه‌ها",
    "",
    intro,
    "",
    `🌐 پلن‌های اشتراک قابل خرید: ${serviceCount}`,
    `🛍 محصولات دیگر قابل خرید: ${otherCount}`,
    "",
    disclaimer,
  ].join("\n");

  const kb = new InlineKeyboard()
    .text(await getButtonText("pricing_services"), PRICE_CB.serviceRoot)
    .row()
    .text(await getButtonText("pricing_other_products"), PRICE_CB.otherRoot)
    .row();
  if (repApplicable) {
    kb.text(await getButtonText("pricing_representative"), PRICE_CB.representative).row();
  }
  kb.text(BACK_TO_MENU, CB.USER_MENU);

  await safeEditOrReply(ctx, body, kb);
  ctx.session.lastMenu = CB.USER_PRICING;
}

// --- Service branch: panels → categories → products → detail -----------------

async function renderServicePanels(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const catalog = await loadUserRetailCatalog(user);
  if (catalog.servicePanels.length === 0) {
    await safeEditOrReply(
      ctx,
      `🌐 تعرفه اشتراک‌ها\n\n${await getMessageTemplate("pricing_page_empty_services")}`,
      new InlineKeyboard().text("بازگشت به تعرفه‌ها", PRICE_CB.root).row().text(BACK_TO_MENU, CB.USER_MENU),
    );
    return;
  }
  // Single-panel shortcut: jump straight to its categories (task §8).
  if (catalog.servicePanels.length === 1) {
    await renderServiceCategoriesFor(ctx, catalog, catalog.servicePanels[0], 1);
    return;
  }
  const slice = paginate(catalog.servicePanels, page, PANELS_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const entry of slice.items) {
    const count = countCatalogProducts(entry);
    const min = minRetailPrice(entry.categories.flatMap((c) => c.products));
    kb.text(
      `${buttonName(entry.panel.name)} · ${count} · از ${formatToman(min)}`,
      PRICE_CB.servicePanel(shortId(entry.panel.id), 1),
    ).row();
  }
  await appendPageFooter(kb, (p) => PRICE_CB.serviceRootPage(p), slice);
  kb.text("بازگشت به تعرفه‌ها", PRICE_CB.root).text(BACK_TO_MENU, CB.USER_MENU);

  const cards = slice.items.map((entry) =>
    panelSummaryLine(
      entry.panel.name,
      countCatalogProducts(entry),
      minRetailPrice(entry.categories.flatMap((c) => c.products)),
    ),
  );
  await safeEditOrReply(
    ctx,
    `🌐 <b>تعرفه اشتراک‌ها</b> — صفحه ${slice.page}/${slice.pages}\n\n${cards.join("\n\n")}`,
    kb,
    HTML,
  );
}

async function renderServiceCategories(ctx: BotContext, panelSid: string, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const catalog = await loadUserRetailCatalog(user);
  const resolved = resolveByShortId(catalog.servicePanels, panelSid, (e) => e.panel.id);
  if (!resolved.ok) {
    await renderServicePanels(ctx, 1);
    return;
  }
  await renderServiceCategoriesFor(ctx, catalog, resolved.value, page);
}

async function renderServiceCategoriesFor(
  ctx: BotContext,
  catalog: UserRetailCatalog,
  panelEntry: RetailCatalogServicePanel,
  page: number,
): Promise<void> {
  // Deterministic back target: the panel list when >1 panel, else the root.
  const backCb = catalog.servicePanels.length > 1 ? PRICE_CB.serviceRoot : PRICE_CB.root;
  const panelSid = shortId(panelEntry.panel.id);
  const slice = paginate(panelEntry.categories, page, CATEGORIES_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const cat of slice.items) {
    kb.text(
      `${buttonName(cat.category.name)} · ${cat.products.length} · از ${formatToman(minRetailPrice(cat.products))}`,
      PRICE_CB.serviceCategory(panelSid, shortId(cat.category.id), 1),
    ).row();
  }
  await appendPageFooter(kb, (p) => PRICE_CB.servicePanel(panelSid, p), slice);
  kb.text("بازگشت", backCb).text(BACK_TO_MENU, CB.USER_MENU);

  const cards = slice.items.map((c) =>
    categorySummaryLine(c.category.name, c.products.length, minRetailPrice(c.products)),
  );
  await safeEditOrReply(
    ctx,
    `🌐 <b>${escapeHtml(panelEntry.panel.name)}</b> — صفحه ${slice.page}/${slice.pages}\n\n${cards.join("\n\n")}`,
    kb,
    HTML,
  );
}

async function renderServiceProducts(
  ctx: BotContext,
  panelSid: string,
  catSid: string,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const catalog = await loadUserRetailCatalog(user);
  const panel = resolveByShortId(catalog.servicePanels, panelSid, (e) => e.panel.id);
  if (!panel.ok) {
    await renderServicePanels(ctx, 1);
    return;
  }
  const cat = resolveByShortId(panel.value.categories, catSid, (c) => c.category.id);
  if (!cat.ok) {
    await renderServiceCategoriesFor(ctx, catalog, panel.value, 1);
    return;
  }
  const slice = paginate(cat.value.products, page, PRODUCTS_PAGE_SIZE);
  const build = (p: number): string => PRICE_CB.serviceCategory(panelSid, catSid, p);
  const kb = new InlineKeyboard();
  for (const product of slice.items) {
    kb.text(
      `${buttonName(product.name)} · ${formatToman(product.priceToman)}`,
      PRICE_CB.serviceDetail(shortId(product.id), panelSid, catSid, slice.page),
    ).row();
  }
  await appendPageFooter(kb, build, slice);
  kb.text("بازگشت", PRICE_CB.servicePanel(panelSid, 1)).text(BACK_TO_MENU, CB.USER_MENU);

  const cards = slice.items.map((p) => serviceProductCard(p));
  await safeEditOrReply(
    ctx,
    `📂 <b>${escapeHtml(cat.value.category.name)}</b> — صفحه ${slice.page}/${slice.pages}\n\n${cards.join("\n\n")}`,
    kb,
    HTML,
  );
}

async function renderServiceDetail(
  ctx: BotContext,
  prodSid: string,
  panelSid: string,
  catSid: string,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const product = await getProductByShortId(prodSid);
  if (
    product === null ||
    product.type !== "SERVICE_PRODUCT" ||
    product.panel === null ||
    !product.panelId?.startsWith(panelSid) ||
    !product.categoryId.startsWith(catSid) ||
    !isProductVisible(product, user.group)
  ) {
    await safeAnswerCallback(ctx, await unavailableToast());
    await renderServiceProducts(ctx, panelSid, catSid, page);
    return;
  }
  await safeAnswerCallback(ctx);
  const [disclaimer, repApplicable] = await Promise.all([
    getMessageTemplate("pricing_page_disclaimer"),
    isRepresentativeSurfaceApplicable(user.id),
  ]);
  const kb = new InlineKeyboard();
  // Retail CTA. For an active representative it is labelled «خرید عادی این پلن»
  // so it can never be confused with representative checkout; it ALWAYS starts a
  // normal retail pre-invoice (no representative context).
  const cta = repApplicable
    ? "خرید عادی این پلن"
    : await getButtonText("pricing_buy_service");
  kb.text(cta, PRICE_CB.serviceBuy(prodSid, panelSid, catSid, page)).row();
  if (repApplicable) {
    // Optional link into the EXISTING representative tariff surface.
    kb.text(await getButtonText("pricing_representative"), PRICE_CB.representative).row();
  }
  kb.text("بازگشت به لیست", PRICE_CB.serviceCategory(panelSid, catSid, page)).row();
  kb.text(await getButtonText("pricing_back"), PRICE_CB.root).text(BACK_TO_MENU, CB.USER_MENU);

  await safeEditOrReply(ctx, serviceDetailBody(product, escapeHtml(disclaimer)), kb, HTML);
}

// --- Other-product branch: categories → products → detail --------------------

async function renderOtherCategories(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const catalog = await loadUserRetailCatalog(user);
  if (catalog.otherProductCategories.length === 0) {
    await safeEditOrReply(
      ctx,
      `🛍 تعرفه محصولات دیگر\n\n${await getMessageTemplate("pricing_page_empty_other")}`,
      new InlineKeyboard().text("بازگشت به تعرفه‌ها", PRICE_CB.root).row().text(BACK_TO_MENU, CB.USER_MENU),
    );
    return;
  }
  const slice = paginate(catalog.otherProductCategories, page, CATEGORIES_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const cat of slice.items) {
    kb.text(
      `${buttonName(cat.category.name)} · ${cat.products.length} · از ${formatToman(minRetailPrice(cat.products))}`,
      PRICE_CB.otherCategory(shortId(cat.category.id), 1),
    ).row();
  }
  await appendPageFooter(kb, (p) => PRICE_CB.otherRootPage(p), slice);
  kb.text("بازگشت به تعرفه‌ها", PRICE_CB.root).text(BACK_TO_MENU, CB.USER_MENU);

  const cards = slice.items.map((c) =>
    categorySummaryLine(c.category.name, c.products.length, minRetailPrice(c.products)),
  );
  await safeEditOrReply(
    ctx,
    `🛍 <b>تعرفه محصولات دیگر</b> — صفحه ${slice.page}/${slice.pages}\n\n${cards.join("\n\n")}`,
    kb,
    HTML,
  );
}

async function renderOtherProducts(ctx: BotContext, catSid: string, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const catalog = await loadUserRetailCatalog(user);
  const cat = resolveByShortId(catalog.otherProductCategories, catSid, (c) => c.category.id);
  if (!cat.ok) {
    await renderOtherCategories(ctx, 1);
    return;
  }
  const slice = paginate(cat.value.products, page, PRODUCTS_PAGE_SIZE);
  const build = (p: number): string => PRICE_CB.otherCategory(catSid, p);
  const kb = new InlineKeyboard();
  for (const product of slice.items) {
    kb.text(
      `${buttonName(product.name)} · ${formatToman(product.priceToman)}`,
      PRICE_CB.otherDetail(shortId(product.id), catSid, slice.page),
    ).row();
  }
  await appendPageFooter(kb, build, slice);
  kb.text("بازگشت", PRICE_CB.otherRoot).text(BACK_TO_MENU, CB.USER_MENU);

  const cards = slice.items.map((p) => otherProductCard(p));
  await safeEditOrReply(
    ctx,
    `📂 <b>${escapeHtml(cat.value.category.name)}</b> — صفحه ${slice.page}/${slice.pages}\n\n${cards.join("\n\n")}`,
    kb,
    HTML,
  );
}

async function renderOtherDetail(
  ctx: BotContext,
  prodSid: string,
  catSid: string,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const product = await getProductByShortId(prodSid);
  if (
    product === null ||
    product.type !== "OTHER_PRODUCT" ||
    !product.categoryId.startsWith(catSid) ||
    !isProductVisible(product, user.group)
  ) {
    await safeAnswerCallback(ctx, await unavailableToast());
    await renderOtherProducts(ctx, catSid, page);
    return;
  }
  await safeAnswerCallback(ctx);
  const disclaimer = await getMessageTemplate("pricing_page_disclaimer");
  const kb = new InlineKeyboard()
    .text(await getButtonText("pricing_buy_other"), PRICE_CB.otherBuy(prodSid, catSid, page))
    .row()
    .text("بازگشت به لیست", PRICE_CB.otherCategory(catSid, page))
    .row()
    .text(await getButtonText("pricing_back"), PRICE_CB.root)
    .text(BACK_TO_MENU, CB.USER_MENU);
  await safeEditOrReply(ctx, otherDetailBody(product, escapeHtml(disclaimer)), kb, HTML);
}

// --- Direct checkout (Buy) ---------------------------------------------------
// Re-resolves the product live, re-verifies visibility + that the requested
// pricing section matches Product.type, then enters the EXISTING retail
// pre-invoice through the ONE shared helper. No money / Payment / Order moves.

async function buyService(
  ctx: BotContext,
  prodSid: string,
  panelSid: string,
  catSid: string,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const product = await getProductByShortId(prodSid);
  if (
    product === null ||
    product.type !== "SERVICE_PRODUCT" ||
    product.panel === null ||
    product.panelId === null ||
    !product.panelId.startsWith(panelSid) ||
    !product.categoryId.startsWith(catSid) ||
    !isProductVisible(product, user.group)
  ) {
    await safeAnswerCallback(ctx, await unavailableToast());
    await renderServiceProducts(ctx, panelSid, catSid, page);
    return;
  }
  await safeAnswerCallback(ctx);
  await startRetailPreInvoice(ctx, product, {
    kind: "PRICING_SERVICE",
    panelId: product.panelId,
    categoryId: product.categoryId,
    page,
  });
}

async function buyOther(
  ctx: BotContext,
  prodSid: string,
  catSid: string,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const product = await getProductByShortId(prodSid);
  if (
    product === null ||
    product.type !== "OTHER_PRODUCT" ||
    !product.categoryId.startsWith(catSid) ||
    !isProductVisible(product, user.group)
  ) {
    await safeAnswerCallback(ctx, await unavailableToast());
    await renderOtherProducts(ctx, catSid, page);
    return;
  }
  await safeAnswerCallback(ctx);
  await startRetailPreInvoice(ctx, product, {
    kind: "PRICING_OTHER",
    categoryId: product.categoryId,
    page,
  });
}

// --- Callback wiring ---------------------------------------------------------
// Old `user:pricing` keyboards keep working: the root opens the real page.

pricingHandler.callbackQuery(CB.USER_PRICING, renderPricingRoot);

// Service branch. The section root accepts an optional page (panel list).
pricingHandler.callbackQuery(/^user:price:s(?::([0-9a-z]+))?$/, async (ctx) => {
  await renderServicePanels(ctx, parsePricingPage(ctx.match[1]));
});
pricingHandler.callbackQuery(/^user:price:sp:([0-9a-f-]+):([0-9a-z]+)$/, async (ctx) => {
  await renderServiceCategories(ctx, ctx.match[1], parsePricingPage(ctx.match[2]));
});
pricingHandler.callbackQuery(/^user:price:sc:([0-9a-f-]+):([0-9a-f-]+):([0-9a-z]+)$/, async (ctx) => {
  await renderServiceProducts(ctx, ctx.match[1], ctx.match[2], parsePricingPage(ctx.match[3]));
});
pricingHandler.callbackQuery(
  /^user:price:sv:([0-9a-f-]+):([0-9a-f-]+):([0-9a-f-]+):([0-9a-z]+)$/,
  async (ctx) => {
    await renderServiceDetail(
      ctx,
      ctx.match[1],
      ctx.match[2],
      ctx.match[3],
      parsePricingPage(ctx.match[4]),
    );
  },
);
pricingHandler.callbackQuery(
  /^user:price:bs:([0-9a-f-]+):([0-9a-f-]+):([0-9a-f-]+):([0-9a-z]+)$/,
  async (ctx) => {
    await buyService(ctx, ctx.match[1], ctx.match[2], ctx.match[3], parsePricingPage(ctx.match[4]));
  },
);

// Other-product branch. The section root accepts an optional page (category list).
pricingHandler.callbackQuery(/^user:price:o(?::([0-9a-z]+))?$/, async (ctx) => {
  await renderOtherCategories(ctx, parsePricingPage(ctx.match[1]));
});
pricingHandler.callbackQuery(/^user:price:oc:([0-9a-f-]+):([0-9a-z]+)$/, async (ctx) => {
  await renderOtherProducts(ctx, ctx.match[1], parsePricingPage(ctx.match[2]));
});
pricingHandler.callbackQuery(/^user:price:ov:([0-9a-f-]+):([0-9a-f-]+):([0-9a-z]+)$/, async (ctx) => {
  await renderOtherDetail(ctx, ctx.match[1], ctx.match[2], parsePricingPage(ctx.match[3]));
});
pricingHandler.callbackQuery(/^user:price:bo:([0-9a-f-]+):([0-9a-f-]+):([0-9a-z]+)$/, async (ctx) => {
  await buyOther(ctx, ctx.match[1], ctx.match[2], parsePricingPage(ctx.match[3]));
});
