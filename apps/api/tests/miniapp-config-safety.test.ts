import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// D4 — a malformed numeric setting must not take authentication down.
//
// `MINIAPP_AUTH_RATE_LIMIT` is read from inside the limiter, on every single
// `POST /auth`. Reading it with a parser that throws on non-numeric input
// (`intEnv`) therefore does not fail loudly at boot where an operator would
// notice — it turns one typo in the environment into an unhandled exception on
// the request path, so EVERY sign-in returns 500 and nobody can use the Mini
// App at all. The safe behaviour is the opposite: fall back to the documented
// default, stay up, and say so once at startup.
//
// "Malformed" is strict on purpose. `Number.parseInt("5abc")` is 5, so a
// half-read value would silently install a ceiling the operator never wrote.
// =============================================================================

process.env.APP_SECRET ??= "miniapp-config-safety-secret-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "717171:AA-miniapp-config-safety-token";

const {
  logMiniAppConfig,
  miniAppAuthRateLimit,
  miniAppInitDataMaxAgeSeconds,
  miniAppSessionTtlSeconds,
  resolveMiniAppAuthRateLimit,
  MINIAPP_AUTH_RATE_LIMIT_DEFAULT,
  MINIAPP_AUTH_RATE_LIMIT_MAX,
  MINIAPP_AUTH_RATE_LIMIT_MIN,
} = await import("../src/miniapp/config.js");
const { FixedWindowRateLimiter } = await import("../src/miniapp/security.js");
const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const original = process.env.MINIAPP_AUTH_RATE_LIMIT;

function setLimit(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.MINIAPP_AUTH_RATE_LIMIT;
  } else {
    process.env.MINIAPP_AUTH_RATE_LIMIT = value;
  }
}

afterEach(() => {
  setLimit(original);
  vi.restoreAllMocks();
});

/** One `POST /auth` against the real route, with a payload that never validates. */
async function auth(): Promise<number> {
  const app: FastifyInstance = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/auth",
      payload: { initData: "deliberately-invalid" },
    });
    return response.statusCode;
  } finally {
    await app.close();
  }
}

