import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Trusted-proxy resolution and per-client rate limiting (P01-P12).
//
// The defect: Fastify was constructed with no `trustProxy`, so `request.ip` was
// the socket peer — which behind Nginx is the SAME address for every user on
// Earth. The five-per-minute authentication limit was therefore a global limit:
// one person signing in five times locked out the entire user base.
//
// Fixing it by trusting forwarded headers unconditionally would be worse than
// the bug. So the properties under test are both halves:
//
//   TRUST      a real client behind the local proxy gets its own bucket
//              (P01, P02, P03), and the header chain Nginx actually produces
//              resolves to the right address (P04, P05).
//   DON'T      a caller that did not come through a trusted hop cannot invent
//              an address (P06, P07), and no configuration value can turn the
//              trust list into "believe everyone" (P08, P09).
//
// Rate limiting is driven through the REAL `/auth` route: the limiter runs
// before any signature work, so a deliberately invalid payload exercises the
// exact production path and stops at 401 (allowed) or 429 (limited) without
// touching the database. The suite needs no PostgreSQL.
// =============================================================================

process.env.APP_SECRET ??= "miniapp-proxy-test-secret-0123456789abcdef";
process.env.TELEGRAM_BOT_TOKEN = "626262:AA-miniapp-proxy-test-token";
// Small enough that a handful of requests crosses it, large enough that the
// non-rate-limit assertions below are not accidentally throttled.
process.env.MINIAPP_AUTH_RATE_LIMIT = "3";
const AUTH_LIMIT = 3;

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies, API_DEFAULT_TRUSTED_PROXIES } = await import(
  "../src/miniapp/trusted-proxy.js"
);
const { clientRateKey } = await import("../src/miniapp/security.js");

/** Addresses a hop can plausibly have in this repository's deployments. */
const LOOPBACK_HOP = "127.0.0.1";
/** Nginx on the host proxying into a published container port. */
const DOCKER_GATEWAY_HOP = "172.17.0.1";
/** A caller that reached the API without passing through any trusted hop. */
const UNTRUSTED_PEER = "198.51.100.7";

const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.11";

let app: FastifyInstance;

/** Builds the server EXACTLY as `src/index.ts` does — same trustProxy value. */
function buildApp(): FastifyInstance {
  const instance = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  void instance.register(miniAppRoutes, { prefix: "/api/miniapp" });
  // A probe that reports what Fastify resolved, so the address itself can be
  // asserted rather than inferred from a rate-limit side effect.
  instance.get("/whoami", async (request) => ({ ip: request.ip, key: clientRateKey(request) }));
  return instance;
}

/** One authentication attempt from a client behind the local proxy. */
function authAs(
  forwardedFor: string | undefined,
  remoteAddress = LOOPBACK_HOP,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    payload: { initData: "deliberately-invalid" },
  });
}

