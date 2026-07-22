import {
  prisma,
  type CheckoutSession,
  type DiscountCode,
  type Product,
  type User,
} from "@zedbot/database";
import {
  buildRepresentativePriceFingerprint,
  buildRepresentativeTierFingerprint,
  isRepresentativePriceMode,
  REPRESENTATIVE_PRICING_MODE,
  resolveRepresentativeBasePrice,
  type RepresentativePriceMode,
} from "@zedbot/shared";

import { isProductVisible } from "./catalog.service.js";
import { calculateDiscountAmount, type DiscountPurpose } from "./discount.service.js";
import {
  isRepresentativeCheckoutEnabled,
  isRepresentativeCheckoutEnabledFresh,
  isRepresentativeProgramEnabled,
  isRepresentativeProgramEnabledFresh,
} from "./representative-settings.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

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

  // §3 switches — reseller pricing requires BOTH the program master switch AND
  // the reseller-checkout switch. Read uncached at the settlement boundary so an
  // OWNER emergency-disable of EITHER switch takes effect immediately (a stale
  // product button can otherwise still seed/settle a reseller draft while the
  // master switch is off).
  const [programOn, checkoutOn] =
    input.mode === "SETTLE"
      ? await Promise.all([
          isRepresentativeProgramEnabledFresh(),
          isRepresentativeCheckoutEnabledFresh(),
        ])
      : await Promise.all([
          isRepresentativeProgramEnabled(),
          isRepresentativeCheckoutEnabled(),
        ]);
  if (!programOn || !checkoutOn) {
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

/** One eligible product with its resolved reseller price, for the «خرید
 * نمایندگی» product list. */
export interface EligibleRepresentativeProduct {
  productId: string;
  name: string;
  retailPriceToman: number;
  finalPriceToman: number;
}

/**
 * Lists the SERVICE_PRODUCTs this user (as an active representative) may buy at a
 * reseller price right now. A product is included ONLY when it is both:
 *   1. actually purchasable for THIS user — the same authoritative catalog
 *      predicate the retail flow uses (`isProductVisible`): active product +
 *      active category + group visibility + panel present/visible/sellable
 *      (provisioning-ready) + valid XUI inbound selection; AND
 *   2. reseller-priced right now — the authoritative resolver returns
 *      REPRESENTATIVE pricing (eligible product, active rep/tier/price, switches
 *      on).
 * Purchasability is evaluated BEFORE pricing, so a product that could never
 * reach pre-invoice (hidden from the group, inactive category, hidden/unready
 * panel, invalid XUI inbound) is never shown in the buy OR tariff list and can
 * never seed a checkout that `renderPreInvoice` would immediately reject
 * (P2@282). Returns [] when the user is not an eligible representative or the
 * program/checkout switch is off. Read-only, deterministic order.
 */
export async function listEligibleRepresentativeProducts(
  user: Pick<User, "id" | "group">,
): Promise<EligibleRepresentativeProduct[]> {
  // Load candidates with the SAME relations the retail catalog uses (category +
  // panel) in ONE bounded query — the visibility predicate then needs no extra
  // per-product panel/category lookup (no N+1). Deterministic order matches the
  // normal catalog: category displayOrder, product displayOrder, price, created.
  const products = await prisma.product.findMany({
    where: { type: "SERVICE_PRODUCT", representativeEligible: true },
    include: { category: true, panel: true },
    orderBy: [
      { category: { displayOrder: "asc" } },
      { displayOrder: "asc" },
      { priceToman: "asc" },
      { createdAt: "asc" },
    ],
  });
  const eligible: EligibleRepresentativeProduct[] = [];
  for (const product of products) {
    if (!isProductVisible(product, user.group)) {
      continue;
    }
    const effective = await resolveEffectiveProductPrice({
      user,
      product,
      checkoutPurpose: "PURCHASE",
      mode: "PREVIEW",
    });
    if (effective.pricingMode === REPRESENTATIVE_PRICING_MODE) {
      eligible.push({
        productId: product.id,
        name: product.name,
        retailPriceToman: effective.retailPriceToman,
        finalPriceToman: effective.finalPriceToman,
      });
    }
  }
  return eligible;
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

/**
 * Settlement-boundary staleness AUDIT for the card-to-card and gateway paths
 * (§16). Unlike the wallet path — where money moves AT settlement, so a stale
 * fingerprint fails closed BEFORE any deduction — a card/gateway payer has
 * ALREADY moved their money (card-to-card transfer / gateway charge) against the
 * price frozen at «ادامه»/CONTINUE, and the settlement layer additionally
 * enforces an EXACT amount-match (payment == frozen final). Re-validating and
 * failing closed here would therefore strand funds the user already paid and
 * contradict §3 ("existing checkouts settle") and §16 ("once a Payment is
 * settled the paid Order is authoritative").
 *
 * So this makes the intended SETTLE-time resolver check RUN on every path — but
 * for card/gateway its outcome is OBSERVATIONAL: when the live tier/price
 * fingerprint (or the reseller switch, read uncached) has drifted from the
 * frozen snapshot, it records a privacy-safe WARN audit marker (ids + coarse
 * flags only, §24) so the OWNER sees the drift. It NEVER blocks settlement,
 * NEVER mutates the paid Order, and NEVER throws. Retail checkouts short-circuit.
 */
export async function auditRepresentativeSettlementPricing(
  checkout: Pick<CheckoutSession, "userId" | "productId" | "productSnapshot">,
): Promise<void> {
  try {
    if (checkout.productId === null) {
      return;
    }
    const snapshot = checkout.productSnapshot;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return; // retail / no snapshot — nothing to audit, no DB read.
    }
    const snap = snapshot as Record<string, unknown>;
    if (snap.pricingMode !== REPRESENTATIVE_PRICING_MODE) {
      return; // retail — nothing to audit.
    }
    const product = await prisma.product.findUnique({
      where: { id: checkout.productId },
      select: { id: true, type: true, priceToman: true, representativeEligible: true },
    });
    if (product === null) {
      return;
    }
    const effective = await resolveEffectiveProductPrice({
      user: { id: checkout.userId },
      product,
      checkoutPurpose: "PURCHASE",
      discountCode: null,
      mode: "SETTLE",
    });
    const frozenTierFp = typeof snap.tierFingerprint === "string" ? snap.tierFingerprint : null;
    const frozenPriceFp = typeof snap.priceFingerprint === "string" ? snap.priceFingerprint : null;

    // Privacy-safe (§24): relational id + coarse boolean flags only; never the
    // fingerprints, prices, tier name or any explanation body.
    if (effective.pricingMode !== REPRESENTATIVE_PRICING_MODE) {
      // Live pricing no longer resolves to reseller at all (switch off, rep
      // suspended/terminated, tier/price archived, product de-listed): fully stale.
      await writeSystemLog({
        level: "WARN",
        eventType: OPS_EVENTS.REPRESENTATIVE_STALE_SETTLEMENT,
        message: "representative checkout settled with stale reseller pricing (order honored)",
        metadata: {
          stillRepresentative: false,
          tierFingerprintChanged: true,
          priceFingerprintChanged: true,
        },
        topicKey: "PAYMENT",
        userId: checkout.userId,
      });
      return;
    }
    // `effective` is narrowed to the REPRESENTATIVE variant here.
    const tierFingerprintChanged = effective.tierFingerprint !== frozenTierFp;
    const priceFingerprintChanged = effective.priceFingerprint !== frozenPriceFp;
    if (!tierFingerprintChanged && !priceFingerprintChanged) {
      return; // live pricing still matches the frozen agreement — nothing to flag.
    }
    await writeSystemLog({
      level: "WARN",
      eventType: OPS_EVENTS.REPRESENTATIVE_STALE_SETTLEMENT,
      message: "representative checkout settled with stale reseller pricing (order honored)",
      metadata: {
        stillRepresentative: true,
        tierFingerprintChanged,
        priceFingerprintChanged,
      },
      topicKey: "PAYMENT",
      userId: checkout.userId,
    });
  } catch {
    // Observational audit only — a failure here must never affect settlement.
  }
}
