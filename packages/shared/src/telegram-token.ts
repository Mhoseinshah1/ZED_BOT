// =============================================================================
// The ONE Telegram bot-token environment contract, shared by the bot AND the
// worker (fix/worker-telegram-token-env-contract). Historically the bot read
// `TELEGRAM_BOT_TOKEN` while the worker read only `BOT_TOKEN`; a normal
// installer-generated `.env` (which writes only `TELEGRAM_BOT_TOKEN`) therefore
// left the worker tokenless and every worker Telegram path (log-group setup, ops
// log delivery, notification delivery, backup notice, Stars recovery) failed
// with `bot-token-missing`. Both processes now resolve the token through the
// SINGLE pure function below, so their precedence can never diverge again.
//
// SECURITY: the token value NEVER leaves this module as anything but the resolved
// string a caller explicitly asked for. Nothing here logs the token, its length,
// a prefix/suffix, a hash, or the raw env value, and no code path puts a token
// into an exception message. The resolver never throws — it returns a typed
// result; diagnostics surface only the KEY NAME (the `source`), never token data.
// =============================================================================

/** The documented, installer-generated canonical key. */
export const TELEGRAM_BOT_TOKEN_CANONICAL_KEY = "TELEGRAM_BOT_TOKEN";
/** The legacy compatibility key (older installs / the worker's historical read). */
export const TELEGRAM_BOT_TOKEN_LEGACY_KEY = "BOT_TOKEN";

/**
 * Which key a token came from — or why none is usable. Reveals ONLY the key
 * name, never any token bytes. `CONFLICT` means both keys are set to different
 * values (fail closed); `MISSING` means neither is set.
 */
export type TelegramBotTokenSource =
  | "TELEGRAM_BOT_TOKEN"
  | "BOT_TOKEN"
  | "MISSING"
  | "CONFLICT";

export type TelegramBotTokenResolution =
  | {
      ok: true;
      token: string;
      /** The key the value was taken from. */
      source: "TELEGRAM_BOT_TOKEN" | "BOT_TOKEN";
      /** True when only the legacy `BOT_TOKEN` was present (safe warning). */
      legacyFallback: boolean;
      /** True when BOTH keys are present with the SAME value (safe warning). */
      duplicateKeys: boolean;
    }
  | {
      ok: false;
      /** MISSING (neither key set) or CONFLICT (both set, different values). */
      source: "MISSING" | "CONFLICT";
    };

/** A minimal env shape — anything with string-or-undefined keys (e.g. process.env). */
export type EnvLike = Record<string, string | undefined>;

function trimmed(value: string | undefined): string {
  return value === undefined ? "" : value.trim();
}

/**
 * The pure, exhaustive Telegram-token precedence, identical for the bot and the
 * worker:
 *
 *   1. only TELEGRAM_BOT_TOKEN set          → use it (source TELEGRAM_BOT_TOKEN);
 *   2. only BOT_TOKEN set                   → use it (legacy fallback, source BOT_TOKEN);
 *   3. both set, EQUAL values               → use TELEGRAM_BOT_TOKEN (duplicateKeys warning);
 *   4. both set, DIFFERENT values           → CONFLICT (ok:false, fail closed);
 *   5. neither set                          → MISSING (ok:false).
 *
 * Never throws; never emits the token anywhere.
 */
export function resolveTelegramBotTokenFromEnv(env: EnvLike): TelegramBotTokenResolution {
  const canonical = trimmed(env[TELEGRAM_BOT_TOKEN_CANONICAL_KEY]);
  const legacy = trimmed(env[TELEGRAM_BOT_TOKEN_LEGACY_KEY]);
  const hasCanonical = canonical !== "";
  const hasLegacy = legacy !== "";

  if (hasCanonical && hasLegacy) {
    if (canonical === legacy) {
      return {
        ok: true,
        token: canonical,
        source: "TELEGRAM_BOT_TOKEN",
        legacyFallback: false,
        duplicateKeys: true,
      };
    }
    return { ok: false, source: "CONFLICT" };
  }
  if (hasCanonical) {
    return {
      ok: true,
      token: canonical,
      source: "TELEGRAM_BOT_TOKEN",
      legacyFallback: false,
      duplicateKeys: false,
    };
  }
  if (hasLegacy) {
    return { ok: true, token: legacy, source: "BOT_TOKEN", legacyFallback: true, duplicateKeys: false };
  }
  return { ok: false, source: "MISSING" };
}

/**
 * The `source` alone — a safe, token-free classification suitable for
 * diagnostics / capability snapshots. Returns `TELEGRAM_BOT_TOKEN` | `BOT_TOKEN`
 * | `MISSING` | `CONFLICT`, and never any token bytes.
 */
export function telegramBotTokenSourceFromEnv(env: EnvLike): TelegramBotTokenSource {
  return resolveTelegramBotTokenFromEnv(env).source;
}

/** True when a usable token resolves (canonical, legacy, or equal duplicate). */
export function isTelegramBotTokenConfigured(env: EnvLike): boolean {
  return resolveTelegramBotTokenFromEnv(env).ok;
}

// --- runtime accessors (read process.env through the ONE resolver) -----------

/** The resolution for the CURRENT process env (bot + worker share this). */
export function resolveTelegramBotToken(): TelegramBotTokenResolution {
  return resolveTelegramBotTokenFromEnv(process.env);
}

/**
 * The resolved token for the current process, or `null` when it is MISSING or in
 * CONFLICT (fail closed — a mismatched pair never yields a token, so the bot and
 * worker can never silently run on different tokens). Never logs the value.
 */
export function getTelegramBotToken(): string | null {
  const resolution = resolveTelegramBotToken();
  return resolution.ok ? resolution.token : null;
}
