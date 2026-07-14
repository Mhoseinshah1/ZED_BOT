import { prisma, type Product, type User } from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase25-test-secret-phase25-test-secret";

import {
  addStockItem,
  autoDeliverStockOrder,
  disableStockItem,
  getStockCounts,
  isStockDeliveryProduct,
  listStockItems,
  stockContentPreview,
} from "../src/services/other-product-stock.service.js";

// =============================================================================
// Phase 25 stock auto-delivery integration tests. Shared disposable
// PostgreSQL (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

let stockProduct: Product;
let infoStockProduct: Product;
let adminId: string;

function sendRecorder(failAll = false) {
  const calls: Array<{ chatId: string; text: string }> = [];
  return {
    calls,
    api: {
      sendMessage: async (chatId: string, text: string): Promise<unknown> => {
        if (failAll) {
          throw new Error("blocked");
        }
        calls.push({ chatId, text });
        return {};
      },
    },
  };
}

async function createUser(): Promise<User> {
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)) },
  });
}

async function createPaidOrder(user: User, product: Product) {
  return prisma.order.create({
    data: {
      userId: user.id,
      type: "OTHER_PRODUCT",
      status: "PAID",
      productId: product.id,
      finalPriceToman: product.priceToman,
      paidAt: new Date(),
    },
  });
}

