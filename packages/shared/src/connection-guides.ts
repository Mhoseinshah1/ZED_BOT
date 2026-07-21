// =============================================================================
// Device connection guides (feat/device-connection-guides) — shared contract.
//
// This module owns the language-neutral, cross-package constants for the
// operator-managed "how to connect" guide system: the master-switch setting key,
// the typed platform vocabulary + compact callback codes, every input bound, and
// the HTTPS download-URL validator. Persian labels are NOT here — they live in
// the editable ButtonText/MessageTemplate registry (callback behavior never
// depends on an editable label).
//
// `platform` is a typed STRING at the DB layer (see schema comment) validated
// here, so future devices can be added without a Postgres enum migration.
// =============================================================================

/** Master switch. Default FALSE — the whole system is dormant until the OWNER
 * configures + activates at least one guide app and explicitly enables it. */
export const CONNECTION_GUIDES_ENABLED_KEY = "connection_guides_enabled";

/** The supported platforms, in canonical display order. */
export const GUIDE_PLATFORMS = [
  "IOS",
  "ANDROID",
  "WINDOWS",
  "MACOS",
  "LINUX",
  "ANDROID_TV",
] as const;

export type GuidePlatform = (typeof GUIDE_PLATFORMS)[number];

/** True when `value` is one of the supported platform identifiers. */
export function isGuidePlatform(value: string): value is GuidePlatform {
  return (GUIDE_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Compact, stable, ASCII callback codes (<=3 chars, `[a-z]` only) used INSIDE
 * callback data so `user:svc:guide:<sid>:<code>` stays well under Telegram's
 * 64-byte limit. These codes are an immutable wire contract — never derived from
 * an editable label, never changed once shipped.
 */
export const GUIDE_PLATFORM_CODE: Record<GuidePlatform, string> = {
  IOS: "ios",
  ANDROID: "and",
  WINDOWS: "win",
  MACOS: "mac",
  LINUX: "lin",
  ANDROID_TV: "atv",
};

const GUIDE_PLATFORM_BY_CODE: Record<string, GuidePlatform> = Object.fromEntries(
  GUIDE_PLATFORMS.map((p) => [GUIDE_PLATFORM_CODE[p], p]),
) as Record<string, GuidePlatform>;

/** Resolves a compact callback code back to its platform, or null if unknown. */
export function guidePlatformFromCode(code: string): GuidePlatform | null {
  return GUIDE_PLATFORM_BY_CODE[code] ?? null;
}

/** Neutral (non-user-facing) platform label for logs/admin fallbacks only. */
export const GUIDE_PLATFORM_NEUTRAL_LABEL: Record<GuidePlatform, string> = {
  IOS: "iOS / iPadOS",
  ANDROID: "Android",
  WINDOWS: "Windows",
  MACOS: "macOS",
  LINUX: "Linux",
  ANDROID_TV: "Android TV",
};

// --- input bounds ------------------------------------------------------------
/** Slug: lowercase ASCII letters/digits/hyphens, no leading/trailing hyphen. It
 * travels in callback data, so the max keeps the 3-segment callback < 64 bytes:
 * `user:svc:guide:`(15) + sid(≤32 in theory, 8 in practice) + `:` + code(3) +
 * `:` + slug(≤32). With the real 8-char sid the worst case is 60 bytes. */
export const GUIDE_SLUG_MIN = 2;
export const GUIDE_SLUG_MAX = 32;
export const GUIDE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const GUIDE_DISPLAY_NAME_MIN = 2;
export const GUIDE_DISPLAY_NAME_MAX = 60;
/** Icon emoji length is counted in UTF-16 code units. A single "perceived" emoji
 * (ZWJ sequences like 👨‍👩‍👧‍👦, flags, skin-tone/variation selectors) can be 11+
 * code units, so the cap is generous enough to accept any one complex emoji while
 * still rejecting a pasted paragraph. */
export const GUIDE_ICON_EMOJI_MAX = 32;
export const GUIDE_INSTRUCTIONS_MIN = 5;
export const GUIDE_INSTRUCTIONS_MAX = 3000;
export const GUIDE_TROUBLESHOOTING_MAX = 2000;
export const GUIDE_SORT_ORDER_MIN = 0;
export const GUIDE_SORT_ORDER_MAX = 9999;
export const GUIDE_DOWNLOAD_URL_MAX = 512;

/** Hard cap on the assembled (HTML-escaped) guide-page text. A fully populated
 * app (3000 + 2000 chars) plus intro/status would exceed Telegram's 4096-char
 * message limit, which makes BOTH the edit and the reply fallback fail silently;
 * the view layer clamps the operator body to keep the whole message under this. */
export const GUIDE_PAGE_TEXT_MAX = 3900;

/** Hard cap on how many active apps a single platform may present, so the
 * application-selection keyboard can never grow unbounded. */
export const GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM = 12;

/** True when `slug` matches the bounded, safe slug format. */
export function isValidGuideSlug(slug: string): boolean {
  return (
    typeof slug === "string" &&
    slug.length >= GUIDE_SLUG_MIN &&
    slug.length <= GUIDE_SLUG_MAX &&
    GUIDE_SLUG_PATTERN.test(slug)
  );
}

/**
 * Derives a safe, bounded slug candidate from an arbitrary (possibly non-ASCII)
 * display name. Non `[a-z0-9]` runs collapse to single hyphens; the result is
 * trimmed of hyphens and bounded. Returns "app" when nothing usable remains
 * (e.g. a Persian-only name) — the caller de-duplicates with a numeric suffix.
 */
export function slugifyGuideName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GUIDE_SLUG_MAX)
    .replace(/-+$/g, "");
  return base.length >= GUIDE_SLUG_MIN ? base : "app";
}

export type GuideUrlRejectReason =
  | "EMPTY"
  | "TOO_LONG"
  | "CONTROL_CHARS"
  | "UNPARSEABLE"
  | "NOT_HTTPS"
  | "HAS_CREDENTIALS"
  | "NO_HOST";

/**
 * Validates an operator-supplied download URL. The server NEVER fetches, proxies,
 * follows or availability-checks it — this is a pure syntactic gate. Requires
 * `https:`; rejects control characters, embedded credentials, over-length input
 * and anything the standard URL parser cannot parse (which also rejects
 * `javascript:` / `data:` / `file:` / `ftp:` and arbitrary custom schemes).
 * Returns the normalized URL string on success and a typed reason on failure —
 * the reason NEVER echoes the raw URL.
 */
export function validateHttpsDownloadUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: GuideUrlRejectReason } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "EMPTY" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (trimmed.length > GUIDE_DOWNLOAD_URL_MAX) {
    return { ok: false, reason: "TOO_LONG" };
  }
  // Control characters (incl. embedded newlines/tabs/DEL) are never valid.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "CONTROL_CHARS" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "UNPARSEABLE" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "NOT_HTTPS" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "HAS_CREDENTIALS" };
  }
  if (parsed.hostname === "") {
    return { ok: false, reason: "NO_HOST" };
  }
  return { ok: true, url: parsed.toString() };
}
