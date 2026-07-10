import { getBooleanSetting, getSetting, setSetting } from "./settings.service.js";

// =============================================================================
// Operator-configurable wallet/payment settings (Phase 22), stored in the
// existing Setting model (key/value rows - nothing is seeded; every read
// falls back to a safe default when the row is missing). Key names follow
// the repo's existing snake_case convention; the top-up min/max keys are the
// PRE-EXISTING Phase 14 keys, so values an operator already stored keep
// working (wallet-topup.service.walletTopupLimits reads them unchanged).
//
//   wallet.topup.enabled         -> wallet_topup_enabled          (true)
//   wallet.payment.enabled       -> wallet_payment_enabled        (true)
//   wallet.topup.min_toman       -> wallet_topup_min_toman        (10,000)
//   wallet.topup.max_toman       -> wallet_topup_max_toman        (50,000,000)
//   wallet.topup.instruction_text-> wallet_topup_instruction_text (null)
//   payment.page.notice_text     -> payment_page_notice_text      (null)
// =============================================================================

export const WALLET_TOPUP_ENABLED_KEY = "wallet_topup_enabled";
export const WALLET_PAYMENT_ENABLED_KEY = "wallet_payment_enabled";
/** Pre-existing Phase 14 keys - reused, not renamed. */
export const WALLET_TOPUP_MIN_KEY = "wallet_topup_min_toman";
export const WALLET_TOPUP_MAX_KEY = "wallet_topup_max_toman";
export const WALLET_TOPUP_INSTRUCTION_KEY = "wallet_topup_instruction_text";
export const PAYMENT_PAGE_NOTICE_KEY = "payment_page_notice_text";

/** Built-in fallbacks (identical to the Phase 14 walletTopupLimits defaults). */
export const DEFAULT_TOPUP_MIN_TOMAN = 10_000;
export const DEFAULT_TOPUP_MAX_TOMAN = 50_000_000;

export const SETTING_TEXT_MAX_LENGTH = 1000;

export const WALLET_TOPUP_DISABLED_TEXT = "شارژ کیف پول در حال حاضر غیرفعال است.";
export const WALLET_PAYMENT_DISABLED_TEXT = "پرداخت با کیف پول در حال حاضر غیرفعال است.";
export const SETTING_TEXT_TOO_LONG = `متن حداکثر ${SETTING_TEXT_MAX_LENGTH} کاراکتر است.`;
export const MIN_ABOVE_MAX_TOPUP_TEXT = "حداقل شارژ نمی‌تواند از حداکثر شارژ بیشتر باشد.";

// --- reads (safe defaults when rows are missing) --------------------------------------

export async function isWalletTopupEnabled(): Promise<boolean> {
  return getBooleanSetting(WALLET_TOPUP_ENABLED_KEY, true);
}

export async function isWalletPaymentEnabled(): Promise<boolean> {
  return getBooleanSetting(WALLET_PAYMENT_ENABLED_KEY, true);
}

/** Trimmed instruction text or null when unset/cleared. */
export async function walletTopupInstruction(): Promise<string | null> {
  const raw = (await getSetting(WALLET_TOPUP_INSTRUCTION_KEY, "")).trim();
  return raw === "" ? null : raw;
}

/** Trimmed payment-page notice or null when unset/cleared. */
export async function paymentPageNotice(): Promise<string | null> {
  const raw = (await getSetting(PAYMENT_PAGE_NOTICE_KEY, "")).trim();
  return raw === "" ? null : raw;
}

/**
 * Raw stored limit for validation/display. Mirrors the exact Phase 14
 * walletTopupLimits semantics: a non-positive/unparseable min falls back to
 * the default; a max below the effective min falls back to the default.
 */
async function effectiveLimit(key: string): Promise<number | null> {
  const raw = Number.parseInt(await getSetting(key, ""), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

// --- writes ----------------------------------------------------------------------------

export async function setWalletTopupEnabled(enabled: boolean): Promise<void> {
  await setSetting(WALLET_TOPUP_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

export async function setWalletPaymentEnabled(enabled: boolean): Promise<void> {
  await setSetting(WALLET_PAYMENT_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

export type SettingWriteResult = { ok: true } | { ok: false; safeMessage: string };

/**
 * value 0 RESETS the limit to the built-in default (walletTopupLimits treats
 * non-positive stored values as "use the default"). A positive min must not
 * exceed the effective max and vice versa.
 */
export async function setWalletTopupMinToman(value: number): Promise<SettingWriteResult> {
  if (value > 0) {
    const max = (await effectiveLimit(WALLET_TOPUP_MAX_KEY)) ?? DEFAULT_TOPUP_MAX_TOMAN;
    if (value > max) {
      return { ok: false, safeMessage: MIN_ABOVE_MAX_TOPUP_TEXT };
    }
  }
  await setSetting(WALLET_TOPUP_MIN_KEY, String(Math.max(0, value)), "NUMBER");
  return { ok: true };
}

export async function setWalletTopupMaxToman(value: number): Promise<SettingWriteResult> {
  if (value > 0) {
    const min = (await effectiveLimit(WALLET_TOPUP_MIN_KEY)) ?? DEFAULT_TOPUP_MIN_TOMAN;
    if (value < min) {
      return { ok: false, safeMessage: MIN_ABOVE_MAX_TOPUP_TEXT };
    }
  }
  await setSetting(WALLET_TOPUP_MAX_KEY, String(Math.max(0, value)), "NUMBER");
  return { ok: true };
}

/** null/empty clears the text; capped at 1000 chars. */
export async function setWalletTopupInstruction(text: string | null): Promise<SettingWriteResult> {
  return setTextSetting(WALLET_TOPUP_INSTRUCTION_KEY, text);
}

/** null/empty clears the text; capped at 1000 chars. */
export async function setPaymentPageNotice(text: string | null): Promise<SettingWriteResult> {
  return setTextSetting(PAYMENT_PAGE_NOTICE_KEY, text);
}

async function setTextSetting(key: string, text: string | null): Promise<SettingWriteResult> {
  const value = text?.trim() ?? "";
  if (value.length > SETTING_TEXT_MAX_LENGTH) {
    return { ok: false, safeMessage: SETTING_TEXT_TOO_LONG };
  }
  await setSetting(key, value, "STRING");
  return { ok: true };
}
