import {
  AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES,
  NOTIF_AUTO_RENEWAL_UPCOMING_TEMPLATE_KEY,
  WALLET_AUTO_RENEWAL_ENABLED_KEY,
  errorMessage,
} from "@zedbot/shared";
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
  previewPrechargeNotices,
  setPrechargeNoticeMinutes,
  type AutoRenewalAdminStats,
} from "../../services/auto-renewal.service.js";
import { normalizeDigits } from "../../services/free-trial-admin.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { enqueueAutoRenewalScanNow, readWorkerHeartbeat } from "../../services/ops-queue.service.js";
import { compareAndSetBooleanSetting, clearSettingsCache } from "../../services/settings.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

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
  // Pre-charge notice settings (Corrective Phase, Parts P/Q).
  notice: "admin:war:notice",
  noticePreset: (minutes: number): string => `admin:war:np:${minutes}`,
  noticeCustom: "admin:war:ncustom",
  noticePreview: "admin:war:npreview",
  noticeTest: "admin:war:ntest",
} as const;

/** Notice-window presets (minutes): ۶/۱۲/۲۴/۴۸ ساعت + غیرفعال. */
const NOTICE_PRESETS: { label: string; minutes: number }[] = [
  { label: "۶ ساعت", minutes: 360 },
  { label: "۱۲ ساعت", minutes: 720 },
  { label: "۲۴ ساعت", minutes: 1440 },
  { label: "۴۸ ساعت", minutes: 2880 },
  { label: "غیرفعال", minutes: 0 },
];

/** Latin -> Persian digits for user-facing counts. */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

function noticeWindowLabel(minutes: number): string {
  if (minutes <= 0) return "غیرفعال";
  if (minutes % 1440 === 0) return `${faDigits(minutes / 1440)} روز`;
  if (minutes % 60 === 0) return `${faDigits(minutes / 60)} ساعت`;
  return `${faDigits(minutes)} دقیقه`;
}

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
  kb.text(
    `اعلان پیش از کسر: ${noticeWindowLabel(stats.prechargeNoticeMinutes)} ⏰`,
    AR_ADMIN_CB.notice,
  ).row();
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

// --- pre-charge notice settings (Corrective Phase, Parts P/Q) ----------------

function noticeSettingsText(stats: AutoRenewalAdminStats): string {
  return [
    "⏰ <b>اعلان پیش از کسر خودکار</b>",
    "",
    `پنجرهٔ فعلی: ${noticeWindowLabel(stats.prechargeNoticeMinutes)}`,
    "",
    "این اعلان پیش از برداشت خودکار از کیف پول برای کاربر ارسال می‌شود. مقدار «غیرفعال» فقط همین اعلان را خاموش می‌کند و پیام‌های موفقیت/کمبود موجودی/تغییر قیمت را تغییر نمی‌دهد.",
    "",
    "<b>وضعیت اعلان‌ها:</b>",
    `زمان‌بندی‌شده: ${faDigits(stats.noticesScheduled)}`,
    `ارسال‌شده (۲۴ ساعت اخیر): ${faDigits(stats.noticesSentToday)}`,
    `ناموفق: ${faDigits(stats.noticesFailed)}`,
    `منقضی: ${faDigits(stats.noticesExpired)}`,
  ].join("\n");
}

function noticeSettingsKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const preset of NOTICE_PRESETS) {
    const mark = preset.minutes === current ? "✅ " : "";
    kb.text(`${mark}${preset.label}`, AR_ADMIN_CB.noticePreset(preset.minutes)).row();
  }
  kb.text("مقدار دلخواه (دقیقه) ✏️", AR_ADMIN_CB.noticeCustom).row();
  kb.text("پیش‌نمایش اعلان‌های پیش‌رو 👁", AR_ADMIN_CB.noticePreview).row();
  kb.text("ارسال آزمایشی به من 📨", AR_ADMIN_CB.noticeTest).row();
  kb.text("بازگشت", AR_ADMIN_CB.root);
  return kb;
}

async function renderNoticeSettings(ctx: BotContext, toast?: string): Promise<void> {
  const stats = await getAutoRenewalAdminStats();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, noticeSettingsText(stats), noticeSettingsKeyboard(stats.prechargeNoticeMinutes), {
    parseMode: "HTML",
  });
}

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.notice, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = null;
  await renderNoticeSettings(ctx);
});

