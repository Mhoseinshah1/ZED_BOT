import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { prisma } from "@zedbot/database";
import { MINIAPP_SESSION_COOKIE_NAME } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// D2 — every secure-transport decision goes through the TRUSTED proxy chain.
//
// Behind Nginx the socket is plaintext, so "did the browser use TLS?" can only
// be answered from a forwarding header — which makes it a question about whom
// to believe. Reading `X-Forwarded-Proto` off the request answers it wrong in
// two independent ways:
//
//   * the header is present on any request, including one that never passed a
//     trusted hop, so a caller can simply assert `https`;
//   * taking the FIRST comma-separated entry takes the CLIENT-supplied end of
//     the chain, so `https, http` lets the client's claim beat the value the
//     nearest proxy appended.
//
// `request.protocol` consults the header only when the socket peer is itself
// trusted, and takes the LAST entry. These tests drive the four places the
// answer is used — the production plaintext refusal, the `Secure` flag on the
// minted cookie, the logout clear, and the stale-cookie clear — through both
// the honest and the spoofed shape of the request.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-transport-test-secret-0123456789";
const BOT_TOKEN = "515151:AA-miniapp-transport-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
// inject() reports one client address per file; the ceiling would otherwise
// throttle the suite itself.
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");
const { isSecureRequest } = await import("../src/miniapp/transport.js");

/** Nginx on the host proxying into the published container port. */
const TRUSTED_HOP = "127.0.0.1";
/** A caller that reached the API without passing through any trusted hop. */
const UNTRUSTED_PEER = "198.51.100.7";

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const USER_TELEGRAM_ID = 9_400_000_000_000n + runTag;

let app: FastifyInstance;
const originalNodeEnv = process.env.NODE_ENV;

function buildApp(): FastifyInstance {
  // EXACTLY as src/index.ts builds it — same trustProxy value.
  const instance = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  void instance.register(miniAppRoutes, { prefix: "/api/miniapp" });
  return instance;
}

/** Telegram's published algorithm, written out independently of the validator. */
function initDataFor(telegramId: bigint): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000) - 5),
    query_id: "AAtransport",
    user: JSON.stringify({ id: Number(telegramId), first_name: "Trans", language_code: "fa" }),
  };
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

interface Hop {
  /** Socket peer as Fastify sees it. */
  peer: string;
  /** Raw X-Forwarded-Proto, exactly as a caller or a proxy would send it. */
  proto?: string;
}

function headersFor(hop: Hop): Record<string, string> {
  return hop.proto === undefined ? {} : { "x-forwarded-proto": hop.proto };
}

function post(url: string, hop: Hop, payload: unknown = {}) {
  return app.inject({
    method: "POST",
    url,
    remoteAddress: hop.peer,
    headers: headersFor(hop),
    payload,
  });
}

/** The Set-Cookie the response carries (there is at most one here). */
function setCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw.join("; ");
  }
  return typeof raw === "string" ? raw : "";
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

afterAll(async () => {
  await app.close();
  if (hasDb) {
    await prisma.user.deleteMany({ where: { telegramId: USER_TELEGRAM_ID } });
    await prisma.$disconnect();
  }
});

