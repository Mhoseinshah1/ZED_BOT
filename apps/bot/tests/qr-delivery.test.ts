import { afterEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "qr-delivery-tests-secret-0123456789";

import { logger } from "../src/core/logger.js";
import { QR_MAX_PAYLOAD_BYTES } from "../src/services/qr-code.service.js";
import {
  CONFIG_QR_FILENAME,
  configFailureSummary,
  configOverflowSummary,
  configQrCaption,
  deliverConfigQrCodes,
  deliverSubscriptionQr,
  MAX_CONFIG_QRS,
  SUBSCRIPTION_QR_FILENAME,
  subscriptionQrCaption,
  type QrPhotoSender,
} from "../src/services/qr-delivery.service.js";
import { decodeQrPng } from "./helpers/qr-decode.js";

// =============================================================================
// §3/§5/§8/§10 - the bounded, fail-soft QR delivery layer. A recording sender
// decodes each sent PNG so we can prove the EXACT raw payload was encoded, in the
// original order, one QR per config, bounded to 10, with safe captions - and that
// the raw payloads NEVER appear in a log.
// =============================================================================

function recordingSender() {
  const sent: Array<{ decoded: string | null; caption: string; filename: string }> = [];
  const sender: QrPhotoSender = async ({ png, caption, filename }) => {
    sent.push({ decoded: decodeQrPng(png), caption, filename });
    return true;
  };
  return { sent, sender };
}

/** A sender that reports every Telegram send as failed (fail-soft path). */
const failingSender: QrPhotoSender = async () => false;

describe("captions + summaries carry only public labels/counts (§4/§5)", () => {
  it("subscription caption is the fixed label + account identity", () => {
    expect(subscriptionQrCaption("acct_1")).toBe("کیوآرکد لینک اشتراک\nنام سرویس: acct_1");
  });
  it("config caption is the position + account identity", () => {
    expect(configQrCaption(2, 5, "acct_1")).toBe("کانفیگ 2 از 5\nنام سرویس: acct_1");
  });
  it("overflow summary states 10 shown + the remaining count, leaking nothing", () => {
    expect(configOverflowSummary(3)).toBe("۱۰ کانفیگ اول به‌صورت QR ارسال شد.\n3 کانفیگ دیگر نمایش داده نشد.");
  });
  it("failure summary states only a count", () => {
    expect(configFailureSummary(2)).toBe("ساخت کیوآرکد 2 کانفیگ ممکن نشد؛ لینک متنی همچنان قابل استفاده است.");
  });
});

describe("deliverSubscriptionQr (§4)", () => {
  it("encodes the EXACT subscription URL and reports SENT", async () => {
    const url = "https://sub.example.com/s?token=ab<c>&x=%D8%AA#f";
    const rec = recordingSender();
    const outcome = await deliverSubscriptionQr(url, "acct_1", rec.sender);
    expect(outcome).toBe("SENT");
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0].decoded).toBe(url);
    expect(rec.sent[0].filename).toBe(SUBSCRIPTION_QR_FILENAME);
    expect(rec.sent[0].caption).toBe(subscriptionQrCaption("acct_1"));
  });

  it("reports GEN_FAILED without sending when the payload is unencodable (too large)", async () => {
    const rec = recordingSender();
    const outcome = await deliverSubscriptionQr("a".repeat(QR_MAX_PAYLOAD_BYTES + 1), "acct_1", rec.sender);
    expect(outcome).toBe("GEN_FAILED");
    expect(rec.sent).toHaveLength(0);
  });

  it("reports SEND_FAILED when Telegram rejects the photo (fail-soft)", async () => {
    expect(await deliverSubscriptionQr("https://sub.example.com/s", "acct_1", failingSender)).toBe("SEND_FAILED");
  });
});

