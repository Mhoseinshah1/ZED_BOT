// =============================================================================
// Support Tickets V2 (feat/support-ticket-attachments-service-context) — shared
// contract. Language-neutral, dependency-free typed vocabulary for structured
// ticket categories + origins, the attachment security contract (allowlists,
// validation, file-name sanitisation, size buckets) and the bounded rollout
// settings.
//
// Design rules honoured here (same as service-diagnostics.ts):
//   * Behaviour is driven by these machine CODES ONLY — never by comparing
//     Persian strings. Persian rendering lives in the bot view layer.
//   * This module imports NOTHING from @zedbot/database or the bot — pure data +
//     pure functions, so the worker/api/tests can consume it too.
//   * Setting KEYS + bounds live here (a shared typed contract), not as scattered
//     string literals across handlers.
//   * No file BYTES, no download URL, no external storage — attachments are only
//     ever Telegram file references, validated from UNTRUSTED metadata hints.
// =============================================================================

import { clampInt } from "./auto-renewal.js";

// --- structured categories + origins -----------------------------------------

/** The structured problem categories a user picks when opening a ticket. */
export const SUPPORT_TICKET_CATEGORIES = [
  "CONNECTION",
  "PAYMENT",
  "SERVICE_MANAGEMENT",
  "ACCOUNT",
  "OTHER",
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];

/** Where a ticket was opened FROM (audit / admin visibility only). */
export const SUPPORT_TICKET_ORIGINS = [
  "GENERAL",
  "SERVICE_DETAIL",
  "CONNECTION_GUIDE",
  "SERVICE_DIAGNOSTICS",
  // The Telegram Mini App support centre. Additive: `origin` is a nullable
  // String column validated against this list, so no migration is needed and
  // every existing ticket keeps the origin it was opened with. Recorded for
  // admin visibility only — no behaviour branches on it.
  "MINIAPP",
] as const;
export type SupportTicketOrigin = (typeof SUPPORT_TICKET_ORIGINS)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(SUPPORT_TICKET_CATEGORIES);
const ORIGIN_SET: ReadonlySet<string> = new Set(SUPPORT_TICKET_ORIGINS);

export function isSupportTicketCategory(value: unknown): value is SupportTicketCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}
export function isSupportTicketOrigin(value: unknown): value is SupportTicketOrigin {
  return typeof value === "string" && ORIGIN_SET.has(value);
}

/**
 * STABLE Persian display labels for categories + origins (§22). Display only —
 * behaviour never depends on the rendered text; these are NOT editable
 * ButtonText/MessageTemplate entries, so operators cannot repurpose a label to
 * change routing. Shared here so the service (notifications) and the view layer
 * (ticket detail) render the exact same words.
 */
export const SUPPORT_CATEGORY_LABEL_FA: Readonly<Record<SupportTicketCategory, string>> = {
  CONNECTION: "اتصال",
  PAYMENT: "پرداخت و سفارش",
  SERVICE_MANAGEMENT: "مدیریت سرویس",
  ACCOUNT: "حساب کاربری",
  OTHER: "سایر",
};
export const SUPPORT_ORIGIN_LABEL_FA: Readonly<Record<SupportTicketOrigin, string>> = {
  GENERAL: "تیکت عمومی",
  SERVICE_DETAIL: "صفحه سرویس",
  CONNECTION_GUIDE: "آموزش اتصال",
  SERVICE_DIAGNOSTICS: "عیب‌یابی خودکار",
  MINIAPP: "وب‌اپ",
};

/** Stable Persian label for a (possibly null/invalid) category code, or null. */
export function supportCategoryLabelFa(code: string | null | undefined): string | null {
  return isSupportTicketCategory(code) ? SUPPORT_CATEGORY_LABEL_FA[code] : null;
}
/** Stable Persian label for a (possibly null/invalid) origin code, or null. */
export function supportOriginLabelFa(code: string | null | undefined): string | null {
  return isSupportTicketOrigin(code) ? SUPPORT_ORIGIN_LABEL_FA[code] : null;
}

/**
 * Compact, STABLE callback codes for the category selection keyboard. Routing is
 * code-driven — the editable ButtonText labels never control which category is
 * chosen. `user:sup:cat:<code>`; one lowercase letter keeps the callback tiny.
 */