describe("mini app secure transport", () => {
  // D2-1 -----------------------------------------------------------------
  it("D2-1: an untrusted caller asserting X-Forwarded-Proto: https is still plaintext in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await post(
      "/api/miniapp/auth",
      { peer: UNTRUSTED_PEER, proto: "https" },
      { initData: "irrelevant" },
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ ok: false, code: "INSECURE_TRANSPORT" });
  });

  // D2-2 -----------------------------------------------------------------
  it("D2-2: the same header through a trusted hop IS accepted as TLS", async () => {
    process.env.NODE_ENV = "production";
    const res = await post(
      "/api/miniapp/auth",
      { peer: TRUSTED_HOP, proto: "https" },
      { initData: "deliberately-invalid" },
    );
    // Past the transport gate: it now fails on the payload, not the scheme.
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ ok: false, code: "INVALID_INIT_DATA" });
  });

  // D2-3 -----------------------------------------------------------------
  it("D2-3: a client-supplied 'https' prefix cannot outrank what the trusted hop appended", async () => {
    process.env.NODE_ENV = "production";
    // Nginx appends; the LEFT entry is whatever the caller sent. Reading the
    // first entry — the previous behaviour — would have called this TLS.
    const res = await post(
      "/api/miniapp/auth",
      { peer: TRUSTED_HOP, proto: "https, http" },
      { initData: "irrelevant" },
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ ok: false, code: "INSECURE_TRANSPORT" });

    // And a plain socket with no header at all is plaintext, as it must be.
    const bare = await post("/api/miniapp/auth", { peer: TRUSTED_HOP }, { initData: "x" });
    expect(bare.statusCode).toBe(403);
  });

  // D2-4 -----------------------------------------------------------------
  it.runIf(hasDb)("D2-4: the minted session cookie's Secure flag follows the same trusted decision", async () => {
    await prisma.user.deleteMany({ where: { telegramId: USER_TELEGRAM_ID } });
    await prisma.user.create({
      data: { telegramId: USER_TELEGRAM_ID, firstName: "Trans", languageCode: "fa" },
    });

    const overTls = await post(
      "/api/miniapp/auth",
      { peer: TRUSTED_HOP, proto: "https" },
      { initData: initDataFor(USER_TELEGRAM_ID) },
    );
    expect(overTls.statusCode).toBe(200);
    expect(setCookie(overTls.headers as Record<string, unknown>)).toContain("Secure");

    // Same sign-in over plaintext (development): NO Secure, or the browser
    // would drop the cookie and the user would loop on the login screen.
    const overPlaintext = await post(
      "/api/miniapp/auth",
      { peer: TRUSTED_HOP, proto: "http" },
      { initData: initDataFor(USER_TELEGRAM_ID) },
    );
    expect(overPlaintext.statusCode).toBe(200);
    expect(setCookie(overPlaintext.headers as Record<string, unknown>)).not.toContain("Secure");

    // A spoofed https from an untrusted peer must NOT earn a Secure cookie.
    const spoofed = await post(
      "/api/miniapp/auth",
      { peer: UNTRUSTED_PEER, proto: "https" },
      { initData: initDataFor(USER_TELEGRAM_ID) },
    );
    expect(spoofed.statusCode).toBe(200);
    expect(setCookie(spoofed.headers as Record<string, unknown>)).not.toContain("Secure");
  });

  // D2-5 -----------------------------------------------------------------
  it("D2-5: the logout clear-cookie uses the trusted decision, not the raw header", async () => {
    const trusted = await post("/api/miniapp/logout", { peer: TRUSTED_HOP, proto: "https" });
    expect(trusted.statusCode).toBe(200);
    expect(setCookie(trusted.headers as Record<string, unknown>)).toContain("Secure");

    const spoofed = await post("/api/miniapp/logout", { peer: UNTRUSTED_PEER, proto: "https" });
    expect(spoofed.statusCode).toBe(200);
    const cleared = setCookie(spoofed.headers as Record<string, unknown>);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toContain("Secure");
  });

  // D2-6 -----------------------------------------------------------------
  it("D2-6: clearing an invalid session cookie uses the trusted decision too", async () => {
    const request = (hop: Hop) =>
      app.inject({
        method: "GET",
        url: "/api/miniapp/me",
        remoteAddress: hop.peer,
        headers: { ...headersFor(hop), cookie: `${MINIAPP_SESSION_COOKIE_NAME}=not-a-valid-token` },
      });

    const trusted = await request({ peer: TRUSTED_HOP, proto: "https" });
    expect(trusted.statusCode).toBe(401);
    expect(setCookie(trusted.headers as Record<string, unknown>)).toContain("Secure");

    const spoofed = await request({ peer: UNTRUSTED_PEER, proto: "https" });
    expect(spoofed.statusCode).toBe(401);
    expect(setCookie(spoofed.headers as Record<string, unknown>)).not.toContain("Secure");
  });

  // D2-7 -----------------------------------------------------------------
  it("D2-7: there is exactly one transport decision and it never reads the raw header", async () => {
    // The helper itself is scheme-case-insensitive (RFC 3986 §3.1) and treats
    // anything else as plaintext.
    expect(isSecureRequest({ protocol: "https" })).toBe(true);
    expect(isSecureRequest({ protocol: "HTTPS" })).toBe(true);
    expect(isSecureRequest({ protocol: "http" })).toBe(false);
    expect(isSecureRequest({ protocol: undefined } as unknown as { protocol: string })).toBe(false);

    const routes = await readFile(
      fileURLToPath(new URL("../src/miniapp/routes.ts", import.meta.url)),
      "utf8",
    );
    // No route makes its own decision from a forwarding header.
    expect(routes).not.toMatch(/headers\[["']x-forwarded-proto["']\]/);
    // All four decision points call the one helper.
    expect(routes.match(/isSecureRequest\(request\)/g) ?? []).toHaveLength(4);
  });
});
