import { randomUUID } from "node:crypto";

import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  isWalletPaymentEnabled,
  WALLET_PAYMENT_DISABLED_TEXT,
} from "../../services/payment-settings.service.js";
import type { ExtraTimeDraft } from "../../core/session.js";
import { validateDiscountCode } from "../../services/discount.service.js";
import {
  createExtraTimeCheckout,
  extraTimePackages,
  getExtraTimeServiceByShortId,
  isExtraTimePackageValid,
  listExtraTimeServices,
} from "../../services/extra-time.service.js";
import { dispatchPaidOrderFulfillment } from "../../services/order-fulfillment.service.js";
import { getProductByShortId } from "../../services/product.service.js";
import { getButtonText } from "../../services/text.service.js";
import {
  payExtraTimeDraftWithWallet,
  WALLET_PAYMENT_DONE_TEXT,
} from "../../services/wallet-payment.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { CO_CB } from "../user-checkout/checkout-cb.js";
import { walletConfirmText, walletPayAvailable } from "../user-checkout/checkout-views.js";
import { clearCheckoutState } from "../user-checkout/checkout-state.js";
import { showPaymentMethods } from "../user-checkout/payment.handler.js";
import {
  eligibleTimeListKeyboard,
  etcb,
  extraTimePreInvoiceKeyboard,
  extraTimePreInvoiceText,
  extraTimeSummaryText,
  NO_ELIGIBLE_TIME_SERVICE_TEXT,
  NO_TIME_PACKAGE_TEXT,
  timePackageListKeyboard,
} from "./extra-time-views.js";

// =============================================================================
// "خرید زمان اضافه ⏳" (Phase 17). Browsing is read-only; the PENDING
// CheckoutSession (orderType EXTRA_TIME) is created only on continue, and
// the wallet path settles atomically after its confirmation. Every route
// re-validates ownership + eligibility from the DB.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const DRAFT_EXPIRED_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره سرویس را انتخاب کنید.";
const NOT_FOUND = "مورد یافت نشد.";

export const extraTimeHandler = new Composer<BotContext>();

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منو", CB.USER_MENU);
}

async function renderEligibleList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearCheckoutState(ctx);
  const pageData = await listExtraTimeServices(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const buy = await getButtonText("buy_subscription");
    const kb = new InlineKeyboard().text(buy, CO_CB.BUY).row().text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, NO_ELIGIBLE_TIME_SERVICE_TEXT, kb);
    return;
  }
  await safeEditOrReply(
    ctx,
    "خرید زمان اضافه ⏳\n\nسرویس مورد نظر را انتخاب کنید:",
    eligibleTimeListKeyboard(pageData),
  );
}

extraTimeHandler.callbackQuery(CB.USER_EXTRA_TIME, async (ctx) => {
  await renderEligibleList(ctx, 1);
  ctx.session.lastMenu = CB.USER_EXTRA_TIME;
});

extraTimeHandler.callbackQuery(/^user:et:list:(\d+)$/, async (ctx) => {
  await renderEligibleList(ctx, Number.parseInt(ctx.match[1], 10));
});

// Service summary + packages of the SAME panel.
extraTimeHandler.callbackQuery(/^user:et:svc:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearCheckoutState(ctx);
  const service = await getExtraTimeServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const packages = await extraTimePackages(user.group, service.panelId);
  await safeAnswerCallback(ctx);
  if (packages.length === 0) {
    await safeEditOrReply(
      ctx,
      NO_TIME_PACKAGE_TEXT,
      new InlineKeyboard().text("بازگشت", etcb.list(1)).row().text("بازگشت به منو", CB.USER_MENU),
    );
    return;
  }
  await safeEditOrReply(ctx, extraTimeSummaryText(service), timePackageListKeyboard(service, packages), HTML);
});

