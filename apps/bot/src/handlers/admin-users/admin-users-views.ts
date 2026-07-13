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
  // Fix C: landing filters, per-user read-only sub-lists, block/unblock.
  list: (filter: "r" | "a" | "b" | "d", page: number): string =>
    `admin:users:ls:${filter}:${page}`,
  services: (sid: string, page: number): string => `admin:users:svc:${sid}:${page}`,
  orders: (sid: string, page: number): string => `admin:users:ord:${sid}:${page}`,
  payments: (sid: string, page: number): string => `admin:users:pay:${sid}:${page}`,
  walletTx: (sid: string, page: number): string => `admin:user_wallet:tx:${sid}:${page}`,
  blockAsk: (sid: string): string => `admin:users:blk:${sid}`,
  blockConfirm: (sid: string): string => `admin:users:blk:${sid}:yes`,
  unblockAsk: (sid: string): string => `admin:users:ublk:${sid}`,
  unblockConfirm: (sid: string): string => `admin:users:ublk:${sid}:yes`,
} as const;

export const USERS_LANDING_TEXT = "مدیریت کاربران 👤";
export const SEARCH_PROMPT_TEXT =
  "آیدی عددی تلگرام، یوزرنیم (با یا بدون @)، شناسه داخلی، نام یا شماره موبایل کاربر را وارد کنید.";
export const NO_USER_FOUND_TEXT = "کاربری با این مشخصات پیدا نشد.";

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

/**
 * Fix C landing. Filters map to EXISTING UserStatus values (documented in
 * admin-user-wallet.service): active -> ACTIVE, blocked -> BLOCKED,
 * inactive -> DISABLED; recent -> newest of every status except DELETED.
 */
export function usersLandingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("جستجوی کاربر 🔎", AU_CB.search)
    .row()
    .text("کاربران اخیر 🕘", AU_CB.list("r", 1))
    .text("کاربران مسدود 🚫", AU_CB.list("b", 1))
    .row()
    .text("کاربران فعال ✅", AU_CB.list("a", 1))
    .text("کاربران غیرفعال ⏸", AU_CB.list("d", 1))
    .row()
    .text("بازگشت به پنل ادمین", CB.ADMIN_MENU);
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

/** Counters shown on the Fix C profile (computed read-only by the service). */
export interface UserOverviewView {
  services: number;
  activeServices: number;
  orders: number;
  pendingOrders: number;
  paidOrders: number;
  payments: number;
  tickets: number;
  referralCount: number;
  referrer: { telegramId: bigint; username: string | null } | null;
}

/** «پروفایل کاربر 👤» - admin-facing summary of one user (Fix C fields). */
export function userProfileText(user: User, overview?: UserOverviewView): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const lines = [
    "پروفایل کاربر 👤",
    "",
    `شناسه: <code>${userShortId(user)}</code>`,
    `آیدی عددی: <code>${user.telegramId}</code>`,
    `نام: ${fullName === "" ? "-" : escapeHtml(fullName)}`,
    `نام کاربری: ${user.username === null || user.username === "" ? "-" : `@${escapeHtml(user.username)}`}`,
    `شماره تماس: ${user.phoneNumber === null || user.phoneNumber === "" ? "ثبت نشده" : escapeHtml(user.phoneNumber)}`,
    `تاریخ عضویت: ${formatDate(user.createdAt)}`,
    `آخرین بازدید: ${formatDate(user.lastSeenAt)}`,
    `وضعیت: ${STATUS_LABELS[user.status] ?? user.status}`,
    `گروه: ${GROUP_LABELS[user.group] ?? user.group}`,
    "",
    `موجودی کیف پول: ${formatToman(user.balanceToman)}`,
    `مجموع شارژ (بستانکار): ${formatToman(user.totalChargedToman + user.totalManualAddedToman)}`,
    `مجموع خرید/کاهش (بدهکار): ${formatToman(user.totalSpentToman + user.totalManualDeductedToman)}`,
  ];
  if (overview !== undefined) {
    lines.push(
      `سفارش‌های در انتظار: ${overview.pendingOrders} | موفق: ${overview.paidOrders}`,
      "",
      `سرویس‌ها: ${overview.services} (فعال: ${overview.activeServices})`,
      `سفارش‌ها: ${overview.orders} | پرداخت‌ها: ${overview.payments} | تیکت‌ها: ${overview.tickets}`,
      "",
      `معرف: ${
        overview.referrer === null
          ? "-"
          : overview.referrer.username === null || overview.referrer.username === ""
            ? `<code>${overview.referrer.telegramId}</code>`
            : `@${escapeHtml(overview.referrer.username)}`
      }`,
      `تعداد زیرمجموعه‌ها: ${overview.referralCount}`,
    );
  }
  return lines.join("\n");
}

