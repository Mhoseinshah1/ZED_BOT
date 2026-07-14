import { decryptSecret, errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  countActiveCards,
  createCardAccount,
  createCardGatewayIfMissing,
  getCardAccountByShortId,
  getCardGatewayByShortId,
  INVALID_CARD_NUMBER_TEXT,
  INVALID_DISPLAY_ORDER_TEXT,
  INVALID_LIMIT_TEXT,
  INVALID_OWNER_NAME_TEXT,
  listCardAccounts,
  listCardGateways,
  maskCardNumber,
  normalizeCardNumber,
  normalizeOwnerName,
  parseDisplayOrder,
  parseLimitInput,
  setGatewayInstruction,
  setGatewayLimit,
  toggleCardAccount,
  toggleGatewayEnabled,
} from "../../services/admin-payment-method.service.js";
import {
  ensureProviderGateways,
  listManagedProviders,
  managedProviderMeta,
  setProviderEnabled,
  testProviderConnection,
  type ManagedProviderRow,
  type ProviderConnectionStatus,
} from "../../services/admin-payment-provider.service.js";
import {
  isWalletPaymentEnabled,
  isWalletTopupEnabled,
  paymentPageNotice,
  setPaymentPageNotice,
  setWalletPaymentEnabled,
  setWalletTopupEnabled,
  setWalletTopupInstruction,
  setWalletTopupMaxToman,
  setWalletTopupMinToman,
  walletTopupInstruction,
} from "../../services/payment-settings.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { walletTopupLimits } from "../../services/wallet-topup.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  accountsKeyboard,
  accountsText,
  addCardConfirmKeyboard,
  addCardConfirmText,
  FIN_CB,
  FINANCE_LANDING_TEXT,
  financeLandingKeyboard,
  gatewayKeyboard,
  gatewayListKeyboard,
  gatewayText,
  lastCardWarningKeyboard,
  noGatewayKeyboard,
  paymentSettingsKeyboard,
  paymentSettingsText,
  providerActionResultText,
  providerConfigText,
  providerDetailKeyboard,
  providerDetailText,
  providerListKeyboard,
  providerListText,
  providerSettingsBackKeyboard,
  providerToggleConfirmKeyboard,
  providerToggleConfirmText,
  shortId,
  type PaymentSettingsView,
  type ProviderButtonLabels,
} from "./admin-finance-views.js";

// =============================================================================
// «مالی 💎» (Phase 21) - real admin finance section: payment methods page,
// card-to-card gateway creation/settings and card account management. Pure
// configuration: NEVER creates Payment/Order/CheckoutSession rows; receipts
// stay in the existing admin:receipts flow. Card numbers are encrypted at
// rest, never logged and only ever rendered MASKED on the admin side.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };

const MIN_FLOW = "admin_payment:min_amount";
const MAX_FLOW = "admin_payment:max_amount";
const INSTRUCTION_FLOW = "admin_payment:instruction";
const CARD_NUMBER_FLOW = "admin_payment:card_number";
const OWNER_NAME_FLOW = "admin_payment:owner_name";
const DISPLAY_ORDER_FLOW = "admin_payment:display_order";
// Phase 22 global wallet/payment settings flows (no gateway draft needed).
const SETTINGS_MIN_TOPUP_FLOW = "admin_payment_settings:min_topup";
const SETTINGS_MAX_TOPUP_FLOW = "admin_payment_settings:max_topup";
const SETTINGS_TOPUP_INSTRUCTION_FLOW = "admin_payment_settings:topup_instruction";
const SETTINGS_PAYMENT_NOTICE_FLOW = "admin_payment_settings:payment_notice";
const SETTINGS_FLOWS = [
  SETTINGS_MIN_TOPUP_FLOW,
  SETTINGS_MAX_TOPUP_FLOW,
  SETTINGS_TOPUP_INSTRUCTION_FLOW,
  SETTINGS_PAYMENT_NOTICE_FLOW,
];
const ALL_FLOWS = [
  MIN_FLOW,
  MAX_FLOW,
  INSTRUCTION_FLOW,
  CARD_NUMBER_FLOW,
  OWNER_NAME_FLOW,
  DISPLAY_ORDER_FLOW,
  ...SETTINGS_FLOWS,
];

