import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MINIAPP_INITDATA_MAX_BYTES,
  validateMiniAppInitData,
} from "@zedbot/shared";

// =============================================================================
// Telegram Mini App initData validation (M01-M16).
//
// Every signature here is produced INDEPENDENTLY of the implementation: the
// helper below re-implements Telegram's published algorithm from the spec
// rather than calling the validator's internals. A test that signed with the
// validator's own code would pass even if both were wrong in the same way.
// =============================================================================

const BOT_TOKEN = "123456:AA-test-token-for-initdata-vectors";

/** Telegram's algorithm, written out independently. */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .filter((k) => k !== "hash" && k !== "signature")
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

  it("M15 accepts a payload carrying Telegram's third-party signature field", () => {
    // `signature` must be excluded from the bot-token HMAC; including it would
    // break every real modern payload.
    const fields = baseFields();
    const signed = `${signInitData(fields)}&signature=${encodeURIComponent("abc.def")}`;
    expect(validate(signed).ok).toBe(true);
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
});