async function addItem(product: Product, content: string, label: string | null = null) {
  const outcome = await addStockItem({
    productId: product.id,
    content,
    label,
    createdByAdminId: adminId,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("addStockItem failed");
  return outcome.item;
}

describe.runIf(hasDb)("OTHER_PRODUCT stock auto-delivery (Phase 25)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p25-cat-${runTag}`, isActive: true },
    });
    stockProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `GiftCard-${runTag}`,
        priceToman: 100_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });
    infoStockProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `AppleId-${runTag}`,
        priceToman: 200_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        requiredUserInfoEnabled: true,
        requiredUserInfoPromptText: "ایمیل را بفرستید.",
      },
    });
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 925n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores items ENCRYPTED, validates input and counts statuses", async () => {
    expect(isStockDeliveryProduct(stockProduct)).toBe(true);
    expect(stockContentPreview("CODE-12345678")).toBe("CODE-123…");

    const item = await addItem(stockProduct, "GIFT-AAAA-BBBB-CCCC", "کارت اول");
    expect(item.status).toBe("AVAILABLE");
    expect(item.createdByAdminId).toBe(adminId);
    expect(item.contentEncrypted).not.toContain("GIFT-AAAA");
    expect(decryptSecret(item.contentEncrypted)).toBe("GIFT-AAAA-BBBB-CCCC");

    const badContent = await addStockItem({
      productId: stockProduct.id,
      content: "  ",
      label: null,
      createdByAdminId: adminId,
    });
    expect(badContent.ok).toBe(false);
    const badLabel = await addStockItem({
      productId: stockProduct.id,
      content: "ok-content",
      label: "x".repeat(101),
      createdByAdminId: adminId,
    });
    expect(badLabel.ok).toBe(false);

    const counts = await getStockCounts(stockProduct.id);
    expect(counts.available).toBe(1);
    expect(counts.delivered).toBe(0);
    const page = await listStockItems(stockProduct.id, 1);
    expect(page.items.some((i) => i.id === item.id)).toBe(true);

    // Consume the item so later tests start clean.
    expect(await disableStockItem(item.id)).toBe(true);
    expect((await getStockCounts(stockProduct.id)).disabled).toBe(1);
  });

  it("auto-delivers the OLDEST item once: message, DELIVERED, order COMPLETED", async () => {
    const older = await addItem(stockProduct, `OLD-${runTag}`);
    await addItem(stockProduct, `NEW-${runTag}`);
    const user = await createUser();
    const order = await createPaidOrder(user, stockProduct);

    const { api, calls } = sendRecorder();
    const outcome = await autoDeliverStockOrder(api, order.id);
    expect(outcome.status).toBe("DELIVERED");
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe(user.telegramId.toString());
    expect(calls[0].text).toContain("سفارش شما آماده شد ✅");
    expect(calls[0].text).toContain(stockProduct.name);
    expect(calls[0].text).toContain(`OLD-${runTag}`); // oldest first, full content
    // Naming phase: the reference comes from order identifiers, NEVER content.
    expect(calls[0].text).toContain(
      `شناسه تحویل: <code>ord-${order.id.replace(/-/g, "").slice(0, 8)}</code>`,
    );

    const item = await prisma.otherProductStockItem.findUniqueOrThrow({ where: { id: older.id } });
    expect(item.status).toBe("DELIVERED");
    expect(item.deliveredOrderId).toBe(order.id);
    expect(item.deliveredToUserId).toBe(user.id);
    expect(item.deliveredAt).not.toBeNull();
    const completedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(completedOrder.status).toBe("COMPLETED");
    expect(completedOrder.deliveryReference).toBe(
      `ord-${order.id.replace(/-/g, "").slice(0, 8)}`,
    );

    // No Service and no manual-delivery record for a successful auto-delivery.
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { orderId: order.id } })).toBe(0);

    // Idempotent: a repeat returns ALREADY_DELIVERED and sends nothing.
    const again = await autoDeliverStockOrder(api, order.id);
    expect(again.status).toBe("ALREADY_DELIVERED");
    expect(calls).toHaveLength(1);
  });

  it("NO_STOCK when nothing is AVAILABLE; disabled items are never delivered", async () => {
    // Use up the remaining NEW item.
    const filler = await createUser();
    const fillerOrder = await createPaidOrder(filler, stockProduct);
    expect((await autoDeliverStockOrder(sendRecorder().api, fillerOrder.id)).status).toBe(
      "DELIVERED",
    );

    // Add one and disable it - it must not be delivered.
    const disabled = await addItem(stockProduct, `DISABLED-${runTag}`);
    expect(await disableStockItem(disabled.id)).toBe(true);

    const user = await createUser();
    const order = await createPaidOrder(user, stockProduct);
    const { api, calls } = sendRecorder();
    const outcome = await autoDeliverStockOrder(api, order.id);
    expect(outcome.status).toBe("NO_STOCK");
    expect(calls).toHaveLength(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PAID",
    );
  });

  it("failed send rolls the claim back to AVAILABLE and stays deliverable", async () => {
    const item = await addItem(stockProduct, `RETRY-${runTag}`);
    const user = await createUser();
    const order = await createPaidOrder(user, stockProduct);

    const blocked = await autoDeliverStockOrder(sendRecorder(true).api, order.id);
    expect(blocked.status).toBe("SEND_FAILED");
    const rolled = await prisma.otherProductStockItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(rolled.status).toBe("AVAILABLE");
    expect(rolled.deliveredOrderId).toBeNull();
    expect(rolled.deliveredToUserId).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PAID",
    );

    // A later attempt succeeds with the same item.
    const { api, calls } = sendRecorder();
    expect((await autoDeliverStockOrder(api, order.id)).status).toBe("DELIVERED");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(`RETRY-${runTag}`);
  });

  it("two concurrent orders with ONE item: exactly one delivery, no shared content", async () => {
    const item = await addItem(stockProduct, `RACE-${runTag}`);
    const userA = await createUser();
    const userB = await createUser();
    const orderA = await createPaidOrder(userA, stockProduct);
    const orderB = await createPaidOrder(userB, stockProduct);

    const { api, calls } = sendRecorder();
    const [ra, rb] = await Promise.all([
      autoDeliverStockOrder(api, orderA.id),
      autoDeliverStockOrder(api, orderB.id),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(["DELIVERED", "NO_STOCK"]);
    expect(calls).toHaveLength(1);

    const delivered = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(delivered.status).toBe("DELIVERED");
    // Exactly one of the two orders owns the item.
    expect([orderA.id, orderB.id]).toContain(delivered.deliveredOrderId);
    const winner = delivered.deliveredOrderId === orderA.id ? orderA : orderB;
    const loser = winner.id === orderA.id ? orderB : orderA;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: winner.id } })).status).toBe(
      "COMPLETED",
    );
    expect((await prisma.order.findUniqueOrThrow({ where: { id: loser.id } })).status).toBe(
      "PAID",
    );
  });

  it("requiredUserInfoEnabled products are NOT_ELIGIBLE (manual path instead)", async () => {
    await addItem(infoStockProduct, `INFO-${runTag}`);
    const user = await createUser();
    const order = await createPaidOrder(user, infoStockProduct);
    const { api, calls } = sendRecorder();
    const outcome = await autoDeliverStockOrder(api, order.id);
    expect(outcome.status).toBe("NOT_ELIGIBLE");
    expect(calls).toHaveLength(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PAID",
    );
    expect((await getStockCounts(infoStockProduct.id)).available).toBe(1);
  });
});

describe.skipIf(hasDb)("OTHER_PRODUCT stock auto-delivery (skipped)", () => {
  it("stock integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
