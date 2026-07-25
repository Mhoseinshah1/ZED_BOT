import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  prisma,
  WalletTransactionSource,
  WalletTransactionType,
  type CheckoutSession,
  type DiscountCode,
  type Order,
  type Payment,
  type Service,
  type User,
  type WalletTransaction,
} from "@zedbot/database";

import { REPRESENTATIVE_PRICING_MODE, resolveAutoRenewalCharge } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { CheckoutDraft, ExtraTimeDraft, ExtraVolumeDraft, RenewalDraft } from "../core/session.js";
import { isProductVisible } from "./catalog.service.js";
import { buildProductSnapshot, checkoutExpiryMinutes } from "./checkout.service.js";
import { attachReservationToOrder } from "./service-username-selection.service.js";
import { claimDiscountUsage, validateDiscountCode } from "./discount.service.js";
import { resolveEffectiveProductPrice } from "./representative-pricing.service.js";
import {
  recordRepresentativePurchase,
  type RepresentativePurchaseSnapshot,
} from "./representative.service.js";
import {
  isWalletPaymentEnabled,
  WALLET_PAYMENT_DISABLED_TEXT,
} from "./payment-settings.service.js";
import {
  buildExtraTimeSnapshot,
  getExtraTimeServiceByShortId,
  isExtraTimePackageValid,
} from "./extra-time.service.js";
import {
  buildExtraVolumeSnapshot,
  getExtraVolumeServiceByShortId,
  isExtraVolumePackageValid,
} from "./extra-volume.service.js";
import type { ProductWithRelations } from "./product.service.js";
import {
  buildRenewalSnapshot,
  getRenewableServiceByShortId,
  isRenewalPlanValid,
} from "./renewal-checkout.service.js";

// =============================================================================
// Wallet payment for ORDER checkouts (Phase 15): an immediate payment method
// for service purchase / renewal pre-invoices. ONE transaction creates the
// PAID CheckoutSession, the APPROVED Payment (purpose PAY_WITH_WALLET,
// method WALLET), the PAID Order, deducts the balance and writes the SPEND
// WalletTransaction + discount finalization - they commit together, so a
// deducted balance always has its order and vice versa. No ManualReceipt,
// no PENDING_REVIEW, no admin review, no card account - and never for
// WALLET_CHARGE (top-up) checkouts.
//
// Idempotency: Payment.idempotencyKey = wallet:<userId>:<draftNonce> (the
// nonce is minted when the pre-invoice opens). A double click or concurrent
// duplicate hits the unique key and gets the FIRST result back - the
// balance can never be deducted twice for one pre-invoice.
//
// Overspend safety: DIFFERENT drafts (different nonces) don't share an
// idempotency key, so they compete on the balance itself - deduction is an
// atomic conditional update (WHERE balanceToman >= amount), never a
// read-check-then-decrement. If funds only cover one of two racing drafts,
// exactly one wins; the other rolls back with INSUFFICIENT_BALANCE_TEXT.
// =============================================================================

export const WALLET_ORDER_PAYMENT_REASON = "WALLET_ORDER_PAYMENT";

export const WALLET_PAYMENT_DONE_TEXT = "پرداخت از کیف پول با موفقیت انجام شد ✅\nسفارش شما ثبت شد.";
export const INSUFFICIENT_BALANCE_TEXT = "موجودی کیف پول شما کافی نیست.";
const DRAFT_STALE_TEXT = "پیش‌فاکتور در دسترس نیست؛ لطفاً دوباره شروع کنید.";
const DISCOUNT_CHANGED_TEXT = "کد تخفیف دیگر معتبر نیست. لطفاً دوباره پیش‌فاکتور را بررسی کنید.";
// Representative Program (§16): reseller pricing changed or is no longer
// available at the settlement boundary — fail closed BEFORE money moves.
const REP_PRICE_STALE_TEXT =
  "قیمت نمایندگی این محصول تغییر کرده است. لطفاً دوباره از «خرید نمایندگی» اقدام کنید.";
const REP_CHECKOUT_UNAVAILABLE_TEXT =
  "خرید با قیمت نمایندگی در حال حاضر در دسترس نیست. لطفاً بعداً تلاش کنید.";

