import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Telegram Mini App `initData` validation.
//
// This is the ONLY thing that establishes who a Mini App caller is. The
// frontend's `Telegram.WebApp.initDataUnsafe` is, as its name says, unsafe: it
// is plain JavaScript state that anyone can edit before the request leaves the
// page. Only the raw signed `initData` string proves anything, and only after
// the HMAC below verifies against the bot token.
//
// Telegram publishes TWO different validation schemes over the same payload,
// and they exclude DIFFERENT fields. Mixing them up produces code that looks
// right and rejects every real payload:
//
//   1. Bot-token HMAC-SHA256 — what this module implements.
//
//        secret_key        = HMAC_SHA256(key="WebAppData", data=<bot token>)
//        data_check_string = "<k>=<v>" for every received field EXCEPT `hash`,
//                            sorted by key, joined with "\n"
//        expected          = HMAC_SHA256(key=secret_key, data=data_check_string)
//
//      `signature` is an ordinary signed field here: it IS part of the
//      data-check-string. Telegram signs whatever it sends, `signature`
//      included, so excluding it changes the bytes and fails every modern
//      payload — which now always carries `signature`.
//
//   2. Third-party Ed25519 — NOT implemented here (it verifies the payload
//      without holding the bot token, which is not this server's situation).
//      That scheme excludes BOTH `hash` and `signature`, and prefixes the
//      check string with "<bot_id>:WebAppData\n". `buildThirdPartyCheckString`
//      below exists so the difference is executable and testable rather than a
//      comment that can drift.
//
// Two further properties are load-bearing and easy to get wrong:
//
//   * The values fed into the check string are the DECODED values exactly as
//     received. Re-encoding, trimming or normalising them changes the bytes
//     Telegram signed and turns a valid payload invalid (or, worse, lets two
//     different payloads produce one check string).
//   * Sorting is by key over the decoded keys, not over the raw query order.
//
// Everything here is pure: no database, no environment reads, no I/O. That is
// what makes the failure modes testable one at a time.
// =============================================================================

/** Telegram rejects anything larger long before this; 8 KiB is a generous cap. */
export const MINIAPP_INITDATA_MAX_BYTES = 8 * 1024;

/** Default freshness window. Telegram's own examples use the same order. */
export const MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * How far into the future an `auth_date` may sit before it is rejected.
 *
 * Not zero: the server clock and Telegram's are independent, and a payload
 * signed a moment ago can carry a timestamp a second or two ahead. Thirty
 * seconds absorbs ordinary NTP drift while still refusing a timestamp that
 * could only come from a clock someone controls.
 */
export const MINIAPP_INITDATA_MAX_FUTURE_SKEW_SECONDS = 30;

export type MiniAppInitDataFailure =
  | "EMPTY"
  | "TOO_LARGE"
  | "MALFORMED_ENCODING"
  | "DUPLICATE_KEY"
  | "MISSING_HASH"
  | "MALFORMED_HASH"
  | "MISSING_AUTH_DATE"
  | "MALFORMED_AUTH_DATE"
  | "EXPIRED"
  | "FUTURE_AUTH_DATE"
  | "MISSING_USER"
  | "MALFORMED_USER"
  | "BAD_SIGNATURE";

export interface MiniAppInitDataUser {
  /**
   * BigInt, never `number`. Telegram ids already exceed the 32-bit range and
   * the column behind them is a PostgreSQL `BIGINT`; parsing through a double
   * would silently round ids above 2^53.
   */
  telegramId: bigint;
  firstName: string;
  lastName: string;
  username: string;
  languageCode: string;
  isBot: boolean;
}

export type MiniAppInitDataResult =
  | { ok: true; user: MiniAppInitDataUser; authDateSeconds: number }
  | { ok: false; reason: MiniAppInitDataFailure };

export interface MiniAppInitDataOptions {
  botToken: string;
  /** Seconds. Values outside a sane range are clamped by the caller, not here. */
  maxAgeSeconds?: number;
  /** Injected in tests; production passes nothing and gets server time. */
  nowSeconds?: number;
}

/** Percent-decoding that reports malformed input instead of throwing. */
function decodeComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    // URIError: a stray `%` or an invalid escape sequence.
    return null;
  }
}

/**
 * Strict `application/x-www-form-urlencoded` parsing.
 *
 * `URLSearchParams` is deliberately not used: it accepts duplicate keys and
 * silently keeps one of them, which would let an attacker append a second
 * `hash=` or a second `user=` and have the verifier and the consumer disagree
 * about which value is real. Duplicates are rejected outright.
 */
function parseStrict(
  initData: string,
): { ok: true; pairs: Map<string, string> } | { ok: false; reason: MiniAppInitDataFailure } {
  const pairs = new Map<string, string>();
  for (const chunk of initData.split("&")) {
    if (chunk === "") {
      continue;
    }
    const eq = chunk.indexOf("=");
    if (eq <= 0) {
      // No key, or no "=" at all — not a shape Telegram ever produces.
      return { ok: false, reason: "MALFORMED_ENCODING" };
    }
    const key = decodeComponent(chunk.slice(0, eq));
    const value = decodeComponent(chunk.slice(eq + 1));
    if (key === null || value === null) {
      return { ok: false, reason: "MALFORMED_ENCODING" };
    }
    if (pairs.has(key)) {
      return { ok: false, reason: "DUPLICATE_KEY" };
    }
    pairs.set(key, value);
  }
  return { ok: true, pairs };
}

