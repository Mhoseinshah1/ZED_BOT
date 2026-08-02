import {
  CheckoutStatus,
  prisma,
  type CheckoutSession,
  type Prisma,
  type PrismaClient,
  type Service,
  type UserGroup,
} from "@zedbot/database";

import { resolveProductInboundIds, type ProductWithRelations } from "./catalog.js";
import { ServiceUsernameMode } from "@zedbot/database";

import { catalogPublicId, resolvePurchasableProduct } from "./catalog-read.js";
import {
  claimReservationForCheckout,
  reserveRandomServiceUsername,
  reserveServiceUsername,
  type PanelAdapterFactory,
} from "./username-reservation.js";
import {
  OPERATION_DISCOUNT_PURPOSE,
  OPERATION_ORDER_TYPE,
  RENEWAL_QUOTE_TTL_SECONDS,
  type CommerceResultCode,
  type ServiceOperation,
} from "./contract.js";
import { validateDiscountCode, type DiscountRejection } from "./discount.js";
import { resolveServiceOperationOption, type ServiceOperationOptionDto } from "./options.js";
import { quoteFingerprint, sealQuote } from "./quote.js";

// =============================================================================
// The checkout draft: one durable, frozen statement of what is being bought.
//
// NO SECOND CHECKOUT TABLE. `CheckoutSession` already models exactly this — a
// PENDING row carrying the buyer, the product, the target service, an immutable
// `productSnapshot`, the three price columns, the claimed discount and an
// expiry. The bot's renewal, extra-volume and extra-time flows all write one.
// Inventing a Mini-App-shaped twin would mean two tables answering "what did
// this person agree to pay", and reconciliation, refunds and reporting would
// have to learn about both.
//
// THE SNAPSHOT IS THE PRICE. Once the draft exists, the amount charged is read
// from the row, never recomputed from the live Product and never taken from the
// request. An operator repricing a product mid-checkout changes what the NEXT
// draft costs, not what this one settles at — and the quote (below) is what
// notices the change and refuses, rather than silently charging either number.
//
// PARITY IS BY CONSTRUCTION, NOT BY RESEMBLANCE. `buildOperationSnapshot`
// reproduces the exact field set the bot writes for these three flows, and
// `apps/api/tests/miniapp-commerce-checkout.test.ts` asserts it against the
// bot's own `buildRenewalSnapshot` / `buildExtraVolumeSnapshot` /
// `buildExtraTimeSnapshot` output rather than against a list copied by hand.
// The Order columns downstream are derived from these keys, so a missing one is
// a financial report that disagrees with itself.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Operator-configurable checkout lifetime, shared with the bot's flows. */
const DEFAULT_CHECKOUT_EXPIRY_MINUTES = 30;

export async function checkoutExpiryMinutes(db: Db = prisma): Promise<number> {
  try {
    const row = await db.setting.findUnique({
      where: { key: "checkout_expiry_minutes" },
      select: { value: true },
    });
    const value = Number.parseInt(row?.value ?? "", 10);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_CHECKOUT_EXPIRY_MINUTES;
  } catch {
    return DEFAULT_CHECKOUT_EXPIRY_MINUTES;
  }
}

/** The resolved money for one draft. Whole Toman throughout — never a float. */
export interface OperationPricing {
  originalPriceToman: number;
  discountCode: string | null;
  discountCodeId: string | null;
  discountAmountToman: number;
  finalPriceToman: number;
}

/**
 * The immutable capture written onto the draft.
 *
 * Field-for-field what the bot writes today for these operations: the shared
 * product block, then the per-operation target block. The representative and
 * username-customization branches of the bot's `buildProductSnapshot` are
 * absent because they are absent from these flows too — a renewal draft has
 * never carried either.
 */
