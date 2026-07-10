import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard, InputFile } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  backupDir,
  backupRetentionDays,
  buildRestoreInstructions,
  cleanupOldBackups,
  createDatabaseBackup,
  formatBytes,
  getBackupFile,
  getSystemHealth,
  listBackups,
} from "../../services/backup-health.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «گزارشات / بکاپ 🛡» (Phase 35) - system health, manual pg_dump backups,
// backup list/download, retention cleanup and restore INSTRUCTIONS (restore
// is never executed from Telegram). Health is admin-readable; the mutating
// actions (create/download/cleanup) are OWNER-only on top of the admin
// middleware. No secrets - the DATABASE_URL never appears anywhere here.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const OWNER_ONLY_TEXT = "این عملیات فقط برای ادمین OWNER مجاز است.";

const RB_CB = {
  root: CB.ADMIN_REPORTS_BACKUP,
  health: "admin:rb:health",
  backup: "admin:rb:backup",
  backupYes: "admin:rb:backup_yes",
  list: (page: number): string => `admin:rb:list:${page}`,
  file: (sid: string): string => `admin:rb:file:${sid}`,
  cleanup: "admin:rb:cleanup",
  cleanupYes: "admin:rb:cleanup_yes",
  restoreHelp: "admin:rb:restore_help",
} as const;

export const reportsBackupHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

async function renderLanding(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("وضعیت سیستم 🩺", RB_CB.health)
    .row()
    .text("ساخت بکاپ دیتابیس 💾", RB_CB.backup)
    .row()
    .text("لیست بکاپ‌ها 🧾", RB_CB.list(1))
    .row()
    .text("پاکسازی بکاپ‌های قدیمی 🧹", RB_CB.cleanup)
    .row()
    .text("راهنمای Restore ♻️", RB_CB.restoreHelp)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(
    ctx,
    "گزارشات / بکاپ 🛡\n\nسلامت سیستم، بکاپ دستی دیتابیس و پاکسازی بکاپ‌های قدیمی.",
    kb,
  );
}

reportsBackupHandler.callbackQuery(RB_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
  ctx.session.lastMenu = RB_CB.root;
});

// --- health -------------------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(RB_CB.health, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const health = await getSystemHealth();
  const lines = [
    "وضعیت سیستم 🩺",
    "",
    health.db.ok
      ? `دیتابیس: ✅ (${health.db.latencyMs} ms)`
      : `دیتابیس: ❌ ${health.db.error ?? ""}`,
    `Redis: ➖ ${health.redis.reason}`,
    `پوشه بکاپ: ${health.backupDirectory.exists && health.backupDirectory.writable ? "✅ قابل نوشتن" : "❌ در دسترس/قابل نوشتن نیست"} (${health.backupDirectory.path})`,
  ];
  if (health.disk.checked) {
    lines.push(
      `دیسک: ${formatBytes((health.disk.usedKb ?? 0) * 1024)} مصرف / ${formatBytes((health.disk.availableKb ?? 0) * 1024)} آزاد (${health.disk.usePercent ?? "-"})`,
    );
  } else {
    lines.push("دیسک: ➖ بررسی نشد");
  }
  lines.push(
    `Node: ${health.node.version} | آپ‌تایم: ${Math.floor(health.node.uptimeSeconds / 60)} دقیقه`,
    `حافظه: RSS ${formatBytes(health.node.rssBytes)} | Heap ${formatBytes(health.node.heapUsedBytes)}`,
  );
  if (health.appVersion !== null) {
    lines.push(`نسخه: ${health.appVersion}`);
  }
  lines.push(`زمان: ${health.timestamp.toISOString().replace("T", " ").slice(0, 19)} UTC`);
  const kb = new InlineKeyboard()
    .text("به‌روزرسانی 🔄", RB_CB.health)
    .row()
    .text("بازگشت", RB_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
});

// --- create backup (OWNER only) -----------------------------------------------------------------

reportsBackupHandler.callbackQuery(RB_CB.backup, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "ساخت بکاپ دیتابیس 💾\n\nساخت بکاپ ممکن است چند لحظه طول بکشد. ادامه می‌دهید؟",
    new InlineKeyboard().text("بله، ساخت بکاپ 💾", RB_CB.backupYes).row().text("انصراف", RB_CB.root),
  );
});

