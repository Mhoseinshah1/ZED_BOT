import type { CardToCardAccount, PaymentGateway } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import {
  maskCardNumber,
  type CardGatewayWithCounts,
} from "../../services/admin-payment-method.service.js";
import { escapeHtml } from "../../utils/html.js";
import { formatToman } from "../user-wallet/wallet-views.js";

// =============================================================================
// Admin finance rendering (Phase 21) - finance landing, payment methods
// summary, the card-to-card gateway page and card account management. Card
// numbers are ALWAYS rendered masked here; the raw number exists only inside
// the paying user's Phase 7 card screen.
// =============================================================================

export const FIN_CB = {
  root: CB.ADMIN_FINANCE,
  methods: "admin:finance:methods",
  card: "admin:finance:card",
  addGateway: "admin:finance:card:add_gateway",
  gateway: (gsid: string): string => `admin:finance:card:g:${gsid}`,
  toggleGateway: (gsid: string): string => `admin:finance:card:toggle_gateway:${gsid}`,
  setMin: (gsid: string): string => `admin:finance:card:min:${gsid}`,
  setMax: (gsid: string): string => `admin:finance:card:max:${gsid}`,
  setInstruction: (gsid: string): string => `admin:finance:card:instr:${gsid}`,
  accounts: (gsid: string): string => `admin:finance:card:accounts:${gsid}`,
  addAccount: (gsid: string): string => `admin:finance:card:add_account:${gsid}`,
  toggleAccount: (asid: string): string => `admin:finance:card:account:toggle:${asid}`,
  toggleAccountYes: (asid: string): string => `admin:finance:card:account:toggle:${asid}:yes`,
  accountConfirm: "admin:finance:card:acc_confirm",
  accountCancel: "admin:finance:card:acc_cancel",
} as const;

export const FINANCE_LANDING_TEXT = "مالی 💎";

export function shortId(row: Pick<PaymentGateway, "id">): string {
  return row.id.slice(0, 8);
}

export function financeLandingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("روش‌های پرداخت 💳", FIN_CB.methods)
    .row()
    .text("رسیدهای تایید نشده 💵", CB.ADMIN_RECEIPTS)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
}

function limitLabel(value: number | null): string {
  return value === null ? "بدون محدودیت" : formatToman(value);
}

