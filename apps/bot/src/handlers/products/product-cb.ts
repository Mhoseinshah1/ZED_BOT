// Callback-data builders for product/category management. Short ids (8-char
// UUID prefixes) and compact keys keep everything under Telegram's 64-byte
// callback limit.

export const PROD_CB = {
  MENU: "admin:prod:menu",
  CANCEL: "admin:prod:cancel",
  CAT_MENU: "admin:prod:cat",
  CAT_ADD: "admin:prod:cat:add",
  // Fix C: type chooser in front of the existing add wizards.
  ADD: "admin:prod:add",
  ADD_SERVICE: "admin:prod:adds",
  ADD_OTHER: "admin:prod:addo",
  LIST_MENU: "admin:prod:ls",
  NOOP: "admin:prod:noop",
} as const;

export const pcb = {
  // Categories
  catAddType: (t: "S" | "O"): string => `admin:prod:cat:add:${t}`,
  catList: (t: "S" | "O", page: number): string => `admin:prod:cat:ls:${t}:${page}`,
  catView: (sid: string): string => `admin:prod:cat:view:${sid}`,
  catEditName: (sid: string): string => `admin:prod:cat:en:${sid}`,
  catEditOrder: (sid: string): string => `admin:prod:cat:or:${sid}`,
  catToggle: (sid: string): string => `admin:prod:cat:tg:${sid}`,
  catDeleteAsk: (sid: string): string => `admin:prod:cat:del:${sid}`,
  catDeleteConfirm: (sid: string): string => `admin:prod:cat:del:${sid}:yes`,

  // Product list / detail (Fix C added V=active / X=inactive filters)
  list: (f: "S" | "O" | "A" | "V" | "X", page: number): string => `admin:prod:ls:${f}:${page}`,
  view: (sid: string): string => `admin:prod:view:${sid}`,
  toggle: (sid: string): string => `admin:prod:tgl:${sid}`,
  deleteAsk: (sid: string): string => `admin:prod:del:${sid}`,
  deleteConfirm: (sid: string): string => `admin:prod:del:${sid}:yes`,
  // Representative-eligibility opt-in (OWNER-only, SERVICE_PRODUCT-only). The
  // confirm carries the EXPECTED current state ("1"=eligible / "0"=not) so a
  // stale/duplicate confirm converges instead of blindly double-flipping.
  repEligibleAsk: (sid: string): string => `admin:prod:repel:${sid}`,
  repEligibleConfirm: (sid: string, expected: "0" | "1"): string =>
    `admin:prod:repel:${sid}:${expected}`,
  fieldEdit: (sid: string, key: string): string => `admin:prod:fe:${sid}:${key}`,
  pickCategory: (sid: string): string => `admin:prod:cats:${sid}`,
  setCategory: (sid: string, catSid: string): string => `admin:prod:setcat:${sid}:${catSid}`,
  pickGroups: (sid: string): string => `admin:prod:grp:${sid}`,
  setGroups: (sid: string, g: string): string => `admin:prod:setgrp:${sid}:${g}`,
  pickPanel: (sid: string): string => `admin:prod:pnl:${sid}`,
  setPanel: (sid: string, panelSid: string): string => `admin:prod:setpnl:${sid}:${panelSid}`,
  pickLocation: (sid: string): string => `admin:prod:loc:${sid}`,
  setLocation: (sid: string, l: string): string => `admin:prod:setloc:${sid}:${l}`,
  pickResetCycle: (sid: string): string => `admin:prod:trc:${sid}`,
  setResetCycle: (sid: string, c: string): string => `admin:prod:settrc:${sid}:${c}`,
  toggleUserInfo: (sid: string): string => `admin:prod:rui:${sid}`,
  pickDelivery: (sid: string): string => `admin:prod:dlv:${sid}`,
  setDelivery: (sid: string, d: string): string => `admin:prod:setdlv:${sid}:${d}`,
  pickNaming: (sid: string): string => `admin:prod:naming:${sid}`,
  setNaming: (sid: string, index: number): string => `admin:prod:setnp:${sid}:${index}`,
  // Specialized-workflows phase: kind / stock-parser / collect-before-approval.
  pickKind: (sid: string): string => `admin:prod:kind:${sid}`,
  setKind: (sid: string, code: string): string => `admin:prod:setkind:${sid}:${code}`,
  pickStockParser: (sid: string): string => `admin:prod:sparser:${sid}`,
  setStockParser: (sid: string, code: string): string => `admin:prod:setsp:${sid}:${code}`,
  toggleCollectBefore: (sid: string): string => `admin:prod:cba:${sid}`,

  // Add-wizard step callbacks
  flowPanel: (panelSid: string): string => `admin:prod:f:pnl:${panelSid}`,
  flowGroups: (g: string): string => `admin:prod:f:grp:${g}`,
  flowLocation: (l: string): string => `admin:prod:f:loc:${l}`,
  flowCategory: (catSid: string): string => `admin:prod:f:cat:${catSid}`,
  // "admin:prod:f:newcat" is intentionally NOT built anymore - inline
  // category creation is disabled (a compat handler answers old keyboards).
  flowResetCycle: (c: string): string => `admin:prod:f:trc:${c}`,
  flowUserInfo: (v: "y" | "n"): string => `admin:prod:f:rui:${v}`,
  flowDelivery: (d: string): string => `admin:prod:f:dlv:${d}`,
  // Specialized-workflows phase: OTHER_PRODUCT kind branching steps.
  flowKind: (k: string): string => `admin:prod:f:kind:${k}`,
  flowAiMode: (m: string): string => `admin:prod:f:ai:${m}`,
  flowGiftMode: (m: string): string => `admin:prod:f:gc:${m}`,
  flowStockParser: (p: string): string => `admin:prod:f:sp:${p}`,
  flowFormPreset: (p: string): string => `admin:prod:f:fp:${p}`,
  flowSave: (): string => "admin:prod:f:save",
} as const;
