import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

// =============================================================================
// Mini App session token.
//
// A signed, short-lived, stateless bearer of ONE fact: which database user this
// request belongs to. Deliberately not a session table — there is nothing to
// store that the signature does not already carry, and a table would need
// migrating, sweeping and reconciling for no gain at a 15-minute lifetime.
//
// What it is NOT allowed to be:
//
//   * a permission cache. Every authenticated request re-reads the user's
//     authoritative row. A cookie minted before someone was blocked must not
//     keep working, so the cookie carries no status, no group and no flags.
//   * a profile. No name, no username, no Telegram id — nothing that turns a
//     stolen cookie into a disclosure on its own.
//   * bot-token-derived. The bot token authenticates Telegram's payload; the
//     session authenticates our own cookie. Mixing them means rotating one
//     forces rotating the other.
//
// Key material is derived from APP_SECRET with its own scrypt context, the same
// convention `crypto.ts` uses for stored secrets, so the two key spaces cannot
// collide even though they share a root secret.
// =============================================================================

const SESSION_KEY_CONTEXT = "zedbot.miniapp.session.v1";

/**
 * Version marker in every token.
 *
 * Present so the signing key or the payload shape can change later without a
 * flag day: a token minted under a retired version fails verification cleanly
 * instead of being misread under the new rules.
 */
export const MINIAPP_SESSION_VERSION = "v1";

export const MINIAPP_SESSION_COOKIE_NAME = "zb_miniapp";
/** Scoped so the cookie is never attached to payment webhooks or /health. */
export const MINIAPP_SESSION_COOKIE_PATH = "/api/miniapp";

export const MINIAPP_SESSION_DEFAULT_TTL_SECONDS = 15 * 60;
export const MINIAPP_SESSION_MIN_TTL_SECONDS = 60;
export const MINIAPP_SESSION_MAX_TTL_SECONDS = 60 * 60;

export type MiniAppSessionFailure =
  | "MALFORMED"
  | "UNKNOWN_VERSION"
  | "BAD_SIGNATURE"
  | "EXPIRED";

export interface MiniAppSessionPayload {
  /** Internal database user id — an opaque uuid, never a Telegram id. */
  userId: string;
  /** Unix seconds. Absolute, not a duration: no clock arithmetic at read time. */
  expiresAtSeconds: number;
}

export type MiniAppSessionVerifyResult =
  | { ok: true; payload: MiniAppSessionPayload }
  | { ok: false; reason: MiniAppSessionFailure };

/** Thrown when APP_SECRET is missing — never fall back to an unkeyed token. */
export class MiniAppSessionConfigError extends Error {
  constructor() {
    super(
      "APP_SECRET is not set. The Mini App session cannot be signed without it; add it to the environment and restart.",
    );
    this.name = "MiniAppSessionConfigError";
  }
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function sessionKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new MiniAppSessionConfigError();
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  const key = scryptSync(secret, SESSION_KEY_CONTEXT, 32);
  cachedKey = { secret, key };
  return key;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(body: string): string {
  return base64url(createHmac("sha256", sessionKey()).update(body).digest());
}

/**
 * Mints a token: `v1.<userId b64url>.<expiry>.<signature>`.
 *
 * Dots are safe separators because every field is base64url or digits, so no
 * field can smuggle a separator and shift the boundaries.
 */
export function issueMiniAppSession(userId: string, ttlSeconds: number, nowMs = Date.now()): string {
  const ttl = Math.min(
    Math.max(Math.floor(ttlSeconds), MINIAPP_SESSION_MIN_TTL_SECONDS),
    MINIAPP_SESSION_MAX_TTL_SECONDS,
  );
  const expiresAt = Math.floor(nowMs / 1000) + ttl;
  const body = `${MINIAPP_SESSION_VERSION}.${base64url(Buffer.from(userId, "utf8"))}.${expiresAt}`;
  return `${body}.${sign(body)}`;
}

/**
 * Verifies a token.
 *
 * Signature first, expiry second — an unsigned token must not be able to learn
 * whether its guessed expiry was plausible.
 */
export function verifyMiniAppSession(
  token: string,
  nowMs = Date.now(),
): MiniAppSessionVerifyResult {
  if (typeof token !== "string" || token === "") {
    return { ok: false, reason: "MALFORMED" };
  }
  const parts = token.split(".");
  if (parts.length !== 4) {
    return { ok: false, reason: "MALFORMED" };
  }
  const [version, encodedUserId, rawExpiry, signature] = parts;
  if (version !== MINIAPP_SESSION_VERSION) {
    return { ok: false, reason: "UNKNOWN_VERSION" };
  }
  if (!/^\d{1,15}$/.test(rawExpiry)) {
    return { ok: false, reason: "MALFORMED" };
  }

  const expected = Buffer.from(sign(`${version}.${encodedUserId}.${rawExpiry}`), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  const expiresAtSeconds = Number.parseInt(rawExpiry, 10);
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (Math.floor(nowMs / 1000) >= expiresAtSeconds) {
    return { ok: false, reason: "EXPIRED" };
  }

  let userId: string;
  try {
    userId = Buffer.from(encodedUserId, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (userId === "") {
    return { ok: false, reason: "MALFORMED" };
  }
  return { ok: true, payload: { userId, expiresAtSeconds } };
}

export interface MiniAppCookieOptions {
  /** `Secure` is set only in production; local dev is plain http. */
  secure: boolean;
  maxAgeSeconds: number;
}

/** Serialises the Set-Cookie value. HttpOnly always — JS must never read it. */
export function serializeMiniAppSessionCookie(
  token: string,
  options: MiniAppCookieOptions,
): string {
  const attributes = [
    `${MINIAPP_SESSION_COOKIE_NAME}=${token}`,
    `Path=${MINIAPP_SESSION_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    // Lax, not None: the Mini App is served from the SAME origin as the API, so
    // no cross-site request needs the cookie. `SameSite=None` would be required
    // only for a split-origin deployment and would weaken CSRF posture for
    // nothing.
    "SameSite=Lax",
  ];
  if (options.secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/** Clearing cookie: same name/path/flags, empty value, immediate expiry. */
export function serializeMiniAppSessionClearCookie(secure: boolean): string {
  return serializeMiniAppSessionCookie("", { secure, maxAgeSeconds: 0 });
}

/** Reads our cookie out of a raw Cookie header without a parser dependency. */
export function readMiniAppSessionCookie(header: string | undefined): string | null {
  if (typeof header !== "string" || header === "") {
    return null;
  }
  for (const chunk of header.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (chunk.slice(0, eq).trim() === MINIAPP_SESSION_COOKIE_NAME) {
      return chunk.slice(eq + 1).trim();
    }
  }
  return null;
}
