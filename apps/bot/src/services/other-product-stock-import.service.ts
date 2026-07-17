import { Prisma, prisma, type OtherProductStockParser } from "@zedbot/database";
import {
  encryptSecret,
  errorMessage,
  fingerprintSecret,
  maskSecretEdges,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  maskEmail,
  parseInventoryByParser,
  type InventoryItem,
} from "./apple-id-stock-parser.service.js";

// =============================================================================
// Specialized-workflows phase: bulk stock import with fingerprint dedup.
//
// Flow: the admin pastes the inventory -> previewStockImport parses it and
// reports counts + masked first/last identifiers -> the admin confirms ->
// importStockItems re-parses THE SAME draft text (kept in the admin's bot
// session) and inserts everything in one all-or-nothing createMany. The
// preview is deliberately STATELESS: nothing is stashed server-side and no
// import token is issued - the confirm step re-validates from scratch, so a
// stale preview can never import content the admin did not just see counted.
//
// Duplicate detection uses OtherProductStockItem.contentFingerprint - a
// deterministic keyed HMAC of the normalized plaintext (fingerprintSecret) -
// so duplicates are found WITHOUT decrypting, logging or exposing content,
// both within the pasted batch and against existing rows. The DB unique
// (productId, contentFingerprint) is the final authority: a P2002 during
// import aborts the WHOLE batch (no partial import). Legacy rows carry a
// null fingerprint and are invisible to dedup (documented in the schema).
//
// No secrets anywhere: results carry counts and masked previews only; raw
// content, passwords and full emails never appear in returns or logs.
// =============================================================================

export const IMPORT_PRODUCT_NOT_FOUND_TEXT = "مورد یافت نشد.";
export const IMPORT_DUPLICATE_EXISTING_TEXT =
  "برخی آیتم‌ها قبلاً در موجودی این محصول ثبت شده‌اند؛ موارد تکراری را حذف کنید و دوباره تلاش کنید.";
export const IMPORT_FAILED_TEXT = "ثبت گروهی آیتم‌ها ناموفق بود. دوباره تلاش کنید.";

export interface StockImportPreview {
  ok: boolean;
  /** Unique importable items (batch duplicates collapsed). */
  itemCount: number;
  /** Masked identifier of the first/last item - never raw content. */
  maskedFirst: string | null;
  maskedLast: string | null;
  invalidLineCount: number;
  /** Repeated items WITHIN this paste (first occurrence kept on import). */
  batchDuplicateCount: number;
  /** Unique items that already exist in this product's inventory (blocking). */
  existingDuplicateCount: number;
  warnings: string[];
  errors: string[];
  /**
   * Always undefined: the preview is stateless by design - the confirm step
   * re-parses the admin's session draft instead of redeeming a token.
   */
  importToken?: string;
}

export interface StockImportResult {
  ok: boolean;
  importedCount: number;
  errors: string[];
}

/** Masked one-line identifier of one parsed item - never the raw content. */
function maskedItemIdentifier(item: InventoryItem): string {
  if (item.boundaryEmail !== null) {
    return maskEmail(item.boundaryEmail);
  }
  const firstLine = item.content.split("\n", 1)[0];
  return maskSecretEdges(firstLine);
}

interface FingerprintedBatch {
  /** Unique items in first-occurrence order, keyed work list for insert. */
  unique: Array<{ item: InventoryItem; fingerprint: string }>;
  batchDuplicateCount: number;
}

/** Fingerprints the parsed items and collapses in-batch duplicates. */
function fingerprintBatch(items: InventoryItem[]): FingerprintedBatch {
  const seen = new Set<string>();
  const unique: Array<{ item: InventoryItem; fingerprint: string }> = [];
  let batchDuplicateCount = 0;
  for (const item of items) {
    const fingerprint = fingerprintSecret(item.content);
    if (seen.has(fingerprint)) {
      batchDuplicateCount += 1;
      continue;
    }
    seen.add(fingerprint);
    unique.push({ item, fingerprint });
  }
  return { unique, batchDuplicateCount };
}

/** Fingerprints already present in this product's inventory. */
async function findExistingFingerprints(
  productId: string,
  fingerprints: string[],
): Promise<Set<string>> {
  if (fingerprints.length === 0) {
    return new Set();
  }
  const rows = await prisma.otherProductStockItem.findMany({
    where: { productId, contentFingerprint: { in: fingerprints } },
    select: { contentFingerprint: true },
  });
  return new Set(
    rows
      .map((row) => row.contentFingerprint)
      .filter((fingerprint): fingerprint is string => fingerprint !== null),
  );
}