export type WalletPaymentResult =
  | {
      ok: true;
      order: Order;
      payment: Payment;
      checkout: CheckoutSession;
      walletTransaction: WalletTransaction;
      newBalanceToman: number;
      alreadyPaid: boolean;
    }
  | { ok: false; error: string };

/** Thrown inside the transaction to abort with a safe user error. */
class WalletPaymentAbort extends Error {
  constructor(readonly userError: string) {
    super("wallet payment aborted");
  }
}

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

interface WalletOrderArgs {
  orderType: OrderType;
  product: ProductWithRelations;
  serviceId: string | null;
  snapshot: Prisma.InputJsonObject;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCodeId: string | null;
  idempotencyKey: string;
}

/** Loads the settled result of a previously-executed idempotency key. */
async function loadExistingWalletPayment(
  idempotencyKey: string,
): Promise<WalletPaymentResult | null> {
  const payment = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (payment === null || payment.orderId === null || payment.checkoutSessionId === null) {
    return null;
  }
  const [order, checkout, walletTransaction] = await Promise.all([
    prisma.order.findUnique({ where: { id: payment.orderId } }),
    prisma.checkoutSession.findUnique({ where: { id: payment.checkoutSessionId } }),
    prisma.walletTransaction.findFirst({
      where: { relatedPaymentId: payment.id, reason: WALLET_ORDER_PAYMENT_REASON },
    }),
  ]);
  if (order === null || checkout === null || walletTransaction === null) {
    return null;
  }
  return {
    ok: true,
    order,
    payment,
    checkout,
    walletTransaction,
    newBalanceToman: walletTransaction.balanceAfterToman,
    alreadyPaid: true,
  };
}

/**
 * The atomic wallet-payment transaction shared by purchase and renewal.
 * Balance enforcement is a CONDITIONAL update (`updateMany` filtered on
 * `balanceToman >= finalPriceToman`), not a read-then-check: the database
 * re-evaluates the condition against the current committed row under the
 * row lock, so two DIFFERENT drafts racing on one wallet can never both
 * spend a balance that only covers one - the loser matches 0 rows and the
 * whole transaction rolls back. A negative balance is impossible.
 */
