import {
  CheckoutStatus,
  OrderStatus,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  prisma,
  WalletTransactionSource,
  UserStatus,
  WalletTransactionType,
  type CheckoutSession,
  type Order,
  type OrderType,
  type Payment,
  type WalletTransaction,
} from "@zedbot/database";
import { createHash } from "node:crypto";

import { checkoutExpiryMinutes } from "./checkout.js";
import { claimDiscountUsage } from "./discount.js";
import { onWalletBalanceChanged } from "./low-balance.js";

// =============================================================================
// The one atomic wallet settlement, for both transports.
//
// THIS IS THE BOT'S TRANSACTION. Not a reimplementation of it — the same
// statements in the same order, lifted out of
// `apps/bot/src/services/wallet-payment.service.ts` so the Mini App API can call
// it instead of growing a second one. Money is the worst possible thing to have
// two implementations of: they agree until someone edits one, and the
// disagreement is discovered as a balance that does not match its ledger.
//
// WHAT IS LOAD-BEARING ABOUT THE ORDER OF THESE STATEMENTS:
//
//   1. THE REPLAY LOOKUP COMES FIRST, before the wallet kill switch and before
//      anything reads a balance or a price. A retry of a settled payment must
//      keep returning its original result even after the operator disabled the
//      feature, after the price changed and after the balance moved — otherwise
//      a user whose network dropped mid-confirmation is told their completed
//      purchase failed, and clicks again.
//
//   2. THE DEDUCTION IS A CONDITIONAL UPDATE, never a read-then-write.
//      `updateMany` filtered on `balanceToman >= amount` is re-evaluated by
//      PostgreSQL against the committed row under its lock, so two DIFFERENT
//      confirmations racing on one wallet cannot both spend a balance that only
//      covers one. Zero rows matched means insufficient funds and rolls the
//      whole transaction back. A negative balance is unreachable.
//
//   3. THE DEDUCTION IS PLACED AFTER `payment.create`. A concurrent duplicate
//      carrying the SAME idempotency key blocks on the unique index first and
//      resolves through the P2002 path without ever touching the balance. That
//      is what makes "one financial effect per intent" true under concurrency
//      rather than merely likely.
//
//   4. THE DISCOUNT IS CLAIMED INSIDE THIS TRANSACTION, under a row lock, and a
//      failed claim aborts everything. The pre-payment validation is UX and is
//      never trusted here, so a discounted price cannot settle without its
//      claimed usage.
//
// NO PERSIAN. The bot maps these codes back to the exact sentences it printed
// before the move; the Mini App maps them to its own i18n.
// =============================================================================

/** Reason code for a settlement that did not happen. A closed set. */
export type WalletSettlementFailure =
  | "INVALID_FINANCIAL_INPUT"
  | "USER_NOT_ACTIVE"
  | "WALLET_DISABLED"
  | "DRAFT_STALE"
  | "RESERVATION_STALE"
  | "INSUFFICIENT_BALANCE"
  | "DISCOUNT_CHANGED"
  | "IDEMPOTENCY_CONFLICT";

export interface WalletSettlementSuccess {
  ok: true;
  order: Order;
  payment: Payment;
  checkout: CheckoutSession;
  walletTransaction: WalletTransaction;
  newBalanceToman: number;
  /** True when this call returned an ALREADY-settled result rather than settling. */
  alreadyPaid: boolean;
}

export type WalletSettlementResult =
  | WalletSettlementSuccess
  | { ok: false; code: WalletSettlementFailure };

/** Thrown inside the transaction to abort with a code. */
class SettlementAbort extends Error {
  constructor(readonly code: WalletSettlementFailure) {
    super(`wallet settlement aborted: ${code}`);
    this.name = "SettlementAbort";
  }
}

export const WALLET_ORDER_PAYMENT_REASON = "WALLET_ORDER_PAYMENT";

function snapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function snapshotInt(snapshot: Record<string, unknown>, key: string): number | null {
  const value = snapshot[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Validate every monetary value at the settlement boundary.
 *
 * Callers normally obtain these values from a frozen checkout, but this is the
 * final authority before durable financial effects.  JavaScript numbers also
 * permit fractions, infinities and unsafe integers that PostgreSQL's integer
 * columns cannot represent faithfully, so none of those may reach Prisma.
 */
function hasValidFinancialInvariant(args: WalletSettlementArgs): boolean {
  const snapshot = args.snapshot as Record<string, unknown>;
  const original = args.originalPriceToman;
  const discount = args.discountAmountToman;
  const final = args.finalPriceToman;

  if (
    !Number.isSafeInteger(original) ||
    !Number.isSafeInteger(discount) ||
    !Number.isSafeInteger(final) ||
    original <= 0 ||
    discount < 0 ||
    final <= 0 ||
    discount > original ||
    original - discount !== final
  ) {
    return false;
  }

  return (
    snapshotInt(snapshot, "originalPriceToman") === original &&
    snapshotInt(snapshot, "discountAmountToman") === discount &&
    snapshotInt(snapshot, "finalPriceToman") === final
  );
}

function snapshotIntArray(snapshot: Record<string, unknown>, key: string): number[] | null {
  const value = snapshot[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  return ids.length > 0 ? ids : null;
}

/**
 * The digest of everything an idempotency key promises.
 *
 * An idempotency key means "this exact request, again". Without binding it to
 * the request's content, a client could reuse a key for a DIFFERENT purchase and
 * be handed the first purchase's result — silently getting the wrong thing, or
 * being told a purchase succeeded that never happened. The digest makes
 * "different payload, same key" detectable, and it is stored rather than
 * recomputed because the original request is gone by then.
 *
 * It covers what the money depends on. The snapshot is excluded on purpose: it
 * is derived from the product and service ids and the prices already listed
 * here, and including a JSON blob whose key order is not guaranteed would make
 * an honest retry look like a conflict.
 */
export function settlementPayloadFingerprint(input: {
  userId: string;
  orderType: OrderType;
  productId: string;
  serviceId: string | null;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCodeId: string | null;
  existingCheckoutId?: string;
}): string {
  const parts = [
    input.userId,
    input.orderType,
    input.productId,
    input.serviceId ?? "-",
    String(input.originalPriceToman),
    String(input.discountAmountToman),
    String(input.finalPriceToman),
    input.discountCodeId ?? "-",
    input.existingCheckoutId ?? "-",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

export interface WalletSettlementArgs {
  userId: string;
  orderType: OrderType;
  productId: string;
  serviceId: string | null;
  snapshot: Prisma.InputJsonObject;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCodeId: string | null;
  idempotencyKey: string;
  /**
   * The wallet kill switch, supplied by the caller rather than read here.
   *
   * The bot reads it through its 30-second settings cache and the Mini App reads
   * it fresh; both are correct for their surface and neither should be forced on
   * the other by this function. Checked AFTER the replay lookup, so a settled
   * payment still returns its result while the switch is off.
   */
  isWalletEnabled: () => Promise<boolean>;
  /**
   * Settle an EXISTING PENDING checkout instead of creating a fresh PAID one.
   * Used by the bot's personalized OTHER_PRODUCT path.
   */
  existingCheckoutId?: string;
  /** Extra gate for the existing-checkout path (the bot's customer-info form). */
  isExistingCheckoutSettleable?: (checkoutId: string) => Promise<boolean>;
  /** Frozen fulfillment snapshot for a newly-created OTHER_PRODUCT checkout. */
  otherProductFulfillmentSnapshot?: Prisma.InputJsonObject;
  /**
   * Claim and bind a username reservation inside this transaction.
   *
   * Returns false to abort the whole settlement with RESERVATION_STALE — zero
   * deduction, no order, no reservation corruption. Placed BEFORE the balance
   * deduction so a stale hold never costs the buyer money.
   */
  claimReservation?: (
    tx: Prisma.TransactionClient,
    checkoutId: string,
    orderId: string,
    now: Date,
  ) => Promise<boolean>;
}

/** Loads the settled result of a previously-executed idempotency key. */
async function loadExistingSettlement(
  idempotencyKey: string,
): Promise<{ result: WalletSettlementSuccess; fingerprint: string | null } | null> {
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
    result: {
      ok: true,
      order,
      payment,
      checkout,
      walletTransaction,
      newBalanceToman: walletTransaction.balanceAfterToman,
      alreadyPaid: true,
    },
    fingerprint: storedFingerprint(payment),
  };
}

/**
 * The fingerprint recorded alongside the payment method.
 *
 * Stored inside the existing `callbackPayload` JSON rather than in a new column,
 * because the column would be a migration for a value only this path reads. A
 * payment written before this existed has no fingerprint, and `null` is treated
 * as "cannot compare" rather than as "conflict" — an old retry must not start
 * failing because the server learned a new trick.
 */
function storedFingerprint(payment: Payment): string | null {
  const payload = payment.callbackPayload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).payloadFingerprint;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Settles one wallet payment, atomically and exactly once.
 *
 * Returns `alreadyPaid: true` when the idempotency key had already settled.
 */
export async function settleWalletOrder(
  args: WalletSettlementArgs,
): Promise<WalletSettlementResult> {
  // Reject malformed or internally inconsistent money before a database read,
  // feature callback or transaction. The settlement boundary never trusts a
  // transport merely because it usually supplies a server-authored checkout.
  if (!hasValidFinancialInvariant(args)) {
    return { ok: false, code: "INVALID_FINANCIAL_INPUT" };
  }

  const fingerprint = settlementPayloadFingerprint({
    userId: args.userId,
    orderType: args.orderType,
    productId: args.productId,
    serviceId: args.serviceId,
    originalPriceToman: args.originalPriceToman,
    discountAmountToman: args.discountAmountToman,
    finalPriceToman: args.finalPriceToman,
    discountCodeId: args.discountCodeId,
    ...(args.existingCheckoutId !== undefined
      ? { existingCheckoutId: args.existingCheckoutId }
      : {}),
  });

  // (1) REPLAY FIRST. Before the kill switch, before any price, before any
  //     balance. See the file header.
  const existing = await loadExistingSettlement(args.idempotencyKey);
  if (existing !== null) {
    if (existing.fingerprint !== null && existing.fingerprint !== fingerprint) {
      // Same key, different request. Returning the first result would hand the
      // caller someone else's purchase; settling would charge twice for one key.
      return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
    }
    return existing.result;
  }

  if (!(await args.isWalletEnabled())) {
    return { ok: false, code: "WALLET_DISABLED" };
  }
  if (
    args.existingCheckoutId !== undefined &&
    args.isExistingCheckoutSettleable !== undefined &&
    !(await args.isExistingCheckoutSettleable(args.existingCheckoutId))
  ) {
    return { ok: false, code: "DRAFT_STALE" };
  }

  const minutes = await checkoutExpiryMinutes();
  const now = new Date();
  const snapshotRecord = args.snapshot as Record<string, unknown>;

  try {
    const result = await prisma.$transaction(async (tx) => {
      let checkout: CheckoutSession;
      if (args.existingCheckoutId !== undefined) {
        // CAS under a strict identity + price guard; anything unexpected aborts
        // the whole payment (fail closed — no deduction, no order).
        const flipped = await tx.checkoutSession.updateMany({
          where: {
            id: args.existingCheckoutId,
            userId: args.userId,
            purpose: "ORDER_PAYMENT",
            orderType: args.orderType,
            productId: args.productId,
            finalPriceToman: args.finalPriceToman,
            status: CheckoutStatus.PENDING,
            settledByPaymentId: null,
            expiresAt: { gt: now },
          },
          data: { status: CheckoutStatus.PAID, paidAt: now },
        });
        if (flipped.count !== 1) {
          throw new SettlementAbort("DRAFT_STALE");
        }
        checkout = await tx.checkoutSession.findUniqueOrThrow({
          where: { id: args.existingCheckoutId },
        });
      } else {
        checkout = await tx.checkoutSession.create({
          data: {
            userId: args.userId,
            purpose: "ORDER_PAYMENT",
            productId: args.productId,
            serviceId: args.serviceId,
            orderType: args.orderType,
            productSnapshot: args.snapshot,
            ...(args.otherProductFulfillmentSnapshot !== undefined
              ? { otherProductFulfillmentSnapshot: args.otherProductFulfillmentSnapshot }
              : {}),
            originalPriceToman: args.originalPriceToman,
            discountAmountToman: args.discountAmountToman,
            finalPriceToman: args.finalPriceToman,
            discountCodeId: args.discountCodeId,
            status: CheckoutStatus.PAID,
            paidAt: now,
            expiresAt: new Date(now.getTime() + minutes * 60_000),
          },
        });
      }

      const payment = await tx.payment.create({
        data: {
          userId: args.userId,
          checkoutSessionId: checkout.id,
          purpose: PaymentPurpose.PAY_WITH_WALLET,
          status: PaymentStatus.APPROVED,
          amountToman: args.finalPriceToman,
          payableAmountToman: args.finalPriceToman,
          paidAt: now,
          // The method marker the bot has always written, plus the digest that
          // makes "same key, different payload" detectable on a later retry.
          callbackPayload: { method: "WALLET", payloadFingerprint: fingerprint },
          idempotencyKey: args.idempotencyKey,
          settlementStatus: "SETTLED",
          settledAt: now,
        },
      });
      // Record the settlement OWNER — a later gateway success against this
      // checkout is a duplicate, never a re-settle.
      await tx.checkoutSession.update({
        where: { id: checkout.id },
        data: { settledByPaymentId: payment.id },
      });

      const order = await tx.order.create({
        data: {
          userId: args.userId,
          checkoutSessionId: checkout.id,
          type: args.orderType,
          status: OrderStatus.PAID,
          productId: args.productId,
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
          serviceNoteSnapshot: snapshotString(snapshotRecord, "serviceUserNote"),
          paidAt: now,
        },
      });

      // THE PAYER MUST STILL BE ACTIVE, checked here rather than only upstream.
      // The bot blocks a non-ACTIVE user in middleware long before this and the
      // Mini App re-evaluates access on every request, so this is defence in
      // depth — but "the transport checked it" is not a property this
      // transaction can verify, and a suspended account must not be able to
      // spend on any path. Read inside the transaction so a block committed a
      // moment ago is already visible.
      const payer = await tx.user.findUnique({
        where: { id: args.userId },
        select: { status: true },
      });
      if (payer === null || payer.status !== UserStatus.ACTIVE) {
        throw new SettlementAbort("USER_NOT_ACTIVE");
      }

      // Placed BEFORE the deduction so a stale hold never costs the buyer money.
      if (args.claimReservation !== undefined) {
        const claimed = await args.claimReservation(tx, checkout.id, order.id, now);
        if (!claimed) {
          throw new SettlementAbort("RESERVATION_STALE");
        }
      }

      const settledPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { orderId: order.id },
      });

      // (2) and (3): the atomic check-and-deduct. See the file header.
      const deducted = await tx.user.updateMany({
        where: { id: args.userId, balanceToman: { gte: args.finalPriceToman } },
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
        throw new SettlementAbort("INSUFFICIENT_BALANCE");
      }
      // Exact ledger values from the row we just updated (still locked by this
      // transaction, so no other spend can interleave).
      const updatedUser = await tx.user.findUniqueOrThrow({
        where: { id: args.userId },
        select: { balanceToman: true },
      });
      const balanceAfter = updatedUser.balanceToman;
      const balanceBefore = balanceAfter + args.finalPriceToman;
      const walletTransaction = await tx.walletTransaction.create({
        data: {
          userId: args.userId,
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

      // Same transaction, committed balance, no I/O. Every wallet path in this
      // system funnels through here; a settlement that skipped it would be the
      // first one that does not.
      await onWalletBalanceChanged(tx, {
        userId: args.userId,
        balanceBeforeToman: balanceBefore,
        balanceAfterToman: balanceAfter,
        source: "ORDER",
      });

      // (4): the discount is claimed under a row lock and a failed claim aborts
      // the WHOLE payment.
      if (args.discountCodeId !== null && args.discountAmountToman > 0) {
        const claim = await claimDiscountUsage(tx, {
          discountCodeId: args.discountCodeId,
          userId: args.userId,
          orderId: order.id,
          checkoutSessionId: checkout.id,
          amountToman: args.discountAmountToman,
        });
        if (!claim.ok) {
          throw new SettlementAbort("DISCOUNT_CHANGED");
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
    return { ok: true, ...result, alreadyPaid: false };
  } catch (err) {
    if (err instanceof SettlementAbort) {
      return { ok: false, code: err.code };
    }
    // A concurrent duplicate carrying the same key won the unique index. Return
    // ITS settled result rather than failing — the loser of the race performed
    // the same intent and must see the same outcome.
    //
    // The lookup runs OUTSIDE the aborted transaction (this catch is outside
    // `$transaction`), which is the only way it can work: PostgreSQL marks an
    // aborted transaction unusable, so a query issued inside it would fail with
    // 25P02 rather than reading anything.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const settled = await loadExistingSettlement(args.idempotencyKey);
      if (settled !== null) {
        if (settled.fingerprint !== null && settled.fingerprint !== fingerprint) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        return settled.result;
      }
    }
    throw err;
  }
}
