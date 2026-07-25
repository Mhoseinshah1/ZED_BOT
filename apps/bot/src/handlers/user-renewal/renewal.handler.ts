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
import type { RenewalDraft } from "../../core/session.js";
import { validateDiscountCode } from "../../services/discount.service.js";
import { getProductByShortId } from "../../services/product.service.js";
import {
  createRenewalCheckoutSession,
  getRenewableServiceByShortId,
  isRenewalPlanValid,
  listRenewableServices,
  renewalPlansForPanel,
} from "../../services/renewal-checkout.service.js";
import { dispatchPaidOrderFulfillment } from "../../services/order-fulfillment.service.js";
import { getButtonText } from "../../services/text.service.js";
import {
  payRenewalDraftWithWallet,
  WALLET_PAYMENT_DONE_TEXT,
} from "../../services/wallet-payment.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { abandonCheckoutDraft, clearCheckoutState } from "../user-checkout/checkout-state.js";
import { CO_CB } from "../user-checkout/checkout-cb.js";
import { walletConfirmText, walletPayAvailable } from "../user-checkout/checkout-views.js";
import { showPaymentMethods } from "../user-checkout/payment.handler.js";
import {
  NO_RENEWABLE_TEXT,
  NO_RENEWAL_PLAN_TEXT,
  renewableListKeyboard,
  renewalPlansKeyboard,
  renewalPreInvoiceKeyboard,
  renewalPreInvoiceText,
  renewServiceSummaryText,
  rncb,
} from "./renewal-views.js";

// =============================================================================
// "تمدید سرویس ♻️" (Phase 12). Browsing is read-only; the CheckoutSession
// (orderType SERVICE_RENEWAL) is created only when the user confirms the
// pre-invoice, and payment reuses the existing Phase 7 method selection.
// Every route re-validates ownership + eligibility from the DB.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const DRAFT_EXPIRED_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره سرویس را انتخاب کنید.";
const NOT_FOUND = "مورد یافت نشد.";

export const renewalHandler = new Composer<BotContext>();

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منو", CB.USER_MENU);
}

export async function renderRenewableList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await abandonCheckoutDraft(ctx, "RENEW_SERVICE");
  const pageData = await listRenewableServices(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const buy = await getButtonText("buy_subscription");
    const kb = new InlineKeyboard().text(buy, CO_CB.BUY).row().text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, NO_RENEWABLE_TEXT, kb);
    return;
  }
  await safeEditOrReply(ctx, "تمدید سرویس ♻️\n\nسرویس موردنظر برای تمدید را انتخاب کنید.", renewableListKeyboard(pageData));
}

renewalHandler.callbackQuery(CB.USER_RENEW, async (ctx) => {
  await renderRenewableList(ctx, 1);
  ctx.session.lastMenu = CB.USER_RENEW;
});

renewalHandler.callbackQuery(/^user:renew:list:(\d+)$/, async (ctx) => {
  await renderRenewableList(ctx, Number.parseInt(ctx.match[1], 10));
});

/**
 * Renders one service's renewal page (summary + same-panel renewal plans).
 * Extracted from the `user:renew:svc:*` callback so the notification action
 * handler (`ntf:<id>:r`) can land on the IDENTICAL page after re-validating the
 * service owner-scoped; `shortId` is the uuid-prefix short id. Answers the
 * callback itself and re-validates ownership + plan availability from the DB.
 */
