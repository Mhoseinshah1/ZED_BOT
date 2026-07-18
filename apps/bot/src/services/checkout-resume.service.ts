import {
  CheckoutStatus,
  FinancialReconciliationStatus,
  prisma,
  type CheckoutSession,
} from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { ccb } from "../handlers/user-checkout/checkout-cb.js";
import { showPaymentMethods } from "../handlers/user-checkout/payment.handler.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";
import { checkoutShortId, getOwnedCheckout } from "./checkout.service.js";
import { getPendingReviewPayment } from "./payment-method.service.js";

// =============================================================================
// Checkout resume (Phase 2). The ONE safe entry a reminder/callback uses to
// navigate a user BACK into an existing checkout. It NEVER settles a Payment,
// creates an Order, spends the wallet, approves a receipt, reserves inventory
// or mutates the frozen snapshot: it only re-loads the LIVE financial state
// (owner-scoped) and, when - and only when - the checkout is still genuinely
// resumable, hands off to the existing method-selection surface
// (showPaymentMethods). Every non-resumable state maps to a safe Persian
// message + a keyboard that leads somewhere real, never a dead button and never
// a hint that a foreign checkout exists.
// =============================================================================

export type ResumeResult =
  | "RESUMABLE"
  | "ALREADY_SETTLED"
  | "EXPIRED"
  | "CANCELLED"
  | "PENDING_RECEIPT_REVIEW"
  | "RECONCILIATION_REQUIRED"
  | "PRODUCT_UNAVAILABLE"
  | "NOT_FOUND"
  | "NOT_OWNER";

export interface ResolvedResume {
  result: ResumeResult;
  checkout: CheckoutSession | null;
}

const NOT_VALID_TEXT = "این اعلان دیگر معتبر نیست.";
const ALREADY_SETTLED_TEXT = "این سفارش قبلاً پرداخت شده است.";
const PENDING_RECEIPT_TEXT = "رسید شما ثبت شده و در انتظار بررسی است.";
const NOT_RESUMABLE_TEXT = "این سفارش دیگر قابل ادامه نیست. لطفاً خرید جدیدی ثبت کنید.";
const RECONCILIATION_TEXT = "پرداخت این سفارش در حال بررسی است. لطفاً با پشتیبانی در تماس باشید.";

/**
 * Resolves whether a checkout can be safely resumed, reading ONLY live
 * authoritative rows (never the notification snapshot). Owner-scoped: a missing
 * checkout returns NOT_FOUND and a foreign one NOT_OWNER, both indistinguishable
 * to the user. RESUMABLE requires ALL of: status PENDING, no settlement, no
 * Order, no pending-review receipt, no open/in-review reconciliation case, and a
 * future expiry. Read-only - this function performs no writes.
 */
export async function resolveResumableCheckout(
  checkoutId: string,
  userId: string,
): Promise<ResolvedResume> {
  const checkout = await getOwnedCheckout(checkoutId, userId);
  if (checkout === null) {
    // Cheap, non-revealing owner check: distinguish "gone" from "not mine"
    // without leaking either to the user (both render the same safe message).
    const foreign = await prisma.checkoutSession.findUnique({
      where: { id: checkoutId },
      select: { id: true },
    });
    return { result: foreign === null ? "NOT_FOUND" : "NOT_OWNER", checkout: null };
  }

  const now = Date.now();
  const [pendingReview, order, reconciliation] = await Promise.all([
    getPendingReviewPayment(checkout.id),
    prisma.order.findFirst({ where: { checkoutSessionId: checkout.id }, select: { id: true } }),
    prisma.financialReconciliationCase.findFirst({
      where: {
        checkoutSessionId: checkout.id,
        status: {
          in: [FinancialReconciliationStatus.OPEN, FinancialReconciliationStatus.IN_REVIEW],
        },
      },
      select: { id: true },
    }),
  ]);

  // Precedence (most cautious first). A checkout under manual financial review
  // must send the user to support, never back into payment.
  if (reconciliation !== null) {
    return { result: "RECONCILIATION_REQUIRED", checkout };
  }
  if (pendingReview !== null) {
    return { result: "PENDING_RECEIPT_REVIEW", checkout };
  }
  if (checkout.settledByPaymentId !== null || order !== null) {
    return { result: "ALREADY_SETTLED", checkout };
  }
  if (checkout.status === CheckoutStatus.PAID || checkout.status === CheckoutStatus.COMPLETED) {
    return { result: "ALREADY_SETTLED", checkout };
  }
  if (
    checkout.status === CheckoutStatus.CANCELLED ||
    checkout.status === CheckoutStatus.FAILED_REFUNDED
  ) {
    return { result: "CANCELLED", checkout };
  }
  if (checkout.status === CheckoutStatus.EXPIRED || checkout.expiresAt.getTime() <= now) {
    return { result: "EXPIRED", checkout };
  }
  if (checkout.status !== CheckoutStatus.PENDING) {
    // Defensive: any unexpected non-PENDING status is treated as settled/closed.
    return { result: "ALREADY_SETTLED", checkout };
  }
  return { result: "RESUMABLE", checkout };
}

function ordersKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("مشاهده سفارش‌های من", CB.USER_ORDERS);
}

/**
 * Safely resumes a checkout for the acting user. On RESUMABLE it hands off to the
 * existing method-selection surface (showPaymentMethods, which itself re-checks
 * PENDING/expiry/pending-review and renders the "no active method" fallback), so
 * NO new checkout is ever created and the frozen snapshot is never mutated. Every
 * other state renders a safe Persian message + a keyboard that goes somewhere
 * real.
 */
export async function resumeCheckoutForUser(ctx: BotContext, checkoutId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const { result, checkout } = await resolveResumableCheckout(checkoutId, user.id);

  if (result === "RESUMABLE" && checkout !== null) {
    await safeAnswerCallback(ctx);
    // showPaymentMethods owns the empty-method fallback and the PENDING/expiry/
    // pending-review re-checks, so no extra branching is needed here.
    await showPaymentMethods(ctx, checkout, { created: false });
    return;
  }

  if (result === "NOT_OWNER") {
    // Same safe answer as an unknown notification (no existence reveal): a toast,
    // NOT a message edit - the original message + its buttons stay untouched.
    await safeAnswerCallback(ctx, NOT_VALID_TEXT);
    return;
  }

  await safeAnswerCallback(ctx);
  const sid = checkout === null ? "" : checkoutShortId(checkout);
  switch (result) {
    case "ALREADY_SETTLED":
      await safeEditOrReply(ctx, ALREADY_SETTLED_TEXT, ordersKeyboard());
      return;
    case "PENDING_RECEIPT_REVIEW":
      await safeEditOrReply(
        ctx,
        PENDING_RECEIPT_TEXT,
        new InlineKeyboard().text("مشاهده وضعیت سفارش", ccb.viewCheckout(sid)),
      );
      return;
    case "RECONCILIATION_REQUIRED":
      await safeEditOrReply(
        ctx,
        RECONCILIATION_TEXT,
        new InlineKeyboard().text("پشتیبانی", CB.USER_SUPPORT),
      );
      return;
    case "EXPIRED":
    case "CANCELLED":
    case "NOT_FOUND":
    case "PRODUCT_UNAVAILABLE":
    default:
      await safeEditOrReply(
        ctx,
        NOT_RESUMABLE_TEXT,
        new InlineKeyboard()
          .text("مشاهده پلن‌ها", CB.USER_BUY)
          .row()
          .text("مشاهده سفارش‌های من", CB.USER_ORDERS)
          .row()
          .text("بازگشت به منوی اصلی", CB.USER_MENU),
      );
      return;
  }
}
