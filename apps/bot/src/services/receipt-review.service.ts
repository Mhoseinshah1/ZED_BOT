import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PaymentPurpose,
  PaymentStatus,
  prisma,
  WalletTransactionSource,
  WalletTransactionType,
  type Admin,
  type CheckoutSession,
  type ManualReceipt,
  type Order,
  type Payment,
  type User,
  type WalletTransaction,
} from "@zedbot/database";

import { claimDiscountUsage } from "./discount.service.js";
import { auditRepresentativeSettlementPricing } from "./representative-pricing.service.js";
import {
  bindSettledReservationFromSnapshot,
  lockReservationForSettlement,
} from "./service-username-selection.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";
import { WALLET_TOPUP_REASON } from "./wallet-topup.service.js";

// =============================================================================
// Receipt review (Phase 8): approve / reject PENDING_REVIEW card-to-card
// payments.
//
// Approval, in ONE transaction: Payment -> APPROVED, ManualReceipt(s) ->
// APPROVED, CheckoutSession -> PAID, one PAID Order (never a duplicate per
// checkout), discount usage finalized idempotently. Nothing else: no Service,
// no panel call, no wallet deduction, no config/link, no OtherProductOrder -
// provisioning/delivery picks up PAID orders in Phase 9.
//
// Rejection: Payment/ManualReceipt -> REJECTED with the admin's reason; the
// checkout stays PENDING while unexpired (the user may pay again) and is only
// flipped to EXPIRED when its deadline has already passed. No Order, no
// discount finalization.
//
// Both paths are double-click safe: the status flip is a compare-and-set
// (updateMany filtered on PENDING_REVIEW) inside the transaction.
// =============================================================================

export const REJECT_REASON_MAX = 1000;

const NOT_FOUND = "مورد یافت نشد.";
const ALREADY_REVIEWED = "این رسید قبلاً بررسی شده است.";
const NO_CHECKOUT = "پیش‌فاکتور این پرداخت یافت نشد؛ رسید قابل تایید نیست.";
const CHECKOUT_NOT_PENDING = "وضعیت پیش‌فاکتور برای تایید معتبر نیست.";
const AMOUNT_MISMATCH = "مبلغ رسید با پیش‌فاکتور هم‌خوانی ندارد.";
const NO_PENDING_RECEIPT = "رسید در انتظار بررسی برای این پرداخت وجود ندارد.";
const DISCOUNT_CLAIM_FAILED_ADMIN =
  "کد تخفیف این پرداخت دیگر معتبر نیست (سقف استفاده تکمیل یا منقضی شده است). تایید انجام نشد؛ در صورت نیاز رسید را رد کنید.";
const SUBMITTED_AFTER_EXPIRY = "رسید بعد از انقضای پیش‌فاکتور ثبت شده و قابل تایید نیست.";
export const REASON_LENGTH_ERROR = "دلیل رد باید بین ۱ تا ۱۰۰۰ کاراکتر باشد.";

export type PaymentForReview = Payment & {
  user: User;
  checkoutSession: CheckoutSession | null;
  receipts: ManualReceipt[];
};

export type ApproveReceiptResult =
  | {
      ok: true;
      kind: "ORDER_PAYMENT";
      payment: Payment;
      order: Order;
      user: User;
      orderType: OrderType;
      message: string;
    }
  | {
      ok: true;
      kind: "WALLET_TOPUP";
      payment: Payment;
      user: User;
      walletTransaction: WalletTransaction;
      amountToman: number;
      newBalanceToman: number;
      message: string;
    }
  | { ok: false; error: string };

export type RejectReceiptResult =
  | { ok: true; payment: Payment; user: User; reason: string; message: string }
  | { ok: false; error: string };

/**
 * Thrown inside the transaction when a re-checked condition no longer holds
 * (compare-and-set lost a race, checkout left PENDING, receipt vanished).
 * Rolls everything back and surfaces `userError` as the safe admin message.
 */
class ReviewAbortError extends Error {
  constructor(readonly userError: string) {
    super("review aborted: precondition no longer holds");
  }
}