export function buildOperationSnapshot(
  product: ProductWithRelations,
  service: Service,
  operation: ServiceOperation,
  pricing: OperationPricing,
): Prisma.InputJsonObject {
  const base: Prisma.InputJsonObject = {
    productId: product.id,
    productType: product.type,
    productName: product.name,
    invoiceDescription: product.invoiceDescription ?? "",
    categoryId: product.categoryId,
    categoryName: product.category.name,
    panelId: product.panelId,
    panelName: product.panel?.name ?? null,
    panelType: product.panel?.type ?? null,
    serviceLocation: product.serviceLocation,
    allLocations: product.allLocations,
    volumeGb: product.volumeGb,
    durationDays: product.durationDays,
    trafficResetCycle: product.trafficResetCycle,
    requiredUserInfoEnabled: product.requiredUserInfoEnabled,
    requiredUserInfoPromptText: product.requiredUserInfoPromptText,
    deliveryType: product.deliveryType,
    // The admin-selected naming strategy and its config, captured NOW. A paid
    // order's identity resolves from this capture, so later panel-config edits
    // never rename a paid entitlement. Carried on these operations too, even
    // though none of them names a new account, because the snapshot must be
    // byte-identical to the bot's — `SNAP-1` in the bot suite is what noticed
    // its absence here.
    ...(product.type === "SERVICE_PRODUCT" && product.panel !== null
      ? {
          namingStrategy: product.panel.usernamePatternType,
          namingCustomText: product.panel.usernameCustomText,
          namingRandomLength: product.panel.usernameRandomLength,
          namingRepresentativePrefix: product.panel.representativeUsernamePrefix,
        }
      : {}),
    originalPriceToman: pricing.originalPriceToman,
    discountCode: pricing.discountCode,
    discountAmountToman: pricing.discountAmountToman,
    finalPriceToman: pricing.finalPriceToman,
    inboundIds: resolveSoldInboundIds(product),
  };

  if (operation === "RENEWAL") {
    return {
      ...base,
      renewalTargetServiceId: service.id,
      renewalTargetUsername: service.username,
      renewalMethod: "ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD",
      renewalTargetStatus: service.status,
      renewalTargetExpiresAt: service.expiresAt?.toISOString() ?? null,
      renewalTargetRemainingBytes: service.remainingBytes.toString(),
      renewalTargetVolumeBytes: service.volumeBytes.toString(),
    };
  }
  if (operation === "EXTRA_VOLUME") {
    return {
      ...base,
      flowType: "EXTRA_VOLUME",
      extraVolumeTargetServiceId: service.id,
      extraVolumeTargetUsername: service.username,
      extraVolumeGb: product.volumeGb ?? 0,
      extraVolumeTargetRemainingBytes: service.remainingBytes.toString(),
      extraVolumeTargetVolumeBytes: service.volumeBytes.toString(),
    };
  }
  return {
    ...base,
    flowType: "EXTRA_TIME",
    extraTimeTargetServiceId: service.id,
    extraTimeTargetUsername: service.username,
    extraTimeDays: product.durationDays ?? 0,
    extraTimeTargetExpiresAt: service.expiresAt?.toISOString() ?? null,
  };
}

/** Resolved sold inbound set for the snapshot (null for non-XUI/unresolvable). */
function resolveSoldInboundIds(product: ProductWithRelations): number[] | null {
  if (product.type !== "SERVICE_PRODUCT" || product.panel?.type !== "XUI") {
    return null;
  }
  const resolution = resolveProductInboundIds(product.panel, product.inboundIds);
  return resolution.ok ? resolution.inboundIds : null;
}

// --- creating a draft --------------------------------------------------------

/**
 * The public handle for a draft. Same 8-hex convention as everything else the
 * browser is allowed to name.
 */
export function checkoutPublicId(checkout: { id: string }): string {
  return checkout.id.slice(0, 8);
}

const CHECKOUT_PUBLIC_ID_PATTERN = /^[0-9a-f]{8}$/i;

export function isCheckoutPublicId(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_PUBLIC_ID_PATTERN.test(value);
}

