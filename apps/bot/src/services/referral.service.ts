import { Prisma, prisma, type User } from "@zedbot/database";
import {
  DEFAULT_REFERRAL_CONFIG,
  REFERRAL_COMMISSION_PERCENT_KEY,
  REFERRAL_COMMISSIONS_STARTED_AT_KEY,
  REFERRAL_FIRST_PURCHASE_ONLY_KEY,
  REFERRAL_MAX_COMMISSION_PERCENT,
  REFERRAL_MAX_PURCHASE_TOMAN_BOUND,
  REFERRAL_MIN_COMMISSION_PERCENT,
  REFERRAL_MIN_PURCHASE_TOMAN_BOUND,
  REFERRAL_MIN_PURCHASE_TOMAN_KEY,
  REFERRAL_PAYOUT_WINDOWS_KEY,
  REFERRAL_SYSTEM_ENABLED_KEY,
  clampReferralInt,
  closeReferralPayoutWindow,
  errorMessage,
  openReferralPayoutWindow,
  parseReferralPayoutWindowsStrict,
  referralCorrelationHash,
  type ReferralConfig,
  type ReferralPayoutWindow,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  clearSettingsCache,
  getBooleanSetting,
  getSetting,
  setSetting,
} from "./settings.service.js";

/** A Referral row already exists for a user whose User.referrerId was still null,
 *  pointing at a DIFFERENT referrer — throwing rolls the /start claim back so the
 *  User relation and the Referral row can never disagree (never a new mismatch). */
class ReferralAttributionMismatchError extends Error {}

/** getBooleanSetting's truthy set, for transaction-local reads (no cache). */
function isTruthySettingValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

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
    // Fast path only: the AUTHORITATIVE not-already-referred check happens inside
    // the transaction against the LIVE row, so a stale in-memory user is safe.
    if (user.referrerId !== null) {
      return;
    }
    const referrer = await prisma.user.findFirst({
      where: { OR: [{ referralCode: code }, { telegramId: BigInt(code) }] },
      select: { id: true },
    });
    if (referrer === null || referrer.id === user.id) {
      return; // no such referrer, or self-referral — ignored.
    }
    // ONE transaction: claim the User (only while referrerId is still null) AND
    // write the Referral row together, so the relation and the row can never
    // half-link and always reference the SAME referrer. The conditional claim is
    // evaluated against the live DB row (never the stale object), so two concurrent
    // /start requests with different codes converge on exactly one referrer.
    const now = new Date();
    let linked = false;
    try {
      linked = await prisma.$transaction(async (tx) => {
        const claim = await tx.user.updateMany({
          where: { id: user.id, referrerId: null },
          data: { referrerId: referrer.id, referralJoinedAt: now },
        });
        if (claim.count === 0) {
          // Already referred (or a concurrent /start won the claim) — never overwrite.
          return false;
        }
        // The conditional claim above serialises concurrent /start for THIS user
        // (the row lock lets only one win), so at most one writer reaches here — a
        // check-then-create is race-free. A pre-existing Referral row can only come
        // from legacy inconsistent data (User.referrerId null but a Referral row
        // present); it MUST point at the same referrer, else we roll the whole claim
        // back rather than leave User.referrerId and Referral.referrerUserId
        // disagreeing. (We check-then-create instead of catching P2002 because a
        // constraint error inside a transaction aborts it, forbidding a follow-up read.)
        const existing = await tx.referral.findUnique({
          where: { referredUserId: user.id },
          select: { referrerUserId: true },
        });
        if (existing !== null) {
          if (existing.referrerUserId !== referrer.id) {
            throw new ReferralAttributionMismatchError();
          }
          return true; // already consistently linked to the same referrer
        }
        await tx.referral.create({ data: { referrerUserId: referrer.id, referredUserId: user.id } });
        return true;
      });
    } catch (err) {
      if (err instanceof ReferralAttributionMismatchError) {
        // PII-safe: a non-reversible correlation token, never the raw user id.
        logger.warn("referral attribution mismatch — kept existing attribution", {
          corr: referralCorrelationHash(user.id),
        });
        return;
      }
      throw err;
    }
    if (linked) {
      logger.info("referral applied", { corr: referralCorrelationHash(user.id) });
    }
  } catch (err) {
    logger.warn("referral parsing failed, /start continues", { error: errorMessage(err) });
  }
}

// --- config (affiliate-commission phase) -------------------------------------

/** MASTER switch: false for every install until the OWNER enables commissions. */
export async function isReferralSystemEnabled(): Promise<boolean> {
  return getBooleanSetting(REFERRAL_SYSTEM_ENABLED_KEY, false);
}

