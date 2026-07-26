import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Mini App HTTP surface (M27-M51), driven with fastify.inject() against the
// REAL plugin and a REAL PostgreSQL.
//
// The two properties worth this much setup:
//
//   1. DATA ISOLATION. Two users are created with services and ledger rows, and
//      every endpoint is asked for the other user's data. A unit test with a
//      mocked Prisma would happily pass while the real query forgot its userId.
//   2. NO SECRETS. The service fixture is deliberately loaded with a
//      subscription URL, a token, config links and a remote client id - the
//      things whose disclosure IS the compromise - and the response body is
//      asserted not to contain any of them. Asserting on the fields we DO
//      return would not catch a field we accidentally added.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-api-test-secret-0123456789abcdef";
const BOT_TOKEN = "424242:AA-miniapp-api-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_PUBLIC_URL = "https://miniapp.test.example/miniapp";
// fastify.inject() reports one client address for the whole file, so the
// production five-per-minute ceiling would throttle the suite itself. Raised
// here and exercised deliberately in M52, which lowers it back and proves the
// 429 path against the real route.
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";

// Imported after the environment is set: the session module derives its key
// from APP_SECRET at first use, and the routes read the bot token per request.
const { miniAppRoutes } = await import("../src/miniapp/routes.js");

// Unique per run so reruns against the same database never collide, and far
// enough from other suites' ranges that cleanup cannot sweep their rows.
const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const OWNER_TELEGRAM_ID = 9_100_000_000_000n + runTag;
const OTHER_TELEGRAM_ID = OWNER_TELEGRAM_ID + 1n;
const STRANGER_TELEGRAM_ID = OWNER_TELEGRAM_ID + 2n;

const SUBSCRIPTION_URL = "https://panel.internal.example/sub/zzz-secret-token-zzz";
const SUBSCRIPTION_TOKEN = "sub-token-must-never-be-returned";
const CONFIG_LINK = "vless://deadbeef@1.2.3.4:443?security=tls#never-return-me";
const REMOTE_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const FAILURE_REASON = "internal operator note: panel refused";

let app: FastifyInstance;
let ownerId = "";
let otherId = "";
let ownerServiceIds: string[] = [];
let otherServiceId = "";
let panelId = "";
// Signed in once. Every read below reuses these, which keeps the suite honest
// about the rate limiter instead of quietly depending on it being off.
let ownerCookie = "";
let otherCookie = "";

/** Telegram's published algorithm, written out independently of the validator. */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function initDataFor(telegramId: bigint, ageSeconds = 5): string {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    query_id: "AAHminiapp",
    user: `{"id":${telegramId.toString()},"first_name":"Test","username":"tester"}`,
  });
}

