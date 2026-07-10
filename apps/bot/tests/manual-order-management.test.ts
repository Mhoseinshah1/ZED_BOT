import { prisma, type Product, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getManualOrderByShortId,
  initManualDelivery,
  listManualOrders,
  searchManualOrders,
} from "../src/services/other-product-delivery.service.js";

// =============================================================================
// Phase 24 manual-order navigation tests: filters, delivered-history
// ordering and search. Uses the shared disposable PostgreSQL
// (docs/testing.md); skips without DATABASE_URL. Other suites create their
// own manual orders in the same database, so assertions are subset-based
// (every returned row matches the filter; MY rows appear where expected).
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const tagText = runTag.toString();

let product: Product;
let infoProduct: Product;
let buyer: User;

interface Made {
  recordId: string;
  orderId: string;
}

async function makeManualOrder(
  user: User,
  prod: Product,
  status: "WAITING_USER_INFO" | "WAITING_ADMIN_DELIVERY" | "DELIVERED",
  extra: { deliveredAt?: Date; adminDeliveryText?: string; deliveredByAdminId?: string } = {},
): Promise<Made> {
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type: "OTHER_PRODUCT",
      status: status === "DELIVERED" ? "COMPLETED" : "PAID",
      productId: prod.id,
      finalPriceToman: prod.priceToman,
      paidAt: new Date(),
    },
  });
  const record = await prisma.otherProductOrder.create({
    data: {
      orderId: order.id,
      userId: user.id,
      productId: prod.id,
      status,
      deliveredAt: extra.deliveredAt ?? null,
      adminDeliveryText: extra.adminDeliveryText ?? null,
      deliveredByAdminId: extra.deliveredByAdminId ?? null,
    },
  });
  return { recordId: record.id, orderId: order.id };
}

describe.runIf(hasDb)("manual order navigation (Phase 24)", () => {
  let infoRec: Made;
  let readyRec: Made;
  let deliveredOld: Made;
  let deliveredNew: Made;
  let adminId: string;

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p24-cat-${tagText}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `SpotifyPremium-${tagText}`,
        priceToman: 150_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
      },
    });
    infoProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `AppleGift-${tagText}`,
        priceToman: 300_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        requiredUserInfoEnabled: true,
        requiredUserInfoPromptText: "ایمیل را بفرستید.",
      },
    });
    buyer = await prisma.user.create({
      data: { telegramId: runTag + 24n, username: `p24buyer${tagText.slice(-6)}` },
    });
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 924n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;

    infoRec = await makeManualOrder(buyer, infoProduct, "WAITING_USER_INFO");
    readyRec = await makeManualOrder(buyer, product, "WAITING_ADMIN_DELIVERY");
    deliveredOld = await makeManualOrder(buyer, product, "DELIVERED", {
      deliveredAt: new Date(Date.now() - 60_000),
      adminDeliveryText: "کد قدیمی",
      deliveredByAdminId: adminId,
    });
    deliveredNew = await makeManualOrder(buyer, product, "DELIVERED", {
      deliveredAt: new Date(),
      adminDeliveryText: "کد جدید",
      deliveredByAdminId: adminId,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("filters return only their statuses and carry counters", async () => {
    const open = await listManualOrders("open", 1);
    expect(open.filter).toBe("open");
    expect(
      open.records.every(
        (r) => r.status === "WAITING_USER_INFO" || r.status === "WAITING_ADMIN_DELIVERY",
      ),
    ).toBe(true);
    const openIds = open.records.map((r) => r.id);
    expect(openIds).toContain(infoRec.recordId);
    expect(openIds).toContain(readyRec.recordId);
    expect(openIds).not.toContain(deliveredNew.recordId);
    expect(open.waitingInfoCount).toBeGreaterThanOrEqual(1);
    expect(open.readyCount).toBeGreaterThanOrEqual(1);
    expect(open.deliveredCount).toBeGreaterThanOrEqual(2);

    const info = await listManualOrders("info", 1);
    expect(info.records.every((r) => r.status === "WAITING_USER_INFO")).toBe(true);
    expect(info.records.map((r) => r.id)).toContain(infoRec.recordId);

    const ready = await listManualOrders("ready", 1);
    expect(ready.records.every((r) => r.status === "WAITING_ADMIN_DELIVERY")).toBe(true);
    expect(ready.records.map((r) => r.id)).toContain(readyRec.recordId);
  });

  it("delivered history sorts by deliveredAt, newest first", async () => {
    const delivered = await listManualOrders("delivered", 1);
    expect(delivered.records.every((r) => r.status === "DELIVERED")).toBe(true);
    const ids = delivered.records.map((r) => r.id);
    const newIdx = ids.indexOf(deliveredNew.recordId);
    const oldIdx = ids.indexOf(deliveredOld.recordId);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it("search finds by manual/order short id, telegram id, username and product name", async () => {
    // Manual-order short id (uuid prefix).
    const byRecordSid = await searchManualOrders(readyRec.recordId.slice(0, 8));
    expect(byRecordSid.map((r) => r.id)).toContain(readyRec.recordId);

    // Parent Order short id.
    const byOrderSid = await searchManualOrders(readyRec.orderId.slice(0, 8));
    expect(byOrderSid.map((r) => r.id)).toContain(readyRec.recordId);

    // Exact telegram id (numeric).
    const byTelegramId = await searchManualOrders((runTag + 24n).toString());
    expect(byTelegramId.length).toBeGreaterThanOrEqual(4);
    expect(byTelegramId.every((r) => r.userId === buyer.id)).toBe(true);

    // Username with and without @, case-insensitive.
    const byUsername = await searchManualOrders(`@P24BUYER${tagText.slice(-6)}`);
    expect(byUsername.some((r) => r.userId === buyer.id)).toBe(true);

    // Product name contains, case-insensitive.
    const byProduct = await searchManualOrders(`spotifypremium-${tagText}`);
    expect(byProduct.length).toBeGreaterThanOrEqual(1);
    expect(byProduct.every((r) => r.productId === product.id)).toBe(true);

    // No result / invalid input.
    expect(await searchManualOrders(`no-such-thing-${tagText}`)).toHaveLength(0);
    expect(await searchManualOrders("")).toHaveLength(0);
    expect(await searchManualOrders("x".repeat(101))).toHaveLength(0);
  });

  it("detail carries category, delivery text, admin id and parent order", async () => {
    const detail = await getManualOrderByShortId(deliveredNew.recordId.slice(0, 8));
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.product.category.name).toBe(`p24-cat-${tagText}`);
    expect(detail.adminDeliveryText).toBe("کد جدید");
    expect(detail.deliveredByAdminId).toBe(adminId);
    expect(detail.deliveredAt).not.toBeNull();
    expect(detail.order.status).toBe("COMPLETED");

    // Garbage short ids never resolve.
    expect(await getManualOrderByShortId("zz!!")).toBeNull();
  });

  it("initManualDelivery still feeds the filters (integration sanity)", async () => {
    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: infoProduct.id,
        finalPriceToman: infoProduct.priceToman,
        paidAt: new Date(),
      },
    });
    const init = await initManualDelivery(order.id);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const info = await listManualOrders("info", 1);
    expect(info.records.map((r) => r.id)).toContain(init.record.id);
  });
});

describe.skipIf(hasDb)("manual order navigation (skipped)", () => {
  it("manual order navigation tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
