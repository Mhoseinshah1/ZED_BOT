import { prisma, type Admin } from "@zedbot/database";
import { NOTIF_ANALYTICS_STARTED_AT_KEY } from "@zedbot/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "analytics-ui-tests-secret-0123456789";

import {
  analyticsHandler,
  analyticsTextHandler,
} from "../src/handlers/admin-reports-backup/analytics.handler.js";
import {
  disableAnalytics,
  enableAnalytics,
  getAnalyticsStartedAt,
  isAnalyticsEnabled,
  isCsvExportEnabled,
} from "../src/services/notification/analytics-settings.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Analytics admin UI (real DB, fake grammY ctx) + the settings service. Covers
// the enable/disable activation (started-at stamped ONCE), the OWNER-only guards
// on every mutation + CSV export, the disabled -> config redirect, the report
// render, the view toggle, the CSV-disabled gate, and the date-range text flow.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

interface Captured {
  edits: string[];
  replies: string[];
  toasts: Array<string | undefined>;
  documents: number;
}

function fakeCtx(
  data: string,
  opts: { admin?: Admin | null; text?: string; flow?: string; draft?: unknown } = {},
) {
  const cap: Captured = { edits: [], replies: [], toasts: [], documents: 0 };
  const isText = opts.text !== undefined;
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const message = {
    message_id: 6, date: 0, text: opts.text ?? "",
    from: { id: 1, is_bot: false, first_name: "T" }, chat: { id: 1, type: "private" },
  };
  const update = isText ? { update_id: 1, message } : { update_id: 1, callback_query: callbackQuery };
  const ctx = {
    session: {
      temp: opts.draft !== undefined ? { adminAnalyticsDraft: opts.draft } : {},
      currentFlow: opts.flow ?? null,
      lastMenu: undefined,
    },
    admin: opts.admin ?? null,
    from: { id: 1, first_name: "T" },
    callbackQuery: isText ? undefined : callbackQuery,
    message: isText ? message : undefined,
    update,
    match: undefined as unknown,
    reply: async (t: string) => {
      cap.replies.push(t);
      return {};
    },
    editMessageText: async (t: string) => {
      cap.edits.push(t);
      return {};
    },
    editMessageReplyMarkup: async () => ({}),
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
    replyWithDocument: async () => {
      cap.documents += 1;
      return {};
    },
    api: { sendMessage: async () => ({}) },
  };
  return { ctx: ctx as never, cap };
}

const rendered = (cap: Captured): string => [...cap.edits, ...cap.replies].join("\n");
const admin = (role: "OWNER" | "SUPPORT"): Admin =>
  ({ id: `admin-${role}-${runTag}`, role }) as unknown as Admin;

async function runCb(data: string, opts: Parameters<typeof fakeCtx>[1]) {
  const h = fakeCtx(data, opts);
  await analyticsHandler.middleware()(h.ctx, async () => undefined);
  return h;
}
async function runText(text: string, opts: Parameters<typeof fakeCtx>[1]) {
  const h = fakeCtx("", { ...opts, text });
  await analyticsTextHandler.middleware()(h.ctx, async () => undefined);
  return h;
}

async function setEnabled(on: boolean): Promise<void> {
  await setSetting("notification_analytics_enabled", on ? "true" : "false", "BOOLEAN");
}
async function setCsv(on: boolean): Promise<void> {
  await setSetting("notification_analytics_csv_export_enabled", on ? "true" : "false", "BOOLEAN");
}

d("analytics settings service", () => {
  beforeEach(async () => {
    clearSettingsCache();
    await prisma.setting.deleteMany({ where: { key: NOTIF_ANALYTICS_STARTED_AT_KEY } });
    await setEnabled(false);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stamps started_at exactly ONCE across repeated enables (no backfill horizon change)", async () => {
    const first = await enableAnalytics(new Date(Date.UTC(2026, 5, 1)));
    expect(await isAnalyticsEnabled()).toBe(true);
    const second = await enableAnalytics(new Date(Date.UTC(2026, 7, 1)));
    expect(second.getTime()).toBe(first.getTime()); // never moved
  });

  it("disable preserves the start horizon; re-enable keeps it", async () => {
    const started = await enableAnalytics(new Date(Date.UTC(2026, 5, 1)));
    await disableAnalytics();
    expect(await isAnalyticsEnabled()).toBe(false);
    expect((await getAnalyticsStartedAt())?.getTime()).toBe(started.getTime());
    await enableAnalytics(new Date(Date.UTC(2026, 9, 1)));
    expect((await getAnalyticsStartedAt())?.getTime()).toBe(started.getTime());
  });
});

