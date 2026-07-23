import { Composer } from "grammy";

import type { BotContext } from "../core/context.js";
import { getUserMenuMode } from "../services/menu-mode.service.js";
import { resolveMainMenuAction, type UserMainMenuAction } from "../keyboards/user-menu-definition.js";
import { ensureActiveAdminAccess } from "../middlewares/admin-auth.middleware.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import { showAdminMenu } from "./admin.handler.js";
import { isInterruptibleCheckoutFlow } from "./user-checkout/checkout-state.js";
import { openOtherProductsSection, startBuyFlow } from "./user-checkout/checkout.handler.js";
import { openFreeTrialSection } from "./user-free-trial/free-trial.handler.js";
import { renderOrdersHub } from "./user-orders/orders.handler.js";
import { renderPricingRoot } from "./user-pricing/pricing.handler.js";
import { renderPurchaseHub } from "./user-purchase-hub/purchase-hub.handler.js";
import { renderReferralPage } from "./user-referral/referral.handler.js";
import { renderRepresentativeLanding } from "./user-representative/representative.handler.js";
import { renderRenewableList } from "./user-renewal/renewal.handler.js";
import { renderServicesList } from "./user-services/services.handler.js";
import { renderSupportLanding } from "./user-support/support.handler.js";
import { renderWallet } from "./user-wallet/wallet.handler.js";

// =============================================================================
// Shared main-menu action dispatch (menu-keyboard-mode phase): the ONE
// mapping from language-neutral menu actions to the exact section entry
// functions the inline callbacks already use - reply-keyboard taps and
// inline clicks run identical business flows, with all ownership/access
// checks living in those flows. No callback queries are synthesized and no
// business logic is duplicated here.
// =============================================================================

const ACTION_HANDLERS: Record<UserMainMenuAction, (ctx: BotContext) => Promise<void>> = {
  // Defense in depth: even a direct call re-validates the active admin (the
  // reply router already branches BEFORE user gates - see below).
  ADMIN_PANEL: async (ctx) => {
    if (await ensureActiveAdminAccess(ctx)) {
      await showAdminMenu(ctx);
    }
  },
  BUY_SUBSCRIPTION: startBuyFlow,
  RENEW_SERVICE: (ctx) => renderRenewableList(ctx, 1),
  MY_SERVICES: (ctx) => renderServicesList(ctx, 1),
  WALLET: (ctx) => renderWallet(ctx),
  OTHER_PRODUCTS: openOtherProductsSection,
  // Admin-controlled unified purchase menu: the combined-mode entry opens the
  // read-only purchase hub, which itself enters the SAME two flows above.
  PURCHASE_HUB: (ctx) => renderPurchaseHub(ctx),
  MY_ORDERS: (ctx) => renderOrdersHub(ctx),
  PRICING: (ctx) => renderPricingRoot(ctx),
  SUPPORT: (ctx) => renderSupportLanding(ctx),
  FREE_TRIAL: openFreeTrialSection,
  REFERRAL: (ctx) => renderReferralPage(ctx),
  REPRESENTATIVE: (ctx) => renderRepresentativeLanding(ctx),
};

/** Opens one main-menu section - the same entry the inline callback uses. */
export async function openMainMenuSection(
  ctx: BotContext,
  action: UserMainMenuAction,
): Promise<void> {
  await ACTION_HANDLERS[action](ctx);
}

/**
 * Reply-keyboard text router. Registered AFTER the flow-gated message
 * dispatcher in app.ts, so every active conversational flow (discount entry,
 * support messages, receipts, admin edits, ...) has already consumed its
 * text before this runs. It only ever acts when:
 *   - the mode is REPLY,
 *   - no conversational flow is active (defense in depth),
 *   - the text is not a command,
 *   - the trimmed text EXACTLY matches one current main-menu label.
 * Everything else falls through untouched. Matching text alone never
 * authorizes anything: the access gates run first and every section handler
 * keeps its own ownership/eligibility checks. Admin actions are unreachable
 * here by construction - only the 8 user main-menu actions resolve.
 */
export const userMenuTextRouter = new Composer<BotContext>();

userMenuTextRouter.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== null) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    return next(); // commands keep their existing priority
  }
  if ((await getUserMenuMode()) !== "REPLY") {
    return next();
  }
  const action = await resolveMainMenuAction(text);
  if (action === null) {
    return next(); // arbitrary text is never navigation
  }
  // Admin entry is INDEPENDENT of the customer gates: an active admin whose
  // user account is blocked must still reach the panel, and a normal user
  // typing the admin label gets the explicit admin denial (the resolver
  // recognizes the label for everyone; authorization happens HERE, never by
  // visibility). Stale reply keyboards of deactivated admins are denied the
  // same way - ctx.admin is attached for ACTIVE admins only.
  if (action === "ADMIN_PANEL") {
    if (!(await ensureActiveAdminAccess(ctx))) {
      return;
    }
    await showAdminMenu(ctx);
    return;
  }
  // Same gates as the user area (maintenance/blocked/terms/force-join) -
  // applied only AFTER a real menu label matched, so unrelated text from
  // gated users never triggers gate messages.
  if (!(await ensureUserAccess(ctx))) {
    return;
  }
  await openMainMenuSection(ctx, action);
});

