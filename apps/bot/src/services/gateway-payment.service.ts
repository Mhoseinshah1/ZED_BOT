import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PaymentGatewayType,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  prisma,
  StarsPricingMode,
  WalletTransactionSource,
  WalletTransactionType,
  type CheckoutSession,
  type Order,
  type Payment,
  type PaymentGateway as PaymentGatewayRow,
  type User,
} from "@zedbot/database";
import {
  buildDefaultManager,
  STARS_PAYLOAD_PREFIX,
  SUPPORTED_ONLINE_PROVIDERS,
  type CreatePaymentResult,
  type PaymentGatewayManager,
  type SupportedProvider,
} from "@zedbot/payments";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { claimDiscountUsage } from "./discount.service.js";
import {
  buildExtraTimeSuccessMessage,
  executeExtraTimeOrder,
  EXTRA_TIME_FAILED_USER_TEXT,
} from "./extra-time.service.js";
import {
  buildExtraVolumeSuccessMessage,
  executeExtraVolumeOrder,
  EXTRA_VOLUME_FAILED_USER_TEXT,
} from "./extra-volume.service.js";
import {
  initManualDelivery,
  notifyAdminsAboutManualOrder,
  userInfoButtonKeyboard,
  userInfoPromptText,
  WAITING_DELIVERY_USER_TEXT,
  type DeliverySendApi,
} from "./other-product-delivery.service.js";
import {
  autoDeliverStockOrder,
  notifyAdminsAboutStockAlert,
} from "./other-product-stock.service.js";
import {
  buildServiceInfoMessage,
  PROVISION_FAILED_USER_TEXT,
  provisionPaidOrder,
} from "./provisioning.service.js";
import { approvalUserNotice, resolveOrderType } from "./receipt-review.service.js";
import {
  buildRenewalSuccessMessage,
  executeRenewalOrder,
  RENEWAL_FAILED_USER_TEXT,
} from "./service-renewal.service.js";
import { getMessageTemplate } from "./text.service.js";
import { WALLET_TOPUP_REASON } from "./wallet-topup.service.js";

// =============================================================================
// Online gateway payments (payment-gateway-system phase): payment creation
// against the @zedbot/payments adapters, the exactly-once settlement
// transaction (the ONLY place gateway money moves - mirrors
// receipt-review.service) and post-settlement fulfillment (same executor
// dispatch as the admin receipt approval).
//
// Division of labour:
//  - apps/api records verified provider events (providerStatus, verifiedAt,
//    references) but NEVER settles - its SUCCESS recording leaves
//    Payment.status at PENDING/PROCESSING.
//  - settleGatewayPayment() below is the money gate: one transaction whose
//    first statement is the compare-and-set updateMany
//    (status PENDING/PROCESSING -> APPROVED); only the winner of that CAS
//    credits wallets / creates the order. Every caller (check-status button,
//    Stars update handler, sweep loop) funnels through it, so replays,
//    double clicks and concurrent IPNs settle exactly once.
//
// No secrets in logs: authorities, api keys, signatures and charge ids never
// appear at info level or in user-facing texts.
// =============================================================================

const MANAGER_CACHE_TTL_MS = 30_000;
const SWEEP_BATCH_SIZE = 20;
const SWEEP_INTERVAL_MS = 60_000;
/** Pass 2 only re-fulfills orders that stayed PAID at least this long. */
const UNFULFILLED_ORDER_MIN_AGE_MS = 2 * 60_000;
/** PENDING gateway payments are expired this long AFTER their expiresAt. */
const STALE_PENDING_GRACE_MS = 30 * 60_000;

/** Online provider values as PaymentGatewayType enum members (for queries). */
const ONLINE_PROVIDER_TYPES: PaymentGatewayType[] = [
  PaymentGatewayType.ZARINPAL,
  PaymentGatewayType.NOWPAYMENTS,
  PaymentGatewayType.TELEGRAM_STARS,
];

const GENERIC_ERROR = "خطایی رخ داد. لطفاً دوباره تلاش کنید.";

// --- manager -----------------------------------------------------------------------

let managerCache: { manager: PaymentGatewayManager; at: number } | null = null;

/** Test hook / admin-edit hook: drops the cached gateway manager. */
export function clearGatewayManagerCache(): void {
  managerCache = null;
}

/**
 * The process-wide gateway manager. Env-configured adapters plus the Stars
 * rate from the StarsPricingSetting singleton (MANUAL_RATE only - without a
 * positive manual rate Stars reports unavailable). Cached for ~30s like the
 * text.service caches, so availability follows admin edits quickly without
 * a DB read per update.
 */
