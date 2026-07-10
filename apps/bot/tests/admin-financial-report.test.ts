import {
  prisma,
  type Order,
  type OrderStatus,
  type OrderType,
  type Payment,
  type PaymentGateway,
  type Product,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase31-test-secret-phase31-test-secret";

import {
  getAdminOrderDetail,
  getAdminPaymentDetail,
  getFinancialReport,
  listAdminOrders,
  listAdminPayments,
  REPORT_PAGE_SIZE,
  reportRangeStart,
  type FinancialReport,
  type ReportRange,
} from "../src/services/admin-financial-report.service.js";

// =============================================================================
// Phase 31 admin financial reports. The shared disposable DB contains other
// suites' rows, so aggregate assertions are DELTA-based (before/after
// snapshots inside each test; fileParallelism is off, so no concurrent
// writers). Skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const RANGES: ReportRange[] = ["today", "7d", "30d", "all"];

describe.runIf(hasDb)("admin financial reports (Phase 31)", () => {
  let userA: User;
  let userB: User;
  let product: Product;
  let gateway: PaymentGateway;

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  async function createOrder(
    user: User,
    type: OrderType,
    status: OrderStatus,
    amountToman: number,
    createdAt: Date = new Date(),
  ): Promise<Order> {
    return prisma.order.create({
      data: {
        userId: user.id,
        type,
        status,
        productId: type === "OTHER_PRODUCT" ? product.id : null,
        productNameSnapshot: `p31-${type}-${runTag}`,
        finalPriceToman: amountToman,
        createdAt,
        paidAt: status === "PAID" || status === "COMPLETED" ? createdAt : null,
        completedAt: status === "COMPLETED" ? createdAt : null,
      },
    });
  }

  async function createPayment(
    user: User,
    purpose: "WALLET_CHARGE" | "ORDER_PAYMENT",
    status: "PENDING_REVIEW" | "APPROVED" | "REJECTED",
    amountToman: number,
    createdAt: Date = new Date(),
  ): Promise<Payment> {
    return prisma.payment.create({
      data: {
        userId: user.id,
        purpose,
        status,
        amountToman,
        payableAmountToman: amountToman,
        gatewayId: gateway.id,
        createdAt,
        paidAt: status === "APPROVED" ? createdAt : null,
        reviewedAt: status === "PENDING_REVIEW" ? null : createdAt,
      },
    });
  }

  async function snapshots(): Promise<Record<ReportRange, FinancialReport>> {
    const entries = await Promise.all(
      RANGES.map(async (range) => [range, await getFinancialReport(range)] as const),
    );
    return Object.fromEntries(entries) as Record<ReportRange, FinancialReport>;
  }

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p31-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `Report-${runTag}`,
        priceToman: 100_000,
        isActive: true,
      },
    });
    gateway = await prisma.paymentGateway.create({
      data: { type: "CARD_TO_CARD", name: `p31-card-${runTag}` },
    });
    userA = await prisma.user.create({ data: { telegramId: runTag + 937n } });
    userB = await prisma.user.create({ data: { telegramId: runTag + 938n } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("range starts: today = last local midnight, 7d/30d rolling, all = null", () => {
    const now = new Date("2026-07-10T15:30:00");
    const today = reportRangeStart("today", now);
    expect(today?.getHours()).toBe(0);
    expect(today?.getDate()).toBe(now.getDate());
    expect(reportRangeStart("7d", now)?.getTime()).toBe(now.getTime() - 7 * 86_400_000);
    expect(reportRangeStart("30d", now)?.getTime()).toBe(now.getTime() - 30 * 86_400_000);
    expect(reportRangeStart("all", now)).toBeNull();
  });

  it("date ranges bucket orders into today/7d/30d/all correctly", async () => {
    const before = await snapshots();
    await createOrder(userA, "SERVICE_PURCHASE", "COMPLETED", 10_000, new Date());
    await createOrder(userA, "SERVICE_PURCHASE", "COMPLETED", 10_000, daysAgo(10));
    await createOrder(userA, "SERVICE_PURCHASE", "COMPLETED", 10_000, daysAgo(100));
    const after = await snapshots();

    expect(after.today.orders.revenueCount - before.today.orders.revenueCount).toBe(1);
    expect(after["7d"].orders.revenueCount - before["7d"].orders.revenueCount).toBe(1);
    expect(after["30d"].orders.revenueCount - before["30d"].orders.revenueCount).toBe(2);
    expect(after.all.orders.revenueCount - before.all.orders.revenueCount).toBe(3);
    expect(after.all.orders.revenueAmountToman - before.all.orders.revenueAmountToman).toBe(
      30_000,
    );
  });

  it("revenue counts PAID+COMPLETED only; failed/cancelled/refunded close instead", async () => {
    const before = await getFinancialReport("all");
    await createOrder(userA, "SERVICE_RENEWAL", "PAID", 111_000);
    await createOrder(userA, "SERVICE_RENEWAL", "COMPLETED", 111_000);
    await createOrder(userA, "SERVICE_RENEWAL", "FAILED", 111_000);
    await createOrder(userA, "SERVICE_RENEWAL", "CANCELLED", 111_000);
    await createOrder(userA, "SERVICE_RENEWAL", "REFUNDED", 111_000);
    const after = await getFinancialReport("all");

    expect(after.orders.total - before.orders.total).toBe(5);
    expect(after.orders.revenueCount - before.orders.revenueCount).toBe(2);
    expect(after.orders.revenueAmountToman - before.orders.revenueAmountToman).toBe(222_000);
    expect(after.orders.closedCount - before.orders.closedCount).toBe(3);
  });

  it("breaks revenue down by order type", async () => {
    const before = await getFinancialReport("all");
    const types: OrderType[] = [
      "SERVICE_PURCHASE",
      "SERVICE_RENEWAL",
      "EXTRA_VOLUME",
      "EXTRA_TIME",
      "OTHER_PRODUCT",
    ];
    for (const type of types) {
      await createOrder(userB, type, "PAID", 50_000);
    }
    const after = await getFinancialReport("all");
    for (const type of types) {
      expect(after.orders.byType[type].count - before.orders.byType[type].count).toBe(1);
      expect(
        after.orders.byType[type].amountToman - before.orders.byType[type].amountToman,
      ).toBe(50_000);
    }
  });

  it("summarizes wallet top-ups and payment review states separately", async () => {
    const before = await getFinancialReport("all");
    await createPayment(userA, "WALLET_CHARGE", "APPROVED", 70_000);
    await createPayment(userA, "WALLET_CHARGE", "PENDING_REVIEW", 30_000);
    await createPayment(userA, "WALLET_CHARGE", "REJECTED", 10_000);
    await createPayment(userB, "ORDER_PAYMENT", "PENDING_REVIEW", 40_000);
    await createPayment(userB, "ORDER_PAYMENT", "APPROVED", 60_000);
    const after = await getFinancialReport("all");

    expect(after.walletTopup.approvedCount - before.walletTopup.approvedCount).toBe(1);
    expect(after.walletTopup.approvedAmountToman - before.walletTopup.approvedAmountToman).toBe(
      70_000,
    );
    expect(after.walletTopup.pendingCount - before.walletTopup.pendingCount).toBe(1);
    expect(after.walletTopup.pendingAmountToman - before.walletTopup.pendingAmountToman).toBe(
      30_000,
    );

    expect(after.payments.total - before.payments.total).toBe(5);
    expect(after.payments.pendingReviewCount - before.payments.pendingReviewCount).toBe(2);
    expect(after.payments.approvedCount - before.payments.approvedCount).toBe(2);
    expect(after.payments.rejectedCount - before.payments.rejectedCount).toBe(1);
    expect(after.payments.rejectedAmountToman - before.payments.rejectedAmountToman).toBe(
      10_000,
    );
  });

  it("lists payments newest first with pagination bounds", async () => {
    const newest = await createPayment(
      userA,
      "ORDER_PAYMENT",
      "PENDING_REVIEW",
      123_000,
      new Date(Date.now() + 120_000),
    );
    const page = await listAdminPayments(1);
    expect(page.payments.length).toBeLessThanOrEqual(REPORT_PAGE_SIZE);
    expect(page.payments[0].id).toBe(newest.id);
    expect(page.payments[0].user.id).toBe(userA.id);
    const clamped = await listAdminPayments(9999);
    expect(clamped.page).toBe(clamped.pages);
  });

  it("resolves payment detail by short id and rejects garbage", async () => {
    const payment = await createPayment(userB, "WALLET_CHARGE", "REJECTED", 55_000);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { rejectReason: "رسید ناخوانا" },
    });
    const detail = await getAdminPaymentDetail(payment.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.user.id).toBe(userB.id);
    expect(detail.gateway?.type).toBe("CARD_TO_CARD");
    expect(detail.rejectReason).toBe("رسید ناخوانا");
    expect(await getAdminPaymentDetail("zzzz")).toBeNull();
    expect(await getAdminPaymentDetail("")).toBeNull();
  });

  it("lists orders newest first across ALL users (admin view)", async () => {
    const newest = await createOrder(
      userB,
      "EXTRA_VOLUME",
      "PAID",
      77_000,
      new Date(Date.now() + 120_000),
    );
    const page = await listAdminOrders(1);
    expect(page.orders.length).toBeLessThanOrEqual(REPORT_PAGE_SIZE);
    expect(page.orders[0].id).toBe(newest.id);
    const userIds = new Set(page.orders.map((order) => order.userId));
    expect(userIds.size).toBeGreaterThanOrEqual(2); // multiple users visible to admins
  });

  it("order detail carries manual/payment links and the stock flag - never content", async () => {
    const secret = `P31-${runTag}-STOCKSECRET`;
    const order = await createOrder(userA, "OTHER_PRODUCT", "COMPLETED", 90_000);
    const manual = await prisma.otherProductOrder.create({
      data: {
        orderId: order.id,
        userId: userA.id,
        productId: product.id,
        status: "DELIVERED",
        adminDeliveryText: "код",
        deliveredAt: new Date(),
      },
    });
    await prisma.otherProductStockItem.create({
      data: {
        productId: product.id,
        status: "DELIVERED",
        contentEncrypted: encryptSecret(secret),
        deliveredOrderId: order.id,
        deliveredToUserId: userA.id,
        deliveredAt: new Date(),
      },
    });
    const payment = await createPayment(userA, "ORDER_PAYMENT", "APPROVED", 90_000);
    await prisma.payment.update({ where: { id: payment.id }, data: { orderId: order.id } });
    await prisma.order.update({ where: { id: order.id }, data: { paymentId: payment.id } });

    const detail = await getAdminOrderDetail(order.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.otherProductOrder?.id).toBe(manual.id);
    expect(detail.payment?.id).toBe(payment.id);
    expect(detail.stockDelivered).toBe(true);
    const dump = JSON.stringify(detail, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("contentEncrypted");
    expect(await getAdminOrderDetail("zzzz")).toBeNull();
  });
});

describe.skipIf(hasDb)("admin financial reports (skipped)", () => {
  it("financial report tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
