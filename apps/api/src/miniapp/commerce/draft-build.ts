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

import type { RenewalDraft, ExtraVolumeDraft, ExtraTimeDraft } from "@zedbot/bot/core/session";
import { getRenewableServiceByShortId, isRenewalPlanValid } from "@zedbot/bot/services/renewal-checkout.service";
import { getExtraVolumeServiceByShortId, isExtraVolumePackageValid } from "@zedbot/bot/services/extra-volume.service";
import { getExtraTimeServiceByShortId, isExtraTimePackageValid } from "@zedbot/bot/services/extra-time.service";
import { calculateDiscountAmount } from "@zedbot/bot/services/discount.service";

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

  // §4 personalized OTHER_PRODUCT resume: the bot's session carries the
  // materialized PENDING checkout id after the needs-customer-info round; the
  // browser's capsule cannot (it was sealed earlier), so the LIVE pending
  // checkout for this exact (user, product) is re-attached here — the wallet
  // retry then settles THAT checkout (with its submitted form) instead of
  // materializing a fresh one and abandoning the input.
  let otherProductCheckoutId: string | undefined;
  if (product.type === "OTHER_PRODUCT") {
    const pending = await prisma.checkoutSession.findFirst({
      where: {
        userId,
        productId: product.id,
        orderType: "OTHER_PRODUCT",
        status: "PENDING",
        settledByPaymentId: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    otherProductCheckoutId = pending?.id;
  }

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
    ...(otherProductCheckoutId !== undefined ? { otherProductCheckoutId } : {}),
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

// --- renewal / extra-volume / extra-time drafts --------------------------------

export type AddonKind = "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME";

export type AddonDraftRejection =
  | { rejected: "NOT_FOUND"; status: 404 }
  | { rejected: "SERVICE_NOT_ELIGIBLE"; status: 409 }
  | { rejected: "PRODUCT_UNAVAILABLE"; status: 409 }
  | { rejected: "DISCOUNT_INVALID"; status: 409 };

export interface BuiltAddonDraft {
  rejected?: undefined;
  user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
  service: NonNullable<Awaited<ReturnType<typeof prisma.service.findUnique>>>;
  product: ProductWithRelations;
  draft: RenewalDraft | ExtraVolumeDraft | ExtraTimeDraft;
}

/** Re-resolve an addon capsule against the SAME eligibility + plan-validity
 * authorities the bot's renewal / extra flows run, fresh, at every boundary. */
export async function buildAddonDraft(
  userId: string,
  kind: AddonKind,
  capsule: CheckoutDraftCapsule,
): Promise<BuiltAddonDraft | AddonDraftRejection> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null || capsule.serviceId === undefined) {
    return { rejected: "NOT_FOUND", status: 404 };
  }
  // The eligibility authorities resolve by owner-scoped uuid PREFIX (their
  // pattern caps at 32 chars, so the full 36-char uuid is trimmed); the
  // post-resolution identity check below pins the exact sealed row.
  const servicePrefix = capsule.serviceId.slice(0, 32);
  const service =
    kind === "RENEWAL"
      ? await getRenewableServiceByShortId(servicePrefix, userId)
      : kind === "EXTRA_VOLUME"
        ? await getExtraVolumeServiceByShortId(servicePrefix, userId)
        : await getExtraTimeServiceByShortId(servicePrefix, userId);
  if (service === null || service.id !== capsule.serviceId) {
    return { rejected: "SERVICE_NOT_ELIGIBLE", status: 409 };
  }
  const product = await prisma.product.findUnique({
    where: { id: capsule.productId },
    include: { category: true, panel: true },
  });
  if (product === null) {
    return { rejected: "PRODUCT_UNAVAILABLE", status: 409 };
  }
  const planValid =
    kind === "RENEWAL"
      ? isRenewalPlanValid(product, service, user.group)
      : kind === "EXTRA_VOLUME"
        ? isExtraVolumePackageValid(product, service, user.group)
        : isExtraTimePackageValid(product, service, user.group);
  if (!planValid) {
    return { rejected: "PRODUCT_UNAVAILABLE", status: 409 };
  }

  // Renewal codes validate against appliesTo RENEWAL; extras follow the bot
  // exactly and use the default PURCHASE purpose.
  let discountCodeId: string | undefined;
  let discountAmountToman = 0;
  if (capsule.discountCode !== undefined) {
    const validation = await validateDiscountCode(
      capsule.discountCode,
      user,
      product.priceToman,
      kind === "RENEWAL" ? "RENEWAL" : "PURCHASE",
    );
    if (!validation.ok) {
      return { rejected: "DISCOUNT_INVALID", status: 409 };
    }
    discountCodeId = validation.discountCode.id;
    discountAmountToman = calculateDiscountAmount(validation.discountCode, product.priceToman);
  }
  if (product.panelId === null) {
    return { rejected: "PRODUCT_UNAVAILABLE", status: 409 };
  }
  const draft: RenewalDraft = {
    serviceId: service.id,
    productId: product.id,
    panelId: product.panelId,
    categoryId: product.categoryId,
    ...(capsule.discountCode !== undefined && discountCodeId !== undefined
      ? { discountCode: capsule.discountCode, discountCodeId }
      : {}),
    originalPriceToman: product.priceToman,
    discountAmountToman,
    finalPriceToman: Math.max(0, product.priceToman - discountAmountToman),
    draftNonce: capsule.draftNonce,
  };
  return { user, service, product, draft };
}
