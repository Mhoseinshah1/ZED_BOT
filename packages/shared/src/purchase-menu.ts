// =============================================================================
// Admin-controlled unified purchase menu (feat/admin-controlled-unified-purchase-menu)
// — shared contract.
//
// A single OWNER-controlled setting selects how the user main-menu purchase
// entry is laid out: the historical SPLIT layout (two buttons — «خرید اشتراک»
// and «محصولات دیگر») or a COMBINED layout (one «خرید محصولات 🛒» button that
// opens a purchase hub). The setting controls MENU PRESENTATION ONLY — it never
// authorizes or disables a business flow, so both existing checkout entry points
// (VPN subscription + Other Products) stay reachable in every layout.
//
// Design rules (same as representative-program.ts / referral.ts):
//   * Behaviour is driven by these machine CODES ONLY — never by comparing
//     Persian strings. Persian rendering lives in the bot view layer.
//   * This module imports NOTHING from @zedbot/database or the bot — pure data +
//     pure functions, so the api/worker/tests can consume it too.
//   * The audit event is privacy-MINIMAL: it carries the previous/next layout and
//     the actor role only — never a Telegram id, user id, ADMIN id, label,
//     callback payload or Product/payment data. It is written with NO relation id
//     (adminId/userId/orderId/…), so every SystemLog relation-id column stays null;
//     the actor's identity is revalidated at mutation time but never persisted here.
// =============================================================================

// --- rollout setting ---------------------------------------------------------

/**
 * Master switch for the COMBINED purchase layout. Missing / invalid / falsy →
 * the historical SPLIT layout, so existing AND fresh installations keep the two
 * separate purchase buttons with no migration. Default FALSE.
 */
export const USER_COMBINED_PURCHASE_MENU_ENABLED_KEY = "user_combined_purchase_menu_enabled";

// --- layout code machine -----------------------------------------------------

export const PURCHASE_MENU_LAYOUTS = ["SPLIT", "COMBINED"] as const;
export type PurchaseMenuLayout = (typeof PURCHASE_MENU_LAYOUTS)[number];

/** The layout that a boolean "combined enabled" flag maps to. */
export function purchaseMenuLayout(combinedEnabled: boolean): PurchaseMenuLayout {
  return combinedEnabled ? "COMBINED" : "SPLIT";
}

/**
 * The numeric code carried in admin confirmation callbacks (`0` = split, `1` =
 * combined). It is the CURRENT observed layout so a stale confirmation can be
 * detected: `1` ⇔ combined-enabled=true, `0` ⇔ combined-enabled=false. Anything
 * that is not exactly `"1"` fails closed to `0` (split) — never a silent enable.
 */
export function purchaseLayoutCode(combinedEnabled: boolean): "0" | "1" {
  return combinedEnabled ? "1" : "0";
}

/**
 * Parses the expected-code parameter from a confirmation callback back into the
 * observed "combined enabled" boolean. Only the exact literal `"1"` is treated
 * as combined; every other value (including malformed input) is split=false, so
 * a forged/garbled callback can never be read as "was already combined".
 */
export function parsePurchaseLayoutExpectedCombined(raw: string): boolean {
  return raw === "1";
}

// --- privacy-safe audit event ------------------------------------------------

/** Audit marker written when the OWNER flips the purchase layout. Privacy-minimal:
 * metadata is EXACTLY { previousLayout, nextLayout, actorRole } and the row carries
 * NO relation id (adminId/userId/orderId/paymentId/serviceId all null); the writer
 * stamps the timestamp. */
export const USER_MENU_PURCHASE_LAYOUT_CHANGED_EVENT = "user_menu.purchase_layout_changed";