describe("deliverConfigQrCodes - one QR per config, ordered, bounded (§5)", () => {
  it("one config produces exactly one QR carrying that config", async () => {
    const rec = recordingSender();
    const result = await deliverConfigQrCodes(["vmess://only-one"], "acct_1", rec.sender);
    expect(result).toMatchObject({ total: 1, attempted: 1, sent: 1, genFailed: 0, sendFailed: 0, skipped: 0 });
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0].decoded).toBe("vmess://only-one");
    expect(rec.sent[0].filename).toBe(CONFIG_QR_FILENAME);
  });

  it("multiple configs produce ORDERED individual QRs (never one joined QR)", async () => {
    const links = ["vmess://a", "vless://b", "trojan://c"];
    const rec = recordingSender();
    const result = await deliverConfigQrCodes(links, "acct_1", rec.sender);
    expect(result).toMatchObject({ total: 3, attempted: 3, sent: 3 });
    expect(rec.sent.map((s) => s.decoded)).toEqual(links); // exact order, exact payloads
    expect(rec.sent.map((s) => s.caption)).toEqual([
      configQrCaption(1, 3, "acct_1"),
      configQrCaption(2, 3, "acct_1"),
      configQrCaption(3, 3, "acct_1"),
    ]);
    // No QR contains more than its single config.
    for (let i = 0; i < links.length; i += 1) {
      for (let j = 0; j < links.length; j += 1) {
        if (i !== j) expect(rec.sent[i].decoded).not.toContain(links[j]);
      }
    }
  });

  it("bounds delivery to the first MAX_CONFIG_QRS and reports the skipped count", async () => {
    const links = Array.from({ length: 13 }, (_, i) => `vmess://cfg-${i}`);
    const rec = recordingSender();
    const result = await deliverConfigQrCodes(links, "acct_1", rec.sender);
    expect(MAX_CONFIG_QRS).toBe(10);
    expect(result).toMatchObject({ total: 13, attempted: 10, sent: 10, skipped: 3 });
    expect(rec.sent).toHaveLength(10);
    expect(rec.sent.map((s) => s.decoded)).toEqual(links.slice(0, 10));
  });

  it("HTML-sensitive config characters stay byte-identical inside the QR", async () => {
    const links = ['vless://x@h:443?p=<b>&q="v"#n', "vmess://plain"];
    const rec = recordingSender();
    await deliverConfigQrCodes(links, "acct_1", rec.sender);
    expect(rec.sent[0].decoded).toBe(links[0]);
  });

  it("a single unencodable config is counted and skipped; the rest still send", async () => {
    const links = ["vmess://ok-1", "a".repeat(QR_MAX_PAYLOAD_BYTES + 1), "vmess://ok-2"];
    const rec = recordingSender();
    const result = await deliverConfigQrCodes(links, "acct_1", rec.sender);
    expect(result).toMatchObject({ total: 3, attempted: 3, sent: 2, genFailed: 1, sendFailed: 0 });
    expect(rec.sent.map((s) => s.decoded)).toEqual(["vmess://ok-1", "vmess://ok-2"]);
  });

  it("Telegram send failures are counted fail-soft, never thrown", async () => {
    const result = await deliverConfigQrCodes(["vmess://a", "vmess://b"], "acct_1", failingSender);
    expect(result).toMatchObject({ attempted: 2, sent: 0, sendFailed: 2, genFailed: 0 });
  });
});

describe("QR delivery NEVER logs raw payloads (§8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no subscription URL / config string / caption appears in any log call", async () => {
    const logged: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation((msg: string, meta?: unknown) => {
        logged.push(`${msg} ${JSON.stringify(meta ?? {})}`);
      });
    }
    const subUrl = "https://SECRET-sub.example.com/token/DEADBEEF";
    const configs = ["vmess://SECRET-CONFIG-AAAA", "vless://SECRET-CONFIG-BBBB"];
    const rec = recordingSender();
    await deliverSubscriptionQr(subUrl, "acct_secret_label", rec.sender);
    await deliverConfigQrCodes(configs, "acct_secret_label", rec.sender);

    const blob = logged.join("\n");
    expect(blob).not.toContain("SECRET-sub");
    expect(blob).not.toContain("DEADBEEF");
    expect(blob).not.toContain("SECRET-CONFIG");
    // The QR image bytes never get logged either.
    expect(blob).not.toContain("PNG");
  });
});
