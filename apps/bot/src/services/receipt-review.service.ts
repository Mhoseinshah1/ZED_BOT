import {
  CheckoutStatus,
  OrderStatus,
  OrderType,
  PaymentPurpose,
  PaymentStatus,
  prisma,
  type Admin,
  type CheckoutSession,
  type ManualReceipt,
  type Order,
  type Payment,
  type User,
} from "@zedbot/database";

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
const SUBMITTED_AFTER_EXPIRY = "رسید بعد از انقضای پیش‌فاکتور ثبت شده و قابل تایید نیست.";
export const REASON_LENGTH_ERROR = "دلیل رد باید بین ۱ تا ۱۰۰۰ کاراکتر باشد.";

export type PaymentForReview = Payment & {
  user: User;
  checkoutSession: CheckoutSession | null;
  receipts: ManualReceipt[];
};

export type ApproveReceiptResult =
  | { ok: true; payment: Payment; order: Order; user: User; orderType: OrderType; message: string }
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
    where: { id: paymentId, purpose: PaymentPurpose.ORDER_PAYMENT },
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

/** Order type for a checkout: the stored orderType, else derived from the snapshot. */
function resolveOrderType(
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
    return "رسید پرداخت شما تایید شد ✅\n\nسفارش محصول شما ثبت شد و در انتظار مرحله تحویل است.";
  }
  return (
    "رسید پرداخت شما تایید شد ✅\n\n" +
    "سفارش شما ثبت شد و در مرحله آماده‌سازی قرار گرفت.\n" +
    "ساخت سرویس در مرحله بعدی فعال می‌شود."
  );
}

/** Customer-facing rejection notice carrying the admin's exact reason. */
export function rejectionUserNotice(reason: string): string {
  return (
    "رسید پرداخت شما رد شد ❌\n\n" +
    `دلیل رد:\n${reason}\n\n` +
    "لطفاً در صورت نیاز دوباره پرداخت را انجام دهید یا با پشتیبانی تماس بگیرید."
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
  const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
  const orderType = resolveOrderType(checkout, snapshot);

  try {
    const order = await prisma.$transaction(async (tx) => {
      // Compare-and-set: only the first click flips PENDING_REVIEW -> APPROVED.
      const flipped = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING_REVIEW },
        data: {
          status: PaymentStatus.APPROVED,
          paidAt: now,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
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

      const checkoutFlipped = await tx.checkoutSession.updateMany({
        where: { id: checkout.id, status: CheckoutStatus.PENDING },
        data: { status: CheckoutStatus.PAID, paidAt: now },
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

      // Discount finalization: at most one usage row per checkout.
      if (checkout.discountCodeId !== null && checkout.discountAmountToman > 0) {
        const usage = await tx.discountCodeUsage.findFirst({
          where: { checkoutSessionId: checkout.id },
        });
        if (usage === null) {
          await tx.discountCodeUsage.create({
            data: {
              discountCodeId: checkout.discountCodeId,
              userId: checkout.userId,
              orderId: order.id,
              checkoutSessionId: checkout.id,
              amountToman: checkout.discountAmountToman,
            },
          });
          await tx.discountCode.update({
            where: { id: checkout.discountCodeId },
            data: { totalUsedCount: { increment: 1 } },
          });
        }
      }

      return order;
    });

    return {
      ok: true,
      payment,
      order,
      user: payment.user,
      orderType,
      message: "رسید تایید شد ✅\n\nOrder ساخته شد.\nساخت سرویس/تحویل در فاز بعدی انجام می‌شود.",
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

  return {
    ok: true,
    payment,
    user: payment.user,
    reason,
    message: "رسید رد شد ❌\nدلیل برای کاربر ارسال شد.",
  };
}
