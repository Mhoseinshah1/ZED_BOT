import { prisma, type ConnectionGuideApp, type Panel, type Service, type User } from "@zedbot/database";
import { CONNECTION_GUIDES_ENABLED_KEY, GUIDE_PLATFORM_CODE } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "guide-user-ui-tests-secret-0123456789";

import { initialSession } from "../src/core/session.js";
import { servicesHandler } from "../src/handlers/user-services/services.handler.js";
import {
  createGuideApp,
  invalidateGuideCache,
  setGuideAppActive,
  validateGuideAppInput,
} from "../src/services/connection-guide.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import { serviceShortId } from "../src/services/user-services.service.js";

// =============================================================================
// §6/§7/§8/§10/§11/§14 - the user connection-guide callbacks over a real DB.
// A captured fake ctx records edits/replies/toasts + the rendered keyboards so
// we can assert owner-scoping, the disabled fail-closed path, method rendering,
// that NO Service secret appears in guide text or callback data, and the safe
// support handoff.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const SUB_SECRET = "https://sub.example.com/SUBSCRIPTIONSECRET?token=DEADBEEF";
const CONFIG_SECRET = "vmess://CONFIGSECRETBASE64==";

interface Btn {
  text: string;
  data?: string;
  url?: string;
}
interface Captured {
  edits: Array<{ text: string; buttons: Btn[] }>;
  replies: Array<{ text: string; buttons: Btn[] }>;
  toasts: Array<string | undefined>;
  session: ReturnType<typeof initialSession>;
}

function flatButtons(markup: unknown): Btn[] {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) return [];
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }));
}

function fakeCtx(data: string, user: User | null, session = initialSession()) {
  const cap: Captured = { edits: [], replies: [], toasts: [], session };
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    session,
    dbUser: user,
    from: { id: 1, first_name: "T" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    match: undefined as unknown,
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.replies.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.edits.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
  };
  return { ctx: ctx as never, cap };
}

async function run(data: string, user: User | null, session = initialSession()): Promise<Captured> {
  const { ctx, cap } = fakeCtx(data, user, session);
  await servicesHandler.middleware()(ctx, async () => undefined);
  return cap;
}

/** Every callback string a rendered page emits, joined for secret scanning. */
function allCallbackData(cap: Captured): string {
  return [...cap.edits, ...cap.replies]
    .flatMap((m) => m.buttons.map((b) => b.data ?? b.url ?? ""))
    .join("\n");
}
function allText(cap: Captured): string {
  return [...cap.edits, ...cap.replies].map((m) => m.text).join("\n");
}

