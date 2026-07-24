import {
  CheckoutStatus,
  prisma,
  type CheckoutSession,
  type Prisma,
  type User,
} from "@zedbot/database";
import { REPRESENTATIVE_PRICING_MODE } from "@zedbot/shared";

import type { CheckoutDraft } from "../core/session.js";
import { buildFulfillmentSnapshot } from "./other-product-profile.service.js";
import { recordRepresentativePurchase } from "./representative.service.js";
import { bindReservationToCheckout } from "./service-username-selection.service.js";
import { getSetting } from "./settings.service.js";
import { resolveProductInboundIds } from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";

// =============================================================================
// CheckoutSession creation - the ONLY database write of the Phase 6 flow.
// No Order, no Payment, no Service, no wallet changes, no panel calls.
// =============================================================================

const DEFAULT_EXPIRY_MINUTES = 30;

/** Operator-configurable checkout lifetime (shared with the renewal flow). */
export async function checkoutExpiryMinutes(): Promise<number> {
  const raw = await getSetting("checkout_expiry_minutes", "");
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_EXPIRY_MINUTES;
}

/** Immutable copy of everything that was offered, priced and discounted. */
export function buildProductSnapshot(
  product: ProductWithRelations,
  draft: CheckoutDraft,
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
    // Naming phase: the admin-selected naming strategy + its config,
    // captured NOW - the paid order's identity resolves from this capture,
    // so later panel-config edits never rename a paid entitlement.
    ...(product.type === "SERVICE_PRODUCT" && product.panel !== null
      ? {
          namingStrategy: product.panel.usernamePatternType,
          namingCustomText: product.panel.usernameCustomText,
          namingRandomLength: product.panel.usernameRandomLength,
          namingRepresentativePrefix: product.panel.representativeUsernamePrefix,
        }
      : {}),
    // Service-checkout username selection (feat/service-checkout-username-note):
    // the buyer-chosen remote username + its source + the durable reservation id
    // + the optional note, all captured NOW (session still alive) so every
    // payment method provisions from the same immutable snapshot. Only present on
    // a completed SERVICE customization; OTHER_PRODUCT snapshots never carry it.
    ...(product.type === "SERVICE_PRODUCT" && draft.serviceCustomization?.completed === true
      ? {
          serviceUsername: draft.serviceCustomization.normalizedUsername,
          serviceUsernameMode: draft.serviceCustomization.usernameMode,
          serviceUsernameSelectionSource:
            draft.serviceCustomization.usernameMode === "RANDOM" ? "USER_RANDOM" : "USER_CUSTOM",
          serviceUsernameReservationId: draft.serviceCustomization.reservationId,
          serviceUserNote: draft.serviceCustomization.note,
        }
      : {}),
    originalPriceToman: draft.originalPriceToman,
    discountCode: draft.discountCode ?? null,
    discountAmountToman: draft.discountAmountToman,
    finalPriceToman: draft.finalPriceToman,
    // XUI: the EXACT inbound set being sold, resolved NOW (explicit product
    // selection or the materialized panel allowlist). The paid order's
    // entitlement is this set - later product/panel edits never change it.
    inboundIds: resolveSoldInboundIds(product),
    // Representative Program (§16): the IMMUTABLE reseller-pricing marker.
    // pricingMode === "REPRESENTATIVE" is the authoritative financial-isolation
    // signal read by the referral engine (§17). Absent on every retail checkout,
    // so a normal snapshot is byte-identical to before.
    ...(draft.representative !== undefined
      ? {
          pricingMode: REPRESENTATIVE_PRICING_MODE,
          representativeId: draft.representative.representativeId,
          representativeTierId: draft.representative.tierId,
          representativeTierSlug: draft.representative.tierSlug,
          representativePriceMode: draft.representative.priceMode,
          representativeRetailPriceToman: draft.representative.retailPriceToman,
          representativeBasePriceToman: draft.representative.basePriceToman,
          representativeTierFingerprint: draft.representative.tierFingerprint,
          representativePriceFingerprint: draft.representative.priceFingerprint,
        }
      : {}),
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

/**
 * Creates a fresh PENDING CheckoutSession for the draft. Older PENDING
 * sessions of the same user+product are cancelled first, so repeated
 * "continue" clicks can never pile up parallel pending checkouts.
 */
export async function createCheckoutSession(
  user: User,
  product: ProductWithRelations,
  draft: CheckoutDraft,
): Promise<CheckoutSession> {
  const minutes = await checkoutExpiryMinutes();
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const snapshot = buildProductSnapshot(product, draft);
  const fulfillmentSnapshot =
    product.type === "OTHER_PRODUCT"
      ? (buildFulfillmentSnapshot(product) as unknown as Prisma.InputJsonObject)
      : null;

  // The representative purchase marker (§16, §25) is created in the SAME
  // transaction as the checkout so a reseller-priced checkout can never exist
  // without its non-financial marker. The retail path takes no transaction and
  // is byte-identical to before.
  return prisma.$transaction(async (tx) => {
    // Capture the superseded PENDING checkout ids BEFORE cancelling them, so any
    // reseller-purchase markers hanging off those checkouts can be cancelled in
    // the same breath. Otherwise a repeated "continue" leaves an orphaned PENDING
    // RepresentativePurchase that never resolves (§25 idempotency invariant: a
    // marker's lifecycle tracks its checkout's).
    const superseded = await tx.checkoutSession.findMany({
      where: { userId: user.id, productId: product.id, status: CheckoutStatus.PENDING },
      select: { id: true },
    });
    await tx.checkoutSession.updateMany({
      where: { userId: user.id, productId: product.id, status: CheckoutStatus.PENDING },
      data: { status: CheckoutStatus.CANCELLED },
    });
    if (superseded.length > 0) {
      await tx.representativePurchase.updateMany({
        where: {
          checkoutSessionId: { in: superseded.map((c) => c.id) },
          status: "PENDING",
        },
        data: { status: "CANCELLED" },
      });
    }

    const checkout = await tx.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        productId: product.id,
        orderType: product.type === "SERVICE_PRODUCT" ? "SERVICE_PURCHASE" : "OTHER_PRODUCT",
        productSnapshot: snapshot,
        // Specialized-workflows phase: OTHER_PRODUCT checkouts freeze the
        // fulfillment behavior NOW (kind/profile/parser/info schema) - the
        // paid order fulfills from this capture, never from the mutable
        // Product row. Throws for a misconfigured specialized product, so an
        // unresolvable product fails BEFORE any payment.
        ...(fulfillmentSnapshot !== null
          ? { otherProductFulfillmentSnapshot: fulfillmentSnapshot }
          : {}),
        originalPriceToman: draft.originalPriceToman,
        discountAmountToman: draft.discountAmountToman,
        finalPriceToman: draft.finalPriceToman,
        discountCodeId: draft.discountCodeId ?? null,
        status: CheckoutStatus.PENDING,
        expiresAt,
      },
    });

    if (draft.representative !== undefined) {
      await recordRepresentativePurchase(tx, {
        checkoutSessionId: checkout.id,
        userId: user.id,
        productId: product.id,
        status: "PENDING",
        snapshot: {
          representativeId: draft.representative.representativeId,
          tierId: draft.representative.tierId,
          priceMode: draft.representative.priceMode,
          retailPriceToman: draft.representative.retailPriceToman,
          basePriceToman: draft.representative.basePriceToman,
          discountAmountToman: draft.discountAmountToman,
          finalPriceToman: draft.finalPriceToman,
          tierFingerprint: draft.representative.tierFingerprint,
          priceFingerprint: draft.representative.priceFingerprint,
        },
      });
    }

    // Service-checkout username selection: promote the buyer's HELD username
    // reservation to BOUND, linked to this durable checkout. From here the hold
    // is protected from the short HELD TTL for the whole payment window.
    const reservationId = draft.serviceCustomization?.reservationId;
    if (reservationId !== undefined) {
      await bindReservationToCheckout(tx, reservationId, checkout.id, user.id);
    }

    return checkout;
  });
}

/** Loads a checkout by full id, enforcing ownership. */
export async function getOwnedCheckout(
  id: string,
  userId: string,
): Promise<CheckoutSession | null> {
  return prisma.checkoutSession.findFirst({ where: { id, userId } });
}

/** Resolve a checkout by 8-char short id; ownership is enforced by userId. */
export async function getCheckoutByShortId(
  shortId: string,
  userId: string,
): Promise<CheckoutSession | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.checkoutSession.findMany({
    where: { id: { startsWith: shortId }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function checkoutShortId(checkout: Pick<CheckoutSession, "id">): string {
  return checkout.id.slice(0, 8);
}
