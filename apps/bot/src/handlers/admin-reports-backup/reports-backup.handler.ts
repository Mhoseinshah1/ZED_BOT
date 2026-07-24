import {
  BackupOperationStatus,
  BackupTrigger,
  type BackupOperation,
} from "@zedbot/database";
import {
  classifyBackupFileName,
  errorMessage,
  shortGitSha,
  type BackupFileKind,
} from "@zedbot/shared";
import { Composer, InlineKeyboard, InputFile } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  BACKUP_QUEUE_UNAVAILABLE_TEXT,
  BACKUP_SCHEDULE_ENABLED_KEY,
  BACKUP_SCHEDULE_HOUR_KEY,
  BACKUP_SCHEDULE_INTERVAL_KEY,
  BACKUP_SCHEDULE_INTERVALS,
  BACKUP_SCHEDULE_NOTIFY_KEY,
  backupDir,
  backupMinFreeDiskMb,
  backupMinRetained,
  backupRetentionDays,
  buildRestoreInstructions,
  deleteBackup,
  formatBytes,
  getBackupEntry,
  getBackupFile,
  getBackupOperationByShortId,
  getDeploymentDiagnostics,
  getSystemHealth,
  listBackups,
  requestManualBackup,
  telegramTokenSourceLabel,
  type BackupListEntry,
  type BackupScheduleInterval,
  type SystemHealth,
} from "../../services/backup-health.service.js";
import {
  enqueueBackupCleanup,
  enqueueBackupVerify,
} from "../../services/ops-queue.service.js";
import {
  compareAndSetBooleanSetting,
  getBooleanSetting,
  getSetting,
  setSetting,
} from "../../services/settings.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «گزارشات / بکاپ 🛡» (production-backup rework) - system health, QUEUED
// manual backups (the worker runs pg_dump - never this process), backup
// list/detail/download/verify/delete, retention cleanup (queued), restore
// INSTRUCTIONS and the scheduled-backup settings. Health is admin-readable;
// every mutating action is OWNER-only on top of the admin middleware.
// Callback data carries only backup shortIds (timestamps) and operation
// short ids - NEVER raw filenames. No secrets anywhere: DATABASE_URL,
// Redis credentials and BACKUP_ENCRYPTION_PASSWORD never appear in any
// message (only the PRESENCE of the encryption password is shown).
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const OP_NOT_FOUND_TEXT = "عملیات بکاپ پیدا نشد.";
const NO_OPERATION_ROW_TEXT =
  "برای این فایل رکورد عملیات وجود ندارد؛ از CLI بررسی کنید.";
const VERSION_MISMATCH_TEXT =
  "نسخه در حال اجرای ربات با نسخه نصب‌شده روی سرور یکسان نیست ⚠️";

export const SCHEDULE_HOUR_FLOW = "rb:sched_hour";

const RB_CB = {
  root: CB.ADMIN_REPORTS_BACKUP,
  health: "admin:rb:health",
  backup: "admin:rb:backup",
  backupYes: "admin:rb:backup_yes",
  deploy: "admin:rb:deploy",
  testbk: "admin:rb:testbk",
  testbkYes: "admin:rb:testbk_yes",
  op: (sid: string): string => `admin:rb:op:${sid}`,
  list: (page: number): string => `admin:rb:list:${page}`,
  file: (sid: string): string => `admin:rb:file:${sid}`,
  download: (sid: string): string => `admin:rb:dl:${sid}`,
  verify: (sid: string): string => `admin:rb:verify:${sid}`,
  del: (sid: string): string => `admin:rb:del:${sid}`,
  del2: (sid: string): string => `admin:rb:del2:${sid}`,
  delYes: (sid: string): string => `admin:rb:del_yes:${sid}`,
  cleanup: "admin:rb:cleanup",
  cleanupYes: "admin:rb:cleanup_yes",
  restoreHelp: "admin:rb:restore_help",
  schedule: "admin:rb:sched",
  scheduleToggle: "admin:rb:sched:toggle",
  scheduleInterval: (value: BackupScheduleInterval): string => `admin:rb:sched:int:${value}`,
  scheduleHour: "admin:rb:sched:hour",
  scheduleNotify: "admin:rb:sched:notify",
} as const;

