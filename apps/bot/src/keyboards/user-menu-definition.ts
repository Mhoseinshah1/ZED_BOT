import { Keyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { isFreeTrialVisible } from "../services/free-trial.service.js";
import { isCombinedPurchaseMenuEnabled } from "../services/purchase-menu-layout.service.js";
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
//
// Admin-controlled unified purchase menu (feat/admin-controlled-unified-purchase-menu):
// the purchase ENTRY is laid out two ways, selected by one OWNER setting:
//   * SPLIT (default): the historical two buttons BUY_SUBSCRIPTION + OTHER_PRODUCTS;
//   * COMBINED: one PURCHASE_HUB button that opens the purchase hub, from which
//     the SAME two existing flows are entered.
// The setting controls PRESENTATION ONLY. Both business flows stay reachable in
// every layout (old inline callbacks + stale reply labels), so BUY_SUBSCRIPTION,
// OTHER_PRODUCTS and PURCHASE_HUB are ALL kept in the action type + wiring and
// are all reply-resolvable regardless of which layout currently renders them.
// =============================================================================

/** Language-neutral identity of every user main-menu action. */
export type UserMainMenuAction =
  | "BUY_SUBSCRIPTION"
  | "RENEW_SERVICE"
  | "MY_SERVICES"
  | "WALLET"
  | "OTHER_PRODUCTS"
  | "PURCHASE_HUB"
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
  // Admin-controlled unified purchase menu: opens the purchase hub (combined
  // mode). Its business flows are the EXISTING VPN + Other-Products entries; the
  // hub is a navigation surface only. The label is display-only.
  PURCHASE_HUB: { buttonKey: "purchase_hub", callback: CB.USER_PURCHASE_HUB },
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

/** All main-menu ButtonText keys (duplicate-label guard scope). Includes the
 * combined-mode `purchase_hub` label so it participates in the per-menu
 * duplicate-label validation and reply-text resolution. */
export const MAIN_MENU_BUTTON_KEYS: string[] = Object.values(MAIN_MENU_ACTION_WIRING).map(
  (w) => w.buttonKey,
);

/**
 * SPLIT layout (default): the historical rows, unchanged. Two separate purchase
 * buttons (BUY_SUBSCRIPTION + OTHER_PRODUCTS); PURCHASE_HUB is not rendered.
 * FREE_TRIAL's row renders only when visible and the final ADMIN_PANEL row only
 * for an active-admin viewer (fail closed: no viewer context means no admin row).
 */
const SPLIT_ROWS: UserMainMenuAction[][] = [
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
 * COMBINED layout: the two separate purchase buttons are replaced by ONE
 * PURCHASE_HUB button (paired with RENEW_SERVICE). MY_ORDERS pairs with PRICING
 * on one row. Every other row — and the SAME optional/feature-gated rows in the
 * SAME order — is unchanged. BUY_SUBSCRIPTION + OTHER_PRODUCTS are NOT rendered
 * here (their flows remain reachable via the hub, old inline callbacks and
 * stale reply labels).
 */
const COMBINED_ROWS: UserMainMenuAction[][] = [
  ["PURCHASE_HUB", "RENEW_SERVICE"],
  ["MY_SERVICES", "WALLET"],
  ["MY_ORDERS", "PRICING"],
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
 * The current menu definition: the layout selected by the OWNER's purchase-menu
 * setting, current labels, shared visibility policy. Built fresh per render -
 * operator label edits, free-trial availability changes AND a purchase-layout
 * toggle all apply immediately in BOTH keyboard modes on the next render.
 */
export async function buildUserMainMenuDefinition(
  viewer: UserMainMenuViewer = HIDDEN_VIEWER,
): Promise<UserMainMenuButton[][]> {
  const [combined, trialVisible, referralVisible, representativeVisible] = await Promise.all([
    isCombinedPurchaseMenuEnabled(),
    isFreeTrialVisible(),
    isReferralSystemEnabled(),
    isRepresentativeProgramEnabled(),
  ]);
  const layout = combined ? COMBINED_ROWS : SPLIT_ROWS;
  const rows: UserMainMenuButton[][] = [];
  for (const rowActions of layout) {
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

interface MenuResolutionCandidate {
  action: UserMainMenuAction;
  label: string;
}

/**
 * The {action, current-label} set used to resolve incoming reply-keyboard text.
 * It is deliberately LAYOUT-INDEPENDENT for the three purchase actions
 * (BUY_SUBSCRIPTION, OTHER_PRODUCTS, PURCHASE_HUB): all three resolve regardless
 * of which layout currently renders them, so a stale reply keyboard from the
 * OTHER layout keeps routing after the OWNER flips the setting (§11/§12 — the
 * setting is presentation only; both flows are always available). Feature-gated
 * actions (free trial / referral / representative) are included ONLY while their
 * live gate is open — a disabled feature is NEVER made generally resolvable.
 * ADMIN_PANEL resolves for everyone (viewer-blind) so a normal user typing it
 * receives the explicit admin denial; matching NEVER authorizes — the dispatcher
 * revalidates the active admin immediately before opening the panel.
 */
async function buildMenuResolutionCandidates(): Promise<MenuResolutionCandidate[]> {
  const [trialVisible, referralVisible, representativeVisible] = await Promise.all([
    isFreeTrialVisible(),
    isReferralSystemEnabled(),
    isRepresentativeProgramEnabled(),
  ]);
  const resolvable = (action: UserMainMenuAction): boolean => {
    if (action === "FREE_TRIAL") return trialVisible;
    if (action === "REFERRAL") return referralVisible;
    if (action === "REPRESENTATIVE") return representativeVisible;
    // Purchase actions, always-rendered non-gated actions, and ADMIN_PANEL.
    return true;
  };
  const candidates: MenuResolutionCandidate[] = [];
  for (const action of Object.keys(MAIN_MENU_ACTION_WIRING) as UserMainMenuAction[]) {
    if (!resolvable(action)) {
      continue;
    }
    const wiring = MAIN_MENU_ACTION_WIRING[action];
    candidates.push({ action, label: await getButtonText(wiring.buttonKey) });
  }
  return candidates;
}

/**
 * Resolves an incoming reply-keyboard text against the CURRENT labels. Match is
 * exact (trimmed) so edited labels keep routing and arbitrary user text never
 * becomes navigation. An ambiguous label (two DISTINCT actions edited to the
 * same text — additionally blocked at edit time by the duplicate-label guard)
 * fails safe to null. The candidate set is layout-independent for the purchase
 * actions (see buildMenuResolutionCandidates), so a stale reply keyboard from
 * the other purchase layout still routes.
 */
export async function resolveMainMenuAction(
  text: string,
): Promise<UserMainMenuAction | null> {
  const needle = text.trim();
  if (needle === "" || needle.startsWith("/")) {
    return null;
  }
  const candidates = await buildMenuResolutionCandidates();
  const matches = candidates.filter((candidate) => candidate.label.trim() === needle);
  const distinctActions = new Set(matches.map((m) => m.action));
  return distinctActions.size === 1 ? matches[0].action : null;
}
