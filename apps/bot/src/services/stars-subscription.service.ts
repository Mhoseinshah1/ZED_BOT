import {
  AutoRenewalFundingMethod,
  AutoRenewalMandateStatus,
  PanelStatus,
  PaymentGatewayType,
  Prisma,
  prisma,
  type Service,
  type TelegramStarsServiceSubscription,
  type User,
} from "@zedbot/database";
import {
  buildStarsSubscriptionPayload,
  clampStarsSubInt,
  DEFAULT_STARS_SUBSCRIPTION_CONFIG,
  generateStarsSubscriptionPayloadId,
  isValidStarsSubscriptionAmount,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
  STARS_SUB_MAX_PENDING_MINUTES,
  STARS_SUB_MIN_PENDING_MINUTES,
  TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_CONSENT_VERSION_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_PENDING_ENROLLMENT_MINUTES_KEY,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { isPanelSellable } from "./panel-readiness.service.js";
import type { ProductWithRelations } from "./product.service.js";
import { isRenewalPlanValid } from "./renewal-checkout.service.js";
import { getBooleanSetting, getSetting } from "./settings.service.js";

// =============================================================================
// Telegram Stars service subscriptions — enrollment + lifecycle (Phase 2).
//
// The mandate's `serviceId @unique` (Phase 1) is the single exclusivity authority:
// one Service → one automation funding method. Enrolling in a Stars subscription
// flips (or creates) that mandate to `fundingMethod = TELEGRAM_STARS` and attaches
// a TelegramStarsServiceSubscription (PENDING_PAYMENT until the first recurring
// charge fulfils). The FIXED Stars amount + FROZEN entitlement snapshot live on
// the subscription; later cycles apply that contract, never a mutated Product.
//
// Nothing here charges money (Telegram does), touches the wallet, or activates a
// subscription — activation happens only after a fulfilled initial charge.
// =============================================================================

const CONSENT_VERSION_FALLBACK = DEFAULT_STARS_SUBSCRIPTION_CONFIG.consentVersion;
/** chargeLeadMinutes stored on the (unused-for-Stars) mandate field. */
const MANDATE_LEAD_MINUTES = 180;

// --- settings (bot side) -----------------------------------------------------

/** MASTER switch — the whole system is dormant until an operator enables it. */
export async function isStarsSubscriptionsEnabled(): Promise<boolean> {
  return getBooleanSetting(TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY, false);
}

/**
 * The one-time Telegram Stars gateway must be enabled: env `TELEGRAM_STARS_ENABLED`
 * AND an active PaymentGateway row of type TELEGRAM_STARS. A Stars subscription can
 * never operate behind a disabled one-time Stars gateway.
 */
export async function isTelegramStarsGatewayEnabled(): Promise<boolean> {
  if ((process.env.TELEGRAM_STARS_ENABLED ?? "").trim() !== "true") {
    return false;
  }
  const active = await prisma.paymentGateway.count({
    where: { type: PaymentGatewayType.TELEGRAM_STARS, isEnabled: true },
  });
  return active > 0;
}

/** BOTH switches are required: the one-time Stars gateway AND the subscription one. */
export async function isStarsSubscriptionsOperational(): Promise<boolean> {
  const [subsOn, gatewayOn] = await Promise.all([
    isStarsSubscriptionsEnabled(),
    isTelegramStarsGatewayEnabled(),
  ]);
  return subsOn && gatewayOn;
}

export async function getStarsSubscriptionConsentVersion(): Promise<number> {
  const raw = await getSetting(TELEGRAM_STARS_SUBSCRIPTION_CONSENT_VERSION_KEY, "");
  return clampStarsSubInt(Number.parseInt(raw, 10), 1, 1_000_000, CONSENT_VERSION_FALLBACK);
}

export async function getPendingEnrollmentMinutes(): Promise<number> {
  const raw = await getSetting(TELEGRAM_STARS_SUBSCRIPTION_PENDING_ENROLLMENT_MINUTES_KEY, "");
  return clampStarsSubInt(
    Number.parseInt(raw, 10),
    STARS_SUB_MIN_PENDING_MINUTES,
    STARS_SUB_MAX_PENDING_MINUTES,
    DEFAULT_STARS_SUBSCRIPTION_CONFIG.pendingEnrollmentMinutes,
  );
}

// --- eligibility (Part C) ----------------------------------------------------

/** The frozen entitlement contract stored on the subscription. */
export interface FrozenEntitlement {
  productId: string;
  productVersion: number;
  starsAmount: number;
  durationDays: number;
  volumeGb: number;
  panelId: string;
  categoryId: string;
  productName: string;
  panelName: string | null;
  categoryName: string | null;
}

/**
 * A Product is subscription-compatible only when it is an active 30-day
 * SERVICE_PRODUCT with an explicit Stars price in range, on an active
 * provisioning-ready Panel that is a valid renewal plan for the Service and is
 * visible to the user's group. The Stars price is the EXPLICIT recurring contract
 * — never derived from the Toman/Star rate.
 */
export function isSubscriptionProductEligible(
  product: ProductWithRelations,
  service: Service,
  group: User["group"],
): boolean {
  return (
    product.type === "SERVICE_PRODUCT" &&
    product.isActive &&
    product.telegramStarsSubscriptionEnabled &&
    product.durationDays === 30 &&
    isValidStarsSubscriptionAmount(product.telegramStarsSubscriptionPrice) &&
    product.panel !== null &&
    product.panel.status === PanelStatus.ACTIVE &&
    isPanelSellable(product.panel) &&
    product.panelId === service.panelId &&
    isRenewalPlanValid(product, service, group)
  );
}

/** Subscription-enabled same-panel plans for a Service (enrollment list). */
export async function subscriptionPlansForService(
  service: Service,
  group: User["group"],
): Promise<ProductWithRelations[]> {
  const products = await prisma.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      telegramStarsSubscriptionEnabled: true,
      durationDays: 30,
      panelId: service.panelId,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [{ telegramStarsSubscriptionPrice: "asc" }, { createdAt: "asc" }],
  });
  return products.filter((p) => isSubscriptionProductEligible(p, service, group));
}

