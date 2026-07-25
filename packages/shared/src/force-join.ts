// =============================================================================
// Mandatory channel membership (Force Join): PURE link parser + normalizer.
//
// Dependency-free (no prisma, no grammY, no fetch) so the admin flow and any
// validation path reach an identical verdict. This module NEVER issues a
// network request (§4.1: no SSRF surface, not even "for validation") — it is
// string logic only. It classifies an admin-supplied LINK into a PUBLIC channel
// username or a PRIVATE invite link, or rejects it with a stable, safe code.
//
// It deliberately does NOT decide whether the target is truly a channel (vs a
// bot / user / group) — that identity/type assertion is Telegram's job at
// resolution time (getChat, §4.2). The parser only guarantees the STRUCTURE is
// a supported Telegram channel/invite link and produces the normalized dedup
// key that DB uniqueness is enforced on.
//
// Adversarial input is REJECTED, never "cleaned": any non-printable-ASCII byte
// (control chars, zero-width joiners, RTL/LTR/bidi marks, and every non-ASCII
// homoglyph) fails UNSAFE_CHARACTERS instead of being folded into ASCII, so a
// spoofed identity can never slip through as an accepted link.
// =============================================================================

/** Hard cap applied before any parsing work (a real link is far under this). */
export const FORCE_JOIN_LINK_MAX_CHARS = 4096;

export type ForceJoinLinkKind = "PUBLIC" | "PRIVATE";

export interface ParsedForceJoinLink {
  kind: ForceJoinLinkKind;
  /**
   * Canonical dedup / identity key. PUBLIC: `https://t.me/<lowercased-username>`.
   * PRIVATE: the canonical invite URL with the hash preserved byte-for-byte.
   * This is the value the public-only DB uniqueness (D6) is keyed on.
   */
  normalizedLink: string;
  /** Buyer-facing join URL. Identical to `normalizedLink` for both kinds. */
  joinUrl: string;
  /** Lowercased public username without '@' (PUBLIC only; null for PRIVATE). */
  publicUsername: string | null;
  /**
   * Private invite hash, preserved case-sensitively (PRIVATE only; null for
   * PUBLIC). This is the join SECRET — never write it to logs or analytics.
   */
  inviteHash: string | null;
}

export type ForceJoinLinkErrorCode =
  | "EMPTY"
  | "TOO_LONG"
  | "UNSAFE_CHARACTERS"
  | "NOT_TELEGRAM"
  | "DEEP_LINK"
  | "MESSAGE_LINK"
  | "MALFORMED"
  | "INVALID_USERNAME"
  | "INVALID_INVITE";

export type ParseForceJoinLinkResult =
  | { ok: true; value: ParsedForceJoinLink }
  | { ok: false; error: ForceJoinLinkErrorCode };

// Telegram public usernames: 5–32 chars, must start with a letter, only
// [A-Za-z0-9_]. (Telegram additionally forbids a trailing '_' and '__' for
// user-set names; getChat is the authority, so we enforce only the safe
// superset here and let resolution reject anything that structurally passes but
// does not actually exist / is not a channel.)
const PUBLIC_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

// Private invite hash: the url-safe token Telegram issues after '+' or
// '/joinchat/'. Non-empty, url-safe alphabet only.
const INVITE_HASH_RE = /^[A-Za-z0-9_-]{1,64}$/;

// First path segment reserved by Telegram for deep links / features — never a
// joinable public channel username. '+' and 'joinchat' are handled separately
// (private invites) and are intentionally NOT in this set.
const RESERVED_FIRST_SEGMENTS = new Set([
  "proxy",
  "socks",
  "share",
  "url",
  "msg",
  "addstickers",
  "addemoji",
  "addtheme",
  "setlanguage",
  "confirmphone",
  "login",
  "bg",
  "boost",
  "giftcode",
  "invoice",
  "addlist",
  "contact",
  "s",
  "iv",
  "c",
]);

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me"]);

function fail(error: ForceJoinLinkErrorCode): ParseForceJoinLinkResult {
  return { ok: false, error };
}

/**
 * Parses and normalizes an admin-supplied force-join channel link. Pure and
 * network-free. Returns the normalized identity for a supported public/private
 * link, or a stable rejection code. See the module header for the safety model.
 */
