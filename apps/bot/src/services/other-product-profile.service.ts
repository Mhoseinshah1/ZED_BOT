import type {
  OtherProductFulfillmentProfile,
  OtherProductKind,
  OtherProductStockParser,
  Product,
} from "@zedbot/database";

import {
  PERSONALIZED_AI_DEFAULT_SCHEMA,
  PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA,
  TELEGRAM_PREMIUM_DEFAULT_SCHEMA,
  validateCustomerInputSchema,
  type CustomerInputSchema,
} from "./customer-input-schema.service.js";

// =============================================================================
// Specialized-workflows phase: THE single behavior authority for
// OTHER_PRODUCT fulfillment. Every question of the form "how is this product
// fulfilled?" - stock vs manual vs personalized, which inventory parser,
// whether/what customer info is collected, when it is collected, which
// completion message applies - is answered HERE and nowhere else.
//
//   resolveEffectiveProfile  - live Product row -> effective behavior.
//   buildFulfillmentSnapshot - the immutable JSON frozen onto
//                              CheckoutSession.otherProductFulfillmentSnapshot
//                              at checkout creation; paid orders fulfill from
//                              this capture, never from the mutable Product.
//   readFulfillmentSnapshot  - stored snapshot -> behavior, with the
//                              documented legacy fallback for pre-phase
//                              checkouts whose snapshot column is null.
//
// GENERIC products keep their legacy behavior EXACTLY: the resolver derives
// it from the legacy columns (deliveryType / stockEnabled /
// requiredUserInfoEnabled) with the same rule the Phase 25 stock service
// used, so no existing product changes behavior by the mere existence of
// this module.
// =============================================================================

export interface OtherProductFulfillmentSnapshot {
  version: 1;
  kind: OtherProductKind;
  profile: OtherProductFulfillmentProfile;
  stockParser: OtherProductStockParser | null;
  requiresCustomerInfo: boolean;
  collectInfoBeforeManualApproval: boolean;
  /**
   * §4: when true, the structured customer-info form is MANDATORY BEFORE any
   * payment/settlement (wallet deduct, gateway/Stars invoice, card receipt
   * approval all fail closed until it is submitted+confirmed). Used by the
   * personalized Apple ID build, where the buyer's details are needed to
   * create the account before money is taken. When false (the default, and
   * every legacy snapshot that predates this field), info is collected AFTER
   * payment in the manual queue (WAITING_USER_INFO) exactly as before - so
   * TELEGRAM_PREMIUM / AI_ACCOUNT / legacy MANUAL keep their post-payment
   * collection. Distinguishes Apple's pre-payment policy from the identical
   * PERSONALIZED_SERVICE profile of other kinds WITHOUT touching any stock
   * gate (§6 is about stock decisions only).
   */
  requireInfoBeforeSettlement: boolean;
  customerInputSchema: CustomerInputSchema | null;
  promptText: string | null;
  completionMessageTemplate: string | null;
}

/** The Product columns the resolver reads (legacy + specialized). */
export type ProfileProductFields = Pick<
  Product,
  | "otherProductKind"
  | "otherProductFulfillmentProfile"
  | "otherProductStockParser"
  | "collectInfoBeforeManualApproval"
  | "customerInputSchema"
  | "completionMessageTemplate"
  | "requiredUserInfoEnabled"
  | "requiredUserInfoPromptText"
  | "deliveryType"
  | "stockEnabled"
>;

/** Misconfigured kind/profile combination - the product is not sellable. */
export class FulfillmentProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillmentProfileError";
  }
}

// Allowed profiles per specialized kind; the first entry is the kind default
// used when the profile column is null. AI_ACCOUNT has NO default - the
// admin must choose stock credentials vs personalized service explicitly.
const KIND_PROFILES: Record<
  Exclude<OtherProductKind, "GENERIC">,
  { allowed: OtherProductFulfillmentProfile[]; fallback: OtherProductFulfillmentProfile | null }
> = {
  // APPLE_ID supports ready-from-stock credentials OR a personalized manual
  // build. The fallback is STOCK_CREDENTIAL ONLY for legacy rows whose profile
  // column is null (pre-personalized Apple products) - the creation wizard
  // forces an explicit choice for new products, so nothing new silently defaults.
  APPLE_ID: { allowed: ["STOCK_CREDENTIAL", "PERSONALIZED_SERVICE"], fallback: "STOCK_CREDENTIAL" },
  AI_ACCOUNT: { allowed: ["STOCK_CREDENTIAL", "PERSONALIZED_SERVICE"], fallback: null },
  TELEGRAM_PREMIUM: { allowed: ["PERSONALIZED_SERVICE"], fallback: "PERSONALIZED_SERVICE" },
  GIFT_CARD: { allowed: ["STOCK_CODE", "MANUAL_DELIVERY"], fallback: "STOCK_CODE" },
};

