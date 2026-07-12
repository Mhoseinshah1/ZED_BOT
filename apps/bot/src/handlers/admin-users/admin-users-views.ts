import type { User, UserGroup, UserStatus, WalletTransaction } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { AdminUserWalletDraft } from "../../core/session.js";
import { escapeHtml } from "../../utils/html.js";
import { formatDate, formatToman, transactionLine } from "../user-wallet/wallet-views.js";

// =============================================================================
// Admin user management rendering (Phase 20) - landing, search results, user
// profile, wallet page and the manual increase/decrease confirmation. Admin
// context only (behind adminAuthMiddleware).
// =============================================================================

export const AU_CB = {
  root: CB.ADMIN_USERS,
  search: "admin:users:search",
  recent: "admin:users:recent",
  results: "admin:users:results",
  view: (sid: string): string => `admin:users:view:${sid}`,
  wallet: (sid: string): string => `admin:user_wallet:open:${sid}`,
  walletAdd: (sid: string): string => `admin:user_wallet:add:${sid}`,
  walletSubtract: (sid: string): string => `admin:user_wallet:subtract:${sid}`,
  walletConfirm: "admin:user_wallet:confirm",
  walletCancel: "admin:user_wallet:cancel",
} as const;

export const USERS_LANDING_TEXT = "مدیریت کاربران 👥";
export const SEARCH_PROMPT_TEXT = "آیدی عددی تلگرام، یوزرنیم یا شماره موبایل کاربر را وارد کنید.";
export const NO_USER_FOUND_TEXT = "کاربری پیدا نشد.";

const GROUP_LABELS: Record<UserGroup, string> = {
  F: "کاربر عادی (F)",
  N: "نماینده (N)",
  N2: "نماینده ویژه (N2)",
};

const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: "فعال ✅",
  BLOCKED: "مسدود 🚫",
  DISABLED: "غیرفعال ⏸",
  DELETED: "حذف‌شده 🗑",
};

export function userShortId(user: Pick<User, "id">): string {
  return user.id.slice(0, 8);
}

/** "12345678 | @name" or the first/last name - for result/list buttons. */
export function userButtonLabel(user: User): string {
  const name =
    user.username !== null && user.username !== ""
      ? `@${user.username}`
      : [user.firstName, user.lastName].filter(Boolean).join(" ") || "-";
  return `${user.telegramId} | ${name}`;
}

export function usersLandingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("جستجوی کاربر 🔎", AU_CB.search)
    .row()
    .text("کاربران اخیر 👤", AU_CB.recent)
    .row()
    .text("بازگشت", CB.ADMIN_MENU);
}

export function userListKeyboard(users: User[], backCb: string = AU_CB.root): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const user of users) {
    kb.text(userButtonLabel(user), AU_CB.view(userShortId(user))).row();
  }
  kb.text("بازگشت", backCb);
  return kb;
}

export function searchCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("انصراف", AU_CB.root);
}

/** «پروفایل کاربر 👤» - admin-facing summary of one user. */
export function userProfileText(user: User): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return [
    "پروفایل کاربر 👤",
    "",
    `شناسه: <code>${userShortId(user)}</code>`,
    `آیدی عددی: <code>${user.telegramId}</code>`,
    `نام کاربری: ${user.username === null || user.username === "" ? "-" : `@${escapeHtml(user.username)}`}`,
    `نام: ${fullName === "" ? "-" : escapeHtml(fullName)}`,
    `گروه: ${GROUP_LABELS[user.group] ?? user.group}`,
    `وضعیت: ${STATUS_LABELS[user.status] ?? user.status}`,
    `تاریخ عضویت: ${formatDate(user.createdAt)}`,
    "",
    `موجودی کیف پول: ${formatToman(user.balanceToman)}`,
    `مجموع شارژ: ${formatToman(user.totalChargedToman)}`,
    `مجموع خرید: ${formatToman(user.totalSpentToman)}`,
    `تعداد سفارش‌ها: ${user.ordersCount} (پرداخت‌شده: ${user.paidOrdersCount})`,
  ].join("\n");
}

