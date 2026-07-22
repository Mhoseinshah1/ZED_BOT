import { prisma, type DiscountCode, type Product, type User } from "@zedbot/database";
import {
  buildRepresentativePriceFingerprint,
  buildRepresentativeTierFingerprint,
  isRepresentativePriceMode,
  REPRESENTATIVE_PRICING_MODE,
  resolveRepresentativeBasePrice,
  type RepresentativePriceMode,
} from "@zedbot/shared";

import { calculateDiscountAmount, type DiscountPurpose } from "./discount.service.js";
import {
  isRepresentativeCheckoutEnabled,
  isRepresentativeCheckoutEnabledFresh,
} from "./representative-settings.service.js";

// =============================================================================
// Representative Program — the ONE authoritative effective-price resolver (§7).
//
// resolveEffectiveProductPrice is the single place that decides what a checkout
// actually costs. Precedence (§7):
//   1. Product.priceToman (retail) — ALWAYS the ceiling; a rep never pays more.
//   2. An ACTIVE representative's ACTIVE tier price for this ELIGIBLE
//      SERVICE_PRODUCT replaces the base with the reseller price.
//   3. A DiscountCode applies on top ONLY in retail mode, or in representative
//      mode when the code is explicitly flagged allowRepresentativeStacking;
//      otherwise the code is ignored (never rejected loudly here).
// The final price is never negative; a zero final is left for the checkout layer
// to block unless it has a safe free-checkout contract.
//
// FINANCIAL ISOLATION (§6): this function ONLY computes the final product price
// of a normal checkout. It creates NO commission, NO wallet entry, NO second
// ledger. For a non-representative it returns RETAIL that is byte-identical to
// product.priceToman, so the existing retail flow is unchanged.
//
// The resolver is pure-read: it never writes. The immutable snapshot,
// RepresentativePurchase marker and settlement live in the checkout/core layers.
// =============================================================================

/** Retail vs reseller pricing outcome. The RETAIL branch is byte-identical to
 * the legacy `product.priceToman` behaviour for any non-representative. */
export type EffectiveProductPrice =
  | {
      pricingMode: "RETAIL";
      retailPriceToman: number;
      basePriceToman: number;
      discountCodeId: string | null;
      discountAmountToman: number;
      finalPriceToman: number;
    }
  | {
      pricingMode: typeof REPRESENTATIVE_PRICING_MODE;
      representativeId: string;
      tierId: string;
      tierSlug: string;
      priceMode: RepresentativePriceMode;
      retailPriceToman: number;
      basePriceToman: number;
      discountCodeId: string | null;
      discountAmountToman: number;
      finalPriceToman: number;
      /** True when a code WAS supplied but ignored (not stackable on rep price). */
      discountStackingRejected: boolean;
      tierFingerprint: string;
      priceFingerprint: string;
    };

/** Product fields the resolver reads (kept minimal so callers can pass a lean
 * projection or a full row). */
export type PricedProduct = Pick<
  Product,
  "id" | "type" | "priceToman" | "representativeEligible"
>;

export interface EffectiveProductPriceInput {
  user: Pick<User, "id">;
  product: PricedProduct;
  /** Rep pricing applies ONLY to a new PURCHASE (§8). RENEWAL/others are retail. */
  checkoutPurpose: DiscountPurpose;
  /** An already window/limit/group-validated code, or null. */
  discountCode?: DiscountCode | null;
  /** SETTLE reads the global rep-checkout switch UNCACHED so an OWNER
   * emergency-disable takes effect at the money-moving boundary immediately. */
  mode?: "PREVIEW" | "SETTLE";
}

interface ResolvedRepBase {
  representativeId: string;
  tierId: string;
  tierSlug: string;
  priceMode: RepresentativePriceMode;
  fixedPriceToman: number | null;
  percentValue: number | null;
  basePriceToman: number;
  tierFingerprint: string;
}

/**
 * Resolves the reseller base price for this user+product, or null when reseller
 * pricing does not apply (non-eligible product, non-purchase, switch off, not an
 * ACTIVE checkout-enabled representative, no active tier, no active price row, or
 * a stale/invalid price — a stale FIXED above retail falls back to retail so the
 * user is never charged MORE than retail). Pure read.
 */
