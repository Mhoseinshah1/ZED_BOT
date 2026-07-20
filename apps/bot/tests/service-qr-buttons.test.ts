import type { Service } from "@zedbot/database";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "service-qr-buttons-tests-01";

import { serviceDetailKeyboard, svcCb } from "../src/handlers/user-services/service-views.js";

// =============================================================================
// §3 - the QR buttons are ADDITIVE and render ONLY when their stored payload
// exists. The copyable text buttons («لینک اشتراک 🔗» / «کانفیگ‌ها 📄») are never
// replaced. Pure view test over fabricated Service rows (no DB).
// =============================================================================

function fakeService(overrides: Partial<Record<string, unknown>> = {}): Service {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "zed_acct_01",
    productNameSnapshot: "پلن طلایی",
    panelNameSnapshot: "پنل آلمان",
    panelType: "MARZBAN",
    serviceLocation: "MULTI_LOCATION",
    status: "ACTIVE",
    volumeBytes: 0n,
    usedBytes: 0n,
    remainingBytes: 0n,
    durationDays: 30,
    startsAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    lastConnectedAt: null,
    lastSubscriptionUpdateAt: null,
    remoteClientId: null,
    remoteMetadata: null,
    namingStrategySnapshot: null,
    subscriptionUrl: null,
    subscriptionToken: null,
    configLinks: [],
    note: null,
    ...overrides,
  } as unknown as Service;
}

function buttons(service: Service): Array<{ text: string; data: string }> {
  return serviceDetailKeyboard(service)
    .inline_keyboard.flat()
    .filter((b) => "callback_data" in b)
    .map((b) => ({ text: b.text, data: (b as { callback_data: string }).callback_data }));
}

const sid = "abcdef12";

describe("QR buttons render only when the payload exists (§3)", () => {
  it("hides BOTH QR buttons when neither a subscription nor configs are stored", () => {
    const b = buttons(fakeService());
    expect(b.some((x) => x.text === "QR اشتراک 📷")).toBe(false);
    expect(b.some((x) => x.text === "QR کانفیگ‌ها 📷")).toBe(false);
  });

  it("shows «QR اشتراک 📷» (next to the text link) when subscriptionUrl exists", () => {
    const b = buttons(fakeService({ subscriptionUrl: "https://sub.example.com/s" }));
    const link = b.find((x) => x.text === "لینک اشتراک 🔗");
    const qr = b.find((x) => x.text === "QR اشتراک 📷");
    expect(link?.data).toBe(svcCb.link(sid)); // text link unchanged/kept
    expect(qr?.data).toBe(svcCb.qrSub(sid));
    // The config QR stays hidden (no configs).
    expect(b.some((x) => x.text === "QR کانفیگ‌ها 📷")).toBe(false);
  });

  it("shows «QR کانفیگ‌ها 📷» (next to the text configs) when configLinks exist", () => {
    const b = buttons(fakeService({ configLinks: ["vmess://a"] }));
    const cfg = b.find((x) => x.text === "کانفیگ‌ها 📄");
    const qr = b.find((x) => x.text === "QR کانفیگ‌ها 📷");
    expect(cfg?.data).toBe(svcCb.configs(sid)); // text configs unchanged/kept
    expect(qr?.data).toBe(svcCb.qrConfigs(sid));
    expect(b.some((x) => x.text === "QR اشتراک 📷")).toBe(false);
  });

  it("shows all four buttons (both text + both QR) when both payloads exist", () => {
    const b = buttons(fakeService({ subscriptionUrl: "https://s", configLinks: ["vmess://a", "vless://b"] }));
    for (const text of ["لینک اشتراک 🔗", "QR اشتراک 📷", "کانفیگ‌ها 📄", "QR کانفیگ‌ها 📷"]) {
      expect(b.some((x) => x.text === text), `missing button: ${text}`).toBe(true);
    }
  });

  it("ignores malformed (non-string) config entries when deciding the QR button", () => {
    // Only malformed entries -> serviceConfigLinks() is empty -> no config QR.
    const b = buttons(fakeService({ configLinks: [123, null, { x: 1 }] as unknown as string[] }));
    expect(b.some((x) => x.text === "QR کانفیگ‌ها 📷")).toBe(false);
  });
});
