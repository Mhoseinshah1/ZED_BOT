import { type Admin } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { buildAdminMainMenuDefinition } from "./admin-menu-definition.js";

/**
 * Admin main menu - the INLINE rendering of the shared definition
 * (admin-menu-definition.ts): same approved rows, same stable callbacks,
 * operator-editable labels (admin-menu-keyboard-mode phase; the historical
 * hardcoded labels are now the seeded ButtonText defaults, so existing
 * installations render byte-identically).
 *
 * Corrective Fix A: «رسیدهای تایید نشده 💵» moved off the root into the
 * finance landing (financeLandingKeyboard) - CB.ADMIN_RECEIPTS and its
 * handler stay fully active for old Telegram keyboards. The unfinished
 * placeholder sections (panel features, bot update, tutorials, mini-app,
 * custom service price) are not rendered here either; their callbacks keep
 * answering via admin-placeholders.handler.
 */
export async function buildAdminMainKeyboard(
  admin: Admin | null | undefined,
): Promise<InlineKeyboard> {
  const rows = await buildAdminMainMenuDefinition(admin);
  return new InlineKeyboard(
    rows.map((row) => row.map((button) => InlineKeyboard.text(button.label, button.callback))),
  );
}
