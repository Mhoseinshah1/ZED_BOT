import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  isWalletTopupEnabled,
  WALLET_TOPUP_DISABLED_TEXT,
  walletTopupInstruction,
} from "../../services/payment-settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import {
  createWalletTopupCheckout,
  parseTopupAmount,
  walletTopupLimits,
} from "../../services/wallet-topup.service.js";
import {
  getWalletSummary,
  listWalletTransactions,
} from "../../services/wallet.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { clearCheckoutState } from "../user-checkout/checkout-state.js";
import { showPaymentMethods } from "../user-checkout/payment.handler.js";
import {
  formatToman,
  topupAmountKeyboard,
  topupPreInvoiceKeyboard,
  topupPreInvoiceText,
  transactionHistoryKeyboard,
  transactionHistoryText,
  WALLET_CB,
  walletMainKeyboard,
  walletSummaryText,
} from "./wallet-views.js";

// =============================================================================
// "کیف پول + شارژ 🏦" (Phase 13 read-only page + Phase 14 top-up flow).
// The top-up browse steps write nothing; the WALLET_CHARGE CheckoutSession
// is created only on "ادامه و انتخاب روش پرداخت ✅" and then reuses the
// shared Phase 7 payment-method/card-to-card/receipt surface. The balance
// itself moves only when an admin approves the receipt (Phase 14 approval).
// =============================================================================

const HTML = { parseMode: "HTML" as const };

export const walletHandler = new Composer<BotContext>();

/** Leaves the top-up flow (if any) without touching other flows. */
function clearTopupState(ctx: BotContext): void {
  if (ctx.session.currentFlow === "wallet:topup:amount") {
    ctx.session.currentFlow = null;
  }
  ctx.session.temp.walletTopupDraft = undefined;
}

async function renderWallet(ctx: BotContext, answer?: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearTopupState(ctx);
  const [summary, header] = await Promise.all([
    getWalletSummary(user.id),
    getMessageTemplate("wallet_header_text"),
  ]);
  await safeAnswerCallback(ctx, answer);
  await safeEditOrReply(ctx, walletSummaryText(summary, header), walletMainKeyboard(), HTML);
}

walletHandler.callbackQuery(CB.USER_WALLET, async (ctx) => {
  await renderWallet(ctx);
  ctx.session.lastMenu = CB.USER_WALLET;
});

// Refresh re-reads the summary from the DB and re-renders.
walletHandler.callbackQuery(WALLET_CB.REFRESH, async (ctx) => {
  await renderWallet(ctx, "بروزرسانی شد.");
});

walletHandler.callbackQuery(/^user:wallet:tx:(\d+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const [pageData, emptyText] = await Promise.all([
    listWalletTransactions(user.id, Number.parseInt(ctx.match[1], 10)),
    getMessageTemplate("wallet_empty_transactions_text"),
  ]);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    transactionHistoryText(pageData, emptyText),
    transactionHistoryKeyboard(pageData),
    HTML,
  );
});

// --- top-up flow (Phase 14) ---------------------------------------------------------

walletHandler.callbackQuery(WALLET_CB.TOPUP, async (ctx) => {
  if (ctx.dbUser === null) {
    return;
  }
  // Phase 22: operator kill-switch - no draft, no amount prompt, no writes.
  if (!(await isWalletTopupEnabled())) {
    clearTopupState(ctx);
    await safeAnswerCallback(ctx, WALLET_TOPUP_DISABLED_TEXT);
    await safeEditOrReply(ctx, WALLET_TOPUP_DISABLED_TEXT, walletMainKeyboard());
    return;
  }
  clearCheckoutState(ctx);
  ctx.session.currentFlow = "wallet:topup:amount";
  ctx.session.temp.walletTopupDraft = {};
  await safeAnswerCallback(ctx);
  // Operator-editable amount prompt (MessageTemplate) + the Phase 22
  // Setting-backed instruction text, when set (deliberately NOT duplicated
  // into a template).
  const [amountPrompt, instruction] = await Promise.all([
    getMessageTemplate("wallet_topup_amount_prompt"),
    walletTopupInstruction(),
  ]);
  const prompt = instruction === null ? amountPrompt : `${amountPrompt}\n\n${instruction}`;
  await safeEditOrReply(ctx, prompt, topupAmountKeyboard());
});

walletHandler.callbackQuery(WALLET_CB.TOPUP_CANCEL, async (ctx) => {
  clearTopupState(ctx);
  await renderWallet(ctx, "لغو شد.");
});

// The ONLY write of the flow: the WALLET_CHARGE CheckoutSession.
walletHandler.callbackQuery(WALLET_CB.TOPUP_CONTINUE, async (ctx) => {
  const user = ctx.dbUser;
  const amount = ctx.session.temp.walletTopupDraft?.amountToman;
  if (user === null || amount === undefined) {
    await safeAnswerCallback(ctx, "مبلغ در دسترس نیست؛ لطفاً دوباره شروع کنید.");
    return;
  }
  // Phase 22: re-checked at ACTION time - a stale pre-invoice cannot create
  // a checkout after the operator disabled top-up.
  if (!(await isWalletTopupEnabled())) {
    clearTopupState(ctx);
    await safeAnswerCallback(ctx, WALLET_TOPUP_DISABLED_TEXT);
    await safeEditOrReply(ctx, WALLET_TOPUP_DISABLED_TEXT, walletMainKeyboard());
    return;
  }
  const limits = await walletTopupLimits();
  if (amount < limits.minToman || amount > limits.maxToman) {
    clearTopupState(ctx);
    await safeAnswerCallback(ctx, "مبلغ وارد شده معتبر نیست.");
    return;
  }
  try {
    const checkout = await createWalletTopupCheckout(user, amount);
    clearCheckoutState(ctx);
    await safeAnswerCallback(ctx, "ثبت شد ✅");
    await showPaymentMethods(ctx, checkout, { created: true });
    logger.info("wallet topup checkout created", {
      checkoutId: checkout.id,
      userId: user.id,
      amountToman: amount,
    });
  } catch (err) {
    logger.error("wallet topup checkout failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// =============================================================================
// Top-up amount text input ("wallet:topup:amount", routed in app.ts).
// =============================================================================

export const walletTopupTextHandler = new Composer<BotContext>();

walletTopupTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "wallet:topup:amount") {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the top-up flow and continue normally.
  if (text.startsWith("/")) {
    clearTopupState(ctx);
    return next();
  }
  const user = ctx.dbUser;
  const draft = ctx.session.temp.walletTopupDraft;
  if (user === null || draft === undefined) {
    clearTopupState(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره از کیف پول شروع کنید.");
    return;
  }
  const amount = parseTopupAmount(text);
  if (amount === null) {
    await safeReply(ctx, "مبلغ وارد شده معتبر نیست.");
    return;
  }
  const limits = await walletTopupLimits();
  if (amount < limits.minToman) {
    await safeReply(ctx, `حداقل مبلغ شارژ کیف پول ${formatToman(limits.minToman)} است.`);
    return;
  }
  if (amount > limits.maxToman) {
    await safeReply(ctx, `حداکثر مبلغ شارژ کیف پول ${formatToman(limits.maxToman)} است.`);
    return;
  }
  draft.amountToman = amount;
  ctx.session.currentFlow = null;
  const previewNote = await getMessageTemplate("wallet_topup_preview_note");
  await safeReply(
    ctx,
    topupPreInvoiceText(amount, user.balanceToman, previewNote),
    topupPreInvoiceKeyboard(),
    HTML,
  );
});