async function executeWalletOrderPayment(
  user: User,
  args: WalletOrderArgs,
): Promise<WalletPaymentResult> {
  const existing = await loadExistingWalletPayment(args.idempotencyKey);
  if (existing !== null) {
    return existing;
  }
  // Phase 22 operator kill-switch, enforced at the SERVICE level so stale
  // buttons/old keyboards can never reach the transaction. Checked after
  // the idempotent replay above: an already-settled payment still returns
  // its result, but no NEW money moves while disabled.
  if (!(await isWalletPaymentEnabled())) {
    return { ok: false, error: WALLET_PAYMENT_DISABLED_TEXT };
  }
  const minutes = await checkoutExpiryMinutes();
  const now = new Date();
  const snapshotRecord = args.snapshot as Record<string, unknown>;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const checkout = await tx.checkoutSession.create({
        data: {
          userId: user.id,
          purpose: "ORDER_PAYMENT",
          productId: args.product.id,
          serviceId: args.serviceId,
          orderType: args.orderType,
          productSnapshot: args.snapshot,
          originalPriceToman: args.originalPriceToman,
          discountAmountToman: args.discountAmountToman,
          finalPriceToman: args.finalPriceToman,
          discountCodeId: args.discountCodeId,
          status: CheckoutStatus.PAID,
          paidAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        },
      });

      const payment = await tx.payment.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          purpose: PaymentPurpose.PAY_WITH_WALLET,
          status: PaymentStatus.APPROVED,
          amountToman: args.finalPriceToman,
          payableAmountToman: args.finalPriceToman,
          paidAt: now,
          callbackPayload: { method: "WALLET" },
          idempotencyKey: args.idempotencyKey,
          // P0 settlement phase: the wallet payment settles its own
          // freshly-created checkout in this same transaction.
          settlementStatus: "SETTLED",
          settledAt: now,
        },
      });
      // P0 settlement phase: record the settlement OWNER - a later gateway
      // success against this checkout is a duplicate, never a re-settle.
      await tx.checkoutSession.update({
        where: { id: checkout.id },
        data: { settledByPaymentId: payment.id },
      });

      const order = await tx.order.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          type: args.orderType,
          status: OrderStatus.PAID,
          productId: args.product.id,
          serviceId: args.serviceId,
          paymentId: payment.id,
          originalPriceToman: args.originalPriceToman,
          discountAmountToman: args.discountAmountToman,
          finalPriceToman: args.finalPriceToman,
          discountCodeId: args.discountCodeId,
          productNameSnapshot: snapshotString(snapshotRecord, "productName"),
          productDescriptionSnapshot: snapshotString(snapshotRecord, "invoiceDescription"),
          productPriceSnapshot: snapshotInt(snapshotRecord, "originalPriceToman"),
          durationDaysSnapshot: snapshotInt(snapshotRecord, "durationDays"),
          volumeGbSnapshot: snapshotInt(snapshotRecord, "volumeGb"),
          ...(snapshotIntArray(snapshotRecord, "inboundIds") !== null
            ? { inboundIdsSnapshot: snapshotIntArray(snapshotRecord, "inboundIds") as number[] }
            : {}),
          panelNameSnapshot: snapshotString(snapshotRecord, "panelName"),
          locationSnapshot:
            snapshotRecord.allLocations === true
              ? "ALL"
              : snapshotString(snapshotRecord, "serviceLocation"),
          categorySnapshot: snapshotString(snapshotRecord, "categoryName"),
          // Service-checkout username selection: the buyer's optional note,
          // frozen from the checkout snapshot (null when skipped / not a SERVICE).
          serviceNoteSnapshot: snapshotString(snapshotRecord, "serviceUserNote"),
          paidAt: now,
        },
      });
      // Bind the buyer's username reservation to this settled order (BOUND).
      const reservationId = snapshotString(snapshotRecord, "serviceUsernameReservationId");
      if (reservationId !== null) {
        await attachReservationToOrder(tx, reservationId, order.id, checkout.id);
      }
      const settledPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { orderId: order.id },
      });

      // SECURITY-CRITICAL: atomic check-and-deduct. The WHERE condition is
      // re-evaluated by PostgreSQL against the committed row while holding
      // its lock, so a concurrent spend from a DIFFERENT draft can never
      // sneak past a stale balance read. 0 rows matched = insufficient
      // funds = the whole transaction (checkout/payment/order above) rolls
      // back. Deliberately placed AFTER payment.create: a concurrent
      // SAME-draft duplicate blocks on the unique idempotencyKey first and
      // resolves via the P2002 path without ever touching the balance.
      const deducted = await tx.user.updateMany({
        where: { id: user.id, balanceToman: { gte: args.finalPriceToman } },
        data: {
          balanceToman: { decrement: args.finalPriceToman },
          totalSpentToman: { increment: args.finalPriceToman },
          ...(args.discountAmountToman > 0
            ? { totalDiscountToman: { increment: args.discountAmountToman } }
            : {}),
          ordersCount: { increment: 1 },
          paidOrdersCount: { increment: 1 },
          totalPurchaseAmountToman: { increment: args.finalPriceToman },
        },
      });
      if (deducted.count !== 1) {
        throw new WalletPaymentAbort(INSUFFICIENT_BALANCE_TEXT);
      }
      // Exact ledger values from the row we just updated (still locked by
      // this transaction, so no other spend can interleave).
      const updatedUser = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { balanceToman: true },
      });
      const balanceAfter = updatedUser.balanceToman;
      const balanceBefore = balanceAfter + args.finalPriceToman;
      const walletTransaction = await tx.walletTransaction.create({
        data: {
          userId: user.id,
          amountToman: args.finalPriceToman,
          type: WalletTransactionType.SPEND,
          source: WalletTransactionSource.ORDER,
          reason: WALLET_ORDER_PAYMENT_REASON,
          relatedOrderId: order.id,
          relatedPaymentId: payment.id,
          balanceBeforeToman: balanceBefore,
          balanceAfterToman: balanceAfter,
        },
      });

      // SECURITY-CRITICAL discount finalization: claimDiscountUsage locks
      // the DiscountCode row and re-validates active/window/total/per-user
      // limits against the committed state - the pre-payment validation
      // above is UX only and is never trusted here. A failed claim aborts
      // the WHOLE payment (order, payment, deduction all roll back), so a
      // discounted price can never settle without its claimed usage.
      if (args.discountCodeId !== null && args.discountAmountToman > 0) {
        const claim = await claimDiscountUsage(tx, {
          discountCodeId: args.discountCodeId,
          userId: user.id,
          orderId: order.id,
          checkoutSessionId: checkout.id,
          amountToman: args.discountAmountToman,
        });
        if (!claim.ok) {
          throw new WalletPaymentAbort(claim.safeMessage);
        }
      }

      return {
        order,
        payment: settledPayment,
        checkout,
        walletTransaction,
        newBalanceToman: balanceAfter,
      };
    });
    logger.info("wallet payment settled", {
      orderId: result.order.id,
      paymentId: result.payment.id,
      userId: user.id,
      orderType: args.orderType,
      amountToman: args.finalPriceToman,
    });
    return { ok: true, ...result, alreadyPaid: false };
  } catch (err) {
    if (err instanceof WalletPaymentAbort) {
      return { ok: false, error: err.userError };
    }
    // Unique idempotencyKey collision: a concurrent duplicate won - return
    // its settled result instead of failing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const settled = await loadExistingWalletPayment(args.idempotencyKey);
      if (settled !== null) {
        return settled;
      }
    }
    throw err;
  }
}

