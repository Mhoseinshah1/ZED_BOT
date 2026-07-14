import type { CardToCardAccount, PaymentGateway } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import {
  maskCardNumber,
  type CardGatewayWithCounts,
} from "../../services/admin-payment-method.service.js";
import type { ManagedProviderRow } from "../../services/admin-payment-provider.service.js";
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
  settings: "admin:finance:settings",
  settingsToggleTopup: "admin:finance:settings:toggle_topup",
  settingsToggleWalletPayment: "admin:finance:settings:toggle_wallet_payment",
  settingsMinTopup: "admin:finance:settings:min_topup",
  settingsMaxTopup: "admin:finance:settings:max_topup",
  settingsTopupInstruction: "admin:finance:settings:topup_instruction",
  settingsPaymentNotice: "admin:finance:settings:payment_notice",
} as const;

/**
 * Payment provider navigation callbacks. <key> is ALWAYS the stable provider
 * enum key (CARD_TO_CARD/WALLET/ZARINPAL/NOWPAYMENTS/TELEGRAM_STARS), never
 * a display name - renaming a provider can never break these. The longest
 * emitted value (payprov:toggle:TELEGRAM_STARS:off, 33 bytes) stays far
 * under Telegram's 64-byte callback-data limit. The pre-refactor
 * admin:fin:pm:{t,s,c}:<key> routes stay registered in the handler so stale
 * buttons keep answering, but are never emitted anymore.
 */
export const PROV_CB = {
  view: (key: string): string => `payprov:view:${key}`,
  toggle: (key: string): string => `payprov:toggle:${key}`,
  toggleConfirm: (key: string, enable: boolean): string =>
    `payprov:toggle:${key}:${enable ? "on" : "off"}`,
  settings: (key: string): string => `payprov:settings:${key}`,
  test: (key: string): string => `payprov:test:${key}`,
} as const;

export const FINANCE_LANDING_TEXT = "مالی 💎";

export function shortId(row: Pick<PaymentGateway, "id">): string {
  return row.id.slice(0, 8);
}

/**
 * Corrective Fix A layout: receipts review lives here (no longer on the
 * admin root); «مدیریت کیف پول کاربران 👤» reuses the existing user-search
 * entry (CB.ADMIN_USERS) - user wallet adjustments already live on the
 * admin user page, so no duplicate wallet-management surface is built.
 */
export function financeLandingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("رسیدهای تاییدنشده 💵", CB.ADMIN_RECEIPTS)
    .row()
    .text("روش‌های پرداخت 💳", FIN_CB.methods)
    .text("تنظیمات کیف پول و پرداخت 🏦", FIN_CB.settings)
    .row()
    .text("مدیریت کیف پول کاربران 👤", CB.ADMIN_USERS)
    // Phase 31: read-only financial reports.
    .text("گزارش مالی 📊", "admin:fin:reports")
    .row()
    // Gateway phase: read-only payment browser (all statuses/providers).
    .text("لیست پرداخت‌ها 💳", "admin:fin:pay:all:1")
    .row()
    .text("بازگشت به پنل ادمین", CB.ADMIN_MENU);
}

// --- payment/wallet settings (Phase 22) --------------------------------------------

export interface PaymentSettingsView {
  topupEnabled: boolean;
  walletPaymentEnabled: boolean;
  minTopupToman: number;
  maxTopupToman: number;
  topupInstruction: string | null;
  paymentNotice: string | null;
}

function onOff(enabled: boolean): string {
  return enabled ? "روشن ✅" : "خاموش ⏸";
}

function textPreview(text: string | null): string {
  if (text === null) {
    return "تنظیم نشده —";
  }
  const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return `تنظیم شده ✅ («${escapeHtml(short)}»)`;
}

export function paymentSettingsText(view: PaymentSettingsView): string {
  return [
    "تنظیمات پرداخت و کیف پول ⚙️",
    "",
    `شارژ کیف پول: ${onOff(view.topupEnabled)}`,
    `پرداخت با کیف پول: ${onOff(view.walletPaymentEnabled)}`,
    `حداقل شارژ کیف پول: ${formatToman(view.minTopupToman)}`,
    `حداکثر شارژ کیف پول: ${formatToman(view.maxTopupToman)}`,
    `متن راهنمای شارژ کیف پول: ${textPreview(view.topupInstruction)}`,
    `پیام صفحه روش پرداخت: ${textPreview(view.paymentNotice)}`,
  ].join("\n");
}