// Default inventory parser per kind, used only for stock profiles when the
// parser column is null.
const KIND_DEFAULT_PARSER: Record<
  Exclude<OtherProductKind, "GENERIC">,
  OtherProductStockParser
> = {
  APPLE_ID: "EMAIL_BOUNDARY",
  AI_ACCOUNT: "SINGLE_LINE",
  TELEGRAM_PREMIUM: "SINGLE_LINE",
  GIFT_CARD: "SINGLE_LINE",
};

function isStockProfile(profile: OtherProductFulfillmentProfile): boolean {
  return profile === "STOCK_CREDENTIAL" || profile === "STOCK_CODE";
}

/** Empty/whitespace-only optional texts normalize to null. */
function normalizeText(value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  return value;
}

/** Product schema column -> validated schema, else the kind's default form. */
function resolveCustomerInputSchema(
  kind: OtherProductKind,
  raw: unknown,
): CustomerInputSchema | null {
  if (raw !== null && raw !== undefined) {
    const validation = validateCustomerInputSchema(raw);
    if (validation.ok) {
      return validation.schema;
    }
  }
  if (kind === "TELEGRAM_PREMIUM") {
    return TELEGRAM_PREMIUM_DEFAULT_SCHEMA;
  }
  if (kind === "AI_ACCOUNT") {
    return PERSONALIZED_AI_DEFAULT_SCHEMA;
  }
  if (kind === "APPLE_ID") {
    return PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA;
  }
  return null;
}

/**
 * LEGACY GENERIC resolver - byte-for-byte today's behavior:
 *   - stock delivery when (deliveryType STOCK_ITEM OR stockEnabled) AND NOT
 *     requiredUserInfoEnabled (the exact Phase 25 auto-delivery gate);
 *   - otherwise manual delivery, with requiredUserInfoEnabled deciding the
 *     free-text info step (no structured schema for GENERIC).
 * collectInfoBeforeManualApproval defaults to false on legacy rows, so the
 * pass-through changes nothing until an admin turns it on explicitly.
 */
function resolveGenericProfile(product: ProfileProductFields): OtherProductFulfillmentSnapshot {
  const stockDelivery =
    (product.deliveryType === "STOCK_ITEM" || product.stockEnabled) &&
    !product.requiredUserInfoEnabled;
  return {
    version: 1,
    kind: "GENERIC",
    profile: stockDelivery ? "STOCK_CREDENTIAL" : "MANUAL_DELIVERY",
    stockParser: stockDelivery ? "SINGLE_LINE" : null,
    requiresCustomerInfo: product.requiredUserInfoEnabled,
    // Legacy GENERIC keeps post-payment collection.
    requireInfoBeforeSettlement: false,
    collectInfoBeforeManualApproval:
      product.requiredUserInfoEnabled && product.collectInfoBeforeManualApproval,
    customerInputSchema: null,
    promptText: normalizeText(product.requiredUserInfoPromptText),
    completionMessageTemplate: normalizeText(product.completionMessageTemplate),
  };
}

/**
 * Resolves the EFFECTIVE fulfillment behavior of one product row.
 *
 * GENERIC        -> the exact legacy derivation (see resolveGenericProfile).
 * Specialized    -> the specialized columns, with kind defaults for null:
 *   APPLE_ID         STOCK_CREDENTIAL (EMAIL_BOUNDARY parser, no info step) OR
 *                    PERSONALIZED_SERVICE (structured info form, manual build,
 *                    no stock); a null profile resolves to STOCK_CREDENTIAL for
 *                    legacy rows, but the wizard forces an explicit new choice.
 *   AI_ACCOUNT       profile column REQUIRED (STOCK_CREDENTIAL or
 *                    PERSONALIZED_SERVICE) - throws when missing/invalid.
 *   TELEGRAM_PREMIUM PERSONALIZED_SERVICE, info collected, collect-before-
 *                    approval forced on (the kind's defining behavior).
 *   GIFT_CARD        STOCK_CODE + SINGLE_LINE by default; MANUAL_DELIVERY
 *                    allowed as the explicit alternative.
 *
 * requiresCustomerInfo: always true for PERSONALIZED_SERVICE, the legacy
 * requiredUserInfoEnabled flag for MANUAL_DELIVERY, false for stock
 * profiles (they auto-deliver). Throws FulfillmentProfileError on a
 * kind/profile combination outside the table above.
 */