async function renderPreInvoice(ctx: BotContext, edit: boolean): Promise<void> {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.extraTimeDraft;
  if (user === null || draft === undefined) {
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const service = await getExtraTimeServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isExtraTimePackageValid(product, service, user.group)
  ) {
    clearCheckoutState(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const text = extraTimePreInvoiceText(service, product, user, draft);
  const keyboard = extraTimePreInvoiceKeyboard(draft, user, await isWalletPaymentEnabled());
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

extraTimeHandler.callbackQuery(/^user:et:pkg:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getExtraTimeServiceByShortId(ctx.match[1], user.id);
  const product = await getProductByShortId(ctx.match[2]);
  if (service === null || product === null || !isExtraTimePackageValid(product, service, user.group)) {
    await safeAnswerCallback(ctx, "این بسته در دسترس نیست.");
    return;
  }
  ctx.session.currentFlow = null;
  const draft: ExtraTimeDraft = {
    serviceId: service.id,
    productId: product.id,
    panelId: service.panelId,
    categoryId: product.categoryId,
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
    draftNonce: randomUUID(),
  };
  ctx.session.temp.extraTimeDraft = draft;
  await safeAnswerCallback(ctx);
  await renderPreInvoice(ctx, true);
});

// --- discount ------------------------------------------------------------------

extraTimeHandler.callbackQuery(etcb.discount, async (ctx) => {
  if (ctx.session.temp.extraTimeDraft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  ctx.session.currentFlow = "extra_time:discount";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "کد تخفیف را وارد کنید.",
    new InlineKeyboard().text("انصراف", etcb.back),
  );
});

extraTimeHandler.callbackQuery(etcb.back, async (ctx) => {
  if (ctx.session.currentFlow === "extra_time:discount") {
    ctx.session.currentFlow = null;
  }
  await safeAnswerCallback(ctx);
  await renderPreInvoice(ctx, true);
});

extraTimeHandler.callbackQuery(etcb.discountClear, async (ctx) => {
  const draft = ctx.session.temp.extraTimeDraft;
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

// --- wallet payment ----------------------------------------------------------------

extraTimeHandler.callbackQuery(etcb.wallet, async (ctx) => {
  const draft = ctx.session.temp.extraTimeDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  // Phase 22: operator kill-switch, re-checked when the button is clicked.
  if (!(await isWalletPaymentEnabled())) {
    await safeAnswerCallback(ctx, WALLET_PAYMENT_DISABLED_TEXT);
    return;
  }
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
      .text("تایید پرداخت ✅", etcb.walletConfirm)
      .row()
      .text("انصراف", etcb.back),
  );
});

extraTimeHandler.callbackQuery(etcb.walletConfirm, async (ctx) => {
  const draft = ctx.session.temp.extraTimeDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  try {
    const { result } = await payExtraTimeDraftWithWallet(user, draft);
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
    await safeEditOrReply(ctx, WALLET_PAYMENT_DONE_TEXT, menuKeyboard());

    // Money committed above - the UNIFIED post-payment dispatcher applies
    // the time and notifies the user (shared with gateway/receipt paths).
    await dispatchPaidOrderFulfillment(ctx.api, result.order.id, {
      source: "WALLET",
      user,
    });
  } catch (err) {
    logger.error("wallet extra-time payment failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// --- continue: creates the PENDING checkout (card-to-card path) ---------------------------

extraTimeHandler.callbackQuery(etcb.continue, async (ctx) => {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.extraTimeDraft;
  if (user === null || draft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const service = await getExtraTimeServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isExtraTimePackageValid(product, service, user.group)
  ) {
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }

  // Re-validate pricing + discount at click time (PURCHASE semantics).
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
    const checkout = await createExtraTimeCheckout(user, service, product, draft);
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx, "ثبت شد ✅");
    await showPaymentMethods(ctx, checkout, { created: true });
    logger.info("extra time checkout session created", {
      checkoutId: checkout.id,
      userId: user.id,
      serviceId: service.id,
      productId: product.id,
      finalPriceToman: checkout.finalPriceToman,
    });
  } catch (err) {
    logger.error("extra time checkout creation failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// =============================================================================
// Extra-time discount text input ("extra_time:discount", routed in app.ts).
// =============================================================================

export const extraTimeTextHandler = new Composer<BotContext>();

extraTimeTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "extra_time:discount") {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.extraTimeDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
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
    logger.error("extra time discount validation failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});
