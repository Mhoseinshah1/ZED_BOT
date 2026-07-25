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
  // Service-checkout username selection (feat/service-checkout-username-note).
  // Routing binds to these stable strings, never a Persian label. All are far
  // below Telegram's 64-byte callback limit and carry no per-draft data (the
  // draft nonce + reservation live in the session/DB, not the callback).
  UN_CUSTOM: "user:co:un:custom", // pick "type my own username"
  UN_RANDOM: "user:co:un:rand", // pick "generate a random username"
  UN_REGEN: "user:co:un:regen", // regenerate a new random username
  UN_METHOD: "user:co:un:method", // back to the method-choice page
  UN_CONFIRM: "user:co:un:ok", // confirm username → optional-note step
  NOTE_SKIP: "user:co:note:skip", // skip the optional note (stores null)
} as const;

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
