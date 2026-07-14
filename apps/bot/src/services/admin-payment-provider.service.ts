import { prisma, StarsPricingMode, type PaymentGateway } from "@zedbot/database";
import {
  nowpaymentsConfigFromEnv,
  paymentHttpTimeoutMs,
  readJsonSafely,
  telegramStarsConfigFromEnv,
  zarinpalConfigFromEnv,
} from "@zedbot/payments";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { createCardGatewayIfMissing } from "./admin-payment-method.service.js";
import {
  isWalletPaymentEnabled,
  setWalletPaymentEnabled,
} from "./payment-settings.service.js";
import { walletTopupLimits } from "./wallet-topup.service.js";

// =============================================================================
// Admin payment PROVIDER management (provider-management phase): the fixed
// registry of managed providers, idempotent gateway-row bootstrap, the
// enable/disable switch and read-only connection tests. Pure configuration -
// NEVER creates Payment/Order/CheckoutSession rows and never touches the
// gateway adapters in @zedbot/payments (their exports are used read-only).
//
// Secret hygiene: config status is PRESENCE-ONLY (تنظیم شده/نشده) - no env
// value is ever rendered, returned or logged. Logs carry only the provider
// type key and the acting admin id.
// =============================================================================

/** Stable provider keys - used in callback data, NEVER display names. */
export type ManagedProviderKey =
  | "CARD_TO_CARD"
  | "WALLET"
  | "ZARINPAL"
  | "NOWPAYMENTS"
  | "TELEGRAM_STARS";

export interface ManagedProviderMeta {
  key: ManagedProviderKey;
  /** Default Persian display name (PaymentGateway.name for real providers). */
  displayName: string;
  /** List-button emoji - purely visual, never part of callback data. */
  listEmoji: string;
  /** Persian «نوع» label rendered on the provider detail page. */
  kindLabel: string;
  supportsConnectionTest: boolean;
  /**
   * WALLET is VIRTUAL: it is backed by the wallet_payment_enabled Setting
   * (payment-settings.service), not by a PaymentGateway row.
   */
  virtual: boolean;
  /**
   * Enabling requires a complete configuration. Only set for providers whose
   * config lives OUTSIDE this admin page (env/pricing settings): an admin can
   * fix card/wallet config right here, so those stay switchable.
   */
  requireConfigToEnable: boolean;
}

/** Managed providers in admin display order. */
export const MANAGED_PROVIDERS: readonly ManagedProviderMeta[] = [
  {
    key: "CARD_TO_CARD",
    displayName: "کارت‌به‌کارت",
    listEmoji: "💳",
    kindLabel: "پرداخت دستی با رسید",
    supportsConnectionTest: false,
    virtual: false,
    requireConfigToEnable: false,
  },
  {
    key: "WALLET",
    displayName: "کیف پول",
    listEmoji: "🏦",
    kindLabel: "پرداخت از موجودی داخلی کاربر",
    supportsConnectionTest: false,
    virtual: true,
    requireConfigToEnable: false,
  },
  {
    key: "ZARINPAL",
    displayName: "زرین‌پال",
    listEmoji: "🇮🇷",
    kindLabel: "پرداخت آنلاین ریالی",
    supportsConnectionTest: true,
    virtual: false,
    requireConfigToEnable: true,
  },
  {
    key: "NOWPAYMENTS",
    displayName: "پرداخت کریپتویی",
    listEmoji: "🪙",
    kindLabel: "پرداخت کریپتویی",
    supportsConnectionTest: true,
    virtual: false,
    requireConfigToEnable: true,
  },
  {
    key: "TELEGRAM_STARS",
    displayName: "پرداخت با Telegram Stars",
    listEmoji: "⭐",
    kindLabel: "پرداخت داخل تلگرام",
    supportsConnectionTest: false,
    virtual: false,
    requireConfigToEnable: true,
  },
];

export function managedProviderMeta(key: string): ManagedProviderMeta | null {
  return MANAGED_PROVIDERS.find((meta) => meta.key === key) ?? null;
}

/** Provider keys that own a real PaymentGateway row (all but WALLET). */
type RealProviderKey = Exclude<ManagedProviderKey, "WALLET">;

type RealProviderMeta = ManagedProviderMeta & { key: RealProviderKey };

function isRealProvider(meta: ManagedProviderMeta): meta is RealProviderMeta {
  return meta.key !== "WALLET";
}

/** Real (non-virtual) provider metas that own a PaymentGateway row. */
function realProviders(): RealProviderMeta[] {
  return MANAGED_PROVIDERS.filter(isRealProvider);
}

