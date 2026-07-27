import { createHmac, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MINIAPP_INITDATA_MAX_BYTES,
  buildThirdPartyCheckString,
  validateMiniAppInitData,
} from "@zedbot/shared";

// =============================================================================
// Telegram Mini App initData validation (M01-M24).
//
// Two independent layers of evidence, because the first one alone is not
// enough:
//
//   1. FIXED EXTERNAL VECTORS (M17-M22). Four `initData` strings published by
//      two unrelated third-party libraries - aiogram (Python) and
//      telegram-apps/init-data-node (TypeScript) - together with the bot tokens
//      that signed them and the `hash` values they expect. These hashes are
//      literals copied from other projects. No code in this repository, correct
//      or otherwise, participated in producing them, so they cannot agree with
//      a mistake here. This is the layer that catches a wrong field rule.
//
//   2. A LOCAL SIGNER (M01-M16) that re-implements Telegram's algorithm from
//      the spec for the cases external vectors cannot cover - tampering,
//      expiry, oversize payloads, ids beyond 2^53. It deliberately does NOT
//      import the production helper: a shared mistake would make both sides
//      agree and the suite would go green while production rejected every real
//      user. The external vectors above are what prove this signer is right.
//
// The field rules the vectors pin down, which are NOT the same:
//
//   bot-token HMAC   -> data-check-string excludes ONLY `hash`.
//                       `signature`, when present, IS signed.
//   third-party Ed25519 -> excludes `hash` AND `signature`, and is prefixed
//                       with "<bot_id>:WebAppData\n".
//
// M21 and M22 prove the difference is real rather than asserted: the same
// payload validates under one rule and fails under the other, in both
// directions, using a genuine Telegram signature and Telegram's own published
// production public key.
// =============================================================================

const BOT_TOKEN = "123456:AA-test-token-for-initdata-vectors";

/**
 * Telegram's bot-token algorithm, written out from the specification.
 *
 * Excludes exactly one field - `hash`. Anything else Telegram sends, including
 * `signature`, is part of the signed string.
 */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

const NOW = 1_800_000_000;

function userJson(id: string | number = 777_000_111): string {
  return JSON.stringify({
    id: typeof id === "string" ? Number(id) : id,
    first_name: "Ali",
    last_name: "R",
    username: "ali_r",
    language_code: "fa",
  });
}

/** A user JSON carrying an id too large for a double, written literally. */
function bigIdUserJson(id: string): string {
  return `{"id":${id},"first_name":"Ali","username":"ali_r"}`;
}

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW - 10),
    query_id: "AAHtest",
    user: userJson(),
    ...overrides,
  };
}

function validate(initData: string, nowSeconds = NOW) {
  return validateMiniAppInitData(initData, { botToken: BOT_TOKEN, nowSeconds });
}

// --- fixed external vectors --------------------------------------------------
//
// Copied verbatim from the published test suites of two unrelated projects.
// Sources:
//   aiogram        - tests/test_utils/test_web_app.py           (token "42:TEST")
//   telegram-apps  - packages/init-data-node/src/entries/node.test.ts
//
// The `hash` inside each string is the value those projects assert. Nothing
// here is computed by this repository.

/** aiogram, token `42:TEST`. A real-format payload with NO `signature` field. */
const VECTOR_NO_SIGNATURE = {
  token: "42:TEST",
  authDate: 1_650_385_342,
  raw:
    "auth_date=1650385342&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Test%22%7D" +
    "&query_id=test" +
    "&hash=46d2ea5e32911ec8d30999b56247654460c0d20949b6277af519e76271182803",
} as const;

/**
 * aiogram, token `42:TEST`. Same era, but the values carry `+`-encoded spaces,
 * which pins the decoding rule: `+` becomes a space BEFORE percent-decoding,
 * and the decoded value is what gets signed.
 */