export function paymentSettingsKeyboard(view: PaymentSettingsView): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      view.topupEnabled ? "خاموش کردن شارژ کیف پول ⏸" : "روشن کردن شارژ کیف پول ✅",
      FIN_CB.settingsToggleTopup,
    )
    .row()
    .text(
      view.walletPaymentEnabled
        ? "خاموش کردن پرداخت با کیف پول ⏸"
        : "روشن کردن پرداخت با کیف پول ✅",
      FIN_CB.settingsToggleWalletPayment,
    )
    .row()
    .text("تنظیم حداقل شارژ", FIN_CB.settingsMinTopup)
    .text("تنظیم حداکثر شارژ", FIN_CB.settingsMaxTopup)
    .row()
    .text("تنظیم متن راهنمای شارژ", FIN_CB.settingsTopupInstruction)
    .row()
    .text("تنظیم پیام صفحه پرداخت", FIN_CB.settingsPaymentNotice)
    .row()
    .text("بازگشت", FIN_CB.root);
}

function limitLabel(value: number | null): string {
  return value === null ? "بدون محدودیت" : formatToman(value);
}

// --- payment provider management (provider-navigation phase) -------------------------

/** Single render site - the Persian status words stay view constants. */
const PROVIDER_ENABLED_LABEL = "فعال ✅";
const PROVIDER_DISABLED_LABEL = "غیرفعال ❌";
const PROVIDER_READY_LABEL = "آماده ✅";
const PROVIDER_NOT_READY_LABEL = "ناقص ❌";
const PROVIDER_NEVER_TESTED_LABEL = "بررسی نشده";
export const BACK_TO_FINANCE_LABEL = "بازگشت به مالی";
export const PROVIDER_ENV_NOTE =
  "مقادیر از متغیرهای محیطی سرور خوانده می‌شوند و از این بخش قابل ویرایش نیستند.";

/** ButtonText-backed labels for the provider pages (pm_* keys). */
export interface ProviderButtonLabels {
  enable: string;
  disable: string;
  settings: string;
  settingsWallet: string;
  settingsCard: string;
  test: string;
  backProviders: string;
}

function formatCheckDate(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function providerStatusLabel(enabled: boolean): string {
  return enabled ? PROVIDER_ENABLED_LABEL : PROVIDER_DISABLED_LABEL;
}

/** Compact list page: template header + template pick line - nothing else. */
export function providerListText(header: string, pickText: string): string {
  return `${escapeHtml(header)}\n\n${escapeHtml(pickText)}`;
}

/** List-button label: emoji + display name + LIVE status. Label only - the
 * callback data is always PROV_CB.view(stable key). */
export function providerListButtonLabel(row: ManagedProviderRow): string {
  return `${row.listEmoji} ${row.displayName} — ${providerStatusLabel(row.enabled)}`;
}

/**
 * ONE button per provider (no per-provider action buttons on the list) plus
 * the back-to-finance row. Callback data carries the STABLE provider key.
 */
export function providerListKeyboard(rows: ManagedProviderRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(providerListButtonLabel(row), PROV_CB.view(row.providerKey)).row();
  }
  kb.text(BACK_TO_FINANCE_LABEL, FIN_CB.root);
  return kb;
}

/** Detail-page header lines shared with the confirmation page. */
function providerHeadingLines(row: ManagedProviderRow): string[] {
  return [
    `${row.listEmoji} ${escapeHtml(row.displayName)}`,
    "",
    `وضعیت: ${providerStatusLabel(row.enabled)}`,
    `نوع: ${escapeHtml(row.kindLabel)}`,
    `آمادگی استفاده: ${row.configured ? PROVIDER_READY_LABEL : PROVIDER_NOT_READY_LABEL}`,
  ];
}

/**
 * Dedicated provider detail page: heading + presence-only config lines (the
 * service never puts secret values in them) + the last connection test for
 * testable providers («بررسی نشده» before the first run). Every field always
 * has a value - no empty lines.
 */