export async function buildGatewayManager(): Promise<PaymentGatewayManager> {
  if (managerCache !== null && Date.now() - managerCache.at < MANAGER_CACHE_TTL_MS) {
    return managerCache.manager;
  }
  let starsTomanPerStar: number | null = null;
  try {
    const setting = await prisma.starsPricingSetting.findUnique({
      where: { singletonKey: "default" },
    });
    if (
      setting !== null &&
      setting.pricingMode === StarsPricingMode.MANUAL_RATE &&
      (setting.manualTomanPerStar ?? 0) > 0
    ) {
      starsTomanPerStar = setting.manualTomanPerStar;
    }
  } catch (err) {
    // DB outage: Stars just reports unavailable; HTTP gateways still work.
    logger.warn("stars pricing lookup failed, stars unavailable", {
      error: errorMessage(err),
    });
  }
  const manager = buildDefaultManager({ starsTomanPerStar });
  managerCache = { manager, at: Date.now() };
  return manager;
}

/** Narrow a PaymentGatewayType to the online providers this phase implements. */
export function isOnlineProvider(type: string): type is SupportedProvider {
  return (SUPPORTED_ONLINE_PROVIDERS as readonly string[]).includes(type);
}

// --- payment creation ---------------------------------------------------------------

export type GatewayPaymentResult =
  | { ok: true; payment: Payment; create: CreatePaymentResult }
  | { ok: false; error: string };

/** Provider-side order description - payment short id only, never user data. */
function paymentDescription(purpose: CheckoutSession["purpose"], paymentId: string): string {
  const kind = purpose === "WALLET_CHARGE" ? "wallet top-up" : "order";
  return `ZED_BOT ${kind} ${paymentId.slice(0, 8)}`;
}

function payloadRecord(payment: Pick<Payment, "callbackPayload">): Record<string, unknown> {
  const payload = payment.callbackPayload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

/** Integer Stars amount stored on the payment at creation (pre-checkout guard). */
export function storedStarsAmount(payment: Pick<Payment, "callbackPayload">): number | null {
  const stars = payloadRecord(payment).stars;
  return typeof stars === "number" && Number.isInteger(stars) && stars > 0 ? stars : null;
}

/**
 * Rebuilds a CreatePaymentResult for an existing PENDING payment without a
 * provider round-trip: the redirect/invoice URL was stored (sanitized) in
 * callbackPayload at creation; the Stars invoice is derived from the stored
 * authority (= invoice payload) and stars amount.
 */
function resynthesizeCreateResult(payment: Payment): CreatePaymentResult | null {
  if (payment.authority === null || payment.authority === "") {
    return null;
  }
  if (payment.provider === PaymentGatewayType.TELEGRAM_STARS) {
    const stars = storedStarsAmount(payment);
    if (stars === null || !payment.authority.startsWith(STARS_PAYLOAD_PREFIX)) {
      return null;
    }
    const description = paymentDescription(
      payment.purpose === PaymentPurpose.WALLET_CHARGE ? "WALLET_CHARGE" : "ORDER_PAYMENT",
      payment.id,
    );
    return {
      ok: true,
      authority: payment.authority,
      telegramInvoice: {
        title: description.slice(0, 32),
        description,
        payload: payment.authority,
        currency: "XTR",
        stars,
      },
    };
  }
  const payload = payloadRecord(payment);
  const redirectUrl =
    typeof payload.redirectUrl === "string"
      ? payload.redirectUrl
      : typeof payload.invoiceUrl === "string"
        ? payload.invoiceUrl
        : null;
  if (redirectUrl === null) {
    return null;
  }
  return {
    ok: true,
    authority: payment.authority,
    ...(payment.externalReference === null ? {} : { externalReference: payment.externalReference }),
    redirectUrl,
  };
}

/**
 * The one Payment row per checkout+gateway (idempotencyKey
 * `gw:<checkoutId>:<gatewayId>`). Creates it PENDING; on a P2002 collision
 * the existing row is loaded and - when its previous attempt died before any
 * provider success (FAILED/CANCELLED/EXPIRED with providerStatus never
 * SUCCESS) - revived back to PENDING for a fresh provider create. Rows that
 * ever reached provider SUCCESS or APPROVED are never recycled.
 */
async function loadOrCreatePaymentRow(
  user: User,
  checkout: CheckoutSession,
  gateway: PaymentGatewayRow,
): Promise<Payment | null> {
  const idempotencyKey = `gw:${checkout.id}:${gateway.id}`;
  const purpose =
    checkout.purpose === "WALLET_CHARGE"
      ? PaymentPurpose.WALLET_CHARGE
      : PaymentPurpose.ORDER_PAYMENT;
  try {
    return await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        gatewayId: gateway.id,
        provider: gateway.type,
        purpose,
        status: PaymentStatus.PENDING,
        amountToman: checkout.finalPriceToman,
        payableAmountToman: checkout.finalPriceToman,
        expiresAt: checkout.expiresAt,
        idempotencyKey,
        callbackPayload: { method: gateway.type },
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
      throw err;
    }
    const row = await prisma.payment.findUnique({ where: { idempotencyKey } });
    if (row === null) {
      return null;
    }
    if (row.status === PaymentStatus.PENDING) {
      return row;
    }
    const revived = await prisma.payment.updateMany({
      where: {
        id: row.id,
        status: {
          in: [PaymentStatus.FAILED, PaymentStatus.CANCELLED, PaymentStatus.EXPIRED],
        },
        // Money-safety: a row whose provider ever reported SUCCESS is never
        // reset - it belongs to the settlement path.
        NOT: { providerStatus: "SUCCESS" },
      },
      data: {
        status: PaymentStatus.PENDING,
        providerStatus: null,
        authority: null,
        externalReference: null,
        externalTransactionId: null,
        expiresAt: checkout.expiresAt,
        callbackPayload: { method: gateway.type },
      },
    });
    if (revived.count === 0) {
      return null;
    }
    return prisma.payment.findUnique({ where: { id: row.id } });
  }
}

