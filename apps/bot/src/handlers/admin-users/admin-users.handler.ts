import { randomUUID } from "node:crypto";

import type { User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  adjustUserWallet,
  getAdminTargetUserByShortId,
  getAdminUserOverview,
  getUserById,
  INVALID_AMOUNT_TEXT,
  INVALID_REASON_TEXT,
  isValidAdjustAmount,
  listUsersForAdmin,
  listUserOrdersForAdmin,
  listUserPaymentsForAdmin,
  listUserServicesForAdmin,
  listUserWalletTransactionsForAdmin,
  MAX_MANUAL_ADJUST_TOMAN,
  normalizeAdjustReason,
  searchUsersForAdmin,
  setUserBlocked,
  type WalletAdjustAction,
} from "../../services/admin-user-wallet.service.js";
import { listWalletTransactions } from "../../services/wallet.service.js";
import { parseTopupAmount } from "../../services/wallet-topup.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { formatToman, transactionLine } from "../user-wallet/wallet-views.js";
import { statusLabel as serviceStatusLabel } from "../user-services/service-views.js";
import {
  ORDER_TYPE_LABEL,
  orderStatusInfo,
  paymentPurposeTitle,
  paymentStatusInfo,
} from "../../services/user-history.service.js";
import {
  adjustConfirmKeyboard,
  adjustConfirmText,
  AU_CB,
  blockConfirmKeyboard,
  NO_USER_FOUND_TEXT,
  SEARCH_PROMPT_TEXT,
  searchCancelKeyboard,
  subListKeyboard,
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
 * Full Phase 20 state cleanup (flow + wallet draft + search query + the
 * Fix B return-to-receipt context). Called on the «مدیریت کاربران» landing
 * and from showAdminMenu, so returning to the admin main menu never leaves
 * a stale draft, query or receipt context behind.
 */
export function clearAdminUsersState(ctx: BotContext): void {
  clearAdminWalletFlowState(ctx);
  delete ctx.session.temp.adminUserSearchQuery;
  delete ctx.session.temp.adminUserReturnContext;
  delete ctx.session.temp.adminUserListFilter;
  delete ctx.session.temp.adminUserListPage;
}

/**
 * Fix B: receipt short-id for «بازگشت به رسید 🧾» while the admin navigates
 * the user pages after jumping in from a receipt detail.
 */
function receiptReturnSid(ctx: BotContext): string | undefined {
  const context = ctx.session.temp.adminUserReturnContext;
  return context?.kind === "receipt" ? context.receiptId.slice(0, 8) : undefined;
}

export async function renderLanding(ctx: BotContext): Promise<void> {
  clearAdminUsersState(ctx); // full clear: flow + draft + stored search query
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, USERS_LANDING_TEXT, usersLandingKeyboard());
  ctx.session.lastMenu = AU_CB.root;
}

async function renderProfile(ctx: BotContext, user: User): Promise<void> {
  const hasResults = typeof ctx.session.temp.adminUserSearchQuery === "string";
  const overview = await getAdminUserOverview(user);
  const filter = ctx.session.temp.adminUserListFilter;
  const backToList =
    filter === undefined
      ? undefined
      : { filter, page: ctx.session.temp.adminUserListPage ?? 1 };
  await safeEditOrReply(
    ctx,
    userProfileText(user, overview),
    userProfileKeyboard(
      userShortId(user),
      hasResults,
      receiptReturnSid(ctx),
      user.status,
      backToList,
    ),
    HTML,
  );
}

