import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errorMessage, type NotificationWorkerStatus } from "@zedbot/shared";
import { Composer, InlineKeyboard, InputFile } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  buildAnalyticsCsv,
  getAnalyticsReport,
  type AnalyticsReport,
  type AnalyticsView,
} from "../../services/notification/analytics-report.service.js";
import {
  disableAnalytics,
  enableAnalytics,
  getAnalyticsReportingTimezone,
  getAnalyticsStartedAt,
  isAnalyticsEnabled,
  isCsvExportEnabled,
  setCsvExportEnabled,
} from "../../services/notification/analytics-settings.service.js";
import {
  enqueueAttributionBatchNow,
  pingOpsRedis,
  readNotificationWorkerStatus,
  readWorkerHeartbeat,
} from "../../services/ops-queue.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «تحلیل اعلان‌ها 📈» — the OWNER/admin analytics surface (Phase 4). Reads the
// evidence-backed conversion attribution and renders the delivery funnel, click-
// through, direct/assisted conversions and attributed gross/net revenue for a
// bounded, timezone-aware date range, in two labelled views (cohort / conversion
// timeline). OWNER-only actions: enable/disable analytics behind an activation
// gate, toggle CSV export, export an aggregate PII-free CSV, and trigger a manual
// attribution reconcile. Nothing here fabricates a metric — every number is a
// COUNT or a Toman SUM of recorded rows; no opens/reads/impressions, no profit.
// =============================================================================

const OWNER_ONLY_TEXT = "این عملیات فقط برای مالک مجموعه مجاز است.";
const CSV_DISABLED_TEXT = "خروجی CSV غیرفعال است؛ ابتدا آن را از تنظیمات تحلیل فعال کنید.";
const STATUS_FRESH_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;

const AN_CB = {
  root: CB.ADMIN_ANALYTICS,
  cfg: "admin:an:cfg",
  enable: "admin:an:enable",
  enableYes: "admin:an:enable_yes",
  disable: "admin:an:disable",
  csvToggle: "admin:an:csv_toggle",
  csv: "admin:an:csv",
  reconcile: "admin:an:reconcile",
  range: "admin:an:range",
} as const;

/** currentFlow value for the custom date-range text step. */
export const ANALYTICS_RANGE_FLOW = "admin_analytics:range";

export const analyticsHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

// --- date helpers (timezone-aware local calendar days) -----------------------

/** "YYYY-MM-DD" for `date` in the given timezone. */
function localDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Adds `n` whole days to a "YYYY-MM-DD" (calendar-safe). */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

const YYYYMMDD = (day: string): string => day.replace(/-/g, "");
const fromYYYYMMDD = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const viewCode = (view: AnalyticsView): string => (view === "cohort" ? "c" : "t");
const viewFromCode = (c: string): AnalyticsView => (c === "t" ? "conversion" : "cohort");

function overviewCb(view: AnalyticsView, startDay: string, endDay: string): string {
  return `admin:an:ov:${viewCode(view)}:${YYYYMMDD(startDay)}:${YYYYMMDD(endDay)}`;
}

async function defaultRange(): Promise<{ startDay: string; endDay: string }> {
  const tz = await getAnalyticsReportingTimezone();
  const endDay = localDay(new Date(), tz);
  return { startDay: addDays(endDay, -29), endDay };
}