export const reportsBackupHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

function formatTime(when: Date): string {
  return `${when.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

const KIND_LABELS: Record<BackupFileKind, string> = {
  dump: "dump",
  "dump-encrypted": "dump رمز‌شده",
  "legacy-sql-gz": "legacy sql.gz",
};

const TRIGGER_LABELS: Record<BackupTrigger, string> = {
  MANUAL: "دستی",
  SCHEDULED: "زمان‌بندی‌شده",
  PRE_UPDATE: "قبل از بروزرسانی",
};

const OP_STATUS_LABELS: Record<BackupOperationStatus, string> = {
  QUEUED: "در صف انتظار ⏳",
  RUNNING: "در حال ساخت بکاپ… ⏳",
  VERIFYING: "در حال بررسی سلامت… 🧪",
  COMPLETED: "ساخته شد ✅",
  VERIFIED: "سلامت فایل بکاپ تایید شد ✅",
  FAILED: "ساخت بکاپ ناموفق بود ❌",
  CORRUPT: "فایل بکاپ معتبر نیست یا آسیب دیده است ❌",
  CANCELLED: "لغو شد",
};

function verifyLabel(state: BackupListEntry["verifyState"]): string {
  switch (state) {
    case "verified":
      return "تاییدشده ✅";
    case "corrupt":
      return "نامعتبر ❌";
    case "unknown":
      return "نامشخص";
  }
}

// --- landing --------------------------------------------------------------------------------------

export async function renderLanding(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("تحلیل اعلان‌ها 📈", CB.ADMIN_ANALYTICS)
    .row()
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
    .text("تنظیمات بکاپ خودکار ⏰", RB_CB.schedule)
    .row()
    .text("بررسی نصب و بروزرسانی 🧪", RB_CB.deploy)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(
    ctx,
    "گزارشات / بکاپ 🛡\n\nسلامت سیستم، بکاپ دیتابیس (اجرا در سرویس worker) و مدیریت بکاپ‌ها.",
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

function buildHealthLines(health: SystemHealth): string[] {
  const lines = ["وضعیت سیستم 🩺", ""];

  // Deployment identity first: a stale container invalidates every other
  // "healthy" line below it.
  lines.push(
    `نسخه در حال اجرا: ${
      health.version.runningSha === null ? "نامشخص" : shortGitSha(health.version.runningSha)
    }`,
  );
  if (health.version.mismatch) {
    lines.push(VERSION_MISMATCH_TEXT);
  }

  lines.push(
    health.db.ok ? `دیتابیس: ✅ (${health.db.latencyMs} ms)` : "دیتابیس: ❌ در دسترس نیست",
  );
  lines.push(
    health.redis.ok ? `Redis: ✅ (${health.redis.latencyMs} ms)` : "Redis: ❌ در دسترس نیست",
  );

  if (health.worker.alive) {
    lines.push(
      health.worker.heartbeatAgeSeconds === null
        ? "Worker: ✅ فعال"
        : `Worker: ✅ فعال — آخرین پاسخ ${health.worker.heartbeatAgeSeconds} ثانیه قبل`,
    );
  } else {
    lines.push("Worker: ❌ پاسخ نمی‌دهد");
  }
  const queue = health.worker.queue;
  lines.push(
    queue === null
      ? "صف بکاپ: نامشخص"
      : `صف بکاپ: در انتظار ${queue.waiting} | فعال ${queue.active} | ناموفق ${queue.failed}`,
  );

  lines.push(
    "پوشه بکاپ:",
    `خواندن ربات ${health.backupDirectory.botReadable ? "✅" : "❌"}`,
    `نوشتن Worker ${
      health.backupDirectory.workerWritable === null
        ? "نامشخص"
        : health.backupDirectory.workerWritable
          ? "✅"
          : "❌"
    }`,
  );

  if (health.pgDump.available === true && health.pgDump.version !== null) {
    lines.push(`ابزار بکاپ: ✅ pg_dump ${health.pgDump.version}`);
  } else if (health.pgDump.available === false) {
    lines.push("ابزار بکاپ: ❌ نصب نیست");
  } else {
    lines.push("ابزار بکاپ: ❌ نامشخص (Worker در دسترس نیست)");
  }

  if (health.disk.ok) {
    lines.push(
      `دیسک: کل ${formatBytes(health.disk.totalBytes ?? 0)} | مصرف ${formatBytes(health.disk.usedBytes ?? 0)} | آزاد ${formatBytes(health.disk.freeBytes ?? 0)} (${health.disk.percentUsed ?? "-"}٪)`,
    );
    if (health.disk.low) {
      lines.push("⚠️ فضای دیسک کم است");
    }
  } else {
    lines.push("دیسک: ➖ بررسی نشد");
  }

  if (health.latestBackup === null) {
    lines.push("آخرین بکاپ:", "— بکاپی وجود ندارد", "⚠️ هنوز هیچ بکاپی ساخته نشده است");
  } else {
    lines.push(
      "آخرین بکاپ:",
      `${formatTime(health.latestBackup.createdAt)} — ${formatBytes(health.latestBackup.sizeBytes)} — ${verifyLabel(health.latestBackup.verifyState)}`,
    );
    if (health.latestBackup.stale) {
      lines.push("⚠️ آخرین بکاپ قدیمی‌تر از ۴۸ ساعت است");
    }
    if (health.latestBackup.verifyState !== "verified") {
      lines.push("⚠️ هیچ بکاپ تاییدشده‌ای وجود ندارد");
    }
  }

  lines.push(health.encryptionEnabled ? "رمزنگاری بکاپ: فعال ✅" : "رمزنگاری بکاپ: غیرفعال ⚠️");

  if (!health.logGroup.configured) {
    lines.push("گروه لاگ: تنظیم نشده");
  } else if (health.logGroup.lastDeliveryOk === false) {
    lines.push("گروه لاگ: خطا در دسترسی");
  } else {
    lines.push("گروه لاگ: متصل ✅");
  }

  lines.push("", `زمان: ${formatTime(health.timestamp)}`);
  return lines;
}

reportsBackupHandler.callbackQuery(RB_CB.health, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const health = await getSystemHealth();
  const kb = new InlineKeyboard()
    .text("به‌روزرسانی 🔄", RB_CB.health)
    .row()
    .text("بازگشت", RB_CB.root);
  await safeEditOrReply(ctx, buildHealthLines(health).join("\n"), kb);
});

// --- deployment check («بررسی نصب و بروزرسانی 🧪») -------------------------------------------------

function shaLabel(sha: string | null): string {
  return sha === null ? "نامشخص" : shortGitSha(sha);
}

/**
 * The deployment-diagnostics page: repo/bot/worker identity (short SHAs
 * only), migration completeness, backup-mount access and pg_dump presence.
 * Unknown facts render as «نامشخص» - never guessed. Admin-readable like the
 * health page; the test-backup action below it is OWNER-only.
 */
async function renderDeployPage(ctx: BotContext, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  const diag = await getDeploymentDiagnostics();
  const lines = [
    "بررسی نصب و بروزرسانی 🧪",
    "",
    "نسخه مخزن:",
    shaLabel(diag.repoSha),
    "",
    "نسخه ربات:",
    shaLabel(diag.botSha),
    "",
    "نسخه Worker:",
    shaLabel(diag.workerSha),
  ];
  if (diag.mismatch) {
    lines.push("", VERSION_MISMATCH_TEXT);
  }
  lines.push(
    "",
    "Migration:",
    diag.migration.known ? (diag.migration.upToDate ? "بروزرسانی‌شده ✅" : "ناقص ❌") : "نامشخص",
    "",
    "Mount بکاپ:",
    `ربات خواندن ${diag.botReadable ? "✅" : "❌"} | Worker نوشتن ${
      diag.workerWritable === null ? "نامشخص" : diag.workerWritable ? "✅" : "❌"
    }`,
    "",
    "ابزار بکاپ:",
    diag.pgDumpAvailable === null
      ? "نامشخص (Worker در دسترس نیست)"
      : diag.pgDumpAvailable
        ? "pg_dump آماده ✅"
        : "نصب نیست ❌",
    "",
    "توکن تلگرام:",
    `ربات: ${telegramTokenSourceLabel(diag.botTelegramTokenSource)}`,
    `Worker: ${telegramTokenSourceLabel(diag.workerTelegramTokenSource)}`,
  );
  const kb = new InlineKeyboard()
    .text("اجرای تست بکاپ", RB_CB.testbk)
    .row()
    .text("بروزرسانی 🔄", RB_CB.deploy)
    .row()
    .text("بازگشت", RB_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

reportsBackupHandler.callbackQuery(RB_CB.deploy, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderDeployPage(ctx);
});

// «اجرای تست بکاپ»: OWNER-only confirmation - the "test" is a REAL verified
// database backup through the worker queue, never a dry run.
reportsBackupHandler.callbackQuery(RB_CB.testbk, async (ctx) => {
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
    [
      "اجرای تست بکاپ",
      "",
      "یک بکاپ واقعی و کامل از دیتابیس ساخته و سلامت آن بررسی می‌شود.",
      "اجرا در سرویس worker انجام می‌شود و ممکن است چند دقیقه طول بکشد. ادامه می‌دهید؟",
    ].join("\n"),
    new InlineKeyboard()
      .text("تایید و اجرا ✅", RB_CB.testbkYes)
      .row()
      .text("انصراف", RB_CB.deploy),
  );
});

reportsBackupHandler.callbackQuery(RB_CB.testbkYes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const request = await requestManualBackup(admin).catch((err: unknown) => {
    logger.error("test backup request failed", { error: errorMessage(err) });
    return null;
  });
  if (request === null) {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      "اجرای تست بکاپ\n\n❌ ثبت درخواست بکاپ ناموفق بود. لاگ سرور را بررسی کنید.",
      new InlineKeyboard().text("بازگشت", RB_CB.deploy),
    );
    return;
  }
  if (!request.enqueued) {
    // Queue down: the existing toast, back on the diagnostics page.
    await renderDeployPage(ctx, BACKUP_QUEUE_UNAVAILABLE_TEXT);
    return;
  }
  // Success: land on the SAME live operation page the manual-backup button
  // uses (admin:rb:op:<sid> keeps refreshing it).
  await safeAnswerCallback(ctx, "در حال ساخت بکاپ… ⏳");
  const view = renderOperationView(request.op);
  const header = request.created
    ? "در حال ساخت بکاپ… ⏳"
    : "یک عملیات بکاپ از قبل در حال انجام است.";
  await safeEditOrReply(ctx, `${header}\n\n${view.text}`, view.keyboard);
});

// --- create backup (OWNER only, queued) -----------------------------------------------------------

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
    "ساخت بکاپ دیتابیس 💾\n\nبکاپ در سرویس worker ساخته می‌شود و ممکن است چند دقیقه طول بکشد. ادامه می‌دهید؟",
    new InlineKeyboard().text("بله، ساخت بکاپ 💾", RB_CB.backupYes).row().text("انصراف", RB_CB.root),
  );
});

function renderOperationView(op: BackupOperation): { text: string; keyboard: InlineKeyboard } {
  const sid = op.id.slice(0, 8);
  const lines = [`عملیات بکاپ 💾 (شناسه: ${sid})`, "", `وضعیت: ${OP_STATUS_LABELS[op.status]}`];
  if (op.filename !== null) {
    lines.push(`فایل: ${op.filename}`);
  }
  if (op.sizeBytes !== null) {
    lines.push(`حجم: ${formatBytes(Number(op.sizeBytes))}`);
  }
  if (
    op.status === BackupOperationStatus.COMPLETED ||
    op.status === BackupOperationStatus.VERIFIED
  ) {
    lines.push(`رمزنگاری: ${op.encrypted ? "فعال ✅" : "غیرفعال"}`);
  }
  if (op.status === BackupOperationStatus.FAILED && op.safeErrorCode !== null) {
    lines.push(`کد خطا: ${op.safeErrorCode}`);
  }
  if (op.completedAt !== null) {
    lines.push(`زمان پایان: ${formatTime(op.completedAt)}`);
  }
  const kb = new InlineKeyboard();
  const active =
    op.status === BackupOperationStatus.QUEUED ||
    op.status === BackupOperationStatus.RUNNING ||
    op.status === BackupOperationStatus.VERIFYING;
  if (active) {
    kb.text("بروزرسانی وضعیت 🔄", RB_CB.op(sid)).row();
  }
  const fileShortId = op.filename === null ? null : classifyBackupFileName(op.filename)?.shortId;
  if (
    fileShortId !== null &&
    fileShortId !== undefined &&
    (op.status === BackupOperationStatus.COMPLETED ||
      op.status === BackupOperationStatus.VERIFIED)
  ) {
    kb.text("دریافت فایل 📥", RB_CB.download(fileShortId)).row();
  }
  kb.text("لیست بکاپ‌ها 🧾", RB_CB.list(1)).row().text("بازگشت", RB_CB.root);
  return { text: lines.join("\n"), keyboard: kb };
}

reportsBackupHandler.callbackQuery(RB_CB.backupYes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // Answer IMMEDIATELY - the work happens in the worker, nothing blocks here.
  await safeAnswerCallback(ctx, "در حال ساخت بکاپ… ⏳");
  const request = await requestManualBackup(admin).catch((err: unknown) => {
    logger.error("manual backup request failed", { error: errorMessage(err) });
    return null;
  });
  if (request === null) {
    await safeEditOrReply(
      ctx,
      `ساخت بکاپ دیتابیس 💾\n\n❌ ثبت درخواست بکاپ ناموفق بود. لاگ سرور را بررسی کنید.`,
      new InlineKeyboard().text("بازگشت", RB_CB.root),
    );
    return;
  }
  if (!request.enqueued) {
    await safeEditOrReply(
      ctx,
      `ساخت بکاپ دیتابیس 💾\n\n❌ ${BACKUP_QUEUE_UNAVAILABLE_TEXT}`,
      new InlineKeyboard().text("بازگشت", RB_CB.root),
    );
    return;
  }
  const view = renderOperationView(request.op);
  const header = request.created
    ? "در حال ساخت بکاپ… ⏳"
    : "یک عملیات بکاپ از قبل در حال انجام است.";
  await safeEditOrReply(ctx, `${header}\n\n${view.text}`, view.keyboard);
});

reportsBackupHandler.callbackQuery(/^admin:rb:op:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const op = await getBackupOperationByShortId(ctx.match[1]);
  if (op === null) {
    await safeAnswerCallback(ctx, OP_NOT_FOUND_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const view = renderOperationView(op);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// --- list / file detail ------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(/^admin:rb:list:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const pageData = await listBackups(Number.parseInt(ctx.match[1], 10));
  const kb = new InlineKeyboard();
  for (const backup of pageData.backups) {
    kb.text(
      `💾 ${backup.shortId} | ${formatBytes(backup.sizeBytes)} | ${verifyLabel(backup.verifyState)}`,
      RB_CB.file(backup.shortId),
    ).row();
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
      : `لیست بکاپ‌ها 🧾 — ${pageData.total} فایل\n\nبرای جزئیات روی فایل بزنید.`,
    kb,
  );
});

function renderFileView(entry: BackupListEntry): { text: string; keyboard: InlineKeyboard } {
  const op = entry.operation;
  const lines = [
    `بکاپ 💾 ${entry.name}`,
    "",
    `زمان ساخت: ${formatTime(entry.createdAt)}`,
    `حجم: ${formatBytes(entry.sizeBytes)}`,
    `نوع: ${KIND_LABELS[entry.kind]}`,
    `رمزنگاری: ${entry.encrypted ? "فعال ✅" : "غیرفعال"}`,
    `وضعیت بررسی: ${verifyLabel(entry.verifyState)}`,
    `منبع: ${op === null ? "دستی" : TRIGGER_LABELS[op.trigger]}`,
    `وضعیت: ${op === null ? "نامشخص" : OP_STATUS_LABELS[op.status]}`,
  ];
  const kb = new InlineKeyboard()
    .text("دریافت فایل 📥", RB_CB.download(entry.shortId))
    .row()
    .text("بررسی سلامت 🧪", RB_CB.verify(entry.shortId))
    .row()
    .text("حذف بکاپ 🗑", RB_CB.del(entry.shortId))
    .row()
    .text("بازگشت", RB_CB.list(1));
  return { text: lines.join("\n"), keyboard: kb };
}

reportsBackupHandler.callbackQuery(/^admin:rb:file:(\d{8}-\d{6})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const entry = await getBackupEntry(ctx.match[1]);
  if (entry === null) {
    await safeAnswerCallback(ctx, "فایل بکاپ پیدا نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  const view = renderFileView(entry);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// --- download (OWNER only) ------------------------------------------------------------------------

reportsBackupHandler.callbackQuery(/^admin:rb:dl:(\d{8}-\d{6})$/, async (ctx) => {
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
      // Server path is OWNER-only information - the gate above guarantees it.
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

// --- verify (OWNER only, queued) -------------------------------------------------------------------

reportsBackupHandler.callbackQuery(/^admin:rb:verify:(\d{8}-\d{6})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const entry = await getBackupEntry(ctx.match[1]);
  if (entry === null) {
    await safeAnswerCallback(ctx, "فایل بکاپ پیدا نشد.");
    return;
  }
  if (entry.operation === null) {
    // Legacy/CLI files have no operation row - verification lives in the CLI.
    await safeAnswerCallback(ctx, NO_OPERATION_ROW_TEXT);
    return;
  }
  const enqueued = await enqueueBackupVerify(entry.operation.id, entry.shortId);
  if (!enqueued) {
    await safeAnswerCallback(ctx, BACKUP_QUEUE_UNAVAILABLE_TEXT);
    return;
  }
  await safeAnswerCallback(ctx, "بررسی سلامت در صف قرار گرفت 🧪");
  const view = renderOperationView(entry.operation);
  await safeEditOrReply(
    ctx,
    `بررسی سلامت فایل بکاپ 🧪\n\nنتیجه با «بروزرسانی وضعیت 🔄» قابل مشاهده است.\n\n${view.text}`,
    new InlineKeyboard()
      .text("بروزرسانی وضعیت 🔄", RB_CB.op(entry.operation.id.slice(0, 8)))
      .row()
      .text("بازگشت", RB_CB.file(entry.shortId)),
  );
});

// --- delete (OWNER only, DOUBLE confirmation) -------------------------------------------------------

reportsBackupHandler.callbackQuery(/^admin:rb:del:(\d{8}-\d{6})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const sid = ctx.match[1];
  const entry = await getBackupEntry(sid);
  if (entry === null) {
    await safeAnswerCallback(ctx, "فایل بکاپ پیدا نشد.");
    return;
  }
  await safeAnswerCallback(ctx);
  // Confirmation 1 of 2.
  await safeEditOrReply(
    ctx,
    [
      "حذف بکاپ 🗑 (مرحله ۱ از ۲)",
      "",
      `فایل: ${entry.name}`,
      `حجم: ${formatBytes(entry.sizeBytes)}`,
      "",
      "آیا از حذف این بکاپ مطمئن هستید؟",
    ].join("\n"),
    new InlineKeyboard().text("ادامه حذف 🗑", RB_CB.del2(sid)).row().text("انصراف", RB_CB.file(sid)),
  );
});

reportsBackupHandler.callbackQuery(/^admin:rb:del2:(\d{8}-\d{6})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const sid = ctx.match[1];
  await safeAnswerCallback(ctx);
  // Confirmation 2 of 2 - a DISTINCT page, so a double-tap on the first
  // confirmation can never delete anything.
  await safeEditOrReply(
    ctx,
    [
      "حذف بکاپ 🗑 (مرحله ۲ از ۲ - تایید نهایی)",
      "",
      "⚠️ این عمل غیرقابل بازگشت است و فایل برای همیشه حذف می‌شود.",
    ].join("\n"),
    new InlineKeyboard()
      .text("بله، حذف نهایی ❗️", RB_CB.delYes(sid))
      .row()
      .text("انصراف", RB_CB.file(sid)),
  );
});

reportsBackupHandler.callbackQuery(/^admin:rb:del_yes:(\d{8}-\d{6})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const outcome = await deleteBackup(admin, ctx.match[1]);
  await safeAnswerCallback(ctx, outcome.safeMessage);
  if (outcome.ok) {
    await safeEditOrReply(
      ctx,
      `حذف بکاپ 🗑\n\n${outcome.safeMessage}`,
      new InlineKeyboard().text("لیست بکاپ‌ها 🧾", RB_CB.list(1)).row().text("بازگشت", RB_CB.root),
    );
  }
});

// --- cleanup (OWNER only, queued) -------------------------------------------------------------------

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
    `پاکسازی بکاپ‌های قدیمی 🧹\n\nبکاپ‌های قدیمی‌تر از ${backupRetentionDays()} روز (با نگهداری حداقل ${backupMinRetained()} بکاپ) توسط سرویس worker حذف می‌شوند. ادامه می‌دهید؟`,
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
  const enqueued = await enqueueBackupCleanup();
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    enqueued
      ? "پاکسازی بکاپ‌های قدیمی 🧹\n\nدرخواست پاکسازی در صف ثبت شد ✅ نتیجه در گروه لاگ اعلام می‌شود."
      : `پاکسازی بکاپ‌های قدیمی 🧹\n\n❌ ${BACKUP_QUEUE_UNAVAILABLE_TEXT}`,
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

// --- scheduled-backup settings (OWNER only) ----------------------------------------------------------
// The bot ONLY edits the Settings rows below; the WORKER owns the repeatable
// BullMQ job and reconciles it from these Settings on its own cadence - no
// direct queue mutation happens here.

const INTERVAL_LABELS: Record<BackupScheduleInterval, string> = {
  "6h": "هر ۶ ساعت",
  "12h": "هر ۱۲ ساعت",
  daily: "روزانه",
  weekly: "هفتگی",
};

async function readScheduleInterval(): Promise<BackupScheduleInterval> {
  const raw = await getSetting(BACKUP_SCHEDULE_INTERVAL_KEY, "daily");
  return (BACKUP_SCHEDULE_INTERVALS as readonly string[]).includes(raw)
    ? (raw as BackupScheduleInterval)
    : "daily";
}

async function readScheduleHour(): Promise<number> {
  const parsed = Number.parseInt(await getSetting(BACKUP_SCHEDULE_HOUR_KEY, "3"), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 3;
}

async function renderSchedulePage(ctx: BotContext, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  const [enabled, interval, hour, notify] = await Promise.all([
    getBooleanSetting(BACKUP_SCHEDULE_ENABLED_KEY, false),
    readScheduleInterval(),
    readScheduleHour(),
    getBooleanSetting(BACKUP_SCHEDULE_NOTIFY_KEY, true),
  ]);
  const lines = [
    "تنظیمات بکاپ خودکار ⏰",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ❌"}`,
    `بازه اجرا: ${INTERVAL_LABELS[interval]}`,
    `ساعت اجرا (UTC): ${hour}`,
    `ارسال نتیجه به گروه لاگ: ${notify ? "فعال ✅" : "غیرفعال"}`,
    "",
    "— مقادیر مدیریت‌شده با env —",
    `نگهداری بکاپ: ${backupRetentionDays()} روز (BACKUP_RETENTION_DAYS)`,
    `حداقل بکاپ نگه‌داشته‌شده: ${backupMinRetained()} (BACKUP_MIN_RETAINED)`,
    `حداقل فضای آزاد دیسک: ${backupMinFreeDiskMb()} MB (BACKUP_MIN_FREE_DISK_MB)`,
    "",
    "سرویس worker زمان‌بندی را از همین تنظیمات همگام می‌کند.",
  ];
  const kb = new InlineKeyboard()
    .text(enabled ? "غیرفعال کردن بکاپ خودکار" : "فعال کردن بکاپ خودکار", RB_CB.scheduleToggle)
    .row();
  for (const value of BACKUP_SCHEDULE_INTERVALS) {
    kb.text(
      `${value === interval ? "• " : ""}${INTERVAL_LABELS[value]}`,
      RB_CB.scheduleInterval(value),
    );
    if (value === "12h") {
      kb.row();
    }
  }
  kb.row()
    .text("تغییر ساعت اجرا 🕒", RB_CB.scheduleHour)
    .row()
    .text(
      notify ? "خاموش کردن اعلان گروه لاگ" : "روشن کردن اعلان گروه لاگ",
      RB_CB.scheduleNotify,
    )
    .row()
    .text("بازگشت", RB_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

reportsBackupHandler.callbackQuery(RB_CB.schedule, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await renderSchedulePage(ctx);
});

