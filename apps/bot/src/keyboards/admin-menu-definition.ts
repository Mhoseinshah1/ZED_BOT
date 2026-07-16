import { type Admin } from "@zedbot/database";
import { Keyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { getButtonText } from "../services/text.service.js";

// =============================================================================
// The ONE admin main-menu definition (admin-menu-keyboard-mode phase): the
// approved rows, language-neutral action identities, operator-editable
// labels and the shared visibility policy. Both renderers - the inline
// keyboard in admin-main.keyboard.ts and the reply keyboard below - consume
// THIS definition, so the two modes can never drift apart. Action identity
// NEVER derives from the Persian label, reply buttons carry ONLY safe
// top-level navigation (no entity ids, no mutations), and matching a label
// never authorizes anything by itself.
// =============================================================================

/** Language-neutral identity of every admin main-menu action. */
export type AdminMainMenuAction =
  | "FINANCE"
  | "USERS"
  | "PRODUCTS"
  | "PANELS"
  | "OTHER_PRODUCTS"
  | "SUPPORT_TICKETS"
  | "BROADCAST"
  | "GENERAL_SETTINGS"
  | "REPORTS_BACKUP";

export interface AdminMainMenuButton {
  action: AdminMainMenuAction;
  /** ButtonText registry key - the label is always the CURRENT edited value. */
  buttonKey: string;
  /** Operator-editable visible label (verbatim from the registry). */
  label: string;
  /** Stable inline callback (unchanged - the approved contract). */
  callback: string;
}

/** action -> {buttonKey, callback}: the stable, label-independent wiring. */
export const ADMIN_MAIN_MENU_ACTION_WIRING: Record<
  AdminMainMenuAction,
  { buttonKey: string; callback: string }
> = {
  FINANCE: { buttonKey: "admin_finance", callback: CB.ADMIN_FINANCE },
  USERS: { buttonKey: "admin_users", callback: CB.ADMIN_USERS },
  PRODUCTS: { buttonKey: "admin_products", callback: CB.ADMIN_PRODUCTS },
  PANELS: { buttonKey: "admin_panels", callback: CB.ADMIN_PANELS },
  OTHER_PRODUCTS: { buttonKey: "admin_other_products", callback: CB.ADMIN_OTHER_PRODUCTS },
  SUPPORT_TICKETS: { buttonKey: "admin_support_tickets", callback: CB.ADMIN_SUPPORT },
  BROADCAST: { buttonKey: "admin_broadcast", callback: CB.ADMIN_BROADCAST },
  GENERAL_SETTINGS: { buttonKey: "admin_general_settings", callback: CB.ADMIN_GENERAL_SETTINGS },
  REPORTS_BACKUP: { buttonKey: "admin_reports_backup", callback: CB.ADMIN_REPORTS_BACKUP },
};

/** The 9 admin main-menu ButtonText keys (duplicate-label guard scope). */
export const ADMIN_MAIN_MENU_BUTTON_KEYS: string[] = Object.values(
  ADMIN_MAIN_MENU_ACTION_WIRING,
).map((w) => w.buttonKey);

/** The approved row layout (identical to the historical inline menu). */
const APPROVED_ROWS: AdminMainMenuAction[][] = [
  ["FINANCE", "USERS"],
  ["PRODUCTS", "PANELS"],
  ["OTHER_PRODUCTS"],
  ["SUPPORT_TICKETS", "BROADCAST"],
  ["GENERAL_SETTINGS", "REPORTS_BACKUP"],
];

/**
 * Visibility policy, shared by BOTH renderers and the text resolver. The
 * approved admin main menu is currently identical for every ACTIVE admin
 * (role gates live inside the sections themselves, e.g. the OWNER-only
 * reconciliation, backup and trial-settings pages) - centralized RBAC is a
 * documented separate task, and this hook is where per-role hiding lands
 * when it does. A missing/inactive admin sees NO admin menu at all
 * (fail-closed, undefined included - never trust the caller's typing).
 */
function visibleActions(admin: Admin | null | undefined): Set<AdminMainMenuAction> {
  if (admin === null || admin === undefined || !admin.isActive) {
    return new Set();
  }
  return new Set(Object.keys(ADMIN_MAIN_MENU_ACTION_WIRING) as AdminMainMenuAction[]);
}

/**
 * The current admin menu definition: approved rows, current labels, shared
 * visibility. Built fresh per render - operator label edits apply
 * immediately in BOTH modes. Empty (no rows) for null/inactive admins.
 */
export async function buildAdminMainMenuDefinition(
  admin: Admin | null | undefined,
): Promise<AdminMainMenuButton[][]> {
  const visible = visibleActions(admin);
  const rows: AdminMainMenuButton[][] = [];
  for (const rowActions of APPROVED_ROWS) {
    const row: AdminMainMenuButton[] = [];
    for (const action of rowActions) {
      if (!visible.has(action)) {
        continue;
      }
      const wiring = ADMIN_MAIN_MENU_ACTION_WIRING[action];
      row.push({
        action,
        buttonKey: wiring.buttonKey,
        label: await getButtonText(wiring.buttonKey),
        callback: wiring.callback,
      });
    }
    if (row.length > 0) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The persistent reply-keyboard rendering of the SAME definition: identical
 * rows and labels, no callback data (reply buttons send their text). Always
 * built per admin/request - never cache one global keyboard.
 */
export async function buildAdminMainReplyKeyboard(
  admin: Admin | null | undefined,
): Promise<Keyboard> {
  const rows = await buildAdminMainMenuDefinition(admin);
  const keyboard = new Keyboard(rows.map((row) => row.map((button) => Keyboard.text(button.label))));
  return keyboard.resized().persistent().placeholder("یک گزینه را انتخاب کنید");
}

/** How one reply-keyboard text resolved against the CURRENT admin menu. */
export type AdminMainMenuResolution =
  | { matched: false }
  | { matched: true; authorized: false }
  | { matched: true; authorized: true; action: AdminMainMenuAction };

/**
 * Resolves an incoming reply-keyboard text against the CURRENT admin menu
 * labels. Match is exact (trimmed) so edited labels keep routing and
 * arbitrary text never becomes navigation; an ambiguous label (two actions
 * edited to the same text - additionally blocked at edit time) fails safe
 * to unmatched. Matching alone NEVER authorizes: the sender must be an
 * active admin, and the label must belong to a section visible to them,
 * or the result is {matched, authorized: false} for the caller to deny.
 */
export async function resolveAdminMainMenuAction(
  text: string,
  admin: Admin | null | undefined,
): Promise<AdminMainMenuResolution> {
  const needle = text.trim();
  if (needle === "" || needle.startsWith("/")) {
    return { matched: false };
  }
  // Label matching runs over the FULL approved menu (visibility-independent)
  // so a deactivated admin's stale keyboard is recognized - and denied -
  // instead of falling through as arbitrary text.
  const labelled: { action: AdminMainMenuAction; label: string }[] = [];
  for (const [action, wiring] of Object.entries(ADMIN_MAIN_MENU_ACTION_WIRING)) {
    labelled.push({
      action: action as AdminMainMenuAction,
      label: (await getButtonText(wiring.buttonKey)).trim(),
    });
  }
  const matches = labelled.filter((entry) => entry.label === needle);
  if (matches.length !== 1) {
    return { matched: false };
  }
  const action = matches[0].action;
  if (!visibleActions(admin).has(action)) {
    return { matched: true, authorized: false };
  }
  return { matched: true, authorized: true, action };
}