/**
 * Wallet payment for a product-purchase pre-invoice draft. Supports BOTH
 * product types (other-product-wallet phase):
 *   SERVICE_PRODUCT -> OrderType.SERVICE_PURCHASE (provisioned later)
 *   OTHER_PRODUCT   -> OrderType.OTHER_PRODUCT   (manual/stock delivery)
 * Nothing from the session is trusted: the product is reloaded with its
 * relations and visibility / active state / price / discount / final amount
 * are recomputed here. Delivery requirements and stock configuration are
 * snapshot via buildProductSnapshot and re-read fresh from the Product row
 * by the post-commit fulfillment dispatch - the wallet transaction itself
 * never provisions, never sends and never touches stock.
 */
export async function payPurchaseDraftWithWallet(
  user: User,
  draft: CheckoutDraft,
): Promise<WalletPaymentResult> {
  if (draft.draftNonce === undefined) {
    return { ok: false, error: DRAFT_STALE_TEXT };
  }
  const product = await prisma.product.findUnique({
    where: { id: draft.productId },
    include: { category: true, panel: true },
  });
  if (
    product === null ||
    (product.type !== "SERVICE_PRODUCT" && product.type !== "OTHER_PRODUCT") ||
    !isProductVisible(product, user.group) ||
    (draft.panelId !== undefined && product.panelId !== draft.panelId)
  ) {
    return { ok: false, error: DRAFT_STALE_TEXT };
  }

  // Never trust the session price: recompute from the product + discount. For a
  // representative purchase the price comes from the authoritative resolver at
  // the SETTLE boundary (uncached switch) and a stale reseller price/fingerprint
  // fails closed BEFORE any money moves (§16). The retail branch is unchanged.
  let originalPriceToman: number;
  let discountAmountToman = 0;
  let discountCodeId: string | null = null;
  let repSnapshot: RepresentativePurchaseSnapshot | null = null;

  if (draft.representative !== undefined) {
    // Validate the code (window/limits/group) first for a clear UX error; the
    // resolver then applies the reseller stacking rule (§7).
    let validatedCode: DiscountCode | null = null;
    if (draft.discountCode !== undefined) {
      const v = await validateDiscountCode(
        draft.discountCode,
        user,
        draft.representative.basePriceToman,
      );
      if (!v.ok) {
        return { ok: false, error: DISCOUNT_CHANGED_TEXT };
      }
      validatedCode = v.discountCode;
    }
    const effective = await resolveEffectiveProductPrice({
      user,
      product,
      checkoutPurpose: "PURCHASE",
      discountCode: validatedCode,
      mode: "SETTLE",
    });
    if (effective.pricingMode !== REPRESENTATIVE_PRICING_MODE) {
      return { ok: false, error: REP_CHECKOUT_UNAVAILABLE_TEXT };
    }
    if (
      effective.priceFingerprint !== draft.representative.priceFingerprint ||
      effective.tierFingerprint !== draft.representative.tierFingerprint
    ) {
      return { ok: false, error: REP_PRICE_STALE_TEXT };
    }
    originalPriceToman = effective.basePriceToman;
    discountAmountToman = effective.discountAmountToman;
    discountCodeId = effective.discountCodeId;
    repSnapshot = {
      representativeId: effective.representativeId,
      tierId: effective.tierId,
      priceMode: effective.priceMode,
      retailPriceToman: effective.retailPriceToman,
      basePriceToman: effective.basePriceToman,
      discountAmountToman: effective.discountAmountToman,
      finalPriceToman: effective.finalPriceToman,
      tierFingerprint: effective.tierFingerprint,
      priceFingerprint: effective.priceFingerprint,
    };
  } else {
    originalPriceToman = product.priceToman;
    if (draft.discountCode !== undefined) {
      const validation = await validateDiscountCode(draft.discountCode, user, originalPriceToman);
      if (!validation.ok) {
        return { ok: false, error: DISCOUNT_CHANGED_TEXT };
      }
      discountAmountToman = validation.discountAmountToman;
      discountCodeId = validation.discountCode.id;
    }
  }
  const finalPriceToman = Math.max(0, originalPriceToman - discountAmountToman);
  if (finalPriceToman <= 0) {
    return { ok: false, error: "امکان پرداخت بدون مبلغ وجود ندارد." };
  }
  if (user.balanceToman < finalPriceToman) {
    return { ok: false, error: INSUFFICIENT_BALANCE_TEXT };
  }

  const snapshot = buildProductSnapshot(product, {
    ...draft,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
  });
  const result = await executeWalletOrderPayment(user, {
    orderType:
      product.type === "OTHER_PRODUCT" ? OrderType.OTHER_PRODUCT : OrderType.SERVICE_PURCHASE,
    product,
    serviceId: null,
    snapshot,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
    discountCodeId,
    idempotencyKey: `wallet:${user.id}:${draft.draftNonce}`,
  });

  // Record the reseller purchase marker as COMPLETED once the wallet settled
  // (the wallet path creates its own checkout inside executeWalletOrderPayment,
  // so there is no prior PENDING marker to complete). Best-effort: the money
  // already committed and the Order is authoritative; keyed by the unique
  // checkoutSessionId, so a replay converges (§25).
  if (result.ok && repSnapshot !== null) {
    await recordRepresentativePurchase(prisma, {
      checkoutSessionId: result.checkout.id,
      userId: user.id,
      productId: product.id,
      status: "COMPLETED",
      paymentId: result.payment.id,
      orderId: result.order.id,
      snapshot: repSnapshot,
    });
  }
  return result;
}

