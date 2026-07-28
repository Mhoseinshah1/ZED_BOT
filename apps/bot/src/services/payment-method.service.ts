import {
  PaymentStatus,
  prisma,
  type CardToCardAccount,
  type CheckoutSession,
  type ManualReceipt,
  type Payment,
  type PaymentGateway,
  type Prisma,
  type User,
  type UserGroup,
} from "@zedbot/database";

import { SUPPORTED_ONLINE_PROVIDERS } from "@zedbot/payments";

import { buildGatewayManager, isOnlineProvider } from "./gateway-payment.service.js";

// =============================================================================
// Payment methods, card-to-card rotation and receipt submission (Phase 7).
//
// Core rule: nothing here creates Orders/Services, deducts wallets, calls
// panels or finalizes discounts. The only writes are a PENDING_REVIEW Payment
// plus its ManualReceipt when the user submits a receipt.
// =============================================================================

export const RECEIPTS_PAGE_SIZE = 8;

function groupAllowed(allowedGroups: unknown, group: UserGroup): boolean {
  if (Array.isArray(allowedGroups) && allowedGroups.length > 0) {
    return allowedGroups.includes("ALL") || allowedGroups.includes(group);
  }
  return true; // null/empty = all groups
}

/**
 * Gateways this user may pay this checkout with:
 * isEnabled, not isHidden, not per-user hidden, amount within min/max,
 * group allowed, and the user's successful-payment count satisfies
 * activateAfterSuccessfulPaymentsCount. Phase 21: a CARD_TO_CARD gateway is
 * additionally only offered when it has at least one ACTIVE card account -
 * an empty gateway would dead-end on the card screen. Sorted by
 * displayOrder, createdAt.
 */
