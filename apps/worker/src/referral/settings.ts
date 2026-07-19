import { prisma } from "@zedbot/database";
import {
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_PAYOUT_WINDOWS_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
  parseReferralPayoutWindows,
  type ReferralPayoutWindow,
} from "@zedbot/shared";

// =============================================================================
// Referral SETTINGS reader (worker side). Reads the SAME Setting rows the bot
// writes, so the reconciliation scan and the bot execute consumer see identical
// configuration. The master switch defaults FALSE, so a worker whose install
// never enabled referral payouts scans nothing.
// =============================================================================

async function settingValue(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value.trim() ?? "";
  return value === "" ? null : value;
}

function toBool(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** MASTER switch (false for every install until the OWNER enables payouts). */
export async function isReferralSystemEnabled(): Promise<boolean> {
  return toBool(await settingValue(REFERRAL_SYSTEM_ENABLED_KEY));
}

/** Whether the first-purchase-only policy is active (affects which orders to scan). */
export async function isReferralFirstPurchaseOnly(): Promise<boolean> {
  const raw = await settingValue(REFERRAL_FIRST_PURCHASE_ONLY_KEY);
  // Default true (mirrors DEFAULT_REFERRAL_CONFIG.firstPurchaseOnly).
  return raw === null ? true : toBool(raw);
}

/**
 * The activation-horizon instant, or null when payouts were never enabled. A null
 * horizon is fail-closed — the scan credits nothing and never back-fills history.
 */
export async function getReferralCommissionsStartedAt(): Promise<Date | null> {
  const raw = await settingValue(REFERRAL_COMMISSIONS_STARTED_AT_KEY);
  if (raw === null) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The payout ACTIVE-WINDOWS. An order is credit-eligible only if it completed
 * inside one. Backward-compatible: an install with a horizon but no windows row
 * (enabled under the pre-window code) synthesises a single open window from the
 * horizon, preserving the old "all post-horizon eligible" behaviour.
 */
export async function getReferralPayoutWindows(): Promise<ReferralPayoutWindow[]> {
  const parsed = parseReferralPayoutWindows(await settingValue(REFERRAL_PAYOUT_WINDOWS_KEY));
  if (parsed.length > 0) {
    return parsed;
  }
  const horizon = await getReferralCommissionsStartedAt();
  return horizon === null ? [] : [{ from: horizon.toISOString(), to: null }];
}
