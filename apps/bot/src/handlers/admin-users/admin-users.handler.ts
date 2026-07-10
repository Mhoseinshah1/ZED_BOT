import { randomUUID } from "node:crypto";

import type { User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  adjustUserWallet,
  getAdminTargetUserByShortId,
  getUserById,
  INVALID_AMOUNT_TEXT,
  INVALID_REASON_TEXT,
  isValidAdjustAmount,
  listRecentUsers,
  listUserWalletTransactionsForAdmin,
  MAX_MANUAL_ADJUST_TOMAN,
  normalizeAdjustReason,
  searchUsersForAdmin,
  type WalletAdjustAction,
} from "../../services/admin-user-wallet.service.js";
import { parseTopupAmount } from "../../services/wallet-topup.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { formatToman } from "../user-wallet/wallet-views.js";
import {
  adjustConfirmKeyboard,
  adjustConfirmText,
  AU_CB,
  NO_USER_FOUND_TEXT,
  SEARCH_PROMPT_TEXT,
  searchCancelKeyboard,
  userListKeyboard,
  userProfileKeyboard,
  userProfileText,
  userShortId,
  USERS_LANDING_TEXT,
  usersLandingKeyboard,
  userWalletKeyboard,
  userWalletText,
} from "./admin-users-views.js";

// =============================================================================
// «مدیریت کاربران 👥» (Phase 20) - admin searches/selects a user, opens the
// profile, opens «کیف پول کاربر 🏦» and manually increases/decreases the
// balance with a mandatory reason + explicit confirmation. Admin-only
// (mounted behind adminAuthMiddleware); every handler additionally requires
// ctx.admin. Nothing is written before the confirmation; the mutation itself
// is the atomic adjustUserWallet (negative balances are impossible).
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };

const SEARCH_FLOW = "admin_users:search";
const AMOUNT_FLOW = "admin_wallet:amount";
const REASON_FLOW = "admin_wallet:reason";

export const adminUsersHandler = new Composer<BotContext>();

/**
 * Clears the wallet-adjustment flow/draft but keeps the stored search query
 * so «بازگشت به نتایج» still works while navigating profiles/wallets.
 */
function clearAdminWalletFlowState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow === SEARCH_FLOW ||
    ctx.session.currentFlow === AMOUNT_FLOW ||
    ctx.session.currentFlow === REASON_FLOW
  ) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminUserWalletDraft;
}

/**
 * Full Phase 20 state cleanup (flow + wallet draft + search query). Called
 * on the «مدیریت کاربران» landing and from showAdminMenu, so returning to
 * the admin main menu never leaves a stale draft or query behind.
 */
export function clearAdminUsersState(ctx: BotContext): void {
  clearAdminWalletFlowState(ctx);
  delete ctx.session.temp.adminUserSearchQuery;
}

async function renderLanding(ctx: BotContext): Promise<void> {
  clearAdminUsersState(ctx); // full clear: flow + draft + stored search query
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, USERS_LANDING_TEXT, usersLandingKeyboard());
  ctx.session.lastMenu = AU_CB.root;
}

async function renderProfile(ctx: BotContext, user: User): Promise<void> {
  const hasResults = typeof ctx.session.temp.adminUserSearchQuery === "string";
  await safeEditOrReply(
    ctx,
    userProfileText(user),
    userProfileKeyboard(userShortId(user), hasResults),
    HTML,
  );
}

async function renderWallet(ctx: BotContext, user: User): Promise<void> {
  const transactions = await listUserWalletTransactionsForAdmin(user.id, 5);
  await safeEditOrReply(ctx, userWalletText(user, transactions), userWalletKeyboard(userShortId(user)), HTML);
}

adminUsersHandler.callbackQuery(AU_CB.root, renderLanding);

adminUsersHandler.callbackQuery(AU_CB.search, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminWalletFlowState(ctx);
  ctx.session.currentFlow = SEARCH_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, SEARCH_PROMPT_TEXT, searchCancelKeyboard());
});

