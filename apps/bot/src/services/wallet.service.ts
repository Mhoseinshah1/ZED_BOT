import {
  OrderStatus,
  prisma,
  ServiceStatus,
  type User,
  type WalletTransaction,
} from "@zedbot/database";

// =============================================================================
// Wallet/profile summary (Phase 13) - strictly READ-ONLY. Nothing here (or
// anywhere in this phase) creates/updates Payments, CheckoutSessions,
// Orders, WalletTransactions or User balances. All queries are scoped to
// one userId.
// =============================================================================

export const WALLET_TX_PAGE_SIZE = 10;
export const WALLET_LATEST_TX_COUNT = 5;

export interface WalletSummary {
  user: User;
  totalServices: number;
  activeServices: number;
  totalOrders: number;
  paidOrders: number;
  referralCount: number;
  latestTransactions: WalletTransaction[];
  now: Date;
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
  const [totalServices, activeServices, totalOrders, paidOrders, referralCount, latestTransactions] =
    await Promise.all([
      prisma.service.count({
        where: { userId, deletedAt: null, status: { not: ServiceStatus.DELETED } },
      }),
      prisma.service.count({
        where: { userId, deletedAt: null, status: ServiceStatus.ACTIVE },
      }),
      prisma.order.count({ where: { userId } }),
      prisma.order.count({
        where: {
          userId,
          status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING, OrderStatus.COMPLETED] },
        },
      }),
      prisma.user.count({ where: { referrerId: userId } }),
      prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: WALLET_LATEST_TX_COUNT,
      }),
    ]);
  return {
    user,
    totalServices,
    activeServices,
    totalOrders,
    paidOrders,
    referralCount,
    latestTransactions,
    now: new Date(),
  };
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
