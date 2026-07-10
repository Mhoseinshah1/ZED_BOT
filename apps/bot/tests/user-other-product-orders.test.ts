import { prisma, type Order, type Product, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase29-test-secret-phase29-test-secret";

import {
  deriveUserOrderStatus,
  getDeliveredStockContentForUser,
  getUserOtherProductOrderDetail,
  listUserOtherProductOrders,
  orderProductName,
  STOCK_CONTENT_UNAVAILABLE_TEXT,
  USER_ORDERS_PAGE_SIZE,
  visibleManualDeliveryText,
} from "../src/services/user-other-product-orders.service.js";

// =============================================================================
// Phase 29 user-facing OTHER_PRODUCT order history. Owner scoping, all three
// fulfilment shapes (manual record / stock auto-delivery / paid edge),
// delivered-content visibility rules and pagination. Shared disposable
// PostgreSQL (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

describe.runIf(hasDb)("user OTHER_PRODUCT order history (Phase 29)", () => {
  let userA: User;
  let userB: User;
  let product: Product;
  let categoryId: string;

  async function createOrder(
    user: User,
    status: "PAID" | "COMPLETED",
    overrides: { type?: "OTHER_PRODUCT" | "SERVICE_PURCHASE"; nameSnapshot?: string } = {},
  ): Promise<Order> {
    return prisma.order.create({
      data: {
        userId: user.id,
        type: overrides.type ?? "OTHER_PRODUCT",
        status,
        productId: product.id,
        productNameSnapshot: overrides.nameSnapshot ?? product.name,
        finalPriceToman: product.priceToman,
        paidAt: new Date(),
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
  }

  async function createManualRecord(
    order: Order,
    user: User,
    status: "WAITING_USER_INFO" | "WAITING_ADMIN_DELIVERY" | "DELIVERED",
    deliveryText: string | null = null,
  ) {
    return prisma.otherProductOrder.create({
      data: {
        orderId: order.id,
        userId: user.id,
        productId: product.id,
        status,
        adminDeliveryText: deliveryText,
        deliveredAt: status === "DELIVERED" ? new Date() : null,
      },
    });
  }

  async function createDeliveredStockItem(order: Order, user: User, content: string) {
    return prisma.otherProductStockItem.create({
      data: {
        productId: product.id,
        status: "DELIVERED",
        contentEncrypted: encryptSecret(content),
        deliveredOrderId: order.id,
        deliveredToUserId: user.id,
        deliveredAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p29-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `History-${runTag}`,
        priceToman: 250_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        requiredUserInfoPromptText: "ایمیل خود را بفرستید.",
      },
    });
    userA = await prisma.user.create({ data: { telegramId: runTag + 931n } });
    userB = await prisma.user.create({ data: { telegramId: runTag + 932n } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lists only the current user's OTHER_PRODUCT orders", async () => {
    const mine = await createOrder(userA, "PAID");
    const foreign = await createOrder(userB, "PAID");
    const service = await createOrder(userA, "PAID", { type: "SERVICE_PURCHASE" });

    const page = await listUserOtherProductOrders(userA.id, 1);
    const ids = page.rows.map((row) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(foreign.id);
    expect(ids).not.toContain(service.id);
    for (const row of page.rows) {
      expect(row.userId).toBe(userA.id);
      expect(row.type).toBe("OTHER_PRODUCT");
    }
  });

  it("derives the manual statuses: waiting info, waiting delivery, delivered", async () => {
    const infoOrder = await createOrder(userA, "PAID");
    await createManualRecord(infoOrder, userA, "WAITING_USER_INFO");
    const readyOrder = await createOrder(userA, "PAID");
    await createManualRecord(readyOrder, userA, "WAITING_ADMIN_DELIVERY");
    const doneOrder = await createOrder(userA, "COMPLETED");
    await createManualRecord(doneOrder, userA, "DELIVERED", `کد شما: DONE-${runTag}`);

    const info = await getUserOtherProductOrderDetail(userA.id, infoOrder.id.slice(0, 8));
    const ready = await getUserOtherProductOrderDetail(userA.id, readyOrder.id.slice(0, 8));
    const done = await getUserOtherProductOrderDetail(userA.id, doneOrder.id.slice(0, 8));
    expect(info).not.toBeNull();
    expect(ready).not.toBeNull();
    expect(done).not.toBeNull();
    if (info === null || ready === null || done === null) return;

    expect(deriveUserOrderStatus(info)).toBe("waiting_info");
    expect(deriveUserOrderStatus(ready)).toBe("waiting_delivery");
    expect(deriveUserOrderStatus(done)).toBe("delivered_manual");

    // Delivery text: visible only on the delivered record, only for its owner.
    expect(visibleManualDeliveryText(done, userA.id)).toBe(`کد شما: DONE-${runTag}`);
    expect(visibleManualDeliveryText(done, userB.id)).toBeNull();
    expect(visibleManualDeliveryText(ready, userA.id)).toBeNull();
  });

  it("includes the stock auto-delivered order (no OtherProductOrder) and decrypts for the owner only", async () => {
    const order = await createOrder(userA, "COMPLETED");
    const secret = `STOCK-${runTag}-SECRET`;
    await createDeliveredStockItem(order, userA, secret);

    const detail = await getUserOtherProductOrderDetail(userA.id, order.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.otherProductOrder).toBeNull();
    expect(detail.stockItem).not.toBeNull();
    expect(deriveUserOrderStatus(detail)).toBe("delivered_stock");

    const content = getDeliveredStockContentForUser(detail, userA.id);
    expect(content).toEqual({ ok: true, content: secret });

    // A mismatching viewer gets nothing decrypted.
    expect(getDeliveredStockContentForUser(detail, userB.id)).toBeNull();
    // And the foreign user cannot even resolve the order.
    expect(await getUserOtherProductOrderDetail(userB.id, order.id.slice(0, 8))).toBeNull();
  });

  it("decrypt failure returns the safe message and never the payload", async () => {
    const order = await createOrder(userA, "COMPLETED");
    await prisma.otherProductStockItem.create({
      data: {
        productId: product.id,
        status: "DELIVERED",
        contentEncrypted: "not-a-valid-ciphertext",
        deliveredOrderId: order.id,
        deliveredToUserId: userA.id,
        deliveredAt: new Date(),
      },
    });
    const detail = await getUserOtherProductOrderDetail(userA.id, order.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    const content = getDeliveredStockContentForUser(detail, userA.id);
    expect(content).toEqual({ ok: false, safeMessage: STOCK_CONTENT_UNAVAILABLE_TEXT });
    if (content === null || content.ok) return;
    expect(content.safeMessage).not.toContain("not-a-valid-ciphertext");
  });

  it("PAID order with no manual record and no stock item shows the pending state", async () => {
    const order = await createOrder(userA, "PAID");
    const detail = await getUserOtherProductOrderDetail(userA.id, order.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.otherProductOrder).toBeNull();
    expect(detail.stockItem).toBeNull();
    expect(deriveUserOrderStatus(detail)).toBe("pending");
  });

  it("falls back to the product-name snapshot when the live product is gone", async () => {
    const doomed = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `Doomed-${runTag}`,
        priceToman: 10_000,
        isActive: false,
      },
    });
    const order = await prisma.order.create({
      data: {
        userId: userA.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: doomed.id,
        productNameSnapshot: `Snapshot-${runTag}`,
        finalPriceToman: 10_000,
        paidAt: new Date(),
      },
    });
    await prisma.order.update({ where: { id: order.id }, data: { productId: null } });
    await prisma.product.delete({ where: { id: doomed.id } });

    const detail = await getUserOtherProductOrderDetail(userA.id, order.id.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.product).toBeNull();
    expect(orderProductName(detail)).toBe(`Snapshot-${runTag}`);
  });

  it("paginates 10/page, newest first, and rejects garbage short ids", async () => {
    const pager = await prisma.user.create({ data: { telegramId: runTag + 933n } });
    for (let i = 0; i < USER_ORDERS_PAGE_SIZE + 2; i++) {
      await createOrder(pager, "PAID");
    }
    const page1 = await listUserOtherProductOrders(pager.id, 1);
    expect(page1.total).toBe(USER_ORDERS_PAGE_SIZE + 2);
    expect(page1.pages).toBe(2);
    expect(page1.rows).toHaveLength(USER_ORDERS_PAGE_SIZE);
    const page2 = await listUserOtherProductOrders(pager.id, 2);
    expect(page2.rows).toHaveLength(2);
    // Out-of-range pages clamp instead of erroring.
    expect((await listUserOtherProductOrders(pager.id, 99)).page).toBe(2);
    const stamps = page1.rows.map((row) => row.createdAt.getTime());
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    expect(await getUserOtherProductOrderDetail(pager.id, "zzzz")).toBeNull();
    expect(await getUserOtherProductOrderDetail(pager.id, "")).toBeNull();
  });
});

describe.skipIf(hasDb)("user OTHER_PRODUCT order history (skipped)", () => {
  it("order history tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