d("user connection-guide callbacks", () => {
  let panel: Panel;
  let owner: User;
  let stranger: User;
  let service: Service;
  let iosApp: ConnectionGuideApp;
  const iosCode = GUIDE_PLATFORM_CODE.IOS;

  async function makeApp(over: Record<string, unknown>): Promise<ConnectionGuideApp> {
    const v = validateGuideAppInput({
      platform: "IOS",
      displayName: "V2Box",
      iconEmoji: "📦",
      primaryDownloadUrl: "https://apps.apple.com/app/v2box",
      alternateDownloadUrl: null,
      supportsSubscription: true,
      supportsQr: true,
      supportsIndividualConfigs: true,
      instructions: "برنامه را نصب کنید، سپس لینک اشتراک را وارد نمایید.",
      troubleshooting: "اگر وصل نشد، سرور دیگری را امتحان کنید.",
      sortOrder: 0,
      ...over,
    });
    if (!v.ok) throw new Error("fixture invalid");
    return createGuideApp(v.value, "admin-test");
  }

  beforeAll(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `guide-ui-${runTag}`, baseUrl: "https://p.test", status: "ACTIVE", renewalEnabled: false },
    });
    owner = await prisma.user.create({ data: { telegramId: runTag + 1n } });
    stranger = await prisma.user.create({ data: { telegramId: runTag + 2n } });
    service = await prisma.service.create({
      data: {
        userId: owner.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `guide_acct_${runTag}`,
        status: "ACTIVE",
        volumeBytes: 0n,
        usedBytes: 0n,
        subscriptionUrl: SUB_SECRET,
        configLinks: [CONFIG_SECRET],
      },
    });
    iosApp = await makeApp({});
    await setGuideAppActive(iosApp.id, true, "admin-test");
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    invalidateGuideCache();
  });

  afterAll(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    await prisma.service.deleteMany({ where: { panelId: panel.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
    await prisma.panel.delete({ where: { id: panel.id } });
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    await prisma.$disconnect();
  });

  const sid = (): string => serviceShortId(service);

  it("platform page: owner sees only platforms with an active app", async () => {
    const cap = await run(`user:svc:guide:${sid()}`, owner);
    const labels = cap.edits.at(-1)?.buttons.map((b) => b.text) ?? [];
    expect(labels.some((l) => l.includes("آیفون"))).toBe(true);
    // No platform without an active app (e.g. Linux) is shown.
    expect(labels.some((l) => l.includes("لینوکس"))).toBe(false);
  });

  it("a STRANGER cannot open the guide (owner-scoped)", async () => {
    const cap = await run(`user:svc:guide:${sid()}`, stranger);
    expect(cap.toasts).toContain("مورد یافت نشد.");
    expect(cap.edits).toHaveLength(0);
  });

  it("fails CLOSED when the master switch is disabled", async () => {
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    const cap = await run(`user:svc:guide:${sid()}`, owner);
    expect(allText(cap)).toContain("در دسترس نیست");
    // Re-enable for the rest of the suite.
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
  });

  it("app page lists the active app; guide page shows method buttons + downloads + NO secret", async () => {
    const appPage = await run(`user:svc:guide:${sid()}:${iosCode}`, owner);
    expect(appPage.edits.at(-1)?.buttons.some((b) => b.text.includes("V2Box"))).toBe(true);

    const guide = await run(`user:svc:guide:${sid()}:${iosCode}:${iosApp.slug}`, owner);
    const buttons = guide.edits.at(-1)?.buttons ?? [];
    // Method buttons reuse the existing owner-scoped routes.
    expect(buttons.some((b) => b.data === `user:svc:link:${sid()}`)).toBe(true);
    expect(buttons.some((b) => b.data === `user:svc:qr_sub:${sid()}`)).toBe(true);
    expect(buttons.some((b) => b.data === `user:svc:configs:${sid()}`)).toBe(true);
    expect(buttons.some((b) => b.data === `user:svc:qr_configs:${sid()}`)).toBe(true);
    // Download is a validated HTTPS url button.
    const dl = buttons.find((b) => b.text.includes("دانلود برنامه"));
    expect(dl?.url).toBe("https://apps.apple.com/app/v2box");
    // NO Service secret in the text or in any callback/url.
    expect(allText(guide)).not.toContain("SUBSCRIPTIONSECRET");
    expect(allText(guide)).not.toContain("CONFIGSECRET");
    expect(allText(guide)).not.toContain("DEADBEEF");
    expect(allCallbackData(guide)).not.toContain("SUBSCRIPTIONSECRET");
    expect(allCallbackData(guide)).not.toContain("CONFIGSECRET");
    // The download URL never embeds a Service secret.
    expect(dl?.url).not.toContain("SUBSCRIPTIONSECRET");
  });

  it("every emitted guide callback is <= 64 bytes", async () => {
    const guide = await run(`user:svc:guide:${sid()}:${iosCode}:${iosApp.slug}`, owner);
    for (const b of guide.edits.at(-1)?.buttons ?? []) {
      if (b.data !== undefined) {
        expect(Buffer.byteLength(b.data, "utf8"), b.data).toBeLessThanOrEqual(64);
      }
    }
  });

  it("unsupported method is NOT offered (app without config support)", async () => {
    const subOnly = await makeApp({ displayName: "SubOnly", supportsIndividualConfigs: false });
    await setGuideAppActive(subOnly.id, true, "admin-test");
    invalidateGuideCache();
    const guide = await run(`user:svc:guide:${sid()}:${iosCode}:${subOnly.slug}`, owner);
    const buttons = guide.edits.at(-1)?.buttons ?? [];
    expect(buttons.some((b) => b.data === `user:svc:link:${sid()}`)).toBe(true);
    expect(buttons.some((b) => b.data === `user:svc:configs:${sid()}`)).toBe(false);
  });

  it("an inactive app fails safely (stale) and returns to the app list", async () => {
    const gone = await makeApp({ displayName: "Gone" });
    await setGuideAppActive(gone.id, true, "admin-test");
    invalidateGuideCache();
    await setGuideAppActive(gone.id, false, "admin-test"); // deactivated after render
    invalidateGuideCache();
    const cap = await run(`user:svc:guide:${sid()}:${iosCode}:${gone.slug}`, owner);
    expect(cap.toasts.some((t) => typeof t === "string" && t.includes("در دسترس نیست"))).toBe(true);
  });

  it("support handoff: seeds a SAFE ticket flow (no secret) and a cancel back to the guide", async () => {
    const session = initialSession();
    const cap = await run(`user:svc:gsup:${sid()}:${iosCode}:${iosApp.slug}`, owner, session);
    // Routed into the existing support MESSAGE flow with ids-only context.
    expect(session.currentFlow).toBe("support:message");
    expect(session.temp.guideSupportContext).toEqual({ sid: sid(), pcode: iosCode, slug: iosApp.slug });
    // Subject carries device+app but NEVER a secret.
    expect(session.temp.supportDraft?.subject).toBeDefined();
    expect(session.temp.supportDraft?.subject).not.toContain("SUBSCRIPTIONSECRET");
    // Cancel returns to the exact guide app page.
    const cancel = cap.edits.at(-1)?.buttons.find((b) => b.text.includes("بازگشت به راهنما"));
    expect(cancel?.data).toBe(`user:svc:guide:${sid()}:${iosCode}:${iosApp.slug}`);
    // No secret in the handoff prompt.
    expect(allText(cap)).not.toContain("SUBSCRIPTIONSECRET");
  });
});