reportsBackupHandler.callbackQuery(RB_CB.scheduleToggle, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const current = await getBooleanSetting(BACKUP_SCHEDULE_ENABLED_KEY, false);
  // Compare-and-set: a stale tap / racing admin loses the transition.
  const applied = await compareAndSetBooleanSetting(BACKUP_SCHEDULE_ENABLED_KEY, current, !current);
  await renderSchedulePage(
    ctx,
    applied
      ? !current
        ? "بکاپ خودکار فعال شد ✅"
        : "بکاپ خودکار غیرفعال شد."
      : "وضعیت قبلاً تغییر کرده است.",
  );
});

reportsBackupHandler.callbackQuery(/^admin:rb:sched:int:(6h|12h|daily|weekly)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const value = ctx.match[1] as BackupScheduleInterval;
  await setSetting(BACKUP_SCHEDULE_INTERVAL_KEY, value, "STRING");
  await renderSchedulePage(ctx, `بازه اجرا: ${INTERVAL_LABELS[value]} ✅`);
});

reportsBackupHandler.callbackQuery(RB_CB.scheduleHour, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = SCHEDULE_HOUR_FLOW;
  ctx.session.temp.adminBackupScheduleDraft = { field: "hour" };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "تغییر ساعت اجرا 🕒\n\nیک عدد بین 0 تا 23 بفرستید (ساعت به وقت UTC).",
    new InlineKeyboard().text("انصراف", RB_CB.schedule),
  );
});

