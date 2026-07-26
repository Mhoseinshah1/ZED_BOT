import {
  CheckoutStatus,
  OrderStatus,
  PaymentGatewayType,
  PaymentPurpose,
  PaymentSettlementStatus,
  PaymentStatus,
  Prisma,
  prisma,
  StarsPricingMode,
  WalletTransactionSource,
  WalletTransactionType,
  type CheckoutSession,
  type FinancialReconciliationCase,
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
import { isMandatoryCustomerInfoMissing } from "./checkout-customer-input.service.js";
import { claimDiscountUsage } from "./discount.service.js";
import {
  bindSettledReservationFromSnapshot,
  lockReservationForSettlement,
} from "./service-username-selection.service.js";
import {
  blockedServiceUnboundCheckoutIds,
  fileServiceUsernameUnboundCase,
  findCaseForDuplicatePayment,
  notifyDuplicateSuccessCase,
  notifyServiceUsernameUnboundCase,
  recordDuplicateSuccess,
  sweepUnnotifiedServiceUnboundCases,
} from "./financial-reconciliation.service.js";
import { dispatchPaidOrderFulfillment } from "./order-fulfillment.service.js";
import { type DeliverySendApi } from "./other-product-delivery.service.js";
import { resolveOrderType } from "./receipt-review.service.js";
import { auditRepresentativeSettlementPricing } from "./representative-pricing.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";
import { getMessageTemplate } from "./text.service.js";
import { WALLET_TOPUP_REASON } from "./wallet-topup.service.js";
import { onWalletBalanceChanged } from "./low-balance/low-balance-hook.js";

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
  // Provider-management phase: an admin-disabled gateway row never creates
  // a payment, even through a stale/raced selection.
  if (!gateway.isEnabled || !isOnlineProvider(gateway.type)) {
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
  try {
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
  } catch (err) {
    // P0 settlement phase: @@unique(provider, externalTransactionId) - the
    // same external charge can never be attached to a SECOND local payment.
    // A replayed/forged event reusing another payment's transaction id is
    // refused entirely: no SUCCESS is recorded on reused evidence.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn("provider success refused - transaction id already attached elsewhere", {
        paymentId: payment.id,
        provider: payment.provider,
      });
      return;
    }
    throw err;
  }
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
  | {
      kind: "settled";
      payment: Payment;
      order: Order | null;
      purpose: PaymentPurpose;
      /**
       * §2/§3: present only when THIS settlement filed (or found) a durable
       * SERVICE_USERNAME_UNBOUND reconciliation case. `created` is true only on
       * the filing call, so the caller sends the OWNER alert exactly once.
       */
      serviceUnbound?: { reconciliationCase: FinancialReconciliationCase; created: boolean };
    }
  | { kind: "already"; payment: Payment; order: Order | null; purpose: PaymentPurpose }
  | { kind: "pending" }
  | { kind: "failed"; status: PaymentStatus }
  /**
   * P0 settlement phase: the provider collected real money but ANOTHER
   * payment owns this checkout's settlement. Non-retryable locally - the
   * duplicate is filed as a FinancialReconciliationCase (created=true only
   * on the filing call, so callers notify exactly once). Provider SUCCESS
   * stays recorded; nothing was provisioned/credited for this payment.
   */
  | {
      kind: "duplicate";
      payment: Payment;
      reconciliationCase: FinancialReconciliationCase;
      created: boolean;
    }
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

/**
 * Thrown when the checkout claim shows ANOTHER payment (or a pre-claim-era
 * settlement) owns the checkout: the current payment is a real duplicate
 * successful charge and must go to financial review.
 */
