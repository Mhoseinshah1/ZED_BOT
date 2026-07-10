import { prisma, type Product } from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase27-test-secret-phase27-test-secret";

import {
  addStockItemsBulk,
  BULK_NO_VALID_ITEMS_TEXT,
  BULK_TOO_MANY_TEXT,
  parseBulkStockInput,
  STOCK_BULK_MAX_ITEMS,
  STOCK_CONTENT_MAX,
} from "../src/services/other-product-stock.service.js";

// =============================================================================
// Phase 27 bulk stock creation. The parser is pure (runs without a DB); the
// creation tests use the shared disposable PostgreSQL (docs/testing.md) and
// skip without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

describe("parseBulkStockInput (Phase 27, pure)", () => {
  it("trims lines, skips empty lines and keeps input order", () => {
    const parsed = parseBulkStockInput("  code-a  \n\n\t\ncode-b\n   \ncode-c");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual(["code-a", "code-b", "code-c"]);
    expect(parsed.invalidCount).toBe(0);
    expect(parsed.duplicateCount).toBe(0);
  });

  it("handles CRLF input", () => {
    const parsed = parseBulkStockInput("one\r\ntwo\r\nthree");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual(["one", "two", "three"]);
  });

  it("detects in-batch duplicates after trim, keeping the first occurrence", () => {
    const parsed = parseBulkStockInput("dup\nunique\n  dup  \ndup");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual(["dup", "unique"]);
    expect(parsed.duplicateCount).toBe(2);
  });

  it("counts over-length lines as invalid without dropping the rest", () => {
    const tooLong = "x".repeat(STOCK_CONTENT_MAX + 1);
    const atLimit = "y".repeat(STOCK_CONTENT_MAX);
    const parsed = parseBulkStockInput(`ok-1\n${tooLong}\n${atLimit}\n${tooLong}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual(["ok-1", atLimit]);
    expect(parsed.invalidCount).toBe(2);
  });

  it("fails safely when nothing valid remains", () => {
    for (const text of ["", "\n\n  \n", "z".repeat(STOCK_CONTENT_MAX + 1)]) {
      const parsed = parseBulkStockInput(text);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.safeMessage).toBe(BULK_NO_VALID_ITEMS_TEXT);
    }
  });

  it(`rejects more than ${STOCK_BULK_MAX_ITEMS} valid unique items`, () => {
    const atCap = Array.from({ length: STOCK_BULK_MAX_ITEMS }, (_, i) => `item-${i}`);
    expect(parseBulkStockInput(atCap.join("\n")).ok).toBe(true);
    const overCap = parseBulkStockInput([...atCap, "one-more"].join("\n"));
    expect(overCap.ok).toBe(false);
    if (overCap.ok) return;
    expect(overCap.safeMessage).toBe(BULK_TOO_MANY_TEXT);
  });
});

describe.runIf(hasDb)("addStockItemsBulk (Phase 27)", () => {
  let product: Product;
  let serviceProduct: Product;
  let adminId: string;

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p27-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `Voucher-${runTag}`,
        priceToman: 120_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });
    const serviceCategory = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `p27-svc-cat-${runTag}`, isActive: true },
    });
    serviceProduct = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: serviceCategory.id,
        name: `Vpn-${runTag}`,
        priceToman: 90_000,
        isActive: true,
      },
    });
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 927n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates N AVAILABLE encrypted items with null label and the admin id", async () => {
    const contents = [`BULK-A-${runTag}`, `BULK-B-${runTag}`, `BULK-C-${runTag}`];
    const outcome = await addStockItemsBulk({
      productId: product.id,
      contents,
      createdByAdminId: adminId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdCount).toBe(3);

    const rows = await prisma.otherProductStockItem.findMany({
      where: { productId: product.id },
    });
    expect(rows).toHaveLength(3);
    const decrypted = rows.map((row) => decryptSecret(row.contentEncrypted)).sort();
    expect(decrypted).toEqual([...contents].sort());
    for (const row of rows) {
      expect(row.status).toBe("AVAILABLE");
      expect(row.label).toBeNull();
      expect(row.createdByAdminId).toBe(adminId);
      for (const content of contents) {
        expect(row.contentEncrypted).not.toContain(content);
      }
    }
  });

  it("re-trims and re-dedupes defensively before creating", async () => {
    const outcome = await addStockItemsBulk({
      productId: product.id,
      contents: [`  DEF-${runTag}  `, `DEF-${runTag}`, "", "   "],
      createdByAdminId: adminId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.createdCount).toBe(1);
  });

  it("fails safely for a missing or non-OTHER_PRODUCT product (nothing created)", async () => {
    const before = await prisma.otherProductStockItem.count();
    for (const productId of ["00000000-0000-0000-0000-000000000000", serviceProduct.id]) {
      const outcome = await addStockItemsBulk({
        productId,
        contents: [`GHOST-${runTag}`],
        createdByAdminId: adminId,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.safeMessage).toBe("مورد یافت نشد.");
    }
    expect(await prisma.otherProductStockItem.count()).toBe(before);
  });

  it("rejects empty and over-cap batches at the service level too", async () => {
    const empty = await addStockItemsBulk({
      productId: product.id,
      contents: [],
      createdByAdminId: adminId,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.safeMessage).toBe(BULK_NO_VALID_ITEMS_TEXT);

    const overCap = await addStockItemsBulk({
      productId: product.id,
      contents: Array.from({ length: STOCK_BULK_MAX_ITEMS + 1 }, (_, i) => `cap-${i}`),
      createdByAdminId: adminId,
    });
    expect(overCap.ok).toBe(false);
    if (overCap.ok) return;
    expect(overCap.safeMessage).toBe(BULK_TOO_MANY_TEXT);
  });

  it("never leaks raw content through safe messages", async () => {
    const secret = `LEAK-${runTag}-BULKSECRET`;
    const outcomes = [
      await addStockItemsBulk({
        productId: "00000000-0000-0000-0000-000000000000",
        contents: [secret],
        createdByAdminId: adminId,
      }),
      await addStockItemsBulk({
        productId: product.id,
        contents: Array.from({ length: STOCK_BULK_MAX_ITEMS + 1 }, (_, i) => `${secret}-${i}`),
        createdByAdminId: adminId,
      }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.safeMessage).not.toContain(secret);
      expect(outcome.safeMessage).not.toContain("BULKSECRET");
    }
  });
});

describe.skipIf(hasDb)("addStockItemsBulk (skipped)", () => {
  it("bulk-create tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