reportsBackupHandler.callbackQuery(RB_CB.scheduleNotify, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const current = await getBooleanSetting(BACKUP_SCHEDULE_NOTIFY_KEY, true);
  const applied = await compareAndSetBooleanSetting(BACKUP_SCHEDULE_NOTIFY_KEY, current, !current);
  await renderSchedulePage(
    ctx,
    applied
      ? !current
        ? "اعلان گروه لاگ روشن شد ✅"
        : "اعلان گروه لاگ خاموش شد."
      : "وضعیت قبلاً تغییر کرده است.",
  );
});

// --- schedule-hour text input ----------------------------------------------------------------------

export const reportsBackupTextHandler = new Composer<BotContext>();

/** Persian/Arabic digits -> latin, so "۳" and "3" both work. */
function normalizeDigits(text: string): string {
  return text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

reportsBackupTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== SCHEDULE_HOUR_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    ctx.session.currentFlow = null;
    delete ctx.session.temp.adminBackupScheduleDraft;
    return next();
  }
  if (admin.role !== "OWNER") {
    ctx.session.currentFlow = null;
    delete ctx.session.temp.adminBackupScheduleDraft;
    await safeReply(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const normalized = normalizeDigits(text.trim());
  if (!/^\d{1,2}$/.test(normalized) || Number.parseInt(normalized, 10) > 23) {
    await safeReply(
      ctx,
      "مقدار نامعتبر است. یک عدد بین 0 تا 23 بفرستید.",
      new InlineKeyboard().text("انصراف", RB_CB.schedule),
    );
    return;
  }
  const hour = Number.parseInt(normalized, 10);
  await setSetting(BACKUP_SCHEDULE_HOUR_KEY, String(hour), "NUMBER");
  ctx.session.currentFlow = null;
  delete ctx.session.temp.adminBackupScheduleDraft;
  await safeReply(
    ctx,
    `ساعت اجرای بکاپ خودکار روی ${hour} (UTC) تنظیم شد ✅`,
    new InlineKeyboard().text("تنظیمات بکاپ خودکار ⏰", RB_CB.schedule),
  );
});