async function renderWallet(ctx: BotContext, user: User): Promise<void> {
  const transactions = await listUserWalletTransactionsForAdmin(user.id, 5);
  await safeEditOrReply(
    ctx,
    userWalletText(user, transactions),
    userWalletKeyboard(userShortId(user), receiptReturnSid(ctx)),
    HTML,
  );
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

// --- Fix C: paged status-filtered lists (recent / active / blocked / disabled) ---

const USER_LIST_TITLES: Record<"r" | "a" | "b" | "d", string> = {
  r: "کاربران اخیر 🕘",
  a: "کاربران فعال ✅",
  b: "کاربران مسدود 🚫",
  d: "کاربران غیرفعال ⏸",
};

async function renderUserList(
  ctx: BotContext,
  filter: "r" | "a" | "b" | "d",
  page: number,
): Promise<void> {
  clearAdminWalletFlowState(ctx);
  // Browsing a list replaces any search context for back-navigation.
  delete ctx.session.temp.adminUserSearchQuery;
  const pageData = await listUsersForAdmin(filter, page);
  ctx.session.temp.adminUserListFilter = filter;
  ctx.session.temp.adminUserListPage = pageData.page;
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    await safeEditOrReply(ctx, `${USER_LIST_TITLES[filter]}\n\n${NO_USER_FOUND_TEXT}`, usersLandingKeyboard());
    return;
  }
  const kb = userListKeyboard(pageData.users, AU_CB.root);
  // Pagination row is spliced in front of the trailing back button.
  if (pageData.pages > 1) {
    const pager: Array<{ text: string; callback_data: string }> = [];
    if (pageData.page > 1) {
      pager.push({ text: "« قبلی", callback_data: AU_CB.list(filter, pageData.page - 1) });
    }
    pager.push({
      text: `${pageData.page}/${pageData.pages}`,
      callback_data: AU_CB.list(filter, pageData.page),
    });
    if (pageData.page < pageData.pages) {
      pager.push({ text: "بعدی »", callback_data: AU_CB.list(filter, pageData.page + 1) });
    }
    kb.inline_keyboard.splice(kb.inline_keyboard.length - 1, 0, pager);
  }
  await safeEditOrReply(ctx, `${USER_LIST_TITLES[filter]} (${pageData.total})`, kb);
}

adminUsersHandler.callbackQuery(/^admin:users:ls:([rabd]):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderUserList(ctx, ctx.match[1] as "r" | "a" | "b" | "d", Number.parseInt(ctx.match[2], 10));
});

// Old «کاربران اخیر» callback keeps answering with the new recent list.
adminUsersHandler.callbackQuery(AU_CB.recent, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderUserList(ctx, "r", 1);
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

// --- Fix C: confirmed block / unblock (guarded status flip only) --------------------

async function askBlockChange(ctx: BotContext, shortId: string, block: boolean): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(shortId);
  if (user === null || user.status !== (block ? "ACTIVE" : "BLOCKED")) {
    await safeAnswerCallback(ctx, user === null ? NOT_FOUND : "وضعیت کاربر تغییر کرده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      block ? "مسدود کردن کاربر 🚫" : "رفع مسدودی کاربر ✅",
      "",
      `کاربر: <code>${user.telegramId}</code>${
        user.username === null || user.username === "" ? "" : ` (@${escapeHtml(user.username)})`
      }`,
      "",
      block
        ? "آیا از مسدود کردن این کاربر مطمئن هستید؟\nکاربر مسدود دیگر به ربات دسترسی نخواهد داشت."
        : "دسترسی کاربر به ربات دوباره فعال می‌شود. ادامه؟",
    ].join("\n"),
    blockConfirmKeyboard(userShortId(user), block),
    HTML,
  );
}

async function confirmBlockChange(ctx: BotContext, shortId: string, block: boolean): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(shortId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await setUserBlocked(user.id, block);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    await renderProfile(ctx, user);
    return;
  }
  await safeAnswerCallback(ctx, block ? "کاربر با موفقیت مسدود شد." : "کاربر با موفقیت فعال شد.");
  await renderProfile(ctx, outcome.user);
}

adminUsersHandler.callbackQuery(/^admin:users:blk:([0-9a-f-]+)$/, async (ctx) => {
  await askBlockChange(ctx, ctx.match[1], true);
});
adminUsersHandler.callbackQuery(/^admin:users:blk:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmBlockChange(ctx, ctx.match[1], true);
});
adminUsersHandler.callbackQuery(/^admin:users:ublk:([0-9a-f-]+)$/, async (ctx) => {
  await askBlockChange(ctx, ctx.match[1], false);
});
adminUsersHandler.callbackQuery(/^admin:users:ublk:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmBlockChange(ctx, ctx.match[1], false);
});

// --- Fix C: read-only per-user sub-pages (services / orders / payments / tx) --------
// Pure reporting over existing data - nothing here mutates anything, and no
// subscription/config links or secrets ever render.

