import {
  OrderStatus,
  prisma,
  ServiceStatus,
  type User,
  type WalletTransaction,
} from "@zedbot/database";

// =============================================================================
// Wallet/profile summary (Phase 13, trimmed by Corrective Fix A) - strictly
// READ-ONLY. Nothing here creates/updates Payments, CheckoutSessions,
// Orders, WalletTransactions or User balances. All queries are scoped to
// one userId. The summary carries exactly what the wallet landing renders;
// transaction details live behind «تاریخچه تراکنش‌ها 📋».
// =============================================================================

export const WALLET_TX_PAGE_SIZE = 10;

/** Order states counted as "unpaid/pending" on the wallet landing. */
export const PENDING_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.WAITING_RECEIPT,
  OrderStatus.PENDING_REVIEW,
];

export interface WalletSummary {
  user: User;
  totalServices: number;
  /** Orders still in PENDING_PAYMENT / WAITING_RECEIPT / PENDING_REVIEW. */
  pendingOrders: number;
  referralCount: number;
}

export interface WalletTransactionPage {
  transactions: WalletTransaction[];
  page: number;
  pages: number;
  total: number;
}

/** Fresh, read-only snapshot of the user's wallet/profile numbers. */
export async function getWalletSummary(userId: string): Promise<WalletSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const [totalServices, pendingOrders, referralCount] = await Promise.all([
    prisma.service.count({
      where: { userId, deletedAt: null, status: { not: ServiceStatus.DELETED } },
    }),
    prisma.order.count({
      where: { userId, status: { in: PENDING_ORDER_STATUSES } },
    }),
    prisma.user.count({ where: { referrerId: userId } }),
  ]);
  return { user, totalServices, pendingOrders, referralCount };
}

/** Newest-first page of the user's wallet transactions (10 per page). */
export async function listWalletTransactions(
  userId: string,
  page: number,
  pageSize: number = WALLET_TX_PAGE_SIZE,
): Promise<WalletTransactionPage> {
  const total = await prisma.walletTransaction.count({ where: { userId } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const transactions = await prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * pageSize,
    take: pageSize,
  });
  return { transactions, page: safePage, pages, total };
}
