import { prisma, type Admin } from "@zedbot/database";
import { CONNECTION_GUIDES_ENABLED_KEY, GUIDE_PAGE_TEXT_MAX, GUIDE_PLATFORM_CODE } from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "guide-admin-tests-secret-0123456789";

import { logger } from "../src/core/logger.js";
import { initialSession } from "../src/core/session.js";
import {
  deviceGuidesHandler,
  deviceGuidesTextHandler,
} from "../src/handlers/admin-settings/device-guides.handler.js";
import {
  DEV_GUIDE_CB,
  devGuidePreviewText,
  GUIDE_EDIT_FIELDS,
  GUIDE_METHOD_CODES,
} from "../src/handlers/admin-settings/device-guides-views.js";
import { getBooleanSetting, clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import * as systemLog from "../src/services/system-log.service.js";

// =============================================================================
// §18/§19/§21 - OWNER admin: non-OWNER denied, the create wizard, per-field
// validation (bad URL / empty name), the enable readiness gate, disable, archive,
// and that audit events carry NO secret or full URL. Real DB, captured fake ctx.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

interface Cap {
  edits: string[];
  replies: string[];
  toasts: Array<string | undefined>;
  session: ReturnType<typeof initialSession>;
  admin: Admin | null;
}

function makeCap(admin: Admin | null): Cap {
  return { edits: [], replies: [], toasts: [], session: initialSession(), admin };
}

function ctxFor(cap: Cap, opts: { data?: string; text?: string }) {
  const callbackQuery =
    opts.data === undefined
      ? undefined
      : {
          id: "cbq",
          chat_instance: "ci",
          from: { id: 9, is_bot: false, first_name: "A" },
          data: opts.data,
          message: { message_id: 5, date: 0, chat: { id: 9, type: "private" } },
        };
  const message =
    opts.text === undefined
      ? undefined
      : { message_id: 6, date: 0, text: opts.text, chat: { id: 9, type: "private" }, from: { id: 9, is_bot: false, first_name: "A" } };
  return {
    session: cap.session,
    admin: cap.admin,
    dbUser: null,
    from: { id: 9, first_name: "A" },
    callbackQuery,
    message,
    update: {
      update_id: 1,
      ...(callbackQuery === undefined ? {} : { callback_query: callbackQuery }),
      ...(message === undefined ? {} : { message }),
    },
    match: undefined as unknown,
    reply: async (t: string) => {
      cap.replies.push(t);
      return {};
    },
    editMessageText: async (t: string) => {
      cap.edits.push(t);
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
  } as never;
}

async function cb(cap: Cap, data: string): Promise<void> {
  await deviceGuidesHandler.middleware()(ctxFor(cap, { data }), async () => undefined);
}
async function text(cap: Cap, value: string): Promise<void> {
  await deviceGuidesTextHandler.middleware()(ctxFor(cap, { text: value }), async () => undefined);
}

describe("admin preview text (pure)", () => {
  it("clamps a fully-populated preview to Telegram's message limit", () => {
    const app = {
      displayName: "PreviewApp",
      iconEmoji: "📦",
      instructions: "a<&d ".repeat(600), // 3000 chars incl. HTML-special chars
      troubleshooting: "x>y&z ".repeat(300), // 1800 chars
      supportsSubscription: true,
      supportsIndividualConfigs: true,
      supportsQr: true,
    } as never;
    const text = devGuidePreviewText(app);
    expect(text.length).toBeLessThanOrEqual(GUIDE_PAGE_TEXT_MAX);
    // No dangling/partial HTML entity at the truncation point.
    expect(/&[^;]{0,9}$/.test(text)).toBe(false);
  });
});

d("device-guide OWNER admin", () => {
  let owner: Admin;
  let support: Admin;
  const iosCode = GUIDE_PLATFORM_CODE.IOS;

  beforeAll(async () => {
    owner = await prisma.admin.create({ data: { telegramId: runTag + 1n, role: "OWNER", isActive: true } });
    support = await prisma.admin.create({ data: { telegramId: runTag + 2n, role: "SUPPORT", isActive: true } });
  });

  beforeEach(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
  });

  afterAll(async () => {
    await prisma.connectionGuideApp.deleteMany({});
    await prisma.admin.deleteMany({ where: { id: { in: [owner.id, support.id] } } });
    await setSetting(CONNECTION_GUIDES_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("a non-OWNER admin cannot open or mutate the panel", async () => {
    const cap = makeCap(support);
    await cb(cap, DEV_GUIDE_CB.root);
    expect(cap.toasts).toContain("این بخش فقط برای مالک ربات در دسترس است.");
    expect(cap.edits).toHaveLength(0);
    await cb(cap, DEV_GUIDE_CB.add(iosCode));
    expect(cap.session.currentFlow).toBeNull(); // no wizard started
  });

  async function createValidApp(cap: Cap): Promise<void> {
    await cb(cap, DEV_GUIDE_CB.add(iosCode));
    await text(cap, "V2Box");
    await text(cap, "https://apps.apple.com/app/v2box");
    await text(cap, "برنامه را نصب کنید و لینک اشتراک را وارد نمایید.");
  }

  it("the create wizard builds an inactive app; a bad URL is rejected mid-wizard", async () => {
    const cap = makeCap(owner);
    await cb(cap, DEV_GUIDE_CB.add(iosCode));
    await text(cap, "V2Box");
    await text(cap, "http://insecure.example.com"); // non-https -> rejected, stays on the step
    expect(cap.replies.some((r) => r.includes("نامعتبر"))).toBe(true);
    await text(cap, "https://apps.apple.com/app/v2box");
    await text(cap, "برنامه را نصب کنید و لینک اشتراک را وارد نمایید.");
    const apps = await prisma.connectionGuideApp.findMany({ where: { platform: "IOS" } });
    expect(apps).toHaveLength(1);
    expect(apps[0].isActive).toBe(false); // created inactive
    expect(apps[0].primaryDownloadUrl).toBe("https://apps.apple.com/app/v2box");
  });

  it("an empty name is rejected in the create wizard", async () => {
    const cap = makeCap(owner);
    await cb(cap, DEV_GUIDE_CB.add(iosCode));
    await text(cap, " ");
    expect(cap.replies.some((r) => r.includes("نامعتبر"))).toBe(true);
    expect(await prisma.connectionGuideApp.count()).toBe(0);
  });

  it("editing the primary URL to a non-https value is rejected", async () => {
    const cap = makeCap(owner);
    await createValidApp(cap);
    const app = await prisma.connectionGuideApp.findFirstOrThrow({ where: { platform: "IOS" } });
    const short = app.id.slice(0, 8);
    await cb(cap, DEV_GUIDE_CB.edit(short, GUIDE_EDIT_FIELDS.primary));
    await text(cap, "javascript:alert(1)");
    expect(cap.replies.some((r) => r.includes("نامعتبر"))).toBe(true);
    const after = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.primaryDownloadUrl).toBe("https://apps.apple.com/app/v2box"); // unchanged
  });

  it("the enable gate blocks incomplete config and passes once an app is active+valid", async () => {
    const cap = makeCap(owner);
    // No active app -> enable shows the readiness report, never flips the switch.
    await cb(cap, DEV_GUIDE_CB.enable);
    expect(await getBooleanSetting(CONNECTION_GUIDES_ENABLED_KEY, false)).toBe(false);
    // Create + activate a valid app, then enable.
    await createValidApp(cap);
    const app = await prisma.connectionGuideApp.findFirstOrThrow({ where: { platform: "IOS" } });
    await cb(cap, DEV_GUIDE_CB.toggleConfirm(app.id.slice(0, 8), true));
    await cb(cap, DEV_GUIDE_CB.enableYes);
    clearSettingsCache();
    expect(await getBooleanSetting(CONNECTION_GUIDES_ENABLED_KEY, false)).toBe(true);
    // Disabling stays available and never deletes config.
    await cb(cap, DEV_GUIDE_CB.disableYes);
    clearSettingsCache();
    expect(await getBooleanSetting(CONNECTION_GUIDES_ENABLED_KEY, false)).toBe(false);
    expect(await prisma.connectionGuideApp.count()).toBe(1);
  });

  it("archive is soft (row retained, deactivated, hidden from active reads)", async () => {
    const cap = makeCap(owner);
    await createValidApp(cap);
    const app = await prisma.connectionGuideApp.findFirstOrThrow({ where: { platform: "IOS" } });
    await cb(cap, DEV_GUIDE_CB.archiveYes(app.id.slice(0, 8)));
    const after = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.archivedAt).not.toBeNull(); // retained for audit
    expect(after.isActive).toBe(false);
    // A stale activation callback after archive must NOT reactivate the (now
    // invisible) row — the admin lookup excludes archived records.
    await cb(cap, DEV_GUIDE_CB.toggleConfirm(app.id.slice(0, 8), true));
    const stale = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(stale.isActive).toBe(false);
    expect(stale.archivedAt).not.toBeNull();
  });

  it("the sort-order edit rejects a partially-numeric value like '12abc'", async () => {
    const cap = makeCap(owner);
    await createValidApp(cap);
    const app = await prisma.connectionGuideApp.findFirstOrThrow({ where: { platform: "IOS" } });
    const short = app.id.slice(0, 8);
    await cb(cap, DEV_GUIDE_CB.edit(short, GUIDE_EDIT_FIELDS.sort));
    await text(cap, "12abc"); // Number.parseInt would accept "12" — must be rejected.
    expect(cap.replies.some((r) => r.includes("نامعتبر"))).toBe(true);
    const unchanged = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(unchanged.sortOrder).toBe(app.sortOrder);
    // A clean integer is accepted.
    await cb(cap, DEV_GUIDE_CB.edit(short, GUIDE_EDIT_FIELDS.sort));
    await text(cap, "7");
    const after = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(after.sortOrder).toBe(7);
  });

  it("cannot toggle OFF the last connection method of an ACTIVE app", async () => {
    const cap = makeCap(owner);
    await createValidApp(cap); // all three methods on, inactive
    const app = await prisma.connectionGuideApp.findFirstOrThrow({ where: { platform: "IOS" } });
    const short = app.id.slice(0, 8);
    await cb(cap, DEV_GUIDE_CB.toggleConfirm(short, true)); // activate
    // Turn off two of three — allowed while one remains.
    await cb(cap, DEV_GUIDE_CB.method(short, GUIDE_METHOD_CODES.subscription));
    await cb(cap, DEV_GUIDE_CB.method(short, GUIDE_METHOD_CODES.qr));
    let now = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(now.supportsSubscription).toBe(false);
    expect(now.supportsQr).toBe(false);
    expect(now.supportsIndividualConfigs).toBe(true);
    // Turning off the LAST method on an active app is blocked (would be NO_METHOD).
    cap.toasts.length = 0;
    await cb(cap, DEV_GUIDE_CB.method(short, GUIDE_METHOD_CODES.configs));
    expect(cap.toasts.some((t) => typeof t === "string" && t.includes("غیرفعال کنید"))).toBe(true);
    now = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(now.supportsIndividualConfigs).toBe(true); // unchanged
    // Once deactivated, reaching zero methods is allowed.
    await cb(cap, DEV_GUIDE_CB.toggleConfirm(short, false));
    await cb(cap, DEV_GUIDE_CB.method(short, GUIDE_METHOD_CODES.configs));
    now = await prisma.connectionGuideApp.findUniqueOrThrow({ where: { id: app.id } });
    expect(now.supportsIndividualConfigs).toBe(false);
  });

  it("paginates the admin platform list so a large app count can't overflow", async () => {
    const cap = makeCap(owner);
    // Create 10 IOS apps (> GUIDE_ADMIN_PAGE_SIZE = 8).
    for (let i = 0; i < 10; i += 1) {
      await prisma.connectionGuideApp.create({
        data: {
          slug: `pg-${i}-${runTag}`,
          platform: "IOS",
          displayName: `App ${i}`,
          iconEmoji: "📦",
          primaryDownloadUrl: "https://apps.apple.com/app/x",
          alternateDownloadUrl: null,
          supportsSubscription: true,
          supportsQr: true,
          supportsIndividualConfigs: true,
          instructions: "برنامه را نصب کنید و لینک را وارد نمایید.",
          troubleshooting: "",
          isActive: false,
          sortOrder: i,
        },
      });
    }
    // Page 1 of 2.
    await cb(cap, DEV_GUIDE_CB.platform(iosCode));
    expect(cap.edits.at(-1)).toContain("صفحه 1 از 2");
    // Page 2 of 2.
    await cb(cap, DEV_GUIDE_CB.platform(iosCode, 1));
    expect(cap.edits.at(-1)).toContain("صفحه 2 از 2");
  });

  it("audit events carry NO secret or full download URL", async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(systemLog, "writeSystemLog")
      .mockImplementation(async (args: unknown) => {
        logged.push(JSON.stringify(args));
      });
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation((m: string, meta?: unknown) => {
        logged.push(`${m} ${JSON.stringify(meta ?? {})}`);
      });
    }
    const cap = makeCap(owner);
    await cb(cap, DEV_GUIDE_CB.add(iosCode));
    await text(cap, "SecretlyNamedApp");
    await text(cap, "https://downloads.example.com/SECRETDOWNLOADPATH");
    await text(cap, "این متن آموزش محرمانه است و نباید در لاگ بیاید.");
    const blob = logged.join("\n");
    expect(blob).not.toContain("SECRETDOWNLOADPATH");
    expect(blob).not.toContain("محرمانه");
    expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