/** Wallet payment for a renewal pre-invoice draft (Phase 12 semantics). */
export async function payRenewalDraftWithWallet(
  user: User,
  draft: RenewalDraft,
): Promise<{ result: WalletPaymentResult; service: Service | null }> {
  if (draft.draftNonce === undefined) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product =
    service === null
      ? null
      : await prisma.product.findUnique({
          where: { id: draft.productId },
          include: { category: true, panel: true },
        });
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isRenewalPlanValid(product, service, user.group)
  ) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }

  const originalPriceToman = product.priceToman;
  let discountAmountToman = 0;
  let discountCodeId: string | null = null;
  if (draft.discountCode !== undefined) {
    const validation = await validateDiscountCode(
      draft.discountCode,
      user,
      originalPriceToman,
      "RENEWAL",
    );
    if (!validation.ok) {
      return { result: { ok: false, error: DISCOUNT_CHANGED_TEXT }, service };
    }
    discountAmountToman = validation.discountAmountToman;
    discountCodeId = validation.discountCode.id;
  }
  const finalPriceToman = Math.max(0, originalPriceToman - discountAmountToman);
  if (finalPriceToman <= 0) {
    return { result: { ok: false, error: "امکان پرداخت بدون مبلغ وجود ندارد." }, service };
  }
  if (user.balanceToman < finalPriceToman) {
    return { result: { ok: false, error: INSUFFICIENT_BALANCE_TEXT }, service };
  }

  const snapshot = buildRenewalSnapshot(product, service, {
    ...draft,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
  });
  const result = await executeWalletOrderPayment(user, {
    orderType: OrderType.SERVICE_RENEWAL,
    product,
    serviceId: service.id,
    snapshot,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
    discountCodeId,
    idempotencyKey: `wallet:${user.id}:${draft.draftNonce}`,
  });
  return { result, service };
}

