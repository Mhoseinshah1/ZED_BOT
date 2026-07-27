import {
  createLogger,
  MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS,
  MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
  MINIAPP_SESSION_MAX_TTL_SECONDS,
  MINIAPP_SESSION_MIN_TTL_SECONDS,
  optionalEnv,
} from "@zedbot/shared";

// =============================================================================
// Every numeric knob the Mini App exposes, and the bounds each is tuned within.
//
// None of these were meant to be constants an operator has to patch the source
// to change — a bot whose users sit on slow mobile networks may need a wider
// `initData` window, a deployment with stricter policy may want a shorter
// session, and an operator under attack may want a tighter sign-in ceiling. But
// none of them is a free-text knob either: a "0" or a "one week" here is a
// security decision disguised as a tuning value, so all are CLAMPED to a
// documented range rather than trusted.
//
// CLAMPING, NOT THROWING, and that distinction is the whole point of this file.
// Every one of these is read ON THE REQUEST PATH so an operator's change takes
// effect without a restart. A parser that throws on a malformed value therefore
// does not fail at boot where someone would see it — it turns one typo in the
// environment into a 500 on every single sign-in, taking authentication down
// completely for a mistake whose safe neighbour was right there. So a value
// that cannot be read takes the documented default, and the fact that it did is
// reported once at startup (`logMiniAppConfig`) where an operator can act on it.
//
// "Cannot be read" is strict: only a whole run of digits counts. "5abc" is a
// typo, not "five" — half-reading it would silently apply a limit the operator
// never wrote.
// =============================================================================

const logger = createLogger("api");

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

/** How a configured value was resolved — reported at startup, not per request. */
export type ConfigResolution =
  /** Nothing was set; the documented default applies. */
  | "default"
  /** A usable value was set and used as written. */
  | "configured"
  /** A usable value was set but fell outside the bounds and was clamped. */
  | "clamped"
  /** Something unusable was set; the documented default applies instead. */
  | "invalid";

export interface ResolvedIntSetting {
  /** The effective value. Always inside [min, max]; never NaN. */
  value: number;
  resolution: ConfigResolution;
}

/**
 * Reads an integer setting, clamped, with the default for anything unusable.
 *
 * NEVER THROWS. Deliberately not `intEnv`, which raises on a non-numeric value:
 * see the header for why a throw here is a self-inflicted outage rather than a
 * safety measure.
 */
export function resolveClampedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): ResolvedIntSetting {
  const raw = optionalEnv(name, "").trim();
  if (raw === "") {
    return { value: fallback, resolution: "default" };
  }
  // The WHOLE value must be digits. `Number.parseInt` would happily read "5abc"
  // as 5 and "1e9" as 1, applying a ceiling nobody wrote.
  if (!/^\d+$/.test(raw)) {
    return { value: fallback, resolution: "invalid" };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { value: fallback, resolution: "invalid" };
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  return { value: clamped, resolution: clamped === parsed ? "configured" : "clamped" };
}

function clampedSeconds(name: string, fallback: number, min: number, max: number): number {
  return resolveClampedInt(name, fallback, min, max).value;
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

// --- authentication rate ceiling ---------------------------------------------

/** Production default. Five sign-ins a minute is far above honest use. */
export const MINIAPP_AUTH_RATE_LIMIT_DEFAULT = 5;
/**
 * Floor of one. Zero would not be "strict", it would be a total outage: nobody
 * could ever sign in, including the operator who set it.
 */
export const MINIAPP_AUTH_RATE_LIMIT_MIN = 1;
/**
 * Ceiling. Above this the setting stops limiting anything, and an operator who
 * meant to relax the limit for a load test would silently be turning it off.
 */
export const MINIAPP_AUTH_RATE_LIMIT_MAX = 10_000;

/** The resolved per-minute authentication ceiling, with how it was resolved. */
export function resolveMiniAppAuthRateLimit(): ResolvedIntSetting {
  return resolveClampedInt(
    "MINIAPP_AUTH_RATE_LIMIT",
    MINIAPP_AUTH_RATE_LIMIT_DEFAULT,
    MINIAPP_AUTH_RATE_LIMIT_MIN,
    MINIAPP_AUTH_RATE_LIMIT_MAX,
  );
}

/**
 * The per-minute authentication ceiling.
 *
 * Called from inside the limiter on EVERY `POST /auth`, which is exactly why it
 * cannot throw: this is the hot path of the endpoint that is supposed to stay
 * up under abuse.
 */
export function miniAppAuthRateLimit(): number {
  return resolveMiniAppAuthRateLimit().value;
}

// --- startup report -----------------------------------------------------------

/**
 * Logs the EFFECTIVE value of every Mini App knob, exactly once, at boot.
 *
 * The point is not telemetry. Because a malformed value fails soft, an operator
 * who typed `MINIAPP_AUTH_RATE_LIMIT=5abc` would otherwise have no signal at
 * all that their limit is not in force — the API would simply run on the
 * default forever. This is that signal, and it is at `error` level for an
 * unusable value because it means the configuration in the file is not the
 * configuration the service is running.
 */
export function logMiniAppConfig(): void {
  const settings = [
    {
      name: "MINIAPP_AUTH_RATE_LIMIT",
      unit: "per minute",
      resolved: resolveMiniAppAuthRateLimit(),
    },
    {
      name: "MINIAPP_INITDATA_MAX_AGE_SECONDS",
      unit: "seconds",
      resolved: resolveClampedInt(
        "MINIAPP_INITDATA_MAX_AGE_SECONDS",
        MINIAPP_INITDATA_DEFAULT_MAX_AGE_SECONDS,
        MINIAPP_INITDATA_MIN_MAX_AGE_SECONDS,
        MINIAPP_INITDATA_MAX_MAX_AGE_SECONDS,
      ),
    },
    {
      name: "MINIAPP_SESSION_TTL_SECONDS",
      unit: "seconds",
      resolved: resolveClampedInt(
        "MINIAPP_SESSION_TTL_SECONDS",
        MINIAPP_SESSION_DEFAULT_TTL_SECONDS,
        MINIAPP_SESSION_MIN_TTL_SECONDS,
        MINIAPP_SESSION_MAX_TTL_SECONDS,
      ),
    },
  ];

  for (const setting of settings) {
    const { value, resolution } = setting.resolved;
    // The raw value is NOT echoed: it is operator input, and a startup log is
    // not the place to reflect arbitrary text back. The name and the outcome
    // are enough to find and fix it.
    if (resolution === "invalid") {
      logger.error(
        `${setting.name} is not a whole number; running on the default of ${value} ${setting.unit}.`,
      );
    } else if (resolution === "clamped") {
      logger.warn(
        `${setting.name} was outside its allowed range; clamped to ${value} ${setting.unit}.`,
      );
    } else {
      logger.info(`${setting.name} = ${value} ${setting.unit} (${resolution}).`);
    }
  }
}