export const SUPPORT_CATEGORY_BY_CALLBACK: Readonly<Record<string, SupportTicketCategory>> = {
  c: "CONNECTION",
  p: "PAYMENT",
  s: "SERVICE_MANAGEMENT",
  a: "ACCOUNT",
  o: "OTHER",
};
export const SUPPORT_CALLBACK_BY_CATEGORY: Readonly<Record<SupportTicketCategory, string>> = {
  CONNECTION: "c",
  PAYMENT: "p",
  SERVICE_MANAGEMENT: "s",
  ACCOUNT: "a",
  OTHER: "o",
};

/** Resolve a `user:sup:cat:<code>` code to its category (null when unknown). */
export function supportCategoryFromCallback(code: string): SupportTicketCategory | null {
  return Object.prototype.hasOwnProperty.call(SUPPORT_CATEGORY_BY_CALLBACK, code)
    ? SUPPORT_CATEGORY_BY_CALLBACK[code]
    : null;
}

/**
 * Categories where a Service is intrinsically part of the problem, so the
 * new-ticket flow shows the Service picker up front. The others may still LINK a
 * Service, but only through the explicit «اتصال تیکت به یک سرویس» opt-in — an
 * unrelated Service is never forced onto a PAYMENT / ACCOUNT / OTHER ticket.
 */
export function supportCategoryPrefersService(category: SupportTicketCategory): boolean {
  return category === "CONNECTION" || category === "SERVICE_MANAGEMENT";
}

// --- rollout settings ---------------------------------------------------------

/** Master switch. Default FALSE — attachments are dormant until the OWNER
 * enables them. Disabling deletes no attachment metadata and keeps text-only
 * support unchanged. */
export const SUPPORT_ATTACHMENTS_ENABLED_KEY = "support_attachments_enabled";

/** Per-attachment byte ceiling. Code owns the default + bounds so tuning never
 * needs a data migration (same convention as the diagnostics settings). */
export const SUPPORT_ATTACHMENT_MAX_BYTES_KEY = "support_attachment_max_bytes";
export const SUPPORT_ATTACHMENT_MAX_BYTES_DEFAULT = 15_728_640; // 15 MiB
export const SUPPORT_ATTACHMENT_MAX_BYTES_MIN = 1_048_576; // 1 MiB
export const SUPPORT_ATTACHMENT_MAX_BYTES_MAX = 20_971_520; // 20 MiB

/** Clamp a raw (string|null) setting value to the attachment size bound. */
export function resolveSupportAttachmentMaxBytes(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(
    n,
    SUPPORT_ATTACHMENT_MAX_BYTES_MIN,
    SUPPORT_ATTACHMENT_MAX_BYTES_MAX,
    SUPPORT_ATTACHMENT_MAX_BYTES_DEFAULT,
  );
}

/** The size presets offered on the OWNER attachment-settings page (bytes). */
export const SUPPORT_ATTACHMENT_SIZE_PRESETS_BYTES = [
  5_242_880, // 5 MiB
  10_485_760, // 10 MiB
  15_728_640, // 15 MiB
  20_971_520, // 20 MiB
] as const;

// --- attachment types + security contract ------------------------------------

export const SUPPORT_ATTACHMENT_TYPES = ["PHOTO", "DOCUMENT"] as const;
export type SupportAttachmentType = (typeof SUPPORT_ATTACHMENT_TYPES)[number];

const ATTACHMENT_TYPE_SET: ReadonlySet<string> = new Set(SUPPORT_ATTACHMENT_TYPES);
export function isSupportAttachmentType(value: unknown): value is SupportAttachmentType {
  return typeof value === "string" && ATTACHMENT_TYPE_SET.has(value);
}

/** Bounds. A caption never replaces text — it is optional and short. */
export const SUPPORT_CAPTION_MAX = 1000;
export const SUPPORT_FILENAME_MAX = 120;

/**
 * The DOCUMENT allowlists. Telegram-provided MIME + file name are UNTRUSTED
 * hints — we validate both where present, reject anything else (allowlist-only,
 * so every executable / script / archive / macro / SVG / HTML is rejected by
 * absence), and NEVER download, unzip, inspect or parse the file. Content-level
 * trust is explicitly out of scope; admins are shown an "untrusted file" notice.
 */