/**
 * Fix C profile keyboard: wallet/services/orders/payments sub-pages, a
 * confirmed block (ACTIVE) or unblock (BLOCKED), the Fix B receipt return
 * and the direct-parent backs. Per-user ticket and referral-member lists
 * have no page yet, so no button renders for them (documented deferral -
 * the counters render in the text instead).
 */
export function userProfileKeyboard(
  sid: string,
  hasResults: boolean,
  returnReceiptSid?: string,
  status?: User["status"],
  backToList?: { filter: "r" | "a" | "b" | "d"; page: number },
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("کیف پول کاربر 💰", AU_CB.wallet(sid))
    .text("سرویس‌های کاربر 🛍", AU_CB.services(sid, 1))
    .row()
    .text("سفارش‌های کاربر 🧾", AU_CB.orders(sid, 1))
    .text("پرداخت‌های کاربر 💳", AU_CB.payments(sid, 1))
    .row();
  if (status === "ACTIVE") {
    kb.text("مسدود کردن کاربر 🚫", AU_CB.blockAsk(sid)).row();
  } else if (status === "BLOCKED") {
    kb.text("رفع مسدودی کاربر ✅", AU_CB.unblockAsk(sid)).row();
  }
  if (returnReceiptSid !== undefined) {
    kb.text("بازگشت به رسید 🧾", `admin:rec:view:${returnReceiptSid}`).row();
  }
  if (hasResults) {
    kb.text("بازگشت به نتایج", AU_CB.results).row();
  } else if (backToList !== undefined) {
    kb.text("بازگشت به لیست", AU_CB.list(backToList.filter, backToList.page)).row();
  }
  return kb
    .text("بازگشت به مدیریت کاربران", AU_CB.root)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
}

/** Confirmed block/unblock - nothing changes before «بله». */
export function blockConfirmKeyboard(sid: string, block: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      block ? "بله، مسدود کن 🚫" : "بله، رفع مسدودی ✅",
      block ? AU_CB.blockConfirm(sid) : AU_CB.unblockConfirm(sid),
    )
    .row()
    .text("انصراف", AU_CB.view(sid));
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
    `افزایش دستی: ${formatToman(user.totalManualAddedToman)} | کاهش دستی: ${formatToman(user.totalManualDeductedToman)}`,
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
    .text("کاهش موجودی ➖", AU_CB.walletSubtract(sid))
    .row()
    .text("تاریخچه تراکنش‌ها 📋", AU_CB.walletTx(sid, 1))
    .row();
  if (returnReceiptSid !== undefined) {
    kb.text("بازگشت به رسید 🧾", `admin:rec:view:${returnReceiptSid}`).row();
  }
  return kb
    .text("بازگشت به کاربر", AU_CB.view(sid))
    .text("بازگشت به مدیریت کاربران", AU_CB.root);
}

/** Shared pagination + back rows for the Fix C read-only sub-lists. */
export function subListKeyboard(
  sid: string,
  build: (page: number) => string,
  pageData: { page: number; pages: number },
  rows?: Array<{ label: string; callback: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows ?? []) {
    kb.text(row.label, row.callback).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", build(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, build(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", build(pageData.page + 1));
    }
    kb.row();
  }
  return kb
    .text("بازگشت به کاربر", AU_CB.view(sid))
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
    increase ? "افزایش موجودی کیف پول" : "کاهش موجودی کیف پول",
    "",
    `کاربر: <code>${user.telegramId}</code>${
      user.username === null || user.username === "" ? "" : ` (@${escapeHtml(user.username)})`
    }`,
    `موجودی فعلی: ${formatToman(user.balanceToman)}`,
    `مبلغ: ${formatToman(draft.amountToman)}`,
    enough
      ? `موجودی پس از تغییر: ${formatToman(after)}`
      : "⚠️ موجودی کاربر برای این کاهش کافی نیست.",
    `دلیل: ${escapeHtml(draft.reason)}`,
    "",
    "آیا از انجام این تغییر مطمئن هستید؟",
  ];
  return lines.join("\n");
}

export function adjustConfirmKeyboard(action: "INCREASE" | "DECREASE"): InlineKeyboard {
  return new InlineKeyboard()
    .text(action === "INCREASE" ? "تایید افزایش ✅" : "تایید کاهش ✅", AU_CB.walletConfirm)
    .row()
    .text("انصراف", AU_CB.walletCancel);
}
