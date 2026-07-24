import { randomUUID } from "node:crypto";

import { errorMessage, normalizeServiceNote, validateServiceUsername } from "@zedbot/shared";
import { type CheckoutSession, ServiceUsernameMode } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  isWalletPaymentEnabled,
  WALLET_PAYMENT_DISABLED_TEXT,
} from "../../services/payment-settings.service.js";
import type { CheckoutDraft, CheckoutOrigin } from "../../core/session.js";
import {
  categoriesOf,
  getPurchasablePanelByShortId,
  isProductVisible,
  purchasablePanels,
  visibleOtherProducts,
  visibleServiceProducts,
} from "../../services/catalog.service.js";
import {
  checkoutShortId,
  createCheckoutSession,
  getCheckoutByShortId,
} from "../../services/checkout.service.js";
import { validateDiscountCode } from "../../services/discount.service.js";
import { resolveEffectiveProductPrice } from "../../services/representative-pricing.service.js";
import { getPendingReviewPayment } from "../../services/payment-method.service.js";
import { getProductByShortId, type ProductWithRelations } from "../../services/product.service.js";
import {
  NAMING_INCOMPLETE_TEXT,
  namingConfigFromPanel,
  validateNamingConfig,
} from "../../services/service-naming.service.js";
import { dispatchPaidOrderFulfillment } from "../../services/order-fulfillment.service.js";
import {
  releaseReservation,
  reserveRandomServiceUsername,
  reserveServiceUsername,
} from "../../services/service-username-selection.service.js";
import {
  payPurchaseDraftWithWallet,
  WALLET_PAYMENT_DONE_TEXT,
} from "../../services/wallet-payment.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { clearCheckoutState } from "./checkout-state.js";
import { ccb, CO_CB } from "./checkout-cb.js";
import {
  categoryListKeyboard,
  checkoutViewText,
  EMPTY_CATALOG_TEXT,
  LEGACY_STEP_TEXT,
  NO_CATEGORY_TEXT,
  NO_PANEL_TEXT,
  NO_PRODUCT_TEXT,
  panelListKeyboard,
  PICK_CATEGORY_TEXT,
  PICK_PANEL_TEXT,
  PICK_PRODUCT_TEXT,
  preInvoiceKeyboard,
  preInvoiceText,
  productListKeyboard,
  SERVICE_NOTE_PROMPT_TEXT,
  SERVICE_USERNAME_CUSTOM_PROMPT_TEXT,
  SERVICE_USERNAME_METHOD_TEXT,
  serviceNotePromptKeyboard,
  serviceNoteRejectText,
  serviceUsernameConfirmKeyboard,
  serviceUsernameConfirmText,
  serviceUsernameCustomPromptKeyboard,
  serviceUsernameMethodKeyboard,
  serviceUsernameRejectText,
  serviceUsernameUnavailableText,
  walletConfirmText,
  walletPayAvailable,
} from "./checkout-views.js";
import { showPaymentMethods } from "./payment.handler.js";
import { CHECKOUT_EXPIRED_TEXT, paycb, RECEIPT_WAITING_TEXT } from "./payment-views.js";

const HTML = { parseMode: "HTML" as const };
const DRAFT_EXPIRED_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره محصول را انتخاب کنید.";

export const checkoutHandler = new Composer<BotContext>();

// --- helpers ---------------------------------------------------------------------

function backKeyboard(backCb: string): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت", backCb);
}

// Service-checkout username selection (feat/service-checkout-username-note).
const SVC_USERNAME_FLOW = "checkout:service_username";
const SVC_NOTE_FLOW = "checkout:service_note";

/**
 * True when this draft must run the SERVICE username/note steps before its
 * pre-invoice renders: a SERVICE_PRODUCT that provisions a normal VPN account
 * (has a panel). OTHER_PRODUCT and panel-less drafts skip it entirely.
 */
function draftNeedsServiceCustomization(draft: CheckoutDraft): boolean {
  return draft.flowType === "SERVICE_PRODUCT" && draft.panelId !== undefined;
}

function serviceCustomizationComplete(draft: CheckoutDraft): boolean {
  return draft.serviceCustomization?.completed === true;
}