export const SUPPORT_DOCUMENT_MIME_ALLOWLIST: readonly string[] = [
  "application/pdf",
  "text/plain",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
];
export const SUPPORT_DOCUMENT_EXTENSION_ALLOWLIST: readonly string[] = [
  ".pdf",
  ".txt",
  ".log",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];

const DOC_MIME_SET: ReadonlySet<string> = new Set(SUPPORT_DOCUMENT_MIME_ALLOWLIST);
const DOC_EXT_SET: ReadonlySet<string> = new Set(SUPPORT_DOCUMENT_EXTENSION_ALLOWLIST);

/** Each allowed extension → the MIME types that legitimately pair with it. When
 * both a MIME and an extension are present they must be compatible per this map;
 * a mismatch (e.g. `report.pdf` claiming `application/x-msdownload`) is rejected. */
const EXTENSION_TO_MIMES: Readonly<Record<string, readonly string[]>> = {
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".log": ["text/plain"],
  // Telegram labels .json as application/json OR text/plain depending on client.
  ".json": ["application/json", "text/plain"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
};

/** The typed, safe rejection reasons an attachment attempt can produce. The bot
 * maps each to a Persian template; NONE of them ever echoes user content. */
export const SUPPORT_ATTACHMENT_REJECTIONS = [
  "DISABLED", // attachments master switch is off
  "ALBUM", // media_group_id present (send files separately)
  "EMPTY", // neither text nor a valid attachment
  "TOO_LARGE", // over the configured byte ceiling
  "TYPE_REJECTED", // extension/MIME not allowed, mismatched, or unknown document
  "ZERO_BYTE", // a document Telegram reports as 0 bytes
  "METADATA_INVALID", // missing file_id / file_unique_id / required size
  "CAPTION_TOO_LONG", // caption over SUPPORT_CAPTION_MAX
] as const;
export type SupportAttachmentRejection = (typeof SUPPORT_ATTACHMENT_REJECTIONS)[number];

/** A raw, still-untrusted attachment pulled off a Telegram message. */
export interface RawSupportAttachment {
  type: SupportAttachmentType;
  fileId?: string;
  fileUniqueId?: string;
  /** Telegram document file name (untrusted hint). */
  fileName?: string;
  /** Telegram document MIME (untrusted hint). */
  mimeType?: string;
  /** Telegram-reported file_size in bytes; may be omitted (esp. for photos). */
  sizeBytes?: bigint;
}

/** A validated, normalised, safe-to-persist attachment (references only). */
export interface SupportAttachmentInput {
  type: SupportAttachmentType;
  fileId: string;
  fileUniqueId: string;
  /** Sanitised, length-bounded display name, or null (photos / unnamed docs). */
  fileName: string | null;
  /** Normalised (lower-cased) MIME hint, or null when Telegram omitted it. */
  mimeType: string | null;
  /** Reported size in bytes, or null when Telegram omitted it (photos). */
  sizeBytes: bigint | null;
}

export type SupportAttachmentValidation =
  | { ok: true; attachment: SupportAttachmentInput }
  | { ok: false; reason: SupportAttachmentRejection };

/** Lower-cased extension INCLUDING the leading dot (`".pdf"`), or "" when none. */
export function fileExtension(fileName: string): string {
  const base = fileName.slice(fileName.replace(/\\/g, "/").lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

/**
 * Sanitises an UNTRUSTED Telegram file name into a bounded, safe display string:
 * strips any path, drops control/reserved characters, collapses whitespace, and
 * bounds to SUPPORT_FILENAME_MAX. Returns null when nothing safe remains — the
 * caller then shows a generic label. Never used to open a file; display only.
 */
export function sanitizeSupportFileName(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  // Keep only the basename (defeat ../ and absolute paths in the hint).
  const base = raw.slice(raw.replace(/\\/g, "/").lastIndexOf("/") + 1);
  // Allow letters/digits (incl. Persian/Arabic), spaces, and a small safe set of
  // punctuation. Everything else (control chars, quotes, slashes, HTML) is dropped.
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^0-9A-Za-z._ ()\-\u0600-\u06FF\u200C]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return null;
  }
  return cleaned.length <= SUPPORT_FILENAME_MAX ? cleaned : cleaned.slice(0, SUPPORT_FILENAME_MAX);
}

/**
 * Validates a raw attachment against the security contract. PHOTO requires only
 * valid ids + (when reported) an in-limit size. DOCUMENT requires a reported
 * size (non-zero, in-limit) and an allowed extension AND/OR MIME that, when both
 * present, are compatible. Returns the normalised, safe-to-persist reference or
 * a typed rejection. Pure; never throws, never fetches, never inspects content.
 */
export function validateSupportAttachment(
  raw: RawSupportAttachment,
  opts: { maxBytes: number },
): SupportAttachmentValidation {
  if (
    typeof raw.fileId !== "string" ||
    raw.fileId === "" ||
    typeof raw.fileUniqueId !== "string" ||
    raw.fileUniqueId === ""
  ) {
    return { ok: false, reason: "METADATA_INVALID" };
  }
  const maxBytes = BigInt(resolveSupportAttachmentMaxBytes(String(opts.maxBytes)));

  if (raw.type === "PHOTO") {
    // Telegram guarantees a photo is an image; size may be omitted. Enforce the
    // ceiling only when reported. No file name / MIME are meaningful for photos.
    if (raw.sizeBytes !== undefined && raw.sizeBytes > maxBytes) {
      return { ok: false, reason: "TOO_LARGE" };
    }
    return {
      ok: true,
      attachment: {
        type: "PHOTO",
        fileId: raw.fileId,
        fileUniqueId: raw.fileUniqueId,
        fileName: null,
        mimeType: null,
        sizeBytes: raw.sizeBytes ?? null,
      },
    };
  }

  // DOCUMENT.
  if (raw.sizeBytes === undefined) {
    // Can't verify zero-byte / over-limit without a size — fail safe.
    return { ok: false, reason: "METADATA_INVALID" };
  }
  if (raw.sizeBytes <= 0n) {
    return { ok: false, reason: "ZERO_BYTE" };
  }
  if (raw.sizeBytes > maxBytes) {
    return { ok: false, reason: "TOO_LARGE" };
  }

  const ext = typeof raw.fileName === "string" ? fileExtension(raw.fileName) : "";
  const mime = typeof raw.mimeType === "string" ? raw.mimeType.trim().toLowerCase() : "";
  const hasExt = ext !== "";
  const hasMime = mime !== "";

  if (!hasExt && !hasMime) {
    return { ok: false, reason: "TYPE_REJECTED" }; // unknown document format
  }
  if (hasExt && !DOC_EXT_SET.has(ext)) {
    return { ok: false, reason: "TYPE_REJECTED" };
  }
  if (hasMime && !DOC_MIME_SET.has(mime)) {
    return { ok: false, reason: "TYPE_REJECTED" };
  }
  if (hasExt && hasMime && !(EXTENSION_TO_MIMES[ext] ?? []).includes(mime)) {
    return { ok: false, reason: "TYPE_REJECTED" }; // extension/MIME mismatch
  }

  return {
    ok: true,
    attachment: {
      type: "DOCUMENT",
      fileId: raw.fileId,
      fileUniqueId: raw.fileUniqueId,
      fileName: sanitizeSupportFileName(raw.fileName),
      mimeType: hasMime ? mime : null,
      sizeBytes: raw.sizeBytes,
    },
  };
}

/** A coarse, non-reversible size bucket for privacy-safe logging (never the
 * exact byte count, which could correlate a specific file). */
export function supportAttachmentSizeBucket(sizeBytes: bigint | null | undefined): string {
  if (sizeBytes === null || sizeBytes === undefined) {
    return "unknown";
  }
  const KIB = 1024n;
  const MIB = 1024n * KIB;
  if (sizeBytes <= 0n) return "empty";
  if (sizeBytes < 256n * KIB) return "<256K";
  if (sizeBytes < MIB) return "256K-1M";
  if (sizeBytes < 5n * MIB) return "1M-5M";
  if (sizeBytes < 10n * MIB) return "5M-10M";
  if (sizeBytes < 15n * MIB) return "10M-15M";
  return "15M+";
}
