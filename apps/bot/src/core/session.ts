import type {
  OtherProductDeliveryType,
  OtherProductFulfillmentProfile,
  OtherProductKind,
  OtherProductStockParser,
  PanelType,
  ProductType,
  ServiceLocation,
  TrafficResetCycle,
} from "@zedbot/database";
import type {
  DiagnosticSnapshot,
  ServiceDiagnosticAction,
  SupportTicketCategory,
  SupportTicketOrigin,
} from "@zedbot/shared";

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
    | "otherKind"
    | "aiMode"
    | "giftMode"
    | "stockParser"
    | "formPreset"
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
  // Specialized-workflows phase (OTHER_PRODUCT wizard branching).
  otherProductKind?: OtherProductKind;
  otherProductFulfillmentProfile?: OtherProductFulfillmentProfile;
  otherProductStockParser?: OtherProductStockParser;
  collectInfoBeforeManualApproval?: boolean;
  customerInputSchemaPreset?: "TELEGRAM_PREMIUM" | "PERSONALIZED_AI" | "NONE";
}

/**
 * Where a checkout pre-invoice was opened FROM — pure navigation metadata used
 * only to route the pre-invoice «بازگشت» button back to the exact surface the
 * user came from (feat/public-pricing-catalog). It NEVER affects price, product
 * eligibility, settlement or authorization: those are always re-derived from the
 * live Product + user group at click time. A missing origin behaves exactly like
 * the historical RETAIL_CATALOG buy flow. The pricing variants carry only bounded
 * ids + a page number so the return page can be rebuilt server-side; no callback
 * string is ever stored.
 */
export type CheckoutOrigin =
  | { kind: "RETAIL_CATALOG" }
  | { kind: "PRICING_SERVICE"; panelId: string; categoryId: string; page: number }
  | { kind: "PRICING_OTHER"; categoryId: string; page: number }
  | { kind: "REPRESENTATIVE" };

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
  /**
   * Where this pre-invoice was opened from (feat/public-pricing-catalog). Drives
   * ONLY the «بازگشت» destination; absent = the historical retail buy-flow back
   * navigation. Never consulted for pricing, eligibility, settlement or auth.
   */
  origin?: CheckoutOrigin;
  /**
   * Representative Program (feat/representative-program, §16): present ONLY for
   * a reseller-priced purchase started from «خرید نمایندگی». When absent (every
   * normal retail checkout) the flow behaves byte-identically to before. Carries
   * the immutable pricing agreement (retail/base + tier identity + stale-price
   * fingerprints) that the settlement boundary re-validates before money moves.
   */
  representative?: RepresentativeDraftContext;
}

/** The frozen reseller-pricing agreement carried on a representative checkout
 * draft. Behaviour binds to these codes/ids, never a Persian label. */
