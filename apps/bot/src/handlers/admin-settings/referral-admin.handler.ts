import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  enableReferralPayoutsGated,
  getReferralMigrationHistory,
  type ReferralActivationReadiness,
  type ReferralMigrationHistory,
  type ReferralMigrationHistoryStatus,
} from "../../services/referral-activation.service.js";
import { enqueueReferralReconcileNow, readReferralWorkerStatus } from "../../services/ops-queue.service.js";
import {
  disableReferralPayouts,
  getReferralAdminStats,
  setReferralCommissionPercent,
  setReferralFirstPurchaseOnly,
  setReferralMinPurchaseToman,
  type ReferralAdminStats,
} from "../../services/referral.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Referral affiliate commissions — ADMIN page (Phase 1). OWNER-only. The master
// switch (disabled by default) gates the PAYOUT only — referral attribution linking
// always works. The OWNER sets the commission percent, the first-purchase-only
// policy and the minimum qualifying order, and sees the paid/reversed totals.
// Nothing here moves money or creates a commission.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

/** Persian labels for the migration-history dimension (§9). */
const MIGRATION_HISTORY_LABEL: Record<ReferralMigrationHistoryStatus, string> = {
  HEALTHY: "سالم",
  KNOWN_COMPATIBLE_LEGACY_VARIANT: "نسخه قدیمی سازگار",
  CHECKSUM_DRIFT: "ناسازگار",
  FILE_MISSING: "فایل migration موجود نیست",
  SCHEMA_POSTCONDITION_FAILED: "ساختار پایگاه‌داده ناقص",
};
/** The exact non-blocking OWNER warning for a known compatible PR #110 lineage. */
const LEGACY_VARIANT_WARNING = "تاریخچه این نصب از نسخه سازگار قدیمی migration استفاده می‌کند.";

export const REF_ADMIN_CB = {
  root: "admin:referral:root",
  enable: "admin:referral:enable",
  disable: "admin:referral:disable",
  first: "admin:referral:first",
  reconcile: "admin:referral:reconcile",
  pct: (n: number): string => `admin:referral:pct:${n}`,
  min: (n: number): string => `admin:referral:min:${n}`,
} as const;

const PERCENT_PRESETS = [5, 10, 15, 20, 25];
const MIN_PRESETS = [0, 50_000, 100_000, 200_000];

export const referralAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

function toman(n: number): string {
  return faDigits(n.toLocaleString("en-US"));
}

/** One line for the migration-history dimension; a warning line follows for legacy. */
function migrationHistoryLines(mh: ReferralMigrationHistory): string[] {
  const lines = ["", "<b>تاریخچه migration:</b>", `وضعیت: ${MIGRATION_HISTORY_LABEL[mh.status]}`];
  if (mh.legacyWarning) {
    lines.push(`⚠️ ${LEGACY_VARIANT_WARNING}`);
  }
  return lines;
}

