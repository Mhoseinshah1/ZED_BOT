import { randomUUID } from "node:crypto";

import { errorMessage, normalizeServiceNote, validateServiceUsername } from "@zedbot/shared";
import { type CheckoutSession, prisma, ServiceUsernameMode, type User } from "@zedbot/database";
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
  CheckoutReservationError,
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
  isReservationClaimable,
  releaseHeldReservationForDraft,
  reserveRandomServiceUsername,
  reserveServiceUsername,
} from "../../services/service-username-selection.service.js";
import {
  payPurchaseDraftWithWallet,
  WALLET_PAYMENT_DONE_TEXT,
} from "../../services/wallet-payment.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { abandonCheckoutDraft, clearCheckoutState } from "./checkout-state.js";
import { enforceCustomerInfoBeforePayment } from "./customer-input-form.handler.js";
import {
  ccb,
  CO_CB,
  parseCoNonceCallback,
  shortDraftNonce,
  type CoNonceAction,
} from "./checkout-cb.js";
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
  serviceNotePromptKeyboard,
  serviceNotePromptText,
  serviceNoteRejectText,
  serviceUsernameConfirmKeyboard,
  serviceUsernameConfirmText,
  serviceUsernameCustomPromptKeyboard,
  serviceUsernameCustomPromptText,
  serviceUsernameMethodKeyboard,
  serviceUsernameMethodText,
  serviceUsernameRejectText,
  serviceUsernameUnavailableText,
  walletConfirmText,
  walletPayAvailable,
} from "./checkout-views.js";
import { showPaymentMethods } from "./payment.handler.js";
import { CHECKOUT_EXPIRED_TEXT, paycb, RECEIPT_WAITING_TEXT } from "./payment-views.js";

const HTML = { parseMode: "HTML" as const };
const DRAFT_EXPIRED_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره محصول را انتخاب کنید.";
// hotfix §2: a username/note button from an OLD (replaced) draft — fail closed.
const STALE_STEP_TEXT = "این مرحله منقضی شده است؛ لطفاً دوباره اقدام کنید.";
// hotfix §9: whitespace-only note text — invalid, ask again (only «رد کردن» skips).
const SERVICE_NOTE_EMPTY_TEXT =
  "یادداشت خالی است. یک متن کوتاه ارسال کنید یا برای رد کردن، دکمه «رد کردن» را بزنید.";
// hotfix §4: a wallet button fired against an incomplete / drifted / stale SERVICE
// draft — fail closed before showing a confirmation screen or moving money.
const WALLET_SERVICE_STALE_TEXT =
  "نام کاربری انتخابی دیگر معتبر نیست؛ لطفاً دوباره نام کاربری را انتخاب کنید.";

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

/**
 * Panel drift recovery (hotfix §3): the product changed panels since the buyer
 * selected a username. Release the old HELD hold, drop the now-invalid
 * customization, and re-seat the draft on the CURRENT product/panel — preserving
 * productId + the navigation origin (retail / Pricing return location /
 * representative context) — so the buyer re-selects a username on the new panel
 * instead of looping forever on a claim failure. Moves no money.
 */
