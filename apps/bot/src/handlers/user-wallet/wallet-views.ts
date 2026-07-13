import type {
  UserGroup,
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
// Wallet/profile rendering (Phase 13, trimmed by Corrective Fix A) -
// read-only views. The landing shows identity + balance + counters only;
// transaction lines render solely inside «تاریخچه تراکنش‌ها 📋». The
// heading/prompt/note/empty texts come from MessageTemplate keys
// (wallet_header_text, wallet_topup_amount_prompt, wallet_topup_preview_note,
// wallet_empty_transactions_text) fetched by the handler and passed in -
// dynamic amounts stay formatted/escaped in code, and the template values
// are HTML-escaped here because these messages use parseMode HTML (a bad
// operator edit must never make Telegram reject the wallet pages).
// =============================================================================

export const WALLET_CB = {
  MAIN: CB.USER_WALLET,
  REFRESH: "user:wallet:refresh",
  TOPUP: "user:wallet:topup",
  TOPUP_CONTINUE: "user:wallet:topup:continue",
  TOPUP_CANCEL: "user:wallet:topup:cancel",
} as const;

export const walletTxCb = (page: number): string => `user:wallet:tx:${page}`;

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

/**
 * Wallet landing (Corrective Fix A): identity, balance and counters only.
 * `headerText` is the operator-editable wallet_header_text template.
 */
export function walletSummaryText(summary: WalletSummary, headerText: string): string {
  const user = summary.user;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return [
    escapeHtml(headerText),
    "",
    `آیدی عددی: <code>${user.telegramId}</code>`,
    `نام: ${fullName === "" ? "-" : escapeHtml(fullName)}`,
    `نام کاربری: ${user.username === null ? "-" : `@${escapeHtml(user.username)}`}`,
    `شماره موبایل: ${user.phoneNumber === null ? "ثبت نشده" : escapeHtml(user.phoneNumber)}`,
    `تاریخ ثبت‌نام: ${formatDate(user.joinedAt)}`,
    `گروه کاربری: ${GROUP_LABELS[user.group] ?? user.group}`,
    "",
    `موجودی: <b>${formatToman(user.balanceToman)}</b>`,
    "",
    `تعداد سرویس‌ها: ${summary.totalServices}`,
    `سفارش‌های پرداخت‌نشده: ${summary.pendingOrders}`,
    `تعداد زیرمجموعه: ${summary.referralCount}`,
  ].join("\n");
}

export function walletMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("افزایش موجودی 💰", WALLET_CB.TOPUP)
    .row()
    .text("تاریخچه تراکنش‌ها 📋", walletTxCb(1))
    .text("بروزرسانی ♻️", WALLET_CB.REFRESH)
    .row()
    .text("بازگشت به منوی اصلی", CB.USER_MENU);
}

/** `emptyText` is the wallet_empty_transactions_text template. */
export function transactionHistoryText(
  pageData: WalletTransactionPage,
  emptyText: string,
): string {
  const lines = ["تاریخچه تراکنش‌های کیف پول", ""];
  if (pageData.total === 0) {
    lines.push(escapeHtml(emptyText));
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

export function topupAmountKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("بازگشت به کیف پول", WALLET_CB.MAIN)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
}

/**
 * Pre-invoice for a validated top-up amount (nothing written yet).
 * `previewNote` is the wallet_topup_preview_note template.
 */
export function topupPreInvoiceText(
  amountToman: number,
  balanceToman: number,
  previewNote: string,
): string {
  return [
    "پیش‌فاکتور شارژ کیف پول 🏦",
    "",
    `مبلغ شارژ: <b>${formatToman(amountToman)}</b>`,
    `موجودی فعلی کیف پول: ${formatToman(balanceToman)}`,
    `موجودی بعد از شارژ: ${formatToman(balanceToman + amountToman)}`,
    "",
    `توضیح: ${escapeHtml(previewNote)}`,
  ].join("\n");
}

export function topupPreInvoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("ادامه و انتخاب روش پرداخت ✅", WALLET_CB.TOPUP_CONTINUE)
    .row()
    .text("تغییر مبلغ", WALLET_CB.TOPUP)
    .text("لغو", WALLET_CB.TOPUP_CANCEL)
    .row()
    .text("بازگشت به کیف پول", WALLET_CB.MAIN);
}
