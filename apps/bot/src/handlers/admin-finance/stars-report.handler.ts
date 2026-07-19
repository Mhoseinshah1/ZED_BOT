import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard, InputFile } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  REPORT_RANGE_LABEL,
  type ReportRange,
} from "../../services/admin-financial-report.service.js";
import {
  buildStarsReportCsv,
  getStarsSubscriptionReport,
  type StarsSubscriptionReport,
} from "../../services/admin-stars-report.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «گزارش مالی اشتراک‌های Stars ⭐» — admin-only READ-ONLY reporting UI for the
// Telegram Stars subscription financials, kept SEPARATE from the Toman «گزارش
// مالی 📊». Ranged aggregate (امروز / ۷ روز اخیر / ۳۰ روز اخیر / همه زمان‌ها),
// all amounts in STARS (never converted to Toman), with an OWNER-only aggregate,
// PII-free CSV export. Nothing here mutates a financial row.
// =============================================================================

const OWNER_ONLY_TEXT = "تنها مالک ربات به این بخش دسترسی دارد.";
const DEFAULT_RANGE: ReportRange = "30d";

const SR_CB = {
  root: "admin:starsrep:root",
  range: (range: ReportRange): string => `admin:starsrep:r:${range}`,
  csv: (range: ReportRange): string => `admin:starsrep:csv:${range}`,
  // The Stars subscription admin dashboard (sibling handler).
  back: "admin:starsub:root",
} as const;

export const starsReportHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function renderText(report: StarsSubscriptionReport, range: ReportRange): string {
  return [
    `گزارش مالی اشتراک‌های Stars ⭐ (${REPORT_RANGE_LABEL[range]})`,
    "",
    "پرداخت اولیه اشتراک:",
    `${report.initialCount}`,
    "",
    "پرداخت دوره‌ای:",
    `${report.recurringCount}`,
    "",
    "استار دریافتی ناخالص:",
    `${report.grossStars}`,
    "",
    "استار بازپرداخت‌شده:",
    `${report.refundedStars}`,
    "",
    "استار خالص:",
    `${report.netStars}`,
    "",
    "تمدید تکمیل‌شده:",
    `${report.completedRenewals}`,
    "",
    "نیازمند بررسی:",
    `${report.requiresAction}`,
    "",
    "بازپرداخت در انتظار:",
    `${report.refundPending}`,
    "",
    "مبالغ بر حسب استار هستند.",
  ].join("\n");
}

function buildKeyboard(range: ReportRange, owner: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("امروز", SR_CB.range("today"))
    .text("۷ روز اخیر", SR_CB.range("7d"))
    .row()
    .text("۳۰ روز اخیر", SR_CB.range("30d"))
    .text("همه زمان‌ها", SR_CB.range("all"))
    .row();
  if (owner) {
    kb.text("خروجی CSV 📄", SR_CB.csv(range)).row();
  }
  kb.text("بازگشت", SR_CB.back);
  return kb;
}

async function render(ctx: BotContext, range: ReportRange): Promise<void> {
  const report = await getStarsSubscriptionReport(range);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, renderText(report, range), buildKeyboard(range, isOwner(ctx)));
}

starsReportHandler.callbackQuery(SR_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await render(ctx, DEFAULT_RANGE);
});

starsReportHandler.callbackQuery(/^admin:starsrep:r:(today|7d|30d|all)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await render(ctx, ctx.match[1] as ReportRange);
});

starsReportHandler.callbackQuery(/^admin:starsrep:csv:(today|7d|30d|all)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const range = ctx.match[1] as ReportRange;
  const report = await getStarsSubscriptionReport(range);
  await safeAnswerCallback(ctx, "در حال ساخت فایل CSV… 📄");
  await sendCsv(ctx, report, range);
});

async function sendCsv(
  ctx: BotContext,
  report: StarsSubscriptionReport,
  range: ReportRange,
): Promise<void> {
  const csv = buildStarsReportCsv(report, REPORT_RANGE_LABEL[range]);
  // A safe temp file: non-guessable name in the OS temp dir, mode 0600, removed
  // in finally. The visible filename carries only the (non-PII) range key.
  const path = join(tmpdir(), `zedbot-stars-report-${randomUUID()}.csv`);
  const visibleName = `stars-report-${range}.csv`;
  try {
    await writeFile(path, csv, { encoding: "utf8", mode: 0o600 });
    await ctx.replyWithDocument(new InputFile(path, visibleName));
  } catch (err) {
    logger.warn("stars report csv send failed", { error: errorMessage(err) });
    await safeReply(ctx, "ساخت یا ارسال فایل CSV ناموفق بود.");
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