export const adminFinanceHandler = new Composer<BotContext>();

/** Full Phase 21 state cleanup - called on landing/methods/menu/cancel. */
export function clearAdminPaymentState(ctx: BotContext): void {
  if (ctx.session.currentFlow !== null && ALL_FLOWS.includes(ctx.session.currentFlow)) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminPaymentDraft;
}

/** Masked card number; decryption failures render as "****" and log SAFELY. */
function maskedNumberFor(account: { id: string; cardNumberEncrypted: string }): string {
  try {
    return maskCardNumber(decryptSecret(account.cardNumberEncrypted));
  } catch (err) {
    logger.warn("card number decryption failed (admin list)", {
      accountId: account.id,
      error: errorMessage(err),
    });
    return "****";
  }
}

async function renderGatewayPage(ctx: BotContext, gatewaySid: string): Promise<void> {
  const gateway = await getCardGatewayByShortId(gatewaySid);
  if (gateway === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, gatewayText(gateway), gatewayKeyboard(gateway), HTML);
}

async function renderAccountsPage(ctx: BotContext, gatewaySid: string): Promise<void> {
  const gateway = await getCardGatewayByShortId(gatewaySid);
  if (gateway === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const accounts = await listCardAccounts(gateway.id);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    accountsText(gateway, accounts),
    accountsKeyboard(gatewaySid, accounts.map((account) => ({ account, maskedNumber: maskedNumberFor(account) }))),
    HTML,
  );
}

adminFinanceHandler.callbackQuery(FIN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, FINANCE_LANDING_TEXT, financeLandingKeyboard());
  ctx.session.lastMenu = FIN_CB.root;
});

// --- payment/wallet settings (Phase 22) -----------------------------------------------

async function loadSettingsView(): Promise<PaymentSettingsView> {
  const [topupEnabled, walletPaymentEnabled, limits, topupInstruction, paymentNotice] =
    await Promise.all([
      isWalletTopupEnabled(),
      isWalletPaymentEnabled(),
      walletTopupLimits(),
      walletTopupInstruction(),
      paymentPageNotice(),
    ]);
  return {
    topupEnabled,
    walletPaymentEnabled,
    minTopupToman: limits.minToman,
    maxTopupToman: limits.maxToman,
    topupInstruction,
    paymentNotice,
  };
}

async function renderSettingsPage(ctx: BotContext): Promise<void> {
  const view = await loadSettingsView();
  await safeEditOrReply(ctx, paymentSettingsText(view), paymentSettingsKeyboard(view), HTML);
}

adminFinanceHandler.callbackQuery(FIN_CB.settings, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await safeAnswerCallback(ctx);
  await renderSettingsPage(ctx);
});

adminFinanceHandler.callbackQuery(FIN_CB.settingsToggleTopup, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const enabled = !(await isWalletTopupEnabled());
  await setWalletTopupEnabled(enabled);
  await safeAnswerCallback(ctx, enabled ? "شارژ کیف پول روشن شد ✅" : "شارژ کیف پول خاموش شد ⏸");
  await renderSettingsPage(ctx);
});

adminFinanceHandler.callbackQuery(FIN_CB.settingsToggleWalletPayment, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const enabled = !(await isWalletPaymentEnabled());
  await setWalletPaymentEnabled(enabled);
  await safeAnswerCallback(
    ctx,
    enabled ? "پرداخت با کیف پول روشن شد ✅" : "پرداخت با کیف پول خاموش شد ⏸",
  );
  await renderSettingsPage(ctx);
});

function startSettingsFlow(flow: string, prompt: string) {
  return async (ctx: BotContext): Promise<void> => {
    if (ctx.admin === null) {
      return;
    }
    clearAdminPaymentState(ctx);
    ctx.session.currentFlow = flow;
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, prompt, new InlineKeyboard().text("انصراف", FIN_CB.settings));
  };
}

adminFinanceHandler.callbackQuery(
  FIN_CB.settingsMinTopup,
  startSettingsFlow(
    SETTINGS_MIN_TOPUP_FLOW,
    "حداقل شارژ کیف پول را به تومان وارد کنید. (0 = بازگشت به پیش‌فرض)",
  ),
);

