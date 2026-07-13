import type {
  OtherProductDeliveryType,
  PanelType,
  ProductType,
  ServiceLocation,
  TrafficResetCycle,
} from "@zedbot/database";

/** In-progress "add panel" wizard state. */
export interface PanelAddState {
  step: "name" | "baseUrl" | "authMode" | "username" | "password" | "token";
  type: PanelType;
  /** XUI only; chosen in the wizard (SESSION_COOKIE default). */
  authMode?: "SESSION_COOKIE" | "API_TOKEN";
  name?: string;
  baseUrl?: string;
  username?: string;
}

/** In-progress "add category" wizard state. */
export interface CategoryAddState {
  step: "name" | "order";
  type: ProductType;
  name?: string;
}

/** In-progress "add product" wizard state (service + other products). */
export interface ProductAddState {
  kind: ProductType;
  step:
    | "panel"
    | "name"
    | "groups"
    | "location"
    | "category"
    | "volume"
    | "duration"
    | "price"
    | "resetCycle"
    | "invoice"
    | "userInfo"
    | "userInfoPrompt"
    | "delivery"
    | "order"
    | "confirm";
  panelId?: string;
  panelType?: PanelType;
  panelName?: string;
  name?: string;
  groups?: string[];
  serviceLocation?: ServiceLocation | null;
  allLocations?: boolean;
  categoryId?: string;
  categoryName?: string;
  volumeGb?: number;
  durationDays?: number;
  priceToman?: number;
  trafficResetCycle?: TrafficResetCycle | null;
  invoiceDescription?: string;
  requiredUserInfoEnabled?: boolean;
  requiredUserInfoPromptText?: string | null;
  deliveryType?: OtherProductDeliveryType;
  displayOrder?: number;
}

/** Pre-invoice draft (user checkout browsing). No DB rows until "continue". */
export interface CheckoutDraft {
  productId: string;
  categoryId: string;
  /** Selected panel (SERVICE_PRODUCT flow; Phase 11.1 panel-first purchase). */
  panelId?: string;
  flowType: ProductType;
  discountCode?: string;
  discountCodeId?: string;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  /** Unique per pre-invoice; wallet-payment idempotency key (Phase 15). */
  draftNonce?: string;
}

/** Renewal pre-invoice draft (Phase 12). No DB rows until "continue". */
export interface RenewalDraft {
  serviceId: string;
  productId: string;
  panelId: string;
  categoryId: string;
  discountCode?: string;
  discountCodeId?: string;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  /** Unique per pre-invoice; wallet-payment idempotency key (Phase 15). */
  draftNonce?: string;
}

/** Extra-volume pre-invoice draft (Phase 16). No DB rows until continue/wallet confirm. */
export interface ExtraVolumeDraft {
  serviceId: string;
  productId: string;
  panelId: string;
  categoryId: string;
  discountCode?: string;
  discountCodeId?: string;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  /** Unique per pre-invoice; wallet-payment idempotency key. */
  draftNonce?: string;
}

/** Extra-time pre-invoice draft (Phase 17). No DB rows until continue/wallet confirm. */
export interface ExtraTimeDraft {
  serviceId: string;
  productId: string;
  panelId: string;
  categoryId: string;
  discountCode?: string;
  discountCodeId?: string;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  /** Unique per pre-invoice; wallet-payment idempotency key. */
  draftNonce?: string;
}

/** Wallet top-up draft (Phase 14). No DB rows until "continue". */
export interface WalletTopupDraft {
  amountToman?: number;
}

/** Card-to-card payment context while the user views the card / sends a receipt. */
export interface PaymentDraft {
  checkoutSessionId: string;
  paymentGatewayId: string;
  cardAccountId?: string;
  cardNumber?: string;
  amountToman: number;
}

/** Admin card-to-card configuration draft (Phase 21). No DB rows until confirm. */
export interface AdminPaymentDraft {
  gatewayId: string;
  /** Card-add wizard collected values (card number NEVER logged). */
  cardNumber?: string;
  ownerName?: string;
  displayOrder?: number;
}

/** Admin manual wallet adjustment draft (Phase 20). No DB rows until confirm. */
export interface AdminUserWalletDraft {
  targetUserId: string;
  action: "INCREASE" | "DECREASE";
  amountToman?: number;
  reason?: string;
  /** Minted when the flow starts; cleared with the draft on confirm/cancel. */
  draftNonce?: string;
}

