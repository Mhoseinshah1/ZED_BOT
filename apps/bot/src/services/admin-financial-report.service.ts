import {
  prisma,
  type ManualReceipt,
  type Order,
  type OrderType,
  type OtherProductOrder,
  type Payment,
  type PaymentGateway,
  type Product,
  type Service,
  type User,
} from "@zedbot/database";

// =============================================================================
// «گزارش مالی 📊» (Phase 31) - admin-only READ-ONLY financial reporting:
// date-ranged aggregate summaries (one groupBy query per model) plus
// newest-first payment/order lists with detail lookups. Amount rules (no
// double counting): order revenue = Order.finalPriceToman of PAID/COMPLETED
// orders; wallet top-ups = WALLET_CHARGE payments, reported in their own
// section and never added to order revenue; the payments section counts
// review states. All stats bucket rows by their createdAt using server time
// ("today" = since the server's last local midnight - documented, no TZ
// helper exists in the repo). Nothing here mutates any financial row, and
// no stock content / receipt media / adapter errors are ever returned.
// =============================================================================

export const REPORT_PAGE_SIZE = 10;

export type ReportRange = "today" | "7d" | "30d" | "all";

export const REPORT_RANGE_LABEL: Record<ReportRange, string> = {
  today: "امروز",
  "7d": "۷ روز اخیر",
  "30d": "۳۰ روز اخیر",
  all: "همه زمان‌ها",
};

/** Range start in SERVER time; "today" = last local midnight; "all" = null. */
export function reportRangeStart(range: ReportRange, now: Date = new Date()): Date | null {
  switch (range) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}

const ORDER_TYPES: OrderType[] = [
  "SERVICE_PURCHASE",
  "SERVICE_RENEWAL",
  "EXTRA_VOLUME",
  "EXTRA_TIME",
  "LOCATION_CHANGE",
  "OTHER_PRODUCT",
];

/** Revenue statuses: paid money that was not reversed. */
const REVENUE_ORDER_STATUSES = ["PAID", "COMPLETED"] as const;
const CLOSED_ORDER_STATUSES = ["FAILED", "CANCELLED", "REFUNDED"] as const;

export interface FinancialReport {
  range: ReportRange;
  from: Date | null;
  orders: {
    total: number;
    revenueCount: number;
    revenueAmountToman: number;
    closedCount: number;
    byType: Record<OrderType, { count: number; amountToman: number }>;
  };
  walletTopup: {
    approvedCount: number;
    approvedAmountToman: number;
    pendingCount: number;
    pendingAmountToman: number;
  };
  payments: {
    total: number;
    pendingReviewCount: number;
    pendingReviewAmountToman: number;
    approvedCount: number;
    approvedAmountToman: number;
    rejectedCount: number;
    rejectedAmountToman: number;
  };
}

/** One groupBy per model; everything else is in-memory aggregation. */
export async function getFinancialReport(range: ReportRange): Promise<FinancialReport> {
  const from = reportRangeStart(range);
  const createdFilter = from === null ? {} : { createdAt: { gte: from } };

  const [orderGroups, paymentGroups] = await Promise.all([
    prisma.order.groupBy({
      by: ["type", "status"],
      where: createdFilter,
      _count: { _all: true },
      _sum: { finalPriceToman: true },
    }),
    prisma.payment.groupBy({
      by: ["purpose", "status"],
      where: createdFilter,
      _count: { _all: true },
      _sum: { amountToman: true },
    }),
  ]);

  const byType = Object.fromEntries(
    ORDER_TYPES.map((type) => [type, { count: 0, amountToman: 0 }]),
  ) as Record<OrderType, { count: number; amountToman: number }>;
  let orderTotal = 0;
  let revenueCount = 0;
  let revenueAmountToman = 0;
  let closedCount = 0;
  for (const group of orderGroups) {
    const count = group._count._all;
    const amount = group._sum.finalPriceToman ?? 0;
    orderTotal += count;
    if ((REVENUE_ORDER_STATUSES as readonly string[]).includes(group.status)) {
      revenueCount += count;
      revenueAmountToman += amount;
      byType[group.type].count += count;
      byType[group.type].amountToman += amount;
    } else if ((CLOSED_ORDER_STATUSES as readonly string[]).includes(group.status)) {
      closedCount += count;
    }
  }

  const walletTopup = {
    approvedCount: 0,
    approvedAmountToman: 0,
    pendingCount: 0,
    pendingAmountToman: 0,
  };
  const payments = {
    total: 0,
    pendingReviewCount: 0,
    pendingReviewAmountToman: 0,
    approvedCount: 0,
    approvedAmountToman: 0,
    rejectedCount: 0,
    rejectedAmountToman: 0,
  };
  for (const group of paymentGroups) {
    const count = group._count._all;
    const amount = group._sum.amountToman ?? 0;
    payments.total += count;
    if (group.status === "PENDING_REVIEW") {
      payments.pendingReviewCount += count;
      payments.pendingReviewAmountToman += amount;
    } else if (group.status === "APPROVED") {
      payments.approvedCount += count;
      payments.approvedAmountToman += amount;
    } else if (group.status === "REJECTED") {
      payments.rejectedCount += count;
      payments.rejectedAmountToman += amount;
    }
    if (group.purpose === "WALLET_CHARGE") {
      if (group.status === "APPROVED") {
        walletTopup.approvedCount += count;
        walletTopup.approvedAmountToman += amount;
      } else if (group.status === "PENDING_REVIEW") {
        walletTopup.pendingCount += count;
        walletTopup.pendingAmountToman += amount;
      }
    }
  }

  return {
    range,
    from,
    orders: { total: orderTotal, revenueCount, revenueAmountToman, closedCount, byType },
    walletTopup,
    payments,
  };
}

