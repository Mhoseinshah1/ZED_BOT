// =============================================================================
// Service-checkout username selection + optional subscription note
// (feat/service-checkout-username-note) — PURE, side-effect-free helpers shared
// by the bot (checkout flow) and the worker (reservation cleanup). No DB, no
// Prisma, no Telegram, no logging here: this module only validates, normalizes
// and randomly generates values. Availability/reservation persistence lives in
// the bot service that consumes these helpers.
//
// The username produced/validated here is the REAL remote panel account
// username (the same identity slot as the naming pipeline's
// resolvedRemoteUsername) — never a Persian display name, nickname, human name
// or friendly title. Randomness comes exclusively from node:crypto; Math.random
// is never used for a generated username.
// =============================================================================

import { randomBytes } from "node:crypto";

// --- username shape ----------------------------------------------------------

/** Minimum / maximum username length in ASCII characters (inclusive). */
export const SERVICE_USERNAME_MIN_LENGTH = 8;
export const SERVICE_USERNAME_MAX_LENGTH = 16;

/**
 * The canonical username regex: 8–16 ASCII chars, first char a lowercase letter,
 * the rest lowercase letters / digits / underscore. `{7,15}` after the first char
 * yields the 8–16 total-length window. Random (`u_…`) usernames also satisfy it.
 */
export const SERVICE_USERNAME_REGEX = /^[a-z][a-z0-9_]{7,15}$/;

/** Opaque random usernames are prefixed so they are visibly machine-generated. */
export const SERVICE_USERNAME_RANDOM_PREFIX = "u_";
/** Length of the crypto-random suffix appended after the prefix. */
const RANDOM_SUFFIX_LENGTH = 8;
/** Lowercase alphanumeric alphabet for the random suffix (all regex-legal). */
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** How the buyer chose the username. Mirrors the Prisma `ServiceUsernameMode`. */
export const SERVICE_USERNAME_MODES = ["CUSTOM", "RANDOM"] as const;
export type ServiceUsernameMode = (typeof SERVICE_USERNAME_MODES)[number];

/** Durable reservation states. Mirrors the Prisma enum of the same name. */
export const SERVICE_USERNAME_RESERVATION_STATUSES = [
  "HELD",
  "BOUND",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
] as const;
export type ServiceUsernameReservationStatus =
  (typeof SERVICE_USERNAME_RESERVATION_STATUSES)[number];

/** Reservation states that still OWN the (panelId, username) uniqueness slot. */
export const SERVICE_USERNAME_ACTIVE_STATUSES: readonly ServiceUsernameReservationStatus[] = [
  "HELD",
  "BOUND",
  "CONSUMED",
];

/**
 * Typed availability outcomes for the read-only pre-payment check. Callers must
 * NEVER treat a non-AVAILABLE outcome as available, and NEVER report unavailable
 * as available on a remote/panel failure (that is what UNVERIFIABLE /
 * PANEL_UNAVAILABLE are for).
 */
export const SERVICE_USERNAME_AVAILABILITY_OUTCOMES = [
  "AVAILABLE",
  "TAKEN_LOCAL",
  "TAKEN_REMOTE",
  "RESERVED",
  "PANEL_UNAVAILABLE",
  "UNVERIFIABLE",
  "INVALID",
] as const;
export type ServiceUsernameAvailabilityOutcome =
  (typeof SERVICE_USERNAME_AVAILABILITY_OUTCOMES)[number];

/**
 * How the durable identity snapshot recorded the username. USER_CUSTOM / USER_RANDOM
 * are the new buyer-selected sources; STRATEGY is the legacy panel-pattern origin.
 */
export const SERVICE_USERNAME_SELECTION_SOURCES = [
  "USER_CUSTOM",
  "USER_RANDOM",
  "STRATEGY",
] as const;
export type ServiceUsernameSelectionSource =
  (typeof SERVICE_USERNAME_SELECTION_SOURCES)[number];

// --- username validation -----------------------------------------------------

/** Machine-readable reasons a candidate username is rejected (never raw text). */
export type ServiceUsernameRejectReason =
  | "EMPTY"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "BAD_FIRST_CHAR"
  | "BAD_CHARS";

export type ServiceUsernameValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: ServiceUsernameRejectReason };

/**
 * Normalize a raw username the buyer typed: trim EDGE whitespace and lowercase
 * ASCII letters. Deliberately does NOT transliterate and does NOT silently strip
 * invalid characters — validation is responsible for rejecting anything the regex
 * forbids, so the buyer sees a clear error instead of a silently mangled name.
 */
export function normalizeServiceUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate + normalize a buyer-typed username against the canonical regex.
 * Returns a typed reason on failure so the UI can render a specific message and
 * logs can record only the (safe) reason code, never the raw value.
 */
