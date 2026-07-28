// =============================================================================
// Rebuild a validated CheckoutDraft from a sealed capsule (miniapp §4/§7/§11).
//
// Shared by BOTH money paths — checkout confirmation (card/gateway) and the
// direct wallet payment — so the two can never drift in what they re-validate:
// product visibility, discount validity and pricing are ALWAYS resolved fresh
// from live rows at the money boundary. The capsule contributed identity only.
// =============================================================================
import { prisma, ServiceUsernameMode } from "@zedbot/database";
import type { CheckoutDraft } from "@zedbot/bot/core/session";
import { isProductVisible } from "@zedbot/bot/services/catalog.service";
import { validateDiscountCode } from "@zedbot/bot/services/discount.service";
import type { ProductWithRelations } from "@zedbot/bot/services/product.service";
import { resolveEffectiveProductPrice } from "@zedbot/bot/services/representative-pricing.service";

import type { CheckoutDraftCapsule } from "./draft-token.js";

export type DraftBuildRejection =
  | { rejected: "NOT_FOUND"; status: 404 }
  | { rejected: "PRODUCT_UNAVAILABLE"; status: 409 }
  | { rejected: "DISCOUNT_INVALID"; status: 409 };

export interface BuiltDraft {
  rejected?: undefined;
  user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
  product: ProductWithRelations;
  draft: CheckoutDraft;
}

/**
 * `mode` follows the pricing resolver's contract: "PREVIEW" for quotes,
 * "SETTLE" wherever the result is about to move money or freeze a snapshot.
 */
export async function buildValidatedDraft(
  userId: string,
  capsule: CheckoutDraftCapsule,
  mode: "PREVIEW" | "SETTLE",
): Promise<BuiltDraft | DraftBuildRejection> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null) {
    return { rejected: "NOT_FOUND", status: 404 };
  }
  const product = await prisma.product.findUnique({
    where: { id: capsule.productId },
    include: { category: true, panel: true },
  });
  if (product === null || !isProductVisible(product, user.group)) {
    return { rejected: "PRODUCT_UNAVAILABLE", status: 409 };
  }

  let discountRow = null;
  if (capsule.discountCode !== undefined) {
    const validation = await validateDiscountCode(
      capsule.discountCode,
      user,
      product.priceToman,
      "PURCHASE",
    );
    if (!validation.ok) {
      return { rejected: "DISCOUNT_INVALID", status: 409 };
    }
    discountRow = validation.discountCode;
  }
  const pricing = await resolveEffectiveProductPrice({
    user,
    product,
    checkoutPurpose: "PURCHASE",
    discountCode: discountRow,
    mode,
  });

  const draft: CheckoutDraft = {
    productId: product.id,
    categoryId: product.categoryId,
    ...(product.panelId !== null ? { panelId: product.panelId } : {}),
    flowType: product.type,
    ...(pricing.discountCodeId !== null && capsule.discountCode !== undefined
      ? { discountCode: capsule.discountCode, discountCodeId: pricing.discountCodeId }
      : {}),
    originalPriceToman: pricing.basePriceToman,
    discountAmountToman: pricing.discountAmountToman,
    finalPriceToman: pricing.finalPriceToman,
    draftNonce: capsule.draftNonce,
    ...(pricing.pricingMode === "REPRESENTATIVE"
      ? {
          representative: {
            representativeId: pricing.representativeId,
            tierId: pricing.tierId,
            tierSlug: pricing.tierSlug,
            priceMode: pricing.priceMode,
            retailPriceToman: pricing.retailPriceToman,
            basePriceToman: pricing.basePriceToman,
            tierFingerprint: pricing.tierFingerprint,
            priceFingerprint: pricing.priceFingerprint,
          },
        }
      : {}),
    ...(capsule.reservationId !== undefined &&
    capsule.normalizedUsername !== undefined &&
    capsule.usernameMode !== undefined
      ? {
          serviceCustomization: {
            usernameMode: capsule.usernameMode as ServiceUsernameMode,
            normalizedUsername: capsule.normalizedUsername,
            reservationId: capsule.reservationId,
            note: capsule.note ?? null,
            usernameConfirmedAt: capsule.usernameConfirmedAt ?? new Date().toISOString(),
            completed: true,
          },
        }
      : {}),
  };
  return { user, product, draft };
}