export async function getAvailablePaymentMethods(
  user: User,
  checkout: CheckoutSession,
): Promise<PaymentGateway[]> {
  const gateways = await prisma.paymentGateway.findMany({
    where: {
      isEnabled: true,
      isHidden: false,
      hiddenForUsers: { none: { userId: user.id } },
    },
    include: { _count: { select: { cardAccounts: { where: { isActive: true } } } } },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  const amount = checkout.finalPriceToman;
  const eligible = gateways.filter(
    (g) =>
      (g.minAmountToman === null || amount >= g.minAmountToman) &&
      (g.maxAmountToman === null || amount <= g.maxAmountToman) &&
      groupAllowed(g.allowedGroups, user.group) &&
      user.paidOrdersCount >= g.activateAfterSuccessfulPaymentsCount &&
      (g.type !== "CARD_TO_CARD" || g._count.cardAccounts > 0),
  );
  // Online providers (Zarinpal / NOWPayments / Stars) are additionally gated
  // on adapter availability (env credentials, Stars rate) - a configured-off
  // gateway row must never dead-end the user on a broken payment screen.
  if (!eligible.some((g) => isOnlineProvider(g.type))) {
    return eligible;
  }
  const manager = await buildGatewayManager();
  return eligible.filter(
    (g) => !isOnlineProvider(g.type) || manager.get(g.type)?.isAvailable() === true,
  );
}

/**
 * True when at least one ONLINE-provider gateway row exists but is switched
 * off by the admin (isEnabled false) or its adapter is unavailable (env
 * config / Stars rate missing). Drives the «روش پرداخت آنلاین فعالی وجود
 * ندارد» empty state; an amount/group filter alone keeps the generic
 * NO_METHODS_TEXT.
 */
export async function hasDormantOnlineGateways(): Promise<boolean> {
  const rows = await prisma.paymentGateway.findMany({
    where: { type: { in: [...SUPPORTED_ONLINE_PROVIDERS] } },
    select: { type: true, isEnabled: true },
  });
  if (rows.length === 0) {
    return false;
  }
  if (rows.some((row) => !row.isEnabled)) {
    return true;
  }
  const manager = await buildGatewayManager();
  return rows.some((row) => manager.get(row.type)?.isAvailable() !== true);
}

export async function getGatewayByShortId(shortId: string): Promise<PaymentGateway | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.paymentGateway.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function gatewayShortId(gateway: Pick<PaymentGateway, "id">): string {
  return gateway.id.slice(0, 8);
}

/**
 * Card rotation (round-robin, never random). The schema has no lastUsedAt
 * and Payment has no cardAccountId column, so per the fallback rules the
 * pick is: the ACTIVE account with the fewest Payments created today that
 * reference it (cardAccountId inside Payment.callbackPayload), ties broken
 * by displayOrder then createdAt. Usage increments naturally when the
 * receipt's Payment row is created.
 */
export async function pickCardAccountForGateway(
  gatewayId: string,
): Promise<CardToCardAccount | null> {
  const accounts = await prisma.cardToCardAccount.findMany({
    where: { gatewayId, isActive: true },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    return accounts[0];
  }
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const counts = await Promise.all(
    accounts.map((account) =>
      prisma.payment.count({
        where: {
          gatewayId,
          createdAt: { gte: startOfDay },
          callbackPayload: { path: ["cardAccountId"], equals: account.id },
        },
      }),
    ),
  );
  let best = 0;
  for (let i = 1; i < accounts.length; i++) {
    if (counts[i] < counts[best]) {
      best = i;
    }
  }
  return accounts[best];
}

/** The live (unreviewed) payment for a checkout, when one exists. */
export async function getPendingReviewPayment(checkoutSessionId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({
    where: { checkoutSessionId, status: PaymentStatus.PENDING_REVIEW },
    orderBy: { createdAt: "desc" },
  });
}

export interface ReceiptInput {
  fileId?: string;
  text?: string;
  /** Browser-uploaded evidence (Mini App): MiniAppReceiptUpload row id. The
   * SAME review pipeline consumes it — admins re-send the stored bytes
   * instead of a Telegram file_id. */
  uploadId?: string;
}

export type ReceiptSubmission =
  | { ok: true; payment: Payment }
  | { ok: false; error: string };

/**
 * Records a manual receipt: one PENDING_REVIEW Payment + its ManualReceipt,
 * in a transaction. Duplicate submissions for a checkout that already has a
 * PENDING_REVIEW payment are rejected. Never approves anything.
 */
export async function submitReceipt(
  user: User,
  checkout: CheckoutSession,
  gatewayId: string,
  cardAccountId: string | undefined,
  receipt: ReceiptInput,
): Promise<ReceiptSubmission> {
  const existing = await getPendingReviewPayment(checkout.id);
  if (existing !== null) {
    return { ok: false, error: "این پرداخت قبلاً رسید دریافت کرده است." };
  }
  const metadata: Prisma.InputJsonObject = {
    method: "CARD_TO_CARD",
    ...(cardAccountId === undefined ? {} : { cardAccountId }),
  };
  // The payment mirrors the checkout's purpose: wallet top-ups (Phase 14)
  // carry WALLET_CHARGE, everything else stays ORDER_PAYMENT.
  const purpose = checkout.purpose === "WALLET_CHARGE" ? "WALLET_CHARGE" : "ORDER_PAYMENT";
  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        gatewayId,
        purpose,
        status: PaymentStatus.PENDING_REVIEW,
        amountToman: checkout.finalPriceToman,
        payableAmountToman: checkout.finalPriceToman,
        callbackPayload: metadata,
        expiresAt: checkout.expiresAt,
      },
    });
    await tx.manualReceipt.create({
      data: {
        paymentId: created.id,
        userId: user.id,
        fileId: receipt.fileId ?? null,
        text: receipt.text ?? null,
        uploadId: receipt.uploadId ?? null,
        status: PaymentStatus.PENDING_REVIEW,
      },
    });
    return created;
  });
  return { ok: true, payment };
}

// --- Admin receipt list (read-only foundation) --------------------------------

export type PaymentWithRelations = Payment & {
  user: User;
  gateway: PaymentGateway | null;
  checkoutSession: CheckoutSession | null;
  receipts: ManualReceipt[];
};

export interface ReceiptListPage {
  payments: PaymentWithRelations[];
  page: number;
  pages: number;
  total: number;
}

export async function listPendingReviewPayments(page: number): Promise<ReceiptListPage> {
  const where = { status: PaymentStatus.PENDING_REVIEW } as const;
  const total = await prisma.payment.count({ where });
  const pages = Math.max(1, Math.ceil(total / RECEIPTS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const payments = await prisma.payment.findMany({
    where,
    include: { user: true, gateway: true, checkoutSession: true, receipts: true },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * RECEIPTS_PAGE_SIZE,
    take: RECEIPTS_PAGE_SIZE,
  });
  return { payments, page: safePage, pages, total };
}

export async function getPaymentByShortId(shortId: string): Promise<PaymentWithRelations | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.payment.findMany({
    where: { id: { startsWith: shortId } },
    include: { user: true, gateway: true, checkoutSession: true, receipts: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function paymentShortId(payment: Pick<Payment, "id">): string {
  return payment.id.slice(0, 8);
}
