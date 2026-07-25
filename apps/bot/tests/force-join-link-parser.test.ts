import {
  FORCE_JOIN_LINK_MAX_CHARS,
  parseForceJoinLink,
  type ForceJoinLinkErrorCode,
  type ParsedForceJoinLink,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// Phase 1 — force-join link parser/normalizer (PURE, network-free). Covers
// every adversarial case in spec §4.1:
//   - accepted public/private forms + scheme/host/case normalization
//   - duplicate detection via identical normalizedLink (dedup key)
//   - rejection of external URLs, malformed links, message links, deep links,
//     tg:// links, and whitespace / zero-width / bidi / homoglyph tricks
//   - NO network request is ever made (the function is synchronous string logic)
// =============================================================================

function expectOk(raw: string): ParsedForceJoinLink {
  const result = parseForceJoinLink(raw);
  expect(result.ok, `expected ${JSON.stringify(raw)} to parse`).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.value;
}

function expectErr(raw: unknown, code: ForceJoinLinkErrorCode): void {
  const result = parseForceJoinLink(raw);
  expect(result.ok, `expected ${JSON.stringify(raw)} to be rejected as ${code}`).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.error, `wrong code for ${JSON.stringify(raw)}`).toBe(code);
}

describe("parseForceJoinLink — accepted public forms", () => {
  it("accepts https://t.me/<username>", () => {
    const v = expectOk("https://t.me/zedproxy");
    expect(v.kind).toBe("PUBLIC");
    expect(v.normalizedLink).toBe("https://t.me/zedproxy");
    expect(v.joinUrl).toBe("https://t.me/zedproxy");
    expect(v.publicUsername).toBe("zedproxy");
    expect(v.inviteHash).toBeNull();
  });

  it("accepts https://telegram.me/<username> and normalizes host to t.me", () => {
    const v = expectOk("https://telegram.me/zedproxy");
    expect(v.kind).toBe("PUBLIC");
    expect(v.normalizedLink).toBe("https://t.me/zedproxy");
  });

  it("accepts scheme-less t.me/<username>", () => {
    const v = expectOk("t.me/zedproxy");
    expect(v.normalizedLink).toBe("https://t.me/zedproxy");
  });

  it("accepts @<username>", () => {
    const v = expectOk("@zedproxy");
    expect(v.kind).toBe("PUBLIC");
    expect(v.normalizedLink).toBe("https://t.me/zedproxy");
    expect(v.publicUsername).toBe("zedproxy");
  });

  it("normalizes http:// to https://", () => {
    expect(expectOk("http://t.me/zedproxy").normalizedLink).toBe("https://t.me/zedproxy");
  });

  it("normalizes username case (Telegram usernames are case-insensitive)", () => {
    expect(expectOk("@ZedProxy").normalizedLink).toBe("https://t.me/zedproxy");
    expect(expectOk("t.me/ZEDPROXY").normalizedLink).toBe("https://t.me/zedproxy");
    expect(expectOk("https://telegram.me/ZedProxy").publicUsername).toBe("zedproxy");
  });

  it("strips only outer whitespace", () => {
    expect(expectOk("   @zedproxy   ").normalizedLink).toBe("https://t.me/zedproxy");
    expect(expectOk("\n t.me/zedproxy \t").normalizedLink).toBe("https://t.me/zedproxy");
  });

  it("tolerates a trailing slash", () => {
    expect(expectOk("https://t.me/zedproxy/").normalizedLink).toBe("https://t.me/zedproxy");
  });

  it("accepts usernames with digits and underscores", () => {
    expect(expectOk("@zed_proxy_2024").publicUsername).toBe("zed_proxy_2024");
  });
});

describe("parseForceJoinLink — duplicate identity (dedup key)", () => {
  it("maps every equivalent public form to the same normalizedLink", () => {
    const forms = [
      "@ZedProxy",
      "t.me/zedproxy",
      "https://t.me/ZEDPROXY",
      "https://telegram.me/ZedProxy",
      "http://t.me/zedProxy/",
      "  @zedproxy  ",
    ];
    const normalized = new Set(forms.map((f) => expectOk(f).normalizedLink));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe("https://t.me/zedproxy");
  });
});