/** Wallet payment for an extra-volume pre-invoice draft (Phase 16). */
export async function payExtraVolumeDraftWithWallet(
  user: User,
  draft: ExtraVolumeDraft,
): Promise<{ result: WalletPaymentResult; service: Service | null }> {
  if (draft.draftNonce === undefined) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }
  // The eligibility lookup already excludes unlimited/foreign/deleted services.
  const service = await getExtraVolumeServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product =
    service === null
      ? null
      : await prisma.product.findUnique({
          where: { id: draft.productId },
          include: { category: true, panel: true },
        });
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isExtraVolumePackageValid(product, service, user.group)
  ) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }

  const originalPriceToman = product.priceToman;
  let discountAmountToman = 0;
  let discountCodeId: string | null = null;
  if (draft.discountCode !== undefined) {
    // Extra volume counts as a PURCHASE for discount semantics (Phase 16).
    const validation = await validateDiscountCode(draft.discountCode, user, originalPriceToman);
    if (!validation.ok) {
      return { result: { ok: false, error: DISCOUNT_CHANGED_TEXT }, service };
    }
    discountAmountToman = validation.discountAmountToman;
    discountCodeId = validation.discountCode.id;
  }
  const finalPriceToman = Math.max(0, originalPriceToman - discountAmountToman);
  if (finalPriceToman <= 0) {
    return { result: { ok: false, error: "امکان پرداخت بدون مبلغ وجود ندارد." }, service };
  }
  if (user.balanceToman < finalPriceToman) {
    return { result: { ok: false, error: INSUFFICIENT_BALANCE_TEXT }, service };
  }

  const snapshot = buildExtraVolumeSnapshot(product, service, {
    ...draft,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
  });
  const result = await executeWalletOrderPayment(user, {
    orderType: OrderType.EXTRA_VOLUME,
    product,
    serviceId: service.id,
    snapshot,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
    discountCodeId,
    idempotencyKey: `wallet:${user.id}:extra-volume:${draft.draftNonce}`,
  });
  return { result, service };
}

/** Wallet payment for an extra-time pre-invoice draft (Phase 17). */
export async function payExtraTimeDraftWithWallet(
  user: User,
  draft: ExtraTimeDraft,
): Promise<{ result: WalletPaymentResult; service: Service | null }> {
  if (draft.draftNonce === undefined) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }
  // The eligibility lookup already excludes never-expiring/foreign/deleted services.
  const service = await getExtraTimeServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product =
    service === null
      ? null
      : await prisma.product.findUnique({
          where: { id: draft.productId },
          include: { category: true, panel: true },
        });
  if (
    service === null ||
    product === null ||
    product.id !== draft.productId ||
    !isExtraTimePackageValid(product, service, user.group)
  ) {
    return { result: { ok: false, error: DRAFT_STALE_TEXT }, service: null };
  }

  const originalPriceToman = product.priceToman;
  let discountAmountToman = 0;
  let discountCodeId: string | null = null;
  if (draft.discountCode !== undefined) {
    // Extra time counts as a PURCHASE for discount semantics (Phase 17).
    const validation = await validateDiscountCode(draft.discountCode, user, originalPriceToman);
    if (!validation.ok) {
      return { result: { ok: false, error: DISCOUNT_CHANGED_TEXT }, service };
    }
    discountAmountToman = validation.discountAmountToman;
    discountCodeId = validation.discountCode.id;
  }
  const finalPriceToman = Math.max(0, originalPriceToman - discountAmountToman);
  if (finalPriceToman <= 0) {
    return { result: { ok: false, error: "امکان پرداخت بدون مبلغ وجود ندارد." }, service };
  }
  if (user.balanceToman < finalPriceToman) {
    return { result: { ok: false, error: INSUFFICIENT_BALANCE_TEXT }, service };
  }

  const snapshot = buildExtraTimeSnapshot(product, service, {
    ...draft,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
  });
  const result = await executeWalletOrderPayment(user, {
    orderType: OrderType.EXTRA_TIME,
    product,
    serviceId: service.id,
    snapshot,
    originalPriceToman,
    discountAmountToman,
    finalPriceToman,
    discountCodeId,
    idempotencyKey: `wallet:${user.id}:extra-time:${draft.draftNonce}`,
  });
  return { result, service };
}

