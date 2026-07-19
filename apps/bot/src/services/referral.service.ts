import { prisma, type User } from "@zedbot/database";
import {
  DEFAULT_REFERRAL_CONFIG,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_MAX_COMMISSION_PERCENT,
  REFERRAL_MAX_PURCHASE_TOMAN_BOUND,
  REFERRAL_MIN_COMMISSION_PERCENT,
  REFERRAL_MIN_PURCHASE_TOMAN_BOUND,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
  clampReferralInt,
  errorMessage,
  type ReferralConfig,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { clearSettingsCache, getBooleanSetting, getSetting, setSetting } from "./settings.service.js";

/**
 * Applies a /start referral payload when eligible:
 *   - payload must be numeric (a referralCode / telegramId)
 *   - the user must not already have a referrer
 *   - the referrer must exist and not be the user themselves
 *
 * Sets user.referrerId + referralJoinedAt and ensures the Referral row.
 * No gifts, no commissions yet (later phases). Never throws - a broken
 * referral payload must not break /start.
 */
export async function applyReferralIfEligible(user: User, payload: string): Promise<void> {
  try {
    const code = payload.trim();
    if (!/^\d+$/.test(code)) {
      logger.debug("ignoring non-numeric referral payload");
      return;
    }
    if (user.referrerId !== null) {
      return;
    }
    const referrer = await prisma.user.findFirst({
      where: { OR: [{ referralCode: code }, { telegramId: BigInt(code) }] },
    });
    if (referrer === null || referrer.id === user.id) {
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { referrerId: referrer.id, referralJoinedAt: new Date() },
    });
    await prisma.referral.upsert({
      where: { referredUserId: user.id },
      update: {},
      create: { referrerUserId: referrer.id, referredUserId: user.id },
    });
    logger.info("referral applied", { referredUserId: user.id, referrerUserId: referrer.id });
  } catch (err) {
    logger.warn("referral parsing failed, /start continues", { error: errorMessage(err) });
  }
}

// --- config (affiliate-commission phase) -------------------------------------

/** MASTER switch: false for every install until the OWNER enables commissions. */
export async function isReferralSystemEnabled(): Promise<boolean> {
  return getBooleanSetting(REFERRAL_SYSTEM_ENABLED_KEY, false);
}

/** The validated referral config — every field bounded and code-defaulted. */
export async function getReferralConfig(): Promise<ReferralConfig> {
  const d = DEFAULT_REFERRAL_CONFIG;
  const [percentRaw, firstOnly, minRaw] = await Promise.all([
    getSetting(REFERRAL_COMMISSION_PERCENT_KEY, ""),
    getBooleanSetting(REFERRAL_FIRST_PURCHASE_ONLY_KEY, d.firstPurchaseOnly),
    getSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, ""),
  ]);
  return {
    commissionPercent: clampReferralInt(
      Number.parseInt(percentRaw, 10),
      REFERRAL_MIN_COMMISSION_PERCENT,
      REFERRAL_MAX_COMMISSION_PERCENT,
      d.commissionPercent,
    ),
    firstPurchaseOnly: firstOnly,
    minPurchaseToman: clampReferralInt(
      Number.parseInt(minRaw, 10),
      REFERRAL_MIN_PURCHASE_TOMAN_BOUND,
      REFERRAL_MAX_PURCHASE_TOMAN_BOUND,
      d.minPurchaseToman,
    ),
  };
}

// --- admin config setters + stats (affiliate-commission phase) ----------------

/** Sets the commission percent (0..100). Out-of-range → false (rejected). */
export async function setReferralCommissionPercent(percent: number): Promise<boolean> {
  if (!Number.isInteger(percent) || percent < REFERRAL_MIN_COMMISSION_PERCENT || percent > REFERRAL_MAX_COMMISSION_PERCENT) {
    return false;
  }
  await setSetting(REFERRAL_COMMISSION_PERCENT_KEY, String(percent), "NUMBER");
  clearSettingsCache();
  return true;
}

/** Sets the minimum qualifying order amount (Toman). Out-of-range → false. */
export async function setReferralMinPurchaseToman(minToman: number): Promise<boolean> {
  if (!Number.isInteger(minToman) || minToman < REFERRAL_MIN_PURCHASE_TOMAN_BOUND || minToman > REFERRAL_MAX_PURCHASE_TOMAN_BOUND) {
    return false;
  }
  await setSetting(REFERRAL_MIN_PURCHASE_TOMAN_KEY, String(minToman), "NUMBER");
  clearSettingsCache();
  return true;
}

/** Sets the first-purchase-only toggle. */
export async function setReferralFirstPurchaseOnly(value: boolean): Promise<void> {
  await setSetting(REFERRAL_FIRST_PURCHASE_ONLY_KEY, value ? "true" : "false", "BOOLEAN");
  clearSettingsCache();
}

export interface ReferralAdminStats {
  enabled: boolean;
  commissionPercent: number;
  firstPurchaseOnly: boolean;
  minPurchaseToman: number;
  totalReferrals: number;
  paidCommissionCount: number;
  paidCommissionToman: number;
  reversedCommissionCount: number;
}

/** Authoritative referral counts for the admin overview (read straight from the DB). */
export async function getReferralAdminStats(): Promise<ReferralAdminStats> {
  const [enabled, config, totalReferrals, paid, reversedCount] = await Promise.all([
    isReferralSystemEnabled(),
    getReferralConfig(),
    prisma.referral.count(),
    prisma.referralCommission.aggregate({ where: { status: "PAID" }, _count: true, _sum: { amountToman: true } }),
    prisma.referralCommission.count({ where: { status: "REVERSED" } }),
  ]);
  return {
    enabled,
    commissionPercent: config.commissionPercent,
    firstPurchaseOnly: config.firstPurchaseOnly,
    minPurchaseToman: config.minPurchaseToman,
    totalReferrals,
    paidCommissionCount: paid._count,
    paidCommissionToman: paid._sum.amountToman ?? 0,
    reversedCommissionCount: reversedCount,
  };
}