function freezeEntitlement(product: ProductWithRelations): FrozenEntitlement {
  return {
    productId: product.id,
    productVersion: product.telegramStarsSubscriptionVersion,
    starsAmount: product.telegramStarsSubscriptionPrice ?? 0,
    durationDays: product.durationDays ?? 30,
    volumeGb: product.volumeGb ?? 0,
    panelId: product.panelId ?? "",
    categoryId: product.categoryId,
    productName: product.name,
    panelName: product.panel?.name ?? null,
    categoryName: product.category.name,
  };
}

// --- enrollment (Parts B/H/I/J) ----------------------------------------------

export type BeginEnrollmentResult =
  | {
      status: "ready";
      subscription: TelegramStarsServiceSubscription;
      payload: string;
      reused: boolean;
    }
  | { status: "wallet-conflict" }
  | { status: "already-subscribed"; subscription: TelegramStarsServiceSubscription }
  | { status: "ineligible" }
  | { status: "system-disabled" };

export interface BeginEnrollmentInput {
  service: Service;
  product: ProductWithRelations;
  /** True once the user explicitly confirmed superseding an active wallet mandate. */
  supersedeWallet: boolean;
}

/**
 * Begins (or reuses) a PENDING_PAYMENT Stars enrollment. Exclusivity is enforced
 * on the mandate's `serviceId @unique`: a fresh service creates the mandate; a
 * previously-cancelled or wallet mandate is FLIPPED to TELEGRAM_STARS (a wallet
 * flip requires `supersedeWallet` explicit consent). An already-active Stars
 * subscription short-circuits. Repeated invoice clicks reuse the same live pending
 * enrollment — never a second mandate/subscription/Payment.
 */
