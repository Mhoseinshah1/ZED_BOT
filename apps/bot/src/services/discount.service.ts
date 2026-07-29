import type { DiscountCode, Prisma, User } from "@zedbot/database";
import {
  calculateDiscountAmount,
  claimDiscountUsage as claimDiscountUsageShared,
  validateDiscountCode as validateDiscountCodeShared,
  type DiscountClaimArgs,
  type DiscountPurpose,
  type DiscountRejection,
} from "@zedbot/service-renewal";

// =============================================================================
// The bot's words for the discount rules.
//
// The RULES live in @zedbot/service-renewal, because the Mini App API reaches
// the same verdicts and a second copy of "is this code still valid" would
// disagree with the first the day either is edited — about money.
//
// What stays here is the Persian. The domain returns a code from a closed set;
// this module maps each code to the exact sentence the bot printed before the
// move, so every handler's user-visible text is byte-identical and no call site
// changed. That is the seam the package header describes: the domain decides,
// the transport speaks.
// =============================================================================

export type { DiscountPurpose, DiscountClaimArgs };

export { calculateDiscountAmount };

export type DiscountValidation =
  | {
      ok: true;
      discountCode: DiscountCode;
      discountAmountToman: number;
      finalPriceToman: number;
    }
  | { ok: false; error: string };

/**
 * The sentence the bot shows for each refusal reason.
 *
 * MALFORMED and UNKNOWN deliberately share one sentence — that is what the bot
 * has always said, and it keeps "no such code" from being distinguishable from
 * "that is not a code shape".
 */
const REJECTION_TEXT: Record<DiscountRejection, string> = {
  MALFORMED: "کد تخفیف معتبر نیست.",
  UNKNOWN: "کد تخفیف معتبر نیست.",
  NOT_STARTED: "این کد تخفیف هنوز فعال نشده است.",
  EXPIRED: "مهلت استفاده از این کد تخفیف به پایان رسیده است.",
  EXHAUSTED: "ظرفیت استفاده از این کد تخفیف تکمیل شده است.",
  NOT_FOR_PURCHASE: "این کد تخفیف برای خرید جدید قابل استفاده نیست.",
  NOT_FOR_RENEWAL: "این کد تخفیف برای تمدید سرویس قابل استفاده نیست.",
  GROUP_NOT_ALLOWED: "این کد تخفیف برای گروه کاربری شما مجاز نیست.",
  USER_LIMIT_REACHED: "شما قبلاً از این کد تخفیف به حداکثر تعداد مجاز استفاده کرده‌اید.",
};

/**
 * Validates a user-entered discount code for a purchase or a renewal. All
 * failures return a safe, user-friendly Persian message and never leak other
 * codes' existence rules.
 */
export async function validateDiscountCode(
  rawCode: string,
  user: User,
  priceToman: number,
  purpose: DiscountPurpose = "PURCHASE",
): Promise<DiscountValidation> {
  const result = await validateDiscountCodeShared(rawCode, user, priceToman, purpose);
  if (result.ok) {
    return result;
  }
  return { ok: false, error: REJECTION_TEXT[result.reason] };
}

// --- atomic consumption (inside the payment transaction) ---------------------

export const DISCOUNT_CLAIM_FAILED_TEXT =
  "کد تخفیف این سفارش دیگر معتبر نیست (سقف استفاده تکمیل یا منقضی شده است).";

export type DiscountClaimOutcome =
  | { ok: true; alreadyClaimed: boolean }
  | { ok: false; safeMessage: string };

/**
 * Atomically claims one discount usage INSIDE the caller's payment transaction.
 * See `@zedbot/service-renewal`'s `claimDiscountUsage` for the locking and
 * idempotency guarantees; this wrapper only supplies the Persian sentence.
 */
export async function claimDiscountUsage(
  tx: Prisma.TransactionClient,
  args: DiscountClaimArgs,
): Promise<DiscountClaimOutcome> {
  const result = await claimDiscountUsageShared(tx, args);
  if (result.ok) {
    return result;
  }
  return { ok: false, safeMessage: DISCOUNT_CLAIM_FAILED_TEXT };
}