d("analytics admin UI", () => {
  beforeEach(async () => {
    clearSettingsCache();
    await setEnabled(true);
    await setCsv(false);
    await prisma.setting.upsert({
      where: { key: NOTIF_ANALYTICS_STARTED_AT_KEY },
      create: { key: NOTIF_ANALYTICS_STARTED_AT_KEY, value: new Date(Date.UTC(2026, 0, 1)).toISOString(), type: "STRING" },
      update: { value: new Date(Date.UTC(2026, 0, 1)).toISOString() },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("renders the analytics overview when enabled", async () => {
    const { cap } = await runCb("admin:analytics", { admin: admin("OWNER") });
    expect(rendered(cap)).toContain("تحلیل اعلان‌ها");
  });

  it("redirects to the config page when analytics is disabled", async () => {
    await setEnabled(false);
    const { cap } = await runCb("admin:analytics", { admin: admin("OWNER") });
    expect(rendered(cap)).toContain("تنظیمات تحلیل");
  });

  it("blocks enable for a non-OWNER admin", async () => {
    await setEnabled(false);
    const { cap } = await runCb("admin:an:enable", { admin: admin("SUPPORT") });
    expect(cap.toasts.join(" ")).toContain("مالک");
    expect(await isAnalyticsEnabled()).toBe(false);
  });

  it("blocks enable behind the activation gate when the worker is not reporting", async () => {
    await setEnabled(false);
    const { cap } = await runCb("admin:an:enable", { admin: admin("OWNER") });
    // No live worker/Redis in the test -> gate fails, analytics stays off.
    expect(await isAnalyticsEnabled()).toBe(false);
    expect(rendered(cap)).toContain("ممکن نیست");
  });

  it("OWNER can disable analytics", async () => {
    const { cap } = await runCb("admin:an:disable", { admin: admin("OWNER") });
    expect(await isAnalyticsEnabled()).toBe(false);
    expect(rendered(cap)).toContain("تنظیمات تحلیل");
  });

  it("OWNER can toggle CSV export; a non-OWNER cannot", async () => {
    await runCb("admin:an:csv_toggle", { admin: admin("OWNER") });
    expect(await isCsvExportEnabled()).toBe(true);
    const { cap } = await runCb("admin:an:csv_toggle", { admin: admin("SUPPORT") });
    expect(cap.toasts.join(" ")).toContain("مالک");
    expect(await isCsvExportEnabled()).toBe(true); // unchanged by the non-owner
  });

  it("refuses CSV export while the export switch is off", async () => {
    await setCsv(false);
    const { cap } = await runCb("admin:an:csv:c:20260101:20260131", { admin: admin("OWNER") });
    expect(cap.documents).toBe(0);
    expect(cap.toasts.join(" ")).toContain("CSV");
  });

  it("exports a CSV document for an OWNER when the switch is on", async () => {
    await setCsv(true);
    const { cap } = await runCb("admin:an:csv:c:20260101:20260131", { admin: admin("OWNER") });
    expect(cap.documents).toBe(1);
  });

  it("refuses CSV export for a non-OWNER even when enabled", async () => {
    await setCsv(true);
    const { cap } = await runCb("admin:an:csv:c:20260101:20260131", { admin: admin("SUPPORT") });
    expect(cap.documents).toBe(0);
    expect(cap.toasts.join(" ")).toContain("مالک");
  });

  it("renders the overview under the conversion-timeline view toggle", async () => {
    const { cap } = await runCb("admin:an:ov:t:20260101:20260131", { admin: admin("OWNER") });
    expect(rendered(cap)).toContain("تبدیل");
  });

  it("blocks the manual reconcile for a non-OWNER", async () => {
    const { cap } = await runCb("admin:an:reconcile", { admin: admin("SUPPORT") });
    expect(cap.toasts.join(" ")).toContain("مالک");
  });

  it("date-range text flow rejects a malformed range", async () => {
    const { cap } = await runText("not a date", {
      admin: admin("OWNER"),
      flow: "admin_analytics:range",
      draft: { view: "cohort" },
    });
    expect(rendered(cap)).toContain("نامعتبر");
  });

  it("date-range text flow renders a report for a valid range", async () => {
    const { cap } = await runText("2026-01-01 2026-01-31", {
      admin: admin("OWNER"),
      flow: "admin_analytics:range",
      draft: { view: "cohort" },
    });
    expect(rendered(cap)).toContain("تحلیل اعلان‌ها");
  });

  it("ignores text when no analytics range flow is active", async () => {
    let passed = false;
    const h = fakeCtx("", { admin: admin("OWNER"), text: "2026-01-01 2026-01-31" });
    await analyticsTextHandler.middleware()(h.ctx, async () => {
      passed = true;
    });
    expect(passed).toBe(true);
    expect(rendered(h.cap)).toBe("");
  });
});
