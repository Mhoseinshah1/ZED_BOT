import { Keyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { isFreeTrialVisible } from "../services/free-trial.service.js";
import { isReferralSystemEnabled } from "../services/referral.service.js";
import { isRepresentativeProgramEnabled } from "../services/representative-settings.service.js";
import { getButtonText } from "../services/text.service.js";

// =============================================================================
// The ONE user main-menu definition (menu-keyboard-mode phase): the approved
// rows, language-neutral action identities, operator-editable labels and the
// shared visibility policy (free-trial row only when the feature is live).
// Both renderers - the inline keyboard in user-main.keyboard.ts and the
// reply keyboard below - consume THIS definition, so the two modes can never
// drift apart. Action identity NEVER derives from the Persian label.
// =============================================================================

/** Language-neutral identity of every user main-menu action. */
export type UserMainMenuAction =
  | "BUY_SUBSCRIPTION"
  | "RENEW_SERVICE"
  | "MY_SERVICES"
  | "WALLET"
  | "OTHER_PRODUCTS"
  | "MY_ORDERS"
  | "PRICING"
  | "SUPPORT"
  | "FREE_TRIAL"
  | "REFERRAL"
  | "REPRESENTATIVE"
  | "ADMIN_PANEL";

export interface UserMainMenuButton {
  action: UserMainMenuAction;
  /** ButtonText registry key - the label is always the CURRENT edited value. */
  buttonKey: string;
  /** Operator-editable visible label (verbatim from the registry). */
  label: string;
  /** Stable inline callback (unchanged - the approved contract). */
  callback: string;
}

/** action -> {buttonKey, callback}: the stable, label-independent wiring. */
export const MAIN_MENU_ACTION_WIRING: Record<
  UserMainMenuAction,
  { buttonKey: string; callback: string }
> = {
  BUY_SUBSCRIPTION: { buttonKey: "buy_subscription", callback: CB.USER_BUY },
  RENEW_SERVICE: { buttonKey: "renew_service", callback: CB.USER_RENEW },
  MY_SERVICES: { buttonKey: "my_services", callback: CB.USER_SERVICES },
  WALLET: { buttonKey: "wallet", callback: CB.USER_WALLET },
  OTHER_PRODUCTS: { buttonKey: "other_products", callback: CB.USER_OTHER_PRODUCTS },
  MY_ORDERS: { buttonKey: "my_orders", callback: CB.USER_ORDERS },
  // Public retail Pricing Catalog (feat/public-pricing-catalog): opens the real
  // «تعرفه‌ها» page. Always visible once this feature landed (no rollout switch);
  // the label is display-only and never determines routing.
  PRICING: { buttonKey: "pricing", callback: CB.USER_PRICING },
  SUPPORT: { buttonKey: "support", callback: CB.USER_SUPPORT },
  FREE_TRIAL: { buttonKey: "free_test", callback: CB.USER_FREE_TEST },
  // Referral affiliate phase: opens the real referral page. Visible only when the
  // OWNER has enabled the referral program (like FREE_TRIAL) — hidden by default.
  REFERRAL: { buttonKey: "referral", callback: CB.USER_REFERRAL },
  // Representative Program: opens the real representative page. Visible only when
  // the OWNER has enabled the program master switch (§3) — hidden by default.
  REPRESENTATIVE: { buttonKey: "representative", callback: CB.USER_REPRESENTATIVE },
  // Admin-entry phase: opens the EXISTING admin panel (same callback the
  // /admin menu uses). Visible only to active admins via the viewer-aware
  // definition below; the label is display-only and never authorization.
  ADMIN_PANEL: { buttonKey: "admin_panel", callback: CB.ADMIN_MENU },
};

/** The 8 main-menu ButtonText keys (duplicate-label guard scope). */
export const MAIN_MENU_BUTTON_KEYS: string[] = Object.values(MAIN_MENU_ACTION_WIRING).map(
  (w) => w.buttonKey,
);

/**
 * The approved row layout; FREE_TRIAL's row renders only when visible and
 * the final ADMIN_PANEL row only for an active-admin viewer (fail closed:
 * no viewer context means no admin row).
 */
const APPROVED_ROWS: UserMainMenuAction[][] = [
  ["BUY_SUBSCRIPTION", "RENEW_SERVICE"],
  ["MY_SERVICES", "WALLET"],
  ["OTHER_PRODUCTS", "MY_ORDERS"],
  // Standalone Pricing row: after OTHER_PRODUCTS/MY_ORDERS and before every
  // feature-gated row (free trial / referral / representative).
  ["PRICING"],
  ["FREE_TRIAL"],
  ["REFERRAL"],
  ["REPRESENTATIVE"],
  ["SUPPORT"],
  ["ADMIN_PANEL"],
];

/**
 * Viewer context for user-specific menu visibility. isActiveAdmin must come
 * from the middleware-attached ctx.admin (active-only by construction) -
 * renderers never issue their own admin query.
 */
export interface UserMainMenuViewer {
  isActiveAdmin: boolean;
}

const HIDDEN_VIEWER: UserMainMenuViewer = { isActiveAdmin: false };

/**
 * The current menu definition: approved rows, current labels, shared
 * visibility policy. Built fresh per render - operator label edits and
 * free-trial availability changes apply immediately in BOTH modes.
 */
export async function buildUserMainMenuDefinition(
  viewer: UserMainMenuViewer = HIDDEN_VIEWER,
): Promise<UserMainMenuButton[][]> {
  const [trialVisible, referralVisible, representativeVisible] = await Promise.all([
    isFreeTrialVisible(),
    isReferralSystemEnabled(),
    isRepresentativeProgramEnabled(),
  ]);
  const rows: UserMainMenuButton[][] = [];
  for (const rowActions of APPROVED_ROWS) {
    const row: UserMainMenuButton[] = [];
    for (const action of rowActions) {
      if (action === "FREE_TRIAL" && !trialVisible) {
        continue;
      }
      if (action === "REFERRAL" && !referralVisible) {
        continue; // Hidden until the OWNER enables the referral program.
      }
      if (action === "REPRESENTATIVE" && !representativeVisible) {
        continue; // Hidden until the OWNER enables the representative program (§3).
      }
      if (action === "ADMIN_PANEL" && !viewer.isActiveAdmin) {
        continue; // Fail closed: the default viewer never sees the admin row.
      }
      const wiring = MAIN_MENU_ACTION_WIRING[action];
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
 * built per user/request - never cache one global keyboard.
 */
export async function buildUserMainReplyKeyboard(
  viewer: UserMainMenuViewer = HIDDEN_VIEWER,
): Promise<Keyboard> {
  const rows = await buildUserMainMenuDefinition(viewer);
  const keyboard = new Keyboard(rows.map((row) => row.map((button) => Keyboard.text(button.label))));
  return keyboard.resized().persistent().placeholder("یک گزینه را انتخاب کنید");
}

/**
 * Resolves an incoming reply-keyboard text against the CURRENT labels. Match
 * is exact (trimmed) so edited labels keep routing and arbitrary user text
 * never becomes navigation. An ambiguous label (two actions edited to the
 * same text - additionally blocked at edit time) fails safe to null.
 */
export async function resolveMainMenuAction(
  text: string,
): Promise<UserMainMenuAction | null> {
  const needle = text.trim();
  if (needle === "" || needle.startsWith("/")) {
    return null;
  }
  // Resolution is deliberately viewer-blind (isActiveAdmin: true): the
  // configured admin_panel label must resolve for EVERYONE so a normal user
  // typing it receives the explicit admin denial instead of the generic
  // fallback. Matching NEVER authorizes - the dispatcher revalidates the
  // active admin immediately before opening the panel.
  const rows = await buildUserMainMenuDefinition({ isActiveAdmin: true });
  const matches = rows.flat().filter((button) => button.label.trim() === needle);
  return matches.length === 1 ? matches[0].action : null;
}
