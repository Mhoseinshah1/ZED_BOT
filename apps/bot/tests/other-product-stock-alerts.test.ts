import { prisma, type Product, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase28-test-secret-phase28-test-secret";

import {
  addStockItem,
  autoDeliverStockOrder,
  evaluateStockAlert,
  getStockLowThreshold,
  notifyAdminsAboutStockAlert,
  parseThresholdInput,
  setStockLowThreshold,
  STOCK_LOW_ALERT_TITLE,
  STOCK_OUT_ALERT_TITLE,
  STOCK_THRESHOLD_MAX,
  stockAlertLevel,
} from "../src/services/other-product-stock.service.js";

// =============================================================================
// Phase 28 low-stock alerts. Threshold parsing and the alert rule are pure
// (run without a DB); persistence, evaluation and admin notification use the
// shared disposable PostgreSQL (docs/testing.md) and skip without
// DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const STOCKY = { deliveryType: "STOCK_ITEM", stockEnabled: true } as const;
const MANUAL = { deliveryType: null, stockEnabled: false } as const;

describe("parseThresholdInput (Phase 28, pure)", () => {
  it("accepts integers 0..100000 with whitespace and Persian/Arabic digits", () => {
    expect(parseThresholdInput("5")).toEqual({ kind: "set", value: 5 });
    expect(parseThresholdInput(" 0 ")).toEqual({ kind: "set", value: 0 });
    expect(parseThresholdInput("۱۲")).toEqual({ kind: "set", value: 12 });
    expect(parseThresholdInput("٤٢")).toEqual({ kind: "set", value: 42 });
    expect(parseThresholdInput(String(STOCK_THRESHOLD_MAX))).toEqual({
      kind: "set",
      value: STOCK_THRESHOLD_MAX,
    });
  });

  it("clears on '-' and rejects everything else", () => {
    expect(parseThresholdInput(" - ")).toEqual({ kind: "clear" });
    for (const bad of ["", "abc", "3.5", "-2", "1e3", "۵.۵", String(STOCK_THRESHOLD_MAX + 1)]) {
      expect(parseThresholdInput(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("stockAlertLevel (Phase 28, pure)", () => {
  it("missing threshold: none while stocked, out at zero for stock-enabled only", () => {
    expect(stockAlertLevel(STOCKY, 3, null)).toBe("none");
    expect(stockAlertLevel(STOCKY, 0, null)).toBe("out");
    expect(stockAlertLevel(MANUAL, 0, null)).toBe("none");
  });

  it("threshold 0: alert only when stock reaches zero", () => {
    expect(stockAlertLevel(STOCKY, 1, 0)).toBe("none");
    expect(stockAlertLevel(STOCKY, 0, 0)).toBe("out");
    expect(stockAlertLevel(MANUAL, 0, 0)).toBe("out"); // explicit threshold wins
  });

  it("threshold 5: none above, low at/below, out at zero", () => {
    expect(stockAlertLevel(STOCKY, 6, 5)).toBe("none");
    expect(stockAlertLevel(STOCKY, 5, 5)).toBe("low");
    expect(stockAlertLevel(STOCKY, 1, 5)).toBe("low");
    expect(stockAlertLevel(STOCKY, 0, 5)).toBe("out");
  });
});

describe.runIf(hasDb)("stock low-stock alerts (Phase 28)", () => {
  let adminId: string;
  let activeAdminTid: bigint;
  let flakyAdminTid: bigint;
  let inactiveAdminTid: bigint;
  let categoryId: string;

  function recorder(failChatIds: string[] = []) {
    const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
    return {
      calls,
      api: {
        sendMessage: async (
          chatId: string,
          text: string,
          other?: Record<string, unknown>,
        ): Promise<unknown> => {
          if (failChatIds.includes(chatId)) {
            throw new Error("blocked");
          }
          calls.push({ chatId, text, other });
          return {};
        },
      },
    };
  }

  async function createProduct(): Promise<Product> {
    return prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `Alert-${runTag}-${Math.floor(Math.random() * 1_000_000)}`,
        priceToman: 100_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });
  }

  async function addItems(product: Product, contents: string[]): Promise<void> {
    for (const content of contents) {
      const outcome = await addStockItem({
        productId: product.id,
        content,
        label: null,
        createdByAdminId: adminId,
      });
      expect(outcome.ok).toBe(true);
    }
  }

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p28-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    activeAdminTid = runTag + 928n;
    flakyAdminTid = runTag + 929n;
    inactiveAdminTid = runTag + 930n;
    const admin = await prisma.admin.create({
      data: { telegramId: activeAdminTid, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
    await prisma.admin.create({
      data: { telegramId: flakyAdminTid, role: "OWNER", isActive: true },
    });
    await prisma.admin.create({
      data: { telegramId: inactiveAdminTid, role: "OWNER", isActive: false },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("set/clear threshold persists through the Setting row", async () => {
    const product = await createProduct();
    const key = `stock.low_threshold.${product.id}`;

    await setStockLowThreshold(product.id, 7);
    expect((await prisma.setting.findUnique({ where: { key } }))?.value).toBe("7");
    expect(await getStockLowThreshold(product.id)).toBe(7);

    await setStockLowThreshold(product.id, 0);
    expect(await getStockLowThreshold(product.id)).toBe(0);

    await setStockLowThreshold(product.id, null);
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
    expect(await getStockLowThreshold(product.id)).toBeNull();
  });

  it("evaluateStockAlert applies the threshold matrix against real counts", async () => {
    const product = await createProduct();
    // No threshold, no items -> out (stock-enabled).
    expect(await evaluateStockAlert(product.id)).toEqual({
      level: "out",
      available: 0,
      threshold: null,
    });
    await addItems(product, [`E1-${runTag}`, `E2-${runTag}`, `E3-${runTag}`]);
    expect((await evaluateStockAlert(product.id)).level).toBe("none");

    await setStockLowThreshold(product.id, 3);
    expect(await evaluateStockAlert(product.id)).toEqual({
      level: "low",
      available: 3,
      threshold: 3,
    });
    await setStockLowThreshold(product.id, 2);
    expect((await evaluateStockAlert(product.id)).level).toBe("none");

    // Missing product -> none.
    expect(
      (await evaluateStockAlert("00000000-0000-0000-0000-000000000000")).level,
    ).toBe("none");
  });

  it("notifies active admins only, with counts/buttons and no raw content", async () => {
    const product = await createProduct();
    await setStockLowThreshold(product.id, 5);
    const secret = `ALERT-${runTag}-TOPSECRET`;
    await addItems(product, [secret, `${secret}-2`, `${secret}-3`]);

    const { api, calls } = recorder();
    const reached = await notifyAdminsAboutStockAlert(api, {
      productId: product.id,
      orderId: "abcdef12-3456-7890-abcd-ef1234567890",
    });

    expect(reached).toBe(calls.length);
    const chatIds = calls.map((c) => c.chatId);
    expect(chatIds).toContain(activeAdminTid.toString());
    expect(chatIds).not.toContain(inactiveAdminTid.toString());

    for (const call of calls) {
      expect(call.text).toContain(STOCK_LOW_ALERT_TITLE);
      expect(call.text).toContain(product.name);
      expect(call.text).toContain("موجودی فعلی: 3");
      expect(call.text).toContain("حد هشدار: ≤ 5");
      expect(call.text).toContain("سفارش: <code>abcdef12</code>");
      expect(call.text).not.toContain(secret);
      const keyboard = JSON.stringify(call.other?.reply_markup ?? {});
      expect(keyboard).toContain(`admin:stock:p:${product.id.slice(0, 8)}`);
      expect(keyboard).toContain(`admin:stock:bulk_add:${product.id.slice(0, 8)}`);
    }
  });

  it("one failing admin does not block the others", async () => {
    const product = await createProduct(); // no items -> out
    const { api, calls } = recorder([flakyAdminTid.toString()]);
    const reached = await notifyAdminsAboutStockAlert(api, { productId: product.id });

    expect(reached).toBe(calls.length);
    expect(reached).toBeGreaterThanOrEqual(1);
    const chatIds = calls.map((c) => c.chatId);
    expect(chatIds).toContain(activeAdminTid.toString());
    expect(chatIds).not.toContain(flakyAdminTid.toString());
    for (const call of calls) {
      expect(call.text).toContain(STOCK_OUT_ALERT_TITLE);
    }
  });

  it("healthy stock sends nothing", async () => {
    const product = await createProduct();
    await addItems(product, [`H1-${runTag}`]);
    const { api, calls } = recorder();
    expect(await notifyAdminsAboutStockAlert(api, { productId: product.id })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("delivering the last item triggers the out-of-stock alert (post-delivery hook)", async () => {
    const product = await createProduct();
    const secret = `LAST-${runTag}-SECRET`;
    await addItems(product, [secret]);
    const user: User = await prisma.user.create({
      data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)) },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: product.id,
        finalPriceToman: product.priceToman,
        paidAt: new Date(),
      },
    });

    const delivery = recorder();
    expect((await autoDeliverStockOrder(delivery.api, order.id)).status).toBe("DELIVERED");
    expect(delivery.calls).toHaveLength(1); // buyer only - the alert is a separate call

    // What the receipts.handler hook does right after a fresh DELIVERED:
    const alert = recorder();
    const reached = await notifyAdminsAboutStockAlert(alert.api, {
      productId: product.id,
      orderId: order.id,
    });
    expect(reached).toBeGreaterThanOrEqual(1);
    const buyerIds = alert.calls.map((c) => c.chatId);
    expect(buyerIds).not.toContain(user.telegramId.toString());
    for (const call of alert.calls) {
      expect(call.text).toContain(STOCK_OUT_ALERT_TITLE);
      expect(call.text).toContain("موجودی فعلی: 0");
      expect(call.text).toContain(`سفارش: <code>${order.id.slice(0, 8)}</code>`);
      expect(call.text).not.toContain(secret);
    }
  });
});

describe.skipIf(hasDb)("stock low-stock alerts (skipped)", () => {
  it("alert integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