describe("mini app configuration safety", () => {
  // D4-1 -----------------------------------------------------------------
  it("D4-1: a non-numeric ceiling never throws — it resolves to the default", () => {
    for (const junk of ["abc", "", "   ", "five", "-1", "1.5", "0x10", "١٢٣", "Infinity", "NaN"]) {
      setLimit(junk);
      expect(() => miniAppAuthRateLimit(), junk).not.toThrow();
      expect(miniAppAuthRateLimit(), junk).toBe(MINIAPP_AUTH_RATE_LIMIT_DEFAULT);
    }
  });

  // D4-2 -----------------------------------------------------------------
  it("D4-2: a PARTIAL numeric value is rejected outright, not half-read", () => {
    // `Number.parseInt` would read each of these as a number, quietly applying
    // a ceiling nobody configured.
    for (const partial of ["5abc", "1e9", "10s", "3 per minute", "7,5", "12px", "+8", " 9 x"]) {
      setLimit(partial);
      const resolved = resolveMiniAppAuthRateLimit();
      expect(resolved.resolution, partial).toBe("invalid");
      expect(resolved.value, partial).toBe(MINIAPP_AUTH_RATE_LIMIT_DEFAULT);
    }
  });

  // D4-3 -----------------------------------------------------------------
  it("D4-3: bounds still hold — a usable value is clamped, not obeyed blindly", () => {
    setLimit("0");
    // Zero is not "strict", it is a permanent outage; the floor is 1.
    expect(resolveMiniAppAuthRateLimit()).toEqual({
      value: MINIAPP_AUTH_RATE_LIMIT_MIN,
      resolution: "clamped",
    });

    setLimit("999999999");
    expect(resolveMiniAppAuthRateLimit()).toEqual({
      value: MINIAPP_AUTH_RATE_LIMIT_MAX,
      resolution: "clamped",
    });

    setLimit("42");
    expect(resolveMiniAppAuthRateLimit()).toEqual({ value: 42, resolution: "configured" });

    setLimit(undefined);
    expect(resolveMiniAppAuthRateLimit()).toEqual({
      value: MINIAPP_AUTH_RATE_LIMIT_DEFAULT,
      resolution: "default",
    });
  });

  // D4-4 -----------------------------------------------------------------
  it("D4-4: with a malformed ceiling, /auth still answers 401 rather than 500", async () => {
    setLimit("5abc");
    // 401 = the request reached signature validation, i.e. the limiter ran and
    // allowed it. A 500 here is the exact defect: the whole endpoint down over
    // a typo.
    expect(await auth()).toBe(401);

    setLimit("not-a-number-at-all");
    expect(await auth()).toBe(401);
  });

  // D4-5 -----------------------------------------------------------------
  it("D4-5: the fallback ceiling is still ENFORCED, not merely survived", async () => {
    setLimit("garbage");
    // Exactly the limiter the route constructs — the real class, driven by the
    // real config function — so this measures the ceiling actually in force
    // rather than a reimplementation of it. (The route's own limiter is
    // module-scoped and shared by every test in this file, so its window
    // cannot be observed from a known-empty state here.)
    const limiter = new FixedWindowRateLimiter(miniAppAuthRateLimit, 60_000);
    const allowed: boolean[] = [];
    for (let i = 0; i < MINIAPP_AUTH_RATE_LIMIT_DEFAULT + 2; i += 1) {
      allowed.push(limiter.check("d4-5").allowed);
    }
    expect(allowed.slice(0, MINIAPP_AUTH_RATE_LIMIT_DEFAULT)).toEqual(
      Array.from({ length: MINIAPP_AUTH_RATE_LIMIT_DEFAULT }, () => true),
    );
    expect(allowed.slice(MINIAPP_AUTH_RATE_LIMIT_DEFAULT)).toEqual([false, false]);
    // Refusal carries a Retry-After the client can act on.
    expect(limiter.check("d4-5").retryAfterSeconds).toBeGreaterThan(0);

    // And the route really is wired to a ceiling: hammering it ends in 429,
    // not in an unbounded stream of 401s.
    let sawRefusal = false;
    for (let i = 0; i < 40 && !sawRefusal; i += 1) {
      sawRefusal = (await auth()) === 429;
    }
    expect(sawRefusal).toBe(true);
  });

  // D4-6 -----------------------------------------------------------------
  it("D4-6: the effective value is reported once at startup, loudly when unusable", () => {
    const errors: string[] = [];
    const warns: string[] = [];
    const infos: string[] = [];
    const capture = (text: string): true => {
      if (text.includes('"level":"error"')) {
        errors.push(text);
      } else if (text.includes('"level":"warn"')) {
        warns.push(text);
      } else {
        infos.push(text);
      }
      return true;
    };
    // The JSON-lines logger writes straight to the streams; warn/error go to
    // stderr and everything else to stdout.
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) =>
      capture(String(chunk)),
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) =>
      capture(String(chunk)),
    );

    setLimit("5abc");
    logMiniAppConfig();
    // An unusable value is an ERROR: the file says one thing, the service is
    // doing another, and only the log can tell the operator that.
    expect(errors.some((l) => l.includes("MINIAPP_AUTH_RATE_LIMIT"))).toBe(true);
    expect(errors.some((l) => l.includes(String(MINIAPP_AUTH_RATE_LIMIT_DEFAULT)))).toBe(true);
    // The operator's raw text is never echoed back into the log.
    expect([...errors, ...warns, ...infos].some((l) => l.includes("5abc"))).toBe(false);

    errors.length = 0;
    warns.length = 0;
    infos.length = 0;
    setLimit("999999999");
    logMiniAppConfig();
    expect(warns.some((l) => l.includes("MINIAPP_AUTH_RATE_LIMIT"))).toBe(true);
    expect(warns.some((l) => l.includes(String(MINIAPP_AUTH_RATE_LIMIT_MAX)))).toBe(true);

    errors.length = 0;
    warns.length = 0;
    infos.length = 0;
    setLimit("7");
    logMiniAppConfig();
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(0);
    // One line per setting, every time: rate limit, initData window, session TTL.
    expect(infos).toHaveLength(3);
    expect(infos.some((l) => l.includes("MINIAPP_AUTH_RATE_LIMIT"))).toBe(true);
  });

  // D4-7 -----------------------------------------------------------------
  it("D4-7: no Mini App numeric setting can throw, whatever the environment says", () => {
    const readers = [
      { name: "MINIAPP_AUTH_RATE_LIMIT", read: miniAppAuthRateLimit },
      { name: "MINIAPP_INITDATA_MAX_AGE_SECONDS", read: miniAppInitDataMaxAgeSeconds },
      { name: "MINIAPP_SESSION_TTL_SECONDS", read: miniAppSessionTtlSeconds },
    ];
    const hostile = ["", " ", "abc", "5abc", "-3", "1e400", "0", "999999999999999999999", "٣"];
    const previous = readers.map((r) => process.env[r.name]);
    try {
      for (const reader of readers) {
        for (const value of hostile) {
          process.env[reader.name] = value;
          expect(() => reader.read(), `${reader.name}=${value}`).not.toThrow();
          const result = reader.read();
          expect(Number.isSafeInteger(result), `${reader.name}=${value}`).toBe(true);
          expect(result, `${reader.name}=${value}`).toBeGreaterThan(0);
        }
      }
    } finally {
      readers.forEach((reader, index) => {
        const prior = previous[index];
        if (prior === undefined) {
          delete process.env[reader.name];
        } else {
          process.env[reader.name] = prior;
        }
      });
    }
  });
});
