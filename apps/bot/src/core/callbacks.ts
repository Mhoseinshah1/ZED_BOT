/**
 * Stable callback-data constants. Keep values short (Telegram limits callback
 * data to 64 bytes) and never rename existing ones - old inline keyboards
 * keep living in user chats.
 */
export const CB = {
  // User menu
  USER_MENU: "user:menu",
  USER_BUY: "user:buy",
  USER_RENEW: "user:renew",
  USER_SERVICES: "user:services",
  USER_WALLET: "user:wallet",
  USER_REFERRAL: "user:referral",
  USER_FREE_TEST: "user:free_test",
  USER_WHEEL: "user:wheel",
  USER_TUTORIALS: "user:tutorials",
  USER_SUPPORT: "user:support",
  USER_PRICING: "user:pricing",
  USER_REPRESENTATIVE: "user:representative_request",
  USER_OTHER_PRODUCTS: "user:other_products",
  USER_ORDERS: "user:orders",
  USER_EXTRA_VOLUME: "user:extra_volume",
  USER_EXTRA_TIME: "user:extra_time",

  // Admin menu
  ADMIN_MENU: "admin:menu",
  ADMIN_FINANCE: "admin:finance",
  ADMIN_PANEL_FEATURES: "admin:panel_features",
  ADMIN_UPDATE_BOT: "admin:update_bot",
  ADMIN_RECEIPTS: "admin:receipts",
  ADMIN_TUTORIALS: "admin:tutorials",
  ADMIN_GENERAL_SETTINGS: "admin:general_settings",
  ADMIN_MINI_APP_SETTINGS: "admin:mini_app_settings",
  ADMIN_USERS: "admin:users",
  ADMIN_PRODUCTS: "admin:products",
  ADMIN_PANELS: "admin:panels",
  ADMIN_CUSTOM_SERVICE_PRICE: "admin:custom_service_price",
  ADMIN_OTHER_PRODUCTS: "admin:other_products",
  ADMIN_SUPPORT: "admin:support",
  ADMIN_BROADCAST: "admin:broadcast",
  ADMIN_REPORTS_BACKUP: "admin:reports_backup",
  ADMIN_ANALYTICS: "admin:analytics",

  // Common / gates
  COMMON_BACK: "common:back",
  TERMS_ACCEPT: "terms:accept",
  FORCE_JOIN_CHECK: "force_join:check",
} as const;

export type CallbackData = (typeof CB)[keyof typeof CB];
