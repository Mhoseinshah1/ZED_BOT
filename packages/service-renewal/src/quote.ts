import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

import type { CommerceOperation } from "./contract.js";

// =============================================================================
// The authoritative quote.
//
// WHAT A QUOTE IS FOR. Between "show me the price" and "yes, charge me" the
// world can change: the operator can reprice the product, a discount can reach
// its limit, the service can expire, the rollout switch can be turned off. The
// quote is what lets the server notice. It is not a promise to honour the old
// price — it is a statement of exactly which world the user was shown, so the
// confirmation can refuse when the world it settles into is a different one.
//
// NOTHING AUTHORITATIVE COMES FROM THE BROWSER. The client sends a quote
// reference, a checkout reference and an idempotency key. It never sends an
// amount, a discount, a duration, a traffic figure or a balance; if it did, the
// server would have to decide whether to believe it, and the only safe answer to
// that question is to never ask it. The amount charged is read from the frozen
// checkout row, never from the request.
//
// WHY SEALED AND NOT MERELY SIGNED. The payload names a CheckoutSession by its
// database uuid. A signed-but-readable token would hand that uuid to the
// browser in base64 — the identifier this whole contract avoids exposing,
// arriving through the back door. Signing prevents forgery and does nothing
// about disclosure, so the payload is encrypted with AES-256-GCM exactly as
// `apps/api/src/miniapp/cursor.ts` seals keyset cursors, and the client holds
// ciphertext.
//
// BOUND, AND BOUND IN THE CRYPTOGRAPHY. The version+purpose string is the AEAD's
// additional data, so a quote cannot be replayed as a cursor or under a future
// payload shape: the tag simply fails. The owning user and the operation are
// inside the sealed payload and are compared against the session on every use,
// so a stolen quote is useless to anyone else — it is a description, never a
// capability.
//
// THE FINGERPRINT is a hash of every authoritative input that went into the
// figures the user was shown. Recomputing it at confirmation and finding it
// changed is the definition of QUOTE_STALE. It holds no values, only their
// digest, so it cannot leak a price or a balance even if the seal were opened.
// =============================================================================

const QUOTE_KEY_CONTEXT = "zedbot.miniapp.quote.key.v1";
/** Version marker AND the AEAD's additional data. */
const QUOTE_VERSION = "q1";
/** AES-GCM standard nonce length; a fresh random nonce per quote. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Thrown when APP_SECRET is missing — never fall back to an unkeyed quote. */
export class QuoteConfigError extends Error {
  constructor() {
    super(
      "APP_SECRET is not set. Commerce quotes cannot be sealed without it; add it to the environment and restart.",
    );
    this.name = "QuoteConfigError";
  }
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function quoteKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new QuoteConfigError();
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  // Its own scrypt context, so the quote key space cannot collide with the
  // session or cursor key spaces even though all three share APP_SECRET.
  const key = scryptSync(secret, QUOTE_KEY_CONTEXT, 32);
  cachedKey = { secret, key };
  return key;
}

/**
 * What a sealed quote says.
 *
 * Deliberately small. Everything else the confirmation needs is re-read from the
 * database under the settlement transaction; carrying it here would mean
 * settling from a copy the user has been holding.
 */
export interface QuotePayload {
  /** The user this quote was issued to. Compared against the session on use. */
  userId: string;
  /** The frozen CheckoutSession this quote prices. Never leaves the server. */
  checkoutId: string;
  operation: CommerceOperation;
  /** The payable amount at issue time, in whole Toman. */
  finalPriceToman: number;
  /** Digest of every authoritative input behind the figures shown. */
  fingerprint: string;
  /** Absolute expiry, unix milliseconds. No clock arithmetic at read time. */
  expiresAtMs: number;
}

export type QuoteFailure = "MALFORMED" | "BAD_SEAL" | "EXPIRED";

export type QuoteOpenResult =
  | { ok: true; payload: QuotePayload }
  | { ok: false; reason: QuoteFailure };

/**
 * The separator between fingerprint fields.
 *
 * NUL, because it cannot occur in a uuid, a status name, a number's decimal
 * form or the placeholder. A printable separator could in principle be smuggled
 * into a value and shift a field boundary, so that two different priced worlds
 * hash to one digest. Written as an escape rather than as a literal byte so the
 * file stays text.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * The digest of one priced world.
 *
 * EVERY INPUT THAT MOVED A NUMBER IS IN HERE, and the fields are written as an
 * explicit list rather than by hashing an object, so adding a priced input to
 * the quote without adding it here is a visible omission rather than a silent
 * one.
 *
 * Values are joined with a separator that cannot appear in any of them, so two
 * different worlds cannot produce one string by shifting a boundary.
 */