adminUsersHandler.callbackQuery(/^admin:users:svc:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sid = userShortId(user);
  const pageData = await listUserServicesForAdmin(user.id, Number.parseInt(ctx.match[2], 10));
  await safeAnswerCallback(ctx);
  const lines = [`سرویس‌های کاربر 🛍 (${pageData.total})`, ""];
  for (const service of pageData.rows) {
    const expiry = service.expiresAt === null ? "نامحدود" : service.expiresAt.toISOString().slice(0, 10);
    lines.push(
      `• ${escapeHtml(service.productNameSnapshot ?? service.username)} | ${serviceStatusLabel(service.status)} | ${escapeHtml(service.panelNameSnapshot ?? "-")} | انقضا: ${expiry}`,
    );
  }
  if (pageData.rows.length === 0) {
    lines.push("سرویسی ثبت نشده است.");
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    subListKeyboard(sid, (p) => AU_CB.services(sid, p), pageData),
    HTML,
  );
});

adminUsersHandler.callbackQuery(/^admin:users:ord:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sid = userShortId(user);
  const pageData = await listUserOrdersForAdmin(user.id, Number.parseInt(ctx.match[2], 10));
  await safeAnswerCallback(ctx);
  const lines = [`سفارش‌های کاربر 🧾 (${pageData.total})`, ""];
  for (const order of pageData.rows) {
    const status = orderStatusInfo(order.status);
    lines.push(
      `• ${ORDER_TYPE_LABEL[order.type] ?? order.type} | ${escapeHtml(order.productNameSnapshot ?? "-")} | ${formatToman(order.finalPriceToman)} | ${status.icon} ${status.label} | ${order.createdAt.toISOString().slice(0, 10)}`,
    );
  }
  if (pageData.rows.length === 0) {
    lines.push("سفارشی ثبت نشده است.");
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    subListKeyboard(sid, (p) => AU_CB.orders(sid, p), pageData),
    HTML,
  );
});

adminUsersHandler.callbackQuery(/^admin:users:pay:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sid = userShortId(user);
  const pageData = await listUserPaymentsForAdmin(user.id, Number.parseInt(ctx.match[2], 10));
  await safeAnswerCallback(ctx);
  const lines = [
    `پرداخت‌های کاربر 💳 (${pageData.total})`,
    "",
    pageData.rows.length === 0 ? "پرداختی ثبت نشده است." : "برای جزئیات روی یک پرداخت بزنید:",
  ];
  // Each payment opens the existing Fix B receipt/payment detail page.
  const rows = pageData.rows.map((payment) => {
    const status = paymentStatusInfo(payment.status);
    return {
      label: `${status.icon} ${paymentPurposeTitle(payment.purpose)} | ${formatToman(payment.amountToman)} | ${payment.createdAt.toISOString().slice(5, 10)}`,
      callback: `admin:rec:view:${payment.id.slice(0, 8)}`,
    };
  });
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    subListKeyboard(sid, (p) => AU_CB.payments(sid, p), pageData, rows),
    HTML,
  );
});

adminUsersHandler.callbackQuery(/^admin:user_wallet:tx:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sid = userShortId(user);
  const pageData = await listWalletTransactions(user.id, Number.parseInt(ctx.match[2], 10));
  await safeAnswerCallback(ctx);
  const lines = [`تاریخچه تراکنش‌های کاربر 📋 (${pageData.total})`, ""];
  for (const tx of pageData.transactions) {
    lines.push(`• ${transactionLine(tx)}`);
  }
  if (pageData.transactions.length === 0) {
    lines.push("تراکنشی ثبت نشده است.");
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    subListKeyboard(sid, (p) => AU_CB.walletTx(sid, p), pageData),
    HTML,
  );
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
      ? "مبلغ افزایش موجودی را وارد کنید."
      : "مبلغ کاهش موجودی را وارد کنید.",
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
      : "موجودی کیف پول شما توسط مدیریت کاهش یافت.",
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
    increase ? "موجودی کاربر با موفقیت افزایش یافت ✅" : "موجودی کاربر با موفقیت کاهش یافت ✅",
  );
  const summary = [
    increase ? "افزایش موجودی ثبت شد ✅" : "کاهش موجودی ثبت شد ✅",
    "",
    `مبلغ: ${formatToman(draft.amountToman)}`,
    `موجودی جدید کاربر: ${formatToman(outcome.user.balanceToman)}`,
    notified ? "کاربر مطلع شد ✅" : "ارسال پیام به کاربر ناموفق بود ⚠️",
  ].join("\n");
  await safeEditOrReply(
    ctx,
    summary,
    userWalletKeyboard(userShortId(outcome.user), receiptReturnSid(ctx)),
    HTML,
  );
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
    await safeReply(ctx, "دلیل این عملیات را وارد کنید.", searchCancelKeyboard());
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
