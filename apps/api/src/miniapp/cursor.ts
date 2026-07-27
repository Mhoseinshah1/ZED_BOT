import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

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
// WHY THE PAYLOAD IS ENCRYPTED, NOT MERELY SIGNED. The tie-breaker in that sort
// key IS the row's database uuid — there is no other unique, stable column to
// break a millisecond tie with. A signed-but-readable cursor therefore hands
// the client a base64 uuid on the second page of any list: the identifier the
// rest of this contract goes out of its way not to expose, arriving through the
// back door. Signing stops forgery; it does nothing about disclosure. So the
// payload is sealed with AES-256-GCM and the client receives ciphertext.
//
// BOUND TO ITS RESOURCE. The caller names the collection the cursor belongs to
// and that name is the AEAD's additional data, so a cursor minted for the
// service list cannot be replayed against the wallet ledger: the tag simply
// fails to verify. Nothing has to remember to check it — the decryption either
// happens or it does not.
//
// It is NOT a capability. The owning user id is never inside it, and every
// query is scoped by the session's user id regardless of what the cursor says.
// =============================================================================

/** The collections a cursor can belong to. Also the AEAD's additional data. */
export type CursorResource = "services" | "wallet-transactions";

const CURSOR_VERSION = "c2";
const KEY_CONTEXT = "zedbot.miniapp.cursor.key.v2";
/** AES-GCM standard nonce length; a fresh random nonce per cursor. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeysetCursor {
  /** Unix milliseconds of the last row's `createdAt`. */
  createdAtMs: number;
  /** Tie-breaker for rows sharing a millisecond — never leaves this module. */
  id: string;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function cursorKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new Error("APP_SECRET is not set; Mini App cursors cannot be sealed.");
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  // HMAC over a context string rather than a KDF: the input is already a
  // high-entropy application secret, and this runs on a paginated hot path.
  const key = createHmac("sha256", secret).update(KEY_CONTEXT).digest();
  cachedKey = { secret, key };
  return key;
}

/** Encodes a row's sort key into an opaque, resource-bound cursor. */
export function encodeCursor(resource: CursorResource, cursor: KeysetCursor): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(), iv);
  // The resource name is authenticated but not encrypted: it is not a secret,
  // and binding it here is what makes a cross-collection replay fail.
  cipher.setAAD(Buffer.from(`${CURSOR_VERSION}.${resource}`, "utf8"));
  const plaintext = Buffer.from(`${cursor.createdAtMs}.${cursor.id}`, "utf8");
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CURSOR_VERSION}.${Buffer.concat([iv, sealed, tag]).toString("base64url")}`;
}

/**
 * Decodes a cursor minted for `resource`.
 *
 * Returns `null` for anything else — malformed, wrong version, tampered, or
 * minted for a different collection all collapse to the same outcome so the
 * shape of the failure teaches nothing.
 */
export function decodeCursor(raw: string, resource: CursorResource): KeysetCursor | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  const separator = raw.indexOf(".");
  if (separator === -1) {
    return null;
  }
  const version = raw.slice(0, separator);
  // Constant-time on the version too: it costs nothing and keeps the whole
  // comparison path uniform.
  const versionBuf = Buffer.from(version, "utf8");
  const expectedVersion = Buffer.from(CURSOR_VERSION, "utf8");
  if (versionBuf.length !== expectedVersion.length || !timingSafeEqual(versionBuf, expectedVersion)) {
    return null;
  }
  const body = raw.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(body)) {
    return null;
  }
  const bytes = Buffer.from(body, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES) {
    return null;
  }

  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", cursorKey(), bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`${CURSOR_VERSION}.${resource}`, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Tampered, or minted for another resource. Same answer either way.
    return null;
  }

  const dot = plaintext.indexOf(".");
  if (dot === -1) {
    return null;
  }
  const rawMs = plaintext.slice(0, dot);
  const id = plaintext.slice(dot + 1);
  if (!/^\d{1,15}$/.test(rawMs)) {
    return null;
  }
  const createdAtMs = Number.parseInt(rawMs, 10);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  // Every paginated table is keyed by uuid; anything else was not sealed here.
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