export async function renderRenewalServicePage(ctx: BotContext, shortId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  await abandonCheckoutDraft(ctx, "RENEW_SERVICE");
  const service = await getRenewableServiceByShortId(shortId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const plans = await renewalPlansForPanel(user.group, service.panelId);
  await safeAnswerCallback(ctx);
  if (plans.length === 0) {
    await safeEditOrReply(
      ctx,
      NO_RENEWAL_PLAN_TEXT,
      new InlineKeyboard().text("بازگشت", rncb.list(1)).row().text("بازگشت به منو", CB.USER_MENU),
    );
    return;
  }
  await safeEditOrReply(ctx, renewServiceSummaryText(service), renewalPlansKeyboard(service, plans), HTML);
}

// Service summary + renewal plans of the SAME panel.
renewalHandler.callbackQuery(/^user:renew:svc:([0-9a-f-]+)$/, async (ctx) => {
  await renderRenewalServicePage(ctx, ctx.match[1]);
});

async function renderRenewalPreInvoice(ctx: BotContext, edit: boolean): Promise<void> {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.renewalDraft;
  if (user === null || draft === undefined) {
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isRenewalPlanValid(product, service, user.group)
  ) {
    clearCheckoutState(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  const text = renewalPreInvoiceText(service, product, user, draft);
  const keyboard = renewalPreInvoiceKeyboard(draft, user, await isWalletPaymentEnabled());
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

renewalHandler.callbackQuery(/^user:renew:plan:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
  const product = await getProductByShortId(ctx.match[2]);
  if (service === null || product === null || !isRenewalPlanValid(product, service, user.group)) {
    await safeAnswerCallback(ctx, "این پلن در دسترس نیست.");
    return;
  }
  ctx.session.currentFlow = null;
  const draft: RenewalDraft = {
    serviceId: service.id,
    productId: product.id,
    panelId: service.panelId,
    categoryId: product.categoryId,
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
    // One nonce per pre-invoice: the wallet payment's idempotency key.
    draftNonce: randomUUID(),
  };
  ctx.session.temp.renewalDraft = draft;
  await safeAnswerCallback(ctx);
  await renderRenewalPreInvoice(ctx, true);
});

// --- discount ------------------------------------------------------------------

renewalHandler.callbackQuery(rncb.discount, async (ctx) => {
  if (ctx.session.temp.renewalDraft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  ctx.session.currentFlow = "renew:discount";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "کد تخفیف را وارد کنید.",
    new InlineKeyboard().text("انصراف", rncb.back),
  );
});

renewalHandler.callbackQuery(rncb.back, async (ctx) => {
  if (ctx.session.currentFlow === "renew:discount") {
    ctx.session.currentFlow = null;
  }
  await safeAnswerCallback(ctx);
  await renderRenewalPreInvoice(ctx, true);
});

renewalHandler.callbackQuery(rncb.discountClear, async (ctx) => {
  const draft = ctx.session.temp.renewalDraft;
  if (draft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.discountCode = undefined;
  draft.discountCodeId = undefined;
  draft.discountAmountToman = 0;
  draft.finalPriceToman = draft.originalPriceToman;
  await safeAnswerCallback(ctx, "کد تخفیف حذف شد.");
  await renderRenewalPreInvoice(ctx, true);
});

// --- wallet payment (Phase 15) ---------------------------------------------------------

renewalHandler.callbackQuery(rncb.wallet, async (ctx) => {
  const draft = ctx.session.temp.renewalDraft;
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
    await renderRenewalPreInvoice(ctx, true);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    walletConfirmText(draft.finalPriceToman, user.balanceToman),
    new InlineKeyboard()
      .text("تایید پرداخت ✅", rncb.walletConfirm)
      .row()
      .text("انصراف", rncb.back),
  );
});

// Only this callback deducts - and only through the atomic service.
renewalHandler.callbackQuery(rncb.walletConfirm, async (ctx) => {
  const draft = ctx.session.temp.renewalDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  try {
    const { result } = await payRenewalDraftWithWallet(user, draft);
    if (!result.ok) {
      await safeAnswerCallback(ctx, result.error);
      await renderRenewalPreInvoice(ctx, true);
      return;
    }
    clearCheckoutState(ctx);
    if (result.alreadyPaid) {
      await safeAnswerCallback(ctx, "پرداخت قبلاً انجام شده است.");
      return;
    }
    await safeAnswerCallback(ctx, "پرداخت شد ✅");
    await safeEditOrReply(ctx, WALLET_PAYMENT_DONE_TEXT, menuKeyboard());

    // Money committed above - renewal runs through the UNIFIED post-payment
    // dispatcher shared with the gateway and receipt paths.
    await dispatchPaidOrderFulfillment(ctx.api, result.order.id, {
      source: "WALLET",
      user,
    });
  } catch (err) {
    logger.error("wallet renewal payment failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// --- continue: creates the PENDING checkout (card-to-card path) ---------------------------

renewalHandler.callbackQuery(rncb.continue, async (ctx) => {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.renewalDraft;
  if (user === null || draft === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isRenewalPlanValid(product, service, user.group)
  ) {
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }

  // Re-validate pricing + discount at click time.
  draft.originalPriceToman = product.priceToman;
  if (draft.discountCode !== undefined) {
    const validation = await validateDiscountCode(
      draft.discountCode,
      user,
      product.priceToman,
      "RENEWAL",
    );
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
      await renderRenewalPreInvoice(ctx, true);
      return;
    }
  } else {
    draft.finalPriceToman = product.priceToman;
  }

  try {
    const checkout = await createRenewalCheckoutSession(user, service, product, draft);
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx, "ثبت شد ✅");
    await showPaymentMethods(ctx, checkout, { created: true });
    logger.info("renewal checkout session created", {
      checkoutId: checkout.id,
      userId: user.id,
      serviceId: service.id,
      productId: product.id,
      finalPriceToman: checkout.finalPriceToman,
    });
  } catch (err) {
    logger.error("renewal checkout creation failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// =============================================================================
// Renewal discount-code text input ("renew:discount" flow, routed in app.ts).
// =============================================================================

export const renewalTextHandler = new Composer<BotContext>();

renewalTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "renew:discount") {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the discount entry (and the draft) and continue normally.
  if (text.startsWith("/")) {
    clearCheckoutState(ctx);
    return next();
  }
  const draft = ctx.session.temp.renewalDraft;
  const user = ctx.dbUser;
  if (draft === undefined || user === null) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, menuKeyboard());
    return;
  }
  try {
    const validation = await validateDiscountCode(text, user, draft.originalPriceToman, "RENEWAL");
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
    await renderRenewalPreInvoice(ctx, false);
  } catch (err) {
    ctx.session.currentFlow = null;
    logger.error("renewal discount validation failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});
