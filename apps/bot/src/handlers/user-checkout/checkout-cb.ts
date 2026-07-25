// Callback-data builders for the user checkout flow. Short ids (8-char UUID
// prefixes) keep everything far below Telegram's 64-byte limit. The selected
// panel/category travel inside the callback data so browsing is stateless
// and survives bot restarts.

export const CO_CB = {
  BUY: "user:buy",
  OTHER: "user:other_products",
  DISCOUNT: "user:co:discount",
  DISCOUNT_CLEAR: "user:co:discount:clear",
  CONTINUE: "user:co:continue",
  BACK_TO_INVOICE: "user:co:back",
  // Phase 15: pay the pre-invoice from the wallet balance.
  WALLET: "user:co:wallet",
  WALLET_CONFIRM: "user:co:wallet:yes",
} as const;

// =============================================================================
// Service-checkout username/note callbacks (hotfix §2, fix/service-username-
// reservation-safety). Every username/note action carries a COMPACT per-draft
// nonce: `user:co:un:{c,r,g,m,o}:<shortNonce>` and `user:co:nt:{s,b}:<shortNonce>`.
// The nonce is the draft's own nonce (dashes stripped, 12 hex) — NEVER the raw
// username or note. A keyboard from an OLD draft therefore carries an OLD nonce
// that no longer matches the current draft, so the shared validator below rejects
// it and the handler fails closed (no reservation churn, no note skip, no flow
// change). All forms are ≤ ~25 bytes, well under Telegram's 64-byte limit.
//
//   un:c = choose custom username   un:m = back to the method page
//   un:r = choose random username   un:o = confirm username → note step
//   un:g = regenerate random        nt:s = skip the optional note (stores null)
//                                   nt:b = back from note → username confirmation
// =============================================================================

/** The compact per-draft nonce embedded in every username/note callback. */
export function shortDraftNonce(draftNonce: string | null | undefined): string {
  return (draftNonce ?? "").replace(/-/g, "").slice(0, 12);
}

export const coNonce = {
  unCustom: (n: string): string => `user:co:un:c:${n}`,
  unRandom: (n: string): string => `user:co:un:r:${n}`,
  unRegen: (n: string): string => `user:co:un:g:${n}`,
  unMethod: (n: string): string => `user:co:un:m:${n}`,
  unConfirm: (n: string): string => `user:co:un:o:${n}`,
  noteSkip: (n: string): string => `user:co:nt:s:${n}`,
  noteBack: (n: string): string => `user:co:nt:b:${n}`,
} as const;

export type CoNonceAction = "un:c" | "un:r" | "un:g" | "un:m" | "un:o" | "nt:s" | "nt:b";

/** The single shared regex used by the ONE parser/validator for these callbacks. */
const CO_NONCE_RE = /^user:co:(un:[crgmo]|nt:[sb]):([0-9a-f]{6,32})$/;

/**
 * THE shared parser/validator (§2): decode a username/note callback into its
 * action + embedded short nonce, or null when the data is not one of these
 * callbacks. Carries no username/note, only a hex nonce.
 */
export function parseCoNonceCallback(
  data: string,
): { action: CoNonceAction; nonce: string } | null {
  const m = CO_NONCE_RE.exec(data);
  if (m === null) {
    return null;
  }
  return { action: m[1] as CoNonceAction, nonce: m[2] };
}

export const ccb = {
  // Panel-first buy flow (Phase 11.1). The old "user:buy:loc:*" fake
  // service-type step is gone; legacy callbacks get a compat redirect.
  buyPanel: (panelSid: string): string => `user:buy:panel:${panelSid}`,
  buyCategory: (panelSid: string, catSid: string): string =>
    `user:buy:cat:${panelSid}:${catSid}`,
  buyProduct: (panelSid: string, catSid: string, prodSid: string): string =>
    `user:buy:prod:${panelSid}:${catSid}:${prodSid}`,
  otherCategory: (catSid: string): string => `user:op:cat:${catSid}`,
  otherProduct: (prodSid: string): string => `user:op:p:${prodSid}`,
  viewCheckout: (coSid: string): string => `user:co:view:${coSid}`,
} as const;
