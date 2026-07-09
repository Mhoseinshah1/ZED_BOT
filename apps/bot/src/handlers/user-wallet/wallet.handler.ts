import { Composer } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getWalletSummary,
  listWalletTransactions,
} from "../../services/wallet.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import {
  topupPlaceholderKeyboard,
  TOPUP_PLACEHOLDER_TEXT,
  transactionHistoryKeyboard,
  transactionHistoryText,
  WALLET_CB,
  walletMainKeyboard,
  walletSummaryText,
} from "./wallet-views.js";

// =============================================================================
// "کیف پول + شارژ 🏦" (Phase 13) - strictly READ-ONLY wallet/profile page.
// No payment, no checkout, no wallet mutation; the top-up button is a
// placeholder that never asks for an amount. Everything is scoped to
// ctx.dbUser.id - other users' data is unreachable.
// =============================================================================

const HTML = { parseMode: "HTML" as const };

export const walletHandler = new Composer<BotContext>();

async function renderWallet(ctx: BotContext, answer?: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const summary = await getWalletSummary(user.id);
  await safeAnswerCallback(ctx, answer);
  await safeEditOrReply(ctx, walletSummaryText(summary), walletMainKeyboard(), HTML);
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
  const pageData = await listWalletTransactions(user.id, Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    transactionHistoryText(pageData),
    transactionHistoryKeyboard(pageData),
    HTML,
  );
});

// Phase 13: top-up is a placeholder - no amount, no payment, no writes.
walletHandler.callbackQuery(WALLET_CB.TOPUP, async (ctx) => {
  if (ctx.dbUser === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, TOPUP_PLACEHOLDER_TEXT, topupPlaceholderKeyboard());
});