async function loadReviewPayment(paymentId: string): Promise<PaymentForReview | null> {
  return prisma.payment.findFirst({
    where: {
      id: paymentId,
      // Reviewable purposes: orders (Phase 8) and wallet top-ups (Phase 14).
      purpose: { in: [PaymentPurpose.ORDER_PAYMENT, PaymentPurpose.WALLET_CHARGE] },
    },
    include: { user: true, checkoutSession: true, receipts: true },
  });
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

/**
 * Order type for a checkout: the stored orderType, else derived from the
 * snapshot. Exported so the gateway settlement (gateway-payment.service)
 * resolves order types exactly like the receipt approval path.
 */
export function resolveOrderType(
  checkout: CheckoutSession,
  snapshot: Record<string, unknown>,
): OrderType {
  if (checkout.orderType !== null) {
    return checkout.orderType;
  }
  return snapshot.productType === "OTHER_PRODUCT"
    ? OrderType.OTHER_PRODUCT
    : OrderType.SERVICE_PURCHASE;
}

/** Customer-facing approval notice, by what was bought. */
export function approvalUserNotice(orderType: OrderType): string {
  if (orderType === OrderType.OTHER_PRODUCT) {
    return "پرداخت شما تایید شد ✅\n\nسفارش محصول شما ثبت شد و در انتظار مرحله تحویل است.";
  }
  if (orderType === OrderType.SERVICE_RENEWAL) {
    return "پرداخت شما تایید شد ✅\n\nتمدید سرویس شما در حال انجام است.";
  }
  if (orderType === OrderType.EXTRA_VOLUME) {
    return "پرداخت شما تایید شد ✅\n\nافزایش حجم سرویس شما در حال انجام است.";
  }
  if (orderType === OrderType.EXTRA_TIME) {
    return "پرداخت شما تایید شد ✅\n\nافزایش زمان سرویس شما در حال انجام است.";
  }
  return (
    "پرداخت شما تایید شد ✅\n\n" +
    "سفارش شما ثبت شد و در مرحله آماده‌سازی قرار گرفت.\n" +
    "ساخت سرویس در مرحله بعدی فعال می‌شود."
  );
}

/** Customer-facing rejection notice carrying the admin's exact reason. */
export function rejectionUserNotice(
  reason: string,
  purpose: PaymentPurpose = PaymentPurpose.ORDER_PAYMENT,
): string {
  const head =
    purpose === PaymentPurpose.WALLET_CHARGE
      ? "پرداخت شارژ کیف پول شما رد شد."
      : "پرداخت شما رد شد.";
  return (
    `${head}\n\n` +
    `دلیل: ${reason}\n\n` +
    "لطفاً در صورت نیاز دوباره پرداخت را انجام دهید یا با پشتیبانی تماس بگیرید."
  );
}

/** Customer-facing wallet top-up success notice. */
export function walletTopupSuccessNotice(amountToman: number, newBalanceToman: number): string {
  return (
    "شارژ کیف پول شما تایید شد ✅\n\n" +
    `مبلغ شارژ: ${amountToman.toLocaleString("en-US")} تومان\n` +
    `موجودی جدید: ${newBalanceToman.toLocaleString("en-US")} تومان`
  );
}

/**
 * Approves a PENDING_REVIEW order payment. Idempotent / double-click safe:
 * a payment that is no longer PENDING_REVIEW is refused, an existing Order
 * for the checkout is returned instead of duplicated, and discount usage is
 * finalized at most once per checkout.
 *
 * Validations (Phase 8.1): checkout must still be PENDING, the payment
 * amounts must exactly match the checkout's final price, a PENDING_REVIEW
 * ManualReceipt must exist, and the payment must have been created before
 * the checkout expired (a receipt submitted in time may be approved after
 * expiry, one submitted after expiry never). The status/receipt conditions
 * are re-checked inside the transaction.
 */
export async function approveReceiptPayment(
  paymentId: string,
  admin: Admin,
): Promise<ApproveReceiptResult> {
  const payment = await loadReviewPayment(paymentId);
  if (payment === null) {
    return { ok: false, error: NOT_FOUND };
  }
  if (payment.status !== PaymentStatus.PENDING_REVIEW) {
    return { ok: false, error: ALREADY_REVIEWED };
  }
  const checkout = payment.checkoutSession;
  if (checkout === null) {
    return { ok: false, error: NO_CHECKOUT };
  }
  if (checkout.status !== CheckoutStatus.PENDING) {
    return { ok: false, error: CHECKOUT_NOT_PENDING };
  }
  if (
    payment.amountToman !== checkout.finalPriceToman ||
    payment.payableAmountToman !== checkout.finalPriceToman
  ) {
    return { ok: false, error: AMOUNT_MISMATCH };
  }
  if (!payment.receipts.some((r) => r.status === PaymentStatus.PENDING_REVIEW)) {
    return { ok: false, error: NO_PENDING_RECEIPT };
  }
  if (payment.createdAt.getTime() > checkout.expiresAt.getTime()) {
    return { ok: false, error: SUBMITTED_AFTER_EXPIRY };
  }

  const now = new Date();

  // Phase 14: wallet top-ups share every validation above but follow their
  // own approval path - balance moves, NO Order/provisioning/discount.
  if (payment.purpose === PaymentPurpose.WALLET_CHARGE) {
    return approveWalletTopup(payment, checkout, admin, now);
  }

  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  const orderType = resolveOrderType(checkout, snapshot);

  try {
    const order = await prisma.$transaction(async (tx) => {
      // hotfix §7: lock the buyer's username reservation for the WHOLE approval
      // transaction, BEFORE the checkout is flipped, so the concurrent cleanup
      // sweep (FOR UPDATE ... SKIP LOCKED) skips it and can never expire a
      // reservation that is settling. No-op when the snapshot carries no reservation.
      const settlingReservationId = snapshotString(snapshot, "serviceUsernameReservationId");
      if (settlingReservationId !== null) {
        await lockReservationForSettlement(tx, settlingReservationId);
      }
      // Compare-and-set: only the first click flips PENDING_REVIEW -> APPROVED.
      const flipped = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.APPROVED,
          paidAt: now,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
          // P0 settlement phase: the approved receipt payment owns its
          // checkout's settlement (claimed in the checkout flip below).
          settlementStatus: "SETTLED",
          settledAt: now,
        },
      });
      if (flipped.count === 0) {
        throw new ReviewAbortError(ALREADY_REVIEWED);
      }

      // Re-checks inside the transaction: both updateMany calls are filtered
      // on the state validated above; zero matches means a concurrent change
      // slipped in, so the whole approval rolls back.
      const receiptsFlipped = await tx.manualReceipt.updateMany({
        where: { paymentId: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.APPROVED,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
        },
      });
      if (receiptsFlipped.count === 0) {
        throw new ReviewAbortError(NO_PENDING_RECEIPT);
      }

      // P0 settlement phase: the approval also records the settlement OWNER
      // (settledByPaymentId) so a later gateway success on the same checkout
      // is classified as a duplicate instead of double-settling.
      const checkoutFlipped = await tx.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutStatus.PENDING, settledByPaymentId: null },
        data: { status: CheckoutStatus.PAID, paidAt: now, settledByPaymentId: payment.id },
      });
      if (checkoutFlipped.count === 0) {
        throw new ReviewAbortError(CHECKOUT_NOT_PENDING);
      }

      // One Order per checkout - a pre-existing one is reused, never duplicated.
      let order = await tx.order.findFirst({
        where: { checkoutSessionId: checkout.id },
        orderBy: { createdAt: "asc" },
      });
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
            // Service-checkout username selection: the buyer's optional note.
            serviceNoteSnapshot: snapshotString(snapshot, "serviceUserNote"),
            paidAt: now,
          },
        });
        // hotfix §6: strictly bind the buyer's username reservation to this
        // settled order (exact id + owner + checkout + panel + username in BOUND
        // state, no foreign order). EXTERNAL-SUCCESS settlement: the card receipt
        // was already approved, so a bind anomaly is recorded for reconciliation
        // (privacy-safe: ids only) instead of rolling back and losing a real
        // payment. Provisioning resolves the identity from the immutable order
        // snapshot; the username is never regenerated post-payment.
        await bindSettledReservationFromSnapshot(tx, snapshot, {
          userId: checkout.userId,
          checkoutSessionId: checkout.id,
          orderId: order.id,
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: { orderId: order.id },
        });
        // Stats only move with the (single) order creation, so a re-approval
        // race can never double-count. paidOrdersCount also unlocks gateways
        // gated by activateAfterSuccessfulPaymentsCount.
        await tx.user.update({
          where: { id: checkout.userId },
          data: {
            ordersCount: { increment: 1 },
            paidOrdersCount: { increment: 1 },
            totalPurchaseAmountToman: { increment: checkout.finalPriceToman },
          },
        });
      }

      // SECURITY-CRITICAL discount finalization: claimDiscountUsage locks
      // the DiscountCode row and re-validates active/window/total/per-user
      // limits against the committed state (the checkout-time validation is
      // UX only). Still at most one usage row per checkout. A failed claim
      // aborts the WHOLE approval - the payment stays PENDING_REVIEW so the
      // admin can reject it with a reason instead of settling a discounted
      // price whose usage could not be claimed.
      if (checkout.discountCodeId !== null && checkout.discountAmountToman > 0) {
        const claim = await claimDiscountUsage(tx, {
          discountCodeId: checkout.discountCodeId,
          userId: checkout.userId,
          orderId: order.id,
          checkoutSessionId: checkout.id,
          amountToman: checkout.discountAmountToman,
        });
        if (!claim.ok) {
          throw new ReviewAbortError(DISCOUNT_CLAIM_FAILED_ADMIN);
        }
      }

      return order;
    });

    // §16 settlement-boundary audit (card-to-card): the paid Order is already
    // authoritative and is honored as frozen; this only records a WARN marker if
    // live reseller pricing drifted after the user paid. Never blocks/mutates.
    void auditRepresentativeSettlementPricing(checkout);

    // Ops log (PAYMENT topic) - ids/amounts only, never the receipt itself.
    void writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.RECEIPT_APPROVED,
      message: "manual receipt approved",
      metadata: { amountToman: payment.amountToman, orderType },
      topicKey: "PAYMENT",
      userId: payment.userId,
      adminId: admin.id,
      paymentId: payment.id,
      orderId: order.id,
    });
    return {
      ok: true,
      kind: "ORDER_PAYMENT",
      payment,
      order,
      user: payment.user,
      orderType,
      message: "رسید تایید شد ✅\n\nسفارش ساخته شد.\nساخت سرویس/تحویل در فاز بعدی انجام می‌شود.",
    };
  } catch (err) {
    if (err instanceof ReviewAbortError) {
      return { ok: false, error: err.userError };
    }
    throw err;
  }
}

