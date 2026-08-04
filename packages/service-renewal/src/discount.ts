import { prisma, type DiscountCode, type Prisma, type PrismaClient, type User } from "@zedbot/database";

// =============================================================================
// Discount code validation and atomic consumption.
//
// TWO FUNCTIONS, AND ONLY ONE OF THEM IS AUTHORITATIVE.
//
// `validateDiscountCode` is the READ-ONLY pre-payment check. It exists for the
// screen: it tells someone typing a code whether it will work, and it never
// increments a counter or writes a usage row. Its answer is advice.
//
// `claimDiscountUsage` is the source of truth. It runs INSIDE the payment
// transaction, locks the DiscountCode row, re-validates every limit against the
// committed state and only then claims. Two concurrent payments cannot both
// consume the last remaining usage, and a rolled-back payment consumes nothing.
// The pre-payment answer is never trusted here — it was computed against a world
// that may have moved on.
//
// WHY THE PERSIAN LEFT. These functions used to return the sentence the user
// reads. That made them un-importable by the Mini App API, which needs the same
// verdict but renders its own words in its own i18n. They now return a code from
// a closed set, and `apps/bot/src/services/discount.service.ts` maps each code
// back to exactly the sentence it printed before — the bot's wording is
// unchanged, and the rules have one implementation.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/** What the code is being applied to; checked against DiscountCode.appliesTo. */
export type DiscountPurpose = "PURCHASE" | "RENEWAL";

/**
 * Every reason a code can be refused.
 *
 * A CLOSED SET, and finer-grained than the Mini App's single `DISCOUNT_INVALID`
 * on purpose: the bot already tells a user "this code has expired" versus "you
 * have already used this code", and parity means the Mini App can say the same
 * things. Unlike a service id, a discount code is something the user typed and
 * usually got from an advertisement — telling them why it did not work is help,
 * not disclosure. Nothing here names another code, another user, or a row id.
 */
export type DiscountRejection =
  | "MALFORMED"
  | "UNKNOWN"
  | "NOT_STARTED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "NOT_FOR_PURCHASE"
  | "NOT_FOR_RENEWAL"
  | "GROUP_NOT_ALLOWED"
  | "USER_LIMIT_REACHED";

export type DiscountValidation =
  | {
      ok: true;
      discountCode: DiscountCode;
      discountAmountToman: number;
      finalPriceToman: number;
    }
  | { ok: false; reason: DiscountRejection };

/** Computes the discount amount for a price, clamped into [0, price]. */
export function calculateDiscountAmount(code: DiscountCode, priceToman: number): number {
  const amount =
    code.type === "PERCENT"
      ? Math.floor((priceToman * code.value) / 100)
      : Math.min(code.value, priceToman);
  return Math.max(0, Math.min(amount, priceToman));
}

/**
 * Validates a user-entered discount code for a purchase or a renewal.
 *
 * Lookup tries the exact input first, then the uppercase form, so a code
 * advertised in capitals still works when typed in lower case. Usage is never
 * incremented here — finalization happens only inside the payment transaction.
 */