adminUsersHandler.callbackQuery(AU_CB.recent, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminWalletFlowState(ctx);
  const users = await listRecentUsers(5);
  await safeAnswerCallback(ctx);
  if (users.length === 0) {
    await safeEditOrReply(ctx, NO_USER_FOUND_TEXT, usersLandingKeyboard());
    return;
  }
  await safeEditOrReply(ctx, "کاربران اخیر 👤", userListKeyboard(users));
});

// «بازگشت به نتایج» re-runs the stored search query.
adminUsersHandler.callbackQuery(AU_CB.results, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminWalletFlowState(ctx);
  const query = ctx.session.temp.adminUserSearchQuery;
  if (typeof query !== "string" || query === "") {
    await renderLanding(ctx);
    return;
  }
  const users = await searchUsersForAdmin(query);
  await safeAnswerCallback(ctx);
  if (users.length === 0) {
    await safeEditOrReply(ctx, NO_USER_FOUND_TEXT, usersLandingKeyboard());
    return;
  }
  await safeEditOrReply(ctx, `نتایج جستجو (${users.length}):`, userListKeyboard(users));
});

adminUsersHandler.callbackQuery(/^admin:users:view:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminWalletFlowState(ctx);
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderProfile(ctx, user);
});

adminUsersHandler.callbackQuery(/^admin:user_wallet:open:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminWalletFlowState(ctx);
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderWallet(ctx, user);
});

async function startAdjustFlow(
  ctx: BotContext,
  shortId: string,
  action: WalletAdjustAction,
): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(shortId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminUserWalletDraft = {
    targetUserId: user.id,
    action,
    draftNonce: randomUUID(),
  };
  ctx.session.currentFlow = AMOUNT_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    action === "INCREASE"
      ? "مبلغ افزایش موجودی را به تومان وارد کنید."
      : "مبلغ کسر موجودی را به تومان وارد کنید.",
    searchCancelKeyboard(),
  );
}

adminUsersHandler.callbackQuery(/^admin:user_wallet:add:([0-9a-f-]+)$/, async (ctx) => {
  await startAdjustFlow(ctx, ctx.match[1], "INCREASE");
});

adminUsersHandler.callbackQuery(/^admin:user_wallet:subtract:([0-9a-f-]+)$/, async (ctx) => {
  await startAdjustFlow(ctx, ctx.match[1], "DECREASE");
});

adminUsersHandler.callbackQuery(AU_CB.walletCancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const targetUserId = ctx.session.temp.adminUserWalletDraft?.targetUserId;
  clearAdminWalletFlowState(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  const user = targetUserId === undefined ? null : await getUserById(targetUserId);
  if (user === null) {
    await safeEditOrReply(ctx, USERS_LANDING_TEXT, usersLandingKeyboard());
    return;
  }
  await renderWallet(ctx, user);
});