/**
 * Wallet top-up approval (Phase 14): in ONE transaction the payment/receipt
 * flip APPROVED, the checkout flips PAID, the user's balanceToman +
 * totalChargedToman increase and exactly one CHARGE WalletTransaction is
 * created (guarded by relatedPaymentId + reason, so a re-run or pathological
 * state can never double-increment). Because everything commits together,
 * an approved wallet payment always has its transaction - no partial state.
 * NO Order, NO provisioning, NO discount finalization.
 */
async function approveWalletTopup(
  payment: PaymentForReview,
  checkout: CheckoutSession,
  admin: Admin,
  now: Date,
): Promise<ApproveReceiptResult> {
  try {
    const { walletTransaction, newBalanceToman } = await prisma.$transaction(async (tx) => {
      const flipped = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentStatus.PENDING_REVIEW,
          purpose: PaymentPurpose.WALLET_CHARGE,
        },
        data: {
          status: PaymentStatus.APPROVED,
          paidAt: now,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
          // P0 settlement phase: the approved receipt payment owns its
          // checkout's settlement (claimed in the checkout flip below).
          settlementStatus: "SETTLED",
          settledAt: now,
        },
      });
      if (flipped.count === 0) {
        throw new ReviewAbortError(ALREADY_REVIEWED);
      }
      const receiptsFlipped = await tx.manualReceipt.updateMany({
        where: { paymentId: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.APPROVED,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
        },
      });
      if (receiptsFlipped.count === 0) {
        throw new ReviewAbortError(NO_PENDING_RECEIPT);
      }
      // P0 settlement phase: the approval also records the settlement OWNER
      // (settledByPaymentId) so a later gateway success on the same checkout
      // is classified as a duplicate instead of double-settling.
      const checkoutFlipped = await tx.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutStatus.PENDING, settledByPaymentId: null },
        data: { status: CheckoutStatus.PAID, paidAt: now, settledByPaymentId: payment.id },
      });
      if (checkoutFlipped.count === 0) {
        throw new ReviewAbortError(CHECKOUT_NOT_PENDING);
      }

      // Idempotency net: never a second CHARGE for the same payment.
      const existing = await tx.walletTransaction.findFirst({
        where: { relatedPaymentId: payment.id, reason: WALLET_TOPUP_REASON },
      });
      if (existing !== null) {
        return { walletTransaction: existing, newBalanceToman: existing.balanceAfterToman };
      }

      // LEDGER-CRITICAL: the increment UPDATE takes the row lock and returns
      // the post-update row, so balanceBefore/balanceAfter always describe
      // the real transition. A plain pre-read here would race a concurrent
      // spend and record a before/after pair that never existed.
      const credited = await tx.user.update({
        where: { id: payment.userId },
        data: {
          balanceToman: { increment: payment.amountToman },
          totalChargedToman: { increment: payment.amountToman },
        },
        select: { balanceToman: true },
      });
      const balanceAfter = credited.balanceToman;
      const balanceBefore = balanceAfter - payment.amountToman;
      const created = await tx.walletTransaction.create({
        data: {
          userId: payment.userId,
          amountToman: payment.amountToman,
          type: WalletTransactionType.CHARGE,
          source: WalletTransactionSource.USER_PAYMENT,
          reason: WALLET_TOPUP_REASON,
          relatedPaymentId: payment.id,
          balanceBeforeToman: balanceBefore,
          balanceAfterToman: balanceAfter,
        },
      });
      return { walletTransaction: created, newBalanceToman: balanceAfter };
    });

    // Ops log (PAYMENT topic) - amount only, never balances beyond the ledger.
    void writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.RECEIPT_APPROVED,
      message: "manual wallet top-up receipt approved",
      metadata: { amountToman: payment.amountToman, purpose: "WALLET_CHARGE" },
      topicKey: "PAYMENT",
      userId: payment.userId,
      adminId: admin.id,
      paymentId: payment.id,
    });
    return {
      ok: true,
      kind: "WALLET_TOPUP",
      payment,
      user: payment.user,
      walletTransaction,
      amountToman: payment.amountToman,
      newBalanceToman,
      message: "رسید شارژ کیف پول تایید شد ✅\nموجودی کاربر افزایش یافت.",
    };
  } catch (err) {
    if (err instanceof ReviewAbortError) {
      return { ok: false, error: err.userError };
    }
    throw err;
  }
}

