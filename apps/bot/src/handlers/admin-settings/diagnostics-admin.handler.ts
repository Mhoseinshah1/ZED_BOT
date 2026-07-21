import { clampEscapedText } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import {
  compareAndSetServiceDiagnosticsEnabled,
  diagnosticsCooldownSeconds,
  diagnosticsRecentConnectionHours,
  isServiceDiagnosticsEnabled,
  resetDiagnosticsCooldown,
  resetDiagnosticsRecentConnectionHours,
  setDiagnosticsCooldownSeconds,
  setDiagnosticsRecentConnectionHours,
} from "../../services/service-diagnostics-settings.service.js";
import {
  countDiagnosticsPanelSupport,
  diagnosticCheckMessage,
  diagnosticEvidenceLabel,
  diagnosticOverallLabel,
  diagnosticsEventCounts,
  DIAGNOSTIC_EVENTS,
  getServiceByShortIdForAdmin,
  runServiceDiagnostics,
} from "../../services/service-diagnostics.service.js";
import { clearSettingsCache } from "../../services/settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Service self-diagnostics — OWNER settings page (feat/service-self-diagnostics).
// Master switch (atomic CAS), cooldown + recent-connection presets, per-setting
// reset, panel live-read coverage, a bounded recent event summary, the safe
// limitations copy, and a READ-ONLY preview by service short id. Every mutation
// re-checks OWNER + revalidates atomically; the preview never creates a ticket
// and never moves money or mutates a panel beyond the existing safe row sync.
// =============================================================================

const OWNER_ONLY_TOAST = "این بخش فقط برای مالک ربات در دسترس است.";
const NOT_FOUND = "مورد یافت نشد.";
const PREVIEW_FLOW = "admin_diag:preview";
const EVENT_WINDOW_HOURS = 24;

/** Fixed presets (all within the shared bounds; the setters clamp anyway). */
const COOLDOWN_PRESETS = [15, 30, 60, 120];
const RECENT_PRESETS = [24, 72, 168, 336];

const DIAG_ADMIN_CB = {
  root: "admin:diag:root",
  toggle: "admin:diag:toggle",
  cooldown: (n: number): string => `admin:diag:cd:${n}`,
  recent: (n: number): string => `admin:diag:rc:${n}`,
  resetCooldown: "admin:diag:reset_cd",
  resetRecent: "admin:diag:reset_rc",
  preview: "admin:diag:preview",
} as const;

const DIAG_HTML = { parseMode: "HTML" as const };

export const diagnosticsAdminHandler = new Composer<BotContext>();
export const diagnosticsAdminTextHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TOAST);
    return false;
  }
  return true;
}

async function renderLanding(ctx: BotContext): Promise<void> {
  const [enabled, cooldown, recentHours, panels, counts, limitations] = await Promise.all([
    isServiceDiagnosticsEnabled(),
    diagnosticsCooldownSeconds(),
    diagnosticsRecentConnectionHours(),
    countDiagnosticsPanelSupport(),
    diagnosticsEventCounts(EVENT_WINDOW_HOURS),
    getMessageTemplate("service_diagnostics_limitations"),
  ]);

  const lines = [
    "عیب‌یابی سرویس 🛠",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `مدت انتظار بین بررسی‌ها: ${cooldown} ثانیه`,
    `آستانه اتصال اخیر: ${recentHours} ساعت`,
    "",
    `پنل‌های دارای بررسی لحظه‌ای: ${panels.readable}`,
    `پنل‌های بدون بررسی لحظه‌ای: ${panels.unreadable}`,
    "",
    `آمار ${EVENT_WINDOW_HOURS} ساعت اخیر:`,
    `• بررسی‌های انجام‌شده: ${counts[DIAGNOSTIC_EVENTS.COMPLETED] ?? 0}`,
    `• برخورد با محدودیت زمانی: ${counts[DIAGNOSTIC_EVENTS.COOLDOWN_HIT] ?? 0}`,
    `• عدم دسترسی به پنل: ${counts[DIAGNOSTIC_EVENTS.LIVE_READ_UNAVAILABLE] ?? 0}`,
    `• ارجاع به پشتیبانی: ${counts[DIAGNOSTIC_EVENTS.SUPPORT_HANDOFF] ?? 0}`,
    "",
    escapeHtml(limitations),
  ];
  const text = clampEscapedText(escapeHtml(lines.join("\n")));

  const kb = new InlineKeyboard()
    .text(enabled ? "غیرفعال کردن ⛔" : "فعال کردن ✅", DIAG_ADMIN_CB.toggle)
    .row();
  // Cooldown presets (seconds): the current value is marked «•».
  for (const preset of COOLDOWN_PRESETS) {
    kb.text(`${preset}ث${preset === cooldown ? " •" : ""}`, DIAG_ADMIN_CB.cooldown(preset));
  }
  kb.row().text("بازگردانی مدت انتظار به پیش‌فرض ♻️", DIAG_ADMIN_CB.resetCooldown).row();
  // Recent-connection presets (hours): the current value is marked «•».
  for (const preset of RECENT_PRESETS) {
    kb.text(`${preset}س${preset === recentHours ? " •" : ""}`, DIAG_ADMIN_CB.recent(preset));
  }
  kb.row().text("بازگردانی آستانه به پیش‌فرض ♻️", DIAG_ADMIN_CB.resetRecent).row();
  kb.text("پیش‌نمایش گزارش سرویس 👁", DIAG_ADMIN_CB.preview).row();
  kb.text("بازگشت به تنظیمات عمومی", "admin:general_settings");
  await safeEditOrReply(ctx, text, kb, DIAG_HTML);
}