describe("parseForceJoinLink — accepted private invite forms", () => {
  it("accepts https://t.me/+<hash> and preserves the hash byte-for-byte", () => {
    const v = expectOk("https://t.me/+AbC123_def-XY");
    expect(v.kind).toBe("PRIVATE");
    expect(v.normalizedLink).toBe("https://t.me/+AbC123_def-XY");
    expect(v.joinUrl).toBe("https://t.me/+AbC123_def-XY");
    expect(v.inviteHash).toBe("AbC123_def-XY");
    expect(v.publicUsername).toBeNull();
  });

  it("accepts https://t.me/joinchat/<hash>", () => {
    const v = expectOk("https://t.me/joinchat/AbC123def");
    expect(v.kind).toBe("PRIVATE");
    expect(v.normalizedLink).toBe("https://t.me/joinchat/AbC123def");
    expect(v.inviteHash).toBe("AbC123def");
  });

  it("accepts a scheme-less private invite", () => {
    expect(expectOk("t.me/+AbC123").normalizedLink).toBe("https://t.me/+AbC123");
  });

  it("does NOT lowercase the private invite hash (it is case-sensitive)", () => {
    const v = expectOk("https://t.me/+AbCdEf");
    expect(v.inviteHash).toBe("AbCdEf");
    expect(v.normalizedLink).toBe("https://t.me/+AbCdEf");
  });
});

describe("parseForceJoinLink — rejects external / non-telegram", () => {
  it("rejects arbitrary external URLs", () => {
    expectErr("https://example.com/zedproxy", "NOT_TELEGRAM");
    expectErr("https://t.me.evil.com/zedproxy", "NOT_TELEGRAM");
    expectErr("https://nott.me/zedproxy", "NOT_TELEGRAM");
  });

  it("rejects a userinfo host-spoof (t.me@evil.com)", () => {
    expectErr("https://t.me@evil.com/zedproxy", "MALFORMED");
  });

  it("rejects a non-http(s) scheme", () => {
    expectErr("ftp://t.me/zedproxy", "NOT_TELEGRAM");
  });

  it("rejects a host with an explicit (non-default) port", () => {
    expectErr("t.me:8080/zedproxy", "MALFORMED");
    expectErr("https://t.me:8080/zedproxy", "MALFORMED");
  });

  it("rejects a bare username without @ or a t.me host", () => {
    expectErr("zedproxy", "NOT_TELEGRAM");
  });
});

describe("parseForceJoinLink — rejects deep links", () => {
  it("rejects tg:// links", () => {
    expectErr("tg://resolve?domain=zedproxy", "DEEP_LINK");
    expectErr("tg://join?invite=abc", "DEEP_LINK");
  });

  it("rejects proxy / socks / share deep links", () => {
    expectErr("https://t.me/proxy?server=1.2.3.4&port=443", "DEEP_LINK");
    expectErr("t.me/socks?server=1.2.3.4", "DEEP_LINK");
    expectErr("https://t.me/share?url=https://x", "DEEP_LINK");
  });

  it("rejects the s/<user> web-preview and c/<id> private-post prefixes", () => {
    expectErr("https://t.me/s/zedproxy", "DEEP_LINK");
    expectErr("https://t.me/c/1234567890/42", "DEEP_LINK");
  });

  it("rejects any link carrying a query or fragment", () => {
    expectErr("https://t.me/zedproxy?start=abc", "DEEP_LINK");
    expectErr("https://t.me/zedproxy#frag", "DEEP_LINK");
  });

  it("rejects reserved usernames given in @ form", () => {
    expectErr("@proxy", "DEEP_LINK");
    expectErr("@share", "DEEP_LINK");
  });
});

describe("parseForceJoinLink — rejects message links", () => {
  it("rejects t.me/<username>/<postId>", () => {
    expectErr("https://t.me/durov/123", "MESSAGE_LINK");
    expectErr("t.me/zedproxy/1", "MESSAGE_LINK");
  });
});

describe("parseForceJoinLink — rejects malformed", () => {
  it("rejects a bare host", () => {
    expectErr("t.me", "MALFORMED");
    expectErr("https://t.me", "MALFORMED");
    expectErr("https://t.me/", "MALFORMED");
  });

  it("rejects joinchat with no hash", () => {
    expectErr("https://t.me/joinchat", "MALFORMED");
  });

  it("rejects an empty private invite hash", () => {
    expectErr("https://t.me/+", "INVALID_INVITE");
  });

  it("rejects a private invite with extra path segments", () => {
    expectErr("https://t.me/+abc/def", "MALFORMED");
    expectErr("https://t.me/joinchat/abc/def", "MALFORMED");
  });

  it("rejects a backslash host-spoof attempt", () => {
    expectErr("https://t.me\\@evil.com/zedproxy", "MALFORMED");
    expectErr("t.me\\zedproxy", "MALFORMED");
  });

  it("rejects a scheme-less string with a stray colon", () => {
    expectErr("tg:resolve", "MALFORMED");
  });
});