// --- rendering ---------------------------------------------------------------

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}٪`;
}

function toman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function viewLabel(view: AnalyticsView): string {
  return view === "cohort" ? "کوهورت (بر پایه زمان ارسال)" : "تبدیل (بر پایه زمان خرید)";
}

function renderReportText(report: AnalyticsReport): string {
  const m = report.metrics;
  const lines: string[] = [
    "تحلیل اعلان‌ها 📈",
    "",
    `بازه: ${report.startDay} تا ${report.endDay} (${report.timezone})`,
    `نما: ${viewLabel(report.view)}`,
    "",
    "قیف تحویل:",
    `• تولیدشده: ${m.generated}`,
    `• ارسال‌شده: ${m.sent}`,
    `• ناموفق: ${m.failed} | نامه‌مرده: ${m.deadLetter}`,
    `• نرخ تحویل موفق: ${pct(m.deliverySuccessRate)}`,
    `• دارای تعامل (کلیک): ${m.sentWithInteraction}`,
    `• نرخ کلیک (CTR): ${pct(m.clickThroughRate)}`,
    "",
    "تبدیل‌های مبتنی بر شواهد:",
    `• تبدیل مستقیم پرداخت ناتمام: ${m.directCheckoutConversions}`,
    `• تبدیل مستقیم سرویس: ${m.directServiceConversions}`,
    `• تبدیل کمکی بازگشت مشتری: ${m.assistedWinbackConversions}`,
    `• مجموع تبدیل‌ها: ${m.totalConversions} (نرخ: ${pct(m.conversionRate)})`,
    "",
    "درآمد منتسب (نه سود):",
    `• ناخالص منتسب: ${toman(m.grossRevenueToman)}`,
    `• برگشت‌خورده: ${toman(m.reversedRevenueToman)}`,
    `• خالص منتسب: ${toman(m.netRevenueToman)}`,
  ];
  if (report.byType.length > 0) {
    lines.push("", "تفکیک بر اساس نوع اعلان:");
    for (const row of report.byType) {
      lines.push(
        `• ${row.type}: ارسال ${row.sent}، کلیک ${row.clicked}، تبدیل ${row.conversions}، خالص ${toman(row.netRevenueToman)}`,
      );
    }
  }
  return lines.join("\n");
}

async function overviewKeyboard(
  view: AnalyticsView,
  startDay: string,
  endDay: string,
  owner: boolean,
): Promise<InlineKeyboard> {
  const tz = await getAnalyticsReportingTimezone();
  const today = localDay(new Date(), tz);
  const other: AnalyticsView = view === "cohort" ? "conversion" : "cohort";
  const kb = new InlineKeyboard()
    .text(`نما: ${view === "cohort" ? "تبدیل ⇄" : "کوهورت ⇄"}`, overviewCb(other, startDay, endDay))
    .row()
    .text("۷ روز اخیر", overviewCb(view, addDays(today, -6), today))
    .text("۳۰ روز اخیر", overviewCb(view, addDays(today, -29), today))
    .row()
    .text("بازه دلخواه 📅", `${AN_CB.range}:${viewCode(view)}`)
    .row();
  if (owner && (await isCsvExportEnabled())) {
    kb.text("خروجی CSV 📄", `${AN_CB.csv}:${viewCode(view)}:${YYYYMMDD(startDay)}:${YYYYMMDD(endDay)}`).row();
  }
  if (owner) {
    kb.text("بروزرسانی انتساب‌ها 🔄", AN_CB.reconcile).row();
  }
  kb.text("تنظیمات تحلیل ⚙️", AN_CB.cfg).row().text("بازگشت", CB.ADMIN_REPORTS_BACKUP);
  return kb;
}

async function renderOverview(
  ctx: BotContext,
  view: AnalyticsView,
  startDay: string,
  endDay: string,
): Promise<void> {
  await safeAnswerCallback(ctx);
  if (!(await isAnalyticsEnabled())) {
    await renderConfig(ctx);
    return;
  }
  const result = await getAnalyticsReport(startDay, endDay, view);
  if (!result.ok) {
    await safeEditOrReply(
      ctx,
      "بازه تاریخ نامعتبر است. لطفاً یک بازه معتبر (حداکثر ۳۶۶ روز) انتخاب کنید.",
      new InlineKeyboard().text("بازگشت", AN_CB.root),
    );
    return;
  }
  const kb = await overviewKeyboard(view, startDay, endDay, isOwner(ctx));
  await safeEditOrReply(ctx, renderReportText(result.report), kb);
}

// --- config / activation -----------------------------------------------------

function isStatusFresh(status: NotificationWorkerStatus | null): boolean {
  if (status === null) {
    return false;
  }
  const at = Date.parse(status.checkedAt);
  return Number.isFinite(at) && Date.now() - at <= STATUS_FRESH_MS;
}

interface GateResult {
  ok: boolean;
  reason?: string;
}

/** Analytics activation gate: the worker must be alive + reporting to run the
 * attribution sweeps. Ordered; the first failure's Persian reason is returned. */
async function evaluateActivationGate(): Promise<GateResult> {
  if (!(await pingOpsRedis()).ok) {
    return { ok: false, reason: "اتصال به Redis برقرار نیست." };
  }
  if ((await readWorkerHeartbeat()) === null) {
    return { ok: false, reason: "ضربان کارگر (worker) دریافت نمی‌شود." };
  }
  if (!isStatusFresh(await readNotificationWorkerStatus())) {
    return { ok: false, reason: "گزارش وضعیت موتور اعلان‌ها تازه نیست." };
  }
  return { ok: true };
}

function formatInstant(when: Date | null): string {
  return when === null ? "هنوز فعال نشده" : `${when.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

async function renderConfig(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  const [enabled, csv, startedAt] = await Promise.all([
    isAnalyticsEnabled(),
    isCsvExportEnabled(),
    getAnalyticsStartedAt(),
  ]);
  const lines = [
    "تنظیمات تحلیل اعلان‌ها ⚙️",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ⛔️"}`,
    `شروع انتساب: ${formatInstant(startedAt)}`,
    `خروجی CSV: ${csv ? "فعال" : "غیرفعال"}`,
    "",
    "با فعال‌سازی، انتساب تبدیل از همین لحظه به بعد آغاز می‌شود (بدون بازگشت به گذشته).",
  ];
  const kb = new InlineKeyboard();
  if (enabled) {
    kb.text("گزارش تحلیل 📈", AN_CB.root).row();
    kb.text("غیرفعال‌سازی تحلیل ⛔️", AN_CB.disable).row();
    kb.text(csv ? "غیرفعال کردن خروجی CSV" : "فعال کردن خروجی CSV", AN_CB.csvToggle).row();
  } else {
    kb.text("فعال‌سازی تحلیل ✅", AN_CB.enable).row();
  }
  kb.text("بازگشت", CB.ADMIN_REPORTS_BACKUP);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

// --- landing (from the reports/backup menu) ----------------------------------

analyticsHandler.callbackQuery(AN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const { startDay, endDay } = await defaultRange();
  await renderOverview(ctx, "cohort", startDay, endDay);
  ctx.session.lastMenu = AN_CB.root;
});

analyticsHandler.callbackQuery(/^admin:an:ov:([ct]):(\d{8}):(\d{8})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const [, code, s, e] = ctx.match as RegExpMatchArray;
  await renderOverview(ctx, viewFromCode(code), fromYYYYMMDD(s), fromYYYYMMDD(e));
});

