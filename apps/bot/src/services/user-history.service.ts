import {
  prisma,
  type ManualReceipt,
  type Order,
  type OrderStatus,
  type OrderType,
  type Payment,
  type PaymentGateway,
  type PaymentPurpose,
  type PaymentStatus,
  type Product,
  type Service,
} from "@zedbot/database";

// =============================================================================
// «سفارش‌ها و سوابق من 🧾» (Phase 30) - READ-ONLY general history over the
// user's own Orders (every OrderType) and Payments (card-to-card, wallet
// top-ups, wallet payments). Everything is scoped to the current user's id;
// ambiguous short ids fail (take 2). Duplicate-avoidance rule: a Payment
// that gained an orderId (both approval paths set it when the Order is
// created) is represented by its ORDER in the unified list - only
// order-less payments (pending/rejected attempts and wallet top-ups) appear
// as payment rows. Stock content and receipt media are never touched here;
// the OTHER_PRODUCT delivered-content path stays in Phase 29.
// No Payment/Order/Wallet/Service/Stock mutation.
// =============================================================================

export const USER_HISTORY_PAGE_SIZE = 10;

// Fix D: «خرید اشتراک‌ها 🔐» - every subscription-service-related order
// type (OTHER_PRODUCT stays a separate list, per the locked separation).
export const SUBSCRIPTION_ORDER_TYPES: OrderType[] = [
  "SERVICE_PURCHASE",
  "SERVICE_RENEWAL",
  "EXTRA_VOLUME",
  "EXTRA_TIME",
  "LOCATION_CHANGE",
];

export interface UserSubscriptionOrdersPage {
  orders: Order[];
  page: number;
  pages: number;
  total: number;
}

/** Owner-scoped, newest-first page of subscription-related orders (Fix D). */
export async function listUserSubscriptionOrders(
  userId: string,
  page: number,
): Promise<UserSubscriptionOrdersPage> {
  const where = { userId, type: { in: SUBSCRIPTION_ORDER_TYPES } } as const;
  const total = await prisma.order.count({ where });
  const pages = Math.max(1, Math.ceil(total / USER_HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * USER_HISTORY_PAGE_SIZE,
    take: USER_HISTORY_PAGE_SIZE,
  });
  return { orders, page: safePage, pages, total };
}

// --- labels ----------------------------------------------------------------------------------

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  SERVICE_PURCHASE: "خرید سرویس",
  SERVICE_RENEWAL: "تمدید سرویس",
  EXTRA_VOLUME: "حجم اضافه",
  EXTRA_TIME: "زمان اضافه",
  LOCATION_CHANGE: "تغییر لوکیشن",
  OTHER_PRODUCT: "محصول دیگر",
};

/** ✅ done / ⏳ in progress / ❌ closed without result. */
export function orderStatusInfo(status: OrderStatus): { icon: string; label: string } {
  switch (status) {
    case "COMPLETED":
      return { icon: "✅", label: "تکمیل‌شده ✅" };
    case "PAID":
      return { icon: "⏳", label: "پرداخت‌شده - در حال انجام ⏳" };
    case "PROVISIONING":
      return { icon: "⏳", label: "در حال ساخت ⏳" };
    case "FAILED":
      return { icon: "❌", label: "ناموفق ❌" };
    case "CANCELLED":
      return { icon: "❌", label: "لغوشده ❌" };
    case "REFUNDED":
      return { icon: "❌", label: "استرداد شده ❌" };
    default:
      // PENDING_PAYMENT / WAITING_RECEIPT / PENDING_REVIEW
      return { icon: "⏳", label: "در انتظار پرداخت/بررسی ⏳" };
  }
}

export function paymentStatusInfo(status: PaymentStatus): { icon: string; label: string } {
  switch (status) {
    case "APPROVED":
      return { icon: "✅", label: "تایید شده ✅" };
    case "REJECTED":
      return { icon: "❌", label: "رد شده ❌" };
    case "FAILED":
      return { icon: "❌", label: "ناموفق ❌" };
    case "EXPIRED":
      return { icon: "❌", label: "منقضی شده ❌" };
    case "DELETED":
      return { icon: "❌", label: "حذف شده ❌" };
    case "PENDING_REVIEW":
      return { icon: "⏳", label: "در انتظار بررسی ⏳" };
    default:
      return { icon: "⏳", label: "در انتظار پرداخت ⏳" };
  }
}

const PAYMENT_PURPOSE_TITLE: Record<PaymentPurpose, string> = {
  WALLET_CHARGE: "شارژ کیف پول",
  ORDER_PAYMENT: "پرداخت سفارش",
  PAY_WITH_WALLET: "پرداخت با کیف پول",
  SERVICE_SUBSCRIPTION_INITIAL: "اشتراک ماهانه (پرداخت اول)",
  SERVICE_SUBSCRIPTION_RECURRING: "اشتراک ماهانه (تمدید دوره‌ای)",
};

export function paymentPurposeTitle(purpose: PaymentPurpose): string {
  return PAYMENT_PURPOSE_TITLE[purpose];
}

/** «کارت‌به‌کارت» / «کیف پول» / gateway-less fallback. Never config data. */
export function paymentMethodLabel(
  payment: Pick<Payment, "purpose">,
  gateway: Pick<PaymentGateway, "type"> | null,
): string {
  if (payment.purpose === "PAY_WITH_WALLET") {
    return "کیف پول";
  }
  if (gateway?.type === "CARD_TO_CARD") {
    return "کارت‌به‌کارت";
  }
  return "-";
}

