import { beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "miniapp-session-test-secret-0123456789abcdef";

import {
  issueMiniAppSession,
  MINIAPP_SESSION_COOKIE_NAME,
  MINIAPP_SESSION_COOKIE_PATH,
  MINIAPP_SESSION_MAX_TTL_SECONDS,
  MINIAPP_SESSION_MIN_TTL_SECONDS,
  readMiniAppSessionCookie,
  serializeMiniAppSessionClearCookie,
  serializeMiniAppSessionCookie,
  verifyMiniAppSession,
} from "@zedbot/shared";

// =============================================================================
// Mini App session token and cookie (M17-M25).
// =============================================================================

const USER_ID = "3f1b7c2a-0000-4000-8000-abcdefabcdef";
const NOW = 1_800_000_000_000; // ms

describe("mini app session", () => {
  beforeAll(() => {
    expect(process.env.APP_SECRET).toBeTruthy();
  });

  it("M17 accepts a freshly issued token and returns the user id", () => {
    const token = issueMiniAppSession(USER_ID, 900, NOW);
    const result = verifyMiniAppSession(token, NOW + 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.userId).toBe(USER_ID);
      expect(result.payload.expiresAtSeconds).toBe(Math.floor(NOW / 1000) + 900);
    }
  });

  it("M18 rejects an expired token", () => {
    const token = issueMiniAppSession(USER_ID, 60, NOW);
    expect(verifyMiniAppSession(token, NOW + 61_000)).toEqual({ ok: false, reason: "EXPIRED" });
    // Exactly at expiry is already too late.
    expect(verifyMiniAppSession(token, NOW + 60_000)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("M19 rejects a tampered payload", () => {
    const token = issueMiniAppSession(USER_ID, 900, NOW);
    const [version, encodedUser, expiry, signature] = token.split(".");
    const otherUser = Buffer.from("00000000-0000-4000-8000-000000000000", "utf8").toString(
      "base64url",
    );
    // Swapped user, original signature.
    expect(
      verifyMiniAppSession(`${version}.${otherUser}.${expiry}.${signature}`, NOW),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    // Extended expiry, original signature.
    expect(
      verifyMiniAppSession(`${version}.${encodedUser}.${expiry}0.${signature}`, NOW),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("M20 rejects an unknown signing version", () => {
    const token = issueMiniAppSession(USER_ID, 900, NOW);
    const parts = token.split(".");
    expect(verifyMiniAppSession(`v2.${parts[1]}.${parts[2]}.${parts[3]}`, NOW)).toEqual({
      ok: false,
      reason: "UNKNOWN_VERSION",
    });
  });

  it("M21 clearing cookie expires immediately and keeps name, path and flags", () => {
    const cleared = serializeMiniAppSessionClearCookie(true);
    expect(cleared).toContain(`${MINIAPP_SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain(`Path=${MINIAPP_SESSION_COOKIE_PATH}`);
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
  });

  it("M22 cookie carries HttpOnly, SameSite=Lax and a scoped path", () => {
    const cookie = serializeMiniAppSessionCookie("tok", { secure: true, maxAgeSeconds: 900 });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // Scoped so it is never sent to payment webhooks, /health or /version.
    expect(cookie).toContain("Path=/api/miniapp");
  });

  it("M23 Secure is set in production and omitted for local http", () => {
    expect(serializeMiniAppSessionCookie("t", { secure: true, maxAgeSeconds: 60 })).toContain(
      "Secure",
    );
    expect(serializeMiniAppSessionCookie("t", { secure: false, maxAgeSeconds: 60 })).not.toContain(
      "Secure",
    );
  });

  it("M24 clamps the lifetime into safe bounds", () => {
    const tooShort = verifyMiniAppSession(issueMiniAppSession(USER_ID, 1, NOW), NOW);
    expect(tooShort.ok).toBe(true);
    if (tooShort.ok) {
      expect(tooShort.payload.expiresAtSeconds).toBe(
        Math.floor(NOW / 1000) + MINIAPP_SESSION_MIN_TTL_SECONDS,
      );
    }
    const tooLong = verifyMiniAppSession(issueMiniAppSession(USER_ID, 86_400, NOW), NOW);
    expect(tooLong.ok).toBe(true);
    if (tooLong.ok) {
      expect(tooLong.payload.expiresAtSeconds).toBe(
        Math.floor(NOW / 1000) + MINIAPP_SESSION_MAX_TTL_SECONDS,
      );
    }
  });

  it("M25 reads its own cookie out of a shared header and ignores others", () => {
    const header = `other=1; ${MINIAPP_SESSION_COOKIE_NAME}=abc.def; another=2`;
    expect(readMiniAppSessionCookie(header)).toBe("abc.def");
    expect(readMiniAppSessionCookie("unrelated=1")).toBeNull();
    expect(readMiniAppSessionCookie(undefined)).toBeNull();
    // The token itself must never appear in a non-HttpOnly form; the cookie
    // string is the only place it exists.
    expect(readMiniAppSessionCookie(`${MINIAPP_SESSION_COOKIE_NAME}=`)).toBe("");
  });

  it("M26 rejects structurally malformed tokens", () => {
    for (const bad of ["", "a", "a.b.c", "v1.x.y.z.extra", "v1.abc.notanumber.sig"]) {
      expect(verifyMiniAppSession(bad, NOW).ok).toBe(false);
    }
  });
});
