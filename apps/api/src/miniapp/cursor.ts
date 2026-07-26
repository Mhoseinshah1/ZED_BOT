import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Opaque keyset cursors.
//
// Offset pagination is not an option here. `Service` and `WalletTransaction`
// grow without bound, and `OFFSET n` makes the database walk and discard n rows
// on every page — the last page of a long ledger costs the most, which is
// exactly backwards. Worse, an insert between two page requests shifts every
// subsequent offset, so a user scrolling their transactions can see a row twice
// or miss one entirely.
//
// A keyset cursor carries the last row's sort key instead: `WHERE (createdAt,
// id) < (:createdAt, :id)`. Constant cost per page, and a concurrent insert
// cannot perturb rows the client has already passed.
//
// The cursor is SIGNED, not merely encoded. It is a filter that goes straight
// into a query, so an unsigned one is an invitation to hand-craft values and
// probe. The signature also lets a tampered cursor be rejected with a clean 400
// instead of surfacing as a confusing empty page. It is NOT a capability: the
// owning user id is never inside it, and every query is scoped by the session's
// user id regardless of what the cursor says.
// =============================================================================

const CURSOR_KEY_CONTEXT = "zedbot.miniapp.cursor.v1";
const CURSOR_VERSION = "c1";
/** Truncated to 16 bytes: this authenticates a sort key, not a secret. */
const SIGNATURE_BYTES = 16;

export interface KeysetCursor {
  /** Unix milliseconds of the last row's `createdAt`. */
  createdAtMs: number;
  /** Tie-breaker for rows sharing a millisecond. */
  id: string;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function cursorKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new Error("APP_SECRET is not set; Mini App cursors cannot be signed.");
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  // HMAC over a context string rather than scrypt: this key is derived on a
  // hot path and authenticates a public sort key, so a KDF would buy nothing.
  const key = createHmac("sha256", secret).update(CURSOR_KEY_CONTEXT).digest();
  cachedKey = { secret, key };
  return key;
}

function sign(body: string): string {
  return createHmac("sha256", cursorKey()).update(body).digest().subarray(0, SIGNATURE_BYTES)
    .toString("base64url");
}

/** Encodes a row's sort key into an opaque, tamper-evident string. */
export function encodeCursor(cursor: KeysetCursor): string {
  const body = `${CURSOR_VERSION}.${cursor.createdAtMs}.${Buffer.from(cursor.id, "utf8").toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

/**
 * Decodes a cursor.
 *
 * Returns `null` for anything that is not a cursor this server minted —
 * malformed, wrong version, or wrong signature all collapse to the same
 * outcome so the shape of the failure teaches nothing.
 */
export function decodeCursor(raw: string): KeysetCursor | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  const parts = raw.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const [version, rawMs, encodedId, signature] = parts;
  if (version !== CURSOR_VERSION || !/^\d{1,15}$/.test(rawMs)) {
    return null;
  }
  const expected = Buffer.from(sign(`${version}.${rawMs}.${encodedId}`), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }
  const createdAtMs = Number.parseInt(rawMs, 10);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  const id = Buffer.from(encodedId, "base64url").toString("utf8");
  // Every paginated table is keyed by uuid; anything else was not minted here.
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return null;
  }
  return { createdAtMs, id };
}

export const MINIAPP_PAGE_DEFAULT_SIZE = 20;
export const MINIAPP_PAGE_MAX_SIZE = 50;

/**
 * Clamps a client-supplied page size.
 *
 * Unparseable input falls back to the default rather than erroring: a page size
 * is a hint, and rejecting the whole request over it would be a worse
 * experience than serving a sane page.
 */
export function clampPageSize(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) {
    return MINIAPP_PAGE_DEFAULT_SIZE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    return MINIAPP_PAGE_DEFAULT_SIZE;
  }
  return Math.min(parsed, MINIAPP_PAGE_MAX_SIZE);
}
