import { Composer } from "grammy";

import type { BotContext } from "../core/context.js";
import {
  resolveAdminMainMenuAction,
  type AdminMainMenuAction,
} from "../keyboards/admin-menu-definition.js";
import { resolveMainMenuAction } from "../keyboards/user-menu-definition.js";
import { getAdminMenuMode, getUserMenuMode } from "../services/menu-mode.service.js";
import { safeReply } from "../utils/safe-reply.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import { showUserMenu } from "./menu.handler.js";
import { renderLanding as renderBroadcastLanding } from "./admin-broadcast/broadcast.handler.js";
import { renderFinanceLanding } from "./admin-finance/admin-finance.handler.js";
import { renderLanding as renderManualOrdersLanding } from "./admin-manual-orders/manual-orders.handler.js";
import { renderLanding as renderReportsBackupLanding } from "./admin-reports-backup/reports-backup.handler.js";
import { renderSettingsLanding } from "./admin-settings/text-settings.handler.js";
import { renderLanding as renderAdminSupportLanding } from "./admin-support/support-admin.handler.js";
import { renderLanding as renderAdminUsersLanding } from "./admin-users/admin-users.handler.js";
import { renderPanelMenu } from "./panels/panel.handler.js";
import { showProductMenu } from "./products/product.handler.js";

// =============================================================================
// Shared ADMIN main-menu action dispatch (admin-menu-keyboard-mode phase):
// the ONE mapping from language-neutral admin menu actions to the exact
// section landing functions the inline callbacks already use - reply-keyboard
// taps and inline clicks run identical section entries, with every deeper
// role gate (OWNER-only reconciliation/backup/trial pages, ...) living
// inside those sections exactly as before. No callback queries are
// synthesized, no business logic is duplicated and NO mutation happens here:
// every action is a safe top-level navigation render.
// =============================================================================

/** Safe denial for unauthorized senders of an admin menu label. */
export const ADMIN_MENU_ACCESS_DENIED_TEXT =
  "شما دسترسی لازم برای ورود به این بخش را ندارید.";

/**
 * The admin main-menu SECTION actions - everything except the two-way exit
 * (RETURN_TO_USER_MENU), which is not a business section and is dispatched
 * separately (ensureUserAccess -> showUserMenu) in the router below.
 */
type AdminMainMenuSectionAction = Exclude<AdminMainMenuAction, "RETURN_TO_USER_MENU">;

const ACTION_HANDLERS: Record<AdminMainMenuSectionAction, (ctx: BotContext) => Promise<void>> = {
  FINANCE: renderFinanceLanding,
  USERS: renderAdminUsersLanding,
  PRODUCTS: showProductMenu,
  PANELS: renderPanelMenu,
  OTHER_PRODUCTS: renderManualOrdersLanding,
  SUPPORT_TICKETS: renderAdminSupportLanding,
  BROADCAST: renderBroadcastLanding,
  GENERAL_SETTINGS: renderSettingsLanding,
  REPORTS_BACKUP: renderReportsBackupLanding,
};

/** Opens one admin main-menu section - the same entry the callback uses. */
export async function openAdminMainMenuSection(
  ctx: BotContext,
  action: AdminMainMenuSectionAction,
): Promise<void> {
  await ACTION_HANDLERS[action](ctx);
}

/**
 * ADMIN reply-keyboard text router. Registered AFTER the flow-gated message
 * dispatcher and BEFORE the user menu router in app.ts, giving the approved
 * priority: command -> active conversation flow -> admin reply action ->
 * user reply action -> fallback. It only ever acts when:
 *   - no conversational flow is active (defense in depth),
 *   - the text is not a command,
 *   - the ADMIN menu mode is REPLY,
 *   - the trimmed text EXACTLY matches one current admin main-menu label.
 * Matching text alone NEVER authorizes anything: a non-admin (or a
 * deactivated admin still carrying the old persistent keyboard) gets only
 * the safe denial - unless the same text is also a live USER menu label,
 * which keeps routing for them in their own context. Every reachable action
 * is a top-level navigation render; sensitive operations stay behind inline
 * callbacks + confirmations and are unreachable from text by construction.
 */
export const adminMenuTextRouter = new Composer<BotContext>();

adminMenuTextRouter.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== null) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    return next(); // commands keep their existing priority
  }
  if ((await getAdminMenuMode()) !== "REPLY") {
    return next();
  }
  const resolution = await resolveAdminMainMenuAction(text, ctx.admin);
  if (!resolution.matched) {
    return next(); // arbitrary text is never navigation
  }
  if (!resolution.authorized) {
    // A label shared with the live USER menu stays a user action for
    // non-admins (separate contexts); otherwise deny safely.
    if ((await getUserMenuMode()) === "REPLY" && (await resolveMainMenuAction(text)) !== null) {
      return next();
    }
    await safeReply(ctx, ADMIN_MENU_ACCESS_DENIED_TEXT);
    return;
  }
  if (resolution.action === "RETURN_TO_USER_MENU") {
    // The return button lives in the admin menu, so the sender is already a
    // resolved active admin here - but the destination is the USER surface.
    // Admin access NEVER bypasses the user-area gates (blocked/maintenance/
    // terms/force-join), so apply them explicitly before showing the user
    // menu; the inline twin (CB.USER_MENU) is gated by userAccessMiddleware.
    // Reuse showUserMenu so every keyboard-transition + session flag stays in
    // one place (no duplicated rendering/state handling).
    if (!(await ensureUserAccess(ctx))) {
      return;
    }
    await showUserMenu(ctx);
    return;
  }
  await openAdminMainMenuSection(ctx, resolution.action);
});