export function parseForceJoinLink(raw: unknown): ParseForceJoinLinkResult {
  if (typeof raw !== "string") {
    return fail("EMPTY");
  }

  // Strip only OUTER whitespace (benign copy-paste framing); everything that
  // remains must be pure printable ASCII.
  const trimmed = raw.replace(/^\s+|\s+$/g, "");
  if (trimmed.length === 0) {
    return fail("EMPTY");
  }
  if (trimmed.length > FORCE_JOIN_LINK_MAX_CHARS) {
    return fail("TOO_LONG");
  }

  // Reject (never clean) any control / zero-width / bidi / non-ASCII byte: a
  // valid t.me link or @username is entirely printable ASCII (0x21–0x7E). This
  // is the homoglyph-domain + invisible-character defense.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      return fail("UNSAFE_CHARACTERS");
    }
  }

  // A backslash never appears in a real link, but the WHATWG URL parser folds
  // '\' to '/' for special schemes; reject it up front to remove that quirk.
  if (trimmed.includes("\\")) {
    return fail("MALFORMED");
  }

  // '@username' form.
  if (trimmed.startsWith("@")) {
    return classifyPublicUsername(trimmed.slice(1));
  }

  // Scheme handling: tg:// and any non-http(s) scheme are deep links / external.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed);
  let toParse: string;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "tg") {
      return fail("DEEP_LINK");
    }
    if (scheme !== "http" && scheme !== "https") {
      return fail("NOT_TELEGRAM");
    }
    toParse = trimmed;
  } else {
    // A scheme-less "t.me/..." / "telegram.me/..."; give the URL parser a base.
    // Anything carrying a ':' but no '://' (e.g. "tg:resolve") is malformed for
    // our purposes.
    if (trimmed.includes("://") || trimmed.includes(":")) {
      return fail("MALFORMED");
    }
    toParse = `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(toParse);
  } catch {
    return fail("MALFORMED");
  }

  // Defensive: userinfo / port on the authority are rejected (host-spoofing).
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return fail("MALFORMED");
  }
  const host = url.hostname.toLowerCase();
  if (!TELEGRAM_HOSTS.has(host)) {
    return fail("NOT_TELEGRAM");
  }

  // Any query or fragment marks a deep link (share?url=, proxy?server=, …).
  if (url.search !== "" || url.hash !== "") {
    return fail("DEEP_LINK");
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return fail("MALFORMED");
  }

  const first = segments[0];

  // Private invite: /+<hash>
  if (first.startsWith("+")) {
    if (segments.length !== 1) {
      return fail("MALFORMED");
    }
    const hash = first.slice(1);
    if (!INVITE_HASH_RE.test(hash)) {
      return fail("INVALID_INVITE");
    }
    return okPrivate(`https://t.me/+${hash}`, hash);
  }

  // Private invite: /joinchat/<hash>
  if (first.toLowerCase() === "joinchat") {
    if (segments.length !== 2) {
      return fail("MALFORMED");
    }
    const hash = segments[1];
    if (!INVITE_HASH_RE.test(hash)) {
      return fail("INVALID_INVITE");
    }
    return okPrivate(`https://t.me/joinchat/${hash}`, hash);
  }

  // Reserved deep-link first segment (proxy, share, s/<user> web view, …).
  if (RESERVED_FIRST_SEGMENTS.has(first.toLowerCase())) {
    return fail("DEEP_LINK");
  }

  // Message link: /<username>/<postId>.
  if (segments.length >= 2) {
    if (segments.length === 2 && /^\d+$/.test(segments[1])) {
      return fail("MESSAGE_LINK");
    }
    return fail("MALFORMED");
  }

  // Single-segment public username.
  return classifyPublicUsername(first);
}

function classifyPublicUsername(candidate: string): ParseForceJoinLinkResult {
  const lower = candidate.toLowerCase();
  if (RESERVED_FIRST_SEGMENTS.has(lower)) {
    return fail("DEEP_LINK");
  }
  if (lower === "joinchat" || candidate.startsWith("+")) {
    return fail("MALFORMED");
  }
  if (!PUBLIC_USERNAME_RE.test(candidate)) {
    return fail("INVALID_USERNAME");
  }
  const normalized = `https://t.me/${lower}`;
  return {
    ok: true,
    value: {
      kind: "PUBLIC",
      normalizedLink: normalized,
      joinUrl: normalized,
      publicUsername: lower,
      inviteHash: null,
    },
  };
}

function okPrivate(canonicalUrl: string, hash: string): ParseForceJoinLinkResult {
  return {
    ok: true,
    value: {
      kind: "PRIVATE",
      normalizedLink: canonicalUrl,
      joinUrl: canonicalUrl,
      publicUsername: null,
      inviteHash: hash,
    },
  };
}

// --- membership status evaluation (§4.8) -------------------------------------

/**
 * Pure §4.8 membership rule over a getChatMember result. JOINED for `creator`,
 * `administrator`, `member`, and `restricted` ONLY when `is_member === true`.
 * NOT joined for `left`, `kicked`, `restricted` without is_member, and any
 * unknown status. A pending join request is reported by Telegram as `left`, so
 * it correctly resolves to NOT joined here. Shared so the gate and any other
 * consumer reach an identical verdict.
 */
export function isForceJoinMembershipActive(status: string, isMember?: boolean): boolean {
  switch (status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return isMember === true;
    default:
      return false;
  }
}