function overviewText(s: ReferralAdminStats, worker: ReferralWorkerLine, mh: ReferralMigrationHistory): string {
  return [
    "👥 <b>زیرمجموعه‌گیری و پاداش</b>",
    "",
    `وضعیت پاداش: ${s.enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `شروع پاداش‌دهی: ${s.startedAt ? faDigits(s.startedAt.toISOString().slice(0, 10)) : "—"}`,
    `درصد پاداش: ${faDigits(s.commissionPercent)}٪`,
    `فقط اولین خرید: ${s.firstPurchaseOnly ? "بله" : "خیر"}`,
    `حداقل مبلغ خرید: ${toman(s.minPurchaseToman)} تومان`,
    "",
    "<b>آمار مالی:</b>",
    `تعداد زیرمجموعه‌ها: ${faDigits(s.totalReferrals)}`,
    `پاداش پرداخت‌شده: ${faDigits(s.paidCommissionCount)} مورد — ${toman(s.paidCommissionToman)} تومان`,
    `بازگردانی‌شده (کامل): ${faDigits(s.reversedCommissionCount)} مورد — ${toman(s.reversedCommissionToman)} تومان`,
    `در انتظار بازگردانی (بدهی): ${faDigits(s.reversalPendingCount)} مورد — ${toman(s.reversalPendingOutstandingToman)} تومان`,
    `<b>پاداش خالص باقی‌مانده:</b> ${toman(s.netCommissionToman)} تومان`,
    ...migrationHistoryLines(mh),
    "",
    "<b>وضعیت پردازش‌گر:</b>",
    `آخرین بررسی: ${worker.lastScan}`,
    `خطای اجرا: ${faDigits(worker.executeFailures)}`,
  ].join("\n");
}

interface ReferralWorkerLine {
  lastScan: string;
  executeFailures: number;
}

function overviewKeyboard(s: ReferralAdminStats): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (s.enabled) {
    kb.text("غیرفعال‌سازی پاداش ⛔", REF_ADMIN_CB.disable).row();
  } else {
    kb.text("فعال‌سازی پاداش ✅", REF_ADMIN_CB.enable).row();
  }
  // Commission percent presets.
  for (const p of PERCENT_PRESETS) {
    kb.text(`${p === s.commissionPercent ? "✅ " : ""}${faDigits(p)}٪`, REF_ADMIN_CB.pct(p));
  }
  kb.row();
  kb.text(`فقط اولین خرید: ${s.firstPurchaseOnly ? "✅" : "❌"}`, REF_ADMIN_CB.first).row();
  // Minimum qualifying order presets.
  for (const m of MIN_PRESETS) {
    kb.text(`${m === s.minPurchaseToman ? "✅ " : ""}${faDigits((m / 1000).toString())}k`, REF_ADMIN_CB.min(m));
  }
  kb.row();
  kb.text("اجرای مغایرت‌گیری ♻️", REF_ADMIN_CB.reconcile).row();
  kb.text("بروزرسانی 🔄", REF_ADMIN_CB.root).row();
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  const [stats, status, migrationHistory] = await Promise.all([
    getReferralAdminStats(),
    readReferralWorkerStatus(),
    getReferralMigrationHistory(),
  ]);
  const worker: ReferralWorkerLine = {
    lastScan: status?.lastScanAt ? faDigits(status.lastScanAt.slice(0, 19).replace("T", " ")) : "نامشخص",
    executeFailures: status?.executeFailures ?? 0,
  };
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, overviewText(stats, worker, migrationHistory), overviewKeyboard(stats), { parseMode: "HTML" });
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return false;
  }
  return true;
}

referralAdminHandler.callbackQuery(REF_ADMIN_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await renderOverview(ctx);
  ctx.session.lastMenu = REF_ADMIN_CB.root;
});

/** Renders the failing activation-integrity checks when enable is BLOCKED. */
function activationBlockedText(readiness: ReferralActivationReadiness): string {
  const lines = [
    "⛔ <b>فعال‌سازی پاداش مسدود شد</b>",
    "",
    `<b>وضعیت تاریخچه migration:</b> ${MIGRATION_HISTORY_LABEL[readiness.migrationHistory.status]}`,
    "",
    "پیش از فعال‌سازی، همهٔ بررسی‌های یکپارچگی باید سبز باشند:",
    "",
    ...readiness.checks.map((c) => `${c.ok ? "✅" : "⛔"} ${c.label}${c.ok || c.detail === null ? "" : ` — ${c.detail}`}`),
    "",
    "پس از رفع موارد بالا دوباره تلاش کنید. (غیرفعال‌سازی همیشه در دسترس است.)",
  ];
  return lines.join("\n");
}

referralAdminHandler.callbackQuery(REF_ADMIN_CB.enable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  // ACTIVATION INTEGRITY GATE: enable only when the system is provably healthy
  // end-to-end. When it passes, the horizon + payout window + master switch flip
  // atomically in one transaction; when it fails, nothing changes and the OWNER
  // sees exactly which checks blocked activation.
  const result = await enableReferralPayoutsGated();
  if (result.status === "blocked") {
    await safeAnswerCallback(ctx, "فعال‌سازی مسدود شد — بررسی یکپارچگی ناموفق بود.");
    await safeEditOrReply(
      ctx,
      activationBlockedText(result.readiness),
      new InlineKeyboard().text("بازگشت 🔙", REF_ADMIN_CB.root),
      { parseMode: "HTML" },
    );
    return;
  }
  if (result.flipped) {
    logger.info("referral system enabled");
  }
  // A known compatible PR #110 lineage activates but surfaces the non-blocking warning.
  const toast = result.migrationHistory.legacyWarning
    ? LEGACY_VARIANT_WARNING
    : result.flipped
      ? "پاداش زیرمجموعه‌گیری فعال شد ✅"
      : "پاداش از قبل فعال است.";
  await renderOverview(ctx, toast);
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.disable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const flipped = await disableReferralPayouts();
  if (flipped) {
    logger.info("referral system disabled");
  }
  await renderOverview(ctx, flipped ? "پاداش زیرمجموعه‌گیری غیرفعال شد." : "پاداش از قبل غیرفعال است.");
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.reconcile, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  // Kicks the worker credit/reversal/recovery scans once. The worker no-ops the
  // credit/reversal scans while payouts are disabled, so this never pays behind a
  // disabled system; debt recovery always runs. Fail-soft when Redis is down.
  const ok = await enqueueReferralReconcileNow();
  await renderOverview(ctx, ok ? "مغایرت‌گیری در صف قرار گرفت ♻️" : "صف در دسترس نیست.");
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.first, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const stats = await getReferralAdminStats();
  await setReferralFirstPurchaseOnly(!stats.firstPurchaseOnly);
  await renderOverview(ctx, "به‌روزرسانی شد");
});

referralAdminHandler.callbackQuery(/^admin:referral:pct:(\d{1,3})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const ok = await setReferralCommissionPercent(Number.parseInt(ctx.match[1], 10));
  await renderOverview(ctx, ok ? "درصد پاداش به‌روزرسانی شد ✅" : "مقدار نامعتبر است.");
});

referralAdminHandler.callbackQuery(/^admin:referral:min:(\d{1,9})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const ok = await setReferralMinPurchaseToman(Number.parseInt(ctx.match[1], 10));
  await renderOverview(ctx, ok ? "حداقل مبلغ به‌روزرسانی شد ✅" : "مقدار نامعتبر است.");
});