/**
 * Fix B: when the page was reached from a receipt detail,
 * `returnReceiptSid` adds «بازگشت به رسید 🧾» (the literal callback shape of
 * the receipts handler's admin:rec:view route - not imported to avoid a
 * module cycle).
 */
export function userProfileKeyboard(
  sid: string,
  hasResults: boolean,
  returnReceiptSid?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("کیف پول کاربر 🏦", AU_CB.wallet(sid)).row();
  if (returnReceiptSid !== undefined) {
    kb.text("بازگشت به رسید 🧾", `admin:rec:view:${returnReceiptSid}`).row();
  }
  if (hasResults) {
    kb.text("بازگشت به نتایج", AU_CB.results).row();
  }
  return kb
    .text("بازگشت به مدیریت کاربران", AU_CB.root)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
}

/** «کیف پول کاربر 🏦» - balance, counters and the latest transactions. */
export function userWalletText(user: User, transactions: WalletTransaction[]): string {
  const lines = [
    "کیف پول کاربر 🏦",
    "",
    `کاربر: <code>${user.telegramId}</code>${
      user.username === null || user.username === "" ? "" : ` (@${escapeHtml(user.username)})`
    }`,
    `موجودی فعلی: ${formatToman(user.balanceToman)}`,
    `مجموع شارژ: ${formatToman(user.totalChargedToman)}`,
    `مجموع خرید: ${formatToman(user.totalSpentToman)}`,
    `مجموع تخفیف: ${formatToman(user.totalDiscountToman)}`,
    `افزایش دستی: ${formatToman(user.totalManualAddedToman)} | کسر دستی: ${formatToman(user.totalManualDeductedToman)}`,
  ];
  if (transactions.length > 0) {
    lines.push("", "آخرین تراکنش‌ها:");
    for (const tx of transactions) {
      lines.push(`• ${transactionLine(tx)}`);
    }
  }
  return lines.join("\n");
}

/** Fix B: `returnReceiptSid` adds «بازگشت به رسید 🧾» (see userProfileKeyboard). */
export function userWalletKeyboard(sid: string, returnReceiptSid?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("افزایش موجودی ➕", AU_CB.walletAdd(sid))
    .text("کسر موجودی ➖", AU_CB.walletSubtract(sid))
    .row();
  if (returnReceiptSid !== undefined) {
    kb.text("بازگشت به رسید 🧾", `admin:rec:view:${returnReceiptSid}`).row();
  }
  return kb
    .text("بازگشت به پروفایل کاربر", AU_CB.view(sid))
    .row()
    .text("بازگشت به مدیریت کاربران", AU_CB.root);
}

/** Confirmation screen - nothing is written before «تایید». */
export function adjustConfirmText(
  user: User,
  draft: Required<Pick<AdminUserWalletDraft, "action" | "amountToman" | "reason">>,
): string {
  const increase = draft.action === "INCREASE";
  const enough = increase || user.balanceToman >= draft.amountToman;
  const after = increase
    ? user.balanceToman + draft.amountToman
    : user.balanceToman - draft.amountToman;
  const lines = [
    increase ? "افزایش موجودی کیف پول" : "کسر موجودی کیف پول",
    "",
    `کاربر: <code>${user.telegramId}</code>${
      user.username === null || user.username === "" ? "" : ` (@${escapeHtml(user.username)})`
    }`,
    `موجودی فعلی: ${formatToman(user.balanceToman)}`,
    `مبلغ: ${formatToman(draft.amountToman)}`,
    enough
      ? `موجودی پس از تغییر: ${formatToman(after)}`
      : "⚠️ موجودی کاربر برای این کسر کافی نیست.",
    `دلیل: ${escapeHtml(draft.reason)}`,
    "",
    increase
      ? "آیا از افزایش موجودی این کاربر مطمئن هستید؟"
      : "آیا از کسر موجودی این کاربر مطمئن هستید؟",
  ];
  return lines.join("\n");
}

export function adjustConfirmKeyboard(action: "INCREASE" | "DECREASE"): InlineKeyboard {
  return new InlineKeyboard()
    .text(action === "INCREASE" ? "تایید افزایش ✅" : "تایید کسر ✅", AU_CB.walletConfirm)
    .row()
    .text("انصراف", AU_CB.walletCancel);
}
