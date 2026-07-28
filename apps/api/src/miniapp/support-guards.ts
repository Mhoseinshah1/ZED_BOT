import type { FastifyReply, FastifyRequest } from "fastify";

import { miniAppSupportClientRateLimit, miniAppSupportRateLimit } from "./config.js";
import {
  checkRequestOrigin,
  clientRateKey,
  FixedWindowRateLimiter,
  type RateLimitDecision,
} from "./security.js";
import { isSecureRequest } from "./transport.js";

// =============================================================================
// What every Support Center MUTATION must survive before it reaches the domain.
//
// The read surface that came before this had exactly two POSTs — sign in and
// sign out — and each repeated its own checks inline. Adding four more
// mutations that way would mean four more chances to forget one, and the one
// people forget is never the same one twice. So the checks are a single
// ordered gate, and a route either passes through it or is not a mutation.
//
// THE ORDER IS DELIBERATE, cheapest and most categorical first:
//
//   1. TRANSPORT. Plaintext in production is refused before anything reads the
//      body, because everything after this point is either a credential or the
//      user's own words.
//   2. ORIGIN. A state change triggered by another site is a state change the
//      user did not ask for. Checked before the rate limiter so a cross-site
//      flood cannot consume the victim's own quota.
//   3. CONTENT TYPE. `application/json` or nothing. Fastify would parse a form
//      post as an empty body and hand the route a well-formed-looking request
//      that means something else entirely; 415 says so out loud.
//   4. RATE. Per user AND per client, because they answer different questions:
//      per-user stops one account flooding the support queue from ten devices,
//      per-client stops one host cycling accounts. Neither subsumes the other,
//      so both are enforced and the tighter one wins.
//
// Body size is NOT here: Fastify enforces it per route before the handler runs,
// which is earlier than any of this and cannot be forgotten at the call site.
// =============================================================================

export type MutationGuardCode =
  | "INSECURE_TRANSPORT"
  | "FORBIDDEN_ORIGIN"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED";

export interface MutationRejection {
  status: number;
  code: MutationGuardCode;
  /** Seconds to wait, for the rate-limited case only. */
  retryAfterSeconds?: number;
}

/** How long a Support Center mutation window lasts. */
export const SUPPORT_MUTATION_WINDOW_MS = 60_000;

export interface SupportMutationLimiters {
  perUser: FixedWindowRateLimiter;
  perClient: FixedWindowRateLimiter;
}

/**
 * Both ceilings are resolved PER CHECK, not captured at construction, so
 * `MINIAPP_SUPPORT_RATE_LIMIT` takes effect without a restart — and so a test
 * can lower it for one scenario and put it back.
 */
export function createSupportMutationLimiters(): SupportMutationLimiters {
  return {
    perUser: new FixedWindowRateLimiter(miniAppSupportRateLimit, SUPPORT_MUTATION_WINDOW_MS),
    perClient: new FixedWindowRateLimiter(
      miniAppSupportClientRateLimit,
      SUPPORT_MUTATION_WINDOW_MS,
    ),
  };
}

/** True when the request declares a JSON body. Parameters (charset) are fine. */
export function isJsonContentType(raw: string | undefined): boolean {
  if (typeof raw !== "string") {
    return false;
  }
  const type = raw.split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

/**
 * Run the gate. Returns `null` when the request may proceed.
 *
 * `production` is a parameter rather than a read of NODE_ENV so a test can
 * exercise the production branch without pretending to be production
 * everywhere else in the process.
 */
export function checkSupportMutation(
  request: FastifyRequest,
  options: {
    allowedOrigins: ReadonlySet<string>;
    limiters: SupportMutationLimiters;
    userId: string;
    production: boolean;
    nowMs?: number;
  },
): MutationRejection | null {
  if (options.production && !isSecureRequest(request)) {
    return { status: 403, code: "INSECURE_TRANSPORT" };
  }
  if (checkRequestOrigin(request, options.allowedOrigins) === "forbidden") {
    return { status: 403, code: "FORBIDDEN_ORIGIN" };
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" };
  }

  const now = options.nowMs ?? Date.now();
  // Both are consumed, never short-circuited: a request that is under the
  // per-user limit but over the per-client one must still count against the
  // user, or a shared host becomes a way to keep one account's window empty.
  const user: RateLimitDecision = options.limiters.perUser.check(`u:${options.userId}`, now);
  const client: RateLimitDecision = options.limiters.perClient.check(clientRateKey(request), now);
  if (!user.allowed || !client.allowed) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: Math.max(
        user.allowed ? 0 : user.retryAfterSeconds,
        client.allowed ? 0 : client.retryAfterSeconds,
      ),
    };
  }
  return null;
}

/** Apply a rejection to the reply. Returns the reply so handlers can `return`. */
export function sendMutationRejection(
  reply: FastifyReply,
  rejection: MutationRejection,
): FastifyReply {
  if (rejection.retryAfterSeconds !== undefined) {
    void reply.header("Retry-After", String(rejection.retryAfterSeconds));
  }
  return reply.code(rejection.status).send({ ok: false, code: rejection.code });
}