export function resolveEffectiveProfile(
  product: ProfileProductFields,
): OtherProductFulfillmentSnapshot {
  if (product.otherProductKind === "GENERIC") {
    return resolveGenericProfile(product);
  }
  const kind = product.otherProductKind;
  const { allowed, fallback } = KIND_PROFILES[kind];

  let profile = product.otherProductFulfillmentProfile;
  if (profile === null) {
    if (fallback === null) {
      throw new FulfillmentProfileError(
        `Product kind ${kind} requires an explicit fulfillment profile (one of: ${allowed.join(", ")}).`,
      );
    }
    profile = fallback;
  }
  if (!allowed.includes(profile)) {
    throw new FulfillmentProfileError(
      `Fulfillment profile ${profile} is not valid for product kind ${kind} (allowed: ${allowed.join(", ")}).`,
    );
  }

  const stockParser = isStockProfile(profile)
    ? (product.otherProductStockParser ?? KIND_DEFAULT_PARSER[kind])
    : null;
  const requiresCustomerInfo =
    profile === "PERSONALIZED_SERVICE"
      ? true
      : profile === "MANUAL_DELIVERY"
        ? product.requiredUserInfoEnabled
        : false;
  const collectInfoBeforeManualApproval =
    requiresCustomerInfo &&
    (kind === "TELEGRAM_PREMIUM" ? true : product.collectInfoBeforeManualApproval);
  // §4: only the personalized Apple ID build gates payment on the form. Every
  // other personalized kind keeps its established post-payment collection.
  const requireInfoBeforeSettlement = requiresCustomerInfo && kind === "APPLE_ID";

  return {
    version: 1,
    kind,
    profile,
    stockParser,
    requiresCustomerInfo,
    collectInfoBeforeManualApproval,
    requireInfoBeforeSettlement,
    customerInputSchema: requiresCustomerInfo
      ? resolveCustomerInputSchema(kind, product.customerInputSchema)
      : null,
    promptText: normalizeText(product.requiredUserInfoPromptText),
    completionMessageTemplate: normalizeText(product.completionMessageTemplate),
  };
}

/**
 * The JSON frozen onto CheckoutSession.otherProductFulfillmentSnapshot at
 * checkout creation (same shape as the resolver output). Throws
 * FulfillmentProfileError for a misconfigured product - checkout creation
 * must fail BEFORE any payment rather than sell an unresolvable product.
 */
export function buildFulfillmentSnapshot(
  product: ProfileProductFields,
): OtherProductFulfillmentSnapshot {
  return resolveEffectiveProfile(product);
}

const KINDS: readonly OtherProductKind[] = [
  "GENERIC",
  "APPLE_ID",
  "AI_ACCOUNT",
  "TELEGRAM_PREMIUM",
  "GIFT_CARD",
];
const PROFILES: readonly OtherProductFulfillmentProfile[] = [
  "MANUAL_DELIVERY",
  "STOCK_CREDENTIAL",
  "STOCK_CODE",
  "PERSONALIZED_SERVICE",
];
const PARSERS: readonly OtherProductStockParser[] = [
  "SINGLE_LINE",
  "EXPLICIT_SEPARATOR",
  "EMAIL_BOUNDARY",
];

/**
 * Parses + validates a stored snapshot Json. Malformed core fields return
 * null (the caller falls back to the legacy derivation); an invalid embedded
 * customerInputSchema is dropped to null WITHOUT rejecting the snapshot, so
 * a schema problem can never silently downgrade the fulfillment profile.
 */
function parseStoredSnapshot(value: unknown): OtherProductFulfillmentSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    return null;
  }
  if (!KINDS.includes(raw.kind as OtherProductKind)) {
    return null;
  }
  if (!PROFILES.includes(raw.profile as OtherProductFulfillmentProfile)) {
    return null;
  }
  if (raw.stockParser !== null && !PARSERS.includes(raw.stockParser as OtherProductStockParser)) {
    return null;
  }
  if (
    typeof raw.requiresCustomerInfo !== "boolean" ||
    typeof raw.collectInfoBeforeManualApproval !== "boolean"
  ) {
    return null;
  }
  const promptText = typeof raw.promptText === "string" ? raw.promptText : null;
  const completionMessageTemplate =
    typeof raw.completionMessageTemplate === "string" ? raw.completionMessageTemplate : null;
  let customerInputSchema: CustomerInputSchema | null = null;
  if (raw.customerInputSchema !== null && raw.customerInputSchema !== undefined) {
    const validation = validateCustomerInputSchema(raw.customerInputSchema);
    if (validation.ok) {
      customerInputSchema = validation.schema;
    }
  }
  return {
    version: 1,
    kind: raw.kind as OtherProductKind,
    profile: raw.profile as OtherProductFulfillmentProfile,
    stockParser: (raw.stockParser ?? null) as OtherProductStockParser | null,
    requiresCustomerInfo: raw.requiresCustomerInfo,
    collectInfoBeforeManualApproval: raw.collectInfoBeforeManualApproval,
    // Additive field: legacy snapshots frozen before it existed default to
    // false (post-payment collection), so no old checkout/order changes
    // behavior or becomes unfulfillable.
    requireInfoBeforeSettlement: raw.requireInfoBeforeSettlement === true,
    customerInputSchema,
    promptText: normalizeText(promptText),
    completionMessageTemplate: normalizeText(completionMessageTemplate),
  };
}

