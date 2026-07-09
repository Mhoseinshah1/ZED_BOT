import type {
  OtherProductDeliveryType,
  PanelType,
  ProductType,
  ServiceLocation,
  TrafficResetCycle,
} from "@zedbot/database";

/** In-progress "add panel" wizard state. */
export interface PanelAddState {
  step: "name" | "baseUrl" | "username" | "password" | "token";
  type: PanelType;
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
    editingCredential?: "password" | "token";
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
    // Card-to-card payment / receipt-upload context.
    paymentDraft?: PaymentDraft;
    // Admin receipt review: payment awaiting a rejection reason ("receipt:reject").
    rejectingPaymentId?: string;
    [key: string]: unknown;
  };
}

export function initialSession(): SessionData {
  return { currentFlow: null, lastMenu: null, temp: {} };
}
