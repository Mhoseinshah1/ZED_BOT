// =============================================================================
// Checkout draft tokens (miniapp-commerce-parity §4/§7).
//
// The bot keeps its pre-invoice draft in the grammY session; a browser gets
// no such trust. The Mini App's draft is therefore SEALED: the quote endpoint
// computes the authoritative pre-invoice and hands back an AES-256-GCM sealed
// capsule of the draft's IDENTITY (product, reservation, note, discount code,
// nonce — never amounts), and the confirm endpoint reopens it, re-validates
// and RE-PRICES everything against live rows before any write. Amounts inside
// a token would be amounts a browser once held — so they are not inside.
//
// Same key discipline as cursor.ts: HMAC-derived key from APP_SECRET, a
// version + purpose string as AAD, random 12-byte nonce, tamper = null.
// Internal uuids ride inside the capsule exactly like they do in cursors —
// sealed, so they never become client-visible identifiers.
// =============================================================================
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = "d1";
const KEY_CONTEXT = "zedbot.miniapp.checkout-draft.key.v1";
const AAD = `${VERSION}.checkout-draft`;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A draft token is only openable this long after minting. Matches the bot's
 * ephemeral pre-invoice horizon; the durable checkout gets its own expiresAt. */
export const DRAFT_TOKEN_TTL_MS = 15 * 60_000;

export type CheckoutDraftKind =
  | "SERVICE"
  | "OTHER"
  | "RENEWAL"
  | "EXTRA_VOLUME"
  | "EXTRA_TIME";

export interface CheckoutDraftCapsule {
  /** Session user the quote was computed for — confirm rejects anyone else. */
  userId: string;
  kind: CheckoutDraftKind;
  /** RENEWAL / EXTRA_* only: the target service (sealed internal uuid). */
  serviceId?: string;
  /** Internal uuid of the quoted product (sealed, never client-visible). */
  productId: string;
  /** Wallet-idempotency seed + reservation linkage; minted server-side. */
  draftNonce: string;
  /** SERVICE only: the HELD reservation the confirm transaction must claim. */
  reservationId?: string;
  usernameMode?: "CUSTOM" | "RANDOM";
  normalizedUsername?: string;
  usernameConfirmedAt?: string;
  /** Normalized subscription note, or null when skipped. */
  note?: string | null;
  /** Raw discount code TEXT — re-validated from scratch at confirm. */
  discountCode?: string;
  mintedAtMs: number;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function draftKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new Error("APP_SECRET is not set; checkout draft tokens cannot be sealed.");
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  const key = createHmac("sha256", secret).update(KEY_CONTEXT).digest();
  cachedKey = { secret, key };
  return key;
}

export function sealDraft(capsule: CheckoutDraftCapsule): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", draftKey(), iv);
  cipher.setAAD(Buffer.from(AAD, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(capsule), "utf8");
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

/** Opens a draft token. Tampered / malformed / expired / wrong-version all
 * collapse to null so the failure shape teaches nothing. */
export function openDraft(token: unknown, nowMs: number): CheckoutDraftCapsule | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot === -1 || token.slice(0, dot) !== VERSION) {
    return null;
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      draftKey(),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(AAD, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plain.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const capsule = parsed as CheckoutDraftCapsule;
    if (
      typeof capsule.userId !== "string" ||
      !["SERVICE", "OTHER", "RENEWAL", "EXTRA_VOLUME", "EXTRA_TIME"].includes(capsule.kind) ||
      typeof capsule.productId !== "string" ||
      typeof capsule.draftNonce !== "string" ||
      typeof capsule.mintedAtMs !== "number"
    ) {
      return null;
    }
    if (nowMs - capsule.mintedAtMs > DRAFT_TOKEN_TTL_MS || capsule.mintedAtMs > nowMs + 60_000) {
      return null;
    }
    return capsule;
  } catch {
    return null;
  }
}
