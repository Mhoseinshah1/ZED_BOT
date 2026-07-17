import type { OtherProductStockParser } from "@zedbot/database";

// =============================================================================
// Specialized-workflows phase: PURE inventory parsers (no DB, no logging).
//
// Admins paste whole inventories in one message; these parsers split the
// paste into stock-item blocks according to the product's configured
// OtherProductStockParser:
//
//   EMAIL_BOUNDARY     - Apple-ID style: a line that IS a complete email
//                        address (or a full-line `Email: addr` / `ایمیل: addr`
//                        form) starts a new account record; everything until
//                        the next boundary belongs to that record. Embedded
//                        emails inside longer sentences never split.
//   EXPLICIT_SEPARATOR - blocks split on lines that are exactly `---`.
//   SINGLE_LINE        - one non-empty trimmed line per item (legacy
//                        parseBulkStockInput semantics; duplicates are NOT
//                        collapsed here - fingerprint-level dedup happens in
//                        other-product-stock-import.service.ts).
//
// Raw content never appears in errors/warnings - identifying emails are
// masked with maskEmail. Any `errors` entry rejects the WHOLE paste
// (ok: false, items: []) so a partial/ambiguous inventory is never imported.
// =============================================================================

export const INVENTORY_TOTAL_MAX_CHARS = 200_000;
export const INVENTORY_MAX_ITEMS = 500;
export const INVENTORY_BLOCK_MAX_CHARS = 4_000;

export const INVENTORY_TOO_LONG_TEXT = `حجم متن بیش از حد مجاز (${INVENTORY_TOTAL_MAX_CHARS.toLocaleString("en-US")} کاراکتر) است.`;
export const INVENTORY_EMPTY_TEXT = "هیچ محتوایی در متن پیدا نشد.";
export const INVENTORY_TOO_MANY_TEXT = `حداکثر ${INVENTORY_MAX_ITEMS} آیتم در هر مرحله قابل ثبت است.`;

/** One parsed stock block. boundaryEmail is set by EMAIL_BOUNDARY only. */
export interface InventoryItem {
  content: string;
  boundaryEmail: string | null;
}

export interface InventoryParseResult {
  ok: boolean;
  items: InventoryItem[];
  invalidLineCount: number;
  warnings: string[];
  errors: string[];
}

export interface AppleIdInventoryItem {
  content: string;
  boundaryEmail: string;
}

export interface AppleIdInventoryResult extends InventoryParseResult {
  items: AppleIdInventoryItem[];
}

// Strict full-line email: the ENTIRE trimmed line must be one address.
const STRICT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// Full-line labeled forms: `Email: addr` / `ایمیل: addr` (any label casing).
const LABELED_EMAIL_PATTERN = /^(?:email|ایمیل)\s*[:：]\s*(.+)$/i;
// Loose "contains an email" check for the embedded-email warning only.
const EMBEDDED_EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** a***z@d***.tld style preview mask - never the full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMasked =
    local.length >= 2 ? `${local[0]}***${local[local.length - 1]}` : `${local}***`;
  const dot = domain.lastIndexOf(".");
  const domainMasked =
    dot > 0 ? `${domain[0]}***.${domain.slice(dot + 1)}` : `${domain[0] ?? ""}***`;
  return `${localMasked}@${domainMasked}`;
}

/** The boundary email of a trimmed line, or null when it is not a boundary. */
function detectBoundaryEmail(trimmedLine: string): string | null {
  if (STRICT_EMAIL_PATTERN.test(trimmedLine)) {
    return trimmedLine;
  }
  const labeled = LABELED_EMAIL_PATTERN.exec(trimmedLine);
  if (labeled !== null) {
    const address = labeled[1].trim();
    if (STRICT_EMAIL_PATTERN.test(address)) {
      return address;
    }
  }
  return null;
}

/** CRLF -> LF, split into lines with outer blank lines stripped. */
function normalizedLines(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

/**
 * Apple-ID inventory parser (EMAIL_BOUNDARY). A line whose TRIMMED value is
 * a complete valid email - or a full-line `Email:`/`ایمیل:` form - starts a
 * new record; the boundary line stays part of the record's content.
 * Embedded emails inside longer lines never split (warned about). Content
 * before the first boundary rejects the whole paste; so do empty blocks
 * (nothing beyond the email line), over-long blocks (> 4000 chars), more
 * than 500 accounts or > 200000 total chars. Internal line order and
 * meaningful internal blank lines are preserved; record-edge blanks are
 * trimmed. Pure - no DB, no logging, no raw content in messages.
 */
export function parseAppleIdInventory(raw: string): AppleIdInventoryResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let invalidLineCount = 0;

  if (raw.length > INVENTORY_TOTAL_MAX_CHARS) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors: [INVENTORY_TOO_LONG_TEXT] };
  }
  const lines = normalizedLines(raw);
  if (lines.length === 0) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors: [INVENTORY_EMPTY_TEXT] };
  }

  const blocks: Array<{ boundaryEmail: string; lines: string[] }> = [];
  let current: { boundaryEmail: string; lines: string[] } | null = null;
  let preBoundaryLineCount = 0;
  let embeddedEmailLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const boundaryEmail = detectBoundaryEmail(trimmed);
    if (boundaryEmail !== null) {
      current = { boundaryEmail, lines: [line] };
      blocks.push(current);
      continue;
    }
    if (current === null) {
      // Content before the first boundary cannot be attributed to any
      // account - ambiguous inventory is rejected entirely below.
      if (trimmed !== "") {
        preBoundaryLineCount += 1;
        invalidLineCount += 1;
      }
      continue;
    }
    if (trimmed !== "" && EMBEDDED_EMAIL_PATTERN.test(line)) {
      embeddedEmailLineCount += 1;
    }
    current.lines.push(line);
  }

  if (preBoundaryLineCount > 0) {
    errors.push(
      `${preBoundaryLineCount} خط قبل از اولین ایمیل قرار دارد؛ هر حساب باید با یک خط ایمیل شروع شود.`,
    );
  }
  if (blocks.length === 0) {
    errors.push("هیچ خط ایمیلی به‌عنوان شروع حساب پیدا نشد.");
  }
  if (blocks.length > INVENTORY_MAX_ITEMS) {
    errors.push(INVENTORY_TOO_MANY_TEXT);
  }
  if (embeddedEmailLineCount > 0) {
    warnings.push(
      `${embeddedEmailLineCount} خط دارای ایمیل در میان متن بود و به‌عنوان شروع حساب در نظر گرفته نشد.`,
    );
  }

  const items: AppleIdInventoryItem[] = [];
  for (const block of blocks) {
    // Edge-trim the record (leading/trailing blanks) while preserving the
    // internal line order and internal blank lines.
    const content = block.lines.join("\n").trim();
    const masked = maskEmail(block.boundaryEmail);
    const hasBody = block.lines.slice(1).some((line) => line.trim() !== "");
    if (!hasBody) {
      errors.push(`بلاک حساب ${masked} بعد از خط ایمیل هیچ محتوایی ندارد.`);
      continue;
    }
    if (content.length > INVENTORY_BLOCK_MAX_CHARS) {
      errors.push(`بلاک حساب ${masked} از حد مجاز ${INVENTORY_BLOCK_MAX_CHARS} کاراکتر طولانی‌تر است.`);
      continue;
    }
    items.push({ content, boundaryEmail: block.boundaryEmail });
  }

  if (errors.length > 0) {
    return { ok: false, items: [], invalidLineCount, warnings, errors };
  }
  return { ok: true, items, invalidLineCount, warnings, errors };
}