adminFinanceHandler.callbackQuery(
  FIN_CB.settingsMaxTopup,
  startSettingsFlow(
    SETTINGS_MAX_TOPUP_FLOW,
    "حداکثر شارژ کیف پول را به تومان وارد کنید. (0 = بازگشت به پیش‌فرض)",
  ),
);

adminFinanceHandler.callbackQuery(
  FIN_CB.settingsTopupInstruction,
  startSettingsFlow(
    SETTINGS_TOPUP_INSTRUCTION_FLOW,
    "متن راهنمای شارژ کیف پول را وارد کنید. (برای حذف، «-» بفرستید)",
  ),
);

adminFinanceHandler.callbackQuery(
  FIN_CB.settingsPaymentNotice,
  startSettingsFlow(
    SETTINGS_PAYMENT_NOTICE_FLOW,
    "پیام صفحه روش پرداخت را وارد کنید. (برای حذف، «-» بفرستید)",
  ),
);

// --- payment provider management (provider-navigation phase) ---------------------------
//
// Navigation: «روش‌های پرداخت» list (FIN_CB.methods) -> payprov:view:<KEY>
// detail page -> toggle/settings/test actions. Every action re-renders the
// DETAIL page so the admin always sees the fresh state. The pre-refactor
// admin:fin:pm:{t,s,c} callbacks stay registered as aliases of the same
// handlers - stale buttons on old messages keep answering.

const TESTING_CONNECTION_TEXT = "در حال تست اتصال…";

async function providerButtonLabels(): Promise<ProviderButtonLabels> {
  const [enable, disable, settings, settingsWallet, settingsCard, test, backProviders] =
    await Promise.all([
      getButtonText("pm_enable"),
      getButtonText("pm_disable"),
      getButtonText("pm_settings"),
      getButtonText("pm_settings_wallet"),
      getButtonText("pm_settings_card"),
      getButtonText("pm_test"),
      getButtonText("pm_back_providers"),
    ]);
  return { enable, disable, settings, settingsWallet, settingsCard, test, backProviders };
}

async function findManagedProvider(providerKey: string): Promise<ManagedProviderRow | null> {
  const rows = await listManagedProviders();
  return rows.find((row) => row.providerKey === providerKey) ?? null;
}

/** «مدیریت روش‌های پرداخت 💳» - the compact provider LIST page. */
async function renderProviderList(ctx: BotContext): Promise<void> {
  const [rows, header, pickText] = await Promise.all([
    listManagedProviders(),
    getMessageTemplate("payment_methods_admin_header"),
    getMessageTemplate("payment_provider_pick_text"),
  ]);
  await safeEditOrReply(ctx, providerListText(header, pickText), providerListKeyboard(rows), HTML);
}

/** One provider's DETAIL page, freshly loaded (optional result line on top). */
async function renderProviderDetail(
  ctx: BotContext,
  providerKey: string,
  resultText?: string,
): Promise<void> {
  const [row, buttons] = await Promise.all([
    findManagedProvider(providerKey),
    providerButtonLabels(),
  ]);
  if (row === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const text =
    resultText === undefined ? providerDetailText(row) : providerActionResultText(resultText, row);
  await safeEditOrReply(ctx, text, providerDetailKeyboard(row, buttons), HTML);
}

adminFinanceHandler.callbackQuery(FIN_CB.methods, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  // Bootstrap missing gateway rows (online providers start DISABLED).
  await ensureProviderGateways();
  await safeAnswerCallback(ctx);
  await renderProviderList(ctx);
});

adminFinanceHandler.callbackQuery(/^payprov:view:([A-Z_]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await safeAnswerCallback(ctx);
  await renderProviderDetail(ctx, ctx.match[1]);
});

// Enable/disable: confirmation page first (the confirm callback carries the
// intended direction, so a stale button can never flip the wrong way).
async function handleProviderToggleAsk(ctx: BotContext, providerKey: string): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const row = await findManagedProvider(providerKey);
  if (row === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const enable = !row.enabled;
  const question = await getMessageTemplate(
    enable ? "payment_provider_enable_confirm" : "payment_provider_disable_confirm",
  );
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    providerToggleConfirmText(question, row),
    providerToggleConfirmKeyboard(row.providerKey, enable),
    HTML,
  );
}