/**
 * Returns (or creates) the gateway payment for a PENDING checkout and the
 * data the UI needs (redirect URL / Telegram invoice). An existing PENDING
 * unexpired payment with an authority is reused with a re-synthesized create
 * result - no duplicate provider payment. Provider create failures mark the
 * row FAILED (nothing exists at the provider for it) and surface the Persian
 * gateway-unavailable template.
 */
export async function getOrCreateGatewayPayment(
  user: User,
  checkout: CheckoutSession,
  gateway: PaymentGatewayRow,
): Promise<GatewayPaymentResult> {
  const unavailable = async (): Promise<GatewayPaymentResult> => ({
    ok: false,
    error: await getMessageTemplate("payment_gateway_unavailable_text"),
  });
  if (!isOnlineProvider(gateway.type)) {
    return unavailable();
  }
  const manager = await buildGatewayManager();
  const adapter = manager.get(gateway.type);
  if (adapter === null || !adapter.isAvailable()) {
    return unavailable();
  }

  // REUSE: a live PENDING payment for this checkout+gateway that already has
  // a provider handle - hand back the same redirect/invoice.
  const existing = await prisma.payment.findFirst({
    where: {
      checkoutSessionId: checkout.id,
      gatewayId: gateway.id,
      status: PaymentStatus.PENDING,
      authority: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing !== null && (existing.expiresAt === null || existing.expiresAt.getTime() > Date.now())) {
    const create = resynthesizeCreateResult(existing);
    if (create !== null) {
      return { ok: true, payment: existing, create };
    }
  }

  const payment = await loadOrCreatePaymentRow(user, checkout, gateway);
  if (payment === null) {
    return unavailable();
  }
  // A concurrent duplicate may have finished the provider create already.
  if (payment.authority !== null) {
    const create = resynthesizeCreateResult(payment);
    if (create !== null) {
      return { ok: true, payment, create };
    }
  }

  // callbackUrl deliberately not passed: the adapters fall back to their env
  // config (ZARINPAL_CALLBACK_URL / NOWPAYMENTS_CALLBACK_URL).
  const create = await adapter.createPayment({
    paymentId: payment.id,
    amountToman: payment.payableAmountToman,
    description: paymentDescription(checkout.purpose, payment.id),
  });
  if (!create.ok || create.authority === undefined || create.authority === "") {
    // Nothing exists at the provider for this row - safe to fail it (a later
    // retry revives it through loadOrCreatePaymentRow).
    await prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED },
    });
    logger.warn("gateway payment creation failed", {
      paymentId: payment.id,
      provider: gateway.type,
      error: create.errorMessage,
    });
    return unavailable();
  }

  // Persist the provider handle + the sanitized redirect/invoice URL (reused
  // on re-entry) and the Stars amount (validated at pre-checkout).
  const payloadPatch: Prisma.InputJsonObject = {
    method: gateway.type,
    ...(gateway.type === "ZARINPAL" && create.redirectUrl !== undefined
      ? { redirectUrl: create.redirectUrl }
      : {}),
    ...(gateway.type === "NOWPAYMENTS" && create.redirectUrl !== undefined
      ? { invoiceUrl: create.redirectUrl }
      : {}),
    ...(create.telegramInvoice !== undefined ? { stars: create.telegramInvoice.stars } : {}),
  };
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      authority: create.authority,
      ...(create.externalReference !== undefined
        ? { externalReference: create.externalReference }
        : {}),
      callbackPayload: payloadPatch,
    },
  });
  logger.info("gateway payment created", {
    paymentId: payment.id,
    provider: gateway.type,
    purpose: payment.purpose,
    amountToman: payment.amountToman,
  });
  return { ok: true, payment: updated, create };
}

