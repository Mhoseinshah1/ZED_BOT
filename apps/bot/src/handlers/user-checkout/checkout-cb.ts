// Callback-data builders for the user checkout flow. Short ids (8-char UUID
// prefixes) plus single-letter location codes keep everything far below
// Telegram's 64-byte limit. Location travels inside the callback data so
// browsing is stateless and survives bot restarts.

export const CO_CB = {
  BUY: "user:buy",
  OTHER: "user:other_products",
  DISCOUNT: "user:co:discount",
  DISCOUNT_CLEAR: "user:co:discount:clear",
  CONTINUE: "user:co:continue",
  BACK_TO_INVOICE: "user:co:back",
} as const;

export const ccb = {
  buyLocation: (l: string): string => `user:buy:loc:${l}`,
  buyCategory: (l: string, catSid: string): string => `user:buy:cat:${l}:${catSid}`,
  buyProduct: (l: string, prodSid: string): string => `user:buy:p:${l}:${prodSid}`,
  otherCategory: (catSid: string): string => `user:op:cat:${catSid}`,
  otherProduct: (prodSid: string): string => `user:op:p:${prodSid}`,
  viewCheckout: (coSid: string): string => `user:co:view:${coSid}`,
} as const;