async function handleProviderToggleConfirm(
  ctx: BotContext,
  providerKey: string,
  enable: boolean,
): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const result = await setProviderEnabled(providerKey, enable, ctx.admin.id);
  if (!result.ok) {
    if (result.reason === "incomplete_config") {
      // Config re-checked at action time came back incomplete - explain and
      // land back on the detail page (which shows what is missing).
      const incompleteText = await getMessageTemplate("payment_provider_config_incomplete_text");
      await safeAnswerCallback(ctx, incompleteText);
      await renderProviderDetail(ctx, providerKey, incompleteText);
      return;
    }
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const resultText = await getMessageTemplate(
    result.changed
      ? enable
        ? "payment_provider_enabled_text"
        : "payment_provider_disabled_text"
      : enable
        ? "payment_provider_already_enabled_text"
        : "payment_provider_already_disabled_text",
  );
  await safeAnswerCallback(ctx, resultText);
  await renderProviderDetail(ctx, providerKey, resultText);
}

adminFinanceHandler.callbackQuery(/^payprov:toggle:([A-Z_]+)$/, async (ctx) => {
  await handleProviderToggleAsk(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^admin:fin:pm:t:([A-Z_]+)$/, async (ctx) => {
  await handleProviderToggleAsk(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^payprov:toggle:([A-Z_]+):(on|off)$/, async (ctx) => {
  await handleProviderToggleConfirm(ctx, ctx.match[1], ctx.match[2] === "on");
});

adminFinanceHandler.callbackQuery(/^admin:fin:pm:t:([A-Z_]+):(on|off)$/, async (ctx) => {
  await handleProviderToggleConfirm(ctx, ctx.match[1], ctx.match[2] === "on");
});

// «تنظیمات»: routes to the provider's EXISTING settings flow - CARD_TO_CARD
// -> the card-management pages, WALLET -> the wallet/payment settings page,
// online providers -> their read-only env-config status page. No generic
// settings form exists.
async function handleProviderSettings(ctx: BotContext, providerKey: string): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const meta = managedProviderMeta(providerKey);
  if (meta === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (meta.key === "CARD_TO_CARD") {
    await renderCardManagementEntry(ctx);
    return;
  }
  if (meta.key === "WALLET") {
    await safeAnswerCallback(ctx);
    await renderSettingsPage(ctx);
    return;
  }
  const [row, buttons] = await Promise.all([findManagedProvider(meta.key), providerButtonLabels()]);
  if (row === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    providerConfigText(row),
    providerSettingsBackKeyboard(meta.key, buttons),
    HTML,
  );
}

adminFinanceHandler.callbackQuery(/^payprov:settings:([A-Z_]+)$/, async (ctx) => {
  await handleProviderSettings(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^admin:fin:pm:s:([A-Z_]+)$/, async (ctx) => {
  await handleProviderSettings(ctx, ctx.match[1]);
});

// «تست اتصال» (ZARINPAL/NOWPAYMENTS only): popup first, then the refreshed
// detail page with the result line. Result texts are templates - raw
// provider errors never reach the admin.
const TEST_RESULT_TEMPLATE: Record<Exclude<ProviderConnectionStatus, "UNSUPPORTED">, string> = {
  OK: "payment_provider_test_ok_text",
  FAILED: "payment_provider_test_failed_text",
  INCOMPLETE: "payment_provider_test_incomplete_text",
};

async function handleProviderTest(ctx: BotContext, providerKey: string): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const meta = managedProviderMeta(providerKey);
  if (meta === null || !meta.supportsConnectionTest) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, TESTING_CONNECTION_TEXT);
  const { status } = await testProviderConnection(meta.key);
  const resultText = await getMessageTemplate(
    TEST_RESULT_TEMPLATE[status === "UNSUPPORTED" ? "FAILED" : status],
  );
  await renderProviderDetail(ctx, meta.key, resultText);
}

adminFinanceHandler.callbackQuery(/^payprov:test:([A-Z_]+)$/, async (ctx) => {
  await handleProviderTest(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^admin:fin:pm:c:([A-Z_]+)$/, async (ctx) => {
  await handleProviderTest(ctx, ctx.match[1]);
});

// Card-to-card entry: none -> create prompt, one -> its page, many -> list.
// Reached from «تنظیمات» on the CARD_TO_CARD provider row AND from the old
// admin:finance:card route (stale buttons keep answering).
async function renderCardManagementEntry(ctx: BotContext): Promise<void> {
  const gateways = await listCardGateways();
  if (gateways.length === 0) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      "کارت‌به‌کارت 💳\n\nهنوز روش کارت‌به‌کارت ساخته نشده است.",
      noGatewayKeyboard(),
    );
    return;
  }
  if (gateways.length === 1) {
    await renderGatewayPage(ctx, shortId(gateways[0]));
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "کارت‌به‌کارت 💳\n\nیک مورد را انتخاب کنید:", gatewayListKeyboard(gateways));
}

adminFinanceHandler.callbackQuery(FIN_CB.card, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await renderCardManagementEntry(ctx);
});

adminFinanceHandler.callbackQuery(FIN_CB.addGateway, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const { created, gateway } = await createCardGatewayIfMissing();
  await safeAnswerCallback(ctx, created ? "روش کارت‌به‌کارت ساخته شد ✅" : "از قبل موجود است.");
  await renderGatewayPage(ctx, shortId(gateway));
});

adminFinanceHandler.callbackQuery(/^admin:finance:card:g:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await renderGatewayPage(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^admin:finance:card:toggle_gateway:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  const gateway = await getCardGatewayByShortId(ctx.match[1]);
  if (gateway === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const updated = await toggleGatewayEnabled(gateway.id);
  await safeAnswerCallback(ctx, updated?.isEnabled === true ? "روشن شد ✅" : "خاموش شد ⏸");
  await renderGatewayPage(ctx, ctx.match[1]);
});

// --- gateway setting flows (min / max / instruction) ---------------------------------

async function startGatewayFieldFlow(
  ctx: BotContext,
  gatewaySid: string,
  flow: string,
  prompt: string,
): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const gateway = await getCardGatewayByShortId(gatewaySid);
  if (gateway === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminPaymentDraft = { gatewayId: gateway.id };
  ctx.session.currentFlow = flow;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    prompt,
    new InlineKeyboard().text("انصراف", FIN_CB.gateway(gatewaySid)),
  );
}

adminFinanceHandler.callbackQuery(/^admin:finance:card:min:([0-9a-f-]+)$/, async (ctx) => {
  await startGatewayFieldFlow(
    ctx,
    ctx.match[1],
    MIN_FLOW,
    "حداقل مبلغ را به تومان وارد کنید. (0 = بدون محدودیت)",
  );
});

adminFinanceHandler.callbackQuery(/^admin:finance:card:max:([0-9a-f-]+)$/, async (ctx) => {
  await startGatewayFieldFlow(
    ctx,
    ctx.match[1],
    MAX_FLOW,
    "حداکثر مبلغ را به تومان وارد کنید. (0 = بدون محدودیت)",
  );
});

adminFinanceHandler.callbackQuery(/^admin:finance:card:instr:([0-9a-f-]+)$/, async (ctx) => {
  await startGatewayFieldFlow(
    ctx,
    ctx.match[1],
    INSTRUCTION_FLOW,
    "متن راهنمای پرداخت را وارد کنید. (برای حذف متن فعلی، «-» بفرستید)",
  );
});

// --- card accounts -------------------------------------------------------------------

adminFinanceHandler.callbackQuery(/^admin:finance:card:accounts:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminPaymentState(ctx);
  await renderAccountsPage(ctx, ctx.match[1]);
});

adminFinanceHandler.callbackQuery(/^admin:finance:card:add_account:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const gateway = await getCardGatewayByShortId(ctx.match[1]);
  if (gateway === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminPaymentDraft = { gatewayId: gateway.id };
  ctx.session.currentFlow = CARD_NUMBER_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "شماره کارت ۱۶ رقمی را وارد کنید.",
    new InlineKeyboard().text("انصراف", FIN_CB.accounts(ctx.match[1])),
  );
});

