import { prisma, type Service } from "@zedbot/database";
import { CONNECTION_GUIDES_ENABLED_KEY } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "guide-detail-pp-tests-secret-0123456789";

import { serviceDetailKeyboard } from "../src/handlers/user-services/service-views.js";
import {
  createGuideApp,
  invalidateGuideCache,
  setGuideAppActive,
  validateGuideAppInput,
} from "../src/services/connection-guide.service.js";
import { deliverPostPurchaseGuideEntry } from "../src/services/order-fulfillment.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// §7/§15 - the service-detail «آموزش اتصال 📱» entry button (rendered only when
// the async gate passed → `guide` non-null) and the fail-soft post-purchase
// guide entry (button-only, gated by the same visibility, never throws).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

function fakeService(over: Partial<Record<string, unknown>> = {}): Service {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "acct_01",
    productNameSnapshot: null,
    panelNameSnapshot: null,
    panelType: "MARZBAN",
    serviceLocation: "MULTI_LOCATION",
    status: "ACTIVE",
    volumeBytes: 0n,
    usedBytes: 0n,
    remainingBytes: 0n,
    durationDays: 30,
    startsAt: new Date(),
    expiresAt: null,
    createdAt: new Date(),
    lastConnectedAt: null,
    lastSubscriptionUpdateAt: null,
    remoteClientId: null,
    remoteMetadata: null,
    namingStrategySnapshot: null,
    subscriptionUrl: "https://s",
    subscriptionToken: null,
    configLinks: [],
    note: null,
    ...over,
  } as unknown as Service;
}

function buttons(kb: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }) {
  return kb.inline_keyboard.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

describe("service-detail guide entry button (§7, pure)", () => {
  it("hides «آموزش اتصال 📱» when the gate is not passed (guide=null)", () => {
    const b = buttons(serviceDetailKeyboard(fakeService()));
    expect(b.some((x) => x.text.includes("آموزش اتصال"))).toBe(false);
  });
  it("shows «آموزش اتصال 📱» (routing to the guide) when the gate passed", () => {
    const b = buttons(serviceDetailKeyboard(fakeService(), undefined, { label: "آموزش اتصال 📱" }));
    const guide = b.find((x) => x.text === "آموزش اتصال 📱");
    expect(guide?.data).toBe("user:svc:guide:abcdef12");
  });
});

d("post-purchase guide entry (§15, DB-backed)", () => {
  function recordApi(opts: { fails?: boolean } = {}) {
    const messages: Array<{ text: string; buttons: string[] }> = [];
    const api = {
      sendMessage: async (_c: string, text: string, other?: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } }) => {
        if (opts.fails === true) throw new Error("blocked");
        messages.push({
          text,
          buttons: (other?.reply_markup?.inline_keyboard ?? []).flat().map((x) => x.text),
        });
        return {};
      },
    };
    return { api, messages };
  }

  beforeAll(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    const v = validateGuideAppInput({
      platform: "ANDROID",
      displayName: "v2rayNG",
      iconEmoji: "🤖",
      primaryDownloadUrl: "https://play.google.com/store/apps/details?id=x",
      alternateDownloadUrl: null,
      supportsSubscription: true,
      supportsQr: true,
      supportsIndividualConfigs: true,
      instructions: "برنامه را نصب کنید و لینک را وارد نمایید.",
      troubleshooting: "",
      sortOrder: 0,
    });
    if (!v.ok) throw new Error("fixture");
    const app = await createGuideApp(v.value, "admin-test");
    await setGuideAppActive(app.id, true, "admin-test");
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    invalidateGuideCache();
  });

  afterAll(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("sends a button-only entry that opens the new service's guide", async () => {
    const rec = recordApi();
    await deliverPostPurchaseGuideEntry(rec.api, "111", fakeService({ id: `${runTag}aaaa-0000-0000-0000-000000000000` }));
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0].buttons.some((t) => t.includes("آموزش اتصال"))).toBe(true);
  });

  it("is fail-soft: a Telegram send failure never throws", async () => {
    const rec = recordApi({ fails: true });
    await expect(
      deliverPostPurchaseGuideEntry(rec.api, "111", fakeService()),
    ).resolves.toBeUndefined();
  });

  it("sends nothing when the master switch is disabled", async () => {
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    const rec = recordApi();
    await deliverPostPurchaseGuideEntry(rec.api, "111", fakeService());
    expect(rec.messages).toHaveLength(0);
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
  });

  it("sends nothing when the service has no connection payload", async () => {
    const rec = recordApi();
    await deliverPostPurchaseGuideEntry(rec.api, "111", fakeService({ subscriptionUrl: null, configLinks: [] }));
    expect(rec.messages).toHaveLength(0);
  });
});
