import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "qr-code-tests-secret-0123456789";

import { generateQrPng, QR_MAX_PAYLOAD_BYTES } from "../src/services/qr-code.service.js";
import { decodeQrPng, PNG_SIGNATURE } from "./helpers/qr-decode.js";

// =============================================================================
// §2/§10 - the pure QR generator: in-memory PNG, exact byte-for-byte payload,
// typed safe errors, bounded size, no disk, no payload leaked. Plus the required
// ROUND-TRIP test: encode a representative vmess/vless/trojan/ss/subscription URL
// (incl. Persian, URL-encoding, query strings, fragments, long configs) and
// decode the PNG back, asserting equality byte-for-byte.
// =============================================================================

// Representative real-world VPN payloads (byte-exact round-trip must hold).
const PAYLOADS: Array<[string, string]> = [
  ["vmess", "vmess://eyJ2IjoiMiIsInBzIjoiTm9kZS0xIiwiYWRkIjoiZXhhbXBsZS5jb20iLCJwb3J0IjoiNDQzIn0="],
  ["vless", "vless://3f2c8a44-1111-2222-3333-444455556666@example.com:443?type=ws&security=tls&path=%2Fws&sni=example.com#سرور-آلمان"],
  ["trojan", "trojan://p%40ssw0rd@host.example.com:443?sni=example.com&alpn=h2#Trojan%20Node"],
  ["shadowsocks", "ss://YWVzLTI1Ni1nY206c2VjcmV0LXBhc3M=@1.2.3.4:8388#SS-تهران"],
  ["subscription", "https://sub.example.com/api/v1/client/subscribe?token=abc123XYZ&name=%D8%B3%D8%B1%D9%88%DB%8C%D8%B3#frag"],
  ["persian-text", "کانفیگ اختصاصی شما ✅ https://example.com/سرویس/۱۲۳"],
  ["html-sensitive", 'vless://uuid@h.example.com:443?path=/a<b>&c="d"&e=\'f\'#name<>&"'],
  ["query-and-fragment", "https://panel.example.com/sub?a=1&b=2&c=3&x=%D8%AA#section-2?nested=yes"],
  ["long-config", `vmess://${"A".repeat(800)}`],
];

describe("generateQrPng - in-memory PNG + typed safe errors (§2)", () => {
  it("returns a real in-memory PNG buffer for a valid payload", async () => {
    const res = await generateQrPng("vmess://short");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Buffer.isBuffer(res.png)).toBe(true);
      expect(res.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(res.png.length).toBeGreaterThan(0);
    }
  });

  it("rejects an empty payload with EMPTY (never throws)", async () => {
    expect(await generateQrPng("")).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("rejects an over-sized payload with TOO_LARGE and leaks no payload", async () => {
    const huge = "a".repeat(QR_MAX_PAYLOAD_BYTES + 1);
    const res = await generateQrPng(huge);
    expect(res).toEqual({ ok: false, reason: "TOO_LARGE" });
    // The typed reason carries NO copy of the payload.
    expect(JSON.stringify(res)).not.toContain("aaaa");
  });

  it("counts UTF-8 BYTES for the size guard (multi-byte chars)", async () => {
    // Each Persian char is 2 bytes in UTF-8; 760 chars = 1520 bytes > the cap.
    const persian = "ت".repeat(760);
    expect(Buffer.byteLength(persian, "utf8")).toBeGreaterThan(QR_MAX_PAYLOAD_BYTES);
    expect(await generateQrPng(persian)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });
});

describe("generateQrPng round-trip: decoded PNG equals the raw payload byte-for-byte (§10)", () => {
  it.each(PAYLOADS)("%s payload round-trips exactly", async (_name, payload) => {
    const res = await generateQrPng(payload);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const decoded = decodeQrPng(res.png);
    expect(decoded).toBe(payload);
  });

  it("HTML-sensitive characters are NEVER escaped or altered in the QR content", async () => {
    const payload = 'vless://x@h:443?p=<b>&q="v"&r=\'w\'&amp=&#name';
    const res = await generateQrPng(payload);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const decoded = decodeQrPng(res.png);
    expect(decoded).toBe(payload);
    // Explicitly: no HTML entity encoding crept in.
    expect(decoded).not.toContain("&lt;");
    expect(decoded).not.toContain("&amp;amp;");
    expect(decoded).toContain("<b>");
    expect(decoded).toContain('"v"');
  });
});

describe("generateQrPng writes NOTHING to disk (§2/§9)", () => {
  const SERVICE_SRC = fileURLToPath(new URL("../src/services/qr-code.service.ts", import.meta.url));

  it("the QR service uses the in-memory encoder only - no disk-writing API", () => {
    const src = readFileSync(SERVICE_SRC, "utf8");
    // The only encoder call is the in-memory toBuffer; the disk-writing qrcode
    // APIs and any raw fs write must be absent.
    expect(src).toContain("toBuffer");
    for (const forbidden of ["toFile", "toFileStream", "writeFile", "createWriteStream", "node:fs"]) {
      expect(src, `qr-code.service must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("generation creates no files in the working directory", async () => {
    const before = readdirSync(process.cwd()).sort();
    const res = await generateQrPng(`vmess://${"Z".repeat(200)}`);
    expect(res.ok).toBe(true);
    const after = readdirSync(process.cwd()).sort();
    expect(after).toEqual(before);
  });
});
