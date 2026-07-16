import { Keyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { isFreeTrialVisible } from "../services/free-trial.service.js";
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
  | "SUPPORT"
  | "FREE_TRIAL";

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
  SUPPORT: { buttonKey: "support", callback: CB.USER_SUPPORT },
  FREE_TRIAL: { buttonKey: "free_test", callback: CB.USER_FREE_TEST },
};

/** The 8 main-menu ButtonText keys (duplicate-label guard scope). */
export const MAIN_MENU_BUTTON_KEYS: string[] = Object.values(MAIN_MENU_ACTION_WIRING).map(
  (w) => w.buttonKey,
);

/** The approved row layout; FREE_TRIAL's row renders only when visible. */
const APPROVED_ROWS: UserMainMenuAction[][] = [
  ["BUY_SUBSCRIPTION", "RENEW_SERVICE"],
  ["MY_SERVICES", "WALLET"],
  ["OTHER_PRODUCTS", "MY_ORDERS"],
  ["FREE_TRIAL"],
  ["SUPPORT"],
];

/**
 * The current menu definition: approved rows, current labels, shared
 * visibility policy. Built fresh per render - operator label edits and
 * free-trial availability changes apply immediately in BOTH modes.
 */
export async function buildUserMainMenuDefinition(): Promise<UserMainMenuButton[][]> {
  const trialVisible = await isFreeTrialVisible();
  const rows: UserMainMenuButton[][] = [];
  for (const rowActions of APPROVED_ROWS) {
    const row: UserMainMenuButton[] = [];
    for (const action of rowActions) {
      if (action === "FREE_TRIAL" && !trialVisible) {
        continue;
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
export async function buildUserMainReplyKeyboard(): Promise<Keyboard> {
  const rows = await buildUserMainMenuDefinition();
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
  const rows = await buildUserMainMenuDefinition();
  const matches = rows.flat().filter((button) => button.label.trim() === needle);
  return matches.length === 1 ? matches[0].action : null;
}
