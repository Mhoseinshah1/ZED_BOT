// Callback-data builders for panel management. All data stays well under
// Telegram's 64-byte limit thanks to 8-char panel short ids and short field
// keys.

export const PANEL_CB = {
  MENU: "admin:panels",
  ADD: "admin:panels:add",
  ADD_MARZBAN: "admin:panels:add:MARZBAN",
  ADD_XUI: "admin:panels:add:XUI",
  CANCEL: "admin:panels:cancel",
  LIST: "admin:panels:list",
  // Add-wizard XUI auth-mode selection (c = SESSION_COOKIE, t = API_TOKEN).
  ADD_AUTH_COOKIE: "admin:panels:addauth:c",
  ADD_AUTH_TOKEN: "admin:panels:addauth:t",
} as const;

export const cb = {
  list: (page: number): string => `admin:panels:list:${page}`,
  // Fix C: status-filtered lists (a=active, i=not active).
  listFiltered: (filter: "a" | "i", page: number): string => `admin:panels:ls:${filter}:${page}`,
  // Fix C: read-only linked-products page.
  products: (sid: string): string => `admin:panel:prods:${sid}`,
  view: (sid: string): string => `admin:panel:view:${sid}`,
  test: (sid: string): string => `admin:panel:test:${sid}`,
  statusMenu: (sid: string): string => `admin:panel:st:${sid}`,
  statusSet: (sid: string, status: string): string => `admin:panel:st:${sid}:${status}`,
  visibility: (sid: string): string => `admin:panel:vis:${sid}`,
  features: (sid: string): string => `admin:panel:feat:${sid}`,
  toggle: (sid: string, key: string): string => `admin:panel:tg:${sid}:${key}`,
  pricing: (sid: string): string => `admin:panel:price:${sid}`,
  testSettings: (sid: string): string => `admin:panel:ts:${sid}`,
  usernameSettings: (sid: string): string => `admin:panel:us:${sid}`,
  usernamePattern: (sid: string, index: number): string => `admin:panel:up:${sid}:${index}`,
  // Naming phase: «پیش‌نمایش نام‌گذاری» - regenerates the sample preview.
  usernamePreview: (sid: string): string => `admin:panel:unp:${sid}`,
  typeSettings: (sid: string): string => `admin:panel:cfg:${sid}`,
  fieldEdit: (sid: string, key: string): string => `admin:panel:fe:${sid}:${key}`,
  deleteAsk: (sid: string): string => `admin:panel:del:${sid}`,
  deleteConfirm: (sid: string): string => `admin:panel:del:${sid}:yes`,
  // XUI auth-mode switch (existing panel).
  authModeMenu: (sid: string): string => `admin:panel:am:${sid}`,
  authModeSet: (sid: string, mode: "c" | "t"): string => `admin:panel:am:${sid}:${mode}`,
} as const;