/**
 * EXPLICIT_SEPARATOR parser: blocks split on lines that are exactly `---`
 * (after trimming the line). Same edge-trimming and limits as the Apple-ID
 * parser; blocks left empty by stray separators are skipped with a warning.
 */
export function parseExplicitSeparatorInventory(raw: string): InventoryParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw.length > INVENTORY_TOTAL_MAX_CHARS) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors: [INVENTORY_TOO_LONG_TEXT] };
  }
  const lines = normalizedLines(raw);
  if (lines.length === 0) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors: [INVENTORY_EMPTY_TEXT] };
  }

  const blockLineGroups: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "---") {
      blockLineGroups.push([]);
      continue;
    }
    blockLineGroups[blockLineGroups.length - 1].push(line);
  }

  const items: InventoryItem[] = [];
  let emptyBlockCount = 0;
  for (const [index, blockLines] of blockLineGroups.entries()) {
    const content = blockLines.join("\n").trim();
    if (content === "") {
      emptyBlockCount += 1;
      continue;
    }
    if (content.length > INVENTORY_BLOCK_MAX_CHARS) {
      errors.push(`بلاک شماره ${index + 1} از حد مجاز ${INVENTORY_BLOCK_MAX_CHARS} کاراکتر طولانی‌تر است.`);
      continue;
    }
    items.push({ content, boundaryEmail: null });
  }
  if (emptyBlockCount > 0) {
    warnings.push(`${emptyBlockCount} بلاک خالی بین جداکننده‌ها نادیده گرفته شد.`);
  }
  if (items.length === 0 && errors.length === 0) {
    errors.push(INVENTORY_EMPTY_TEXT);
  }
  if (items.length > INVENTORY_MAX_ITEMS) {
    errors.push(INVENTORY_TOO_MANY_TEXT);
  }

  if (errors.length > 0) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors };
  }
  return { ok: true, items, invalidLineCount: 0, warnings, errors };
}

/**
 * SINGLE_LINE parser: one non-empty trimmed line per item (the legacy
 * parseBulkStockInput split semantics). Over-long lines (> 4000 chars) are
 * counted as invalid and skipped - mirroring the legacy behavior - and
 * duplicates are intentionally KEPT: batch-level dedup is fingerprint-based
 * and happens in other-product-stock-import.service.ts.
 */
export function parseSingleLineInventory(raw: string): InventoryParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let invalidLineCount = 0;

  if (raw.length > INVENTORY_TOTAL_MAX_CHARS) {
    return { ok: false, items: [], invalidLineCount: 0, warnings, errors: [INVENTORY_TOO_LONG_TEXT] };
  }
  const items: InventoryItem[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.length > INVENTORY_BLOCK_MAX_CHARS) {
      invalidLineCount += 1;
      continue;
    }
    items.push({ content: line, boundaryEmail: null });
  }
  if (invalidLineCount > 0) {
    warnings.push(`${invalidLineCount} خط طولانی‌تر از حد مجاز بود و نادیده گرفته شد.`);
  }
  if (items.length === 0) {
    errors.push(INVENTORY_EMPTY_TEXT);
  }
  if (items.length > INVENTORY_MAX_ITEMS) {
    errors.push(INVENTORY_TOO_MANY_TEXT);
  }

  if (errors.length > 0) {
    return { ok: false, items: [], invalidLineCount, warnings, errors };
  }
  return { ok: true, items, invalidLineCount, warnings, errors };
}

/** Dispatches one paste to the parser configured on the product. */
export function parseInventoryByParser(
  parser: OtherProductStockParser,
  raw: string,
): InventoryParseResult {
  switch (parser) {
    case "EMAIL_BOUNDARY":
      return parseAppleIdInventory(raw);
    case "EXPLICIT_SEPARATOR":
      return parseExplicitSeparatorInventory(raw);
    case "SINGLE_LINE":
      return parseSingleLineInventory(raw);
  }
}
