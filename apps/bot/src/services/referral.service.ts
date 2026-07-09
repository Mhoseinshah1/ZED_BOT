import { prisma, type User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";

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