/** What a review screen may be told about a draft. An allowlist, not a row. */
export interface CheckoutDraftDto {
  checkoutId: string;
  operation: ServiceOperation;
  option: ServiceOperationOptionDto;
  serviceId: string;
  serviceLabel: string;
  originalPriceToman: number;
  discountCode: string | null;
  discountAmountToman: number;
  finalPriceToman: number;
  currency: "IRT";
  expiresAt: string;
}

export type CheckoutCreateResult =
  | { ok: true; checkout: CheckoutSession; draft: CheckoutDraftDto }
  | {
      ok: false;
      code: Extract<
        CommerceResultCode,
        "SERVICE_NOT_FOUND" | "SERVICE_NOT_ELIGIBLE" | "OPTION_UNAVAILABLE" | "PRODUCT_UNAVAILABLE"
      >;
      discountRejection?: DiscountRejection;
    };

export interface CheckoutCreateArgs {
  userId: string;
  group: UserGroup;
  operation: ServiceOperation;
  publicServiceId: string;
  publicOptionId: string;
  /** Optional at draft time; may also be applied afterwards. */
  discountCode?: string;
}

/**
 * Creates one PENDING draft for a service operation.
 *
 * Everything authoritative is resolved here, from the database: the service by
 * the owner-scoped gate, the option by the eligibility set, the price from the
 * Product row, the discount by the shared validator. Nothing in the request
 * contributes a number.
 *
 * Older PENDING drafts for the same user+service are cancelled first, exactly as
 * the bot does, so repeated taps cannot pile up parallel payable drafts.
 */
export async function createOperationCheckout(
  db: Db,
  args: CheckoutCreateArgs,
): Promise<CheckoutCreateResult> {
  const resolved = await resolveServiceOperationOption(db, {
    userId: args.userId,
    group: args.group,
    operation: args.operation,
    publicServiceId: args.publicServiceId,
    publicOptionId: args.publicOptionId,
  });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code };
  }
  const { product, owned } = resolved;

  const pricing = await priceOperation(db, {
    userId: args.userId,
    group: args.group,
    operation: args.operation,
    product,
    discountCode: args.discountCode,
  });
  if (!pricing.ok) {
    return { ok: false, code: "PRODUCT_UNAVAILABLE", discountRejection: pricing.reason };
  }

  const minutes = await checkoutExpiryMinutes(db);
  const expiresAt = new Date(Date.now() + minutes * 60_000);

  await db.checkoutSession.updateMany({
    where: {
      userId: args.userId,
      serviceId: owned.service.id,
      status: CheckoutStatus.PENDING,
    },
    data: { status: CheckoutStatus.CANCELLED },
  });

  const checkout = await db.checkoutSession.create({
    data: {
      userId: args.userId,
      purpose: "ORDER_PAYMENT",
      productId: product.id,
      serviceId: owned.service.id,
      orderType: OPERATION_ORDER_TYPE[args.operation],
      productSnapshot: buildOperationSnapshot(
        product,
        owned.service,
        args.operation,
        pricing.pricing,
      ),
      originalPriceToman: pricing.pricing.originalPriceToman,
      discountAmountToman: pricing.pricing.discountAmountToman,
      finalPriceToman: pricing.pricing.finalPriceToman,
      discountCodeId: pricing.pricing.discountCodeId,
      status: CheckoutStatus.PENDING,
      expiresAt,
    },
  });

  return {
    ok: true,
    checkout,
    draft: toDraftDto(checkout, resolved.option, owned.service, args.operation, pricing.pricing),
  };
}

function toDraftDto(
  checkout: CheckoutSession,
  option: ServiceOperationOptionDto,
  service: Service,
  operation: ServiceOperation,
  pricing: OperationPricing,
): CheckoutDraftDto {
  return {
    checkoutId: checkoutPublicId(checkout),
    operation,
    option,
    serviceId: service.id.slice(0, 8),
    serviceLabel: service.username,
    originalPriceToman: pricing.originalPriceToman,
    discountCode: pricing.discountCode,
    discountAmountToman: pricing.discountAmountToman,
    finalPriceToman: pricing.finalPriceToman,
    currency: "IRT",
    expiresAt: checkout.expiresAt.toISOString(),
  };
}