/** Lowercase hex of exactly 32 bytes. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Data-check-string for the BOT-TOKEN HMAC scheme.
 *
 * Excludes exactly one field: `hash`. Everything else Telegram sent — including
 * `signature` — is signed and must be present, byte for byte as received.
 */
export function buildBotTokenCheckString(pairs: Iterable<[string, string]>): string {
  return [...pairs]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * Data-check-string for the THIRD-PARTY Ed25519 scheme.
 *
 * Not used by this server — it holds the bot token and so uses the HMAC scheme
 * above. It is written out here so the two field rules sit side by side and a
 * test can prove they differ, instead of one silently drifting into the other.
 *
 * Excludes `hash` AND `signature`, and prefixes "<bot_id>:WebAppData\n".
 */
export function buildThirdPartyCheckString(
  pairs: Iterable<[string, string]>,
  botId: string,
): string {
  const body = [...pairs]
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `${botId}:WebAppData\n${body}`;
}

/**
 * Extracts the Telegram id from the raw `user` JSON WITHOUT going through a
 * double.
 *
 * `JSON.parse` turns every number into an IEEE-754 double, so an id above 2^53
 * comes back rounded — a silently wrong account. Reading the digits directly
 * and handing them to `BigInt` keeps every digit.
 */
function extractTelegramId(rawUserJson: string): bigint | null {
  const match = /"id"\s*:\s*(-?\d+)/.exec(rawUserJson);
  if (match === null) {
    return null;
  }
  try {
    const id = BigInt(match[1]);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * Validates a raw `initData` string and returns the Telegram user it proves.
 *
 * Returns a reason code rather than throwing: every branch here is an expected,
 * attacker-reachable outcome, and the caller maps them onto one generic HTTP
 * response so the codes never become an oracle.
 */
export function validateMiniAppInitData(
  initData: string,
  options: MiniAppInitDataOptions,
): MiniAppInitDataResult {
  if (typeof initData !== "string" || initData === "") {
    return { ok: false, reason: "EMPTY" };
  }
  // Measured in BYTES, not characters: a multi-byte payload must not slip past
  // a length check that counted UTF-16 units.
  if (Buffer.byteLength(initData, "utf8") > MINIAPP_INITDATA_MAX_BYTES) {
    return { ok: false, reason: "TOO_LARGE" };
  }

  const parsed = parseStrict(initData);
  if (!parsed.ok) {
    return parsed;
  }
  const pairs = parsed.pairs;

  const hash = pairs.get("hash");
  if (hash === undefined || hash === "") {
    return { ok: false, reason: "MISSING_HASH" };
  }
  // Length and alphabet are checked BEFORE the comparison: `timingSafeEqual`
  // throws on a length mismatch, and an uppercase hash would fail comparison
  // for the wrong reason. Telegram emits lowercase hex.
  if (!HASH_PATTERN.test(hash)) {
    return { ok: false, reason: "MALFORMED_HASH" };
  }

  const rawAuthDate = pairs.get("auth_date");
  if (rawAuthDate === undefined || rawAuthDate === "") {
    return { ok: false, reason: "MISSING_AUTH_DATE" };
  }
  if (!/^\d{1,15}$/.test(rawAuthDate)) {
    return { ok: false, reason: "MALFORMED_AUTH_DATE" };
  }
  const authDateSeconds = Number.parseInt(rawAuthDate, 10);
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    return { ok: false, reason: "MALFORMED_AUTH_DATE" };
  }

  const rawUser = pairs.get("user");
  if (rawUser === undefined || rawUser === "") {
    return { ok: false, reason: "MISSING_USER" };
  }

  // --- signature ------------------------------------------------------------
  // Built from the values as received, excluding only `hash`. `signature`, when
  // present, is a signed field like any other — see the header for why the
  // third-party scheme's extra exclusion must not leak into this one.
  const checkString = buildBotTokenCheckString(pairs);

  const secretKey = createHmac("sha256", "WebAppData").update(options.botToken).digest();
  const expected = createHmac("sha256", secretKey).update(checkString).digest();
  const received = Buffer.from(hash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  // --- freshness ------------------------------------------------------------
  // Checked only AFTER the signature: an unsigned payload must never be able to
  // tell the difference between "wrong key" and "too old".
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS;
  if (authDateSeconds > now + MINIAPP_INITDATA_MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "FUTURE_AUTH_DATE" };
  }
  if (now - authDateSeconds > maxAge) {
    return { ok: false, reason: "EXPIRED" };
  }

  // --- user payload ---------------------------------------------------------
  const telegramId = extractTelegramId(rawUser);
  if (telegramId === null) {
    return { ok: false, reason: "MALFORMED_USER" };
  }
  let parsedUser: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(rawUser);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { ok: false, reason: "MALFORMED_USER" };
    }
    parsedUser = candidate as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "MALFORMED_USER" };
  }

  return {
    ok: true,
    authDateSeconds,
    user: {
      telegramId,
      firstName: readString(parsedUser, "first_name"),
      lastName: readString(parsedUser, "last_name"),
      username: readString(parsedUser, "username"),
      languageCode: readString(parsedUser, "language_code"),
      isBot: parsedUser.is_bot === true,
    },
  };
}
