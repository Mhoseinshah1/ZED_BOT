import { InlineKeyboard } from "grammy";

import { buildUserMainMenuDefinition } from "./user-menu-definition.js";

/**
 * Main user menu - button texts come from the database (operator-editable
 * ButtonText rows; Phase 34 admin editing).
 *
 * Only IMPLEMENTED sections are visible. The unfinished placeholder
 * sections (referral, lucky_wheel, tutorials, pricing,
 * representative_request) are HIDDEN from the menu until their real flows
 * land - their callbacks stay registered in user-placeholders.handler.ts so
 * buttons on old Telegram messages keep answering instead of dead-ending.
 *
 * Free-trial phase: «اکانت تست رایگان 🎁» (ButtonText free_test) renders
 * ONLY when the feature is globally enabled AND at least one trial-ready
 * panel exists - a fully operational section or no button at all, never a
 * visible placeholder.
 *
 * LOCKED layout decisions:
 *  - «خرید اشتراک» opens the existing subscription purchase flow
 *    (CB.USER_BUY) - unchanged.
 *  - «محصولات دیگر» stays a SEPARATE section (CB.USER_OTHER_PRODUCTS) -
 *    never merged into the subscription purchase.
 */
export async function buildUserMainKeyboard(): Promise<InlineKeyboard> {
  // Menu-keyboard-mode phase: rendered from the ONE shared menu definition
  // (rows/labels/visibility identical to the reply-keyboard mode); the
  // approved inline layout and stable callbacks are unchanged.
  const rows = await buildUserMainMenuDefinition();
  return new InlineKeyboard(
    rows.map((row) => row.map((button) => InlineKeyboard.text(button.label, button.callback))),
  );
}
