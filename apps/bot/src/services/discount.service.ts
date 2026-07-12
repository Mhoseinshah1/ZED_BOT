import { prisma, type DiscountCode, type Prisma, type User } from "@zedbot/database";

// =============================================================================
// Discount code validation + atomic consumption.
//
// validateDiscountCode is the READ-ONLY pre-payment check (UX only) - it
// never increments totalUsedCount and never creates DiscountCodeUsage rows.
// The single source of truth is claimDiscountUsage, executed INSIDE the
// payment transaction (wallet settle / receipt approval): it locks the
// DiscountCode row, re-validates every limit against the committed state
// and only then claims the usage. Two concurrent payments can never both
// consume the last remaining usage (total or per-user).
// =============================================================================

export type DiscountValidation =
  | {
      ok: true;
      discountCode: DiscountCode;
      discountAmountToman: number;
      finalPriceToman: number;
    }
  | { ok: false; error: string };

/** What the code is being applied to; checked against DiscountCode.appliesTo. */
export type DiscountPurpose = "PURCHASE" | "RENEWAL";

function invalid(error: string): DiscountValidation {
  return { ok: false, error };
}

/** Computes the discount amount for a price, clamped into [0, price]. */
export function calculateDiscountAmount(code: DiscountCode, priceToman: number): number {
  const amount =
    code.type === "PERCENT"
      ? Math.floor((priceToman * code.value) / 100)
      : Math.min(code.value, priceToman);
  return Math.max(0, Math.min(amount, priceToman));
}

/**
 * Validates a user-entered discount code for a purchase or (Phase 12) a
 * renewal. Lookup tries the exact input first, then the uppercase form. All
 * failures return a safe, user-friendly Persian message and never leak other
 * codes' existence rules. Usage is never incremented here - finalization
 * happens only after payment approval (Phase 8).
 */
export async function validateDiscountCode(
  rawCode: string,
  user: User,
  priceToman: number,
  purpose: DiscountPurpose = "PURCHASE",
): Promise<DiscountValidation> {
  const input = rawCode.trim();
  if (input.length === 0 || input.length > 64) {
    return invalid("کد تخفیف معتبر نیست.");
  }

  let code = await prisma.discountCode.findUnique({ where: { code: input } });
  if (code === null && input !== input.toUpperCase()) {
    code = await prisma.discountCode.findUnique({ where: { code: input.toUpperCase() } });
  }
  if (code === null || !code.isActive) {
    return invalid("کد تخفیف معتبر نیست.");
  }

  const now = new Date();
  if (code.startsAt !== null && code.startsAt > now) {
    return invalid("این کد تخفیف هنوز فعال نشده است.");
  }
  if (code.expiresAt !== null && code.expiresAt <= now) {
    return invalid("کد تخفیف منقضی شده است.");
  }
  if (code.totalUsageLimit !== null && code.totalUsedCount >= code.totalUsageLimit) {
    return invalid("سقف استفاده از این کد تخفیف تکمیل شده است.");
  }
  if (purpose === "PURCHASE" && code.appliesTo === "RENEWAL") {
    return invalid("این کد تخفیف برای خرید جدید قابل استفاده نیست.");
  }
  if (purpose === "RENEWAL" && code.appliesTo === "PURCHASE") {
    return invalid("این کد تخفیف برای تمدید سرویس قابل استفاده نیست.");
  }

  // allowedGroups: null/empty => all groups; "ALL" entry => all groups.
  const groups = code.allowedGroups;
  if (Array.isArray(groups) && groups.length > 0) {
    if (!groups.includes("ALL") && !groups.includes(user.group)) {
      return invalid("این کد تخفیف برای گروه کاربری شما مجاز نیست.");
    }
  }

  if (code.perUserUsageLimit !== null) {
    const used = await prisma.discountCodeUsage.count({
      where: { discountCodeId: code.id, userId: user.id },
    });
    if (used >= code.perUserUsageLimit) {
      return invalid("شما قبلاً از این کد تخفیف استفاده کرده‌اید.");
    }
  }

  const discountAmountToman = calculateDiscountAmount(code, priceToman);
  return {
    ok: true,
    discountCode: code,
    discountAmountToman,
    finalPriceToman: Math.max(0, priceToman - discountAmountToman),
  };
}

// --- atomic consumption (inside the payment transaction) ---------------------------

export const DISCOUNT_CLAIM_FAILED_TEXT =
  "کد تخفیف این سفارش دیگر معتبر نیست (سقف استفاده تکمیل یا منقضی شده است).";