/** Optional live-product loader for the legacy fallback path. */
export type SnapshotProductLoader = () => Promise<ProfileProductFields | null>;

/**
 * Reads the fulfillment behavior of one checkout.
 *
 * 1. A valid stored otherProductFulfillmentSnapshot wins - paid orders are
 *    fulfilled from the capture, never from the mutable Product row.
 * 2. LEGACY COMPATIBILITY (snapshot null/malformed): when a productLoader is
 *    provided and resolves, behavior is derived from the LIVE product -
 *    exactly what the pre-phase fulfillment code did (it always read
 *    order.product). A loader throw (misconfiguration) falls through.
 * 3. Last resort: derive from the checkout's productSnapshot copy
 *    (requiredUserInfoEnabled / requiredUserInfoPromptText / deliveryType)
 *    with kind GENERIC. productSnapshot never captured stockEnabled, so only
 *    deliveryType STOCK_ITEM can indicate stock here - acceptable for the
 *    deleted-product edge this path exists for.
 */
export async function readFulfillmentSnapshot(
  checkout: { otherProductFulfillmentSnapshot: unknown; productSnapshot: unknown },
  productLoader?: SnapshotProductLoader,
): Promise<OtherProductFulfillmentSnapshot> {
  const stored = parseStoredSnapshot(checkout.otherProductFulfillmentSnapshot);
  if (stored !== null) {
    return stored;
  }
  if (productLoader !== undefined) {
    try {
      const product = await productLoader();
      if (product !== null) {
        return resolveEffectiveProfile(product);
      }
    } catch {
      // Misconfigured/unloadable product: fall through to the snapshot copy.
    }
  }

  const snapshot =
    checkout.productSnapshot !== null &&
    typeof checkout.productSnapshot === "object" &&
    !Array.isArray(checkout.productSnapshot)
      ? (checkout.productSnapshot as Record<string, unknown>)
      : {};
  const requiredUserInfoEnabled = snapshot.requiredUserInfoEnabled === true;
  const requiredUserInfoPromptText =
    typeof snapshot.requiredUserInfoPromptText === "string"
      ? snapshot.requiredUserInfoPromptText
      : null;
  const stockDelivery = snapshot.deliveryType === "STOCK_ITEM" && !requiredUserInfoEnabled;
  return {
    version: 1,
    kind: "GENERIC",
    profile: stockDelivery ? "STOCK_CREDENTIAL" : "MANUAL_DELIVERY",
    stockParser: stockDelivery ? "SINGLE_LINE" : null,
    requiresCustomerInfo: requiredUserInfoEnabled,
    collectInfoBeforeManualApproval: false,
    // Legacy GENERIC fallback keeps post-payment collection.
    requireInfoBeforeSettlement: false,
    customerInputSchema: null,
    promptText: normalizeText(requiredUserInfoPromptText),
    completionMessageTemplate: null,
  };
}

// --- display labels -------------------------------------------------------------------------

const KIND_LABELS: Record<OtherProductKind, string> = {
  GENERIC: "محصول عمومی",
  APPLE_ID: "اپل آیدی",
  AI_ACCOUNT: "اکانت هوش مصنوعی",
  TELEGRAM_PREMIUM: "تلگرام پریمیوم",
  GIFT_CARD: "گیفت کارت",
};

const PROFILE_LABELS: Record<OtherProductFulfillmentProfile, string> = {
  MANUAL_DELIVERY: "تحویل دستی",
  STOCK_CREDENTIAL: "اکانت از موجودی",
  STOCK_CODE: "کد از موجودی",
  PERSONALIZED_SERVICE: "سرویس شخصی‌سازی‌شده",
};

/** Persian display label of a product kind - admin pages must use THIS. */
export function kindLabel(kind: OtherProductKind): string {
  return KIND_LABELS[kind];
}

/** Persian display label of a fulfillment profile - admin pages must use THIS. */
export function profileLabel(profile: OtherProductFulfillmentProfile): string {
  return PROFILE_LABELS[profile];
}
