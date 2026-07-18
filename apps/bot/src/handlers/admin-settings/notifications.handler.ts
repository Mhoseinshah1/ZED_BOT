import { errorMessage, type NotificationRuleKey, type NotificationWorkerStatus } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  estimateNotificationAudience,
  getNotificationStatusCounts,
  listFailedNotifications,
  type NotificationStatusCounts,
} from "../../services/notification/notification.service.js";
import {
  anyNotificationRuleEnabled,
  compareAndSetNotificationSystemEnabled,
  isNotificationRuleEnabled,
  isNotificationSystemEnabled,
  setNotificationRuleEnabled,
} from "../../services/notification/notification-settings.service.js";
import {
  pingOpsRedis,
  readNotificationWorkerStatus,
  readWorkerHeartbeat,
  type OpsRedisPing,
  type WorkerHeartbeat,
} from "../../services/ops-queue.service.js";
import { clearSettingsCache } from "../../services/settings.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «اعلان‌ها و یادآوری‌ها 🔔» - the admin notification-engine settings + health
// page (feat/notification-retention-engine, Phase 1). READS are open to any
// admin (master/rule switches, worker health, status counts, recent failures,
// a rough تخمینی audience count). MUTATIONS are OWNER-only; a non-owner sees the
// same read-only page and a «فقط مالک» toast on any mutate attempt.
//
// The MASTER switch stays DISABLED by default and can only be enabled behind an
// activation gate that ALL of Redis / worker heartbeat / fresh engine status /
// at least one rule / a live Telegram test message must pass - else it refuses
// with the specific failing reason and the switch stays off. The flip itself is
// a compare-and-set so a stale click or a racing admin can never double-enable.
// Disabling is always allowed and never gated. No secret ever appears here.
// =============================================================================

export const adminNotificationsHandler = new Composer<BotContext>();

export const NTF_ADMIN_CB = {
  root: "admin:ntf",
  enable: "admin:ntf:enable",
  disable: "admin:ntf:disable",
  rule: (rule: NotificationRuleKey): string => `admin:ntf:rule:${rule}`,
} as const;

const OWNER_ONLY_TEXT = "این عملیات فقط برای مالک مجموعه مجاز است.";

/** How recent the worker's engine-status snapshot must be to count as "fresh". */
const STATUS_FRESH_MS = 10 * 60 * 1000;

const RULES: readonly NotificationRuleKey[] = ["expiry", "traffic", "trial"];
const RULE_TITLES: Record<NotificationRuleKey, string> = {
  expiry: "انقضای سرویس",
  traffic: "ترافیک سرویس",
  trial: "اکانت تست",
};

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

function isStatusFresh(status: NotificationWorkerStatus | null): boolean {
  if (status === null) {
    return false;
  }
  const at = Date.parse(status.checkedAt);
  if (!Number.isFinite(at)) {
    return false;
  }
  return Date.now() - at <= STATUS_FRESH_MS;
}