// --- wallet auto-renewal (Phase 1) -------------------------------------------

export type AutoRenewalWalletOutcome =
  | { status: "settled"; result: Extract<WalletPaymentResult, { ok: true }> }
  | { status: "already-settled"; result: Extract<WalletPaymentResult, { ok: true }> }
  | { status: "insufficient-balance" }
  | { status: "price-above-limit"; livePriceToman: number }
  | { status: "plan-invalid" }
  | { status: "wallet-disabled" }
  | { status: "error"; error: string };

export interface AutoRenewalWalletInput {
  /** The renewal product, reloaded with relations (category + panel). */
  product: ProductWithRelations;
  /** The target Service, reloaded and owner-verified by the caller. */
  service: Service;
  /** The user-approved wallet-charge ceiling (Toman) — enforced HERE. */
  authorizedMaximumChargeToman: number;
  /** Stable mandate+cycle idempotency key — the same attempt never deducts twice. */
  idempotencyKey: string;
}

/**
 * Wallet-funds an auto-renewal by REUSING the one atomic wallet-order settlement
 * (executeWalletOrderPayment) — no second implementation, no copied transaction.
 * Version-1 policy: the current NORMAL product price, NO discount code. The price
 * ceiling is re-enforced INSIDE this financial path (defense in depth): a live
 * price above the authorized maximum yields NO charge (price-above-limit), and a
 * live price at/under the ceiling charges the live (possibly lower) price. The
 * stable idempotency key (mandate+cycle) makes the same attempt idempotent across
 * worker restarts. Returns a structured outcome the execute engine maps to
 * attempt state + notifications. Never charges above the ceiling; never overdraws.
 */
export async function payAutoRenewalWithWallet(
  user: User,
  input: AutoRenewalWalletInput,
): Promise<AutoRenewalWalletOutcome> {
  const { product, service } = input;
  // Re-validate the plan against the live Product/Service/group (the mandate's
  // stored product is never trusted here).
  if (!isRenewalPlanValid(product, service, user.group)) {
    return { status: "plan-invalid" };
  }
  const charge = resolveAutoRenewalCharge(product.priceToman, input.authorizedMaximumChargeToman);
  if (charge.reason === "price-above-limit") {
    return { status: "price-above-limit", livePriceToman: product.priceToman };
  }
  if (!charge.eligible) {
    return { status: "error", error: "invalid renewal price" };
  }
  if (!(await isWalletPaymentEnabled())) {
    return { status: "wallet-disabled" };
  }

  const finalPriceToman = charge.chargeToman;
  const snapshot = buildRenewalSnapshot(product, service, {
    serviceId: service.id,
    productId: product.id,
    panelId: product.panelId ?? service.panelId,
    categoryId: product.categoryId,
    originalPriceToman: finalPriceToman,
    discountAmountToman: 0,
    finalPriceToman,
  });

  const result = await executeWalletOrderPayment(user, {
    orderType: OrderType.SERVICE_RENEWAL,
    product,
    serviceId: service.id,
    snapshot,
    originalPriceToman: finalPriceToman,
    discountAmountToman: 0,
    finalPriceToman,
    discountCodeId: null,
    idempotencyKey: input.idempotencyKey,
  });

  if (result.ok) {
    return { status: result.alreadyPaid ? "already-settled" : "settled", result };
  }
  // After the plan + price + wallet-enabled gates above, the only remaining
  // failure of the (no-discount) settlement is insufficient balance.
  return { status: "insufficient-balance" };
}