/** Minimal per-user session state. Complex conversations arrive later. */
export interface SessionData {
  currentFlow: string | null;
  lastMenu: string | null;
  temp: {
    panelAdd?: PanelAddState;
    // Panel id being edited via a text-input step.
    editingPanelId?: string;
    // Field short-key being edited (from panel-fields registry).
    editingField?: string;
    // For credential edits ("password" | "token").
    editingCredential?: "password" | "token" | "cred-username" | "cred-password";
    editingCredentialUsername?: string;
    // Category management flows.
    categoryAdd?: CategoryAddState;
    editingCategoryId?: string;
    editingCategoryField?: "name" | "order";
    // Product management flows.
    productAdd?: ProductAddState;
    editingProductId?: string;
    editingProductField?: string;
    // User checkout draft (pre-invoice).
    checkoutDraft?: CheckoutDraft;
    // Renewal pre-invoice draft (Phase 12).
    renewalDraft?: RenewalDraft;
    // Wallet top-up draft (Phase 14).
    walletTopupDraft?: WalletTopupDraft;
    // Extra-volume pre-invoice draft (Phase 16).
    extraVolumeDraft?: ExtraVolumeDraft;
    // Extra-time pre-invoice draft (Phase 17).
    extraTimeDraft?: ExtraTimeDraft;
    // Card-to-card payment / receipt-upload context.
    paymentDraft?: PaymentDraft;
    // Admin receipt review: payment awaiting a rejection reason ("receipt:reject").
    rejectingPaymentId?: string;
    // Admin receipt list position (Corrective Fix B) - detail pages return
    // to this page; fallback 1.
    adminReceiptListPage?: number;
    // Where to return after jumping from a receipt detail into the admin
    // user pages (Corrective Fix B). Cleared on the users landing and the
    // admin main menu.
    adminUserReturnContext?: { kind: "receipt"; receiptId: string; receiptPage?: number };
    // Admin manual wallet adjustment (Phase 20).
    adminUserWalletDraft?: AdminUserWalletDraft;
    // Last admin user-search query ("بازگشت به نتایج" re-runs it).
    adminUserSearchQuery?: string;
    // Fix D user-side list contexts - details return to the same page.
    userTicketListPage?: number;
    userHistListKind?: "all" | "sub";
    userHistListPage?: number;
    userPayListPage?: number;
    // Fix C list contexts - details return to the same filter/page.
    adminUserListFilter?: "r" | "a" | "b" | "d";
    adminUserListPage?: number;
    adminProductListFilter?: "S" | "O" | "A" | "V" | "X";
    adminProductListPage?: number;
    adminPanelListFilter?: "a" | "i";
    adminPanelListPage?: number;
    // Admin card-to-card configuration (Phase 21).
    adminPaymentDraft?: AdminPaymentDraft;
    // OTHER_PRODUCT required-info intake (Phase 23, flow "other_product:info").
    otherProductInfoRecordId?: string;
    // Admin manual delivery draft (Phase 23, flow "admin_manual:deliver_text").
    adminDeliveryDraft?: { recordId: string; deliveryText?: string };
    // Admin manual-order navigation (Phase 24).
    adminManualOrderSearchQuery?: string;
    adminManualOrderLastFilter?: "open" | "info" | "ready" | "delivered";
    adminManualOrderLastPage?: number;
    // Support tickets (Phase 32): user new-ticket/reply draft + the admin
    // reply target.
    supportDraft?: { subject?: string; ticketId?: string };
    adminSupportReplyTicketId?: string;
    // Admin broadcast draft (Phase 33).
    adminBroadcastDraft?: { text?: string };
    // Admin text-settings edit target (Phase 34).
    adminTextEditDraft?: { kind: "template" | "button"; id: string };
    // Admin stock add-item wizard (Phase 25), bulk add (Phase 27) and
    // low-stock threshold editing (Phase 28); content NEVER logged.
    adminStockDraft?: {
      productId: string;
      content?: string;
      label?: string | null;
      bulkItems?: string[];
      invalidCount?: number;
      duplicateCount?: number;
      thresholdEditing?: true;
    };
    [key: string]: unknown;
  };
}

export function initialSession(): SessionData {
  return { currentFlow: null, lastMenu: null, temp: {} };
}