function formatInstant(iso: string | null): string {
  if (iso === null || iso === "") {
    return "نامشخص";
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return "نامشخص";
  }
  return `${new Date(t).toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

interface AdminNotificationView {
  enabled: boolean;
  rules: boolean[];
  status: NotificationWorkerStatus | null;
  heartbeat: WorkerHeartbeat | null;
  ping: OpsRedisPing;
  counts: NotificationStatusCounts;
  failures: Awaited<ReturnType<typeof listFailedNotifications>>;
  audience: number;
}

async function gatherView(): Promise<AdminNotificationView> {
  const [enabled, rules, status, heartbeat, ping, counts, failures, audience] = await Promise.all([
    isNotificationSystemEnabled(),
    Promise.all(RULES.map((rule) => isNotificationRuleEnabled(rule))),
    readNotificationWorkerStatus(),
    readWorkerHeartbeat(),
    pingOpsRedis(),
    getNotificationStatusCounts(),
    listFailedNotifications(5),
    estimateNotificationAudience(),
  ]);
  return { enabled, rules, status, heartbeat, ping, counts, failures, audience };
}

function renderText(view: AdminNotificationView): string {
  const { enabled, rules, status, heartbeat, ping, counts, failures, audience } = view;
  const reporting =
    status === null ? "بدون گزارش ❌" : isStatusFresh(status) ? "فعال و تازه ✅" : "قدیمی ⚠️";
  const lines = [
    "🔔 اعلان‌ها و یادآوری‌ها",
    "",
    `وضعیت کلی سیستم: ${enabled ? "فعال ✅" : "غیرفعال ❌"}`,
    "",
    "قوانین:",
    ...RULES.map((rule, i) => `• ${RULE_TITLES[rule]}: ${rules[i] ? "فعال ✅" : "غیرفعال ❌"}`),
    "",
    "وضعیت موتور (worker):",
    `• گزارش‌دهی موتور: ${reporting}`,
    `• زمان‌بند: ${status?.schedulerActive === true ? "فعال ✅" : "غیرفعال ❌"}`,
    `• ضربان کارگر: ${heartbeat !== null ? "تازه ✅" : "نامشخص ❌"}`,
    `• Redis: ${ping.ok ? `متصل ✅${ping.latencyMs !== null ? ` (${ping.latencyMs}ms)` : ""}` : "قطع ❌"}`,
    `• آخرین همگام‌سازی سرویس‌ها: ${formatInstant(status?.lastServiceSyncAt ?? null)}`,
    `• آخرین اسکن سرویس‌ها: ${formatInstant(status?.lastServiceScanAt ?? null)}`,
    `• صف تحویل: ${status?.deliveryWaiting ?? 0} | ناموفق: ${status?.deliveryFailed ?? 0} | مرده: ${status?.deadLetter ?? 0}`,
    "",
    "آمار اعلان‌ها:",
    `• زمان‌بندی‌شده: ${counts.scheduled}`,
    `• آماده: ${counts.ready}`,
    `• در حال ارسال: ${counts.sending}`,
    `• ارسال‌شده: ${counts.sent}`,
    `• ناموفق: ${counts.failed}`,
    `• مرده (dead-letter): ${counts.deadLetter}`,
    "",
    `مخاطبان واجد شرایط (تخمینی): ${audience}`,
  ];
  if (failures.length > 0) {
    lines.push("", "آخرین خطاها:");
    for (const failure of failures) {
      lines.push(
        `• ${failure.type} | ${failure.status} | تلاش: ${failure.attempts}${failure.safeErrorCode !== null ? ` | ${failure.safeErrorCode}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function renderKeyboard(view: AdminNotificationView, owner: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (owner) {
    kb.text(
      view.enabled ? "غیرفعال کردن سیستم ⛔" : "فعال کردن سیستم ✅",
      view.enabled ? NTF_ADMIN_CB.disable : NTF_ADMIN_CB.enable,
    ).row();
    RULES.forEach((rule, i) => {
      kb.text(`${RULE_TITLES[rule]}: ${view.rules[i] ? "✅" : "❌"}`, NTF_ADMIN_CB.rule(rule)).row();
    });
  }
  kb.text("بروزرسانی ♻️", NTF_ADMIN_CB.root).row();
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderPage(ctx: BotContext, toast?: string): Promise<void> {
  const view = await gatherView();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, renderText(view), renderKeyboard(view, isOwner(ctx)));
}

interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * The MASTER-enable activation gate: every check must pass, in order, else the
 * first failure's Persian reason is returned and the switch stays off. The
 * final check actually SENDS a Telegram message to the acting admin's own chat
 * (a real end-to-end delivery proof), so it runs last.
 */
async function evaluateActivationGate(ctx: BotContext): Promise<GateResult> {
  // (a) Redis reachable.
  if (!(await pingOpsRedis()).ok) {
    return { ok: false, reason: "اتصال به Redis برقرار نیست." };
  }
  // (b) Worker heartbeat fresh (TTL-backed key -> presence means alive).
  if ((await readWorkerHeartbeat()) === null) {
    return { ok: false, reason: "ضربان کارگر (worker) دریافت نمی‌شود." };
  }
  // (c) Notification-engine status present + fresh.
  if (!isStatusFresh(await readNotificationWorkerStatus())) {
    return { ok: false, reason: "گزارش وضعیت موتور اعلان‌ها تازه نیست." };
  }
  // (d) At least one rule enabled.
  if (!(await anyNotificationRuleEnabled())) {
    return { ok: false, reason: "هیچ قانونی فعال نیست؛ ابتدا حداقل یک قانون را فعال کنید." };
  }
  // (e) A live Telegram test message to the acting admin succeeds.
  const chatId = ctx.from?.id;
  if (chatId === undefined) {
    return { ok: false, reason: "شناسه چت مدیر در دسترس نیست." };
  }
  try {
    await ctx.api.sendMessage(chatId, "پیام آزمایشی سیستم اعلان‌ها ✅ (فعال‌سازی)");
  } catch (err) {
    logger.warn("notification activation test message failed", { error: errorMessage(err) });
    return { ok: false, reason: "ارسال پیام آزمایشی به مدیر ناموفق بود." };
  }
  return { ok: true };
}

adminNotificationsHandler.callbackQuery(NTF_ADMIN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderPage(ctx);
  ctx.session.lastMenu = NTF_ADMIN_CB.root;
});

adminNotificationsHandler.callbackQuery(/^admin:ntf:rule:(expiry|traffic|trial)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const rule = ctx.match[1] as NotificationRuleKey;
  const next = !(await isNotificationRuleEnabled(rule));
  await setNotificationRuleEnabled(rule, next);
  clearSettingsCache();
  logger.info("notification rule toggled", { adminId: admin.id, rule, enabled: next });
  await renderPage(ctx, next ? "قانون فعال شد ✅" : "قانون غیرفعال شد.");
});

adminNotificationsHandler.callbackQuery(NTF_ADMIN_CB.disable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // Disabling is ALWAYS allowed and never gated.
  const flipped = await compareAndSetNotificationSystemEnabled(true, false);
  if (flipped) {
    clearSettingsCache();
    logger.info("notification system disabled", { adminId: admin.id });
  }
  await renderPage(ctx, flipped ? "سیستم اعلان‌ها غیرفعال شد." : "سیستم از قبل غیرفعال است.");
});

adminNotificationsHandler.callbackQuery(NTF_ADMIN_CB.enable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  if (await isNotificationSystemEnabled()) {
    await renderPage(ctx, "سیستم از قبل فعال است.");
    return;
  }
  const gate = await evaluateActivationGate(ctx);
  if (!gate.ok) {
    logger.info("notification system enable refused by gate", {
      adminId: admin.id,
      reason: gate.reason,
    });
    const view = await gatherView();
    await safeAnswerCallback(ctx, "فعال‌سازی انجام نشد.");
    await safeEditOrReply(
      ctx,
      `${renderText(view)}\n\n⛔ فعال‌سازی ممکن نشد:\n${gate.reason ?? ""}`,
      renderKeyboard(view, true),
    );
    return;
  }
  // Race-free flip: a stale click or a racing admin loses the transition and
  // gets the idempotent "already enabled" answer instead.
  if (!(await compareAndSetNotificationSystemEnabled(false, true))) {
    await renderPage(ctx, "سیستم از قبل فعال است.");
    return;
  }
  clearSettingsCache();
  logger.info("notification system enabled", { adminId: admin.id });
  await renderPage(ctx, "سیستم اعلان‌ها فعال شد ✅");
});
