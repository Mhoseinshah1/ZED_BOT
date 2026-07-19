import { WALLET_AUTO_RENEWAL_ENABLED_KEY, errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  adminStopMandate,
  getAutoRenewalAdminStats,
  getMandateByShortIdForAdmin,
  listPausedMandatesForAdmin,
  mandateShortId,
  previewDueMandates,
  type AutoRenewalAdminStats,
} from "../../services/auto-renewal.service.js";
import { enqueueAutoRenewalScanNow, readWorkerHeartbeat } from "../../services/ops-queue.service.js";
import { compareAndSetBooleanSetting, clearSettingsCache } from "../../services/settings.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Wallet auto-renewal — ADMIN page (Phase 1). OWNER-only. The master switch is
// the ONLY thing an admin toggles; there is NO admin path that enables a user's
// mandate or raises an authorization (createMandate requires the user's own
// consent). Admins may PAUSE / CANCEL a mandate, run a dry-run preview of what
// the next scan would pick up (read-only), and trigger a manual scan.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

export const AR_ADMIN_CB = {
  root: "admin:war:root",
  enable: "admin:war:enable",
  disable: "admin:war:disable",
  preview: "admin:war:preview",
  paused: "admin:war:paused",
  scan: "admin:war:scan",
  mandate: (mid: string): string => `admin:war:m:${mid}`,
  pause: (mid: string): string => `admin:war:pause:${mid}`,
  cancel: (mid: string): string => `admin:war:cancel:${mid}`,
} as const;

