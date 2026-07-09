import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import type { CheckoutDraft } from "../../core/session.js";
import {
  categoriesOf,
  isProductVisible,
  visibleOtherProducts,
  visibleServiceProducts,
  type LocationCode,
} from "../../services/catalog.service.js";
import {
  checkoutShortId,
  createCheckoutSession,
  getCheckoutByShortId,
} from "../../services/checkout.service.js";
import { validateDiscountCode } from "../../services/discount.service.js";
import { getProductByShortId, type ProductWithRelations } from "../../services/product.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { clearCheckoutState } from "./checkout-state.js";
import { ccb, CO_CB } from "./checkout-cb.js";
import {
  categoryListKeyboard,
  checkoutCreatedKeyboard,
  checkoutCreatedText,
  checkoutViewText,
  EMPTY_CATALOG_TEXT,
  locationMenuKeyboard,
  preInvoiceKeyboard,
  preInvoiceText,
  productListKeyboard,
} from "./checkout-views.js";

const HTML = { parseMode: "HTML" as const };
const DRAFT_EXPIRED_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره محصول را انتخاب کنید.";

export const checkoutHandler = new Composer<BotContext>();

// --- helpers ---------------------------------------------------------------------

function backKeyboard(backCb: string): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت", backCb);
}

async function renderPreInvoice(ctx: BotContext, edit: boolean): Promise<void> {
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
  const text = preInvoiceText(product, user, draft);
  const keyboard = preInvoiceKeyboard(draft);
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

async function startPreInvoice(
  ctx: BotContext,
  product: ProductWithRelations,
  locationCode?: LocationCode,
): Promise<void> {
  ctx.session.currentFlow = null;
  const draft: CheckoutDraft = {
    productId: product.id,
    categoryId: product.categoryId,
    flowType: product.type,
    locationCode,
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
  };
  ctx.session.temp.checkoutDraft = draft;
  await renderPreInvoice(ctx, true);
}

// --- Buy subscription flow -----------------------------------------------------------

checkoutHandler.callbackQuery(CO_CB.BUY, async (ctx) => {
  clearCheckoutState(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نوع سرویس را انتخاب کنید:", locationMenuKeyboard());
});

checkoutHandler.callbackQuery(/^user:buy:loc:(M|D|T|A)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const location = ctx.match[1] as LocationCode;
  const products = await visibleServiceProducts(user.group, location);
  await safeAnswerCallback(ctx);
  if (products.length === 0) {
    await safeEditOrReply(ctx, EMPTY_CATALOG_TEXT, backKeyboard(CO_CB.BUY));
    return;
  }
  const categories = categoriesOf(products);
  await safeEditOrReply(
    ctx,
    "دسته‌بندی را انتخاب کنید:",
    categoryListKeyboard(categories, (catSid) => ccb.buyCategory(location, catSid), CO_CB.BUY),
  );
});

checkoutHandler.callbackQuery(/^user:buy:cat:(M|D|T|A):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const location = ctx.match[1] as LocationCode;
  const catPrefix = ctx.match[2];
  const products = (await visibleServiceProducts(user.group, location)).filter((p) =>
    p.categoryId.startsWith(catPrefix),
  );
  await safeAnswerCallback(ctx);
  if (products.length === 0) {
    await safeEditOrReply(ctx, EMPTY_CATALOG_TEXT, backKeyboard(ccb.buyLocation(location)));
    return;
  }
  await safeEditOrReply(
    ctx,
    "محصول را انتخاب کنید:",
    productListKeyboard(products, (sid) => ccb.buyProduct(location, sid), ccb.buyLocation(location)),
  );
});

checkoutHandler.callbackQuery(/^user:buy:p:(M|D|T|A):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const location = ctx.match[1] as LocationCode;
  const product = await getProductByShortId(ctx.match[2]);
  if (product === null || !isProductVisible(product, user.group, location)) {
    await safeAnswerCallback(ctx, "این محصول در دسترس نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  await startPreInvoice(ctx, product, location);
});

// --- Other products flow --------------------------------------------------------------

checkoutHandler.callbackQuery(CO_CB.OTHER, async (ctx) => {
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
});

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
    await safeAnswerCallback(ctx, "این محصول در دسترس نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  await startPreInvoice(ctx, product);
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

// --- Continue: the only write ------------------------------------------------------------

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
    !isProductVisible(product, user.group, draft.locationCode)
  ) {
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, backKeyboard(CB.USER_MENU));
    return;
  }

  // Re-validate pricing + discount at click time (price/code may have changed).
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

  try {
    const checkout = await createCheckoutSession(user, product, draft);
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx, "ثبت شد ✅");
    await safeEditOrReply(ctx, checkoutCreatedText(), checkoutCreatedKeyboard(checkout));
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
  await safeEditOrReply(
    ctx,
    checkoutViewText(checkout),
    new InlineKeyboard()
      .text("مشاهده دوباره پیش‌فاکتور", ccb.viewCheckout(checkoutShortId(checkout)))
      .row()
      .text("بازگشت به منوی اصلی", CB.USER_MENU),
    HTML,
  );
});

// =============================================================================
// Discount-code text input. Only consumes text when the user is in the
// checkout:discount flow (wired in app.ts before the generic fallthrough).
// =============================================================================

export const checkoutTextHandler = new Composer<BotContext>();

checkoutTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "checkout:discount") {
    return next();
  }
  const text = ctx.message.text;
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
      await safeReply(ctx, "کد تخفیف اعمال شد ✅");
    } else {
      await safeReply(ctx, validation.error);
    }
    await renderPreInvoice(ctx, false);
  } catch (err) {
    ctx.session.currentFlow = null;
    logger.error("discount validation failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});
