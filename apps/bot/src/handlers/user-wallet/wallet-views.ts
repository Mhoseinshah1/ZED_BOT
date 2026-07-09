import type {
  UserGroup,
  UserStatus,
  WalletTransaction,
  WalletTransactionType,
} from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type {
  WalletSummary,
  WalletTransactionPage,
} from "../../services/wallet.service.js";
import { escapeHtml } from "../../utils/html.js";

// =============================================================================
// Wallet/profile rendering (Phase 13) - read-only views. No amounts are ever
// asked for and no payment surface exists here (top-up is a placeholder).
// =============================================================================

export const WALLET_CB = {
  MAIN: CB.USER_WALLET,
  REFRESH: "user:wallet:refresh",
  TOPUP: "user:wallet:topup",
} as const;

export const walletTxCb = (page: number): string => `user:wallet:tx:${page}`;

export const TOPUP_PLACEHOLDER_TEXT = "شارژ کیف پول در فاز بعدی فعال می‌شود.";
export const NO_TRANSACTIONS_TEXT = "تراکنشی ثبت نشده است.";

export function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

export function formatDate(date: Date | null): string {
  return date === null ? "-" : `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

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

const TX_TYPE_LABELS: Record<WalletTransactionType, string> = {
  CHARGE: "شارژ کیف پول",
  SPEND: "خرید",
  REFUND: "برگشت وجه",
  CASHBACK: "کش‌بک",
  COMMISSION: "پورسانت",
  MANUAL_ADD: "افزایش دستی",
  MANUAL_DEDUCT: "کسر دستی",
  DEBT_ADD: "ثبت بدهی",
  DEBT_PAYMENT: "پرداخت بدهی",
  DISCOUNT: "تخفیف",
  SYSTEM_ADJUSTMENT: "اصلاح سیستمی",
};

/** Known machine reasons -> user-friendly Persian; unknown reasons are escaped raw. */
const REASON_LABELS: Record<string, string> = {
  REFUND_PROVISIONING_FAILED: "برگشت بابت خطای ساخت/تمدید سرویس",
};

function txTypeLabel(type: WalletTransactionType): string {
  return TX_TYPE_LABELS[type] ?? type;
}

function txReasonLabel(reason: string | null): string | null {
  if (reason === null || reason === "") {
    return null;
  }
  return REASON_LABELS[reason] ?? escapeHtml(reason);
}

/** Sign derived from the actual balance movement - never guessed from type. */
function signedAmount(tx: WalletTransaction): string {
  const sign =
    tx.balanceAfterToman > tx.balanceBeforeToman
      ? "+"
      : tx.balanceAfterToman < tx.balanceBeforeToman
        ? "-"
        : "";
  return `${sign}${formatToman(tx.amountToman)}`;
}

export function transactionLine(tx: WalletTransaction): string {
  const parts = [signedAmount(tx), txTypeLabel(tx.type)];
  const reason = txReasonLabel(tx.reason);
  if (reason !== null) {
    parts.push(reason);
  }
  parts.push(tx.createdAt.toISOString().slice(0, 10));
  return `${parts.join(" | ")} (موجودی: ${formatToman(tx.balanceAfterToman)})`;
}

export function walletSummaryText(summary: WalletSummary): string {
  const user = summary.user;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const lines = [
    "کیف پول و حساب کاربری 🏦",
    "",
    `شناسه عددی تلگرام: <code>${user.telegramId}</code>`,
    `نام: ${fullName === "" ? "-" : escapeHtml(fullName)}`,
    `نام کاربری: ${user.username === null ? "-" : `@${escapeHtml(user.username)}`}`,
    `شماره تماس: ${user.phoneNumber === null ? "ثبت نشده" : escapeHtml(user.phoneNumber)}`,
    `زمان ثبت‌نام: ${formatDate(user.joinedAt)}`,
    `آخرین بازدید: ${formatDate(user.lastSeenAt)}`,
    `گروه کاربری: ${GROUP_LABELS[user.group] ?? user.group}`,
    `وضعیت کاربر: ${STATUS_LABELS[user.status] ?? user.status}`,
    "",
    `موجودی کیف پول: <b>${formatToman(user.balanceToman)}</b>`,
    `مجموع شارژ: ${formatToman(user.totalChargedToman)}`,
    `مجموع خرید: ${formatToman(user.totalSpentToman)}`,
    `مجموع تخفیف: ${formatToman(user.totalDiscountToman)}`,
    `مجموع برگشتی: ${formatToman(user.totalRefundedToman)}`,
    "",
    `تعداد سرویس‌ها: ${summary.totalServices}`,
    `تعداد سرویس‌های فعال: ${summary.activeServices}`,
    `تعداد کل سفارش‌ها: ${summary.totalOrders}`,
    `تعداد سفارش‌های پرداخت‌شده: ${summary.paidOrders}`,
    `تعداد زیرمجموعه‌ها: ${summary.referralCount}`,
    "",
    "آخرین تراکنش‌ها:",
  ];
  if (summary.latestTransactions.length === 0) {
    lines.push(NO_TRANSACTIONS_TEXT);
  } else {
    for (const tx of summary.latestTransactions) {
      lines.push(transactionLine(tx));
    }
  }
  lines.push("", `تاریخ/ساعت فعلی: ${formatDate(summary.now)}`);
  return lines.join("\n");
}

export function walletMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("افزایش موجودی 💰", WALLET_CB.TOPUP)
    .row()
    .text("تاریخچه تراکنش‌ها 📋", walletTxCb(1))
    .text("بروزرسانی ♻️", WALLET_CB.REFRESH)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
}

export function transactionHistoryText(pageData: WalletTransactionPage): string {
  const lines = ["تاریخچه تراکنش‌های کیف پول", ""];
  if (pageData.total === 0) {
    lines.push(NO_TRANSACTIONS_TEXT);
  } else {
    for (const tx of pageData.transactions) {
      lines.push(transactionLine(tx));
    }
    lines.push("", `صفحه ${pageData.page} از ${pageData.pages} (${pageData.total} تراکنش)`);
  }
  return lines.join("\n");
}

export function transactionHistoryKeyboard(pageData: WalletTransactionPage): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", walletTxCb(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, walletTxCb(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", walletTxCb(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به کیف پول", WALLET_CB.MAIN).row().text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

export function topupPlaceholderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("بازگشت به کیف پول", WALLET_CB.MAIN)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
}