export const autoRenewalAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function overviewText(stats: AutoRenewalAdminStats, workerAlive: boolean): string {
  return [
    "🔁 <b>تمدید خودکار (کیف پول)</b>",
    "",
    `وضعیت سامانه: ${stats.enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `ضربان کارگر: ${workerAlive ? "دریافت می‌شود ✅" : "دریافت نمی‌شود ⚠️"}`,
    "",
    "<b>مندیت‌ها:</b>",
    `فعال: ${stats.activeMandates}`,
    `متوقف: ${stats.pausedMandates}`,
    `لغوشده: ${stats.cancelledMandates}`,
    "",
    "<b>تلاش‌ها:</b>",
    `در جریان: ${stats.openAttempts}`,
    `موفق (۲۴ ساعت اخیر): ${stats.completedToday}`,
    `کمبود موجودی: ${stats.insufficientBalance}`,
    `نیازمند بررسی: ${stats.requiresAction}`,
    `ناموفق: ${stats.failed}`,
  ].join("\n");
}

function overviewKeyboard(stats: AutoRenewalAdminStats): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (stats.enabled) {
    kb.text("غیرفعال‌سازی سامانه ⛔", AR_ADMIN_CB.disable).row();
  } else {
    kb.text("فعال‌سازی سامانه ✅", AR_ADMIN_CB.enable).row();
  }
  kb.text("پیش‌نمایش تمدیدهای پیش‌رو 👁", AR_ADMIN_CB.preview).row();
  kb.text(`مندیت‌های متوقف (${stats.pausedMandates}) ⏸`, AR_ADMIN_CB.paused).row();
  kb.text("اجرای اسکن دستی ▶️", AR_ADMIN_CB.scan).row();
  kb.text("بروزرسانی ♻️", AR_ADMIN_CB.root).row();
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  const [stats, heartbeat] = await Promise.all([getAutoRenewalAdminStats(), readWorkerHeartbeat()]);
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, overviewText(stats, heartbeat !== null), overviewKeyboard(stats), {
    parseMode: "HTML",
  });
}

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await renderOverview(ctx);
  ctx.session.lastMenu = AR_ADMIN_CB.root;
});

// --- master switch (activation gate; disabling is always allowed) ------------

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.enable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // Activation gate: the worker must be alive, or nothing would ever scan /
  // execute and enabling would be a silent no-op.
  if ((await readWorkerHeartbeat()) === null) {
    await renderOverview(ctx, "فعال‌سازی انجام نشد: ضربان کارگر دریافت نمی‌شود.");
    return;
  }
  if (!(await compareAndSetBooleanSetting(WALLET_AUTO_RENEWAL_ENABLED_KEY, false, true))) {
    await renderOverview(ctx, "سامانه از قبل فعال است.");
    return;
  }
  clearSettingsCache();
  logger.info("wallet auto-renewal enabled", { adminId: admin.id });
  await renderOverview(ctx, "تمدید خودکار فعال شد ✅");
});

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.disable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const flipped = await compareAndSetBooleanSetting(WALLET_AUTO_RENEWAL_ENABLED_KEY, true, false);
  if (flipped) {
    clearSettingsCache();
    logger.info("wallet auto-renewal disabled", { adminId: admin.id });
  }
  await renderOverview(ctx, flipped ? "تمدید خودکار غیرفعال شد." : "سامانه از قبل غیرفعال است.");
});

// --- dry-run preview (read-only) ---------------------------------------------

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.preview, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const rows = await previewDueMandates(20);
  await safeAnswerCallback(ctx);
  const lines = [
    "👁 <b>پیش‌نمایش تمدیدهای پیش‌رو</b> (فقط نمایشی — هیچ برداشتی انجام نمی‌شود)",
    "",
    `تعداد در بازهٔ تمدید: ${rows.length}`,
    "",
  ];
  for (const row of rows.slice(0, 15)) {
    const when = row.expiresAt === null ? "-" : row.expiresAt.toISOString().slice(0, 10);
    lines.push(
      `• <code>${escapeHtml(row.username)}</code> — انقضا ${when} — سقف ${row.mandate.maximumChargeToman.toLocaleString("en-US")}`,
    );
  }
  if (rows.length === 0) {
    lines.push("موردی در بازهٔ تمدید وجود ندارد.");
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text("بازگشت", AR_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

// --- paused-mandate review + admin pause/cancel ------------------------------

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.paused, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const rows = await listPausedMandatesForAdmin(20);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(`${row.username} — ${row.mandate.pauseReason ?? "-"}`, AR_ADMIN_CB.mandate(mandateShortId(row.mandate))).row();
  }
  kb.text("بازگشت", AR_ADMIN_CB.root);
  await safeEditOrReply(
    ctx,
    rows.length === 0 ? "مندیت متوقفی برای بررسی وجود ندارد." : "⏸ مندیت‌های متوقف",
    kb,
  );
});

async function renderMandateAdmin(ctx: BotContext, shortId: string, toast?: string): Promise<void> {
  const mandate = await getMandateByShortIdForAdmin(shortId);
  if (mandate === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await safeAnswerCallback(ctx, toast);
  const lines = [
    "🔁 <b>مندیت تمدید خودکار</b>",
    "",
    `وضعیت: ${mandate.status}`,
    `علت توقف: ${mandate.pauseReason ?? "-"}`,
    `سقف مجاز: ${mandate.maximumChargeToman.toLocaleString("en-US")} تومان`,
    `تعداد شکست پیاپی: ${mandate.consecutiveFailureCount}`,
    `آخرین خطا: ${mandate.safeLastErrorCode ?? "-"}`,
  ];
  const mid = mandateShortId(mandate);
  const kb = new InlineKeyboard();
  if (mandate.status === "ACTIVE") {
    kb.text("توقف (ادمین) ⏸", AR_ADMIN_CB.pause(mid)).row();
  }
  if (mandate.status !== "CANCELLED") {
    kb.text("لغو (ادمین) ❌", AR_ADMIN_CB.cancel(mid)).row();
  }
  kb.text("بازگشت", AR_ADMIN_CB.paused);
  await safeEditOrReply(ctx, lines.join("\n"), kb, { parseMode: "HTML" });
}

autoRenewalAdminHandler.callbackQuery(/^admin:war:m:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await renderMandateAdmin(ctx, ctx.match[1]);
});

autoRenewalAdminHandler.callbackQuery(/^admin:war:pause:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const mandate = await getMandateByShortIdForAdmin(ctx.match[1]);
  if (mandate === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await adminStopMandate(mandate.id, false);
  logger.info("wallet auto-renewal mandate paused by admin", { adminId: admin.id, mandateId: mandate.id });
  await renderMandateAdmin(ctx, ctx.match[1], "مندیت متوقف شد ⏸");
});

autoRenewalAdminHandler.callbackQuery(/^admin:war:cancel:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const mandate = await getMandateByShortIdForAdmin(ctx.match[1]);
  if (mandate === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  await adminStopMandate(mandate.id, true);
  logger.info("wallet auto-renewal mandate cancelled by admin", { adminId: admin.id, mandateId: mandate.id });
  await renderMandateAdmin(ctx, ctx.match[1], "مندیت لغو شد ❌");
});

// --- manual scan -------------------------------------------------------------

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.scan, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  try {
    const ok = await enqueueAutoRenewalScanNow();
    logger.info("wallet auto-renewal manual scan requested", { adminId: admin.id, enqueued: ok });
    await renderOverview(ctx, ok ? "درخواست اسکن ارسال شد ▶️" : "ارسال درخواست اسکن ناموفق بود.");
  } catch (err) {
    logger.error("wallet auto-renewal manual scan failed", { error: errorMessage(err) });
    await renderOverview(ctx, "خطا در ارسال درخواست اسکن.");
  }
});