/**
 * Rejects a PENDING_REVIEW order payment with the admin's reason (1..1000
 * chars). The checkout is left PENDING while unexpired so the user can try
 * another payment; an already-expired one is flipped to EXPIRED. Creates no
 * Order and finalizes no discount usage.
 */
export async function rejectReceiptPayment(
  paymentId: string,
  admin: Admin,
  reasonRaw: string,
): Promise<RejectReceiptResult> {
  const reason = reasonRaw.trim();
  if (reason.length === 0 || reason.length > REJECT_REASON_MAX) {
    return { ok: false, error: REASON_LENGTH_ERROR };
  }
  const payment = await loadReviewPayment(paymentId);
  if (payment === null) {
    return { ok: false, error: NOT_FOUND };
  }
  if (payment.status !== PaymentStatus.PENDING_REVIEW) {
    return { ok: false, error: ALREADY_REVIEWED };
  }

  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.REJECTED,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
          rejectReason: reason,
        },
      });
      if (flipped.count === 0) {
        throw new ReviewAbortError(ALREADY_REVIEWED);
      }

      await tx.manualReceipt.updateMany({
        where: { paymentId: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.REJECTED,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
          rejectReason: reason,
        },
      });

      const checkout = payment.checkoutSession;
      if (
        checkout !== null &&
        checkout.status === CheckoutStatus.PENDING &&
        checkout.expiresAt.getTime() <= now.getTime()
      ) {
        await tx.checkoutSession.update({
          where: { id: checkout.id },
          data: { status: CheckoutStatus.EXPIRED },
        });
      }
    });
  } catch (err) {
    if (err instanceof ReviewAbortError) {
      return { ok: false, error: err.userError };
    }
    throw err;
  }

  // Ops log (PAYMENT topic) - the rejection REASON is admin-authored free
  // text shown to the user, safe to persist (still scrubbed defensively).
  void writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.RECEIPT_REJECTED,
    message: "manual receipt rejected",
    metadata: { amountToman: payment.amountToman },
    topicKey: "PAYMENT",
    userId: payment.userId,
    adminId: admin.id,
    paymentId: payment.id,
  });
  return {
    ok: true,
    payment,
    user: payment.user,
    reason,
    message: "رسید رد شد ❌\nدلیل برای کاربر ارسال شد.",
  };
}