function failedPreview(errors: string[], warnings: string[] = [], invalidLineCount = 0): StockImportPreview {
  return {
    ok: false,
    itemCount: 0,
    maskedFirst: null,
    maskedLast: null,
    invalidLineCount,
    batchDuplicateCount: 0,
    existingDuplicateCount: 0,
    warnings,
    errors,
  };
}

/**
 * Parses one inventory paste and reports what a confirmed import would do:
 * item count, masked first/last identifiers, invalid lines, duplicates
 * within the batch and against existing rows. Existing duplicates are a
 * BLOCKING error (the import would abort on the DB unique anyway); batch
 * duplicates are informational (import keeps the first occurrence). Never
 * returns content; stashes nothing server-side.
 */
export async function previewStockImport(
  productId: string,
  parser: OtherProductStockParser,
  raw: string,
): Promise<StockImportPreview> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (product === null || product.type !== "OTHER_PRODUCT") {
    return failedPreview([IMPORT_PRODUCT_NOT_FOUND_TEXT]);
  }
  const parsed = parseInventoryByParser(parser, raw);
  if (!parsed.ok) {
    return failedPreview(parsed.errors, parsed.warnings, parsed.invalidLineCount);
  }

  const { unique, batchDuplicateCount } = fingerprintBatch(parsed.items);
  const existing = await findExistingFingerprints(
    product.id,
    unique.map((entry) => entry.fingerprint),
  );
  const existingDuplicateCount = unique.filter((entry) => existing.has(entry.fingerprint)).length;

  const errors: string[] = [];
  if (existingDuplicateCount > 0) {
    errors.push(IMPORT_DUPLICATE_EXISTING_TEXT);
  }
  const first = unique.at(0);
  const last = unique.at(-1);
  return {
    ok: errors.length === 0,
    itemCount: unique.length,
    maskedFirst: first !== undefined ? maskedItemIdentifier(first.item) : null,
    maskedLast: last !== undefined ? maskedItemIdentifier(last.item) : null,
    invalidLineCount: parsed.invalidLineCount,
    batchDuplicateCount,
    existingDuplicateCount,
    warnings: parsed.warnings,
    errors,
  };
}

/**
 * Confirmed import: re-parses and re-validates the draft text (the preview
 * held no server-side state), then inserts every unique item in ONE
 * $transaction createMany - all-or-nothing. Items are stored encrypted with
 * their fingerprint; APPLE_ID-style items (email-boundary parser) get the
 * MASKED email as their admin-visible label, everything else gets null. A
 * P2002 on (productId, contentFingerprint) - a concurrent import or an item
 * added since the preview - aborts the whole batch with a duplicate error:
 * no partial import, ever.
 */
export async function importStockItems(
  productId: string,
  adminId: string,
  parser: OtherProductStockParser,
  raw: string,
): Promise<StockImportResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (product === null || product.type !== "OTHER_PRODUCT") {
    return { ok: false, importedCount: 0, errors: [IMPORT_PRODUCT_NOT_FOUND_TEXT] };
  }
  const parsed = parseInventoryByParser(parser, raw);
  if (!parsed.ok) {
    return { ok: false, importedCount: 0, errors: parsed.errors };
  }
  const { unique } = fingerprintBatch(parsed.items);
  if (unique.length === 0) {
    return { ok: false, importedCount: 0, errors: [IMPORT_FAILED_TEXT] };
  }

  try {
    const [created] = await prisma.$transaction([
      prisma.otherProductStockItem.createMany({
        data: unique.map(({ item, fingerprint }) => ({
          productId: product.id,
          status: "AVAILABLE" as const,
          contentEncrypted: encryptSecret(item.content),
          contentFingerprint: fingerprint,
          label: item.boundaryEmail !== null ? maskEmail(item.boundaryEmail) : null,
          createdByAdminId: adminId,
        })),
      }),
    ]);
    logger.info("stock items imported", {
      productId: product.id,
      parser,
      count: created.count,
    });
    return { ok: true, importedCount: created.count, errors: [] };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // The (productId, contentFingerprint) unique fired: at least one item
      // already exists. All-or-nothing - the transaction rolled everything
      // back; report the duplicate without any content.
      logger.warn("stock import aborted on duplicate fingerprint", {
        productId: product.id,
        parser,
        requested: unique.length,
      });
      return { ok: false, importedCount: 0, errors: [IMPORT_DUPLICATE_EXISTING_TEXT] };
    }
    logger.error("stock import failed", {
      productId: product.id,
      parser,
      requested: unique.length,
      error: errorMessage(error),
    });
    return { ok: false, importedCount: 0, errors: [IMPORT_FAILED_TEXT] };
  }
}
