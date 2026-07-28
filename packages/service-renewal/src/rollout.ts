import { prisma, SettingType, type Prisma, type PrismaClient } from "@zedbot/database";

import {
  MINIAPP_WALLET_RENEWAL_ENABLED_DEFAULT,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
} from "./contract.js";

// =============================================================================
// The rollout gate for Mini App wallet renewal.
//
// READ FRESH, EVERY TIME, ON BOTH SIDES OF THE FLOW. The Bot's settings service
// caches, which is right for a label or a page of instructions and wrong for
// this: a kill switch that takes a cache TTL to take effect is not a kill
// switch. When an operator turns this off it is usually because money is moving
// somewhere it should not, and the next confirmation must already see `false`.
// So this reads the row directly rather than going through any cache, and the
// quote and the confirmation each read it independently — a quote issued while
// enabled must not authorise a settlement after it was disabled.
//
// FAIL CLOSED ON EVERYTHING. Missing row, malformed value, unreadable database:
// all return `false`. The cost of a false negative is a user seeing "not
// available right now" on a feature that was meant to be on. The cost of a
// false positive is a charge the operator had switched off. Those are not
// comparable, so the ambiguous cases all resolve the safe way.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The stored strings this project treats as boolean true.
 *
 * Matched exactly rather than by truthiness: `"false"` is a non-empty string
 * and would be true under a naive check, which is the classic way a disabled
 * flag turns itself on.
 */
const TRUE_VALUES = new Set(["true", "1", "on", "yes"]);

/**
 * Whether Mini App wallet renewal is enabled right now.
 *
 * Never throws. A caller on a request path that is already failing must not be
 * handed a second failure by the gate that was supposed to protect it.
 */
export async function isMiniAppWalletRenewalEnabled(db: Db = prisma): Promise<boolean> {
  try {
    const row = await db.setting.findUnique({
      where: { key: MINIAPP_WALLET_RENEWAL_ENABLED_KEY },
      select: { value: true },
    });
    if (row === null) {
      return MINIAPP_WALLET_RENEWAL_ENABLED_DEFAULT;
    }
    return TRUE_VALUES.has(row.value.trim().toLowerCase());
  } catch {
    // The database is the authority; with no answer from it there is no
    // authority, and an unauthorised charge is the one outcome worth avoiding.
    return false;
  }
}

/**
 * Writes the switch. OWNER-only enforcement belongs to the caller's transport —
 * this function is the storage contract, not the permission check.
 *
 * Upserts so an install that predates the seed can still be switched on without
 * a migration, and stores the canonical `"true"`/`"false"` spelling so the value
 * an operator sees in the settings table reads the way they expect.
 */
export async function setMiniAppWalletRenewalEnabled(
  enabled: boolean,
  db: Db = prisma,
): Promise<void> {
  const value = enabled ? "true" : "false";
  await db.setting.upsert({
    where: { key: MINIAPP_WALLET_RENEWAL_ENABLED_KEY },
    update: { value },
    create: {
      key: MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
      value,
      type: SettingType.BOOLEAN,
      // Not public: the Mini App learns whether renewal is available from the
      // renewal-options response, which is owner-scoped and already gated. A
      // public setting would announce the rollout to every unauthenticated
      // caller and turn the switch itself into a signal.
      isPublic: false,
    },
  });
}