const VECTOR_PLUS_ENCODED = {
  token: "42:TEST",
  authDate: 1_650_385_342,
  raw:
    "auth_date=1650385342&user=%7B%22id%22%3A+%22123456789%22%2C+%22first_name%22%3A+" +
    "%22PlaceholderFirstName%22%2C+%22last_name%22%3A+%22PlaceholderLastName+" +
    "%5Cud83c%5Cuddfa%5Cud83c%5Cudde6%22%2C+%22username%22%3A+%22Latand%22%2C+" +
    "%22language_code%22%3A+%22en%22%2C+%22is_premium%22%3A+%22true%22%2C+" +
    "%22allows_write_to_pm%22%3A+%22true%22%7D&query_id=test" +
    "&hash=b3c8b293f14ad0f7f0abcf769aea1209a72295d30a87eb0e74df855d32e53bfe",
} as const;

/**
 * telegram-apps. Carries `signature` with an EMPTY value.
 *
 * Even empty, the field is part of the signed string: dropping it removes a
 * whole `signature=` line and changes the digest. This is the cheapest possible
 * proof that `signature` is not excluded from the bot-token HMAC.
 */
const VECTOR_EMPTY_SIGNATURE = {
  token: "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8",
  authDate: 1,
  raw:
    "can_send_after=10000&chat=%7B%22id%22%3A1%2C%22type%22%3A%22group%22%2C%22username" +
    "%22%3A%22my-chat%22%2C%22title%22%3A%22chat-title%22%2C%22photo_url%22%3A%22chat-" +
    "photo%22%7D&chat_instance=888&chat_type=sender&query_id=QUERY&receiver=%7B%22added" +
    "_to_attachment_menu%22%3Afalse%2C%22allows_write_to_pm%22%3Atrue%2C%22first_name" +
    "%22%3A%22receiver-first-name%22%2C%22id%22%3A991%2C%22is_bot%22%3Afalse%2C%22is_" +
    "premium%22%3Atrue%2C%22language_code%22%3A%22ru%22%2C%22last_name%22%3A%22receiver-" +
    "last-name%22%2C%22photo_url%22%3A%22receiver-photo%22%2C%22username%22%3A%22receiver-" +
    "username%22%7D&start_param=debug&user=%7B%22added_to_attachment_menu%22%3Afalse%2C" +
    "%22allows_write_to_pm%22%3Afalse%2C%22first_name%22%3A%22user-first-name%22%2C%22id" +
    "%22%3A222%2C%22is_bot%22%3Atrue%2C%22is_premium%22%3Afalse%2C%22language_code%22%3A" +
    "%22en%22%2C%22last_name%22%3A%22user-last-name%22%2C%22photo_url%22%3A%22user-photo" +
    "%22%2C%22username%22%3A%22user-username%22%7D&auth_date=1&signature=" +
    "&hash=cc10443c8ae0ee6c7b97bac5db17c64ed07ef0755627b1ca70a72ac5c39d89e9",
} as const;

/**
 * telegram-apps. A genuine payload from a real bot, with a real non-empty
 * Ed25519 `signature`.
 *
 * This is the vector that matters most: it is exactly the shape Telegram sends
 * today, and it is the one an implementation that excludes `signature` rejects.
 */
const VECTOR_REAL_SIGNATURE = {
  token: "7342037359:AAFZehRPBRs8Seg40oDjTMIW8uTGPuW1zfQ",
  botId: "7342037359",
  authDate: 1_733_584_787,
  telegramId: 279_058_397n,
  raw:
    "user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%20%2B%20-%20%3F%20" +
    "%5C%2F%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C" +
    "%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%2C%22allows_write_to_pm" +
    "%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic" +
    "%5C%2F320%5C%2F4FPEE4tmP3ATHa57u6MqTDih13LTOiMoKoLDRG4PnSA.svg%22%7D" +
    "&chat_instance=8134722200314281151&chat_type=private&auth_date=1733584787" +
    "&signature=zL-ucjNyREiHDE8aihFwpfR9aggP2xiAo3NSpfe-p7IbCisNlDKlo7Kb6G4D0Ao2mBrSgEk4maLSdv6MLIlADQ" +
    "&hash=2174df5b000556d044f3f020384e879c8efcab55ddea2ced4eb752e93e7080d6",
} as const;

/** Telegram's published PRODUCTION Ed25519 public key for third-party validation. */
const TELEGRAM_PRODUCTION_ED25519_KEY =
  "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";

/** Wraps a raw 32-byte Ed25519 key in the SPKI DER header Node requires. */
function ed25519PublicKey(hex: string) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(hex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
}