// --- provider success recording (bot side) -------------------------------------------

/**
 * Records a provider SUCCESS observed by the BOT (Stars updates, Zarinpal
 * verify fallback). Same semantics as the apps/api recorder: providerStatus
 * SUCCESS + verifiedAt set once + externalTransactionId, sanitized payload
 * merged into callbackPayload, and a CAS status move PENDING/PROCESSING ->
 * PROCESSING (skipped for rows already past expiresAt, like the API). Never
 * downgrades, idempotent on replays. Payment.status APPROVED only ever
 * happens inside settleGatewayPayment's transaction.
 */
export async function recordProviderSuccessFromBot(
  paymentId: string,
  event: { transactionId?: string; sanitizedPayload?: Record<string, unknown> },
): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (payment === null) {
    return;
  }
  const now = new Date();
  const merged = JSON.parse(
    JSON.stringify({ ...payloadRecord(payment), ...(event.sanitizedPayload ?? {}) }),
  ) as Prisma.InputJsonValue;
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      providerStatus: "SUCCESS",
      callbackPayload: merged,
      ...(payment.verifiedAt === null ? { verifiedAt: now } : {}),
      ...(event.transactionId !== undefined && event.transactionId !== ""
        ? { externalTransactionId: event.transactionId }
        : {}),
    },
  });
  const isExpired = payment.expiresAt !== null && payment.expiresAt.getTime() < now.getTime();
  if (!isExpired) {
    await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      data: { status: PaymentStatus.PROCESSING },
    });
  }
  logger.info("gateway provider success recorded (bot)", { paymentId: payment.id });
}

// --- settlement (the exactly-once money gate) -----------------------------------------

export type SettleOutcome =
  | { kind: "settled"; payment: Payment; order: Order | null; purpose: PaymentPurpose }
  | { kind: "already"; payment: Payment; order: Order | null; purpose: PaymentPurpose }
  | { kind: "pending" }
  | { kind: "failed"; status: PaymentStatus }
  | { kind: "error"; error: string };

/** Thrown when the settlement CAS matched 0 rows - a concurrent settle won. */
class AbortToAlready extends Error {
  constructor() {
    super("settlement lost the compare-and-set race");
  }
}

/** Thrown when an in-transaction re-check fails - everything rolls back. */
class SettleAbort extends Error {
  constructor(readonly reason: string) {
    super(`settlement aborted: ${reason}`);
  }
}

const FAILED_STATUSES: PaymentStatus[] = [
  PaymentStatus.REJECTED,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED,
  PaymentStatus.DELETED,
];

function snapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function snapshotInt(snapshot: Record<string, unknown>, key: string): number | null {
  const value = snapshot[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Validated int-array snapshot field ([] and non-arrays -> null). */
function snapshotIntArray(snapshot: Record<string, unknown>, key: string): number[] | null {
  const value = snapshot[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  return ids.length > 0 ? ids : null;
}

/** "already" outcome: the payment settled before - load its order. */
async function alreadyOutcome(payment: Payment): Promise<SettleOutcome> {
  let order: Order | null = null;
  if (payment.purpose === PaymentPurpose.ORDER_PAYMENT) {
    order =
      payment.orderId !== null
        ? await prisma.order.findUnique({ where: { id: payment.orderId } })
        : payment.checkoutSessionId !== null
          ? await prisma.order.findFirst({
              where: { checkoutSessionId: payment.checkoutSessionId },
              orderBy: { createdAt: "asc" },
            })
          : null;
  }
  return { kind: "already", payment, order, purpose: payment.purpose };
}

/**
 * Settles ONE gateway payment. This is the only place gateway money moves,
 * mirroring receipt-review.service:
 *
 *  1. Terminal states short-circuit (APPROVED -> "already", failed statuses
 *     -> "failed").
 *  2. Without a recorded provider SUCCESS: Zarinpal payments are verified
 *     on demand (verify is the source of truth; uncertain results never
 *     fail anything); NOWPayments/Stars stay "pending" until their IPN/bot
 *     update arrives.
 *  3. Amount guard: payment amounts must equal the checkout's final price.
 *  4. ONE transaction: CAS Payment PENDING/PROCESSING -> APPROVED (losers
 *     resolve to "already"), CAS checkout PENDING -> PAID, then the
 *     purpose-specific money move (wallet credit exactly once / one PAID
 *     order per checkout + user stats) and discount finalization.
 *
 * Safe to call concurrently and repeatedly from every trigger path.
 */
export async function settleGatewayPayment(paymentId: string): Promise<SettleOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { checkoutSession: true },
  });
  if (payment === null || payment.provider === null) {
    return { kind: "error", error: "payment not found or not a gateway payment" };
  }
  if (
    payment.purpose !== PaymentPurpose.ORDER_PAYMENT &&
    payment.purpose !== PaymentPurpose.WALLET_CHARGE
  ) {
    return { kind: "error", error: "unsupported payment purpose" };
  }
  const checkout = payment.checkoutSession;
  if (checkout === null) {
    return { kind: "error", error: "payment has no checkout session" };
  }

  if (payment.status === PaymentStatus.APPROVED) {
    return alreadyOutcome(payment);
  }
  if (FAILED_STATUSES.includes(payment.status)) {
    return { kind: "failed", status: payment.status };
  }
  if (payment.status === PaymentStatus.PENDING_REVIEW) {
    // Manual-review rows never settle here.
    return { kind: "error", error: "payment is in manual review" };
  }

  if (payment.providerStatus !== "SUCCESS") {
    // Zarinpal fallback: the redirect may have been lost - verify on demand.
    // Verify is idempotent server-side (code 101 = already verified).
    if (payment.provider === PaymentGatewayType.ZARINPAL && payment.authority !== null) {
      const manager = await buildGatewayManager();
      const adapter = manager.get("ZARINPAL");
      if (adapter === null) {
        return { kind: "pending" };
      }
      const verification = await adapter.verifyPayment({
        authority: payment.authority,
        amountToman: payment.payableAmountToman,
      });
      if (verification.ok && verification.status === "SUCCESS") {
        await recordProviderSuccessFromBot(payment.id, {
          transactionId: verification.transactionId,
        });
      } else if (verification.status === "FAILED" && verification.uncertain !== true) {
        // Definite provider failure (not a timeout/transport uncertainty).
        await prisma.payment.updateMany({
          where: {
            id: payment.id,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
          },
          data: { status: PaymentStatus.FAILED },
        });
        return { kind: "failed", status: PaymentStatus.FAILED };
      } else {
        return { kind: "pending" };
      }
    } else {
      // NOWPayments/Stars have no reliable poll - IPN / bot updates drive them.
      return { kind: "pending" };
    }
  }

  // Amount guard: never settle mismatched amounts.
  if (
    payment.amountToman !== payment.payableAmountToman ||
    payment.amountToman !== checkout.finalPriceToman
  ) {
    logger.error("gateway settlement amount mismatch", {
      paymentId: payment.id,
      amountToman: payment.amountToman,
      payableAmountToman: payment.payableAmountToman,
      checkoutFinalPriceToman: checkout.finalPriceToman,
    });
    return { kind: "error", error: "payment/checkout amount mismatch" };
  }

  const now = new Date();
  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  try {
    const order = await prisma.$transaction(async (tx) => {
      // (a) The exactly-once gate: only the first settle flips the payment.
      const flipped = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
        data: { status: PaymentStatus.APPROVED, paidAt: now, reviewedAt: now },
      });
      if (flipped.count === 0) {
        throw new AbortToAlready();
      }

      // (b) Checkout flip - count 0 means another payment already paid it.
      const checkoutFlipped = await tx.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutStatus.PENDING },
        data: { status: CheckoutStatus.PAID, paidAt: now },
      });

      // (c) Wallet top-up: mirror approveWalletTopup - balance moves exactly
      // once (guarded by relatedPaymentId + reason), no Order, no discount.
      if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
        if (checkoutFlipped.count === 0) {
          throw new SettleAbort("wallet top-up checkout is not PENDING");
        }
        const existingTx = await tx.walletTransaction.findFirst({
          where: { relatedPaymentId: payment.id, reason: WALLET_TOPUP_REASON },
        });
        if (existingTx === null) {
          // LEDGER-CRITICAL: the increment UPDATE takes the row lock and
          // returns the post-update row, so before/after always describe the
          // real transition (same as the receipt approval path).
          const credited = await tx.user.update({
            where: { id: payment.userId },
            data: {
              balanceToman: { increment: payment.amountToman },
              totalChargedToman: { increment: payment.amountToman },
            },
            select: { balanceToman: true },
          });
          const balanceAfter = credited.balanceToman;
          await tx.walletTransaction.create({
            data: {
              userId: payment.userId,
              amountToman: payment.amountToman,
              type: WalletTransactionType.CHARGE,
              source: WalletTransactionSource.USER_PAYMENT,
              reason: WALLET_TOPUP_REASON,
              relatedPaymentId: payment.id,
              balanceBeforeToman: balanceAfter - payment.amountToman,
              balanceAfterToman: balanceAfter,
            },
          });
        }
        return null;
      }

      // (d) Order payment: one PAID Order per checkout, exactly like the
      // receipt approval - an existing order is reused, never duplicated;
      // user stats move only with the (single) creation.
      const orderType = resolveOrderType(checkout, snapshot);
      let order = await tx.order.findFirst({
        where: { checkoutSessionId: checkout.id },
        orderBy: { createdAt: "asc" },
      });
      if (checkoutFlipped.count === 0 && order === null) {
        throw new SettleAbort("checkout is not PENDING and has no order to reuse");
      }
      if (order === null) {
        order = await tx.order.create({
          data: {
            userId: checkout.userId,
            checkoutSessionId: checkout.id,
            type: orderType,
            status: OrderStatus.PAID,
            productId: checkout.productId,
            serviceId: checkout.serviceId,
            paymentId: payment.id,
            originalPriceToman: checkout.originalPriceToman,
            discountAmountToman: checkout.discountAmountToman,
            finalPriceToman: checkout.finalPriceToman,
            discountCodeId: checkout.discountCodeId,
            productNameSnapshot: snapshotString(snapshot, "productName"),
            productDescriptionSnapshot: snapshotString(snapshot, "invoiceDescription"),
            productPriceSnapshot: snapshotInt(snapshot, "originalPriceToman"),
            durationDaysSnapshot: snapshotInt(snapshot, "durationDays"),
            volumeGbSnapshot: snapshotInt(snapshot, "volumeGb"),
            ...(snapshotIntArray(snapshot, "inboundIds") !== null
              ? { inboundIdsSnapshot: snapshotIntArray(snapshot, "inboundIds") as number[] }
              : {}),
            panelNameSnapshot: snapshotString(snapshot, "panelName"),
            locationSnapshot:
              snapshot.allLocations === true ? "ALL" : snapshotString(snapshot, "serviceLocation"),
            categorySnapshot: snapshotString(snapshot, "categoryName"),
            paidAt: now,
          },
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: { orderId: order.id },
        });
        // Stats only move with the (single) order creation, so a settle race
        // can never double-count. paidOrdersCount also unlocks gateways gated
        // by activateAfterSuccessfulPaymentsCount.
        await tx.user.update({
          where: { id: checkout.userId },
          data: {
            ordersCount: { increment: 1 },
            paidOrdersCount: { increment: 1 },
            totalPurchaseAmountToman: { increment: checkout.finalPriceToman },
          },
        });
      } else if (payment.orderId === null) {
        // Reused order: link it so "already" outcomes and the sweep's pass 2
        // resolve the order directly from the payment row.
        await tx.payment.update({
          where: { id: payment.id },
          data: { orderId: order.id },
        });
      }

      // (e) Discount finalization. DELIBERATE DIVERGENCE from the receipt and
      // wallet paths, which ABORT on a failed claim: those abort BEFORE any
      // money moves, but here the user has already paid the discounted amount
      // at an external provider - rolling back would strand real money, which
      // is worse than an over-claimed discount code. So a failed claim keeps
      // the settlement and flags the order for manual review instead.
      if (checkout.discountCodeId !== null && checkout.discountAmountToman > 0) {
        const claim = await claimDiscountUsage(tx, {
          discountCodeId: checkout.discountCodeId,
          userId: checkout.userId,
          orderId: order.id,
          checkoutSessionId: checkout.id,
          amountToman: checkout.discountAmountToman,
        });
        if (!claim.ok) {
          logger.error("discount claim failed after external payment - flagged for review", {
            paymentId: payment.id,
            orderId: order.id,
            discountCodeId: checkout.discountCodeId,
          });
          await tx.order.update({
            where: { id: order.id },
            data: {
              adminNote: "discount usage cap exceeded after external payment - manual review",
            },
          });
        }
      }

      return order;
    });

    const settled = await prisma.payment.findUnique({ where: { id: payment.id } });
    logger.info("gateway payment settled", {
      paymentId: payment.id,
      provider: payment.provider,
      purpose: payment.purpose,
      orderId: order?.id ?? null,
      amountToman: payment.amountToman,
    });
    return {
      kind: "settled",
      payment: settled ?? payment,
      order,
      purpose: payment.purpose,
    };
  } catch (err) {
    if (err instanceof AbortToAlready) {
      const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
      if (fresh !== null && fresh.status === PaymentStatus.APPROVED) {
        return alreadyOutcome(fresh);
      }
      if (fresh !== null && FAILED_STATUSES.includes(fresh.status)) {
        return { kind: "failed", status: fresh.status };
      }
      return { kind: "pending" };
    }
    if (err instanceof SettleAbort) {
      logger.error("gateway settlement aborted", {
        paymentId: payment.id,
        reason: err.reason,
      });
      return { kind: "error", error: err.reason };
    }
    logger.error("gateway settlement crashed", {
      paymentId: payment.id,
      error: errorMessage(err),
    });
    return { kind: "error", error: GENERIC_ERROR };
  }
}