describe("parseForceJoinLink — rejects invalid usernames", () => {
  it("rejects @ alone", () => {
    expectErr("@", "INVALID_USERNAME");
  });

  it("rejects too-short usernames (< 5 chars)", () => {
    expectErr("@abcd", "INVALID_USERNAME");
    expectErr("t.me/abcd", "INVALID_USERNAME");
  });

  it("rejects too-long usernames (> 32 chars)", () => {
    const longName = "a".repeat(33);
    expectErr(`@${longName}`, "INVALID_USERNAME");
  });

  it("rejects usernames that do not start with a letter", () => {
    expectErr("@1zedproxy", "INVALID_USERNAME");
    expectErr("@_zedproxy", "INVALID_USERNAME");
  });

  it("rejects usernames with illegal characters (percent-encoding, dots)", () => {
    expectErr("t.me/zed.proxy", "INVALID_USERNAME"); // '.' is not a legal username char
    expectErr("t.me/%2Bzedproxy", "INVALID_USERNAME"); // percent-encoding never decoded
  });
});

describe("parseForceJoinLink \u2014 rejects unsafe characters (never cleans)", () => {
  it("rejects an internal space", () => {
    expectErr("t.me/zed proxy", "UNSAFE_CHARACTERS");
    expectErr("@zed proxy", "UNSAFE_CHARACTERS");
  });

  it("rejects zero-width characters", () => {
    expectErr("t.me/zed\u200Bproxy", "UNSAFE_CHARACTERS"); // ZWSP
    expectErr("@zed\u200Dproxy", "UNSAFE_CHARACTERS"); // ZWJ
    expectErr("t.me/zed\uFEFFproxy", "UNSAFE_CHARACTERS"); // ZWNBSP (internal)
  });

  it("rejects RTL / LTR / bidi marks", () => {
    expectErr("@zed\u200Fproxy", "UNSAFE_CHARACTERS"); // RLM
    expectErr("t.me/zed\u202Eproxy", "UNSAFE_CHARACTERS"); // RLO
    expectErr("@zed\u200Eproxy", "UNSAFE_CHARACTERS"); // LRM
  });

  it("rejects homoglyph domains and homoglyph usernames (non-ASCII)", () => {
    expectErr("https://t.m\u0435/zedproxy", "UNSAFE_CHARACTERS"); // Cyrillic 'e' in host
    expectErr("@z\u0435dproxy", "UNSAFE_CHARACTERS"); // Cyrillic 'e' in username
    expectErr("https://\uFF54.me/zedproxy", "UNSAFE_CHARACTERS"); // fullwidth 't' host
  });

  it("rejects control characters", () => {
    expectErr("t.me/zed\u0000proxy", "UNSAFE_CHARACTERS"); // NUL
    expectErr("t.me/zed\u0007proxy", "UNSAFE_CHARACTERS"); // BEL
    expectErr("t.me/zed\u001Bproxy", "UNSAFE_CHARACTERS"); // ESC
  });
});

describe("parseForceJoinLink — boundary / input hygiene", () => {
  it("rejects empty / whitespace-only / non-string input", () => {
    expectErr("", "EMPTY");
    expectErr("    ", "EMPTY");
    expectErr(undefined, "EMPTY");
    expectErr(null, "EMPTY");
    expectErr(12345, "EMPTY");
  });

  it("rejects input exceeding the length cap", () => {
    expectErr(`t.me/${"a".repeat(FORCE_JOIN_LINK_MAX_CHARS)}`, "TOO_LONG");
  });

  it("accepts a minimum-length (5 char) username", () => {
    expect(expectOk("@abcde").publicUsername).toBe("abcde");
  });

  it("accepts a maximum-length (32 char) username", () => {
    const name = `a${"b".repeat(31)}`; // 32 chars, starts with a letter
    expect(expectOk(`@${name}`).publicUsername).toBe(name);
  });
});

describe("parseForceJoinLink — parser is structural only (type asserted later)", () => {
  it("does NOT itself reject bot-looking or user-looking usernames", () => {
    // The parser cannot distinguish a channel from a bot/user by username; the
    // channel-vs-bot/user assertion is Telegram's job at getChat (§4.2). These
    // structurally-valid usernames therefore parse as PUBLIC candidates.
    expect(expectOk("@somenewsbot").kind).toBe("PUBLIC");
    expect(expectOk("@some_user").kind).toBe("PUBLIC");
  });
});