/** Decoded `k=v` pairs, in received order - the input both check-string rules take. */
function decodedPairs(raw: string): [string, string][] {
  return raw.split("&").map((chunk) => {
    const eq = chunk.indexOf("=");
    return [
      decodeURIComponent(chunk.slice(0, eq).replace(/\+/g, " ")),
      decodeURIComponent(chunk.slice(eq + 1).replace(/\+/g, " ")),
    ] as [string, string];
  });
}

describe("mini app initData validation", () => {
  it("M01 accepts a valid official-format payload", () => {
    const result = validate(signInitData(baseFields()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.telegramId).toBe(777_000_111n);
      expect(result.user.username).toBe("ali_r");
      expect(result.authDateSeconds).toBe(NOW - 10);
    }
  });

  it("M02 rejects tampered user JSON", () => {
    const signed = signInitData(baseFields());
    // Same signature, different user — the classic impersonation attempt.
    const tampered = signed.replace(
      encodeURIComponent(userJson()),
      encodeURIComponent(userJson(999_000_222)),
    );
    expect(validate(tampered)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M03 rejects a tampered auth_date", () => {
    const signed = signInitData(baseFields());
    const tampered = signed.replace(`auth_date=${NOW - 10}`, `auth_date=${NOW - 1}`);
    expect(validate(tampered)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M04 rejects a payload signed with a different bot token", () => {
    const signed = signInitData(baseFields(), "999999:AA-someone-elses-token");
    expect(validate(signed)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M05 rejects an uppercase or malformed hash before comparison", () => {
    const signed = signInitData(baseFields());
    const upper = signed.replace(/hash=([0-9a-f]{64})/, (_m, h: string) =>
      `hash=${h.toUpperCase()}`,
    );
    expect(validate(upper)).toEqual({ ok: false, reason: "MALFORMED_HASH" });
    expect(validate(signed.replace(/hash=[0-9a-f]{64}/, "hash=abc"))).toEqual({
      ok: false,
      reason: "MALFORMED_HASH",
    });
  });

  it("M06 rejects duplicate query keys", () => {
    const signed = signInitData(baseFields());
    // A second `user=` is exactly how a parser disagreement becomes an exploit.
    const duplicated = `${signed}&user=${encodeURIComponent(userJson(1))}`;
    expect(validate(duplicated)).toEqual({ ok: false, reason: "DUPLICATE_KEY" });
  });

  it("M07 rejects a missing hash", () => {
    const fields = baseFields();
    const withoutHash = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    expect(validate(withoutHash)).toEqual({ ok: false, reason: "MISSING_HASH" });
  });

  it("M08 rejects a missing user", () => {
    const fields = { auth_date: String(NOW - 10), query_id: "AAHtest" };
    expect(validate(signInitData(fields))).toEqual({ ok: false, reason: "MISSING_USER" });
  });

  it("M09 rejects malformed user JSON that still carries an id", () => {
    const signed = signInitData(baseFields({ user: '{"id":5,"first_name":' }));
    expect(validate(signed)).toEqual({ ok: false, reason: "MALFORMED_USER" });
  });

  it("M10 rejects malformed percent encoding", () => {
    expect(validate("auth_date=1&user=%E0%A4%A&hash=" + "a".repeat(64))).toEqual({
      ok: false,
      reason: "MALFORMED_ENCODING",
    });
  });

  it("M11 rejects a payload above 8 KiB", () => {
    const huge = signInitData(baseFields({ query_id: "A".repeat(MINIAPP_INITDATA_MAX_BYTES) }));
    expect(validate(huge)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("M12 rejects a stale auth_date", () => {
    const signed = signInitData(baseFields({ auth_date: String(NOW - 3600) }));
    expect(validate(signed)).toEqual({ ok: false, reason: "EXPIRED" });
    // ...and accepts it when the caller widens the window.
    expect(
      validateMiniAppInitData(signed, {
        botToken: BOT_TOKEN,
        nowSeconds: NOW,
        maxAgeSeconds: 7200,
      }).ok,
    ).toBe(true);
  });

  it("M13 rejects an auth_date too far in the future but tolerates small skew", () => {
    const far = signInitData(baseFields({ auth_date: String(NOW + 600) }));
    expect(validate(far)).toEqual({ ok: false, reason: "FUTURE_AUTH_DATE" });
    // A few seconds ahead is ordinary clock drift, not an attack.
    const near = signInitData(baseFields({ auth_date: String(NOW + 5) }));
    expect(validate(near).ok).toBe(true);
  });

  it("M14 preserves a Telegram id far above the 32-bit range", () => {
    const id = "8646911284551352321"; // > 2^53, would round through a double
    const signed = signInitData(baseFields({ user: bigIdUserJson(id) }));
    const result = validate(signed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.telegramId).toBe(BigInt(id));
      expect(result.user.telegramId.toString()).toBe(id);
    }
  });

  it("M15 signs `signature` like any other field", () => {
    // A payload whose `signature` was included when signing must verify, and the
    // same payload with `signature` stripped must NOT - which is only true if
    // the field participates in the data-check-string.
    const fields = baseFields({ signature: "abc.def" });
    const signed = signInitData(fields);
    expect(validate(signed).ok).toBe(true);
    const stripped = signed.replace(`&signature=${encodeURIComponent("abc.def")}`, "");
    expect(validate(stripped)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M16 rejects an empty payload and a hash of the wrong byte length", () => {
    expect(validate("")).toEqual({ ok: false, reason: "EMPTY" });
    // 63 hex chars: `timingSafeEqual` would throw on a length mismatch, so the
    // length gate must run first.
    const short = signInitData(baseFields()).replace(/hash=([0-9a-f]{64})/, (_m, h: string) =>
      `hash=${h.slice(0, 63)}`,
    );
    expect(validate(short)).toEqual({ ok: false, reason: "MALFORMED_HASH" });
  });

  // --- fixed external vectors -----------------------------------------------

  it("M17 accepts the published aiogram vector that carries no `signature`", () => {
    const v = VECTOR_NO_SIGNATURE;
    const result = validateMiniAppInitData(v.raw, {
      botToken: v.token,
      nowSeconds: v.authDate,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.telegramId).toBe(42n);
      expect(result.user.firstName).toBe("Test");
      expect(result.authDateSeconds).toBe(v.authDate);
    }
  });

  it("M18 accepts the published aiogram vector with `+`-encoded spaces", () => {
    // The signature covers the DECODED values, so `+` must become a space before
    // percent-decoding. Re-encoding or skipping that step changes the digest.
    const v = VECTOR_PLUS_ENCODED;
    const result = validateMiniAppInitData(v.raw, {
      botToken: v.token,
      nowSeconds: v.authDate,
    });
    // The signature is valid; the payload is rejected later, for the unrelated
    // reason that this fixture writes `id` as a string rather than a number.
    // Reaching MALFORMED_USER at all proves the HMAC passed.
    expect(result).toEqual({ ok: false, reason: "MALFORMED_USER" });
  });

  it("M19 accepts the published vector whose `signature` field is present but empty", () => {
    const v = VECTOR_EMPTY_SIGNATURE;
    const result = validateMiniAppInitData(v.raw, {
      botToken: v.token,
      nowSeconds: v.authDate,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.telegramId).toBe(222n);
      expect(result.user.username).toBe("user-username");
    }
    // Removing the empty `signature=` field changes the signed bytes.
    const withoutSignature = v.raw.replace("&signature=", "");
    expect(
      validateMiniAppInitData(withoutSignature, { botToken: v.token, nowSeconds: v.authDate }),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M20 accepts a real Telegram payload carrying a real non-empty `signature`", () => {
    // This is the shape Telegram sends today. An implementation that excludes
    // `signature` from the bot-token HMAC rejects this - and therefore rejects
    // every current production user.
    const v = VECTOR_REAL_SIGNATURE;
    const result = validateMiniAppInitData(v.raw, {
      botToken: v.token,
      nowSeconds: v.authDate,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.telegramId).toBe(v.telegramId);
      expect(result.user.username).toBe("vdkfrost");
      // Percent-decoding is exact: `%20` is a space, `%2B` a literal plus.
      expect(result.user.firstName).toBe("Vladislav + - ? /");
    }
  });

  it("M21 rejects the real payload once its `signature` is tampered with", () => {
    const v = VECTOR_REAL_SIGNATURE;
    // Flip one character of the Ed25519 signature, leaving `hash` untouched. If
    // `signature` were excluded from the data-check-string this would still
    // verify, and an attacker could swap the third-party proof at will.
    const tampered = v.raw.replace("&signature=zL-", "&signature=zL0");
    expect(
      validateMiniAppInitData(tampered, { botToken: v.token, nowSeconds: v.authDate }),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    // Dropping the field entirely is likewise rejected.
    const dropped = v.raw.replace(
      /&signature=[^&]*/,
      "",
    );
    expect(
      validateMiniAppInitData(dropped, { botToken: v.token, nowSeconds: v.authDate }),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M22 builds the third-party check string by a different, verifiable rule", () => {
    // The third-party Ed25519 scheme excludes `hash` AND `signature`, and is
    // prefixed with "<bot_id>:WebAppData\n". The proof is external and total:
    // Telegram's own published PRODUCTION public key verifies the real
    // signature over the string this helper builds — and refuses the string the
    // bot-token rule would build. Neither rule can drift into the other without
    // this failing.
    const v = VECTOR_REAL_SIGNATURE;
    const pairs = decodedPairs(v.raw);
    const signatureField = pairs.find(([k]) => k === "signature");
    expect(signatureField).toBeDefined();
    const signature = Buffer.from(signatureField?.[1] ?? "", "base64url");
    expect(signature).toHaveLength(64);
    const key = ed25519PublicKey(TELEGRAM_PRODUCTION_ED25519_KEY);

    const thirdParty = buildThirdPartyCheckString(pairs, v.botId);
    expect(verifyEd25519(null, Buffer.from(thirdParty, "utf8"), key, signature)).toBe(true);

    // Same payload, bot-token field rule (only `hash` removed, no prefix): not a
    // valid Ed25519 message.
    const botTokenShaped = `${v.botId}:WebAppData\n${pairs
      .filter(([k]) => k !== "hash")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${k}=${val}`)
      .join("\n")}`;
    expect(verifyEd25519(null, Buffer.from(botTokenShaped, "utf8"), key, signature)).toBe(false);

    // And the constructions are textually distinct on this payload.
    expect(thirdParty).not.toContain("\nsignature=");
    expect(thirdParty.startsWith(`${v.botId}:WebAppData\n`)).toBe(true);
    expect(thirdParty).not.toContain("\nhash=");
  });

  it("M23 rejects a duplicate `signature` or `hash` on an otherwise valid vector", () => {
    // Two `signature=` fields would let the HMAC and any downstream consumer
    // disagree about which one is real.
    const v = VECTOR_REAL_SIGNATURE;
    expect(
      validateMiniAppInitData(`${v.raw}&signature=other`, {
        botToken: v.token,
        nowSeconds: v.authDate,
      }),
    ).toEqual({ ok: false, reason: "DUPLICATE_KEY" });
    expect(
      validateMiniAppInitData(`${v.raw}&hash=${"0".repeat(64)}`, {
        botToken: v.token,
        nowSeconds: v.authDate,
      }),
    ).toEqual({ ok: false, reason: "DUPLICATE_KEY" });
  });

  it("M24 rejects malformed fields on an otherwise valid vector", () => {
    const v = VECTOR_REAL_SIGNATURE;
    const opts = { botToken: v.token, nowSeconds: v.authDate };
    // A stray percent escape inside a real payload.
    expect(validateMiniAppInitData(v.raw.replace("&chat_type=", "&chat_type=%E0%A4"), opts)).toEqual(
      { ok: false, reason: "MALFORMED_ENCODING" },
    );
    // A field with no "=" at all.
    expect(validateMiniAppInitData(`${v.raw}&stray`, opts)).toEqual({
      ok: false,
      reason: "MALFORMED_ENCODING",
    });
    // A field with an empty key.
    expect(validateMiniAppInitData(`${v.raw}&=x`, opts)).toEqual({
      ok: false,
      reason: "MALFORMED_ENCODING",
    });
    // A non-numeric auth_date is caught before any signature work.
    expect(
      validateMiniAppInitData(v.raw.replace("auth_date=1733584787", "auth_date=yesterday"), opts),
    ).toEqual({ ok: false, reason: "MALFORMED_AUTH_DATE" });
  });
});