/** Signs in and returns the session cookie value, or throws with the code. */
async function signIn(telegramId: bigint): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    headers: { origin: "https://miniapp.test.example", "content-type": "application/json" },
    payload: { initData: initDataFor(telegramId) },
  });
  if (response.statusCode !== 200) {
    throw new Error(`auth failed ${response.statusCode}: ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return raw.split(";")[0];
}

function authed(cookie: string) {
  return { cookie };
}

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  app = Fastify({ logger: false });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  const owner = await prisma.user.create({
    data: {
      telegramId: OWNER_TELEGRAM_ID,
      firstName: "Owner",
      username: "owner_test",
      balanceToman: 250_000,
    },
  });
  ownerId = owner.id;
  const other = await prisma.user.create({
    data: { telegramId: OTHER_TELEGRAM_ID, firstName: "Other", balanceToman: 5_000 },
  });
  otherId = other.id;

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: "Panel Alpha",
      baseUrl: "https://panel.internal.example",
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
    },
  });
  panelId = panel.id;

  // Three owner services with distinct createdAt so keyset paging is
  // deterministic rather than dependent on insertion order.
  const base = Date.now() - 10 * 60 * 1000;
  for (let i = 0; i < 3; i += 1) {
    const service = await prisma.service.create({
      data: {
        userId: ownerId,
        panelId,
        panelType: "MARZBAN",
        username: `mini-owner-${runTag}-${i}`,
        status: "ACTIVE",
        productNameSnapshot: `Plan ${i}`,
        panelNameSnapshot: "Panel Alpha",
        volumeBytes: 50n * 1024n * 1024n * 1024n,
        usedBytes: BigInt(i) * 1024n * 1024n * 1024n,
        remainingBytes: 40n * 1024n * 1024n * 1024n,
        durationDays: 30,
        createdAt: new Date(base + i * 60_000),
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        // Secrets and operator text, all of which must stay server-side.
        subscriptionUrl: SUBSCRIPTION_URL,
        subscriptionToken: SUBSCRIPTION_TOKEN,
        configLinks: [CONFIG_LINK],
        remoteClientId: REMOTE_CLIENT_ID,
        failureReason: FAILURE_REASON,
        note: "zedbot order:internal-marker",
        userNote: "یادداشت خریدار",
      },
    });
    ownerServiceIds.push(service.id);
  }
  // Newest first is the API's order, so reverse to match what pages return.
  ownerServiceIds = [...ownerServiceIds].reverse();

  const foreign = await prisma.service.create({
    data: {
      userId: otherId,
      panelId,
      panelType: "MARZBAN",
      username: `mini-other-${runTag}`,
      status: "ACTIVE",
      volumeBytes: 1n,
      usedBytes: 0n,
      remainingBytes: 1n,
      durationDays: 1,
      subscriptionUrl: SUBSCRIPTION_URL,
    },
  });
  otherServiceId = foreign.id;

  for (let i = 0; i < 3; i += 1) {
    await prisma.walletTransaction.create({
      data: {
        userId: ownerId,
        amountToman: (i + 1) * 1000,
        type: "CHARGE",
        source: "ADMIN",
        reason: "internal admin reason that must not be returned",
        balanceBeforeToman: 0,
        balanceAfterToman: (i + 1) * 1000,
        createdAt: new Date(base + i * 60_000),
      },
    });
  }
  await prisma.walletTransaction.create({
    data: {
      userId: otherId,
      amountToman: 777,
      type: "CHARGE",
      source: "ADMIN",
      balanceBeforeToman: 0,
      balanceAfterToman: 777,
    },
  });

  ownerCookie = await signIn(OWNER_TELEGRAM_ID);
  otherCookie = await signIn(OTHER_TELEGRAM_ID);
});

afterAll(async () => {
  if (!hasDb) {
    return;
  }
  await app?.close();
  const ids = [ownerId, otherId].filter((id) => id !== "");
  if (ids.length > 0) {
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.service.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (panelId !== "") {
    await prisma.panel.deleteMany({ where: { id: panelId } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("mini app API", () => {
  // --- authentication --------------------------------------------------------

  it("M27 signs in with a valid initData and sets a scoped HttpOnly cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      headers: { origin: "https://miniapp.test.example" },
      payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
    });
    expect(response.statusCode).toBe(200);
    const raw = String(response.headers["set-cookie"]);
    expect(raw).toContain("zb_miniapp=");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Path=/api/miniapp");
    // The response body carries the user, but never a token: the cookie is the
    // only credential and JavaScript must not be able to read it.
    expect(response.body).not.toContain("zb_miniapp");
  });

  it("M28 refuses a forged initData", async () => {
    const forged = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: `{"id":${OWNER_TELEGRAM_ID.toString()},"first_name":"Attacker"}`,
      },
      "999999:AA-not-our-token",
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      headers: { origin: "https://miniapp.test.example" },
      payload: { initData: forged },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, code: "INVALID_INIT_DATA" });
  });

  it("M29 never auto-creates a user the bot has never seen", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      headers: { origin: "https://miniapp.test.example" },
      payload: { initData: initDataFor(STRANGER_TELEGRAM_ID) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("NOT_REGISTERED");
    const created = await prisma.user.findUnique({ where: { telegramId: STRANGER_TELEGRAM_ID } });
    expect(created).toBeNull();
  });

  it("M30 rejects a session-changing POST from a foreign origin", async () => {
    for (const url of ["/api/miniapp/auth", "/api/miniapp/logout"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { origin: "https://evil.example" },
        payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().code).toBe("FORBIDDEN_ORIGIN");
    }
  });

  it("M31 rejects a cross-site fetch even when the Origin header is absent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/logout",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("M32 logout clears the cookie and works for an already-dead session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/logout",
      headers: { origin: "https://miniapp.test.example" },
    });
    expect(response.statusCode).toBe(200);
    const raw = String(response.headers["set-cookie"]);
    expect(raw).toContain("zb_miniapp=;");
    expect(raw).toContain("Max-Age=0");
    expect(raw).toContain("Path=/api/miniapp");
  });

  it("M52 authentication is rate limited and answers with Retry-After", async () => {
    // Lowered to 1 for this test so the ceiling is reached in two requests
    // rather than by hammering the route. The limiter resolves the ceiling per
    // check, so this exercises the real production path rather than a stub.
    const previous = process.env.MINIAPP_AUTH_RATE_LIMIT;
    process.env.MINIAPP_AUTH_RATE_LIMIT = "1";
    try {
      const attempt = async () =>
        app.inject({
          method: "POST",
          url: "/api/miniapp/auth",
          headers: { origin: "https://miniapp.test.example" },
          payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
        });
      // The window opened during beforeAll's sign-ins, so this is already over
      // a ceiling of 1.
      const throttled = await attempt();
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json()).toEqual({ ok: false, code: "RATE_LIMITED" });
      // A bounded, honest wait rather than a bare refusal.
      const retryAfter = Number(throttled.headers["retry-after"]);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      // Throttling happens BEFORE any HMAC or database work, so a flood cannot
      // be turned into an amplifier.
      expect(throttled.body).not.toContain("INVALID_INIT_DATA");
    } finally {
      process.env.MINIAPP_AUTH_RATE_LIMIT = previous;
    }
  });

  it("M53 refuses to mint a production session over plain HTTP", async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // No x-forwarded-proto, and fastify.inject() reports http: exactly the
      // shape a downgrade or a misconfigured proxy produces. A cookie minted
      // here could not carry `Secure`, so it would ride every later plaintext
      // request - refusing is the only fail-closed answer.
      const plaintext = await app.inject({
        method: "POST",
        url: "/api/miniapp/auth",
        headers: { origin: "https://miniapp.test.example" },
        payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
      });
      expect(plaintext.statusCode).toBe(403);
      expect(plaintext.json()).toEqual({ ok: false, code: "INSECURE_TRANSPORT" });
      expect(plaintext.headers["set-cookie"]).toBeUndefined();

      // The same request behind a TLS-terminating proxy is accepted, and the
      // cookie it sets carries Secure.
      const secured = await app.inject({
        method: "POST",
        url: "/api/miniapp/auth",
        headers: { origin: "https://miniapp.test.example", "x-forwarded-proto": "https" },
        payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
      });
      expect(secured.statusCode).toBe(200);
      expect(String(secured.headers["set-cookie"])).toContain("Secure");
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  it("M54 issues a non-Secure cookie in development so local http still works", async () => {
    // Outside production the flag follows the actual scheme. Setting `Secure`
    // over http would make the browser drop the cookie silently and leave a
    // developer in a login loop with nothing to see.
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      headers: { origin: "https://miniapp.test.example" },
      payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).not.toContain("Secure");
  });

  it("M33 refuses every read without a session", async () => {
    for (const url of [
      "/api/miniapp/me",
      "/api/miniapp/dashboard",
      "/api/miniapp/services",
      `/api/miniapp/services/${ownerServiceIds[0]}`,
      "/api/miniapp/wallet/transactions",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().code).toBe("NOT_AUTHENTICATED");
    }
  });

  it("M34 refuses a tampered session cookie", async () => {
    const cookie = ownerCookie;
    const [name, value] = cookie.split("=");
    const parts = value.split(".");
    // Same signature, different signed body.
    const forged = `${name}=${parts[0]}.${parts[1]}.${Number(parts[2]) + 3600}.${parts[3]}`;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/me",
      headers: { cookie: forged },
    });
    expect(response.statusCode).toBe(401);
  });

  // --- data isolation --------------------------------------------------------

  it("M35 a service list contains only the caller's own services", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/services",
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().items.map((item: { id: string }) => item.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(otherServiceId);
  });

  it("M36 another user's service id is a 404, not a leak", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/services/${otherServiceId}`,
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("M37 a cursor minted by one user cannot read another user's rows", async () => {
        const firstPage = await app.inject({
      method: "GET",
      url: "/api/miniapp/services?limit=1",
      headers: authed(ownerCookie),
    });
    const cursor = firstPage.json().nextCursor as string;
    expect(cursor).toBeTruthy();

        const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/services?cursor=${encodeURIComponent(cursor)}`,
      headers: authed(otherCookie),
    });
    expect(response.statusCode).toBe(200);
    // The cursor is a POSITION, not an authority: it moves the window, and the
    // window is still bounded by the session's own user id.
    for (const item of response.json().items as Array<{ id: string }>) {
      expect(ownerServiceIds).not.toContain(item.id);
    }
  });

  it("M38 wallet history is scoped to the caller", async () => {
    const cookie = otherCookie;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/wallet/transactions",
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.balanceToman).toBe(5_000);
  });

  // --- no secrets ------------------------------------------------------------

  it("M39 the service detail never carries subscription secrets or operator text", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/services/${ownerServiceIds[0]}`,
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(200);
    const raw = response.body;
    for (const secret of [
      SUBSCRIPTION_URL,
      SUBSCRIPTION_TOKEN,
      CONFIG_LINK,
      REMOTE_CLIENT_ID,
      FAILURE_REASON,
      "zedbot order:internal-marker",
      "panel.internal.example",
      "encrypted-blob",
      panelId,
    ]) {
      expect(raw, `leaked: ${secret}`).not.toContain(secret);
    }
    // The buyer's OWN note is theirs and does come back.
    expect(response.json().service.userNote).toBe("یادداشت خریدار");
  });

  it("M40 no response carries a Telegram id or an admin reason", async () => {
    const cookie = ownerCookie;
    for (const url of ["/api/miniapp/me", "/api/miniapp/dashboard", "/api/miniapp/wallet/transactions"]) {
      const response = await app.inject({ method: "GET", url, headers: authed(cookie) });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(OWNER_TELEGRAM_ID.toString());
      expect(response.body, url).not.toContain("internal admin reason");
    }
  });

  // --- pagination ------------------------------------------------------------

  it("M41 keyset pagination walks every row exactly once", async () => {
    const cookie = ownerCookie;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url: string =
        cursor === null
          ? "/api/miniapp/services?limit=1"
          : `/api/miniapp/services?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({ method: "GET", url, headers: authed(cookie) });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(seen).toEqual(ownerServiceIds);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("M42 the page size is clamped and never client-dictated", async () => {
    const cookie = ownerCookie;
    for (const limit of ["1000", "-5", "abc", "0"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/miniapp/wallet/transactions?limit=${limit}`,
        headers: authed(cookie),
      });
      expect(response.statusCode, limit).toBe(200);
      expect(response.json().items.length).toBeLessThanOrEqual(50);
    }
  });

  it("M43 a forged or foreign cursor is refused rather than silently ignored", async () => {
    const cookie = ownerCookie;
    for (const cursor of ["c1.1.abc.deadbeef", "not-a-cursor", "c1.0.x.y"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/miniapp/services?cursor=${encodeURIComponent(cursor)}`,
        headers: authed(cookie),
      });
      expect(response.statusCode, cursor).toBe(400);
      expect(response.json().code).toBe("BAD_REQUEST");
    }
  });

  it("M44 the last page reports no next cursor", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/services?limit=50",
      headers: authed(cookie),
    });
    expect(response.json().nextCursor).toBeNull();
  });

  // --- caching and shape -----------------------------------------------------

  it("M45 every response is uncacheable and non-sniffable", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/dashboard",
      headers: authed(cookie),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    // No CORS header at all: its ABSENCE is the policy, and a permissive one
    // could not be added by accident without failing here.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("M46 byte counters are decimal strings, so a large plan cannot round", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/services/${ownerServiceIds[0]}`,
      headers: authed(cookie),
    });
    const service = response.json().service;
    expect(typeof service.volumeBytes).toBe("string");
    expect(service.volumeBytes).toBe((50n * 1024n * 1024n * 1024n).toString());
  });

  it("M47 the dashboard counts from the database, not from a loaded list", async () => {
    const cookie = ownerCookie;
    const body = (
      await app.inject({ method: "GET", url: "/api/miniapp/dashboard", headers: authed(cookie) })
    ).json();
    expect(body.services.total).toBe(3);
    expect(body.services.byStatus.ACTIVE).toBe(3);
    expect(body.services.expiringWithin7Days).toBe(3);
    // The recent slice is bounded regardless of how many services exist.
    expect(body.services.recent.length).toBeLessThanOrEqual(3);
    expect(body.wallet.balanceToman).toBe(250_000);
  });

  it("M48 a malformed service id is a 404, not a validation oracle", async () => {
    const cookie = ownerCookie;
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/services/not-a-uuid",
      headers: authed(cookie),
    });
    expect(response.statusCode).toBe(404);
  });

  // --- access gates ----------------------------------------------------------

  it("M49 a blocked user loses access on the very next request", async () => {
    const cookie = otherCookie;
    expect(
      (await app.inject({ method: "GET", url: "/api/miniapp/me", headers: authed(cookie) }))
        .statusCode,
    ).toBe(200);

    await prisma.user.update({ where: { id: otherId }, data: { status: "BLOCKED" } });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/miniapp/me",
        headers: authed(cookie),
      });
      // The cookie is still cryptographically valid. Access is re-read from the
      // authoritative row on EVERY request, which is the whole point of not
      // caching status in the token.
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("USER_BLOCKED");
    } finally {
      await prisma.user.update({ where: { id: otherId }, data: { status: "ACTIVE" } });
    }
  });

  it("M50 maintenance mode closes the Mini App for everyone", async () => {
    const cookie = ownerCookie;
    await prisma.setting.upsert({
      where: { key: "maintenance_mode" },
      create: { key: "maintenance_mode", value: "true", type: "BOOLEAN" },
      update: { value: "true" },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/miniapp/dashboard",
        headers: authed(cookie),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("MAINTENANCE");
      // Sign-in is closed too, not just the reads behind it.
      const auth = await app.inject({
        method: "POST",
        url: "/api/miniapp/auth",
        headers: { origin: "https://miniapp.test.example" },
        payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
      });
      expect(auth.statusCode).toBe(503);
    } finally {
      await prisma.setting.upsert({
        where: { key: "maintenance_mode" },
        create: { key: "maintenance_mode", value: "false", type: "BOOLEAN" },
        update: { value: "false" },
      });
    }
  });

  it("M51 a force-join gate reports that the bot must clear it", async () => {
    const channel = await prisma.forceJoinChannel.create({
      data: {
        title: `miniapp-test-${runTag}`,
        chatId: -(1_000_000_000_000n + runTag),
        joinUrl: `https://t.me/miniapp_test_${runTag}`,
        normalizedLink: `https://t.me/miniapp_test_${runTag}`,
        isActive: true,
      },
    });
    await prisma.setting.upsert({
      where: { key: "force_join_enabled" },
      create: { key: "force_join_enabled", value: "true", type: "BOOLEAN" },
      update: { value: "true" },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/miniapp/auth",
        headers: { origin: "https://miniapp.test.example" },
        payload: { initData: initDataFor(OWNER_TELEGRAM_ID) },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.code).toBe("FORCE_JOIN_REQUIRED");
      // The API cannot verify membership - only the bot can call Telegram - so
      // it says so instead of guessing, and the client shows an "open the bot"
      // action rather than a dead end.
      expect(body.requiresBot).toBe(true);
    } finally {
      await prisma.setting.upsert({
        where: { key: "force_join_enabled" },
        create: { key: "force_join_enabled", value: "false", type: "BOOLEAN" },
        update: { value: "false" },
      });
      await prisma.forceJoinChannel.delete({ where: { id: channel.id } });
    }
  });
});