export async function beginStarsEnrollment(
  user: User,
  input: BeginEnrollmentInput,
): Promise<BeginEnrollmentResult> {
  if (!(await isStarsSubscriptionsOperational())) {
    return { status: "system-disabled" };
  }
  const { service, product } = input;
  if (
    service.userId !== user.id ||
    service.deletedAt !== null ||
    service.status === "DELETED" ||
    service.expiresAt === null ||
    !isSubscriptionProductEligible(product, service, user.group)
  ) {
    return { status: "ineligible" };
  }

  const existingMandate = await prisma.serviceAutoRenewalMandate.findUnique({
    where: { serviceId: service.id },
    include: { starsSubscription: true },
  });

  if (existingMandate !== null) {
    const sub = existingMandate.starsSubscription;
    // A live Stars subscription already owns this service.
    if (
      existingMandate.fundingMethod === AutoRenewalFundingMethod.TELEGRAM_STARS &&
      sub !== null &&
      sub.status !== "CANCELLED" &&
      sub.status !== "EXPIRED"
    ) {
      if (sub.status === "PENDING_PAYMENT" && !isPendingExpired(sub, await getPendingEnrollmentMinutes())) {
        // Reuse the live pending enrollment (repeated invoice click).
        return { status: "ready", subscription: sub, payload: buildStarsSubscriptionPayload(sub.publicPayloadId), reused: true };
      }
      if (sub.status !== "PENDING_PAYMENT") {
        return { status: "already-subscribed", subscription: sub };
      }
    }
    // An ACTIVE wallet mandate requires explicit supersede consent.
    if (
      existingMandate.fundingMethod === AutoRenewalFundingMethod.WALLET &&
      existingMandate.status === AutoRenewalMandateStatus.ACTIVE &&
      !input.supersedeWallet
    ) {
      return { status: "wallet-conflict" };
    }
  }

  const [consentVersion, entitlement] = [await getStarsSubscriptionConsentVersion(), freezeEntitlement(product)];
  const now = new Date();
  const payloadId = generateStarsSubscriptionPayloadId();

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Flip/create the mandate (serviceId @unique is the exclusivity claim).
      const mandate = await tx.serviceAutoRenewalMandate.upsert({
        where: { serviceId: service.id },
        create: {
          userId: user.id,
          serviceId: service.id,
          productId: product.id,
          fundingMethod: AutoRenewalFundingMethod.TELEGRAM_STARS,
          status: AutoRenewalMandateStatus.ACTIVE,
          maximumChargeToman: 0,
          consentedPriceToman: 0,
          chargeLeadMinutes: MANDATE_LEAD_MINUTES,
          consentVersion,
          consentedAt: now,
          nextEvaluationAt: null,
        },
        update: {
          productId: product.id,
          fundingMethod: AutoRenewalFundingMethod.TELEGRAM_STARS,
          status: AutoRenewalMandateStatus.ACTIVE,
          pauseReason: null,
          maximumChargeToman: 0,
          consentedPriceToman: 0,
          consentVersion,
          consentedAt: now,
          cancelledAt: null,
          pausedAt: null,
          nextEvaluationAt: null,
          safeLastErrorCode: null,
        },
      });

      // Replace any stale prior subscription row for this mandate.
      const existingSub = await tx.telegramStarsServiceSubscription.findUnique({
        where: { mandateId: mandate.id },
      });
      if (existingSub !== null) {
        await tx.telegramStarsSubscriptionCharge.deleteMany({
          where: { subscriptionId: existingSub.id, status: { in: ["RECEIVED", "IGNORED", "FAILED"] } },
        });
        await tx.telegramStarsServiceSubscription.delete({ where: { id: existingSub.id } });
      }

      // The subscription row (PENDING_PAYMENT) IS the enrollment record. The one
      // Payment per charge is created lazily at settlement (keyed on the Telegram
      // charge id), so there is never a dangling placeholder Payment for an
      // abandoned enrollment.
      const subscription = await tx.telegramStarsServiceSubscription.create({
        data: {
          mandateId: mandate.id,
          userId: user.id,
          serviceId: service.id,
          productId: product.id,
          status: "PENDING_PAYMENT",
          publicPayloadId: payloadId,
          starsAmount: entitlement.starsAmount,
          subscriptionPeriodSeconds: STARS_SUBSCRIPTION_PERIOD_SECONDS,
          productVersion: entitlement.productVersion,
          entitlementSnapshot: entitlement as unknown as Prisma.InputJsonObject,
          consentVersion,
          consentedAt: now,
          termsAcceptedAt: now,
        },
      });
      return subscription;
    });
    logger.info("stars subscription enrollment created", {
      subscriptionId: created.id,
      userId: user.id,
      serviceId: service.id.slice(0, 8),
      starsAmount: created.starsAmount,
    });
    return { status: "ready", subscription: created, payload: buildStarsSubscriptionPayload(payloadId), reused: false };
  } catch (err) {
    logger.error("stars subscription enrollment failed", { error: String(err) });
    throw err;
  }
}

function isPendingExpired(sub: TelegramStarsServiceSubscription, pendingMinutes: number): boolean {
  return sub.createdAt.getTime() + pendingMinutes * 60_000 < Date.now();
}

// --- lookups (owner-scoped) --------------------------------------------------

export async function getSubscriptionByPayloadId(
  publicPayloadId: string,
): Promise<TelegramStarsServiceSubscription | null> {
  return prisma.telegramStarsServiceSubscription.findUnique({ where: { publicPayloadId } });
}

export async function getSubscriptionForService(
  userId: string,
  serviceId: string,
): Promise<TelegramStarsServiceSubscription | null> {
  const sub = await prisma.telegramStarsServiceSubscription.findUnique({ where: { serviceId } });
  return sub !== null && sub.userId === userId ? sub : null;
}

export async function getOwnedSubscriptionByShortId(
  shortId: string,
  userId: string,
): Promise<TelegramStarsServiceSubscription | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.telegramStarsServiceSubscription.findMany({
    where: { id: { startsWith: shortId }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function listUserSubscriptions(
  userId: string,
): Promise<TelegramStarsServiceSubscription[]> {
  return prisma.telegramStarsServiceSubscription.findMany({
    where: { userId, status: { notIn: ["EXPIRED", "CANCELLED"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export function subscriptionShortId(sub: { id: string }): string {
  return sub.id.slice(0, 8);
}