export function quoteFingerprint(input: {
  productId: string;
  productPriceToman: number;
  productActive: boolean;
  categoryActive: boolean;
  panelId: string | null;
  panelStatus: string | null;
  discountCodeId: string | null;
  discountAmountToman: number;
  finalPriceToman: number;
  serviceId: string | null;
  serviceStatus: string | null;
  serviceExpiresAtMs: number | null;
  serviceVolumeBytes: string | null;
}): string {
  const parts = [
    input.productId,
    String(input.productPriceToman),
    input.productActive ? "1" : "0",
    input.categoryActive ? "1" : "0",
    input.panelId ?? "-",
    input.panelStatus ?? "-",
    input.discountCodeId ?? "-",
    String(input.discountAmountToman),
    String(input.finalPriceToman),
    input.serviceId ?? "-",
    input.serviceStatus ?? "-",
    input.serviceExpiresAtMs === null ? "-" : String(input.serviceExpiresAtMs),
    input.serviceVolumeBytes ?? "-",
  ];
  return createHash("sha256").update(parts.join(FIELD_SEPARATOR)).digest("base64url");
}

/** Seals a quote. The result is opaque ciphertext, safe to hand to a browser. */
export function sealQuote(payload: QuotePayload): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", quoteKey(), iv);
  cipher.setAAD(Buffer.from(QUOTE_VERSION, "utf8"));
  const body = JSON.stringify({
    u: payload.userId,
    c: payload.checkoutId,
    o: payload.operation,
    a: payload.finalPriceToman,
    f: payload.fingerprint,
    x: payload.expiresAtMs,
  });
  const sealed = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${QUOTE_VERSION}.${Buffer.concat([iv, sealed, tag]).toString("base64url")}`;
}

/**
 * Opens a sealed quote.
 *
 * SEAL FIRST, EXPIRY SECOND. A forged token must not be able to learn whether
 * its guessed expiry was plausible, and an unopenable token has no expiry to
 * speak of.
 */
export function openQuote(token: unknown, nowMs = Date.now()): QuoteOpenResult {
  if (typeof token !== "string" || token === "") {
    return { ok: false, reason: "MALFORMED" };
  }
  const separator = token.indexOf(".");
  if (separator < 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (token.slice(0, separator) !== QUOTE_VERSION) {
    // A retired version fails cleanly instead of being misread under new rules.
    return { ok: false, reason: "MALFORMED" };
  }

  const encoded = token.slice(separator + 1);
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, "base64url");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  // STRICT, CANONICAL BASE64URL ONLY. `Buffer.from` is lenient: it skips
  // characters it does not recognise and tolerates trailing bytes that do not
  // complete a quartet, so `<valid-token>x` decodes to the SAME ciphertext and
  // would open as if untampered. Nothing is forged by that — the AEAD tag still
  // has to verify — but a token that is not byte-for-byte the one we issued must
  // not be accepted, or "the client sent back exactly what we gave it" stops
  // being a property anything can rely on.
  if (raw.toString("base64url") !== encoded) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    return { ok: false, reason: "MALFORMED" };
  }

  let plain: string;
  try {
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const sealed = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", quoteKey(), iv);
    decipher.setAAD(Buffer.from(QUOTE_VERSION, "utf8"));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8");
  } catch {
    // Any tampering — a flipped byte, a swapped nonce, a foreign key — lands
    // here. There is nothing to distinguish and nothing worth reporting.
    return { ok: false, reason: "BAD_SEAL" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return { ok: false, reason: "BAD_SEAL" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "BAD_SEAL" };
  }
  const record = parsed as Record<string, unknown>;
  const userId = record.u;
  const checkoutId = record.c;
  const operation = record.o;
  const amount = record.a;
  const fingerprint = record.f;
  const expiresAtMs = record.x;
  if (
    typeof userId !== "string" ||
    userId === "" ||
    typeof checkoutId !== "string" ||
    checkoutId === "" ||
    typeof operation !== "string" ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    typeof fingerprint !== "string" ||
    fingerprint === "" ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs)
  ) {
    // A payload we sealed but can no longer read as we expect. Treated as a bad
    // seal rather than trusted partially.
    return { ok: false, reason: "BAD_SEAL" };
  }

  if (nowMs >= expiresAtMs) {
    return { ok: false, reason: "EXPIRED" };
  }

  return {
    ok: true,
    payload: {
      userId,
      checkoutId,
      operation: operation as CommerceOperation,
      finalPriceToman: amount,
      fingerprint,
      expiresAtMs,
    },
  };
}
