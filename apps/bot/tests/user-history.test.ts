import {
  prisma,
  type Order,
  type OrderType,
  type Payment,
  type PaymentGateway,
  type Product,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase30-test-secret-phase30-test-secret";

import {
  getUserHistoryOrderDetail,
  getUserPaymentDetail,
  listUserHistory,
  listUserPayments,
  paymentMethodLabel,
  USER_HISTORY_PAGE_SIZE,
} from "../src/services/user-history.service.js";

// =============================================================================
// Phase 30 general user history: unified order+payment list (dedup rule,
// merged sorting, pagination), owner-scoped order/payment details, payment
// states, and the no-stock-content guarantee. Shared disposable PostgreSQL
// (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const baseTime = Date.parse("2026-01-01T00:00:00Z");

describe.runIf(hasDb)("user general history (Phase 30)", () => {
  let userA: User;
  let userB: User;
  let product: Product;
  let gateway: PaymentGateway;

  let purchaseOrder: Order;
  let linkedPayment: Payment;
  let topupPending: Payment;

  function at(minutes: number): Date {
    return new Date(baseTime + minutes * 60_000);
  }

  async function createOrder(
    user: User,
    type: OrderType,
    minutes: number,
    status: "PAID" | "COMPLETED" = "COMPLETED",
  ): Promise<Order> {
    return prisma.order.create({
      data: {
        userId: user.id,
        type,
        status,
        productId: type === "SERVICE_PURCHASE" || type === "OTHER_PRODUCT" ? product.id : null,
        productNameSnapshot: `${type}-${runTag}`,
        finalPriceToman: 100_000,
        createdAt: at(minutes),
        paidAt: at(minutes),
        completedAt: status === "COMPLETED" ? at(minutes + 1) : null,
      },
    });
  }

  async function createPayment(
    user: User,
    args: {
      purpose: "WALLET_CHARGE" | "ORDER_PAYMENT" | "PAY_WITH_WALLET";
      status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
      minutes: number;
      orderId?: string;
      gatewayId?: string;
      rejectReason?: string;
    },
  ): Promise<Payment> {
    return prisma.payment.create({
      data: {
        userId: user.id,
        purpose: args.purpose,
        status: args.status,
        amountToman: 200_000,
        payableAmountToman: 200_000,
        orderId: args.orderId ?? null,
        gatewayId: args.gatewayId ?? null,
        rejectReason: args.rejectReason ?? null,
        createdAt: at(args.minutes),
        paidAt: args.status === "APPROVED" ? at(args.minutes) : null,
        reviewedAt: args.status === "PENDING_REVIEW" ? null : at(args.minutes + 1),
      },
    });
  }

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p30-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `Hist-${runTag}`,
        priceToman: 100_000,
        isActive: true,
      },
    });
    gateway = await prisma.paymentGateway.create({
      data: { type: "CARD_TO_CARD", name: `p30-card-${runTag}` },
    });
    userA = await prisma.user.create({ data: { telegramId: runTag + 934n } });
    userB = await prisma.user.create({ data: { telegramId: runTag + 935n } });

    // userA's orders: one of each type, oldest -> newest.
    purchaseOrder = await createOrder(userA, "SERVICE_PURCHASE", 10);
    await createOrder(userA, "SERVICE_RENEWAL", 20);
    await createOrder(userA, "EXTRA_VOLUME", 30);
    await createOrder(userA, "EXTRA_TIME", 40);
    await createOrder(userA, "OTHER_PRODUCT", 50, "PAID");

    // Payment linked to the purchase order (approved) - must NOT duplicate.
    // Production stamps BOTH sides: Payment.orderId and Order.paymentId.
    linkedPayment = await createPayment(userA, {
      purpose: "ORDER_PAYMENT",
      status: "APPROVED",
      minutes: 10,
      orderId: purchaseOrder.id,
      gatewayId: gateway.id,
    });
    purchaseOrder = await prisma.order.update({
      where: { id: purchaseOrder.id },
      data: { paymentId: linkedPayment.id },
    });
    // Order-less payments: pending top-up (newest), rejected order attempt.
    topupPending = await createPayment(userA, {
      purpose: "WALLET_CHARGE",
      status: "PENDING_REVIEW",
      minutes: 60,
      gatewayId: gateway.id,
    });
    await prisma.manualReceipt.create({
      data: { paymentId: topupPending.id, userId: userA.id, text: "receipt" },
    });
    await createPayment(userA, {
      purpose: "ORDER_PAYMENT",
      status: "REJECTED",
      minutes: 5,
      gatewayId: gateway.id,
      rejectReason: "مبلغ اشتباه است",
    });

    // Foreign rows that must never leak into userA's views.
    await createOrder(userB, "SERVICE_PURCHASE", 55);
    await createPayment(userB, {
      purpose: "WALLET_CHARGE",
      status: "APPROVED",
      minutes: 56,
      gatewayId: gateway.id,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("unified list: all order types + order-less payments, no duplicates, owner only", async () => {
    const page = await listUserHistory(userA.id, 1);
    expect(page.total).toBe(7); // 5 orders + 2 order-less payments

    const orderTypes = page.items
      .filter((item) => item.kind === "order")
      .map((item) => (item.kind === "order" ? item.orderType : ""));
    for (const type of [
      "SERVICE_PURCHASE",
      "SERVICE_RENEWAL",
      "EXTRA_VOLUME",
      "EXTRA_TIME",
      "OTHER_PRODUCT",
    ]) {
      expect(orderTypes).toContain(type);
    }
    const paymentIds = page.items
      .filter((item) => item.kind === "payment")
      .map((item) => item.id);
    expect(paymentIds).toContain(topupPending.id);
    // The approved order payment is represented by its ORDER, not repeated.
    expect(paymentIds).not.toContain(linkedPayment.id);
    // Foreign rows are invisible.
    for (const item of page.items) {
      expect(item.title).not.toContain("undefined");
    }
    const ids = page.items.map((item) => item.id);
    const foreign = await prisma.order.findFirst({ where: { userId: userB.id } });
    expect(foreign).not.toBeNull();
    if (foreign === null) return;
    expect(ids).not.toContain(foreign.id);
  });

  it("merges newest-first across both sources", async () => {
    const page = await listUserHistory(userA.id, 1);
    const times = page.items.map((item) => item.sortAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The pending top-up (minute 60) is the newest item overall.
    expect(page.items[0].id).toBe(topupPending.id);
    expect(page.items[0].kind).toBe("payment");
  });

  it("order detail is owner-scoped with safe short-id handling", async () => {
    const detail = await getUserHistoryOrderDetail(userA.id, purchaseOrder.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.type).toBe("SERVICE_PURCHASE");
    expect(detail.payment?.id).toBe(linkedPayment.id);
    expect(detail.payment?.gateway?.type).toBe("CARD_TO_CARD");
    expect(paymentMethodLabel(detail.payment ?? { purpose: "ORDER_PAYMENT" }, detail.payment?.gateway ?? null)).toBe(
      "کارت‌به‌کارت",
    );

    expect(await getUserHistoryOrderDetail(userB.id, purchaseOrder.id.slice(0, 8))).toBeNull();
    expect(await getUserHistoryOrderDetail(userA.id, "zzzz")).toBeNull();
    expect(await getUserHistoryOrderDetail(userA.id, "")).toBeNull();
  });

  it("payment history carries pending/approved/rejected with receipt state", async () => {
    const page = await listUserPayments(userA.id, 1);
    expect(page.total).toBe(3);
    const statuses = page.payments.map((payment) => payment.status).sort();
    expect(statuses).toEqual(["APPROVED", "PENDING_REVIEW", "REJECTED"]);
    const pending = page.payments.find((payment) => payment.id === topupPending.id);
    expect(pending).toBeDefined();
    expect(pending?.receipts.length).toBe(1);
    expect(pending?.gateway?.type).toBe("CARD_TO_CARD");
    for (const payment of page.payments) {
      expect(payment.userId).toBe(userA.id);
    }
  });

  it("payment detail is owner-scoped and exposes the related order", async () => {
    const detail = await getUserPaymentDetail(userA.id, linkedPayment.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.order?.id).toBe(purchaseOrder.id);
    expect(detail.order?.type).toBe("SERVICE_PURCHASE");

    expect(await getUserPaymentDetail(userB.id, linkedPayment.id.slice(0, 8))).toBeNull();
    expect(await getUserPaymentDetail(userA.id, "zzzz")).toBeNull();
  });

  it("wallet payments label as کیف پول", () => {
    expect(paymentMethodLabel({ purpose: "PAY_WITH_WALLET" }, null)).toBe("کیف پول");
    expect(paymentMethodLabel({ purpose: "WALLET_CHARGE" }, { type: "CARD_TO_CARD" })).toBe(
      "کارت‌به‌کارت",
    );
  });

  it("general history never returns delivered stock content", async () => {
    const secret = `P30-${runTag}-STOCKSECRET`;
    const stockOrder = await createOrder(userA, "OTHER_PRODUCT", 70);
    await prisma.otherProductStockItem.create({
      data: {
        productId: product.id,
        status: "DELIVERED",
        contentEncrypted: encryptSecret(secret),
        deliveredOrderId: stockOrder.id,
        deliveredToUserId: userA.id,
        deliveredAt: at(71),
      },
    });
    const page = await listUserHistory(userA.id, 1);
    const detail = await getUserHistoryOrderDetail(userA.id, stockOrder.id.slice(0, 8));
    const dump = JSON.stringify({ page, detail });
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("contentEncrypted");
  });

  it("paginates the merged list 10/page with clamping", async () => {
    const pager = await prisma.user.create({ data: { telegramId: runTag + 936n } });
    for (let i = 0; i < 8; i++) {
      await createOrder(pager, "SERVICE_PURCHASE", 100 + i);
    }
    for (let i = 0; i < 4; i++) {
      await createPayment(pager, {
        purpose: "WALLET_CHARGE",
        status: "APPROVED",
        minutes: 110 + i,
        gatewayId: gateway.id,
      });
    }
    const page1 = await listUserHistory(pager.id, 1);
    expect(page1.total).toBe(12);
    expect(page1.pages).toBe(2);
    expect(page1.items).toHaveLength(USER_HISTORY_PAGE_SIZE);
    const page2 = await listUserHistory(pager.id, 2);
    expect(page2.items).toHaveLength(2);
    expect((await listUserHistory(pager.id, 99)).page).toBe(2);
    // No item appears on both pages.
    const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });
});

describe.skipIf(hasDb)("user general history (skipped)", () => {
  it("general history tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