diagnosticsAdminHandler.callbackQuery(DIAG_ADMIN_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  clearPreviewState(ctx);
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

// Atomic master-switch toggle: the CAS revalidates the stored state, so a stale
// button (two racing owners) can never double-apply. Moves no money, mutates no
// Service.
diagnosticsAdminHandler.callbackQuery(DIAG_ADMIN_CB.toggle, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const current = await isServiceDiagnosticsEnabled();
  await compareAndSetServiceDiagnosticsEnabled(current, !current);
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

diagnosticsAdminHandler.callbackQuery(/^admin:diag:cd:(\d+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await setDiagnosticsCooldownSeconds(Number.parseInt(ctx.match[1], 10));
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

diagnosticsAdminHandler.callbackQuery(/^admin:diag:rc:(\d+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await setDiagnosticsRecentConnectionHours(Number.parseInt(ctx.match[1], 10));
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

diagnosticsAdminHandler.callbackQuery(DIAG_ADMIN_CB.resetCooldown, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await resetDiagnosticsCooldown();
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

diagnosticsAdminHandler.callbackQuery(DIAG_ADMIN_CB.resetRecent, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await resetDiagnosticsRecentConnectionHours();
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

diagnosticsAdminHandler.callbackQuery(DIAG_ADMIN_CB.preview, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  ctx.session.currentFlow = PREVIEW_FLOW;
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard().text("انصراف", DIAG_ADMIN_CB.root);
  await safeEditOrReply(
    ctx,
    "شناسهٔ کوتاه سرویس (۸ کاراکتر اول) را برای پیش‌نمایش گزارش ارسال کنید.\n\nاین فقط یک پیش‌نمایش است؛ تیکتی ساخته نمی‌شود و هیچ تغییری در سرویس یا پنل ایجاد نمی‌شود.",
    kb,
  );
});

// OWNER preview text input: an admin-authorized (ANY owner) read-only diagnosis.
diagnosticsAdminTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== PREVIEW_FLOW) {
    return next();
  }
  if (ctx.admin === null || ctx.admin.role !== "OWNER") {
    clearPreviewState(ctx);
    return next();
  }
  const raw = ctx.message.text.trim();
  if (raw.startsWith("/")) {
    clearPreviewState(ctx);
    return next();
  }
  clearPreviewState(ctx);
  const service = await getServiceByShortIdForAdmin(raw.toLowerCase());
  if (service === null) {
    await safeReply(ctx, NOT_FOUND, new InlineKeyboard().text("بازگشت", DIAG_ADMIN_CB.root));
    return;
  }
  // Read-only preview: one bounded panel read scoped to the service's OWNER; the
  // report is rendered without any user action button and never becomes a ticket.
  const run = await runServiceDiagnostics(service, service.userId);
  const lines = [
    "پیش‌نمایش عیب‌یابی (فقط برای مالک) 👁",
    `سرویس: ${escapeHtml(service.username)}`,
    "",
    `نتیجه کلی: ${diagnosticOverallLabel(run.report.overall)}`,
    `منبع اطلاعات: ${diagnosticEvidenceLabel(run.report.evidenceSource)}`,
    "",
    "بررسی‌ها:",
    ...run.report.checks.map((check) => `${statusIcon(check.status)} ${diagnosticCheckMessage(check.code)}`),
  ];
  const text = clampEscapedText(escapeHtml(lines.join("\n")));
  const kb = new InlineKeyboard().text("بازگشت به عیب‌یابی سرویس", DIAG_ADMIN_CB.root);
  await safeReply(ctx, text, kb, DIAG_HTML);
});

function statusIcon(status: string): string {
  switch (status) {
    case "PASS":
      return "✅";
    case "INFO":
      return "ℹ️";
    case "WARNING":
      return "⚠️";
    case "FAIL":
      return "❌";
    default:
      return "❔";
  }
}

function clearPreviewState(ctx: BotContext): void {
  if (ctx.session.currentFlow === PREVIEW_FLOW) {
    ctx.session.currentFlow = null;
  }
}