/**
 * The main-menu purchase-navigation actions the pre-flow escape router may use
 * to interrupt an active checkout/payment INPUT flow (§13). Deliberately narrow:
 * only the read-only Pricing catalog, the purchase hub, and the two purchase
 * flows a user would naturally reach for while stuck mid-input. Every other menu
 * label (wallet, services, support, ...) is left to the post-flow router, so a
 * mid-input user does not have every label yank them out of the flow.
 */
const PURCHASE_NAVIGATION_ESCAPE_ACTIONS: ReadonlySet<UserMainMenuAction> = new Set([
  "PRICING",
  "PURCHASE_HUB",
  "BUY_SUBSCRIPTION",
  "OTHER_PRODUCTS",
]);

/**
 * Pre-flow purchase-navigation reply-keyboard escape
 * (feat/admin-controlled-unified-purchase-menu §13; generalizes the
 * fix/pricing-reply-keyboard-flow-escape router — `pricingReplyEscapeRouter`
 * below is kept as an alias for existing imports).
 *
 * `userMenuTextRouter` above runs AFTER the flow dispatcher and self-returns
 * while any `currentFlow` is active, so during one of the six interruptible
 * checkout/payment INPUT flows a persistent purchase-navigation reply button
 * would be consumed by the flow (validated as a discount code, uploaded as a
 * receipt, ...) before it could resolve. This router is mounted in app.ts BEFORE
 * the flow dispatcher and rescues ONLY that exact case:
 *
 *   1. `currentFlow` is one of the SIX interruptible checkout/payment flows
 *      (`isInterruptibleCheckoutFlow`) — never support / representative /
 *      customer-input / admin / any other flow;
 *   2. the text is not a command (commands keep their priority);
 *   3. the user menu mode is REPLY (INLINE mode never routes plain text);
 *   4. the trimmed text resolves through the CURRENT registry
 *      (`resolveMainMenuAction`, layout-independent for purchase actions) to one
 *      of PRICING / PURCHASE_HUB / BUY_SUBSCRIPTION / OTHER_PRODUCTS (edited
 *      labels work; stale/old labels and ambiguous duplicates fail closed).
 *
 * It then applies the SAME `ensureUserAccess` gate as every other menu entry
 * (blocked/maintenance/terms/force-join get the normal gate and the message is
 * consumed — never validated/uploaded) and only then dispatches through the ONE
 * authoritative `openMainMenuSection`, whose handlers each invoke
 * `clearCheckoutState`. Everything else calls `next()` and reaches the flow
 * dispatcher exactly as before. Matching a label never authorizes anything and
 * no checkout state is cleared before the access decision.
 */
export const purchaseNavigationEscapeRouter = new Composer<BotContext>();

purchaseNavigationEscapeRouter.on("message:text", async (ctx, next) => {
  if (!isInterruptibleCheckoutFlow(ctx.session.currentFlow)) {
    return next(); // only the six interruptible checkout/payment flows
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    return next(); // commands keep their existing cancellation/priority
  }
  if ((await getUserMenuMode()) !== "REPLY") {
    return next(); // INLINE mode never routes plain text
  }
  const action = await resolveMainMenuAction(text);
  if (action === null || !PURCHASE_NAVIGATION_ESCAPE_ACTIONS.has(action)) {
    return next(); // arbitrary text / non-purchase labels / stale label → the active flow
  }
  // The user pressed a CURRENT purchase-navigation reply button. Access is
  // decided BEFORE any state is cleared; a gated user gets the normal gate and
  // the message is consumed (never validated as a discount / uploaded as a
  // receipt).
  if (!(await ensureUserAccess(ctx))) {
    return;
  }
  // Dispatch through the ONE authoritative action map; each target handler
  // (renderPricingRoot / renderPurchaseHub / startBuyFlow /
  // openOtherProductsSection) invokes the authoritative clearCheckoutState.
  await openMainMenuSection(ctx, action);
});

/**
 * Backwards-compatible alias for the pre-flow escape router (PR #127 export). The
 * router is now the generalized purchase-navigation escape above; the alias keeps
 * existing imports/tests valid.
 */
export const pricingReplyEscapeRouter = purchaseNavigationEscapeRouter;