analyticsHandler.callbackQuery(AN_CB.cfg, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderConfig(ctx);
});

// --- activation (OWNER only) -------------------------------------------------

analyticsHandler.callbackQuery(AN_CB.enable, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const gate = await evaluateActivationGate();
  if (!gate.ok) {
    await safeAnswerCallback(ctx, "فعال‌سازی ممکن نیست.");
    await safeEditOrReply(
      ctx,
      `فعال‌سازی تحلیل ممکن نیست:\n${gate.reason ?? ""}`,
      new InlineKeyboard().text("تلاش دوباره", AN_CB.cfg),
    );
    return;
  }
  const startedAt = await enableAnalytics();
  logger.info("analytics enabled", { by: ctx.from?.id, startedAt: startedAt.toISOString() });
  await safeAnswerCallback(ctx, "تحلیل فعال شد ✅");
  await renderConfig(ctx);
});

analyticsHandler.callbackQuery(AN_CB.disable, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await disableAnalytics();
  logger.info("analytics disabled", { by: ctx.from?.id });
  await safeAnswerCallback(ctx, "تحلیل غیرفعال شد.");
  await renderConfig(ctx);
});

analyticsHandler.callbackQuery(AN_CB.csvToggle, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await setCsvExportEnabled(!(await isCsvExportEnabled()));
  await renderConfig(ctx);
});