async function toggleAccountAndRender(ctx: BotContext, accountSid: string): Promise<void> {
  const account = await getCardAccountByShortId(accountSid);
  if (account === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const updated = await toggleCardAccount(account.id);
  await safeAnswerCallback(ctx, updated?.isActive === true ? "کارت فعال شد ✅" : "کارت غیرفعال شد ⏸");
  await renderAccountsPage(ctx, shortId(account.gateway));
}

adminFinanceHandler.callbackQuery(
  /^admin:finance:card:account:toggle:([0-9a-f-]+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    clearAdminPaymentState(ctx);
    const account = await getCardAccountByShortId(ctx.match[1]);
    if (account === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    // Deactivating the LAST active card hides card-to-card from users -
    // require an explicit confirmation for that case.
    if (account.isActive && (await countActiveCards(account.gatewayId)) === 1) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(
        ctx,
        "با غیرفعال کردن این کارت، ممکن است کارت‌به‌کارت برای کاربران نمایش داده نشود.\n\nادامه می‌دهید؟",
        lastCardWarningKeyboard(ctx.match[1], shortId(account.gateway)),
      );
      return;
    }
    await toggleAccountAndRender(ctx, ctx.match[1]);
  },
);

adminFinanceHandler.callbackQuery(
  /^admin:finance:card:account:toggle:([0-9a-f-]+):yes$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    clearAdminPaymentState(ctx);
    await toggleAccountAndRender(ctx, ctx.match[1]);
  },
);

