import { prisma, type Admin, type Product } from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "apple-id-parser-tests-secret-0001";

import {
  INVENTORY_BLOCK_MAX_CHARS,
  INVENTORY_MAX_ITEMS,
  INVENTORY_TOO_LONG_TEXT,
  INVENTORY_TOO_MANY_TEXT,
  INVENTORY_TOTAL_MAX_CHARS,
  maskEmail,
  parseAppleIdInventory,
} from "../src/services/apple-id-stock-parser.service.js";
import {
  IMPORT_DUPLICATE_EXISTING_TEXT,
  importStockItems,
  previewStockImport,
} from "../src/services/other-product-stock-import.service.js";

// =============================================================================
// Specialized-workflows phase - Apple-ID inventory parser (EMAIL_BOUNDARY)
// and the fingerprint-dedup preview/import pipeline on top of it. The pure
// parser tests need no DB; the preview/import tests run against the shared
// test PostgreSQL (docs/testing.md) and clean up after themselves.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const PASSWORD_A = "Sup3rSecretPass-A!";
const PASSWORD_B = "An0therSecret-B#";
const EMAIL_A = `apple.a.${runTag}@icloud.com`;
const EMAIL_B = `apple.b.${runTag}@icloud.com`;

function block(email: string, password: string): string {
  return `${email}\nPassword: ${password}\nQuestion: pet name`;
}

// --- pure parser ----------------------------------------------------------------------------

describe("Apple-ID inventory parser (pure)", () => {
  it("parses a single account block; the boundary line stays in the content", () => {
    const result = parseAppleIdInventory(block(EMAIL_A, PASSWORD_A));
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].boundaryEmail).toBe(EMAIL_A);
    expect(result.items[0].content).toBe(
      `${EMAIL_A}\nPassword: ${PASSWORD_A}\nQuestion: pet name`,
    );
  });

  it("splits multiple accounts on full-line email boundaries", () => {
    const raw = `${block(EMAIL_A, PASSWORD_A)}\n${block(EMAIL_B, PASSWORD_B)}`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.boundaryEmail)).toEqual([EMAIL_A, EMAIL_B]);
    expect(result.items[0].content).not.toContain(EMAIL_B);
    expect(result.items[1].content).toContain(PASSWORD_B);
  });

  it("normalizes CRLF line endings", () => {
    const raw = `${EMAIL_A}\r\nPassword: ${PASSWORD_A}\r\n\r\n${EMAIL_B}\r\nPassword: ${PASSWORD_B}\r\n`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].content).toBe(`${EMAIL_A}\nPassword: ${PASSWORD_A}`);
    expect(result.items[0].content).not.toContain("\r");
  });

  it("preserves internal blank lines while trimming record edges", () => {
    const raw = `\n\n${EMAIL_A}\nline one\n\nline after gap\n\n`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toBe(`${EMAIL_A}\nline one\n\nline after gap`);
  });

  it("accepts explicit Email:/ایمیل: labeled boundary lines", () => {
    const raw = [
      `Email: ${EMAIL_A}`,
      `Password: ${PASSWORD_A}`,
      `ایمیل: ${EMAIL_B}`,
      `Password: ${PASSWORD_B}`,
    ].join("\n");
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.boundaryEmail)).toEqual([EMAIL_A, EMAIL_B]);
    // The labeled line itself stays inside the record content.
    expect(result.items[0].content.startsWith(`Email: ${EMAIL_A}`)).toBe(true);
  });

  it("rejects the WHOLE paste when content precedes the first email boundary", () => {
    const raw = `stray note line\n${block(EMAIL_A, PASSWORD_A)}`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.invalidLineCount).toBe(1);
  });

  it("does not treat an invalid email-looking line as a boundary", () => {
    const raw = `${EMAIL_A}\nrecovery: broken@nodot\nPassword: ${PASSWORD_A}`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toContain("broken@nodot");
  });

  it("never splits on an email embedded inside a longer sentence (warns instead)", () => {
    const raw = `${EMAIL_A}\nrescue address is ${EMAIL_B} for recovery\nPassword: ${PASSWORD_A}`;
    const result = parseAppleIdInventory(raw);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].boundaryEmail).toBe(EMAIL_A);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects empty blocks and over-long blocks, with masked identifiers only", () => {
    const emptyBlock = parseAppleIdInventory(`${EMAIL_A}\n\n${block(EMAIL_B, PASSWORD_B)}`);
    expect(emptyBlock.ok).toBe(false);
    expect(emptyBlock.items).toEqual([]);
    expect(emptyBlock.errors.join("\n")).toContain(maskEmail(EMAIL_A));
    expect(emptyBlock.errors.join("\n")).not.toContain(EMAIL_A);

    const oversized = parseAppleIdInventory(`${EMAIL_A}\n${"x".repeat(INVENTORY_BLOCK_MAX_CHARS + 10)}`);
    expect(oversized.ok).toBe(false);
    expect(oversized.errors.join("\n")).toContain(maskEmail(EMAIL_A));
  });

  it("rejects oversized batches: too many accounts and too many total characters", () => {
    const many = Array.from(
      { length: INVENTORY_MAX_ITEMS + 1 },
      (_, i) => `bulk${i}.${runTag}@icloud.com\npass-${i}`,
    ).join("\n");
    const tooMany = parseAppleIdInventory(many);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.errors).toContain(INVENTORY_TOO_MANY_TEXT);

    const tooLong = parseAppleIdInventory("y".repeat(INVENTORY_TOTAL_MAX_CHARS + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors).toEqual([INVENTORY_TOO_LONG_TEXT]);
  });
});