autoRenewalAdminHandler.callbackQuery(/^admin:war:np:(\d{1,6})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const minutes = Number.parseInt(ctx.match[1], 10);
  const ok = await setPrechargeNoticeMinutes(minutes);
  if (ok) {
    logger.info("wallet auto-renewal precharge notice minutes changed", { adminId: admin.id, minutes });
  }
  await renderNoticeSettings(ctx, ok ? "پنجرهٔ اعلان به‌روزرسانی شد ✅" : "مقدار نامعتبر است.");
});

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.noticeCustom, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = "war:notice-minutes";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `عدد پنجرهٔ اعلان را بر حسب دقیقه ارسال کنید (۰ برای غیرفعال، حداکثر ${faDigits(AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES)}).`,
    new InlineKeyboard().text("بازگشت", AR_ADMIN_CB.notice),
  );
});

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.noticePreview, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const rows = await previewPrechargeNotices(20);
  await safeAnswerCallback(ctx);
  const lines = [
    "👁 <b>پیش‌نمایش اعلان‌های پیش‌رو</b> (فقط نمایشی — هیچ اعلانی ساخته نمی‌شود)",
    "",
    `تعداد: ${faDigits(rows.length)}`,
    "",
  ];
  for (const row of rows.slice(0, 15)) {
    const noticeAt = row.prechargeNoticeAt === null ? "-" : row.prechargeNoticeAt.toISOString().slice(0, 16).replace("T", " ");
    const chargeAt = row.expectedChargeAt === null ? "-" : row.expectedChargeAt.toISOString().slice(0, 16).replace("T", " ");
    const kindFa = row.kind === "catch-up" ? "فوری" : "زمان‌بندی‌شده";
    lines.push(`• <code>${escapeHtml(row.username)}</code> — ${kindFa} — اعلان ${noticeAt} — کسر ${chargeAt}`);
  }
  if (rows.length === 0) {
    lines.push("موردی برای اعلان پیش‌رو وجود ندارد.");
  }
  await safeEditOrReply(ctx, lines.join("\n"), new InlineKeyboard().text("بازگشت", AR_ADMIN_CB.notice), {
    parseMode: "HTML",
  });
});

autoRenewalAdminHandler.callbackQuery(AR_ADMIN_CB.noticeTest, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // Render the ACTUAL template with example values and send it to the admin — a
  // faithful preview of the delivered message. Creates NO notification, moves no
  // money, touches no mandate. Buttons are omitted (a real notice resolves live).
  const text = await getMessageTemplate(NOTIF_AUTO_RENEWAL_UPCOMING_TEMPLATE_KEY, undefined, {
    service_name: "نمونه سرویس",
    product_name: "پلن نمونه",
    current_price: 120000,
    maximum_charge: 150000,
    expected_charge_time: new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 16).replace("T", " "),
    service_expiry: new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 16).replace("T", " "),
  });
  await safeAnswerCallback(ctx, "پیام آزمایشی ارسال شد 📨");
  await safeReply(ctx, `📨 نمونهٔ اعلان پیش از کسر:\n\n${text}`);
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

// --- custom notice-minutes text entry (self-gating on currentFlow) -----------

export const autoRenewalAdminTextHandler = new Composer<BotContext>();

autoRenewalAdminTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "war:notice-minutes") {
    return next();
  }
  if (ctx.admin === null || ctx.admin.role !== "OWNER") {
    ctx.session.currentFlow = null;
    return next();
  }
  const raw = normalizeDigits(ctx.message.text.trim());
  const minutes = Number.parseInt(raw, 10);
  if (!/^\d{1,6}$/.test(raw) || !Number.isInteger(minutes)) {
    await safeReply(ctx, "لطفاً فقط یک عدد صحیح (دقیقه) ارسال کنید.");
    return;
  }
  const ok = await setPrechargeNoticeMinutes(minutes);
  ctx.session.currentFlow = null;
  if (!ok) {
    await safeReply(
      ctx,
      `مقدار نامعتبر است. عددی بین ۰ و ${faDigits(AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES)} ارسال کنید.`,
    );
    return;
  }
  logger.info("wallet auto-renewal precharge notice minutes changed (custom)", {
    adminId: ctx.admin.id,
    minutes,
  });
  const stats = await getAutoRenewalAdminStats();
  await safeReply(ctx, noticeSettingsText(stats), noticeSettingsKeyboard(stats.prechargeNoticeMinutes), {
    parseMode: "HTML",
  });
});