export interface DiscountClaimArgs {
  discountCodeId: string;
  userId: string;
  orderId: string;
  checkoutSessionId: string;
  amountToman: number;
}

export type DiscountClaimOutcome =
  | { ok: true; alreadyClaimed: boolean }
  | { ok: false; safeMessage: string };

/**
 * Atomically claims one discount usage INSIDE the caller's payment
 * transaction. Must be called with the surrounding `prisma.$transaction`
 * client - a claim failure is meant to abort (roll back) the whole payment.
 *
 * Guarantees:
 *  - Idempotency (unchanged rule): at most ONE usage row per checkout -
 *    a retried/re-approved payment returns `alreadyClaimed` and never
 *    double-counts.
 *  - SECURITY-CRITICAL race safety: the DiscountCode row is locked with
 *    SELECT ... FOR NO KEY UPDATE, so every claim for one code serializes
 *    here. Active/window/total-limit checks and the per-user usage count all
 *    read the latest committed state under that lock - two concurrent
 *    payments can never both pass a `totalUsedCount = limit - 1` check, and
 *    the same user can never exceed perUserUsageLimit across concurrent
 *    orders. FOR NO KEY UPDATE (not FOR UPDATE) is deliberate: the caller's
 *    transaction has already inserted rows whose discountCodeId FK holds
 *    FOR KEY SHARE on this code row; FOR UPDATE conflicts with the OTHER
 *    payment's KEY SHARE and the two transactions deadlock (40P01), while
 *    FOR NO KEY UPDATE only conflicts with other claimers.
 *  - The usage row and the totalUsedCount increment commit together with
 *    the payment; a failed/rolled-back payment consumes nothing.
 */
export async function claimDiscountUsage(
  tx: Prisma.TransactionClient,
  args: DiscountClaimArgs,
): Promise<DiscountClaimOutcome> {
  // Idempotency first: an existing claim for this checkout short-circuits
  // WITHOUT taking the row lock (re-approvals stay cheap and re-entrant).
  const existing = await tx.discountCodeUsage.findFirst({
    where: { checkoutSessionId: args.checkoutSessionId },
    select: { id: true },
  });
  if (existing !== null) {
    return { ok: true, alreadyClaimed: true };
  }

  // Row lock: concurrent claims for the same code queue up here and each
  // sees the state left behind by the previous committed claim.
  const rows = await tx.$queryRaw<
    Array<{
      isActive: boolean;
      startsAt: Date | null;
      expiresAt: Date | null;
      totalUsageLimit: number | null;
      totalUsedCount: number;
      perUserUsageLimit: number | null;
    }>
  >`SELECT "isActive", "startsAt", "expiresAt", "totalUsageLimit", "totalUsedCount", "perUserUsageLimit"
    FROM "DiscountCode" WHERE "id" = ${args.discountCodeId} FOR NO KEY UPDATE`;
  const code = rows[0];
  const now = new Date();
  if (
    code === undefined ||
    !code.isActive ||
    (code.startsAt !== null && code.startsAt > now) ||
    (code.expiresAt !== null && code.expiresAt <= now) ||
    (code.totalUsageLimit !== null && code.totalUsedCount >= code.totalUsageLimit)
  ) {
    return { ok: false, safeMessage: DISCOUNT_CLAIM_FAILED_TEXT };
  }
  if (code.perUserUsageLimit !== null) {
    // Race-free under the row lock above: any concurrent claim for this
    // code (same user or not) has either committed its usage row already
    // or is still queued behind us.
    const used = await tx.discountCodeUsage.count({
      where: { discountCodeId: args.discountCodeId, userId: args.userId },
    });
    if (used >= code.perUserUsageLimit) {
      return { ok: false, safeMessage: DISCOUNT_CLAIM_FAILED_TEXT };
    }
  }

  await tx.discountCodeUsage.create({
    data: {
      discountCodeId: args.discountCodeId,
      userId: args.userId,
      orderId: args.orderId,
      checkoutSessionId: args.checkoutSessionId,
      amountToman: args.amountToman,
    },
  });
  // Guarded increment (belt over the row lock): zero matches means the row
  // vanished/deactivated between lock and update - impossible while we hold
  // the lock, but a failed claim must never pass silently.
  const bumped = await tx.discountCode.updateMany({
    where: { id: args.discountCodeId, isActive: true },
    data: { totalUsedCount: { increment: 1 } },
  });
  if (bumped.count !== 1) {
    return { ok: false, safeMessage: DISCOUNT_CLAIM_FAILED_TEXT };
  }
  return { ok: true, alreadyClaimed: false };
}