export async function renderPreInvoice(ctx: BotContext, edit: boolean): Promise<void> {
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (product === null || product.id !== draft.productId || !isProductVisible(product, user.group)) {
    clearCheckoutState(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  // THE single gate: a SERVICE checkout never shows its pre-invoice until the
  // buyer has chosen a username and entered/skipped the optional note. This one
  // check covers ALL entry paths (retail, pricing, representative) because they
  // all converge on renderPreInvoice.
  if (draftNeedsServiceCustomization(draft) && !serviceCustomizationComplete(draft)) {
    await renderServiceUsernameEntry(ctx, draft, edit);
    return;
  }
  const text = preInvoiceText(product, user, draft);
  const keyboard = preInvoiceKeyboard(draft, user, await isWalletPaymentEnabled());
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

/**
 * THE single authoritative retail pre-invoice builder (feat/public-pricing-catalog
 * §11). Both the normal retail buy-list flow and the new Pricing page enter the
 * existing checkout through here, so there is exactly one checkout-draft builder.
 *
 * It clears any incompatible previous checkout/discount state, seeds a fresh
 * typed CheckoutDraft priced from the CURRENT `product.priceToman`, records the
 * existing product/category/panel identifiers, mints the wallet-payment
 * idempotency nonce, stamps the navigation-only `origin`, and renders the
 * existing pre-invoice. It moves NO money and creates NO Payment / Order /
 * CheckoutSession / Service / panel call.
 */
export async function startRetailPreInvoice(
  ctx: BotContext,
  product: ProductWithRelations,
  origin: CheckoutOrigin,
): Promise<void> {
  // Selecting a different product abandons any in-progress username reservation
  // from the previous draft: release its HELD hold now so the username frees up
  // immediately (the cleanup worker is only the backstop).
  await releaseDraftReservationBestEffort(ctx.session.temp.checkoutDraft);
  clearCheckoutState(ctx);
  ctx.session.currentFlow = null;
  const draft: CheckoutDraft = {
    productId: product.id,
    categoryId: product.categoryId,
    panelId: product.panelId ?? undefined,
    flowType: product.type,
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
    // One nonce per pre-invoice: the wallet payment's idempotency key.
    draftNonce: randomUUID(),
    // Pure navigation metadata (§12): drives ONLY the «بازگشت» destination.
    origin,
  };
  ctx.session.temp.checkoutDraft = draft;
  await renderPreInvoice(ctx, true);
}

// --- Buy subscription flow (panel-first, Phase 11.1) ------------------------------
// No hardcoded "service type" step: real ACTIVE + visible panels are the
// first choice, skipped entirely when only one panel exists.

/** Categories of one panel that contain >=1 buyable product for this user. */
async function renderCategoriesForPanel(ctx: BotContext, panelId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const panels = await purchasablePanels();
  const panel = panels.find((p) => p.id === panelId);
  if (panel === undefined) {
    await safeEditOrReply(ctx, NO_PANEL_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const multiplePanels = panels.length > 1;
  const backCb = multiplePanels ? CO_CB.BUY : CB.USER_MENU;
  const backLabel = multiplePanels ? "بازگشت به انتخاب پنل" : "بازگشت به منو";
  const products = await visibleServiceProducts(user.group, panel.id);
  if (products.length === 0) {
    await safeEditOrReply(
      ctx,
      NO_CATEGORY_TEXT,
      new InlineKeyboard().text(backLabel, backCb).row().text("بازگشت به منو", CB.USER_MENU),
    );
    return;
  }
  const categories = categoriesOf(products);
  const panelSid = panel.id.slice(0, 8);
  const kb = categoryListKeyboard(categories, (catSid) => ccb.buyCategory(panelSid, catSid), backCb);
  await safeEditOrReply(ctx, PICK_CATEGORY_TEXT, kb);
}

export async function startBuyFlow(ctx: BotContext): Promise<void> {
  clearCheckoutState(ctx);
  const panels = await purchasablePanels();
  if (panels.length === 0) {
    await safeEditOrReply(ctx, NO_PANEL_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  if (panels.length === 1) {
    // Single panel: skip panel selection entirely.
    await renderCategoriesForPanel(ctx, panels[0].id);
    return;
  }
  await safeEditOrReply(ctx, PICK_PANEL_TEXT, panelListKeyboard(panels));
}

checkoutHandler.callbackQuery(CO_CB.BUY, async (ctx) => {
  await safeAnswerCallback(ctx);
  await startBuyFlow(ctx);
});

checkoutHandler.callbackQuery(/^user:buy:panel:([0-9a-f-]+)$/, async (ctx) => {
  const panel = await getPurchasablePanelByShortId(ctx.match[1]);
  if (panel === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  await renderCategoriesForPanel(ctx, panel.id);
});

checkoutHandler.callbackQuery(/^user:buy:cat:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const panel = await getPurchasablePanelByShortId(ctx.match[1]);
  if (panel === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  const catPrefix = ctx.match[2];
  const products = (await visibleServiceProducts(user.group, panel.id)).filter((p) =>
    p.categoryId.startsWith(catPrefix),
  );
  await safeAnswerCallback(ctx);
  const panelSid = panel.id.slice(0, 8);
  if (products.length === 0) {
    await safeEditOrReply(
      ctx,
      NO_PRODUCT_TEXT,
      new InlineKeyboard()
        .text("بازگشت به دسته‌بندی‌ها", ccb.buyPanel(panelSid))
        .row()
        .text("بازگشت به منو", CB.USER_MENU),
    );
    return;
  }
  await safeEditOrReply(
    ctx,
    PICK_PRODUCT_TEXT,
    productListKeyboard(
      products,
      (sid) => ccb.buyProduct(panelSid, catPrefix.slice(0, 8), sid),
      ccb.buyPanel(panelSid),
    ),
  );
});

checkoutHandler.callbackQuery(/^user:buy:prod:([0-9a-f-]+):([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  // Never trust the callback alone: panel/category/product are re-resolved
  // and cross-checked against each other and the user's group.
  const panel = await getPurchasablePanelByShortId(ctx.match[1]);
  const product = await getProductByShortId(ctx.match[3]);
  if (
    panel === null ||
    product === null ||
    product.type !== "SERVICE_PRODUCT" ||
    product.panelId !== panel.id ||
    !product.categoryId.startsWith(ctx.match[2]) ||
    !isProductVisible(product, user.group)
  ) {
    await safeAnswerCallback(ctx, "این محصول در حال حاضر قابل خرید نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  await startRetailPreInvoice(ctx, product, { kind: "RETAIL_CATALOG" });
});

// Legacy compatibility: the removed "service type" step (old keyboards may
// still be open in chats). Redirect into the panel-first flow.
checkoutHandler.callbackQuery(
  [/^user:buy:loc:(M|D|T|A)$/, /^user:buy:cat:(M|D|T|A):([0-9a-f-]+)$/, /^user:buy:p:(M|D|T|A):([0-9a-f-]+)$/],
  async (ctx) => {
    await safeAnswerCallback(ctx, LEGACY_STEP_TEXT);
    await startBuyFlow(ctx);
  },
);

// --- Other products flow --------------------------------------------------------------

export async function openOtherProductsSection(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearCheckoutState(ctx);
  const products = await visibleOtherProducts(user.group);
  await safeAnswerCallback(ctx);
  if (products.length === 0) {
    await safeEditOrReply(ctx, EMPTY_CATALOG_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const categories = categoriesOf(products);
  await safeEditOrReply(
    ctx,
    "دسته‌بندی را انتخاب کنید:",
    categoryListKeyboard(categories, (catSid) => ccb.otherCategory(catSid), CB.USER_MENU),
  );
}

checkoutHandler.callbackQuery(CO_CB.OTHER, openOtherProductsSection);

checkoutHandler.callbackQuery(/^user:op:cat:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const catPrefix = ctx.match[1];
  const products = (await visibleOtherProducts(user.group)).filter((p) =>
    p.categoryId.startsWith(catPrefix),
  );
  await safeAnswerCallback(ctx);
  if (products.length === 0) {
    await safeEditOrReply(ctx, EMPTY_CATALOG_TEXT, backKeyboard(CO_CB.OTHER));
    return;
  }
  await safeEditOrReply(
    ctx,
    "محصول را انتخاب کنید:",
    productListKeyboard(products, (sid) => ccb.otherProduct(sid), CO_CB.OTHER),
  );
});

checkoutHandler.callbackQuery(/^user:op:p:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const product = await getProductByShortId(ctx.match[1]);
  if (product === null || product.type !== "OTHER_PRODUCT" || !isProductVisible(product, user.group)) {
    await safeAnswerCallback(ctx, "این محصول در حال حاضر قابل خرید نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  await startRetailPreInvoice(ctx, product, { kind: "RETAIL_CATALOG" });
});

// =============================================================================
// Service username + optional note (feat/service-checkout-username-note).
// Inserted BEFORE the pre-invoice for every paid SERVICE checkout. Flow:
//   method page → (custom text | random) → confirm → optional note → pre-invoice
// The durable authority is the DB reservation; the session draft only drives UI.
// =============================================================================

/** Best-effort release of a draft's HELD username reservation (fire safe). */
async function releaseDraftReservationBestEffort(
  draft: CheckoutDraft | undefined,
): Promise<void> {
  const reservationId = draft?.serviceCustomization?.reservationId;
  if (reservationId === undefined) {
    return;
  }
  try {
    await releaseReservation(reservationId);
  } catch (err) {
    logger.warn("release username reservation failed", { error: errorMessage(err) });
  }
}

/** Route to the method page (no choice yet) or the confirm page (username held). */
async function renderServiceUsernameEntry(
  ctx: BotContext,
  draft: CheckoutDraft,
  edit: boolean,
): Promise<void> {
  let text: string;
  let keyboard: InlineKeyboard;
  if (draft.serviceCustomization === undefined) {
    text = SERVICE_USERNAME_METHOD_TEXT;
    keyboard = serviceUsernameMethodKeyboard();
  } else {
    const isRandom = draft.serviceCustomization.usernameMode === ServiceUsernameMode.RANDOM;
    text = serviceUsernameConfirmText(draft.serviceCustomization.normalizedUsername, isRandom);
    keyboard = serviceUsernameConfirmKeyboard(isRandom);
  }
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

/** Reserve an opaque random username (also handles regenerate) and show confirm. */
async function reserveRandomAndShow(ctx: BotContext, draft: CheckoutDraft): Promise<void> {
  const user = ctx.dbUser;
  if (user === null || draft.panelId === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const result = await reserveRandomServiceUsername({
    userId: user.id,
    panelId: draft.panelId,
    draftNonce: draft.draftNonce ?? null,
  });
  if (result.outcome !== "AVAILABLE") {
    await safeAnswerCallback(ctx, serviceUsernameUnavailableText(result.outcome));
    return;
  }
  draft.serviceCustomization = {
    usernameMode: ServiceUsernameMode.RANDOM,
    normalizedUsername: result.normalizedUsername,
    reservationId: result.reservationId,
    note: null,
    usernameConfirmedAt: new Date().toISOString(),
    completed: false,
  };
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await renderServiceUsernameEntry(ctx, draft, true);
}

// Pick "type my own username": arm the bounded text-input flow.
checkoutHandler.callbackQuery(CO_CB.UN_CUSTOM, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || !draftNeedsServiceCustomization(draft)) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  ctx.session.currentFlow = SVC_USERNAME_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    SERVICE_USERNAME_CUSTOM_PROMPT_TEXT,
    serviceUsernameCustomPromptKeyboard(),
    HTML,
  );
});

// Pick "generate a random username".
checkoutHandler.callbackQuery(CO_CB.UN_RANDOM, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || !draftNeedsServiceCustomization(draft)) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  await reserveRandomAndShow(ctx, draft);
});

// Regenerate a fresh random username (releases the prior hold via same-nonce reserve).
checkoutHandler.callbackQuery(CO_CB.UN_REGEN, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || draft.serviceCustomization === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  await reserveRandomAndShow(ctx, draft);
});

// Back to the method-choice page: release the current hold.
checkoutHandler.callbackQuery(CO_CB.UN_METHOD, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || !draftNeedsServiceCustomization(draft)) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  await releaseDraftReservationBestEffort(draft);
  draft.serviceCustomization = undefined;
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await renderServiceUsernameEntry(ctx, draft, true);
});

// Confirm the chosen username → move to the optional-note step.
checkoutHandler.callbackQuery(CO_CB.UN_CONFIRM, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || draft.serviceCustomization === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  ctx.session.currentFlow = SVC_NOTE_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, SERVICE_NOTE_PROMPT_TEXT, serviceNotePromptKeyboard(), HTML);
});

// Skip the optional note (stores null) → render the pre-invoice.
checkoutHandler.callbackQuery(CO_CB.NOTE_SKIP, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || draft.serviceCustomization === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.serviceCustomization.note = null;
  draft.serviceCustomization.completed = true;
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await renderPreInvoice(ctx, true);
});

// --- Discount code ---------------------------------------------------------------------

checkoutHandler.callbackQuery(CO_CB.DISCOUNT, async (ctx) => {
  if (ctx.session.temp.checkoutDraft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  ctx.session.currentFlow = "checkout:discount";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "کد تخفیف را وارد کنید.",
    new InlineKeyboard().text("انصراف", CO_CB.BACK_TO_INVOICE),
  );
});

checkoutHandler.callbackQuery(CO_CB.BACK_TO_INVOICE, async (ctx) => {
  if (ctx.session.currentFlow === "checkout:discount") {
    ctx.session.currentFlow = null;
  }
  await safeAnswerCallback(ctx);
  await renderPreInvoice(ctx, true);
});

checkoutHandler.callbackQuery(CO_CB.DISCOUNT_CLEAR, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.discountCode = undefined;
  draft.discountCodeId = undefined;
  draft.discountAmountToman = 0;
  draft.finalPriceToman = draft.originalPriceToman;
  await safeAnswerCallback(ctx, "کد تخفیف حذف شد.");
  await renderPreInvoice(ctx, true);
});

// --- Wallet payment (Phase 15) ------------------------------------------------------------

checkoutHandler.callbackQuery(CO_CB.WALLET, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  // Phase 22: operator kill-switch, re-checked when the button is clicked.
  if (!(await isWalletPaymentEnabled())) {
    await safeAnswerCallback(ctx, WALLET_PAYMENT_DISABLED_TEXT);
    await renderPreInvoice(ctx, true);
    return;
  }
  // Other-product-wallet phase: both product types pay here; only the
  // balance still gates the button.
  if (!walletPayAvailable(user, draft.finalPriceToman)) {
    await safeAnswerCallback(ctx, "موجودی کیف پول کافی نیست.");
    await renderPreInvoice(ctx, true);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    walletConfirmText(draft.finalPriceToman, user.balanceToman),
    new InlineKeyboard()
      .text("تایید پرداخت ✅", CO_CB.WALLET_CONFIRM)
      .row()
      .text("انصراف", CO_CB.BACK_TO_INVOICE),
  );
});

// Only this callback deducts - and only through the atomic service.
checkoutHandler.callbackQuery(CO_CB.WALLET_CONFIRM, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  try {
    const result = await payPurchaseDraftWithWallet(user, draft);
    if (!result.ok) {
      await safeAnswerCallback(ctx, result.error);
      await renderPreInvoice(ctx, true);
      return;
    }
    clearCheckoutState(ctx);
    if (result.alreadyPaid) {
      await safeAnswerCallback(ctx, "پرداخت قبلاً انجام شده است.");
      return;
    }
    await safeAnswerCallback(ctx, "پرداخت شد ✅");
    await safeEditOrReply(ctx, WALLET_PAYMENT_DONE_TEXT, backKeyboard(CB.USER_MENU));

    // Money committed above - fulfillment goes through the UNIFIED dispatcher
    // (same as gateway settlements and receipt approvals): provisioning for
    // service products, stock/manual delivery for other products. Exactly one
    // dispatch per payment - the alreadyPaid replay path above never reaches
    // this line.
    await dispatchPaidOrderFulfillment(ctx.api, result.order.id, {
      source: "WALLET",
      user,
    });
  } catch (err) {
    logger.error("wallet purchase payment failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// --- Continue: creates the PENDING checkout (card-to-card path) -----------------------------

checkoutHandler.callbackQuery(CO_CB.CONTINUE, async (ctx) => {
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    product === null ||
    product.id !== draft.productId ||
    !isProductVisible(product, user.group)
  ) {
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }

  // Re-validate pricing + discount at click time (price/code may have changed).
  if (draft.representative !== undefined) {
    // Representative purchase (§16): re-resolve the reseller price from live data
    // and fail closed if the tier/price fingerprint changed since the agreement.
    const effective = await resolveEffectiveProductPrice({
      user,
      product,
      checkoutPurpose: "PURCHASE",
      discountCode: null,
      mode: "PREVIEW",
    });
    if (
      effective.pricingMode !== "REPRESENTATIVE" ||
      effective.priceFingerprint !== draft.representative.priceFingerprint ||
      effective.tierFingerprint !== draft.representative.tierFingerprint
    ) {
      clearCheckoutState(ctx);
      await safeAnswerCallback(ctx, "قیمت نمایندگی تغییر کرده است. لطفاً دوباره اقدام کنید.");
      await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard("user:rep:buy"));
      return;
    }
    draft.originalPriceToman = effective.basePriceToman;
    draft.discountAmountToman = effective.discountAmountToman;
    draft.discountCodeId = effective.discountCodeId ?? undefined;
    draft.finalPriceToman = effective.finalPriceToman;
  } else {
    draft.originalPriceToman = product.priceToman;
    if (draft.discountCode !== undefined) {
      const validation = await validateDiscountCode(draft.discountCode, user, product.priceToman);
      if (validation.ok) {
        draft.discountCodeId = validation.discountCode.id;
        draft.discountAmountToman = validation.discountAmountToman;
        draft.finalPriceToman = validation.finalPriceToman;
      } else {
        draft.discountCode = undefined;
        draft.discountCodeId = undefined;
        draft.discountAmountToman = 0;
        draft.finalPriceToman = product.priceToman;
        await safeAnswerCallback(ctx, "کد تخفیف دیگر معتبر نیست و حذف شد.");
        await renderPreInvoice(ctx, true);
        return;
      }
    } else {
      draft.finalPriceToman = product.priceToman;
    }
  }

  // Naming phase gate: a strategy whose required config is missing blocks
  // checkout BEFORE any payment - the user is never charged for an order
  // whose identity cannot be resolved.
  if (product.type === "SERVICE_PRODUCT" && product.panel !== null) {
    const naming = validateNamingConfig(namingConfigFromPanel(product.panel));
    if (!naming.ok) {
      await safeAnswerCallback(ctx, NAMING_INCOMPLETE_TEXT);
      return;
    }
  }

  try {
    const checkout = await createCheckoutSession(user, product, draft);
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx, "ثبت شد ✅");
    await showPaymentMethods(ctx, checkout, { created: true });
    logger.info("checkout session created", {
      checkoutId: checkout.id,
      userId: user.id,
      productId: product.id,
      finalPriceToman: checkout.finalPriceToman,
    });
  } catch (err) {
    logger.error("checkout creation failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

/**
 * Renders the read-only checkout detail page for an ALREADY owner-resolved
 * checkout. The primary action, when the checkout is still payable, is
 * «انتخاب روش پرداخت» (the method-selection surface); a pending-review receipt or
 * an expired checkout render the corresponding notice with no pay button.
 * Exported so the notification "view details/order" (`d`) action lands on the
 * exact same page. Read-only - never settles or mutates anything.
 */
export async function renderCheckoutView(
  ctx: BotContext,
  checkout: CheckoutSession,
): Promise<void> {
  // Payment state decides what the view offers next.
  const pendingReview = await getPendingReviewPayment(checkout.id);
  const expired = checkout.status === "PENDING" && checkout.expiresAt.getTime() <= Date.now();
  let statusLine = "";
  const kb = new InlineKeyboard();
  if (pendingReview !== null) {
    statusLine = `\n\n${RECEIPT_WAITING_TEXT}`;
  } else if (checkout.status === "PENDING" && !expired) {
    kb.text("انتخاب روش پرداخت 💳", paycb.methods(checkoutShortId(checkout))).row();
  } else if (expired) {
    statusLine = `\n\n${CHECKOUT_EXPIRED_TEXT}`;
  }
  kb.text("بازگشت به منوی اصلی", CB.USER_MENU);
  await safeEditOrReply(ctx, checkoutViewText(checkout) + statusLine, kb, HTML);
}

checkoutHandler.callbackQuery(/^user:co:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const checkout = await getCheckoutByShortId(ctx.match[1], user.id);
  if (checkout === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  await renderCheckoutView(ctx, checkout);
});

// =============================================================================
// Discount-code text input. Only consumes text when the user is in the
// checkout:discount flow (wired in app.ts before the generic fallthrough).
// =============================================================================

export const checkoutTextHandler = new Composer<BotContext>();

checkoutTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow === "checkout:discount") {
    return handleDiscountText(ctx, next);
  }
  if (flow === SVC_USERNAME_FLOW) {
    return handleServiceUsernameText(ctx, next);
  }
  if (flow === SVC_NOTE_FLOW) {
    return handleServiceNoteText(ctx, next);
  }
  return next();
});

async function handleDiscountText(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  const text = ctx.message?.text ?? "";
  // Commands cancel the discount entry (and the draft) and continue normally.
  if (text.startsWith("/")) {
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  try {
    const validation = await validateDiscountCode(text, user, draft.originalPriceToman);
    ctx.session.currentFlow = null;
    if (validation.ok) {
      draft.discountCode = validation.discountCode.code;
      draft.discountCodeId = validation.discountCode.id;
      draft.discountAmountToman = validation.discountAmountToman;
      draft.finalPriceToman = validation.finalPriceToman;
      await safeReply(ctx, "کد تخفیف با موفقیت اعمال شد ✅");
    } else {
      await safeReply(ctx, validation.error);
    }
    await renderPreInvoice(ctx, false);
  } catch (err) {
    ctx.session.currentFlow = null;
    logger.error("discount validation failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
}

// Custom-username text step (feat/service-checkout-username-note). On an invalid
// or unavailable name the flow stays armed so the buyer can simply retype.
async function handleServiceUsernameText(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    await releaseDraftReservationBestEffort(ctx.session.temp.checkoutDraft);
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null || !draftNeedsServiceCustomization(draft) || draft.panelId === undefined) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const validation = validateServiceUsername(text);
  if (!validation.ok) {
    await safeReply(ctx, serviceUsernameRejectText(validation.reason), serviceUsernameCustomPromptKeyboard());
    return;
  }
  const result = await reserveServiceUsername({
    userId: user.id,
    panelId: draft.panelId,
    mode: ServiceUsernameMode.CUSTOM,
    normalizedUsername: validation.normalized,
    draftNonce: draft.draftNonce ?? null,
  });
  if (result.outcome !== "AVAILABLE") {
    await safeReply(
      ctx,
      serviceUsernameUnavailableText(result.outcome),
      serviceUsernameCustomPromptKeyboard(),
    );
    return;
  }
  draft.serviceCustomization = {
    usernameMode: ServiceUsernameMode.CUSTOM,
    normalizedUsername: result.normalizedUsername,
    reservationId: result.reservationId,
    note: null,
    usernameConfirmedAt: new Date().toISOString(),
    completed: false,
  };
  ctx.session.currentFlow = null;
  await renderServiceUsernameEntry(ctx, draft, false);
}

// Optional-note text step. An invalid note keeps the flow armed for a retry.
async function handleServiceNoteText(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || draft.serviceCustomization === undefined) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const normalized = normalizeServiceNote(text);
  if (!normalized.ok) {
    await safeReply(ctx, serviceNoteRejectText(normalized.reason), serviceNotePromptKeyboard());
    return;
  }
  draft.serviceCustomization.note = normalized.normalized.length > 0 ? normalized.normalized : null;
  draft.serviceCustomization.completed = true;
  ctx.session.currentFlow = null;
  await renderPreInvoice(ctx, false);
}