export async function rebuildDraftForCurrentPanel(
  ctx: BotContext,
  draft: CheckoutDraft,
  product: ProductWithRelations,
): Promise<void> {
  await releaseDraftHeldReservation(ctx, draft);
  draft.panelId = product.panelId ?? undefined;
  draft.categoryId = product.categoryId;
  draft.serviceCustomization = undefined;
  ctx.session.currentFlow = null;
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
    // §6: forced/deliberate exit — release the exact HELD reservation now, not
    // just the session state, then bounce the buyer to the menu.
    await abandonCheckoutDraft(ctx, "DRAFT_PRODUCT_UNAVAILABLE");
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  // §3: a SERVICE draft whose product is no longer a panel-backed SERVICE_PRODUCT
  // (its type changed, or it became panel-less) is structurally unsellable —
  // abandon the draft (releasing its exact HELD reservation) and return to the
  // menu; never render another username prompt for it.
  if (
    draft.flowType === "SERVICE_PRODUCT" &&
    (product.type !== "SERVICE_PRODUCT" || product.panelId === null)
  ) {
    await abandonCheckoutDraft(ctx, "DRAFT_PRODUCT_UNSELLABLE");
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  // §3 panel drift: re-seat the draft on the current panel before the gate below.
  if (
    draft.flowType === "SERVICE_PRODUCT" &&
    product.panelId !== null &&
    draft.panelId !== product.panelId
  ) {
    await rebuildDraftForCurrentPanel(ctx, draft, product);
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
  // from the previous draft: authoritatively release its exact HELD hold now so
  // the username frees up immediately (the cleanup worker is only the backstop).
  await abandonCheckoutDraft(ctx, "SELECT_ANOTHER_PRODUCT");
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
  await abandonCheckoutDraft(ctx, "BUY_HUB");
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
  await abandonCheckoutDraft(ctx, "OTHER_PRODUCTS");
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

/**
 * Release ONLY this draft's own HELD username hold (exact userId + draftNonce +
 * reservationId), never a BOUND/CONSUMED one. Best-effort — a failure is logged
 * (safe category only) and swallowed; the cleanup sweep is the backstop.
 */
async function releaseDraftHeldReservation(
  ctx: BotContext,
  draft: CheckoutDraft,
): Promise<void> {
  const user = ctx.dbUser;
  const reservationId = draft.serviceCustomization?.reservationId;
  if (user === null || reservationId === undefined) {
    return;
  }
  try {
    await releaseHeldReservationForDraft({
      userId: user.id,
      draftNonce: draft.draftNonce ?? null,
      reservationId,
    });
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
  const nonce = shortDraftNonce(draft.draftNonce);
  let text: string;
  let keyboard: InlineKeyboard;
  if (draft.serviceCustomization === undefined) {
    text = await serviceUsernameMethodText();
    keyboard = await serviceUsernameMethodKeyboard(nonce);
  } else {
    const isRandom = draft.serviceCustomization.usernameMode === ServiceUsernameMode.RANDOM;
    text = serviceUsernameConfirmText(draft.serviceCustomization.normalizedUsername, isRandom);
    keyboard = await serviceUsernameConfirmKeyboard(isRandom, nonce);
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

// =============================================================================
// THE single nonce-validated username/note callback router (hotfix §2). Every
// username/note action arrives as `user:co:un:{c,r,g,m,o}:<nonce>` or
// `user:co:nt:{s,b}:<nonce>`. One route, one shared parser/validator: the nonce
// MUST equal the current draft's own short nonce. A button from an OLD/replaced
// draft carries a stale nonce and is rejected here — it can never generate,
// confirm, release or replace a reservation, skip the note, or touch currentFlow.
// =============================================================================
checkoutHandler.callbackQuery(
  /^user:co:(?:un:[crgmo]|nt:[sb]):[0-9a-f]{6,32}$/,
  async (ctx) => {
    const parsed = parseCoNonceCallback(ctx.callbackQuery.data ?? "");
    const draft = ctx.session.temp.checkoutDraft;
    if (
      parsed === null ||
      draft === undefined ||
      !draftNeedsServiceCustomization(draft) ||
      shortDraftNonce(draft.draftNonce) !== parsed.nonce
    ) {
      // Fail closed: acknowledge with a safe notice, mutate NOTHING.
      await safeAnswerCallback(ctx, STALE_STEP_TEXT);
      return;
    }
    await dispatchServiceCustomizationAction(ctx, draft, parsed.action);
  },
);

/** Apply a nonce-validated username/note action to the CURRENT draft. */
async function dispatchServiceCustomizationAction(
  ctx: BotContext,
  draft: CheckoutDraft,
  action: CoNonceAction,
): Promise<void> {
  const nonce = shortDraftNonce(draft.draftNonce);
  switch (action) {
    case "un:c": // choose custom username → arm the bounded text-input flow
      ctx.session.currentFlow = SVC_USERNAME_FLOW;
      await safeAnswerCallback(ctx);
      await safeEditOrReply(
        ctx,
        await serviceUsernameCustomPromptText(),
        serviceUsernameCustomPromptKeyboard(nonce),
        HTML,
      );
      return;
    case "un:r": // choose random username
      await reserveRandomAndShow(ctx, draft);
      return;
    case "un:g": // regenerate a fresh random username
      if (draft.serviceCustomization === undefined) {
        await safeAnswerCallback(ctx, STALE_STEP_TEXT);
        return;
      }
      await reserveRandomAndShow(ctx, draft);
      return;
    case "un:m": // confirmation Back → method page: release the current HELD hold
      await releaseDraftHeldReservation(ctx, draft);
      draft.serviceCustomization = undefined;
      ctx.session.currentFlow = null;
      await safeAnswerCallback(ctx);
      await renderServiceUsernameEntry(ctx, draft, true);
      return;
    case "un:o": // confirm username → optional-note step
      if (draft.serviceCustomization === undefined) {
        await safeAnswerCallback(ctx, STALE_STEP_TEXT);
        return;
      }
      draft.serviceCustomization.completed = false;
      ctx.session.currentFlow = SVC_NOTE_FLOW;
      await safeAnswerCallback(ctx);
      await safeEditOrReply(
        ctx,
        await serviceNotePromptText(),
        await serviceNotePromptKeyboard(nonce),
        HTML,
      );
      return;
    case "nt:s": // skip the optional note (the ONLY path that stores note=null)
      if (draft.serviceCustomization === undefined) {
        await safeAnswerCallback(ctx, STALE_STEP_TEXT);
        return;
      }
      draft.serviceCustomization.note = null;
      draft.serviceCustomization.completed = true;
      ctx.session.currentFlow = null;
      await safeAnswerCallback(ctx);
      await renderPreInvoice(ctx, true);
      return;
    case "nt:b": // note Back → username confirmation page (§10)
      if (draft.serviceCustomization === undefined) {
        await safeAnswerCallback(ctx, STALE_STEP_TEXT);
        return;
      }
      draft.serviceCustomization.completed = false;
      ctx.session.currentFlow = null;
      await safeAnswerCallback(ctx);
      await renderServiceUsernameEntry(ctx, draft, true);
      return;
  }
}

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

/**
 * §4 wallet callback guard (defense in depth ABOVE the final service-layer gate).
 * For a panel-backed SERVICE wallet payment it requires: the live product still
 * matches the draft's productId + panelId, the customization is completed, and the
 * EXACT HELD reservation is still claimable by this user + draft. Returns a safe
 * error string when any of these fail (so a stale wallet button can never even
 * render a valid-looking confirmation screen or move money), or null when OK.
 * OTHER_PRODUCT / legacy panel-less services carry no reservation and pass through.
 */
async function walletServiceDraftBlock(
  user: User,
  draft: CheckoutDraft,
): Promise<string | null> {
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    product === null ||
    product.id !== draft.productId ||
    !isProductVisible(product, user.group)
  ) {
    return DRAFT_EXPIRED_TEXT;
  }
  if (product.type !== "SERVICE_PRODUCT" || product.panelId === null) {
    return null;
  }
  const custom = draft.serviceCustomization;
  if (custom?.completed !== true || draft.panelId !== product.panelId) {
    return WALLET_SERVICE_STALE_TEXT;
  }
  const claimable = await isReservationClaimable({
    reservationId: custom.reservationId,
    userId: user.id,
    draftNonce: draft.draftNonce ?? null,
    normalizedUsername: custom.normalizedUsername,
    mode: custom.usernameMode,
    panelId: product.panelId,
  });
  return claimable ? null : WALLET_SERVICE_STALE_TEXT;
}

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
  // §4: a panel-backed SERVICE draft must be complete + un-drifted + still hold an
  // exact claimable reservation BEFORE the confirmation screen renders. On failure
  // re-render the pre-invoice (which recovers panel drift / returns to username
  // selection). Moves no money.
  const serviceBlock = await walletServiceDraftBlock(user, draft);
  if (serviceBlock !== null) {
    await safeAnswerCallback(ctx, serviceBlock);
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
  // §4: re-assert the SERVICE draft is complete + un-drifted + still holds an exact
  // claimable reservation immediately before any money can move — a stale
  // confirmation button never deducts. payPurchaseDraftWithWallet remains the
  // final financial defense inside the transaction.
  const serviceBlock = await walletServiceDraftBlock(user, draft);
  if (serviceBlock !== null) {
    await safeAnswerCallback(ctx, serviceBlock);
    await renderPreInvoice(ctx, true);
    return;
  }
  try {
    const result = await payPurchaseDraftWithWallet(user, draft);
    if (!result.ok) {
      if ("needsCustomerInfo" in result) {
        // §4 mandatory-input gate: a personalized OTHER_PRODUCT (e.g. a manually
        // built Apple ID) materialized a PENDING checkout — remember it on the
        // draft (a re-tap reuses it) and open the structured form. No money moved.
        draft.otherProductCheckoutId = result.checkoutId;
        const pending = await prisma.checkoutSession.findUnique({
          where: { id: result.checkoutId },
        });
        if (pending !== null) {
          await enforceCustomerInfoBeforePayment(ctx, pending);
        } else {
          await safeAnswerCallback(ctx);
        }
        return;
      }
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
    // §6: release the exact HELD reservation on this forced exit, not just state.
    await abandonCheckoutDraft(ctx, "DRAFT_PRODUCT_UNAVAILABLE");
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }

  // Defense in depth: a SERVICE checkout must have a confirmed username + note
  // before it can create a CheckoutSession. The pre-invoice gate already enforces
  // this, so this only catches a stale «تایید خرید» callback — re-render the step.
  if (draftNeedsServiceCustomization(draft) && !serviceCustomizationComplete(draft)) {
    await safeAnswerCallback(ctx);
    await renderPreInvoice(ctx, true);
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
      // §6: reseller price/fingerprint drifted — release the exact HELD hold too.
      await abandonCheckoutDraft(ctx, "REPRESENTATIVE_PRICE_CHANGED");
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
    // hotfix §3: the authoritative reservation claim failed — the buyer's hold
    // is stale/drifted, so NO checkout was created. Invalidate the stale
    // customization and send them back to the username selection step instead of
    // showing a generic error. The whole transaction (incl. superseded
    // cancellations) already rolled back inside createCheckoutSession.
    if (err instanceof CheckoutReservationError) {
      // §3: the authoritative claim failed (stale hold / panel drift / expiry).
      // Release the exact old HELD hold now, drop the invalid customization, and
      // re-render — renderPreInvoice re-seats the draft on the current panel (drift
      // recovery) and returns the buyer to username selection instead of looping.
      await releaseDraftHeldReservation(ctx, draft);
      draft.serviceCustomization = undefined;
      ctx.session.currentFlow = null;
      logger.warn("checkout reservation claim failed", { reason: err.reason, userId: user.id });
      await safeAnswerCallback(ctx, "نام کاربری انتخابی دیگر معتبر نیست؛ لطفاً دوباره انتخاب کنید.");
      await renderPreInvoice(ctx, true);
      return;
    }
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
  // §6/§8: discount entry happens after the username is confirmed, so the draft
  // may still hold an exact HELD reservation — release it now, not just state.
  if (text.startsWith("/")) {
    await abandonCheckoutDraft(ctx, "DISCOUNT_INPUT_COMMAND");
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
    // A command typed mid-entry is a deliberate exit (§8): authoritatively
    // release this draft's exact HELD hold, then continue command handling.
    await abandonCheckoutDraft(ctx, "USERNAME_INPUT_COMMAND");
    return next();
  }
  const draft = ctx.session.temp.checkoutDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null || !draftNeedsServiceCustomization(draft) || draft.panelId === undefined) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const nonce = shortDraftNonce(draft.draftNonce);
  const validation = validateServiceUsername(text);
  if (!validation.ok) {
    await safeReply(ctx, serviceUsernameRejectText(validation.reason), serviceUsernameCustomPromptKeyboard(nonce));
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
      serviceUsernameCustomPromptKeyboard(nonce),
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
    // A command typed mid-entry is a deliberate exit (§8): release the draft's
    // exact HELD hold, then continue command handling.
    await abandonCheckoutDraft(ctx, "NOTE_INPUT_COMMAND");
    return next();
  }
  const draft = ctx.session.temp.checkoutDraft;
  if (draft === undefined || draft.serviceCustomization === undefined) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }
  const nonce = shortDraftNonce(draft.draftNonce);
  const normalized = normalizeServiceNote(text);
  if (!normalized.ok) {
    await safeReply(ctx, serviceNoteRejectText(normalized.reason), await serviceNotePromptKeyboard(nonce));
    return;
  }
  // hotfix §9: whitespace-only text is INVALID, not a silent null. `note=null` is
  // stored ONLY via the explicit «رد کردن» (nt:s) button. Keep the note flow armed
  // and ask again so the buyer either types real content or explicitly skips.
  if (normalized.normalized === "") {
    await safeReply(ctx, SERVICE_NOTE_EMPTY_TEXT, await serviceNotePromptKeyboard(nonce));
    return;
  }
  draft.serviceCustomization.note = normalized.normalized;
  draft.serviceCustomization.completed = true;
  ctx.session.currentFlow = null;
  await renderPreInvoice(ctx, false);
}