export function validateServiceUsername(raw: string): ServiceUsernameValidation {
  const normalized = normalizeServiceUsername(raw);
  if (normalized.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (normalized.length < SERVICE_USERNAME_MIN_LENGTH) {
    return { ok: false, reason: "TOO_SHORT" };
  }
  if (normalized.length > SERVICE_USERNAME_MAX_LENGTH) {
    return { ok: false, reason: "TOO_LONG" };
  }
  if (!/^[a-z]/.test(normalized)) {
    return { ok: false, reason: "BAD_FIRST_CHAR" };
  }
  if (!SERVICE_USERNAME_REGEX.test(normalized)) {
    return { ok: false, reason: "BAD_CHARS" };
  }
  return { ok: true, normalized };
}

/** True iff a value is already a valid, normalized service username. */
export function isValidServiceUsername(value: string): boolean {
  const r = validateServiceUsername(value);
  return r.ok && r.normalized === value;
}

// --- crypto-random username --------------------------------------------------

/**
 * Draw `count` unbiased indices into an alphabet of length `size` using
 * rejection sampling over crypto bytes — no modulo bias, no Math.random.
 */
function randomIndices(count: number, size: number): number[] {
  const out: number[] = [];
  // Largest multiple of `size` that fits in a byte; values >= it are rejected.
  const limit = 256 - (256 % size);
  while (out.length < count) {
    const buf = randomBytes(count * 2);
    for (let i = 0; i < buf.length && out.length < count; i += 1) {
      const b = buf[i];
      if (b < limit) {
        out.push(b % size);
      }
    }
  }
  return out;
}

/**
 * Generate ONE opaque, `u_`-prefixed random username (e.g. `u_k7m4q2x9`). The
 * value is derived purely from node crypto randomness: it carries NO human,
 * dictionary, animal or place name, and NO Telegram id / db id / phone / order id
 * / sequential counter / timestamp / other PII. Always satisfies
 * SERVICE_USERNAME_REGEX.
 */
export function generateRandomServiceUsername(): string {
  const suffix = randomIndices(RANDOM_SUFFIX_LENGTH, RANDOM_ALPHABET.length)
    .map((i) => RANDOM_ALPHABET[i])
    .join("");
  const candidate = `${SERVICE_USERNAME_RANDOM_PREFIX}${suffix}`;
  // Defensive: the construction always matches, but never emit an illegal name.
  if (!SERVICE_USERNAME_REGEX.test(candidate)) {
    // Extremely unlikely; regenerate deterministically from a fresh draw.
    return generateRandomServiceUsername();
  }
  return candidate;
}

// --- optional subscription note ---------------------------------------------

/** Maximum note length counted in Unicode code points (not UTF-16 units). */
export const SERVICE_NOTE_MAX_CODE_POINTS = 120;

/** Machine-readable reasons a note is rejected (never the raw note text). */
export type ServiceNoteRejectReason = "TOO_LONG" | "CONTROL_OR_BIDI";

export type ServiceNoteValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: ServiceNoteRejectReason };

/**
 * Bidi / invisible formatting code points that enable text-spoofing and are
 * rejected outright. NOTE: U+200C (ZWNJ, essential for Persian "نیم‌فاصله") and
 * U+200D (ZWJ, used inside emoji sequences) are deliberately NOT in this set.
 */
const REJECTED_FORMAT_CODE_POINTS = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0x061c, // ARABIC LETTER MARK
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
]);

/** A disallowed C0/C1 control code point (newline is allowed and handled first). */
function isControlCodePoint(cp: number): boolean {
  // C0 controls except LF (0x0A); DEL (0x7F); C1 controls (0x80–0x9F).
  return (cp < 0x20 && cp !== 0x0a) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
}

/**
 * Validate + normalize an optional subscription note. Persian / English / digits
 * / emoji are all allowed. Normalization: unify CR/CRLF and the Unicode line/para
 * separators to `\n`, turn tabs into single spaces, trim edge whitespace, and
 * collapse any run of 3+ newlines into a paragraph break (`\n\n`). Rejects
 * control and bidi characters (fail-closed, never silently stripped) and any note
 * over SERVICE_NOTE_MAX_CODE_POINTS code points. The result is plain text; every
 * caller HTML-escapes it at render time.
 */
export function normalizeServiceNote(raw: string): ServiceNoteValidation {
  // 1) Unify line breaks and tabs before the control-character check.
  const unified = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ");

  // 2) Reject control / bidi characters (checked on the unified text).
  for (const ch of unified) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isControlCodePoint(cp) || REJECTED_FORMAT_CODE_POINTS.has(cp)) {
      return { ok: false, reason: "CONTROL_OR_BIDI" };
    }
  }

  // 3) Collapse whitespace runs: trailing spaces per line, and 3+ newlines → 2.
  const normalized = unified
    .split("\n")
    .map((line) => line.replace(/[ ]{2,}/g, " ").replace(/[ ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 4) Bound by code points (emoji count as their code points, not UTF-16 units).
  if (countCodePoints(normalized) > SERVICE_NOTE_MAX_CODE_POINTS) {
    return { ok: false, reason: "TOO_LONG" };
  }
  return { ok: true, normalized };
}

/** Count Unicode code points (handles surrogate pairs / emoji correctly). */
export function countCodePoints(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}