// --- manual reconcile (OWNER only) -------------------------------------------

analyticsHandler.callbackQuery(AN_CB.reconcile, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  if (!(await isAnalyticsEnabled())) {
    await safeAnswerCallback(ctx, "تحلیل فعال نیست.");
    return;
  }
  const queued = await enqueueAttributionBatchNow();
  await safeAnswerCallback(ctx, queued ? "بروزرسانی انتساب‌ها در صف قرار گرفت 🔄" : "صف در دسترس نیست.");
});

// --- CSV export (OWNER only, gated on the export switch) ---------------------

analyticsHandler.callbackQuery(/^admin:an:csv:([ct]):(\d{8}):(\d{8})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  if (!(await isCsvExportEnabled())) {
    await safeAnswerCallback(ctx, CSV_DISABLED_TEXT);
    return;
  }
  const [, code, s, e] = ctx.match as RegExpMatchArray;
  const view = viewFromCode(code);
  const startDay = fromYYYYMMDD(s);
  const endDay = fromYYYYMMDD(e);
  const result = await getAnalyticsReport(startDay, endDay, view);
  if (!result.ok) {
    await safeAnswerCallback(ctx, "بازه نامعتبر است.");
    return;
  }
  await safeAnswerCallback(ctx, "در حال ساخت فایل CSV… 📄");
  await sendCsv(ctx, result.report);
});

async function sendCsv(ctx: BotContext, report: AnalyticsReport): Promise<void> {
  const csv = buildAnalyticsCsv(report);
  // A safe temp file: non-guessable name in the OS temp dir, mode 0600, removed
  // in finally. The visible filename carries only the (non-PII) date range.
  const path = join(tmpdir(), `zedbot-analytics-${randomUUID()}.csv`);
  const visibleName = `analytics-${report.startDay}-to-${report.endDay}-${report.view}.csv`;
  try {
    await writeFile(path, csv, { encoding: "utf8", mode: 0o600 });
    await ctx.replyWithDocument(new InputFile(path, visibleName));
  } catch (err) {
    logger.warn("analytics csv send failed", { error: errorMessage(err) });
    await safeReply(ctx, "ساخت یا ارسال فایل CSV ناموفق بود.");
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

// --- custom date-range text flow ---------------------------------------------

analyticsHandler.callbackQuery(/^admin:an:range:([ct])$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const view = viewFromCode((ctx.match as RegExpMatchArray)[1]);
  ctx.session.currentFlow = ANALYTICS_RANGE_FLOW;
  ctx.session.temp.adminAnalyticsDraft = { view };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "بازه تاریخ را به صورت زیر ارسال کنید (میلادی):\n\nYYYY-MM-DD YYYY-MM-DD\n\nمثال: 2026-06-01 2026-06-30",
    new InlineKeyboard().text("انصراف", AN_CB.root),
  );
});

const RANGE_RE = /(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/;

export const analyticsTextHandler = new Composer<BotContext>();

analyticsTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== ANALYTICS_RANGE_FLOW) {
    return next();
  }
  const draft = ctx.session.temp.adminAnalyticsDraft;
  const view: AnalyticsView = draft?.view ?? "cohort";
  ctx.session.currentFlow = null;
  ctx.session.temp.adminAnalyticsDraft = undefined;

  const m = RANGE_RE.exec(ctx.message.text.trim());
  if (m === null) {
    await safeReply(ctx, "قالب بازه نامعتبر است. نمونه: 2026-06-01 2026-06-30");
    return;
  }
  const result = await getAnalyticsReport(m[1], m[2], view);
  if (!result.ok) {
    await safeReply(ctx, "بازه نامعتبر است (حداکثر ۳۶۶ روز و شروع پیش از پایان).");
    return;
  }
  const kb = await overviewKeyboard(view, result.report.startDay, result.report.endDay, isOwner(ctx));
  await safeReply(ctx, renderReportText(result.report), kb);
});
