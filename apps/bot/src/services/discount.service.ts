import { prisma, type DiscountCode, type User } from "@zedbot/database";

// =============================================================================
// Discount code validation (read-only foundation).
//
// This phase NEVER increments totalUsedCount and NEVER creates
// DiscountCodeUsage rows - usage is finalized only after a successful payment
// in a later phase. Existing usage rows still count toward limits.
// =============================================================================

export type DiscountValidation =
  | {
      ok: true;
      discountCode: DiscountCode;
      discountAmountToman: number;
      finalPriceToman: number;
    }
  | { ok: false; error: string };

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
 * Validates a user-entered discount code for a new purchase. Lookup tries the
 * exact input first, then the uppercase form. All failures return a safe,
 * user-friendly Persian message and never leak other codes' existence rules.
 */
export async function validateDiscountCode(
  rawCode: string,
  user: User,
  priceToman: number,
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
  if (code.appliesTo === "RENEWAL") {
    return invalid("این کد تخفیف برای خرید جدید قابل استفاده نیست.");
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
