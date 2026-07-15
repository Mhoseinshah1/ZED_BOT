import type { Service } from "@zedbot/database";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "service-account-display-tests-01";

import {
  serviceAccountLabel,
  serviceDetailText,
  serviceListKeyboard,
  svcCb,
  UNNAMED_SERVICE_TEXT,
} from "../src/handlers/user-services/service-views.js";
import type { ServiceListPage } from "../src/services/user-services.service.js";

// =============================================================================
// Account-display tests: «سرویس‌های من» shows the VPN ACCOUNT username (the
// identity created on the panel), never product names or volume/duration
// specs; the detail header leads with the same identity; callbacks stay
// unchanged; secrets (XUI uuid, subscription tokens) never render.
// Pure view tests - fabricated Service rows, no DB.
// =============================================================================

const XUI_SECRET_UUID = "3f2c8a44-secret-uuid-000000000001";

function fakeService(overrides: Partial<Record<string, unknown>> = {}): Service {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "zed_8709144284_01",
    productNameSnapshot: "پلن طلایی",
    panelNameSnapshot: "پنل آلمان",
    panelType: "MARZBAN",
    serviceLocation: "MULTI_LOCATION",
    status: "ACTIVE",
    volumeBytes: 20n * 1024n * 1024n * 1024n,
    usedBytes: 1n * 1024n * 1024n * 1024n,
    remainingBytes: 19n * 1024n * 1024n * 1024n,
    durationDays: 20,
    startsAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    lastConnectedAt: null,
    lastSubscriptionUpdateAt: null,
    remoteClientId: XUI_SECRET_UUID,
    remoteMetadata: null,
    namingStrategySnapshot: null,
    subscriptionUrl: "https://example.com/sub/secret-token",
    subscriptionToken: "secret-sub-token",
    configLinks: [],
    note: null,
    ...overrides,
  } as unknown as Service;
}

function page(services: Service[]): ServiceListPage {
  return { services, page: 1, pages: 1, total: services.length };
}

function buttons(services: Service[]): Array<{ text: string; data: string }> {
  return serviceListKeyboard(page(services))
    .inline_keyboard.flat()
    .filter((b) => "callback_data" in b)
    .map((b) => ({ text: b.text, data: (b as { callback_data: string }).callback_data }));
}

describe("My Services list shows the ACCOUNT username (1-5)", () => {
  it("1. the list button is the remote username + status emoji", () => {
    const rows = buttons([fakeService()]);
    expect(rows[0].text).toBe("zed_8709144284_01 ✅");
  });

  it("2. a Marzban service shows its Marzban username", () => {
    const service = fakeService({ panelType: "MARZBAN", username: "vpn_test_12345" });
    expect(serviceAccountLabel(service)).toBe("vpn_test_12345");
    expect(buttons([service])[0].text).toBe("vpn_test_12345 ✅");
  });

  it("3. an XUI service shows its global-client identity (username = client email)", () => {
    const service = fakeService({ panelType: "XUI", username: "shop_42" });
    expect(serviceAccountLabel(service)).toBe("shop_42");
    // With an (abnormal) empty username, the sync-refreshed stored client
    // email is the identity - never the uuid, never the product.
    const emptied = fakeService({
      panelType: "XUI",
      username: "  ",
      remoteMetadata: { subId: "sub-42", clients: [{ email: "shop_42", inboundIds: [1] }] },
    });
    expect(serviceAccountLabel(emptied)).toBe("shop_42");
  });

  it("4. the product name is NEVER used - even when the username is missing", () => {
    const service = fakeService({ productNameSnapshot: "Ultra VPN Germany" });
    expect(buttons([service])[0].text).not.toContain("Ultra VPN Germany");
    const nameless = fakeService({
      username: "",
      remoteMetadata: null,
      productNameSnapshot: "Ultra VPN Germany",
    });
    expect(serviceAccountLabel(nameless)).toBe(UNNAMED_SERVICE_TEXT);
    expect(serviceAccountLabel(nameless)).not.toContain("Ultra");
  });

  it("5. the volume/duration spec formatter is gone from the title", () => {
    const label = buttons([fakeService()])[0].text;
    for (const forbidden of ["GB", "گیگ", "روز", "نامحدود", "|", "پلن طلایی"]) {
      expect(label, `list title must not contain: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("fallback, detail header, callbacks, secrets (6-9)", () => {
  it("6. a service with no stored identity shows the safe fallback", () => {
    const nameless = fakeService({ username: "", remoteMetadata: null });
    expect(serviceAccountLabel(nameless)).toBe(UNNAMED_SERVICE_TEXT);
    expect(UNNAMED_SERVICE_TEXT).toBe("سرویس بدون نام");
    expect(buttons([nameless])[0].text).toContain(UNNAMED_SERVICE_TEXT);
  });

  it("7. existing callbacks remain unchanged (view + pagination shapes)", () => {
    const service = fakeService();
    const rows = buttons([service]);
    expect(rows[0].data).toBe(svcCb.view(service.id.slice(0, 8)));
    expect(rows[0].data).toBe("user:svc:view:abcdef12");
    const paged = serviceListKeyboard({
      services: [service],
      page: 2,
      pages: 3,
      total: 11,
    });
    const data = paged.inline_keyboard
      .flat()
      .filter((b) => "callback_data" in b)
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(data).toContain("user:svc:list:1");
    expect(data).toContain("user:svc:list:3");
  });

  it("8. the detail header leads with the account username; specs stay separate fields", () => {
    const text = serviceDetailText(fakeService());
    const [firstLine] = text.split("\n");
    expect(firstLine).toBe("نام سرویس: <code>zed_8709144284_01</code>");
    // Specs render as their own fields, not as the title.
    expect(text).toContain("ترافیک کل: 20 گیگابایت");
    expect(text).toContain("مدت: 20 روز");
    expect(text).toContain("وضعیت: فعال ✅");
    // The old product-name header is gone (the info field remains below).
    expect(text).not.toContain("🛍 <b>");
  });

  it("9. secrets never render: uuid, subscription token, panel data stay hidden", () => {
    const text = serviceDetailText(fakeService());
    const label = buttons([fakeService()])[0].text;
    for (const secret of [XUI_SECRET_UUID, "secret-sub-token"]) {
      expect(text).not.toContain(secret);
      expect(label).not.toContain(secret);
    }
  });
});