/** «روش‌های پرداخت 💳» summary - card-to-card status at a glance. */
export function paymentMethodsText(gateways: CardGatewayWithCounts[]): string {
  const lines = ["روش‌های پرداخت 💳", ""];
  if (gateways.length === 0) {
    lines.push("کارت‌به‌کارت: ساخته نشده ❌", "", "برای فعال‌سازی وارد بخش کارت‌به‌کارت شوید.");
    return lines.join("\n");
  }
  for (const g of gateways) {
    lines.push(
      `کارت‌به‌کارت${gateways.length > 1 ? ` (${escapeHtml(g.name)})` : ""}: ${
        g.isEnabled ? "روشن ✅" : "خاموش ⏸"
      }`,
      `کارت‌های فعال: ${g.activeCardCount} از ${g.totalCardCount}`,
      `حداقل مبلغ: ${limitLabel(g.minAmountToman)} | حداکثر مبلغ: ${limitLabel(g.maxAmountToman)}`,
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

export function paymentMethodsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("کارت‌به‌کارت 💳", FIN_CB.card)
    .row()
    .text("بازگشت", FIN_CB.root);
}

/** Shown when no CARD_TO_CARD gateway exists yet. */
export function noGatewayKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("ساخت روش کارت‌به‌کارت ✅", FIN_CB.addGateway)
    .row()
    .text("بازگشت", FIN_CB.methods);
}

export function gatewayListKeyboard(gateways: CardGatewayWithCounts[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of gateways) {
    kb.text(
      `${g.name} | ${g.isEnabled ? "روشن ✅" : "خاموش ⏸"} | ${g.activeCardCount} کارت فعال`,
      FIN_CB.gateway(shortId(g)),
    ).row();
  }
  kb.text("بازگشت", FIN_CB.methods);
  return kb;
}

/** One gateway's settings page. */
export function gatewayText(gateway: CardGatewayWithCounts): string {
  const lines = [
    "کارت‌به‌کارت 💳",
    "",
    `نام: ${escapeHtml(gateway.name)}`,
    `وضعیت: ${gateway.isEnabled ? "روشن ✅" : "خاموش ⏸"}`,
    `نمایش: ${gateway.isHidden ? "مخفی 🙈" : "قابل نمایش 👁"}`,
    `حداقل مبلغ: ${limitLabel(gateway.minAmountToman)}`,
    `حداکثر مبلغ: ${limitLabel(gateway.maxAmountToman)}`,
    `ترتیب نمایش: ${gateway.displayOrder}`,
    `کارت‌ها: ${gateway.activeCardCount} فعال از ${gateway.totalCardCount}`,
  ];
  if (gateway.instructionText !== null && gateway.instructionText !== "") {
    lines.push("", "متن راهنما:", escapeHtml(gateway.instructionText));
  }
  if (gateway.isEnabled && gateway.activeCardCount === 0) {
    lines.push("", "⚠️ بدون کارت فعال، این روش به کاربران نمایش داده نمی‌شود.");
  }
  return lines.join("\n");
}

export function gatewayKeyboard(gateway: CardGatewayWithCounts): InlineKeyboard {
  const gsid = shortId(gateway);
  return new InlineKeyboard()
    .text(
      gateway.isEnabled ? "خاموش کردن روش پرداخت ⏸" : "روشن کردن روش پرداخت ✅",
      FIN_CB.toggleGateway(gsid),
    )
    .row()
    .text("تنظیم حداقل مبلغ", FIN_CB.setMin(gsid))
    .text("تنظیم حداکثر مبلغ", FIN_CB.setMax(gsid))
    .row()
    .text("تنظیم متن راهنما", FIN_CB.setInstruction(gsid))
    .row()
    .text("مدیریت کارت‌ها 💳", FIN_CB.accounts(gsid))
    .row()
    .text("بازگشت", FIN_CB.methods);
}

/** Card list under one gateway - masked numbers only. */
export function accountsText(gateway: PaymentGateway, accounts: CardToCardAccount[]): string {
  const lines = [`مدیریت کارت‌ها 💳 (${escapeHtml(gateway.name)})`, ""];
  if (accounts.length === 0) {
    lines.push("کارتی ثبت نشده است.");
    return lines.join("\n");
  }
  const active = accounts.filter((a) => a.isActive).length;
  lines.push(`${accounts.length} کارت (${active} فعال):`);
  return lines.join("\n");
}

export function accountButtonLabel(account: CardToCardAccount, maskedNumber: string): string {
  return `${account.isActive ? "✅" : "⏸"} ${maskedNumber} | ${account.ownerName} | ${account.displayOrder}`;
}

export function accountsKeyboard(
  gatewaySid: string,
  accounts: Array<{ account: CardToCardAccount; maskedNumber: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const { account, maskedNumber } of accounts) {
    kb.text(
      accountButtonLabel(account, maskedNumber),
      FIN_CB.toggleAccount(account.id.slice(0, 8)),
    ).row();
  }
  kb.text("افزودن کارت جدید ➕", FIN_CB.addAccount(gatewaySid)).row();
  kb.text("بازگشت", FIN_CB.gateway(gatewaySid));
  return kb;
}

/** Last-active-card deactivation warning. */
export function lastCardWarningKeyboard(accountSid: string, gatewaySid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("بله، غیرفعال کن ⏸", FIN_CB.toggleAccountYes(accountSid))
    .row()
    .text("انصراف", FIN_CB.accounts(gatewaySid));
}

/** Add-card confirmation - the number appears MASKED only. */
export function addCardConfirmText(
  gateway: PaymentGateway,
  cardNumber: string,
  ownerName: string,
  displayOrder: number,
): string {
  return [
    "ثبت کارت جدید 💳",
    "",
    `روش پرداخت: ${escapeHtml(gateway.name)}`,
    `شماره کارت: <code>${maskCardNumber(cardNumber)}</code>`,
    `نام صاحب کارت: ${escapeHtml(ownerName)}`,
    `ترتیب نمایش: ${displayOrder}`,
    "",
    "آیا از ثبت این کارت مطمئن هستید؟",
  ].join("\n");
}

export function addCardConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید ثبت کارت ✅", FIN_CB.accountConfirm)
    .row()
    .text("انصراف", FIN_CB.accountCancel);
}