// --- unified history -------------------------------------------------------------------------

export type UserHistoryItem =
  | {
      kind: "order";
      id: string;
      orderType: OrderType;
      status: OrderStatus;
      title: string;
      amountToman: number;
      createdAt: Date;
      paidAt: Date | null;
      completedAt: Date | null;
      sortAt: Date;
    }
  | {
      kind: "payment";
      id: string;
      purpose: PaymentPurpose;
      status: PaymentStatus;
      title: string;
      amountToman: number;
      createdAt: Date;
      reviewedAt: Date | null;
      sortAt: Date;
    };

export interface UserHistoryPage {
  items: UserHistoryItem[];
  page: number;
  pages: number;
  total: number;
}

function orderTitle(order: Pick<Order, "type" | "productNameSnapshot">): string {
  const type = ORDER_TYPE_LABEL[order.type];
  const name = order.productNameSnapshot;
  return name === null || name === "" ? type : `${type} - ${name}`;
}

/**
 * The user's merged history, newest first (paidAt ?? completedAt ??
 * createdAt), 10/page: every Order plus every order-less Payment. Both
 * sources are fetched up to the requested window and merged in memory - a
 * page deep in history costs one bounded query per source.
 */
export async function listUserHistory(userId: string, page: number): Promise<UserHistoryPage> {
  const orderWhere = { userId };
  const paymentWhere = { userId, orderId: null };
  const [orderTotal, paymentTotal] = await Promise.all([
    prisma.order.count({ where: orderWhere }),
    prisma.payment.count({ where: paymentWhere }),
  ]);
  const total = orderTotal + paymentTotal;
  const pages = Math.max(1, Math.ceil(total / USER_HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const window = safePage * USER_HISTORY_PAGE_SIZE;

  const [orders, payments] = await Promise.all([
    prisma.order.findMany({
      where: orderWhere,
      orderBy: { createdAt: "desc" },
      take: window,
    }),
    prisma.payment.findMany({
      where: paymentWhere,
      orderBy: { createdAt: "desc" },
      take: window,
    }),
  ]);

  const items: UserHistoryItem[] = [
    ...orders.map((order): UserHistoryItem => {
      return {
        kind: "order",
        id: order.id,
        orderType: order.type,
        status: order.status,
        title: orderTitle(order),
        amountToman: order.finalPriceToman,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        completedAt: order.completedAt,
        sortAt: order.paidAt ?? order.completedAt ?? order.createdAt,
      };
    }),
    ...payments.map((payment): UserHistoryItem => {
      return {
        kind: "payment",
        id: payment.id,
        purpose: payment.purpose,
        status: payment.status,
        title: paymentPurposeTitle(payment.purpose),
        amountToman: payment.amountToman,
        createdAt: payment.createdAt,
        reviewedAt: payment.reviewedAt,
        sortAt: payment.paidAt ?? payment.createdAt,
      };
    }),
  ].sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());

  return {
    items: items.slice((safePage - 1) * USER_HISTORY_PAGE_SIZE, safePage * USER_HISTORY_PAGE_SIZE),
    page: safePage,
    pages,
    total,
  };
}

// --- order detail ----------------------------------------------------------------------------

export type UserHistoryOrderDetail = Order & {
  product: Product | null;
  service: Service | null;
  payment: (Payment & { gateway: PaymentGateway | null }) | null;
};

/** Owner-scoped Order lookup by short id (any type; ambiguity fails). */
export async function getUserHistoryOrderDetail(
  userId: string,
  orderShortId: string,
): Promise<UserHistoryOrderDetail | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(orderShortId)) {
    return null;
  }
  const matches = await prisma.order.findMany({
    where: { id: { startsWith: orderShortId }, userId },
    include: { product: true, service: true, payment: { include: { gateway: true } } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- payment history -------------------------------------------------------------------------

export type UserPaymentRow = Payment & {
  gateway: PaymentGateway | null;
  order: Order | null;
  receipts: Pick<ManualReceipt, "id">[];
};

export interface UserPaymentsPage {
  payments: UserPaymentRow[];
  page: number;
  pages: number;
  total: number;
}

/** ALL of the user's payment attempts, newest first, 10/page. */
export async function listUserPayments(userId: string, page: number): Promise<UserPaymentsPage> {
  const where = { userId };
  const total = await prisma.payment.count({ where });
  const pages = Math.max(1, Math.ceil(total / USER_HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const payments = await prisma.payment.findMany({
    where,
    include: { gateway: true, order: true, receipts: { select: { id: true } } },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * USER_HISTORY_PAGE_SIZE,
    take: USER_HISTORY_PAGE_SIZE,
  });
  return { payments, page: safePage, pages, total };
}

/** Owner-scoped Payment lookup by short id (ambiguity fails). */
export async function getUserPaymentDetail(
  userId: string,
  paymentShortId: string,
): Promise<UserPaymentRow | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(paymentShortId)) {
    return null;
  }
  const matches = await prisma.payment.findMany({
    where: { id: { startsWith: paymentShortId }, userId },
    include: { gateway: true, order: true, receipts: { select: { id: true } } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}