// --- fulfillment -----------------------------------------------------------------------

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/** Send helper that never throws (blocked users, closed chats, ...). */
async function sendSafe(
  api: DeliverySendApi,
  chatId: string,
  text: string,
  other?: Record<string, unknown>,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, other);
  } catch (err) {
    logger.warn("gateway fulfillment notice failed", { error: errorMessage(err) });
  }
}

/**
 * Post-settlement fulfillment: wallet top-ups get their success notice;
 * orders dispatch to the SAME executors the admin receipt approval uses
 * (all CAS-claimed / idempotent, so repeats are safe). Never throws.
 */
export async function fulfillSettledGatewayOrder(
  api: DeliverySendApi,
  outcome: SettleOutcome,
): Promise<void> {
  try {
    if (outcome.kind !== "settled" && outcome.kind !== "already") {
      return;
    }
    const payment = outcome.payment;
    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (user === null) {
      return;
    }
    const chatId = user.telegramId.toString();

    if (outcome.purpose === PaymentPurpose.WALLET_CHARGE) {
      const text = [
        await getMessageTemplate("payment_success_text"),
        "",
        `مبلغ شارژ: ${formatToman(payment.amountToman)}`,
        `موجودی جدید: ${formatToman(user.balanceToman)}`,
      ].join("\n");
      await sendSafe(api, chatId, text);
      return;
    }

    const order = outcome.order;
    if (order === null) {
      logger.error("gateway fulfillment has no order", { paymentId: payment.id });
      return;
    }

    if (order.type === OrderType.SERVICE_PURCHASE) {
      const result = await provisionPaidOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildServiceInfoMessage(result.service), {
          parse_mode: "HTML",
        });
        return;
      }
      if (result.refunded) {
        await sendSafe(api, chatId, PROVISION_FAILED_USER_TEXT);
        return;
      }
      await sendSafe(api, chatId, approvalUserNotice(OrderType.SERVICE_PURCHASE));
      return;
    }

    if (order.type === OrderType.SERVICE_RENEWAL) {
      const result = await executeRenewalOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildRenewalSuccessMessage(result.service), {
          parse_mode: "HTML",
        });
        return;
      }
      if (result.refunded) {
        await sendSafe(api, chatId, RENEWAL_FAILED_USER_TEXT);
        return;
      }
      await sendSafe(api, chatId, approvalUserNotice(OrderType.SERVICE_RENEWAL));
      return;
    }

    if (order.type === OrderType.EXTRA_VOLUME) {
      const result = await executeExtraVolumeOrder(order.id);
      if (result.ok) {
        await sendSafe(
          api,
          chatId,
          buildExtraVolumeSuccessMessage(result.service, result.addedVolumeGb),
          { parse_mode: "HTML" },
        );
        return;
      }
      if (result.refunded) {
        await sendSafe(api, chatId, EXTRA_VOLUME_FAILED_USER_TEXT);
        return;
      }
      await sendSafe(api, chatId, approvalUserNotice(OrderType.EXTRA_VOLUME));
      return;
    }

    if (order.type === OrderType.EXTRA_TIME) {
      const result = await executeExtraTimeOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildExtraTimeSuccessMessage(result.service, result.addedDays), {
          parse_mode: "HTML",
        });
        return;
      }
      if (result.refunded) {
        await sendSafe(api, chatId, EXTRA_TIME_FAILED_USER_TEXT);
        return;
      }
      await sendSafe(api, chatId, approvalUserNotice(OrderType.EXTRA_TIME));
      return;
    }

    if (order.type === OrderType.OTHER_PRODUCT) {
      // Same dispatch as the receipt approval: stock auto-delivery first,
      // manual delivery as the fallback.
      const auto = await autoDeliverStockOrder(api, order.id);
      if (auto.status === "DELIVERED") {
        await notifyAdminsAboutStockAlert(api, {
          productId: auto.item.productId,
          orderId: order.id,
        });
        return;
      }
      if (auto.status === "ALREADY_DELIVERED") {
        return;
      }
      if (auto.status === "NO_STOCK") {
        await sendSafe(
          api,
          chatId,
          "پرداخت شما تایید شد ✅\nموجودی این محصول به پایان رسیده است و سفارش برای تحویل دستی ثبت شد.",
        );
      } else if (auto.status === "SEND_FAILED") {
        // The user received NO content (send failed before finalize), so the
        // manual fallback is safe.
        logger.warn("stock auto-delivery failed; falling back to manual", {
          orderId: order.id,
        });
      }
      const init = await initManualDelivery(order.id);
      if (!init.ok) {
        logger.error("manual delivery init after gateway settlement failed", {
          orderId: order.id,
          error: init.error,
        });
        await sendSafe(api, chatId, approvalUserNotice(OrderType.OTHER_PRODUCT));
        return;
      }
      if (!init.created) {
        // Repeat fulfillment (sweep/replay): the record and its notices
        // already exist - never spam the user or the admins again.
        return;
      }
      if (init.requiresInfo) {
        await sendSafe(
          api,
          chatId,
          `پرداخت شما تایید شد ✅\n\n${userInfoPromptText(init.promptText)}`,
          { reply_markup: userInfoButtonKeyboard(order.id) },
        );
        return;
      }
      if (auto.status !== "NO_STOCK") {
        await sendSafe(api, chatId, `پرداخت شما تایید شد ✅\n\n${WAITING_DELIVERY_USER_TEXT}`);
      }
      await notifyAdminsAboutManualOrder(api, init.record);
      return;
    }

    await sendSafe(api, chatId, approvalUserNotice(order.type));
  } catch (err) {
    logger.error("gateway fulfillment crashed", { error: errorMessage(err) });
  }
}

