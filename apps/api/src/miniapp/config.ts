import {
  MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS,
  MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
  MINIAPP_SESSION_MAX_TTL_SECONDS,
  MINIAPP_SESSION_MIN_TTL_SECONDS,
  optionalEnv,
} from "@zedbot/shared";

// =============================================================================
// The two lifetimes an operator may tune, and the bounds they are tuned within.
//
// Both were hard-coded. Neither is a constant an operator should have to patch
// the source to change — a bot whose users sit on slow mobile networks may need
// a wider `initData` window, and a deployment with stricter policy may want a
// shorter session. But neither is a free-text knob either: a "0" or a "one week"
// here is a security decision disguised as a tuning value, so both are CLAMPED
// to a documented range rather than trusted.
//
// Clamping, not rejecting, on purpose. A refusal at boot would take the API down
// over a typo in a value that has a perfectly good safe neighbour; clamping
// keeps the service up and the guarantee intact.
// =============================================================================

/**
 * Lower bound on the `initData` freshness window.
 *
 * Below about half a minute the window stops being a replay bound and starts
 * being a clock-skew lottery: Telegram's `auth_date` and the server's clock are
 * independent, and the validator already tolerates 30s of forward drift.
 */
export const MINIAPP_INITDATA_MIN_MAX_AGE_SECONDS = 30;

/**
 * Upper bound on the same window.
 *
 * `initData` is a bearer credential for as long as it is accepted. An hour is
 * already generous for "the user opened the Mini App and it took a while to
 * load"; beyond that a payload captured from a shared device stays usable long
 * after the person walked away.
 */
export const MINIAPP_INITDATA_MAX_MAX_AGE_SECONDS = 60 * 60;

/**
 * Reads an integer setting, clamped, with the default for anything unusable.
 *
 * Deliberately NOT `intEnv`, which throws on a non-numeric value. These are
 * read per request, so a throw would turn one typo in the environment into a
 * 500 on every sign-in — the loudest possible failure for the least important
 * kind of mistake. Only a whole run of digits counts; "10s" is a typo, not
 * "ten", so it takes the default rather than being half-read.
 */
function clampedSeconds(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalEnv(name, "").trim();
  if (!/^\d+$/.test(raw)) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * How old a signed Telegram payload may be at `POST /auth`
 * (`MINIAPP_INITDATA_MAX_AGE_SECONDS`, default 300s, clamped to 30s..1h).
 */
export function miniAppInitDataMaxAgeSeconds(): number {
  return clampedSeconds(
    "MINIAPP_INITDATA_MAX_AGE_SECONDS",
    MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS,
    MINIAPP_INITDATA_MIN_MAX_AGE_SECONDS,
    MINIAPP_INITDATA_MAX_MAX_AGE_SECONDS,
  );
}

/**
 * How long a minted session cookie stays valid
 * (`MINIAPP_SESSION_TTL_SECONDS`, default 900s, clamped to 60s..1h).
 *
 * The bounds are the session module's own — `issueMiniAppSession` clamps to
 * exactly the same range, so a value that slipped past here could still not
 * mint a token outside it. Clamping in both places is deliberate: this one
 * makes the cookie's `Max-Age` agree with the token's real expiry, and the
 * other makes the token safe regardless of who calls it.
 */
export function miniAppSessionTtlSeconds(): number {
  return clampedSeconds(
    "MINIAPP_SESSION_TTL_SECONDS",
    MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
    MINIAPP_SESSION_MIN_TTL_SECONDS,
    MINIAPP_SESSION_MAX_TTL_SECONDS,
  );
}
