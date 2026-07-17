import {
  CheckoutStatus,
  prisma,
  type CheckoutSession,
  type Prisma,
  type User,
} from "@zedbot/database";

import type { CheckoutDraft } from "../core/session.js";
import { buildFulfillmentSnapshot } from "./other-product-profile.service.js";
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
    originalPriceToman: draft.originalPriceToman,
    discountCode: draft.discountCode ?? null,
    discountAmountToman: draft.discountAmountToman,
    finalPriceToman: draft.finalPriceToman,
    // XUI: the EXACT inbound set being sold, resolved NOW (explicit product
    // selection or the materialized panel allowlist). The paid order's
    // entitlement is this set - later product/panel edits never change it.
    inboundIds: resolveSoldInboundIds(product),
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

  await prisma.checkoutSession.updateMany({
    where: { userId: user.id, productId: product.id, status: CheckoutStatus.PENDING },
    data: { status: CheckoutStatus.CANCELLED },
  });

  return prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "ORDER_PAYMENT",
      productId: product.id,
      orderType: product.type === "SERVICE_PRODUCT" ? "SERVICE_PURCHASE" : "OTHER_PRODUCT",
      productSnapshot: buildProductSnapshot(product, draft),
      // Specialized-workflows phase: OTHER_PRODUCT checkouts freeze the
      // fulfillment behavior NOW (kind/profile/parser/info schema) - the
      // paid order fulfills from this capture, never from the mutable
      // Product row. Throws for a misconfigured specialized product, so an
      // unresolvable product fails BEFORE any payment.
      ...(product.type === "OTHER_PRODUCT"
        ? {
            otherProductFulfillmentSnapshot: buildFulfillmentSnapshot(
              product,
            ) as unknown as Prisma.InputJsonObject,
          }
        : {}),
      originalPriceToman: draft.originalPriceToman,
      discountAmountToman: draft.discountAmountToman,
      finalPriceToman: draft.finalPriceToman,
      discountCodeId: draft.discountCodeId ?? null,
      status: CheckoutStatus.PENDING,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    },
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