class DuplicateSuccess extends Error {
  constructor(
    readonly ownerPaymentId: string | null,
    readonly checkoutStatus: CheckoutStatus,
  ) {
    super("checkout settlement is owned by another payment");
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

/**
 * P0 settlement phase: order creation with the unique-constraint backstop.
 * A P2002 on Order.checkoutSessionId means a concurrent transaction created
 * the checkout's order first - re-read the winner, verify it belongs to the
 * same checkout and user, and reuse it. No second order, no raw error.
 */
async function createOrderIdempotent(
  tx: Prisma.TransactionClient,
  checkoutSessionId: string,
  userId: string,
  data: Prisma.OrderUncheckedCreateInput,
): Promise<{ order: Order; created: boolean }> {
  try {
    return { order: await tx.order.create({ data }), created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await tx.order.findFirst({ where: { checkoutSessionId } });
      if (winner !== null && winner.userId === userId) {
        return { order: winner, created: false };
      }
    }
    throw err;
  }
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
  // P0 settlement phase: a payment already filed for duplicate review is
  // terminal locally - return its existing case idempotently, never retry
  // provisioning/credits, never re-verify at the provider.
  if (payment.settlementStatus === PaymentSettlementStatus.DUPLICATE_SUCCESS_REVIEW) {
    const existingCase = await findCaseForDuplicatePayment(payment.id);
    if (existingCase !== null) {
      return { kind: "duplicate", payment, reconciliationCase: existingCase, created: false };
    }
    // Marker without a case (crash between the two writes is impossible -
    // they share a transaction - but stay defensive): file it now.
    const record = await recordDuplicateSuccess({
      checkoutSessionId: checkout.id,
      duplicatePaymentId: payment.id,
      primaryPaymentId: null,
      userId: payment.userId,
      expectedAmountToman: payment.amountToman,
      safeReason: "duplicate review marker found without a case - refiled",
    });
    return {
      kind: "duplicate",
      payment,
      reconciliationCase: record.reconciliationCase,
      created: record.created,
    };
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

  // §4 settlement-boundary gate (defense in depth). The pre-payment UI gate
  // already blocks creating a gateway payment / Stars invoice for a personalized
  // OTHER_PRODUCT until the customer-info form is confirmed, but a direct IPN, a
  // Stars successful_payment, or a settlement-sweep retry must ALSO refuse to
  // flip the checkout PAID without it. The provider charge stays recorded; a
  // later retry settles once the buyer completes the form.
  if (await isMandatoryCustomerInfoMissing(checkout)) {
    logger.warn("gateway settlement blocked: customer info not submitted", {
      paymentId: payment.id,
    });
    return { kind: "error", error: "customer info not submitted" };
  }

  const now = new Date();
  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  // §3: captured inside the settlement tx when a NEW SERVICE_USERNAME_UNBOUND case
  // is filed, so the OWNER alert fires exactly once AFTER commit (never inside the tx).
  let serviceUnbound: {
    reconciliationCase: FinancialReconciliationCase;
    created: boolean;
  } | null = null;
  try {
    const order = await prisma.$transaction(async (tx) => {
      // hotfix §7: lock the buyer's username reservation for the WHOLE settlement
      // transaction, BEFORE the checkout is flipped, so the concurrent cleanup
      // sweep (FOR UPDATE ... SKIP LOCKED) skips it and can never expire a
      // reservation that is settling. No-op when the snapshot carries no reservation.
      const settlingReservationId = snapshotString(snapshot, "serviceUsernameReservationId");
      if (settlingReservationId !== null) {
        await lockReservationForSettlement(tx, settlingReservationId);
      }
      // (a) THE ATOMIC CROSS-PROVIDER CLAIM (P0 settlement phase): the
      // checkout - not the payment - is the financial gate. Exactly one
      // Payment can ever set settledByPaymentId (compare-and-set on NULL),
      // so two provider successes can never both settle one checkout.
      const claimed = await tx.checkoutSession.updateMany({
        where: {
          id: checkout.id,
          settledByPaymentId: null,
          status: CheckoutStatus.PENDING,
        },
        data: { settledByPaymentId: payment.id, status: CheckoutStatus.PAID, paidAt: now },
      });
      if (claimed.count === 0) {
        const fresh = await tx.checkoutSession.findUnique({
          where: { id: checkout.id },
          select: { settledByPaymentId: true, status: true },
        });
        if (fresh === null) {
          throw new SettleAbort("checkout disappeared during settlement");
        }
        if (fresh.settledByPaymentId !== payment.id) {
          // Another payment (or a pre-claim-era/legacy path) owns this
          // checkout - the current provider SUCCESS is a real duplicate.
          throw new DuplicateSuccess(fresh.settledByPaymentId, fresh.status);
        }
        // This payment already owns the checkout (crash-recovery retry):
        // fall through - every step below is idempotent for the owner.
      }

      // (b) Owner-only payment flip: PENDING/PROCESSING -> APPROVED plus the
      // LOCAL settlement marker. count 0 = the same payment finished in a
      // concurrent call - resolve to "already".
      const flipped = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
        data: {
          status: PaymentStatus.APPROVED,
          paidAt: now,
          reviewedAt: now,
          settlementStatus: PaymentSettlementStatus.SETTLED,
          settledAt: now,
        },
      });
      if (flipped.count === 0) {
        throw new AbortToAlready();
      }

      // (c) Wallet top-up: mirror approveWalletTopup - balance moves exactly
      // once (guarded by relatedPaymentId + reason), no Order, no discount.
      // Checkout ownership is already guaranteed by the claim above.
      if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
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

          // Low-balance state machine: same transaction, committed balance, no I/O.
          await onWalletBalanceChanged(tx, {
            userId: payment.userId,
            // Same authoritative expression the ledger row above records: the
            // increment UPDATE took the row lock and returned the post-update
            // row, so after - amount is exactly the locked before value.
            balanceBeforeToman: balanceAfter - payment.amountToman,
            balanceAfterToman: balanceAfter,
            source: "GATEWAY_TOPUP",
          });
        }
        return null;
      }

      // (d) Order payment: one PAID Order per checkout - the claim makes
      // this payment the only allowed creator; the Order.checkoutSessionId
      // unique constraint is the defense-in-depth backstop (a P2002 race
      // resolves idempotently to the winner row).
      const orderType = resolveOrderType(checkout, snapshot);
      let order = await tx.order.findFirst({
        where: { checkoutSessionId: checkout.id },
        orderBy: { createdAt: "asc" },
      });
      let orderCreated = false;
      if (order === null) {
        const result = await createOrderIdempotent(tx, checkout.id, checkout.userId, {
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
          // Service-checkout username selection: the buyer's optional note.
          serviceNoteSnapshot: snapshotString(snapshot, "serviceUserNote"),
          paidAt: now,
        });
        order = result.order;
        orderCreated = result.created;
      }
      if (orderCreated) {
        // hotfix §2/§6: strictly bind the buyer's username reservation to this
        // settled order. EXTERNAL-SUCCESS settlement (Zarinpal / NOWPayments /
        // one-shot Stars): the provider already captured real money, so a bind
        // anomaly must NOT roll back. Instead file a DURABLE reconciliation case
        // (committed atomically with this paid Order); the order-fulfillment
        // dispatcher refuses to provision any SERVICE order that has such an open
        // case, so provider SUCCESS is preserved but no service is created and the
        // username is never regenerated. Idempotent by the settling payment id.
        const bindResult = await bindSettledReservationFromSnapshot(tx, snapshot, {
          userId: checkout.userId,
          checkoutSessionId: checkout.id,
          orderId: order.id,
        });
        if (!bindResult.bound) {
          serviceUnbound = await fileServiceUsernameUnboundCase(tx, {
            checkoutSessionId: checkout.id,
            paymentId: payment.id,
            userId: checkout.userId,
            expectedAmountToman: checkout.finalPriceToman,
            safeReason: `gateway settlement reservation bind failed: ${bindResult.reason}`,
          });
        }
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

    // §16 settlement-boundary audit (gateway): the user was already charged
    // against the frozen reseller price and the amount-match above is exact, so
    // the paid Order is authoritative and honored as-is; this only records a
    // WARN marker if live reseller pricing drifted. Order payments only; never
    // blocks/mutates/throws.
    if (payment.purpose === PaymentPurpose.ORDER_PAYMENT) {
      void auditRepresentativeSettlementPricing(checkout);
    }

    const settled = await prisma.payment.findUnique({ where: { id: payment.id } });
    // Audit trail: this payment claimed and settled the checkout.
    logger.info("gateway payment settled", {
      paymentId: payment.id,
      provider: payment.provider,
      purpose: payment.purpose,
      checkoutSessionId: checkout.id,
      settledByPaymentId: payment.id,
      orderId: order?.id ?? null,
      amountToman: payment.amountToman,
    });
    // Ops log (PAYMENT topic) - allowlisted fields only, never payloads.
    void writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.PAYMENT_SETTLED,
      message: "gateway payment settled",
      metadata: {
        provider: payment.provider,
        purpose: payment.purpose,
        amountToman: payment.amountToman,
      },
      topicKey: "PAYMENT",
      userId: payment.userId,
      paymentId: payment.id,
      orderId: order?.id ?? undefined,
    });
    return {
      kind: "settled",
      payment: settled ?? payment,
      order,
      purpose: payment.purpose,
      ...(serviceUnbound !== null ? { serviceUnbound } : {}),
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
    if (err instanceof DuplicateSuccess) {
      // Losing path (atomic): mark the LOCAL duplicate state + file exactly
      // one reconciliation case. Provider SUCCESS and Payment.status are
      // untouched - the external charge stays truthfully recorded.
      const record = await recordDuplicateSuccess({
        checkoutSessionId: checkout.id,
        duplicatePaymentId: payment.id,
        primaryPaymentId: err.ownerPaymentId,
        userId: payment.userId,
        expectedAmountToman: payment.amountToman,
        safeReason:
          err.ownerPaymentId !== null
            ? "duplicate provider success: checkout already settled by another payment"
            : `checkout not claimable (status ${err.checkoutStatus}) with no recorded owner`,
      });
      const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
      return {
        kind: "duplicate",
        payment: fresh ?? payment,
        reconciliationCase: record.reconciliationCase,
        created: record.created,
      };
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
 * orders go through the UNIFIED post-payment dispatcher shared with the
 * wallet and receipt-approval paths (all executors CAS-claimed / idempotent,
 * so repeats are safe). Never throws.
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

    if (outcome.purpose === PaymentPurpose.WALLET_CHARGE) {
      const text = [
        await getMessageTemplate("payment_success_text"),
        "",
        `مبلغ شارژ: ${formatToman(payment.amountToman)}`,
        `موجودی جدید: ${formatToman(user.balanceToman)}`,
      ].join("\n");
      await sendSafe(api, user.telegramId.toString(), text);
      return;
    }

    const order = outcome.order;
    if (order === null) {
      logger.error("gateway fulfillment has no order", { paymentId: payment.id });
      return;
    }
    await dispatchPaidOrderFulfillment(api, order.id, { source: "GATEWAY", user });
    // §3: a NEWLY filed username-reconciliation case alerts the OWNER admins
    // exactly once — AFTER the settlement committed and fulfillment ran (which
    // already sent the user the safe hold notice and blocked provisioning). The
    // alert send is non-blocking and never throws, so it cannot roll back the
    // provider-success settlement or delete the durable case.
    if (outcome.kind === "settled" && outcome.serviceUnbound?.created === true) {
      await notifyServiceUsernameUnboundCase(
        api,
        outcome.serviceUnbound.reconciliationCase,
        payment,
      );
    }
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
        // P0 settlement phase: duplicate-review rows are locally terminal -
        // retrying them would loop forever (their checkout belongs to
        // another payment). The reconciliation queue owns them now.
        settlementStatus: PaymentSettlementStatus.UNSETTLED,
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of ready) {
      const outcome = await settleGatewayPayment(row.id);
      if (outcome.kind === "settled" || outcome.kind === "already") {
        await fulfillSettledGatewayOrder(api, outcome);
      } else if (outcome.kind === "duplicate" && outcome.created) {
        // Notify exactly once - the case is already committed, so a crashed
        // notification is retried by the admin queue, never by re-filing.
        await notifyDuplicateSuccessCase(api, outcome.reconciliationCase, outcome.payment);
      }
    }

    const cutoff = new Date(Date.now() - UNFULFILLED_ORDER_MIN_AGE_MS);
    // Codex P1 fix: a SERVICE order whose username reservation could not be bound
    // is deliberately held PAID behind an OPEN/IN_REVIEW reconciliation case.
    // EXCLUDE those checkouts from the recovery batch so they are neither
    // re-notified on every one-minute sweep nor allowed to starve the bounded
    // batch and block genuinely unfulfilled orders. The case is resolved (and the
    // order provisioned) only via the OWNER retry-bind action.
    const blockedCheckoutIds = await blockedServiceUnboundCheckoutIds();
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
            ...(blockedCheckoutIds.length > 0
              ? { checkoutSessionId: { notIn: blockedCheckoutIds } }
              : {}),
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

    // Codex P2 fix: durably retry OWNER alerts for any SERVICE_USERNAME_UNBOUND
    // case that was committed but never notified (crash between commit and push,
    // or a transient send failure). Idempotent — each case is marked delivered.
    await sweepUnnotifiedServiceUnboundCases(api);
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
