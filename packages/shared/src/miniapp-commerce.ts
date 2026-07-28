// =============================================================================
// Mini App commerce rollout switches (miniapp-commerce-parity, Phase 1).
//
// Nine independently-controlled OWNER settings gating the Mini App's commerce
// surface. Every key seeds FALSE: merging the code activates NOTHING until the
// OWNER flips a switch from the bot admin panel. The keys live here — beside
// the other feature-switch contracts — so the bot (admin UI), the API
// (mutation-boundary guards) and the seed share one definition.
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

/** Master switch: catalog browse, checkout drafts, discount application,
 * pre-invoices, orders/payments history. Everything below also requires it. */
export const MINIAPP_COMMERCE_ENABLED_KEY = "miniapp_commerce_enabled";

/** Wallet top-up checkout creation from the Mini App. */
export const MINIAPP_WALLET_TOPUP_ENABLED_KEY = "miniapp_wallet_topup_enabled";

/** Card-to-card method offer + browser receipt upload. */
export const MINIAPP_CARD_TO_CARD_ENABLED_KEY = "miniapp_card_to_card_enabled";

/** Online gateway initiation (Zarinpal / NOWPayments / Stars where safe). */
export const MINIAPP_ONLINE_PAYMENTS_ENABLED_KEY = "miniapp_online_payments_enabled";

/** Delivery surface: subscription URL / config links / QR exposure. */
export const MINIAPP_SERVICE_DELIVERY_ENABLED_KEY = "miniapp_service_delivery_enabled";

/** Renewal checkout from the service detail screen. */
export const MINIAPP_SERVICE_RENEWAL_ENABLED_KEY = "miniapp_service_renewal_enabled";

/** Extra-volume checkout from the service detail screen. */
export const MINIAPP_EXTRA_VOLUME_ENABLED_KEY = "miniapp_extra_volume_enabled";

/** Extra-time checkout from the service detail screen. */
export const MINIAPP_EXTRA_TIME_ENABLED_KEY = "miniapp_extra_time_enabled";

/** Other-product catalog/checkout/customer-input/delivered-content surface. */
export const MINIAPP_OTHER_PRODUCTS_ENABLED_KEY = "miniapp_other_products_enabled";

/** Every Mini App commerce switch, in rollout order (the order the staged
 * rollout enables them and the admin screen lists them). */
export const MINIAPP_COMMERCE_SWITCH_KEYS = [
  MINIAPP_COMMERCE_ENABLED_KEY,
  MINIAPP_WALLET_TOPUP_ENABLED_KEY,
  MINIAPP_CARD_TO_CARD_ENABLED_KEY,
  MINIAPP_ONLINE_PAYMENTS_ENABLED_KEY,
  MINIAPP_SERVICE_DELIVERY_ENABLED_KEY,
  MINIAPP_SERVICE_RENEWAL_ENABLED_KEY,
  MINIAPP_EXTRA_VOLUME_ENABLED_KEY,
  MINIAPP_EXTRA_TIME_ENABLED_KEY,
  MINIAPP_OTHER_PRODUCTS_ENABLED_KEY,
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
  /** A settled gateway payment: run post-settlement fulfilment/notices. */
  GATEWAY_FULFILL: "fulfill-settled-gateway-payment",
  /** A submitted card-to-card receipt: notify the active admins. */
  NOTIFY_RECEIPT: "notify-receipt-submitted",
} as const;

export type MiniAppCommerceJobName =
  (typeof MINIAPP_COMMERCE_JOB_NAMES)[keyof typeof MINIAPP_COMMERCE_JOB_NAMES];
