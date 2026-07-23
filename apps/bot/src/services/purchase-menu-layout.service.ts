import {
  purchaseMenuLayout,
  USER_COMBINED_PURCHASE_MENU_ENABLED_KEY,
  type PurchaseMenuLayout,
} from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  getBooleanSetting,
  setSetting,
} from "./settings.service.js";

// =============================================================================
// Admin-controlled unified purchase menu (feat/admin-controlled-unified-purchase-menu, §3).
// The ONE typed accessor for the purchase-layout setting. Same pattern as the
// representative / free-trial rollout switches: the KEY lives in @zedbot/shared,
// the value defaults FALSE (split) so existing AND fresh installs keep the two
// separate purchase buttons with no migration. The setting selects menu
// PRESENTATION only — it never authorizes or disables a business flow, so both
// the VPN subscription and Other-Products entry points stay reachable in every
// layout.
// =============================================================================

/**
 * Whether the COMBINED purchase layout is active. Missing / invalid / falsy →
 * false (split). Cached via the shared 30s settings cache; a mutation refreshes
 * the cache entry immediately so the OWNER's own next menu render is correct.
 */
export async function isCombinedPurchaseMenuEnabled(): Promise<boolean> {
  return getBooleanSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY, false);
}

/** The current layout as a machine code (SPLIT | COMBINED). */
export async function currentPurchaseMenuLayout(): Promise<PurchaseMenuLayout> {
  return purchaseMenuLayout(await isCombinedPurchaseMenuEnabled());
}

/**
 * Plain (non-atomic) write. Used only where a single writer is guaranteed; the
 * admin confirmation path uses the compare-and-set below instead.
 */
export async function setCombinedPurchaseMenuEnabled(enabled: boolean): Promise<void> {
  await setSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

/**
 * Atomic compare-and-set for the OWNER confirmation action: flips the stored
 * value to `next` ONLY while its current boolean interpretation still equals
 * `expected`. There is no read-check-write window, so two concurrent OWNER
 * confirmations can never both "win" the same transition and a stale
 * confirmation (the stored state already moved on) returns false. Delegates to
 * the shared primitive, which also refreshes the settings cache on success.
 */
export function compareAndSetCombinedPurchaseMenuEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(
    USER_COMBINED_PURCHASE_MENU_ENABLED_KEY,
    expected,
    next,
  );
}