export async function validateDiscountCode(
  rawCode: string,
  user: Pick<User, "id" | "group">,
  priceToman: number,
  purpose: DiscountPurpose = "PURCHASE",
  db: Db = prisma,
): Promise<DiscountValidation> {
  const input = rawCode.trim();
  if (input.length === 0 || input.length > 64) {
    return { ok: false, reason: "MALFORMED" };
  }

  let code = await db.discountCode.findUnique({ where: { code: input } });
  if (code === null && input !== input.toUpperCase()) {
    code = await db.discountCode.findUnique({ where: { code: input.toUpperCase() } });
  }
  // An inactive code is reported as UNKNOWN, not as "disabled": whether a code
  // exists but is switched off is the operator's business, not a probe's.
  if (code === null || !code.isActive) {
    return { ok: false, reason: "UNKNOWN" };
  }

  const now = new Date();
  if (code.startsAt !== null && code.startsAt > now) {
    return { ok: false, reason: "NOT_STARTED" };
  }
  if (code.expiresAt !== null && code.expiresAt <= now) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (code.totalUsageLimit !== null && code.totalUsedCount >= code.totalUsageLimit) {
    return { ok: false, reason: "EXHAUSTED" };
  }
  if (purpose === "PURCHASE" && code.appliesTo === "RENEWAL") {
    return { ok: false, reason: "NOT_FOR_PURCHASE" };
  }
  if (purpose === "RENEWAL" && code.appliesTo === "PURCHASE") {
    return { ok: false, reason: "NOT_FOR_RENEWAL" };
  }

  // allowedGroups: null/empty => all groups; "ALL" entry => all groups.
  const groups = code.allowedGroups;
  if (Array.isArray(groups) && groups.length > 0) {
    if (!groups.includes("ALL") && !groups.includes(user.group)) {
      return { ok: false, reason: "GROUP_NOT_ALLOWED" };
    }
  }

  if (code.perUserUsageLimit !== null) {
    const used = await db.discountCodeUsage.count({
      where: { discountCodeId: code.id, userId: user.id },
    });
    if (used >= code.perUserUsageLimit) {
      return { ok: false, reason: "USER_LIMIT_REACHED" };
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

// --- atomic consumption (inside the payment transaction) ---------------------

export interface DiscountClaimArgs {
  discountCodeId: string;
  userId: string;
  orderId: string;
  checkoutSessionId: string;
  amountToman: number;
}

export type DiscountClaimOutcome =
  | { ok: true; alreadyClaimed: boolean }
  | { ok: false; reason: "CLAIM_FAILED" };

/**
 * Atomically claims one discount usage INSIDE the caller's payment transaction.
 * Must be called with the surrounding `prisma.$transaction` client — a claim
 * failure is meant to abort (roll back) the whole payment.
 *
 * Guarantees:
 *  - Idempotency: at most ONE usage row per checkout — a retried/re-approved
 *    payment returns `alreadyClaimed` and never double-counts.
 *  - SECURITY-CRITICAL race safety: the DiscountCode row is locked with
 *    SELECT ... FOR NO KEY UPDATE, so every claim for one code serializes here.
 *    Active/window/total-limit checks and the per-user usage count all read the
 *    latest committed state under that lock — two concurrent payments can never
 *    both pass a `totalUsedCount = limit - 1` check, and the same user can never
 *    exceed perUserUsageLimit across concurrent orders. FOR NO KEY UPDATE (not
 *    FOR UPDATE) is deliberate: the caller's transaction has already inserted
 *    rows whose discountCodeId FK holds FOR KEY SHARE on this code row; FOR
 *    UPDATE conflicts with the OTHER payment's KEY SHARE and the two
 *    transactions deadlock (40P01), while FOR NO KEY UPDATE only conflicts with
 *    other claimers.
 *  - The usage row and the totalUsedCount increment commit together with the
 *    payment; a failed/rolled-back payment consumes nothing.
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

  // Row lock: concurrent claims for the same code queue up here and each sees
  // the state left behind by the previous committed claim.
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
    return { ok: false, reason: "CLAIM_FAILED" };
  }
  if (code.perUserUsageLimit !== null) {
    // Race-free under the row lock above: any concurrent claim for this code
    // (same user or not) has either committed its usage row already or is still
    // queued behind us.
    const used = await tx.discountCodeUsage.count({
      where: { discountCodeId: args.discountCodeId, userId: args.userId },
    });
    if (used >= code.perUserUsageLimit) {
      return { ok: false, reason: "CLAIM_FAILED" };
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
  // vanished/deactivated between lock and update — impossible while we hold the
  // lock, but a failed claim must never pass silently.
  const bumped = await tx.discountCode.updateMany({
    where: { id: args.discountCodeId, isActive: true },
    data: { totalUsedCount: { increment: 1 } },
  });
  if (bumped.count !== 1) {
    return { ok: false, reason: "CLAIM_FAILED" };
  }
  return { ok: true, alreadyClaimed: false };
}