reportsBackupHandler.callbackQuery(RB_CB.backupYes, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // Answer first - pg_dump may take a while.
  await safeAnswerCallback(ctx, "در حال ساخت بکاپ… ⏳");
  const outcome = await createDatabaseBackup();
  if (!outcome.ok) {
    await safeEditOrReply(
      ctx,
      `ساخت بکاپ دیتابیس 💾\n\n❌ ${outcome.safeMessage}`,
      new InlineKeyboard().text("بازگشت", RB_CB.root),
    );
    return;
  }
  const kb = new InlineKeyboard();
  if (outcome.backup.sizeBytes <= 45 * 1024 * 1024) {
    kb.text("دریافت فایل 📥", RB_CB.file(outcome.backup.shortId)).row();
  }
  kb.text("لیست بکاپ‌ها 🧾", RB_CB.list(1)).row().text("بازگشت", RB_CB.root);
  await safeEditOrReply(
    ctx,
    [
      "بکاپ ساخته شد ✅",
      "",
      `فایل: ${outcome.backup.name}`,
      `حجم: ${formatBytes(outcome.backup.sizeBytes)}`,
      `زمان: ${outcome.backup.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
    ].join("\n"),
    kb,
  );
});

// --- list / download ------------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(/^admin:rb:list:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const pageData = await listBackups(Number.parseInt(ctx.match[1], 10));
  const kb = new InlineKeyboard();
  for (const backup of pageData.backups) {
    kb.text(`💾 ${backup.shortId} | ${formatBytes(backup.sizeBytes)}`, RB_CB.file(backup.shortId)).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", RB_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, RB_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", RB_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", RB_CB.root);
  await safeEditOrReply(
    ctx,
    pageData.total === 0
      ? `لیست بکاپ‌ها 🧾\n\nبکاپی وجود ندارد. (${backupDir()})`
      : `لیست بکاپ‌ها 🧾 — ${pageData.total} فایل\n\nبرای دریافت روی فایل بزنید.`,
    kb,
  );
});

reportsBackupHandler.callbackQuery(/^admin:rb:file:([0-9-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const outcome = await getBackupFile(ctx.match[1]);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.tooLarge ? "حجم فایل زیاد است." : outcome.safeMessage);
    if (outcome.tooLarge) {
      await safeReply(ctx, outcome.safeMessage);
    }
    return;
  }
  await safeAnswerCallback(ctx, "در حال ارسال فایل… 📥");
  try {
    await ctx.replyWithDocument(new InputFile(outcome.path, outcome.name));
  } catch (err) {
    logger.warn("backup file send failed", { name: outcome.name, error: errorMessage(err) });
    await safeReply(ctx, `ارسال فایل ناموفق بود. مسیر روی سرور:\n${outcome.path}`);
  }
});

// --- cleanup (OWNER only) -------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(RB_CB.cleanup, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `پاکسازی بکاپ‌های قدیمی 🧹\n\nبکاپ‌های قدیمی‌تر از ${backupRetentionDays()} روز حذف می‌شوند. ادامه می‌دهید؟`,
    new InlineKeyboard().text("بله، پاکسازی 🧹", RB_CB.cleanupYes).row().text("انصراف", RB_CB.root),
  );
});

reportsBackupHandler.callbackQuery(RB_CB.cleanupYes, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const result = await cleanupOldBackups();
  await safeEditOrReply(
    ctx,
    [
      "پاکسازی بکاپ‌های قدیمی 🧹",
      "",
      `حذف‌شده: ${result.deletedCount} فایل`,
      `فضای آزادشده: ${formatBytes(result.freedBytes)}`,
    ].join("\n"),
    new InlineKeyboard().text("لیست بکاپ‌ها 🧾", RB_CB.list(1)).row().text("بازگشت", RB_CB.root),
  );
});

// --- restore help ---------------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(RB_CB.restoreHelp, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `<pre>${buildRestoreInstructions().replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
    new InlineKeyboard().text("بازگشت", RB_CB.root),
    HTML,
  );
});