// --- latest payments -------------------------------------------------------------------------

export type AdminPaymentRow = Payment & {
  user: User;
  gateway: PaymentGateway | null;
  order: Order | null;
  receipts: Pick<ManualReceipt, "id">[];
};

export interface AdminPaymentsPage {
  payments: AdminPaymentRow[];
  page: number;
  pages: number;
  total: number;
}

/** ALL payments (admin view), newest first, 10/page. */
export async function listAdminPayments(page: number): Promise<AdminPaymentsPage> {
  const total = await prisma.payment.count();
  const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const payments = await prisma.payment.findMany({
    include: { user: true, gateway: true, order: true, receipts: { select: { id: true } } },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * REPORT_PAGE_SIZE,
    take: REPORT_PAGE_SIZE,
  });
  return { payments, page: safePage, pages, total };
}

/** Payment lookup by short id (admin context; ambiguity fails). */
export async function getAdminPaymentDetail(
  paymentShortId: string,
): Promise<AdminPaymentRow | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(paymentShortId)) {
    return null;
  }
  const matches = await prisma.payment.findMany({
    where: { id: { startsWith: paymentShortId } },
    include: { user: true, gateway: true, order: true, receipts: { select: { id: true } } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- latest orders ---------------------------------------------------------------------------

export type AdminOrderRow = Order & {
  user: User;
  product: Product | null;
  service: Service | null;
  payment: (Payment & { gateway: PaymentGateway | null }) | null;
  otherProductOrder: OtherProductOrder | null;
};

export interface AdminOrdersPage {
  orders: AdminOrderRow[];
  page: number;
  pages: number;
  total: number;
}

/** ALL orders (admin view), newest first, 10/page. */
export async function listAdminOrders(page: number): Promise<AdminOrdersPage> {
  const total = await prisma.order.count();
  const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const orders = await prisma.order.findMany({
    include: {
      user: true,
      product: true,
      service: true,
      payment: { include: { gateway: true } },
      otherProductOrder: true,
    },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * REPORT_PAGE_SIZE,
    take: REPORT_PAGE_SIZE,
  });
  return { orders, page: safePage, pages, total };
}

export type AdminOrderDetail = AdminOrderRow & {
  /** A DELIVERED stock item exists for this order (flag only - NEVER content). */
  stockDelivered: boolean;
};

/** Order lookup by short id (admin context; ambiguity fails). */
export async function getAdminOrderDetail(orderShortId: string): Promise<AdminOrderDetail | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(orderShortId)) {
    return null;
  }
  const matches = await prisma.order.findMany({
    where: { id: { startsWith: orderShortId } },
    include: {
      user: true,
      product: true,
      service: true,
      payment: { include: { gateway: true } },
      otherProductOrder: true,
    },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  const stockDelivered =
    (await prisma.otherProductStockItem.count({
      where: { deliveredOrderId: matches[0].id, status: "DELIVERED" },
    })) > 0;
  return { ...matches[0], stockDelivered };
}