/**
 * The activation-horizon instant (the earliest payouts were ever active), or null
 * when payouts were never enabled. Kept for display + the coarse "never before the
 * first enable" guarantee; the FINE eligibility gate is the payout windows below.
 */
export async function getReferralCommissionsStartedAt(): Promise<Date | null> {
  const raw = (await getSetting(REFERRAL_COMMISSIONS_STARTED_AT_KEY, "")).trim();
  if (raw === "") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The payout ACTIVE-WINDOWS. An order earns a commission only if it completed
 * inside one of these. Backward-compatible: an install that enabled under the
 * pre-window code has a horizon but no windows row → a single OPEN window from the
 * horizon is synthesised (preserving the old "all post-horizon eligible" behaviour)
 * until the first explicit toggle materialises real windows.
 */
export async function getReferralPayoutWindows(): Promise<ReferralPayoutWindow[]> {
  const parsed = parseReferralPayoutWindowsStrict(await getSetting(REFERRAL_PAYOUT_WINDOWS_KEY, ""));
  if (!parsed.valid) {
    // Corrupt / malformed windows → FAIL CLOSED. NEVER synthesise an open window
    // from the horizon on top of an untrustworthy store (that would reopen payouts
    // and back-fill paused-period orders). Use only the trustworthy subset (often []).
    logger.warn("referral payout windows failed integrity check — failing closed", {
      issues: parsed.issues,
    });
    return parsed.windows;
  }
  if (parsed.windows.length > 0) {
    return parsed.windows;
  }
  const horizon = await getReferralCommissionsStartedAt();
  return horizon === null ? [] : [{ from: horizon.toISOString(), to: null }];
}

/** Reads the current window list inside a transaction (no cache), with the same
 *  horizon-synthesis fallback as getReferralPayoutWindows. Fail-closed: a corrupt
 *  store never synthesises an open window. */
async function readWindowsTx(
  tx: Prisma.TransactionClient,
): Promise<ReferralPayoutWindow[]> {
  const [winRow, horizonRow] = await Promise.all([
    tx.setting.findUnique({ where: { key: REFERRAL_PAYOUT_WINDOWS_KEY }, select: { value: true } }),
    tx.setting.findUnique({ where: { key: REFERRAL_COMMISSIONS_STARTED_AT_KEY }, select: { value: true } }),
  ]);
  const parsed = parseReferralPayoutWindowsStrict(winRow?.value ?? null);
  if (!parsed.valid) {
    return parsed.windows; // fail closed — never synthesise from horizon on corruption
  }
  if (parsed.windows.length > 0) {
    return parsed.windows;
  }
  return horizonRow === null ? [] : [{ from: horizonRow.value, to: null }];
}

/**
 * OWNER enables referral payouts. Stamps the activation horizon (once), OPENS a
 * payout window, and flips the master switch — ALL IN ONE TRANSACTION, so a crash
 * can never leave an orphan horizon (or window) recorded while payouts stay
 * disabled. Idempotent. Returns whether the switch actually flipped + the horizon.
 */
export async function enableReferralPayouts(
  now: Date = new Date(),
): Promise<{ flipped: boolean; startedAt: Date }> {
  const nowIso = now.toISOString();
  const result = await prisma.$transaction(async (tx) => {
    // Horizon: create-if-absent (never overwritten) — the earliest active instant.
    // `upsert` already returns the row (created or pre-existing), so there is no
    // need for a second findUnique roundtrip.
    const horizonRow = await tx.setting.upsert({
      where: { key: REFERRAL_COMMISSIONS_STARTED_AT_KEY },
      create: { key: REFERRAL_COMMISSIONS_STARTED_AT_KEY, value: nowIso, type: "STRING" },
      update: {},
      select: { value: true },
    });
    const enabledRow = await tx.setting.findUnique({
      where: { key: REFERRAL_SYSTEM_ENABLED_KEY },
      select: { value: true },
    });
    const wasEnabled = enabledRow !== null && isTruthySettingValue(enabledRow.value);
    // Open a payout window (idempotent if one is already open).
    const windows = openReferralPayoutWindow(await readWindowsTx(tx), nowIso);
    await tx.setting.upsert({
      where: { key: REFERRAL_PAYOUT_WINDOWS_KEY },
      create: { key: REFERRAL_PAYOUT_WINDOWS_KEY, value: JSON.stringify(windows), type: "STRING" },
      update: { value: JSON.stringify(windows), type: "STRING" },
    });
    await tx.setting.upsert({
      where: { key: REFERRAL_SYSTEM_ENABLED_KEY },
      create: { key: REFERRAL_SYSTEM_ENABLED_KEY, value: "true", type: "BOOLEAN" },
      update: { value: "true", type: "BOOLEAN" },
    });
    return { flipped: !wasEnabled, startedAt: horizonRow.value };
  });
  clearSettingsCache();
  return { flipped: result.flipped, startedAt: new Date(result.startedAt) };
}

/**
 * OWNER disables referral payouts. CLOSES the open payout window and flips the
 * switch in ONE transaction, so orders completed after this instant fall in a
 * window gap and are never paid, even after a later re-enable. The horizon is
 * preserved (re-enable opens a NEW window and keeps the original horizon).
 */
export async function disableReferralPayouts(now: Date = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const flipped = await prisma.$transaction(async (tx) => {
    const enabledRow = await tx.setting.findUnique({
      where: { key: REFERRAL_SYSTEM_ENABLED_KEY },
      select: { value: true },
    });
    const wasEnabled = enabledRow !== null && isTruthySettingValue(enabledRow.value);
    if (!wasEnabled) {
      return false;
    }
    const windows = closeReferralPayoutWindow(await readWindowsTx(tx), nowIso);
    await tx.setting.upsert({
      where: { key: REFERRAL_PAYOUT_WINDOWS_KEY },
      create: { key: REFERRAL_PAYOUT_WINDOWS_KEY, value: JSON.stringify(windows), type: "STRING" },
      update: { value: JSON.stringify(windows), type: "STRING" },
    });
    await tx.setting.upsert({
      where: { key: REFERRAL_SYSTEM_ENABLED_KEY },
      create: { key: REFERRAL_SYSTEM_ENABLED_KEY, value: "false", type: "BOOLEAN" },
      update: { value: "false", type: "BOOLEAN" },
    });
    return true;
  });
  if (flipped) {
    clearSettingsCache();
  }
  return flipped;
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
  /** The activation horizon (null when payouts were never enabled). */
  startedAt: Date | null;
  commissionPercent: number;
  firstPurchaseOnly: boolean;
  minPurchaseToman: number;
  totalReferrals: number;
  // GROSS payout activity ---------------------------------------------------
  /** PAID commissions (fully retained by the referrer). */
  paidCommissionCount: number;
  paidCommissionToman: number;
  /** Fully-reversed commissions (credit entirely clawed back → net 0). */
  reversedCommissionCount: number;
  reversedCommissionToman: number;
  // Debt (no-overdraft reversals awaiting recovery) --------------------------
  /** REVERSAL_PENDING commissions (a refunded order's credit not yet fully recovered). */
  reversalPendingCount: number;
  /** Outstanding (still-owed) debt across all REVERSAL_PENDING rows. */
  reversalPendingOutstandingToman: number;
  // NET (money actually retained = credited − recovered) ----------------------
  netCommissionToman: number;
}

/** Authoritative referral counts for the admin overview (read straight from the DB). */
export async function getReferralAdminStats(): Promise<ReferralAdminStats> {
  const [enabled, startedAt, config, totalReferrals, paid, reversed, pending] = await Promise.all([
    isReferralSystemEnabled(),
    getReferralCommissionsStartedAt(),
    getReferralConfig(),
    prisma.referral.count(),
    prisma.referralCommission.aggregate({ where: { status: "PAID" }, _count: true, _sum: { amountToman: true } }),
    prisma.referralCommission.aggregate({ where: { status: "REVERSED" }, _count: true, _sum: { amountToman: true } }),
    prisma.referralCommission.aggregate({
      where: { status: "REVERSAL_PENDING" },
      _count: true,
      _sum: { recoveryOutstandingToman: true },
    }),
  ]);
  const paidToman = paid._sum.amountToman ?? 0;
  const pendingOutstanding = pending._sum.recoveryOutstandingToman ?? 0;
  return {
    enabled,
    startedAt,
    commissionPercent: config.commissionPercent,
    firstPurchaseOnly: config.firstPurchaseOnly,
    minPurchaseToman: config.minPurchaseToman,
    totalReferrals,
    paidCommissionCount: paid._count,
    paidCommissionToman: paidToman,
    reversedCommissionCount: reversed._count,
    reversedCommissionToman: reversed._sum.amountToman ?? 0,
    reversalPendingCount: pending._count,
    reversalPendingOutstandingToman: pendingOutstanding,
    // NET retained = money still in referrer wallets from commissions:
    //   PAID rows in full + the un-recovered remainder of REVERSAL_PENDING rows.
    // (Fully REVERSED rows contribute 0.) Equals total credited − total recovered.
    netCommissionToman: paidToman + pendingOutstanding,
  };
}