function whoami(
  forwardedFor: string | undefined,
  remoteAddress = LOOPBACK_HOP,
): Promise<{ ip: string; key: string }> {
  return app
    .inject({
      method: "GET",
      url: "/whoami",
      remoteAddress,
      headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    })
    .then((res) => JSON.parse(res.body) as { ip: string; key: string });
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("mini app trusted proxy", () => {
  it("P01 gives two clients behind the proxy independent rate-limit buckets", async () => {
    // Client A burns its whole allowance.
    for (let i = 0; i < AUTH_LIMIT; i += 1) {
      const res = await authAs(CLIENT_A);
      expect(res.statusCode, `A attempt ${i + 1}`).toBe(401); // allowed, payload invalid
    }
    expect((await authAs(CLIENT_A)).statusCode).toBe(429);

    // Client B is untouched — which is only true if the two are keyed apart.
    // Before `trustProxy`, both were `127.0.0.1` and B was already locked out.
    const b = await authAs(CLIENT_B);
    expect(b.statusCode).toBe(401);
  });

  it("P02 keeps refusing the exhausted client while the fresh one continues", async () => {
    // A is still over its limit from P01; B still has allowance left.
    expect((await authAs(CLIENT_A)).statusCode).toBe(429);
    expect((await authAs(CLIENT_B)).statusCode).toBe(401);
    expect((await authAs(CLIENT_A)).statusCode).toBe(429);
  });

  it("P03 sends Retry-After with the 429 rather than a bare refusal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      remoteAddress: LOOPBACK_HOP,
      headers: { "x-forwarded-for": CLIENT_A },
      payload: { initData: "deliberately-invalid" },
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("P04 trusts the loopback hop and reports the forwarded client", async () => {
    expect((await whoami(CLIENT_A)).ip).toBe(CLIENT_A);
  });

  it("P05 trusts a container-local hop too, which is the real production path", async () => {
    // Nginx runs on the host and proxies to a published container port, so
    // inside the container the peer is the Docker bridge gateway — never
    // 127.0.0.1. Trusting loopback alone would leave the bug in place in
    // production while passing every local test.
    expect((await whoami(CLIENT_A, DOCKER_GATEWAY_HOP)).ip).toBe(CLIENT_A);
  });

  it("P06 ignores a forged X-Forwarded-For from an untrusted direct caller", async () => {
    // Someone reaching the API directly claims to be CLIENT_B.
    const seen = await whoami(CLIENT_B, UNTRUSTED_PEER);
    expect(seen.ip).toBe(UNTRUSTED_PEER);
    expect(seen.ip).not.toBe(CLIENT_B);
    // ...and therefore cannot borrow, or poison, another client's bucket.
    const legitimate = await whoami(CLIENT_B);
    expect(seen.key).not.toBe(legitimate.key);
  });

  it("P07 stops at the address the trusted hop appended, not the forged prefix", async () => {
    // This is the exact chain `$proxy_add_x_forwarded_for` produces when the
    // client sent its own X-Forwarded-For: the forged value first, the address
    // Nginx actually saw appended last. Walking from the server end, the real
    // client is the first untrusted entry and the forgery is never reached.
    expect((await whoami(`${CLIENT_B}, ${CLIENT_A}`)).ip).toBe(CLIENT_A);
    // Several forged hops make no difference.
    expect((await whoami(`10.0.0.9, ${CLIENT_B}, 192.168.5.5, ${CLIENT_A}`)).ip).toBe(CLIENT_A);
  });

  it("P08 falls back to the safe list rather than honouring a trust-everything value", async () => {
    // Every one of these means "believe an arbitrary sender" — the precise
    // failure the trust list exists to prevent.
    for (const value of ["true", "yes", "all", "*", "1", "2"]) {
      expect(apiTrustedProxies(value), value).toBe(API_DEFAULT_TRUSTED_PROXIES);
    }
    // Unset takes the same documented default.
    expect(apiTrustedProxies("")).toBe(API_DEFAULT_TRUSTED_PROXIES);
    expect(apiTrustedProxies("   ")).toBe(API_DEFAULT_TRUSTED_PROXIES);
  });

  it("P09 supports an explicit opt-out and an explicit custom list", async () => {
    for (const value of ["none", "off", "false", "NONE"]) {
      expect(apiTrustedProxies(value), value).toBe(false);
    }
    expect(apiTrustedProxies("10.8.0.1")).toBe("10.8.0.1");
    expect(apiTrustedProxies("loopback")).toBe("loopback");
  });

  it("P10 trusts nothing when the operator opts out", async () => {
    const strict = Fastify({ logger: false, trustProxy: false });
    strict.get("/whoami", async (request) => ({ ip: request.ip }));
    await strict.ready();
    try {
      const res = await strict.inject({
        method: "GET",
        url: "/whoami",
        remoteAddress: LOOPBACK_HOP,
        headers: { "x-forwarded-for": CLIENT_A },
      });
      expect(JSON.parse(res.body)).toEqual({ ip: LOOPBACK_HOP });
    } finally {
      await strict.close();
    }
  });

  it("P11 keeps the address out of the rate-limit map", async () => {
    const seen = await whoami(CLIENT_A);
    // The key groups a client without the map ever holding something readable
    // back out of a heap dump.
    expect(seen.key).not.toContain(CLIENT_A);
    expect(seen.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Stable for the same client, different for another.
    expect((await whoami(CLIENT_A)).key).toBe(seen.key);
    expect((await whoami(CLIENT_B)).key).not.toBe(seen.key);
  });

  it("P12 matches the header chain the repository's Nginx template actually sets", async () => {
    const template = await readFile(
      new URL("../../../scripts/lib/common.sh", import.meta.url),
      "utf8",
    );
    // The append form is what makes P07 safe: a replace (`$remote_addr`) would
    // be safe too, but a bare pass-through of the client's header would not.
    expect(template).toContain("proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;");
    expect(template).toContain("proxy_set_header X-Real-IP \\$remote_addr;");
    // And Nginx reaches the API over the loopback interface, which is why the
    // trusted list covers it.
    expect(template).toContain("proxy_pass http://127.0.0.1:${port};");

    // Same headers, replayed: the client Nginx saw is what the API resolves.
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      remoteAddress: LOOPBACK_HOP,
      headers: { "x-forwarded-for": CLIENT_A, "x-real-ip": CLIENT_A },
    });
    expect(JSON.parse(res.body)).toMatchObject({ ip: CLIENT_A });
  });
});
