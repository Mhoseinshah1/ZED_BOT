import { createHash } from "node:crypto";

import { intEnv, optionalEnv } from "@zedbot/shared";
import type { FastifyRequest } from "fastify";

// =============================================================================
// Transport-level defences for the Mini App API.
//
// Three separate jobs live here, all of them things the route handlers must not
// have to remember:
//
//   1. Cross-origin policy. There is NO CORS. The Mini App is served from the
//      same origin as the API, so no cross-origin request has a legitimate
//      reason to reach these routes, and the correct configuration is the
//      absence of `Access-Control-Allow-Origin` rather than a carefully worded
//      one. A browser then refuses to hand the response to foreign script by
//      default — the strongest possible policy, and the one that cannot drift.
//
//   2. Origin enforcement on session-changing POSTs. `SameSite=Lax` already
//      stops a cross-site POST from carrying the cookie, so logout CSRF is dead
//      on arrival. What Lax does NOT stop is login CSRF: an attacker POSTing
//      their OWN valid initData to sign a victim into the attacker's account.
//      The Origin check kills that.
//
//   3. Rate limiting on authentication. `POST /auth` performs an HMAC and a
//      database lookup for anyone who asks; without a bound it is a free
//      amplifier.
// =============================================================================

/**
 * Parses the configured public origins.
 *
 * `MINIAPP_PUBLIC_URL` is the URL handed to Telegram for the WebApp button, so
 * it is the origin the Mini App actually runs on and needs no second variable
 * to state twice. `MINIAPP_ALLOWED_ORIGINS` exists only for deployments that
 * front the same API with more than one hostname.
 */
export function miniAppAllowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  const publicUrl = optionalEnv("MINIAPP_PUBLIC_URL", "").trim();
  if (publicUrl !== "") {
    try {
      origins.add(new URL(publicUrl).origin);
    } catch {
      // A malformed URL contributes nothing rather than throwing at boot; the
      // bot's own startup check is what reports it to the operator.
    }
  }
  for (const raw of optionalEnv("MINIAPP_ALLOWED_ORIGINS", "").split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignored for the same reason.
    }
  }
  return origins;
}

export type OriginVerdict = "allowed" | "forbidden";

/**
 * Decides whether a session-changing request may proceed.
 *
 * A browser ALWAYS sends `Origin` on a cross-origin POST — that is what the
 * header is for. So a request arriving with no `Origin` at all is, by
 * construction, not a cross-origin browser request, and rejecting it would only
 * break non-browser callers (health probes, a curl smoke test) while stopping
 * nothing. The rule is therefore: judge the evidence when it exists, and treat
 * `Sec-Fetch-Site` as a second witness when the engine provides one.
 *
 * With no origins configured (local development over http://localhost) the
 * check stands down — refusing every POST would make the app unrunnable
 * locally, and there is no production secret to protect on a dev box.
 */
export function checkRequestOrigin(
  request: FastifyRequest,
  allowed: ReadonlySet<string>,
): OriginVerdict {
  const fetchSite = headerValue(request, "sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    // `cross-site` / `same-site` on a POST to this API is never legitimate.
    return "forbidden";
  }
  const origin = headerValue(request, "origin");
  if (origin === null || origin === "null") {
    return "allowed";
  }
  if (allowed.size === 0) {
    return "allowed";
  }
  return allowed.has(origin) ? "allowed" : "forbidden";
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw === "string") {
    return raw;
  }
  // A repeated header is itself suspicious; take none of it rather than one.
  return null;
}

// --- rate limiting -----------------------------------------------------------

/** Production default. Five sign-ins a minute is far above honest use. */
export const MINIAPP_AUTH_RATE_LIMIT_DEFAULT = 5;

/**
 * The per-minute authentication ceiling.
 *
 * Clamped rather than trusted: a zero or negative value would lock everyone
 * out, and an unbounded one would make the setting a footgun disguised as a
 * tuning knob.
 */
export function miniAppAuthRateLimit(): number {
  const configured = intEnv("MINIAPP_AUTH_RATE_LIMIT", MINIAPP_AUTH_RATE_LIMIT_DEFAULT);
  return Math.min(Math.max(configured, 1), 10_000);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window rolls over; sent as `Retry-After`. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

/**
 * A fixed-window counter, in process memory.
 *
 * Deliberately not Redis. This bounds abuse of one API replica's CPU, and a
 * per-replica bound does exactly that; routing a rate-limit check through a
 * network round-trip would add a dependency whose failure mode is "the login
 * endpoint stops working". Nginx enforces the coarse global limit in front.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    /**
     * A number, or a function consulted per check.
     *
     * The callable form exists so the ceiling can come from configuration
     * without the limiter caching a value read once at import time - which
     * would make the setting unobservable in exactly the situation where an
     * operator most wants to change it.
     */
    private readonly limit: number | (() => number),
    private readonly windowMs: number,
    /** Bounds memory: an attacker rotating keys must not grow the map forever. */
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string, nowMs = Date.now()): RateLimitDecision {
    const ceiling = typeof this.limit === "function" ? this.limit() : this.limit;
    const existing = this.windows.get(key);
    if (existing === undefined || existing.resetAtMs <= nowMs) {
      if (this.windows.size >= this.maxKeys) {
        this.evictExpired(nowMs);
      }
      this.windows.set(key, { count: 1, resetAtMs: nowMs + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > ceiling) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictExpired(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAtMs <= nowMs) {
        this.windows.delete(key);
      }
    }
    if (this.windows.size >= this.maxKeys) {
      // Still full of live windows: drop the oldest insertions. Map preserves
      // insertion order, so this sheds the least recently started windows.
      let toDrop = Math.ceil(this.maxKeys / 10);
      for (const key of this.windows.keys()) {
        this.windows.delete(key);
        if (--toDrop <= 0) {
          break;
        }
      }
    }
  }
}

/**
 * A stable, NON-reversible client key.
 *
 * The repo's privacy policy keeps full IP addresses out of logs and out of
 * durable state, and a rate-limit map is durable state for as long as the
 * window lasts. Hashing with a per-process salt derived from `APP_SECRET` gives
 * a key that groups the same client together without the map ever holding an
 * address that could be read back out of a heap dump.
 */
export function clientRateKey(request: FastifyRequest): string {
  const salt = optionalEnv("APP_SECRET", "zedbot-miniapp-ratelimit");
  return createHash("sha256").update(salt).update("|").update(request.ip).digest("base64url")
    .slice(0, 22);
}