adminUsersHandler.callbackQuery(AU_CB.walletConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminUserWalletDraft;
  // The draft is consumed BEFORE executing: a double-clicked confirmation
  // finds no draft and cannot apply twice.
  clearAdminWalletFlowState(ctx);
  if (
    draft === undefined ||
    draft.amountToman === undefined ||
    draft.reason === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    await safeEditOrReply(ctx, USERS_LANDING_TEXT, usersLandingKeyboard());
    return;
  }
  const outcome = await adjustUserWallet({
    targetUserId: draft.targetUserId,
    adminId: admin.id,
    action: draft.action,
    amountToman: draft.amountToman,
    reason: draft.reason,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    const user = await getUserById(draft.targetUserId);
    if (user !== null) {
      await renderWallet(ctx, user);
    }
    return;
  }

  // Notify the target user; a failed notification never rolls back the
  // applied adjustment (mirrors the receipt-review notification pattern).
  const increase = draft.action === "INCREASE";
  const noticeLines = [
    increase
      ? "موجودی کیف پول شما توسط مدیریت افزایش یافت ✅"
      : "موجودی کیف پول شما توسط مدیریت کسر شد.",
    "",
    `مبلغ: ${formatToman(draft.amountToman)}`,
    `دلیل: ${escapeHtml(outcome.walletTransaction.reason ?? "")}`,
    `موجودی جدید: ${formatToman(outcome.user.balanceToman)}`,
  ];
  let notified = true;
  try {
    await ctx.api.sendMessage(outcome.user.telegramId.toString(), noticeLines.join("\n"), {
      parse_mode: "HTML",
    });
  } catch (err) {
    notified = false;
    logger.warn("admin wallet adjustment: user notification failed", {
      targetUserId: outcome.user.id,
      error: errorMessage(err),
    });
  }

  await safeAnswerCallback(
    ctx,
    increase ? "موجودی کاربر با موفقیت افزایش یافت ✅" : "موجودی کاربر با موفقیت کسر شد ✅",
  );
  const summary = [
    increase ? "افزایش موجودی ثبت شد ✅" : "کسر موجودی ثبت شد ✅",
    "",
    `مبلغ: ${formatToman(draft.amountToman)}`,
    `موجودی جدید کاربر: ${formatToman(outcome.user.balanceToman)}`,
    notified ? "کاربر مطلع شد ✅" : "ارسال پیام به کاربر ناموفق بود ⚠️",
  ].join("\n");
  await safeEditOrReply(ctx, summary, userWalletKeyboard(userShortId(outcome.user)), HTML);
});

// --- text inputs (search / amount / reason) -----------------------------------------

export const adminUsersTextHandler = new Composer<BotContext>();

adminUsersTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (
    ctx.admin === null ||
    (flow !== SEARCH_FLOW && flow !== AMOUNT_FLOW && flow !== REASON_FLOW)
  ) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearAdminWalletFlowState(ctx);
    return next();
  }

  if (flow === SEARCH_FLOW) {
    const query = text.trim();
    const users = await searchUsersForAdmin(query);
    if (users.length === 0) {
      await safeReply(ctx, NO_USER_FOUND_TEXT, searchCancelKeyboard());
      return; // keep the flow - the admin can try another query
    }
    ctx.session.temp.adminUserSearchQuery = query;
    ctx.session.currentFlow = null;
    if (users.length === 1) {
      await renderProfile(ctx, users[0]);
      return;
    }
    await safeReply(ctx, `نتایج جستجو (${users.length}):`, userListKeyboard(users));
    return;
  }

  const draft = ctx.session.temp.adminUserWalletDraft;
  if (draft === undefined) {
    clearAdminWalletFlowState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
    return;
  }

  if (flow === AMOUNT_FLOW) {
    const amount = parseTopupAmount(text);
    if (amount === null || !isValidAdjustAmount(amount)) {
      await safeReply(
        ctx,
        `${INVALID_AMOUNT_TEXT} (حداکثر ${formatToman(MAX_MANUAL_ADJUST_TOMAN)})`,
        searchCancelKeyboard(),
      );
      return;
    }
    draft.amountToman = amount;
    ctx.session.currentFlow = REASON_FLOW;
    await safeReply(
      ctx,
      draft.action === "INCREASE"
        ? "دلیل افزایش موجودی را وارد کنید."
        : "دلیل کسر موجودی را وارد کنید.",
      searchCancelKeyboard(),
    );
    return;
  }

  // REASON_FLOW
  const reason = normalizeAdjustReason(text);
  if (reason === null) {
    await safeReply(ctx, INVALID_REASON_TEXT, searchCancelKeyboard());
    return;
  }
  draft.reason = reason;
  ctx.session.currentFlow = null;
  const user = await getUserById(draft.targetUserId);
  if (user === null || draft.amountToman === undefined) {
    clearAdminWalletFlowState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
    return;
  }
  await safeReply(
    ctx,
    adjustConfirmText(user, {
      action: draft.action,
      amountToman: draft.amountToman,
      reason,
    }),
    adjustConfirmKeyboard(draft.action),
    HTML,
  );
});