// --- preview / import against the DB --------------------------------------------------------

describe.runIf(hasDb)("Apple-ID stock import (fingerprint dedup)", () => {
  let admin: Admin;
  let product: Product;
  let categoryId: string;

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `aip-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 910_000_000n, role: "OWNER", isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `aip-apple-${runTag}`,
        priceToman: 150_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        otherProductKind: "APPLE_ID",
        otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
        otherProductStockParser: "EMAIL_BOUNDARY",
      },
    });
  });

  afterAll(async () => {
    await prisma.otherProductStockItem.deleteMany({ where: { productId: product.id } });
    await prisma.product.deleteMany({ where: { id: product.id } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await prisma.$disconnect();
  });

  it("preview collapses batch duplicates and reports masked identifiers only", async () => {
    const raw = [block(EMAIL_A, PASSWORD_A), block(EMAIL_A, PASSWORD_A), block(EMAIL_B, PASSWORD_B)].join(
      "\n",
    );
    const preview = await previewStockImport(product.id, "EMAIL_BOUNDARY", raw);
    expect(preview.ok).toBe(true);
    expect(preview.itemCount).toBe(2);
    expect(preview.batchDuplicateCount).toBe(1);
    expect(preview.existingDuplicateCount).toBe(0);
    expect(preview.maskedFirst).toBe(maskEmail(EMAIL_A));
    expect(preview.maskedLast).toBe(maskEmail(EMAIL_B));
    // Stateless by design: no server-side token is ever issued.
    expect(preview.importToken).toBeUndefined();
  });

  it("imports unique items encrypted with masked labels; duplicates then block the next preview", async () => {
    const raw = [block(EMAIL_A, PASSWORD_A), block(EMAIL_B, PASSWORD_B)].join("\n");
    const result = await importStockItems(product.id, admin.id, "EMAIL_BOUNDARY", raw);
    expect(result.ok).toBe(true);
    expect(result.importedCount).toBe(2);

    const items = await prisma.otherProductStockItem.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "asc" },
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.status).toBe("AVAILABLE");
      expect(item.contentFingerprint).not.toBeNull();
      expect(item.contentEncrypted).not.toContain(PASSWORD_A);
      expect(item.contentEncrypted).not.toContain(PASSWORD_B);
      expect(item.contentEncrypted).not.toContain(EMAIL_A);
    }
    expect(items.map((i) => i.label).sort()).toEqual(
      [maskEmail(EMAIL_A), maskEmail(EMAIL_B)].sort(),
    );
    // createMany rows share one createdAt (and A/B mask identically), so
    // resolve item A by decrypting instead of relying on order or label.
    const decrypted = items.map((i) => decryptSecret(i.contentEncrypted));
    const contentA = decrypted.find((c) => c.startsWith(EMAIL_A));
    expect(contentA).toBeDefined();
    expect(contentA).toContain(PASSWORD_A);

    // Existing duplicates are a BLOCKING preview error.
    const dupPreview = await previewStockImport(
      product.id,
      "EMAIL_BOUNDARY",
      block(EMAIL_A, PASSWORD_A),
    );
    expect(dupPreview.ok).toBe(false);
    expect(dupPreview.existingDuplicateCount).toBe(1);
    expect(dupPreview.errors).toContain(IMPORT_DUPLICATE_EXISTING_TEXT);
  });

  it("import is all-or-nothing: one existing duplicate in the batch adds ZERO rows", async () => {
    const before = await prisma.otherProductStockItem.count({ where: { productId: product.id } });
    const freshEmail = `apple.c.${runTag}@icloud.com`;
    const raw = [block(EMAIL_A, PASSWORD_A), block(freshEmail, "BrandNewSecret-C$")].join("\n");
    const result = await importStockItems(product.id, admin.id, "EMAIL_BOUNDARY", raw);
    expect(result.ok).toBe(false);
    expect(result.importedCount).toBe(0);
    expect(result.errors).toContain(IMPORT_DUPLICATE_EXISTING_TEXT);
    const after = await prisma.otherProductStockItem.count({ where: { productId: product.id } });
    expect(after).toBe(before);
  });

  it("no password or full-email leakage in stringified preview/import results or parse errors", async () => {
    const okPreview = await previewStockImport(
      product.id,
      "EMAIL_BOUNDARY",
      block(`apple.d.${runTag}@icloud.com`, PASSWORD_A),
    );
    const dupImport = await importStockItems(
      product.id,
      admin.id,
      "EMAIL_BOUNDARY",
      block(EMAIL_A, PASSWORD_A),
    );
    // A parse failure that still carries the password in its input.
    const failedParse = parseAppleIdInventory(`stray\n${block(EMAIL_B, PASSWORD_B)}`);
    for (const payload of [okPreview, dupImport, failedParse]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(PASSWORD_A);
      expect(text).not.toContain(PASSWORD_B);
      expect(text).not.toContain(EMAIL_A);
      expect(text).not.toContain(EMAIL_B);
      expect(text).not.toContain(`apple.d.${runTag}@icloud.com`);
    }
  });
});

describe.skipIf(hasDb)("Apple-ID stock import (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