/** Oldest gateway row for a real provider type (mirrors the card lookup). */
async function gatewayRowFor(key: ManagedProviderKey): Promise<PaymentGateway | null> {
  if (key === "WALLET") {
    return null;
  }
  return prisma.paymentGateway.findFirst({
    where: { type: key },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Idempotent create-if-missing of one PaymentGateway row per real provider
 * type. CARD_TO_CARD goes through the existing createCardGatewayIfMissing
 * (enabled by default, Phase 21 semantics); the online providers are created
 * DISABLED - safe default: the admin explicitly enables them. Existing rows
 * are never touched. Called when the admin opens the payment-methods page.
 */
export async function ensureProviderGateways(): Promise<void> {
  for (const meta of realProviders()) {
    if (meta.key === "CARD_TO_CARD") {
      await createCardGatewayIfMissing();
      continue;
    }
    const existing = await gatewayRowFor(meta.key);
    if (existing !== null) {
      continue;
    }
    await prisma.paymentGateway.create({
      data: {
        type: meta.key,
        name: meta.displayName,
        isEnabled: false,
        isHidden: false,
        displayOrder: MANAGED_PROVIDERS.indexOf(meta),
      },
    });
    logger.info("payment provider gateway created", { provider: meta.key });
  }
}

export interface ManagedProviderRow {
  providerKey: ManagedProviderKey;
  gatewayId?: string;
  displayName: string;
  listEmoji: string;
  enabled: boolean;
  kindLabel: string;
  configured: boolean;
  /** PRESENCE-ONLY Persian config lines - never actual secret values. */
  configLines: string[];
  supportsConnectionTest: boolean;
  lastCheckedAt: Date | null;
  healthStatus: string | null;
}

const SET_LABEL = "تنظیم شده ✅";
const UNSET_LABEL = "تنظیم نشده ❌";

function presence(configured: boolean): string {
  return configured ? SET_LABEL : UNSET_LABEL;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** MANUAL_RATE with a positive manual rate = the Stars rate is configured. */
async function starsRateConfigured(): Promise<boolean> {
  try {
    const setting = await prisma.starsPricingSetting.findUnique({
      where: { singletonKey: "default" },
    });
    return (
      setting !== null &&
      setting.pricingMode === StarsPricingMode.MANUAL_RATE &&
      (setting.manualTomanPerStar ?? 0) > 0
    );
  } catch (err) {
    logger.warn("stars pricing lookup failed (provider list)", {
      error: errorMessage(err),
    });
    return false;
  }
}

function formatTomanValue(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

const ON_LABEL = "فعال ✅";
const OFF_LABEL = "غیرفعال ❌";

interface ProviderConfigStatus {
  configured: boolean;
  /** PRESENCE-ONLY Persian lines - never actual secret values. */
  configLines: string[];
}

/**
 * One provider's configuration readiness, RE-FETCHED from its source of
 * truth on every call (env config readers / pricing setting / card count).
 * Shared by the detail pages and the enable guard, and PRESENCE-ONLY: no
 * merchant id, API key, IPN secret or bot token ever leaves this function.
 */
async function providerConfigStatus(
  meta: ManagedProviderMeta,
  gateway: PaymentGateway | null,
): Promise<ProviderConfigStatus> {
  if (meta.key === "WALLET") {
    // The top-up limits are operator-set AMOUNTS (non-secret) - shown as-is.
    const limits = await walletTopupLimits();
    return {
      configured: true,
      configLines: [
        `حداقل/حداکثر شارژ: ${formatTomanValue(limits.minToman)} / ${formatTomanValue(limits.maxToman)}`,
      ],
    };
  }
  if (meta.key === "CARD_TO_CARD") {
    const activeCards =
      gateway === null
        ? 0
        : await prisma.cardToCardAccount.count({
            where: { gatewayId: gateway.id, isActive: true },
          });
    return { configured: activeCards > 0, configLines: [`کارت‌های فعال: ${activeCards}`] };
  }
  if (meta.key === "ZARINPAL") {
    const config = zarinpalConfigFromEnv();
    const merchantSet = isSet(config.merchantId);
    const callbackSet = isSet(config.callbackUrl);
    return {
      configured: merchantSet && callbackSet,
      configLines: [
        `Merchant ID: ${presence(merchantSet)}`,
        `Callback: ${presence(callbackSet)}`,
        `Sandbox: ${config.sandbox ? ON_LABEL : OFF_LABEL}`,
      ],
    };
  }
  if (meta.key === "NOWPAYMENTS") {
    const config = nowpaymentsConfigFromEnv();
    const apiKeySet = isSet(config.apiKey);
    const ipnSecretSet = isSet(config.ipnSecret);
    const callbackSet = isSet(config.callbackUrl);
    const rateSet = config.tomanPerUnit > 0;
    return {
      configured: apiKeySet && ipnSecretSet && callbackSet && rateSet,
      configLines: [
        `API Key: ${presence(apiKeySet)}`,
        `IPN Secret: ${presence(ipnSecretSet)}`,
        `Callback: ${presence(callbackSet)}`,
        `نرخ تبدیل: ${presence(rateSet)}`,
        `Sandbox: ${config.sandbox ? ON_LABEL : OFF_LABEL}`,
      ],
    };
  }
  // TELEGRAM_STARS: env switch + the StarsPricingSetting manual rate. The
  // payment unit is fixed by the Bot API; the bot token itself never appears.
  const config = telegramStarsConfigFromEnv();
  const rateSet = await starsRateConfigured();
  return {
    configured: config.enabled && rateSet,
    configLines: [
      `اتصال ربات: ${config.enabled ? ON_LABEL : OFF_LABEL}`,
      "واحد پرداخت: XTR",
      `نرخ ستاره: ${presence(rateSet)}`,
    ],
  };
}

/**
 * All managed providers (real gateway rows + the virtual wallet) with their
 * enabled state and presence-only configuration status.
 */
export async function listManagedProviders(): Promise<ManagedProviderRow[]> {
  const rows: ManagedProviderRow[] = [];
  for (const meta of MANAGED_PROVIDERS) {
    if (meta.virtual) {
      // WALLET: backed by the wallet_payment_enabled Setting.
      const [enabled, status] = await Promise.all([
        isWalletPaymentEnabled(),
        providerConfigStatus(meta, null),
      ]);
      rows.push({
        providerKey: meta.key,
        displayName: meta.displayName,
        listEmoji: meta.listEmoji,
        enabled,
        kindLabel: meta.kindLabel,
        configured: status.configured,
        configLines: status.configLines,
        supportsConnectionTest: meta.supportsConnectionTest,
        lastCheckedAt: null,
        healthStatus: null,
      });
      continue;
    }

    const gateway = await gatewayRowFor(meta.key);
    const { configured, configLines } = await providerConfigStatus(meta, gateway);

    rows.push({
      providerKey: meta.key,
      ...(gateway === null ? {} : { gatewayId: gateway.id }),
      displayName: gateway?.name ?? meta.displayName,
      listEmoji: meta.listEmoji,
      enabled: gateway?.isEnabled ?? false,
      kindLabel: meta.kindLabel,
      configured,
      configLines,
      supportsConnectionTest: meta.supportsConnectionTest,
      lastCheckedAt: gateway?.lastCheckedAt ?? null,
      healthStatus: gateway?.healthStatus ?? null,
    });
  }
  return rows;
}

export interface SetProviderEnabledResult {
  ok: boolean;
  /** false = the provider was already in the requested state (duplicate). */
  changed: boolean;
  /** Set when ok=false and the cause is a known, reportable condition. */
  reason?: "incomplete_config";
}

/**
 * Flips one provider on/off. WALLET goes through the existing Setting
 * writer; real providers flip their gateway row with a compare-and-set
 * updateMany, so a duplicate action (already in the requested state, e.g. a
 * double click or stale confirmation) reports {ok: true, changed: false}.
 *
 * ENABLE GUARD: providers whose configuration lives outside this page
 * (env/pricing - requireConfigToEnable) re-check their config at action time
 * and refuse to enable while it is incomplete. Disable is never guarded, and
 * disabling deletes NOTHING: config rows, card accounts and Payment records
 * all stay untouched - the provider merely disappears from user selection.
 *
 * Logs only the provider type key, the action and the acting admin id.
 */
export async function setProviderEnabled(
  providerKey: string,
  enabled: boolean,
  adminId: string,
): Promise<SetProviderEnabledResult> {
  const meta = managedProviderMeta(providerKey);
  if (meta === null) {
    return { ok: false, changed: false };
  }
  if (meta.virtual) {
    if ((await isWalletPaymentEnabled()) === enabled) {
      return { ok: true, changed: false };
    }
    await setWalletPaymentEnabled(enabled);
    logger.info(enabled ? "payment provider enabled" : "payment provider disabled", {
      provider: meta.key,
      adminId,
    });
    return { ok: true, changed: true };
  }
  const gateway = await gatewayRowFor(meta.key);
  if (gateway === null) {
    return { ok: false, changed: false };
  }
  if (enabled && meta.requireConfigToEnable) {
    const status = await providerConfigStatus(meta, gateway);
    if (!status.configured) {
      logger.info("payment provider enable blocked (incomplete config)", {
        provider: meta.key,
        adminId,
      });
      return { ok: false, changed: false, reason: "incomplete_config" };
    }
  }
  const updated = await prisma.paymentGateway.updateMany({
    where: { id: gateway.id, isEnabled: !enabled },
    data: { isEnabled: enabled },
  });
  if (updated.count !== 1) {
    return { ok: true, changed: false };
  }
  logger.info(enabled ? "payment provider enabled" : "payment provider disabled", {
    provider: meta.key,
    adminId,
  });
  return { ok: true, changed: true };
}

// --- connection tests --------------------------------------------------------------
//
// Implemented WITHOUT touching the adapters: env config comes from the
// @zedbot/payments config readers and requests use the package's timeout /
// safe-JSON helpers. Results never carry provider errors - only {ok}.

// Host fallbacks mirror the (unexported) adapter constants; the *_BASE_URL
// env override from the config readers always wins.
const ZARINPAL_PRODUCTION_HOST = "https://payment.zarinpal.com";
const ZARINPAL_SANDBOX_HOST = "https://sandbox.zarinpal.com";
const NOWPAYMENTS_PRODUCTION_HOST = "https://api.nowpayments.io/v1";
const NOWPAYMENTS_SANDBOX_HOST = "https://api-sandbox.nowpayments.io/v1";

/** Official NOWPayments API status endpoint: HTTP 200 + a JSON body = up. */
async function testNowPaymentsConnection(): Promise<boolean> {
  const config = nowpaymentsConfigFromEnv();
  const host =
    config.baseUrl ?? (config.sandbox ? NOWPAYMENTS_SANDBOX_HOST : NOWPAYMENTS_PRODUCTION_HOST);
  try {
    const response = await fetch(`${host}/status`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(paymentHttpTimeoutMs()),
    });
    if (!response.ok) {
      return false;
    }
    return (await readJsonSafely(response)).ok;
  } catch {
    return false;
  }
}

/**
 * Zarinpal exposes NO side-effect-free ping endpoint, so the test posts a
 * verify call with a well-formed DUMMY authority: verify.json creates
 * nothing server-side, and ANY structured v4 envelope answer (data/errors -
 * even an error code like "authority not found") proves both connectivity
 * and the expected API shape. Timeouts, transport failures and non-JSON
 * answers are the only failures.
 */
async function testZarinpalConnection(): Promise<boolean> {
  const config = zarinpalConfigFromEnv();
  const host =
    config.baseUrl ?? (config.sandbox ? ZARINPAL_SANDBOX_HOST : ZARINPAL_PRODUCTION_HOST);
  try {
    const response = await fetch(`${host}/pg/v4/payment/verify.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        merchant_id: config.merchantId ?? "",
        amount: 1000,
        authority: "A" + "0".repeat(35),
      }),
      signal: AbortSignal.timeout(paymentHttpTimeoutMs()),
    });
    const parsed = await readJsonSafely(response);
    if (!parsed.ok || typeof parsed.data !== "object" || parsed.data === null) {
      return false;
    }
    return "data" in parsed.data || "errors" in parsed.data;
  } catch {
    return false;
  }
}

export type ProviderConnectionStatus = "OK" | "FAILED" | "INCOMPLETE" | "UNSUPPORTED";

export interface ProviderConnectionResult {
  status: ProviderConnectionStatus;
}

/**
 * Tests one provider's connectivity and persists lastCheckedAt/healthStatus
 * ("OK"/"FAILED") on its gateway row. Providers with no meaningful test
 * report UNSUPPORTED without any request or persistence; an incomplete
 * configuration reports INCOMPLETE without firing a request (nothing useful
 * can be probed and no misleading FAILED is persisted). Never throws; never
 * surfaces raw provider errors.
 */
export async function testProviderConnection(
  providerKey: string,
): Promise<ProviderConnectionResult> {
  const meta = managedProviderMeta(providerKey);
  if (meta === null || !meta.supportsConnectionTest) {
    return { status: "UNSUPPORTED" };
  }
  const gateway = await gatewayRowFor(meta.key);
  const configStatus = await providerConfigStatus(meta, gateway);
  if (!configStatus.configured) {
    logger.info("payment provider connection test", {
      provider: meta.key,
      status: "INCOMPLETE",
    });
    return { status: "INCOMPLETE" };
  }
  const ok =
    meta.key === "NOWPAYMENTS"
      ? await testNowPaymentsConnection()
      : await testZarinpalConnection();
  if (gateway !== null) {
    await prisma.paymentGateway.update({
      where: { id: gateway.id },
      data: { lastCheckedAt: new Date(), healthStatus: ok ? "OK" : "FAILED" },
    });
  }
  logger.info("payment provider connection test", {
    provider: meta.key,
    status: ok ? "OK" : "FAILED",
  });
  return { status: ok ? "OK" : "FAILED" };
}