// --- short id lookup (check-status button) ----------------------------------------------

/** The user's own gateway payment by short id (unique-prefix, provider set). */
export async function getUserGatewayPaymentByShortId(
  userId: string,
  shortId: string,
): Promise<Payment | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.payment.findMany({
    where: { id: { startsWith: shortId }, userId, provider: { not: null } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- settlement sweep loop ---------------------------------------------------------------

/**
 * One sweep, never throws:
 *  - Pass 1: settle+fulfill payments whose provider SUCCESS was recorded
 *    (IPN/callback/Stars) but whose settlement has not run yet (bot was
 *    down, user never pressed the check button).
 *  - Pass 2 (crash recovery): re-fulfill APPROVED order payments whose order
 *    is still PAID (settled but fulfillment crashed) after a 2-minute grace.
 *    Orders with an existing manual-delivery record are excluded - they
 *    legitimately stay PAID until the admin delivers.
 *  - Expiry: PENDING gateway payments 30+ minutes past their expiresAt with
 *    no provider event flip to EXPIRED (CAS via the status filter).
 */
export async function runGatewaySettlementSweep(api: DeliverySendApi): Promise<void> {
  try {
    const ready = await prisma.payment.findMany({
      where: {
        provider: { in: ONLINE_PROVIDER_TYPES },
        providerStatus: "SUCCESS",
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of ready) {
      const outcome = await settleGatewayPayment(row.id);
      if (outcome.kind === "settled" || outcome.kind === "already") {
        await fulfillSettledGatewayOrder(api, outcome);
      }
    }

    const cutoff = new Date(Date.now() - UNFULFILLED_ORDER_MIN_AGE_MS);
    const unfulfilled = await prisma.payment.findMany({
      where: {
        provider: { in: ONLINE_PROVIDER_TYPES },
        status: PaymentStatus.APPROVED,
        purpose: PaymentPurpose.ORDER_PAYMENT,
        order: {
          is: {
            status: OrderStatus.PAID,
            updatedAt: { lt: cutoff },
            otherProductOrder: { is: null },
          },
        },
      },
      include: { order: true },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH_SIZE,
    });
    for (const paymentWithOrder of unfulfilled) {
      if (paymentWithOrder.order === null) {
        continue;
      }
      await fulfillSettledGatewayOrder(api, {
        kind: "already",
        payment: paymentWithOrder,
        order: paymentWithOrder.order,
        purpose: paymentWithOrder.purpose,
      });
    }

    const expired = await prisma.payment.updateMany({
      where: {
        provider: { in: ONLINE_PROVIDER_TYPES },
        status: PaymentStatus.PENDING,
        providerStatus: null,
        expiresAt: { lt: new Date(Date.now() - STALE_PENDING_GRACE_MS) },
      },
      data: { status: PaymentStatus.EXPIRED },
    });
    if (expired.count > 0) {
      logger.info("expired stale gateway payments", { count: expired.count });
    }
  } catch (err) {
    logger.error("gateway settlement sweep failed", { error: errorMessage(err) });
  }
}

/**
 * Self-rescheduling sweep loop: one sweep per minute, timers unref()ed so
 * they never keep the process alive, errors logged never thrown.
 */
export function startGatewaySettlementLoop(api: DeliverySendApi): void {
  const tick = (): void => {
    void runGatewaySettlementSweep(api)
      .catch((err: unknown) => {
        // runGatewaySettlementSweep never rejects, but the loop must survive
        // even if that guarantee is ever broken.
        logger.error("gateway settlement sweep rejected", { error: errorMessage(err) });
      })
      .finally(() => {
        setTimeout(tick, SWEEP_INTERVAL_MS).unref();
      });
  };
  setTimeout(tick, SWEEP_INTERVAL_MS).unref();
}