async function resolveRepresentativeBase(
  input: EffectiveProductPriceInput,
): Promise<ResolvedRepBase | null> {
  // §8: only an eligible SERVICE_PRODUCT bought as a NEW purchase is rep-priced.
  if (input.product.type !== "SERVICE_PRODUCT") {
    return null;
  }
  if (input.checkoutPurpose !== "PURCHASE") {
    return null;
  }
  if (!input.product.representativeEligible) {
    return null;
  }

  // §3 global reseller-checkout switch — uncached at the settlement boundary.
  const enabled =
    input.mode === "SETTLE"
      ? await isRepresentativeCheckoutEnabledFresh()
      : await isRepresentativeCheckoutEnabled();
  if (!enabled) {
    return null;
  }

  const rep = await prisma.representative.findUnique({
    where: { userId: input.user.id },
    select: {
      id: true,
      status: true,
      checkoutEnabled: true,
      tierId: true,
      tier: { select: { id: true, slug: true, isActive: true } },
    },
  });
  if (rep === null || rep.status !== "ACTIVE" || !rep.checkoutEnabled) {
    return null;
  }
  if (rep.tier === null || !rep.tier.isActive) {
    return null;
  }

  const price = await prisma.representativeProductPrice.findUnique({
    where: { tierId_productId: { tierId: rep.tier.id, productId: input.product.id } },
    select: { priceMode: true, fixedPriceToman: true, percentValue: true, isActive: true },
  });
  if (price === null || !price.isActive || !isRepresentativePriceMode(price.priceMode)) {
    return null;
  }

  const resolved = resolveRepresentativeBasePrice({
    mode: price.priceMode,
    retailToman: input.product.priceToman,
    fixedPriceToman: price.fixedPriceToman,
    percentDiscount: price.percentValue,
  });
  if (!resolved.ok) {
    // Stale FIXED above retail / invalid definition → no reseller discount, buy
    // at retail. Never charge more than retail; the loud stale-preview rejection
    // is the fingerprint compare at the settlement boundary (§16).
    return null;
  }

  return {
    representativeId: rep.id,
    tierId: rep.tier.id,
    tierSlug: rep.tier.slug,
    priceMode: price.priceMode,
    fixedPriceToman: price.fixedPriceToman,
    percentValue: price.percentValue,
    basePriceToman: resolved.representativePriceToman,
    tierFingerprint: buildRepresentativeTierFingerprint({
      tierId: rep.tier.id,
      tierSlug: rep.tier.slug,
      tierActive: rep.tier.isActive,
      checkoutEnabled: rep.checkoutEnabled,
    }),
  };
}

/** The ONE authoritative price resolver (§7). See file header. */
export async function resolveEffectiveProductPrice(
  input: EffectiveProductPriceInput,
): Promise<EffectiveProductPrice> {
  const retailPriceToman = input.product.priceToman;
  const rep = await resolveRepresentativeBase(input);
  const basePriceToman = rep === null ? retailPriceToman : rep.basePriceToman;

  // Discount (§7 precedence): retail always allows the code; representative
  // pricing only stacks a code explicitly flagged allowRepresentativeStacking.
  let discountAmountToman = 0;
  let discountCodeId: string | null = null;
  let discountStackingRejected = false;
  if (input.discountCode != null) {
    const stackable = rep === null || input.discountCode.allowRepresentativeStacking;
    if (stackable) {
      discountAmountToman = calculateDiscountAmount(input.discountCode, basePriceToman);
      discountCodeId = input.discountCode.id;
    } else {
      discountStackingRejected = true;
    }
  }
  const finalPriceToman = Math.max(0, basePriceToman - discountAmountToman);

  if (rep === null) {
    return {
      pricingMode: "RETAIL",
      retailPriceToman,
      basePriceToman: retailPriceToman,
      discountCodeId,
      discountAmountToman,
      finalPriceToman,
    };
  }

  return {
    pricingMode: REPRESENTATIVE_PRICING_MODE,
    representativeId: rep.representativeId,
    tierId: rep.tierId,
    tierSlug: rep.tierSlug,
    priceMode: rep.priceMode,
    retailPriceToman,
    basePriceToman,
    discountCodeId,
    discountAmountToman,
    finalPriceToman,
    discountStackingRejected,
    tierFingerprint: rep.tierFingerprint,
    priceFingerprint: buildRepresentativePriceFingerprint({
      tierId: rep.tierId,
      productId: input.product.id,
      priceMode: rep.priceMode,
      fixedPriceToman: rep.fixedPriceToman,
      percentValue: rep.percentValue,
      retailToman: retailPriceToman,
      representativePriceToman: basePriceToman,
    }),
  };
}

/**
 * Financial-isolation predicate (§6, §17): was this checkout priced at reseller
 * rates? Reads the IMMUTABLE checkout snapshot's pricingMode, which is frozen at
 * checkout creation — well before any settlement — so the answer is race-free
 * regardless of when the referral engine runs. Never throws for a business
 * reason; a missing/malformed snapshot is treated as retail (false).
 */
export async function isRepresentativePricedCheckout(
  checkoutSessionId: string | null,
): Promise<boolean> {
  if (checkoutSessionId === null) {
    return false;
  }
  const checkout = await prisma.checkoutSession.findUnique({
    where: { id: checkoutSessionId },
    select: { productSnapshot: true },
  });
  const snapshot = checkout?.productSnapshot;
  if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    return (snapshot as Record<string, unknown>).pricingMode === REPRESENTATIVE_PRICING_MODE;
  }
  return false;
}
