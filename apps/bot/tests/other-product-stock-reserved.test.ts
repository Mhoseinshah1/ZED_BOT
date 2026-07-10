import { prisma, type Product, type User } from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase26-test-secret-phase26-test-secret";

import {
  addStockItem,
  disableReservedStockItem,
  ITEM_DELIVERED_IMMUTABLE_TEXT,
  ITEM_NOT_RESERVED_TEXT,
  ORDER_COMPLETED_IMMUTABLE_TEXT,
  releaseReservedStockItem,
  RESERVED_DISABLED_TEXT,
  RESERVED_RELEASED_TEXT,
} from "../src/services/other-product-stock.service.js";

// =============================================================================
// Phase 26 stuck-RESERVED recovery tests: release/disable a RESERVED stock
// item, guarded by the related Order's status. Shared disposable PostgreSQL
// (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

let product: Product;
let adminId: string;

async function createUser(): Promise<User> {
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)) },
  });
}

async function createOrder(user: User, status: "PAID" | "COMPLETED") {
  return prisma.order.create({
    data: {
      userId: user.id,
      type: "OTHER_PRODUCT",
      status,
      productId: product.id,
      finalPriceToman: product.priceToman,
      paidAt: new Date(),
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });
}

async function createItem(content: string) {
  const outcome = await addStockItem({
    productId: product.id,
    content,
    label: `p26-${runTag}`,
    createdByAdminId: adminId,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("addStockItem failed");
  return outcome.item;
}

/** Fabricates the crash-window state: a claim that never finalized. */
async function createReservedItem(
  content: string,
  opts: { orderStatus?: "PAID" | "COMPLETED"; orderId?: string } = {},
) {
  const user = await createUser();
  const orderId =
    opts.orderId ?? (await createOrder(user, opts.orderStatus ?? "PAID")).id;
  const item = await createItem(content);
  const reserved = await prisma.otherProductStockItem.update({
    where: { id: item.id },
    data: {
      status: "RESERVED",
      deliveredOrderId: orderId,
      deliveredToUserId: user.id,
      deliveredAt: new Date(),
    },
  });
  return { item: reserved, user, orderId };
}

describe.runIf(hasDb)("stuck RESERVED stock recovery (Phase 26)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p26-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `License-${runTag}`,
        priceToman: 150_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 926n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("releases a RESERVED item (PAID order): AVAILABLE, claim cleared, content untouched", async () => {
    const content = `REL-${runTag}-SECRET`;
    const { item, orderId } = await createReservedItem(content);

    const result = await releaseReservedStockItem(item.id);
    expect(result.ok).toBe(true);
    expect(result.safeMessage).toBe(RESERVED_RELEASED_TEXT);
    expect(result.productId).toBe(product.id);

    const after = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(after.status).toBe("AVAILABLE");
    expect(after.deliveredOrderId).toBeNull();
    expect(after.deliveredToUserId).toBeNull();
    expect(after.deliveredAt).toBeNull();
    expect(after.disabledAt).toBeNull();
    // Content and label are untouched - the item is sellable again.
    expect(after.contentEncrypted).toBe(item.contentEncrypted);
    expect(decryptSecret(after.contentEncrypted)).toBe(content);
    expect(after.label).toBe(item.label);
    // The related order was NOT mutated.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "PAID",
    );
  });

  it("disables a RESERVED item (PAID order): DISABLED + disabledAt, claim cleared", async () => {
    const content = `DIS-${runTag}-SECRET`;
    const { item, orderId } = await createReservedItem(content);

    const result = await disableReservedStockItem(item.id);
    expect(result.ok).toBe(true);
    expect(result.safeMessage).toBe(RESERVED_DISABLED_TEXT);
    expect(result.productId).toBe(product.id);

    const after = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(after.status).toBe("DISABLED");
    expect(after.disabledAt).not.toBeNull();
    expect(after.deliveredOrderId).toBeNull();
    expect(after.deliveredToUserId).toBeNull();
    expect(after.deliveredAt).toBeNull();
    expect(after.contentEncrypted).toBe(item.contentEncrypted);
    expect(decryptSecret(after.contentEncrypted)).toBe(content);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "PAID",
    );
  });

  it("refuses to release or disable a DELIVERED item", async () => {
    const user = await createUser();
    const order = await createOrder(user, "COMPLETED");
    const item = await createItem(`DELIVERED-${runTag}`);
    const delivered = await prisma.otherProductStockItem.update({
      where: { id: item.id },
      data: {
        status: "DELIVERED",
        deliveredOrderId: order.id,
        deliveredToUserId: user.id,
        deliveredAt: new Date(),
      },
    });

    for (const action of [releaseReservedStockItem, disableReservedStockItem]) {
      const result = await action(delivered.id);
      expect(result.ok).toBe(false);
      expect(result.safeMessage).toBe(ITEM_DELIVERED_IMMUTABLE_TEXT);
    }
    const after = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: delivered.id },
    });
    expect(after.status).toBe("DELIVERED");
    expect(after.deliveredOrderId).toBe(order.id);
    expect(after.deliveredToUserId).toBe(user.id);
    expect(after.deliveredAt).not.toBeNull();
  });

  it("refuses to release or disable a RESERVED item whose order is COMPLETED", async () => {
    const { item, orderId } = await createReservedItem(`DONE-${runTag}`, {
      orderStatus: "COMPLETED",
    });

    for (const action of [releaseReservedStockItem, disableReservedStockItem]) {
      const result = await action(item.id);
      expect(result.ok).toBe(false);
      expect(result.safeMessage).toBe(ORDER_COMPLETED_IMMUTABLE_TEXT);
    }
    const after = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(after.status).toBe("RESERVED");
    expect(after.deliveredOrderId).toBe(orderId);
  });

  it("releasing an AVAILABLE item is a safe no-op", async () => {
    const item = await createItem(`AVAIL-${runTag}`);

    const released = await releaseReservedStockItem(item.id);
    expect(released.ok).toBe(false);
    expect(released.safeMessage).toBe(ITEM_NOT_RESERVED_TEXT);
    const disabled = await disableReservedStockItem(item.id);
    expect(disabled.ok).toBe(false);
    expect(disabled.safeMessage).toBe(ITEM_NOT_RESERVED_TEXT);

    const after = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(after.status).toBe("AVAILABLE");
    expect(after.disabledAt).toBeNull();
  });

  it("allows release when the claimed order no longer exists (warning path)", async () => {
    // Item points at an order id that was never created.
    const user = await createUser();
    const fabricated = await createOrder(user, "PAID");
    await prisma.order.delete({ where: { id: fabricated.id } });
    const { item } = await createReservedItem(`ORPHAN-${runTag}`, {
      orderId: fabricated.id,
    });

    const result = await releaseReservedStockItem(item.id);
    expect(result.ok).toBe(true);
    expect(result.safeMessage).toBe(RESERVED_RELEASED_TEXT);
    expect(
      (await prisma.otherProductStockItem.findUniqueOrThrow({ where: { id: item.id } }))
        .status,
    ).toBe("AVAILABLE");
  });

  it("never leaks raw content through returned messages", async () => {
    const content = `LEAK-${runTag}-TOPSECRET`;
    const { item } = await createReservedItem(content);

    const messages = [
      (await releaseReservedStockItem(item.id)).safeMessage,
      (await disableReservedStockItem(item.id)).safeMessage, // now AVAILABLE -> not reserved
      (await releaseReservedStockItem("00000000-0000-0000-0000-000000000000")).safeMessage,
    ];
    for (const message of messages) {
      expect(message).not.toContain(content);
      expect(message).not.toContain("TOPSECRET");
      expect(message).not.toContain(item.contentEncrypted);
    }
  });
});

describe.skipIf(hasDb)("stuck RESERVED stock recovery (skipped)", () => {
  it("reserved-stock tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
