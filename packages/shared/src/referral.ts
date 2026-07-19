// =============================================================================
// Referral affiliate commissions (Phase 1) — the dependency-free (no prisma /
// bullmq) shared contract: settings keys, validated config with code-defaults,
// and the PURE commission calculator the bot service, admin dry-run and tests all
// call. The whole payout is DISABLED by default; referral ATTRIBUTION (linking a
// referred user to a referrer) is a separate, always-on concern handled elsewhere.
// A commission is credited to the REFERRER's internal wallet when a REFERRED user
// completes a qualifying purchase — never more than the configured percent of the
// order, never on a below-minimum order, and (by default) only on the referred
// user's FIRST completed order.
// =============================================================================

// --- settings keys -----------------------------------------------------------

/** MASTER switch (false for every install until the OWNER enables it). */
export const REFERRAL_SYSTEM_ENABLED_KEY = "referral_system_enabled";
/** Commission as a whole-number percent of the qualifying order amount. */
export const REFERRAL_COMMISSION_PERCENT_KEY = "referral_commission_percent";
/** When true, only the referred user's FIRST completed order earns a commission. */
export const REFERRAL_FIRST_PURCHASE_ONLY_KEY = "referral_first_purchase_only";
/** Orders paid below this (Toman) never earn a commission. */
export const REFERRAL_MIN_PURCHASE_TOMAN_KEY = "referral_min_purchase_toman";

// --- config ------------------------------------------------------------------

export interface ReferralConfig {
  /** Commission percent (0..100) of the qualifying order amount. */
  commissionPercent: number;
  /** Commission only on the referred user's first completed order. */
  firstPurchaseOnly: boolean;
  /** Minimum paid order amount (Toman) that can earn a commission. */
  minPurchaseToman: number;
}

export const DEFAULT_REFERRAL_CONFIG: ReferralConfig = {
  commissionPercent: 10,
  firstPurchaseOnly: true,
  minPurchaseToman: 0,
};

// bounds (all values validated + clamped; an invalid stored value → the default)
export const REFERRAL_MIN_COMMISSION_PERCENT = 0;
export const REFERRAL_MAX_COMMISSION_PERCENT = 100;
export const REFERRAL_MIN_PURCHASE_TOMAN_BOUND = 0;
export const REFERRAL_MAX_PURCHASE_TOMAN_BOUND = 1_000_000_000;

/** Clamp helper: an out-of-range / non-integer value returns the fallback. */
export function clampReferralInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

// --- pure commission calculator ----------------------------------------------

export interface ReferralCommissionDecision {
  /** True when a positive commission may be credited for this order. */
  eligible: boolean;
  /** The commission amount (Toman) — floored, never over-credited. */
  commissionToman: number;
  /** The percent applied (snapshotted onto the commission row). */
  percent: number;
  reason: "ok" | "invalid-amount" | "below-minimum" | "zero-percent" | "zero-commission";
}

/**
 * Resolves the referral commission for one qualifying order. Pure and deterministic
 * — no clock, no I/O. Never credits more than `percent`% of the order; the amount is
 * FLOORED to whole Toman so a rounding error can never over-credit the referrer. An
 * order below the configured minimum, a zero/invalid amount, a zero percent, or a
 * sub-1-Toman result yields NO commission (the caller records nothing / no wallet
 * credit). First-purchase-only and the enabled switch are enforced by the caller
 * against live DB state; this function only decides the money for an already-eligible
 * order.
 */
export function resolveReferralCommission(input: {
  orderAmountToman: number;
  config: ReferralConfig;
}): ReferralCommissionDecision {
  const { orderAmountToman, config } = input;
  const percent = config.commissionPercent;
  if (!Number.isInteger(orderAmountToman) || orderAmountToman <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "invalid-amount" };
  }
  if (orderAmountToman < config.minPurchaseToman) {
    return { eligible: false, commissionToman: 0, percent, reason: "below-minimum" };
  }
  if (percent <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "zero-percent" };
  }
  const commissionToman = Math.floor((orderAmountToman * percent) / 100);
  if (commissionToman <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "zero-commission" };
  }
  return { eligible: true, commissionToman, percent, reason: "ok" };
}

/** The user-facing t.me deep link that attributes a new user to this referrer. */
export function referralDeepLink(botUsername: string, referralCode: string): string {
  return `https://t.me/${botUsername}?start=${referralCode}`;
}