export interface RepresentativeDraftContext {
  representativeId: string;
  tierId: string;
  tierSlug: string;
  /** REPRESENTATIVE_PRICE_MODES code at agreement time. */
  priceMode: string;
  retailPriceToman: number;
  /** Resolved reseller base price (before any stackable discount). */
  basePriceToman: number;
  tierFingerprint: string;
  priceFingerprint: string;
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
  /**
   * Menu-keyboard-mode phase: true after the persistent REPLY main menu was
   * delivered to this user. Lets the INLINE mode remove the stale reply
   * keyboard exactly once after an admin switches modes (quiet transition).
   */
  replyMenuKeyboardActive?: boolean;
  /**
   * Admin-menu-keyboard-mode phase: true after the persistent REPLY admin
   * menu was delivered to this chat. Together with replyMenuKeyboardActive
   * it tracks WHICH persistent keyboard is on screen, so user/admin menu
   * transitions replace it and INLINE renders remove it exactly once.
   */
  adminReplyMenuKeyboardActive?: boolean;
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
    // Representative Program (feat/representative-program, §9,§10): the
    // application-wizard draft. Held in session ONLY — no DB row until the
    // applicant confirms. Free-text is never persisted anywhere until submit.
    repApplicationDraft?: {
      step:
        | "fullName"
        | "phone"
        | "province"
        | "city"
        | "salesChannel"
        | "expected"
        | "experience"
        | "explanation"
        | "preview";
      fullName?: string;
      phone?: string;
      province?: string;
      city?: string;
      salesChannel?: string;
      expectedMonthlyCustomers?: number;
      experience?: string | null;
      explanation?: string;
    };
    // Representative Program admin flows (§11-§19): reason/name/price text input.
    adminRepDraft?: {
      kind:
        | "reject"
        | "suspend"
        | "terminate"
        | "tier_name"
        | "tier_desc"
        | "price_fixed"
        | "price_percent";
      applicationId?: string;
      representativeId?: string;
      tierId?: string;
      productId?: string;
      nonce: string;
    };
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
    // Trial-entitlement phase: per-user trial-management drafts (grant /
    // set-remaining / reset / revoke / cooldown / denial / force-resolve).
    // One-shot nonce = the operation's idempotency key; the draft is
    // consumed BEFORE applying so a double confirmation cannot re-run.
    adminTrialActionDraft?: {
      userId: string;
      kind:
        | "grant"
        | "set_remaining"
        | "reset"
        | "revoke"
        | "cooldown_set"
        | "denial_set"
        | "force_created"
        | "force_not_created";
      step: string;
      nonce: string;
      count?: number;
      desired?: number;
      panelId?: string;
      expiresAt?: string;
      untilIso?: string;
      claimId?: string;
      reason?: string;
    };
    // Trial-entitlement phase: campaign builder draft (audience, allowance,
    // expiry, notify, include-with-allowance, reason, typed confirmation).
    adminTrialCampaignDraft?: {
      step: string;
      audienceKind?: string;
      audienceDate?: string;
      selectedUserIds?: string[];
      allowance?: number;
      expiresAt?: string;
      notifyUsers?: boolean;
      includeUsersWithAllowance?: boolean;
      reason?: string;
      campaignId?: string;
    };
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
    // "stock" = AWAITING_STOCK list (specialized-workflows phase, additive).
    adminManualOrderLastFilter?: "open" | "info" | "ready" | "delivered" | "stock";
    adminManualOrderLastPage?: number;
    // Support tickets (Phase 32 + V2): the user new-ticket wizard + reply draft.
    // V2 adds the chosen structured category, the origin the ticket was opened
    // from, an OPTIONAL owner-scoped linked serviceId (re-resolved before every
    // final submission — never trusted from the session alone), and the Service
    // picker page. All fields are bounded typed values or ids — never a
    // subscription URL, config or token. `ticketId` is the reply target.
    supportDraft?: {
      subject?: string;
      ticketId?: string;
      category?: SupportTicketCategory;
      origin?: SupportTicketOrigin;
      serviceId?: string;
      servicePage?: number;
    };
    // Device connection guides (feat/device-connection-guides): short-lived,
    // server-side handoff context so the support prompt can show the selected
    // service/device/app and the cancel button can return to the EXACT guide
    // page. Ids only (service short id, compact platform code, app slug) - never
    // a subscription URL, config or credential. Cleared with supportDraft.
    guideSupportContext?: { sid: string; pcode: string; slug: string };
    // Service self-diagnostics (feat/service-self-diagnostics). The last rendered
    // report's SAFE, secret-free snapshot (+ owner-scoped serviceId + short id +
    // primary recommendation), so the support preview and the confirm step can
    // reuse it WITHOUT a second panel read. The snapshot is validated before it
    // is persisted and never holds a URL/config/token/credential. Cleared when a
    // support handoff is cancelled or a diagnostic ticket is created.
    diagnosticSupportContext?: {
      sid: string;
      serviceId: string;
      snapshot: DiagnosticSnapshot;
      primary?: ServiceDiagnosticAction;
    };
    adminSupportReplyTicketId?: string;
    // Admin broadcast draft (Phase 33).
    adminBroadcastDraft?: { text?: string };
    // Admin text-settings edit target (Phase 34).
    adminTextEditDraft?: { kind: "template" | "button"; id: string };
    // Device connection guides admin (feat/device-connection-guides). The
    // create-wizard accumulator + the single-field editor target. Holds only
    // operator-authored content in progress (never a Service secret); the app
    // row is created/updated by the guide service. `field` names which field
    // the next admin text message edits.
    adminDeviceGuideDraft?: {
      mode: "create" | "edit";
      platform?: string;
      appId?: string;
      field?: string;
      displayName?: string;
      primaryDownloadUrl?: string;
    };
    // Checkout-payment reminder config edit (Phase 2, flow "admin_ntf_co:cfg").
    // Holds which rule + which numeric field the next admin text message edits.
    adminCheckoutNtfDraft?: { rule: "abandoned" | "payment"; field: string };
    // Customer win-back config edit (Phase 3, flow "admin_ntf_wb:cfg"). Holds
    // which win-back config field the next admin text message edits.
    adminWinbackNtfDraft?: { field: string };
    // Analytics report date-range input (Phase 4, flow "admin_analytics:range").
    // Holds only which report view the parsed range applies to (never PII).
    adminAnalyticsDraft?: { view: "cohort" | "conversion" };
    // Production-backup rework: scheduled-backup text input target (the
    // "rb:sched_hour" flow currently only edits the run hour).
    adminBackupScheduleDraft?: { field: "hour" };
    // Direct-log-group-setup phase: the numeric-ID connection flow
    // ("lg:chat_id"). Holds the created attempt id (never the chat id) so the
    // confirm/progress pages resolve the durable LogGroupSetupAttempt row.
    adminLogGroupSetupDraft?: { attemptId?: string };
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
      /**
       * Parser-aware import (specialized-workflows phase): the raw pasted
       * inventory kept between preview and confirm. importStockItems
       * re-parses + re-validates it from scratch; NEVER logged.
       */
      parserRaw?: string;
    };
    // Wallet auto-renewal consent draft (Phase 1, flow "arn:ceiling"). Holds
    // the in-progress consent selection until the final confirm creates the
    // mandate; carries only ids + the entered ceiling (never money moves here).
    autoRenewalDraft?: { serviceId: string; productId: string; maximumChargeToman?: number };
    // Pre-settlement customer-input form draft (specialized-workflows phase,
    // flow "customer_input:form"). In-progress answers live ONLY here until
    // the final confirm persists them encrypted; values are NEVER logged.
    customerInputForm?: {
      checkoutSessionId: string;
      orderId?: string;
      fieldIndex: number;
      answers: Record<string, string>;
      reviewing?: boolean;
    };
    // Admin Service Operations (feat/admin-service-operations): the in-progress
    // admin lifecycle mutation / note. Holds ONLY the target service id, the
    // operation type, the chosen value, the captured stale-preview fingerprint,
    // the entered reason/note and a one-shot nonce (= the operation's
    // idempotency seed, consumed BEFORE executing so a double confirm can never
    // re-run). No subscription URL / config / token ever lives here.
    adminServiceOpDraft?: {
      serviceId: string;
      type: "ENABLE" | "DISABLE" | "ADD_VOLUME" | "ADD_TIME" | "REGENERATE_LINK" | "ADD_NOTE";
      step: "reason" | "custom_volume" | "custom_time" | "note" | "ready";
      nonce: string;
      expectedFingerprint?: string;
      requestedCount?: number;
      reason?: string;
    };
    [key: string]: unknown;
  };
}

export function initialSession(): SessionData {
  return { currentFlow: null, lastMenu: null, temp: {} };
}