type PriceResult =
  | { ok: true; pricing: OperationPricing }
  | { ok: false; reason: DiscountRejection };

/**
 * The authoritative price for one operation.
 *
 * `product.priceToman` is the base for all three, which is what the bot charges:
 * reseller pricing applies to a NEW purchase made through the representative
 * flow and never to a renewal or an add-on — `resolveEffectiveProductPrice`
 * returns RETAIL for any `checkoutPurpose` other than PURCHASE, and the bot's
 * own representative suite asserts it.
 */
async function priceOperation(
  db: Db,
  args: {
    userId: string;
    group: UserGroup;
    operation: ServiceOperation;
    product: ProductWithRelations;
    discountCode?: string;
    /** Forces the discount purpose, for the NEW_PURCHASE path. */
    purposeOverride?: "PURCHASE" | "RENEWAL";
  },
): Promise<PriceResult> {
  const originalPriceToman = args.product.priceToman;
  if (args.discountCode === undefined || args.discountCode.trim() === "") {
    return {
      ok: true,
      pricing: {
        originalPriceToman,
        discountCode: null,
        discountCodeId: null,
        discountAmountToman: 0,
        finalPriceToman: originalPriceToman,
      },
    };
  }
  const validation = await validateDiscountCode(
    args.discountCode,
    { id: args.userId, group: args.group },
    originalPriceToman,
    args.purposeOverride ?? OPERATION_DISCOUNT_PURPOSE[args.operation],
    db,
  );
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }
  return {
    ok: true,
    pricing: {
      originalPriceToman,
      discountCode: validation.discountCode.code,
      discountCodeId: validation.discountCode.id,
      discountAmountToman: validation.discountAmountToman,
      finalPriceToman: validation.finalPriceToman,
    },
  };
}

// --- the quote ---------------------------------------------------------------

/**
 * What a review screen shows. Every number is computed here; the client renders
 * and never derives.
 */
export interface QuoteDto {
  quote: string;
  operation: ServiceOperation;
  checkoutId: string;
  optionLabel: string;
  serviceLabel: string;
  originalPriceToman: number;
  discountCode: string | null;
  discountAmountToman: number;
  finalPriceToman: number;
  currency: "IRT";
  walletBalanceToman: number;
  /** What the balance becomes if this settles. Server-computed, never client. */
  expectedBalanceAfterToman: number;
  /** True when the balance covers the payable amount right now. */
  affordable: boolean;
  grantedDurationDays: number | null;
  grantedTrafficGb: number | null;
  currentExpiresAt: string | null;
  /** What the expiry becomes if this settles, when the operation moves it. */
  expectedExpiresAt: string | null;
  quoteExpiresAt: string;
}

export type QuoteIssueResult =
  | { ok: true; dto: QuoteDto }
  | {
      ok: false;
      code: Extract<
        CommerceResultCode,
        "CHECKOUT_UNAVAILABLE" | "SERVICE_NOT_FOUND" | "OPTION_UNAVAILABLE" | "QUOTE_STALE"
      >;
    };

/**
 * Issues a short-lived authoritative quote against an existing draft.
 *
 * The draft supplies the FROZEN amount; the live rows supply the fingerprint.
 * If the two disagree at confirmation time — a reprice, a discount that ran out,
 * a service that changed — the confirmation refuses rather than charging either
 * figure. Issuing a quote writes nothing.
 */
