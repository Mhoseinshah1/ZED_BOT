// =============================================================================
// Mini App commerce rollout switches (miniapp-commerce-parity, Phase 1).
//
// Five independently-controlled OWNER settings gating the wallet-only Mini App
// commerce surface. Missing rows are false, so merging activates nothing.
//
// Gating discipline (enforced by tests):
//   - The API re-reads the relevant switch FRESH (uncached) and FAIL-CLOSED at
//     every authoritative mutation boundary; a DB read failure blocks the
//     mutation exactly like a disabled switch.
//   - A switch only gates the CREATION of new work (browse, drafts, payments,
//     uploads). Disabling one never corrupts an already-settled operation:
//     settled payments stay settled, paid orders keep fulfilling, delivered
//     content stays delivered.
//   - Provider-level settings remain authoritative. A payment provider is
//     usable from the Mini App only when its existing provider gating (gateway
//     row enabled + adapter configured/available) AND the relevant Mini App
//     switch are BOTH on.
// =============================================================================

export const MINIAPP_COMMERCE_BROWSE_ENABLED_KEY = "miniapp_commerce_browse_enabled";
export const MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY = "miniapp_commerce_checkout_enabled";
export const MINIAPP_WALLET_PURCHASE_ENABLED_KEY = "miniapp_wallet_purchase_enabled";
export const MINIAPP_WALLET_RENEWAL_ENABLED_KEY = "miniapp_wallet_renewal_enabled";
export const MINIAPP_WALLET_ADDONS_ENABLED_KEY = "miniapp_wallet_addons_enabled";

/** Every Mini App commerce switch, in rollout order (the order the staged
 * rollout enables them and the admin screen lists them). */
export const MINIAPP_COMMERCE_SWITCH_KEYS = [
  MINIAPP_COMMERCE_BROWSE_ENABLED_KEY,
  MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY,
  MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  MINIAPP_WALLET_ADDONS_ENABLED_KEY,
] as const;

export type MiniAppCommerceSwitchKey = (typeof MINIAPP_COMMERCE_SWITCH_KEYS)[number];

export function isMiniAppCommerceSwitchKey(value: string): value is MiniAppCommerceSwitchKey {
  return (MINIAPP_COMMERCE_SWITCH_KEYS as readonly string[]).includes(value);
}

/** The single truthiness rule for switch values — identical to the bot's
 * `isTruthySettingValue` so both processes always agree on what "on" means. */
export function isMiniAppSwitchValueTruthy(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/** Fail-closed resolution of a switch read. `error` means the read itself
 * failed (DB unreachable, etc.) — callers must treat that as OFF and refuse
 * the mutation, never fall back to a cached or assumed value. */
export type MiniAppSwitchState =
  | { readonly ok: true; readonly enabled: boolean }
  | { readonly ok: false };

export function resolveMiniAppSwitchState(
  read: { readonly ok: true; readonly value: string | null } | { readonly ok: false },
): MiniAppSwitchState {
  if (!read.ok) return { ok: false };
  return { ok: true, enabled: isMiniAppSwitchValueTruthy(read.value) };
}

// --- follow-up queue (Mini-App-initiated settlements) --------------------------
//
// Money settles wherever the mutation ran, but FULFILMENT and user/admin
// Telegram notices always execute in the BOT process (it owns the grammY Api,
// the panel adapters and the service locks). A Mini-App-initiated settlement
// therefore enqueues one durable follow-up job the bot consumes — the same
// producer/consumer split the wallet auto-renewal engine established. Every
// job is idempotent downstream (CAS-claimed fulfilment executors, exactly-once
// admin notices), and the bot's settlement sweep remains the fallback: a lost
// queue message can delay follow-up, never lose it.
export const MINIAPP_COMMERCE_QUEUE_NAME = "miniapp-commerce-followup";

export const MINIAPP_COMMERCE_JOB_NAMES = {
  /** A wallet-paid order: run the unified post-payment fulfilment dispatcher. */
  FULFILL_ORDER: "fulfill-paid-order",
} as const;

export type MiniAppCommerceJobName =
  (typeof MINIAPP_COMMERCE_JOB_NAMES)[keyof typeof MINIAPP_COMMERCE_JOB_NAMES];