export function providerDetailText(row: ManagedProviderRow): string {
  const lines = providerHeadingLines(row);
  if (row.configLines.length > 0) {
    lines.push("", ...row.configLines.map((line) => escapeHtml(line)));
  }
  if (row.supportsConnectionTest) {
    lines.push(
      "",
      row.lastCheckedAt === null
        ? `آخرین تست اتصال: ${PROVIDER_NEVER_TESTED_LABEL}`
        : `آخرین تست اتصال: ${row.healthStatus === "OK" ? "موفق ✅" : "ناموفق ❌"} (${formatCheckDate(row.lastCheckedAt)})`,
    );
  }
  return lines.join("\n");
}

/** Provider-specific «تنظیمات» label (wallet/card have their own flows). */
function providerSettingsLabel(row: ManagedProviderRow, buttons: ProviderButtonLabels): string {
  if (row.providerKey === "WALLET") {
    return buttons.settingsWallet;
  }
  if (row.providerKey === "CARD_TO_CARD") {
    return buttons.settingsCard;
  }
  return buttons.settings;
}

/**
 * Detail-page actions: ONE toggle matching the current state, the
 * provider-specific settings entry, the connection test only where a
 * meaningful test exists, and always the back-to-list row.
 */
export function providerDetailKeyboard(
  row: ManagedProviderRow,
  buttons: ProviderButtonLabels,
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(row.enabled ? buttons.disable : buttons.enable, PROV_CB.toggle(row.providerKey))
    .row()
    .text(providerSettingsLabel(row, buttons), PROV_CB.settings(row.providerKey))
    .row();
  if (row.supportsConnectionTest) {
    kb.text(buttons.test, PROV_CB.test(row.providerKey)).row();
  }
  kb.text(buttons.backProviders, FIN_CB.methods);
  return kb;
}

/** Enable/disable confirmation page: the provider heading + the question. */
export function providerToggleConfirmText(question: string, row: ManagedProviderRow): string {
  return [...providerHeadingLines(row), "", escapeHtml(question)].join("\n");
}

/** «انصراف» returns to the provider's detail page, never to a dead end. */
export function providerToggleConfirmKeyboard(
  providerKey: string,
  enable: boolean,
): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید", PROV_CB.toggleConfirm(providerKey, enable))
    .text("انصراف", PROV_CB.view(providerKey))
    .row()
    .text(BACK_TO_FINANCE_LABEL, FIN_CB.root);
}

/**
 * Read-only config-status page for env-configured providers: PRESENCE-ONLY
 * lines (built by the service - never secret values) + the env note.
 */
export function providerConfigText(row: ManagedProviderRow): string {
  return [
    ...providerHeadingLines(row),
    "",
    ...row.configLines.map((line) => escapeHtml(line)),
    "",
    PROVIDER_ENV_NOTE,
  ].join("\n");
}

/** Back keyboard for provider sub-pages: to the detail page + to the list. */
export function providerSettingsBackKeyboard(
  providerKey: string,
  buttons: ProviderButtonLabels,
): InlineKeyboard {
  return new InlineKeyboard()
    .text("بازگشت", PROV_CB.view(providerKey))
    .row()
    .text(buttons.backProviders, FIN_CB.methods);
}

/** Action-result page: result line on top of the refreshed detail page. */
export function providerActionResultText(resultText: string, row: ManagedProviderRow): string {
  return `${escapeHtml(resultText)}\n\n${providerDetailText(row)}`;
}

/** Shown when no CARD_TO_CARD gateway exists yet. */
export function noGatewayKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("ساخت روش کارت‌به‌کارت ✅", FIN_CB.addGateway)
    .row()
    .text("بازگشت", PROV_CB.view("CARD_TO_CARD"));
}

export function gatewayListKeyboard(gateways: CardGatewayWithCounts[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of gateways) {
    kb.text(
      `${g.name} | ${g.isEnabled ? "روشن ✅" : "خاموش ⏸"} | ${g.activeCardCount} کارت فعال`,
      FIN_CB.gateway(shortId(g)),
    ).row();
  }
  kb.text("بازگشت", PROV_CB.view("CARD_TO_CARD"));
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
    .text("بازگشت", PROV_CB.view("CARD_TO_CARD"));
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