export async function issueQuoteForCheckout(
  db: Db,
  args: {
    userId: string;
    group: UserGroup;
    publicCheckoutId: string;
    walletBalanceToman: number;
    nowMs?: number;
  },
): Promise<QuoteIssueResult> {
  const nowMs = args.nowMs ?? Date.now();
  const found = await loadOwnedPendingCheckout(db, args.userId, args.publicCheckoutId, nowMs);
  if (found === null) {
    return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  }
  const { checkout, operation } = found;

  const snapshot: Record<string, unknown> =
    typeof checkout.productSnapshot === "object" &&
    checkout.productSnapshot !== null &&
    !Array.isArray(checkout.productSnapshot)
      ? (checkout.productSnapshot as Record<string, unknown>)
      : {};
  const productId = typeof snapshot.productId === "string" ? snapshot.productId : null;
  if (productId === null || checkout.serviceId === null) {
    return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  }

  const state = await loadQuoteState(db, args.userId, productId, checkout.serviceId);
  if (state === null) {
    // The product or the service the draft names is gone or no longer the
    // caller's. Reported as stale rather than as "not found": the draft is real,
    // it is the world behind it that moved.
    return { ok: false, code: "QUOTE_STALE" };
  }

  const fingerprint = quoteFingerprint({
    productId,
    productPriceToman: state.product.priceToman,
    productActive: state.product.isActive,
    categoryActive: state.product.category.isActive,
    panelId: state.product.panelId,
    panelStatus: state.product.panel?.status ?? null,
    discountCodeId: checkout.discountCodeId,
    discountAmountToman: checkout.discountAmountToman,
    finalPriceToman: checkout.finalPriceToman,
    serviceId: state.service.id,
    serviceStatus: state.service.status,
    serviceExpiresAtMs: state.service.expiresAt?.getTime() ?? null,
    serviceVolumeBytes: state.service.volumeBytes.toString(),
  });

  const quoteExpiresAtMs = nowMs + RENEWAL_QUOTE_TTL_SECONDS * 1000;
  const quote = sealQuote({
    userId: args.userId,
    checkoutId: checkout.id,
    operation,
    finalPriceToman: checkout.finalPriceToman,
    fingerprint,
    expiresAtMs: quoteExpiresAtMs,
  });

  const grantedDurationDays =
    operation === "EXTRA_VOLUME" ? null : numberOrNull(snapshot.durationDays);
  const grantedTrafficGb = operation === "EXTRA_TIME" ? null : numberOrNull(snapshot.volumeGb);

  return {
    ok: true,
    dto: {
      quote,
      operation,
      checkoutId: checkoutPublicId(checkout),
      optionLabel: typeof snapshot.productName === "string" ? snapshot.productName : "",
      serviceLabel: state.service.username,
      originalPriceToman: checkout.originalPriceToman,
      discountCode: typeof snapshot.discountCode === "string" ? snapshot.discountCode : null,
      discountAmountToman: checkout.discountAmountToman,
      finalPriceToman: checkout.finalPriceToman,
      currency: "IRT",
      walletBalanceToman: args.walletBalanceToman,
      // Computed here so no client ever subtracts money on its own. A negative
      // result is not clamped: an unaffordable quote should read as unaffordable
      // rather than as a balance of zero.
      expectedBalanceAfterToman: args.walletBalanceToman - checkout.finalPriceToman,
      affordable: args.walletBalanceToman >= checkout.finalPriceToman,
      grantedDurationDays,
      grantedTrafficGb,
      currentExpiresAt: state.service.expiresAt?.toISOString() ?? null,
      expectedExpiresAt: expectedExpiry(operation, state.service, grantedDurationDays, nowMs),
      quoteExpiresAt: new Date(quoteExpiresAtMs).toISOString(),
    },
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What the expiry becomes, per the bot's apply methods.
 *
 * EXTRA_TIME is ADD_PURCHASED_DAYS_TO_CURRENT_EXPIRY: from the current expiry
 * while it is still in the future, otherwise from now. EXTRA_VOLUME never moves
 * the expiry at all. Renewal's post-state depends on the panel's own response,
 * so it is not predicted here — promising a date the panel may not produce is
 * worse than showing none.
 */
function expectedExpiry(
  operation: ServiceOperation,
  service: Service,
  grantedDurationDays: number | null,
  nowMs: number,
): string | null {
  if (operation !== "EXTRA_TIME" || grantedDurationDays === null || service.expiresAt === null) {
    return null;
  }
  const from = Math.max(service.expiresAt.getTime(), nowMs);
  return new Date(from + grantedDurationDays * 86_400_000).toISOString();
}

async function loadQuoteState(
  db: Db,
  userId: string,
  productId: string,
  serviceId: string,
): Promise<{ product: ProductWithRelations; service: Service } | null> {
  const [product, service] = await Promise.all([
    db.product.findUnique({ where: { id: productId }, include: { category: true, panel: true } }),
    // Owner-scoped in the WHERE, never checked afterwards.
    db.service.findFirst({ where: { id: serviceId, userId } }),
  ]);
  if (product === null || service === null) {
    return null;
  }
  return { product, service };
}

/** Owner-scoped, unsettled, unexpired PENDING draft for one of our operations. */
export async function loadOwnedPendingCheckout(
  db: Db,
  userId: string,
  publicCheckoutId: string,
  nowMs: number,
): Promise<{ checkout: CheckoutSession; operation: ServiceOperation } | null> {
  if (!isCheckoutPublicId(publicCheckoutId)) {
    return null;
  }
  const matches = await db.checkoutSession.findMany({
    where: {
      userId,
      id: { startsWith: publicCheckoutId.toLowerCase() },
      status: CheckoutStatus.PENDING,
      settledByPaymentId: null,
      purpose: "ORDER_PAYMENT",
    },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  const checkout = matches[0];
  if (checkout.expiresAt.getTime() <= nowMs) {
    return null;
  }
  const operation = operationOfOrderType(checkout.orderType);
  if (operation === null) {
    return null;
  }
  return { checkout, operation };
}

/** Reverse of `OPERATION_ORDER_TYPE`, restricted to the service operations. */
function operationOfOrderType(orderType: string | null): ServiceOperation | null {
  if (orderType === "SERVICE_RENEWAL") return "RENEWAL";
  if (orderType === "EXTRA_VOLUME") return "EXTRA_VOLUME";
  if (orderType === "EXTRA_TIME") return "EXTRA_TIME";
  return null;
}


// --- new subscription --------------------------------------------------------

/**
 * The frozen capture for a NEW subscription.
 *
 * The shared product block plus the buyer's username selection, in the exact
 * shape `apps/bot/src/services/checkout.service.ts` writes it — the naming
 * strategy is captured NOW so a later panel-config edit cannot rename a paid
 * entitlement, and the reservation id is captured so settlement can claim the
 * exact hold rather than "a hold for this username".
 */
export function buildPurchaseSnapshot(
  product: ProductWithRelations,
  pricing: OperationPricing,
  selection: {
    normalizedUsername: string;
    usernameMode: "RANDOM" | "CUSTOM";
    reservationId: string;
    note: string | null;
  },
): Prisma.InputJsonObject {
  return {
    productId: product.id,
    productType: product.type,
    productName: product.name,
    invoiceDescription: product.invoiceDescription ?? "",
    categoryId: product.categoryId,
    categoryName: product.category.name,
    panelId: product.panelId,
    panelName: product.panel?.name ?? null,
    panelType: product.panel?.type ?? null,
    serviceLocation: product.serviceLocation,
    allLocations: product.allLocations,
    volumeGb: product.volumeGb,
    durationDays: product.durationDays,
    trafficResetCycle: product.trafficResetCycle,
    requiredUserInfoEnabled: product.requiredUserInfoEnabled,
    requiredUserInfoPromptText: product.requiredUserInfoPromptText,
    deliveryType: product.deliveryType,
    ...(product.panel !== null
      ? {
          namingStrategy: product.panel.usernamePatternType,
          namingCustomText: product.panel.usernameCustomText,
          namingRandomLength: product.panel.usernameRandomLength,
          namingRepresentativePrefix: product.panel.representativeUsernamePrefix,
        }
      : {}),
    serviceUsername: selection.normalizedUsername,
    serviceUsernameMode: selection.usernameMode,
    serviceUsernameSelectionSource:
      selection.usernameMode === "RANDOM" ? "USER_RANDOM" : "USER_CUSTOM",
    serviceUsernameReservationId: selection.reservationId,
    serviceUserNote: selection.note,
    originalPriceToman: pricing.originalPriceToman,
    discountCode: pricing.discountCode,
    discountAmountToman: pricing.discountAmountToman,
    finalPriceToman: pricing.finalPriceToman,
    inboundIds: resolveSoldInboundIds(product),
  };
}

export type PurchaseCheckoutResult =
  | { ok: true; checkout: CheckoutSession; draft: PurchaseDraftDto }
  | {
      ok: false;
      code: Extract<
        CommerceResultCode,
        "PRODUCT_UNAVAILABLE" | "OPTION_UNAVAILABLE" | "CHECKOUT_UNAVAILABLE"
      >;
      /** Why the username could not be held, when that is the reason. */
      usernameOutcome?: string;
      discountRejection?: DiscountRejection;
    };

export interface PurchaseDraftDto {
  checkoutId: string;
  productId: string;
  productLabel: string;
  locationLabel: string | null;
  username: string;
  usernameMode: "RANDOM" | "CUSTOM";
  durationDays: number | null;
  trafficGb: number | null;
  originalPriceToman: number;
  discountCode: string | null;
  discountAmountToman: number;
  finalPriceToman: number;
  currency: "IRT";
  expiresAt: string;
}

export interface PurchaseCheckoutArgs {
  userId: string;
  group: UserGroup;
  publicProductId: string;
  /** RANDOM asks the server to mint one; CUSTOM validates the buyer's choice. */
  usernameMode: "RANDOM" | "CUSTOM";
  requestedUsername?: string;
  /** Ties the username hold to this draft, exactly as the bot's nonce does. */
  draftNonce: string;
  note?: string | null;
  discountCode?: string;
  /** The panel probe, injectable so a caller can supply a mocked boundary. */
  buildAdapter?: PanelAdapterFactory;
}

/**
 * Creates a PENDING draft for a NEW subscription, with its username reserved.
 *
 * WHY THE RESERVATION HAPPENS HERE AND NOT AT PAYMENT. The username is what the
 * remote account will be called, and it is unique across the whole installation.
 * Holding it at draft time is what stops two buyers who are both looking at the
 * checkout screen from being sold the same name; claiming it to this checkout in
 * the same breath is what stops a hold from outliving the draft that owns it.
 *
 * A failed claim leaves NOTHING behind: the create and the claim share one
 * transaction, so a payable draft can never exist without its exact active hold.
 */
export async function createPurchaseCheckout(
  db: Db,
  args: PurchaseCheckoutArgs,
): Promise<PurchaseCheckoutResult> {
  const resolved = await resolvePurchasableProduct(db, args.group, args.publicProductId);
  if (!resolved.ok) {
    return { ok: false, code: "PRODUCT_UNAVAILABLE" };
  }
  const product = resolved.product;
  if (product.panelId === null || product.panel === null) {
    // A panel-less legacy SERVICE product cannot be provisioned by this path,
    // and it carries no reservation to claim.
    return { ok: false, code: "PRODUCT_UNAVAILABLE" };
  }

  const pricing = await priceOperation(db, {
    userId: args.userId,
    group: args.group,
    // A new purchase validates discount codes under PURCHASE semantics.
    operation: "RENEWAL",
    product,
    ...(args.discountCode !== undefined ? { discountCode: args.discountCode } : {}),
    purposeOverride: "PURCHASE",
  });
  if (!pricing.ok) {
    return { ok: false, code: "PRODUCT_UNAVAILABLE", discountRejection: pricing.reason };
  }

  const held =
    args.usernameMode === "RANDOM"
      ? await reserveRandomServiceUsername({
          userId: args.userId,
          panelId: product.panelId,
          draftNonce: args.draftNonce,
          ...(args.buildAdapter !== undefined ? { buildAdapter: args.buildAdapter } : {}),
        })
      : await reserveServiceUsername({
          userId: args.userId,
          panelId: product.panelId,
          mode: ServiceUsernameMode.CUSTOM,
          normalizedUsername: (args.requestedUsername ?? "").trim().toLowerCase(),
          draftNonce: args.draftNonce,
          ...(args.buildAdapter !== undefined ? { buildAdapter: args.buildAdapter } : {}),
        });
  if (held.outcome !== "AVAILABLE") {
    // The reason IS returned here, unlike a service or option refusal: the buyer
    // typed this name and has to be told whether to pick another one. It names
    // no other user and no other row.
    return { ok: false, code: "OPTION_UNAVAILABLE", usernameOutcome: held.outcome };
  }

  const minutes = await checkoutExpiryMinutes(db);
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const snapshot = buildPurchaseSnapshot(product, pricing.pricing, {
    normalizedUsername: held.normalizedUsername,
    usernameMode: args.usernameMode,
    reservationId: held.reservationId,
    note: args.note ?? null,
  });

  try {
    const checkout = await prisma.$transaction(async (tx) => {
      // Serialize the "cancel old then create new" transition across every API
      // replica.  There may be no existing checkout row to lock, so a row lock
      // cannot close the empty-set race; a transaction-scoped PostgreSQL
      // advisory lock provides a stable lock row derived from the owner and
      // product and is released automatically on commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zedbot-purchase-checkout:${args.userId}:${product.id}`}))`;
      // Repeated taps must not pile up parallel payable drafts for one product.
      await tx.checkoutSession.updateMany({
        where: {
          userId: args.userId,
          productId: product.id,
          status: CheckoutStatus.PENDING,
        },
        data: { status: CheckoutStatus.CANCELLED },
      });
      const created = await tx.checkoutSession.create({
        data: {
          userId: args.userId,
          purpose: "ORDER_PAYMENT",
          productId: product.id,
          orderType: OPERATION_ORDER_TYPE.NEW_PURCHASE,
          productSnapshot: snapshot,
          originalPriceToman: pricing.pricing.originalPriceToman,
          discountAmountToman: pricing.pricing.discountAmountToman,
          finalPriceToman: pricing.pricing.finalPriceToman,
          discountCodeId: pricing.pricing.discountCodeId,
          status: CheckoutStatus.PENDING,
          expiresAt,
        },
      });
      // The ONE authoritative claim: one atomic UPDATE verifying owner, nonce,
      // username, mode, CURRENT panel, HELD, unexpired and unlinked. Throwing
      // rolls the checkout back with it.
      const claim = await claimReservationForCheckout(
        tx,
        {
          reservationId: held.reservationId,
          userId: args.userId,
          draftNonce: args.draftNonce,
          normalizedUsername: held.normalizedUsername,
          mode: held.mode,
          panelId: product.panelId as string,
        },
        created.id,
      );
      if (!claim.ok) {
        throw new PurchaseClaimFailed();
      }
      return created;
    });

    return {
      ok: true,
      checkout,
      draft: {
        checkoutId: checkoutPublicId(checkout),
        productId: catalogPublicId(product),
        productLabel: product.name,
        locationLabel: product.panel?.name ?? null,
        username: held.normalizedUsername,
        usernameMode: args.usernameMode,
        durationDays: product.durationDays ?? null,
        trafficGb: product.volumeGb ?? null,
        originalPriceToman: pricing.pricing.originalPriceToman,
        discountCode: pricing.pricing.discountCode,
        discountAmountToman: pricing.pricing.discountAmountToman,
        finalPriceToman: pricing.pricing.finalPriceToman,
        currency: "IRT",
        expiresAt: checkout.expiresAt.toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof PurchaseClaimFailed) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
    }
    throw err;
  }
}

/** Thrown inside the draft transaction so the claim and the create roll back together. */
class PurchaseClaimFailed extends Error {
  constructor() {
    super("username reservation could not be claimed for this checkout");
    this.name = "PurchaseClaimFailed";
  }
}
