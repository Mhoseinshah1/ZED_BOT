import { InlineKeyboard } from "grammy";

import {
  buildUserMainMenuDefinition,
  type UserMainMenuViewer,
} from "./user-menu-definition.js";

/**
 * Main user menu - button texts come from the database (operator-editable
 * ButtonText rows; Phase 34 admin editing).
 *
 * Only IMPLEMENTED sections are visible. The remaining unfinished placeholder
 * sections (lucky_wheel, tutorials) are HIDDEN from the menu until their real
 * flows land - their callbacks stay registered in user-placeholders.handler.ts
 * so buttons on old Telegram messages keep answering instead of dead-ending.
 * «تعرفه‌ها» (CB.USER_PRICING) is now a real, always-visible standalone row
 * (feat/public-pricing-catalog).
 *
 * Free-trial phase: «اکانت تست رایگان 🎁» (ButtonText free_test) renders
 * ONLY when the feature is globally enabled AND at least one trial-ready
 * panel exists - a fully operational section or no button at all, never a
 * visible placeholder.
 *
 * LAYOUT invariant (admin-controlled unified purchase menu):
 *  - «خرید اشتراک» (CB.USER_BUY) and «محصولات دیگر» (CB.USER_OTHER_PRODUCTS) are
 *    two SEPARATE business flows and stay separate — no flow is ever merged.
 *  - Only their main-menu ENTRY BUTTONS may be combined: in COMBINED mode the two
 *    buttons are replaced by a single «خرید محصولات 🛒» (CB.USER_PURCHASE_HUB)
 *    that opens a purchase hub from which the SAME two flows are entered. The
 *    OWNER's `user_combined_purchase_menu_enabled` setting selects the layout;
 *    it is presentation only and never gates a flow (both callbacks stay valid
 *    in every layout, on old inline keyboards and stale reply keyboards alike).
 */
export async function buildUserMainKeyboard(viewer?: UserMainMenuViewer): Promise<InlineKeyboard> {
  // Menu-keyboard-mode phase: rendered from the ONE shared menu definition
  // (rows/labels/visibility identical to the reply-keyboard mode); the
  // approved inline layout and stable callbacks are unchanged. The viewer
  // gates the active-admin-only final row (absent viewer = hidden).
  const rows = await buildUserMainMenuDefinition(viewer);
  return new InlineKeyboard(
    rows.map((row) => row.map((button) => InlineKeyboard.text(button.label, button.callback))),
  );
}