adminFinanceHandler.callbackQuery(FIN_CB.accountCancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const gatewayId = ctx.session.temp.adminPaymentDraft?.gatewayId;
  clearAdminPaymentState(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  if (gatewayId !== undefined) {
    await renderAccountsPage(ctx, gatewayId.slice(0, 8));
    return;
  }
  await safeEditOrReply(ctx, FINANCE_LANDING_TEXT, financeLandingKeyboard());
});

adminFinanceHandler.callbackQuery(FIN_CB.accountConfirm, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminPaymentDraft;
  // Consume the draft BEFORE creating - a double click cannot store twice.
  clearAdminPaymentState(ctx);
  if (
    draft === undefined ||
    draft.cardNumber === undefined ||
    draft.ownerName === undefined ||
    draft.displayOrder === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    await safeEditOrReply(ctx, FINANCE_LANDING_TEXT, financeLandingKeyboard());
    return;
  }
  const outcome = await createCardAccount({
    gatewayId: draft.gatewayId,
    cardNumber: draft.cardNumber,
    ownerName: draft.ownerName,
    displayOrder: draft.displayOrder,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    await renderAccountsPage(ctx, draft.gatewayId.slice(0, 8));
    return;
  }
  await safeAnswerCallback(ctx, "کارت با موفقیت ثبت شد ✅");
  await renderAccountsPage(ctx, draft.gatewayId.slice(0, 8));
});

// --- text inputs ----------------------------------------------------------------------

export const adminFinanceTextHandler = new Composer<BotContext>();

adminFinanceTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (ctx.admin === null || flow === null || !ALL_FLOWS.includes(flow)) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearAdminPaymentState(ctx);
    return next();
  }

  // Phase 22 global settings flows - no gateway draft involved.
  if (SETTINGS_FLOWS.includes(flow)) {
    const settingsCancelKb = new InlineKeyboard().text("انصراف", FIN_CB.settings);
    if (flow === SETTINGS_MIN_TOPUP_FLOW || flow === SETTINGS_MAX_TOPUP_FLOW) {
      const parsed = parseLimitInput(text);
      if (!parsed.ok) {
        await safeReply(ctx, INVALID_LIMIT_TEXT, settingsCancelKb);
        return;
      }
      // parseLimitInput maps "0" to null = reset to the built-in default.
      const value = parsed.value ?? 0;
      const result =
        flow === SETTINGS_MIN_TOPUP_FLOW
          ? await setWalletTopupMinToman(value)
          : await setWalletTopupMaxToman(value);
      if (!result.ok) {
        await safeReply(ctx, result.safeMessage, settingsCancelKb);
        return;
      }
    } else {
      const cleared = text.trim() === "-" || text.trim() === "حذف";
      const result =
        flow === SETTINGS_TOPUP_INSTRUCTION_FLOW
          ? await setWalletTopupInstruction(cleared ? null : text)
          : await setPaymentPageNotice(cleared ? null : text);
      if (!result.ok) {
        await safeReply(ctx, result.safeMessage, settingsCancelKb);
        return;
      }
    }
    clearAdminPaymentState(ctx);
    const view = await loadSettingsView();
    await safeReply(
      ctx,
      `ثبت شد ✅\n\n${paymentSettingsText(view)}`,
      paymentSettingsKeyboard(view),
      HTML,
    );
    return;
  }

  const draft = ctx.session.temp.adminPaymentDraft;
  if (draft === undefined) {
    clearAdminPaymentState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, financeLandingKeyboard());
    return;
  }
  const gatewaySid = draft.gatewayId.slice(0, 8);
  const cancelKb = new InlineKeyboard().text("انصراف", FIN_CB.gateway(gatewaySid));

  if (flow === MIN_FLOW || flow === MAX_FLOW) {
    const parsed = parseLimitInput(text);
    if (!parsed.ok) {
      await safeReply(ctx, INVALID_LIMIT_TEXT, cancelKb);
      return;
    }
    const result = await setGatewayLimit(
      draft.gatewayId,
      flow === MIN_FLOW ? "minAmountToman" : "maxAmountToman",
      parsed.value,
    );
    if (!result.ok) {
      await safeReply(ctx, result.safeMessage, cancelKb);
      return;
    }
    clearAdminPaymentState(ctx);
    const gateway = await getCardGatewayByShortId(gatewaySid);
    if (gateway !== null) {
      await safeReply(ctx, `ثبت شد ✅\n\n${gatewayText(gateway)}`, gatewayKeyboard(gateway), HTML);
    }
    return;
  }

  if (flow === INSTRUCTION_FLOW) {
    const cleared = text.trim() === "-" || text.trim() === "حذف";
    const result = await setGatewayInstruction(draft.gatewayId, cleared ? null : text);
    if (!result.ok) {
      await safeReply(ctx, result.safeMessage, cancelKb);
      return;
    }
    clearAdminPaymentState(ctx);
    const gateway = await getCardGatewayByShortId(gatewaySid);
    if (gateway !== null) {
      await safeReply(ctx, `ثبت شد ✅\n\n${gatewayText(gateway)}`, gatewayKeyboard(gateway), HTML);
    }
    return;
  }

  const wizardCancelKb = new InlineKeyboard().text("انصراف", FIN_CB.accountCancel);

  if (flow === CARD_NUMBER_FLOW) {
    const cardNumber = normalizeCardNumber(text);
    if (cardNumber === null) {
      await safeReply(ctx, INVALID_CARD_NUMBER_TEXT, wizardCancelKb);
      return;
    }
    draft.cardNumber = cardNumber;
    ctx.session.currentFlow = OWNER_NAME_FLOW;
    await safeReply(ctx, "نام صاحب کارت را وارد کنید.", wizardCancelKb);
    return;
  }

  if (flow === OWNER_NAME_FLOW) {
    const ownerName = normalizeOwnerName(text);
    if (ownerName === null) {
      await safeReply(ctx, INVALID_OWNER_NAME_TEXT, wizardCancelKb);
      return;
    }
    draft.ownerName = ownerName;
    ctx.session.currentFlow = DISPLAY_ORDER_FLOW;
    await safeReply(ctx, "ترتیب نمایش را وارد کنید. (0 تا 9999؛ پیش‌فرض 0)", wizardCancelKb);
    return;
  }

  // DISPLAY_ORDER_FLOW
  const displayOrder = parseDisplayOrder(text);
  if (displayOrder === null) {
    await safeReply(ctx, INVALID_DISPLAY_ORDER_TEXT, wizardCancelKb);
    return;
  }
  draft.displayOrder = displayOrder;
  ctx.session.currentFlow = null;
  const gateway = await getCardGatewayByShortId(gatewaySid);
  if (gateway === null || draft.cardNumber === undefined || draft.ownerName === undefined) {
    clearAdminPaymentState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, financeLandingKeyboard());
    return;
  }
  await safeReply(
    ctx,
    addCardConfirmText(gateway, draft.cardNumber, draft.ownerName, displayOrder),
    addCardConfirmKeyboard(),
    HTML,
  );
});
