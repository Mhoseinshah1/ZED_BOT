import { prisma } from "@zedbot/database";
import {
  errorMessage,
  NOTIF_CHECKOUT_TEMPLATE_KEYS,
  type AbandonedExclusionReason,
  type CheckoutNotificationRuleKey,
  type NotificationRuleKey,
  type NotificationWorkerStatus,
  type PaymentRetryExclusionReason,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  previewAbandonedAudience,
  previewPaymentAudience,
} from "../../services/checkout-notification.service.js";
import {
  estimateNotificationAudience,
  getNotificationStatusCounts,
  listFailedNotifications,
  type NotificationStatusCounts,
} from "../../services/notification/notification.service.js";
import {
  anyNotificationRuleEnabled,
  compareAndSetNotificationSystemEnabled,
  getAbandonedCheckoutConfig,
  getFailedPaymentConfig,
  isCheckoutRuleEnabled,
  isNotificationRuleEnabled,
  isNotificationSystemEnabled,
  setAbandonedCheckoutConfig,
  setCheckoutRuleEnabled,
  setFailedPaymentConfig,
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
import { getMessageTemplate } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

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

/**
 * Checkout-payment rule-page callbacks (Phase 2). All under the admin:ntf:co:
 * namespace, carrying only the rule key + a short field code - never a checkout,
 * payment, user or config value. Well under Telegram's 64-byte limit.
 */
const CO_NTF_CB = {
  page: (rule: CheckoutNotificationRuleKey): string => `admin:ntf:co:${rule}`,
  toggle: (rule: CheckoutNotificationRuleKey): string => `admin:ntf:co:tg:${rule}`,
  preview: (rule: CheckoutNotificationRuleKey): string => `admin:ntf:co:prev:${rule}`,
  template: (rule: CheckoutNotificationRuleKey): string => `admin:ntf:co:tpl:${rule}`,
  test: (rule: CheckoutNotificationRuleKey): string => `admin:ntf:co:test:${rule}`,
  edit: (rule: CheckoutNotificationRuleKey, field: string): string =>
    `admin:ntf:co:e:${rule}:${field}`,
} as const;

/** currentFlow value for the numeric config-input step (routed from app.ts). */
const CO_CFG_FLOW = "admin_ntf_co:cfg";

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
    `• آخرین بررسی سفارش‌های ناقص: ${formatInstant(status?.lastCheckoutScanAt ?? null)}`,
    `• نامزد سفارش ناقص: ${status?.abandonedCheckoutCandidates ?? 0} | نامزد پرداخت ناموفق: ${status?.paymentRetryCandidates ?? 0}`,
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
  // Checkout-payment rule pages (Phase 2). READ is open to any admin, so these
  // navigation buttons are always shown; the pages OWNER-gate every mutation.
  kb.text("یادآوری سفارش ناقص 🛒", CO_NTF_CB.page("abandoned")).row();
  kb.text("یادآوری پرداخت ناموفق 💳", CO_NTF_CB.page("payment")).row();
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

// =============================================================================
// Checkout-payment rule pages (Phase 2): «یادآوری سفارش ناقص 🛒» +
// «یادآوری پرداخت ناموفق 💳». READ (status, thresholds, dry-run audience) is open
// to any admin; every MUTATION (enable/disable, config edit, message-template
// navigation) is OWNER-only. Enabling a rule passes the activation gate below;
// disabling is always allowed. Config edits validate through the shared parsers
// before persisting the full JSON, and enabling one checkout rule never touches
// the master switch or a service-notification rule.
// =============================================================================

const MAX_THRESHOLD_MINUTES = 30 * 24 * 60; // mirrors the shared parser bound.

const ABANDONED_REASON_LABELS: Record<AbandonedExclusionReason, string> = {
  "not-pending": "در وضعیت انتظار نیست",
  cancelled: "لغوشده",
  expired: "منقضی‌شده",
  settled: "پرداخت‌شده",
  "order-exists": "سفارش ثبت شده",
  "receipt-pending": "رسید در انتظار بررسی",
  "receipt-approved": "رسید تأییدشده",
  "duplicate-success": "پرداخت تکراری در حال بررسی",
  reconciliation: "در حال بررسی مالی",
  suppressed: "یادآوری خاموش‌شده",
  "too-old": "قدیمی‌تر از حد مجاز",
  "max-reached": "به سقف یادآوری رسیده",
  "too-early": "هنوز زمان یادآوری نرسیده",
};

const PAYMENT_REASON_LABELS: Record<PaymentRetryExclusionReason, string> = {
  "not-failed": "ناموفق قطعی نیست",
  "excluded-provider": "درگاه غیرمجاز برای تلاش مجدد",
  "settled-locally": "تسویه‌شده",
  settled: "سفارش پرداخت‌شده",
  "order-exists": "سفارش ثبت شده",
  "receipt-pending": "رسید در انتظار بررسی",
  reconciliation: "در حال بررسی مالی",
  "competing-success": "پرداخت موفق دیگری وجود دارد",
  expired: "منقضی‌شده",
  suppressed: "یادآوری خاموش‌شده",
  "too-early": "هنوز زمان یادآوری نرسیده",
  "max-per-payment": "به سقف هر پرداخت رسیده",
  "max-per-checkout-day": "به سقف روزانه هر سفارش رسیده",
};

const CONFIG_PROMPTS: Record<CheckoutNotificationRuleKey, Record<string, string>> = {
  abandoned: {
    t1: "زمان یادآوری اول را بر حسب دقیقه وارد کنید (بین ۱ تا ۴۳۲۰۰):",
    t2: "زمان یادآوری دوم را بر حسب دقیقه وارد کنید (باید بیشتر از یادآوری اول باشد):",
    max: "حداکثر تعداد یادآوری برای هر سفارش را وارد کنید (بین ۱ تا ۶):",
    age: "حداکثر عمر سفارش را بر حسب ساعت وارد کنید (بین ۱ تا ۷۲۰):",
  },
  payment: {
    delay: "تأخیر یادآوری پس از ناموفقی را بر حسب دقیقه وارد کنید (بین ۱ تا ۱۰۰۸۰):",
    maxpay: "حداکثر یادآوری برای هر پرداخت را وارد کنید (بین ۱ تا ۵):",
    maxday: "حداکثر یادآوری روزانه برای هر سفارش را وارد کنید (بین ۱ تا ۱۰):",
  },
};

interface RulePageOptions {
  toast?: string;
  showBreakdown?: boolean;
  gateReason?: string;
}

type EditResult = { ok: true } | { ok: false; error: string };

/** Clears any pending config-input flow (called on every navigation callback). */
function clearCoCfgFlow(ctx: BotContext): void {
  if (ctx.session.currentFlow === CO_CFG_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminCheckoutNtfDraft;
}

/** Parses a positive integer, accepting Persian/Arabic digits; null when invalid. */
function parsePositiveInt(raw: string): number | null {
  const normalized = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const n = Number.parseInt(normalized, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function formatExclusions(
  exclusions: Partial<Record<string, number>>,
  labels: Record<string, string>,
): string[] {
  const entries = Object.entries(exclusions).filter(([, n]) => (n ?? 0) > 0);
  entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return entries.map(([reason, n]) => `• ${labels[reason] ?? reason}: ${n}`);
}

function ruleActionKeyboard(
  rule: CheckoutNotificationRuleKey,
  enabled: boolean,
  owner: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (owner) {
    kb.text(enabled ? "غیرفعال کردن ⛔" : "فعال کردن ✅", CO_NTF_CB.toggle(rule)).row();
    if (rule === "abandoned") {
      kb.text("تنظیم زمان یادآوری اول", CO_NTF_CB.edit(rule, "t1"))
        .text("تنظیم زمان یادآوری دوم", CO_NTF_CB.edit(rule, "t2"))
        .row();
      kb.text("تنظیم حداکثر تعداد", CO_NTF_CB.edit(rule, "max"))
        .text("تنظیم حداکثر عمر", CO_NTF_CB.edit(rule, "age"))
        .row();
    } else {
      kb.text("تنظیم تأخیر", CO_NTF_CB.edit(rule, "delay"))
        .text("سقف هر پرداخت", CO_NTF_CB.edit(rule, "maxpay"))
        .row();
      kb.text("سقف روزانه هر سفارش", CO_NTF_CB.edit(rule, "maxday")).row();
    }
    kb.text("ویرایش متن پیام ✏️", CO_NTF_CB.template(rule)).row();
  }
  kb.text("پیش‌نمایش مخاطبان 👁", CO_NTF_CB.preview(rule)).row();
  kb.text("ارسال آزمایشی 📨", CO_NTF_CB.test(rule)).row();
  kb.text("بازگشت", NTF_ADMIN_CB.root);
  return kb;
}

async function renderAbandonedPage(ctx: BotContext, opts: RulePageOptions): Promise<void> {
  const [enabled, config, preview] = await Promise.all([
    isCheckoutRuleEnabled("abandoned"),
    getAbandonedCheckoutConfig(),
    previewAbandonedAudience(),
  ]);
  const t2 = config.thresholdMinutes.length > 1 ? config.thresholdMinutes[1] : null;
  const lines = [
    "🛒 یادآوری سفارش ناقص",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ❌"}`,
    `زمان یادآوری اول: ${config.thresholdMinutes[0]} دقیقه`,
    `زمان یادآوری دوم: ${t2 === null ? "—" : `${t2} دقیقه`}`,
    `حداکثر تعداد یادآوری برای هر سفارش: ${config.maximumRemindersPerCheckout}`,
    `حداکثر عمر سفارش: ${config.maximumCheckoutAgeHours} ساعت`,
    "",
    `مخاطبان واجد شرایط (تخمینی): ${preview.eligible}`,
    `سفارش‌های بررسی‌شده: ${preview.scanned}${preview.capped ? " (به سقف اسکن رسید)" : ""}`,
    `قالب پیام: ${NOTIF_CHECKOUT_TEMPLATE_KEYS.ABANDONED_CHECKOUT}`,
  ];
  if (opts.showBreakdown === true) {
    const breakdown = formatExclusions(preview.exclusions, ABANDONED_REASON_LABELS);
    lines.push(
      "",
      breakdown.length > 0
        ? "دلایل خارج‌شدن از فهرست:"
        : "همه‌ی موارد بررسی‌شده واجد شرایط بودند یا موردی یافت نشد.",
      ...breakdown,
    );
  }
  if (opts.gateReason !== undefined) {
    lines.push("", "⛔ فعال‌سازی ممکن نشد:", opts.gateReason);
  }
  await safeAnswerCallback(ctx, opts.toast);
  await safeEditOrReply(ctx, lines.join("\n"), ruleActionKeyboard("abandoned", enabled, isOwner(ctx)));
}

async function renderPaymentPage(ctx: BotContext, opts: RulePageOptions): Promise<void> {
  const [enabled, config, preview] = await Promise.all([
    isCheckoutRuleEnabled("payment"),
    getFailedPaymentConfig(),
    previewPaymentAudience(),
  ]);
  const lines = [
    "💳 یادآوری پرداخت ناموفق",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ❌"}`,
    `تأخیر پس از ناموفقی: ${config.delayMinutes} دقیقه`,
    `حداکثر یادآوری برای هر پرداخت: ${config.maximumRemindersPerPayment}`,
    `حداکثر یادآوری روزانه برای هر سفارش: ${config.maximumRemindersPerCheckoutPerDay}`,
    "",
    `مخاطبان واجد شرایط (تخمینی): ${preview.eligible}`,
    `پرداخت‌های بررسی‌شده: ${preview.scanned}${preview.capped ? " (به سقف اسکن رسید)" : ""}`,
    `قالب پیام: ${NOTIF_CHECKOUT_TEMPLATE_KEYS.PAYMENT_RETRY}`,
  ];
  if (opts.showBreakdown === true) {
    const breakdown = formatExclusions(preview.exclusions, PAYMENT_REASON_LABELS);
    lines.push(
      "",
      breakdown.length > 0
        ? "دلایل خارج‌شدن از فهرست:"
        : "همه‌ی موارد بررسی‌شده واجد شرایط بودند یا موردی یافت نشد.",
      ...breakdown,
    );
  }
  if (opts.gateReason !== undefined) {
    lines.push("", "⛔ فعال‌سازی ممکن نشد:", opts.gateReason);
  }
  await safeAnswerCallback(ctx, opts.toast);
  await safeEditOrReply(ctx, lines.join("\n"), ruleActionKeyboard("payment", enabled, isOwner(ctx)));
}

async function renderRulePage(
  ctx: BotContext,
  rule: CheckoutNotificationRuleKey,
  opts: RulePageOptions,
): Promise<void> {
  if (rule === "abandoned") {
    await renderAbandonedPage(ctx, opts);
  } else {
    await renderPaymentPage(ctx, opts);
  }
}

/**
 * The per-rule activation gate for ENABLING a checkout rule: master switch on,
 * Redis reachable, worker heartbeat fresh, engine status fresh, and the rule's
 * message template resolvable. Config is validated-by-construction (the shared
 * parser never yields an invalid config). Disabling never runs this.
 */
async function evaluateCheckoutRuleGate(rule: CheckoutNotificationRuleKey): Promise<GateResult> {
  if (!(await isNotificationSystemEnabled())) {
    return { ok: false, reason: "ابتدا سیستم اعلان‌ها را از صفحه اصلی فعال کنید." };
  }
  if (!(await pingOpsRedis()).ok) {
    return { ok: false, reason: "اتصال به Redis برقرار نیست." };
  }
  if ((await readWorkerHeartbeat()) === null) {
    return { ok: false, reason: "ضربان کارگر (worker) دریافت نمی‌شود." };
  }
  if (!isStatusFresh(await readNotificationWorkerStatus())) {
    return { ok: false, reason: "گزارش وضعیت موتور اعلان‌ها تازه نیست." };
  }
  const key =
    rule === "abandoned"
      ? NOTIF_CHECKOUT_TEMPLATE_KEYS.ABANDONED_CHECKOUT
      : NOTIF_CHECKOUT_TEMPLATE_KEYS.PAYMENT_RETRY;
  const rendered = await getMessageTemplate(key);
  if (rendered.trim() === "") {
    return { ok: false, reason: "قالب پیام این قانون در دسترس نیست." };
  }
  return { ok: true };
}

async function toggleCheckoutRule(
  ctx: BotContext,
  rule: CheckoutNotificationRuleKey,
): Promise<void> {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  if (await isCheckoutRuleEnabled(rule)) {
    // Disabling is always allowed and never gated.
    await setCheckoutRuleEnabled(rule, false);
    clearSettingsCache();
    logger.info("checkout rule disabled", { adminId: admin.id, rule });
    await renderRulePage(ctx, rule, { toast: "قانون غیرفعال شد." });
    return;
  }
  const gate = await evaluateCheckoutRuleGate(rule);
  if (!gate.ok) {
    logger.info("checkout rule enable refused by gate", {
      adminId: admin.id,
      rule,
      reason: gate.reason,
    });
    await renderRulePage(ctx, rule, { toast: "فعال‌سازی انجام نشد.", gateReason: gate.reason });
    return;
  }
  await setCheckoutRuleEnabled(rule, true);
  clearSettingsCache();
  logger.info("checkout rule enabled", { adminId: admin.id, rule });
  await renderRulePage(ctx, rule, { toast: "قانون فعال شد ✅" });
}

/** Applies one abandoned-config numeric edit, range/order-validated, then persists. */
async function applyAbandonedEdit(field: string, value: number): Promise<EditResult> {
  const cfg = await getAbandonedCheckoutConfig();
  const thresholds = [...cfg.thresholdMinutes];
  if (field === "t1") {
    if (value > MAX_THRESHOLD_MINUTES) {
      return { ok: false, error: `مقدار باید بین ۱ تا ${MAX_THRESHOLD_MINUTES} باشد.` };
    }
    const upper = thresholds.length > 1 ? thresholds[1] : Number.POSITIVE_INFINITY;
    if (value >= upper) {
      return { ok: false, error: "زمان یادآوری اول باید کمتر از یادآوری دوم باشد." };
    }
    thresholds[0] = value;
  } else if (field === "t2") {
    if (value > MAX_THRESHOLD_MINUTES) {
      return { ok: false, error: `مقدار باید بین ۱ تا ${MAX_THRESHOLD_MINUTES} باشد.` };
    }
    if (value <= thresholds[0]) {
      return { ok: false, error: "زمان یادآوری دوم باید بیشتر از یادآوری اول باشد." };
    }
    thresholds[1] = value;
  } else if (field === "max") {
    if (value > 6) {
      return { ok: false, error: "مقدار باید بین ۱ تا ۶ باشد." };
    }
    await setAbandonedCheckoutConfig({ ...cfg, maximumRemindersPerCheckout: value });
    return { ok: true };
  } else if (field === "age") {
    if (value > 30 * 24) {
      return { ok: false, error: "مقدار باید بین ۱ تا ۷۲۰ باشد." };
    }
    await setAbandonedCheckoutConfig({ ...cfg, maximumCheckoutAgeHours: value });
    return { ok: true };
  } else {
    return { ok: false, error: "مورد نامعتبر است." };
  }
  await setAbandonedCheckoutConfig({ ...cfg, thresholdMinutes: thresholds });
  return { ok: true };
}

/** Applies one failed-payment-config numeric edit, range-validated, then persists. */
async function applyPaymentEdit(field: string, value: number): Promise<EditResult> {
  const cfg = await getFailedPaymentConfig();
  if (field === "delay") {
    if (value > 7 * 24 * 60) {
      return { ok: false, error: "مقدار باید بین ۱ تا ۱۰۰۸۰ باشد." };
    }
    await setFailedPaymentConfig({ ...cfg, delayMinutes: value });
    return { ok: true };
  }
  if (field === "maxpay") {
    if (value > 5) {
      return { ok: false, error: "مقدار باید بین ۱ تا ۵ باشد." };
    }
    await setFailedPaymentConfig({ ...cfg, maximumRemindersPerPayment: value });
    return { ok: true };
  }
  if (field === "maxday") {
    if (value > 10) {
      return { ok: false, error: "مقدار باید بین ۱ تا ۱۰ باشد." };
    }
    await setFailedPaymentConfig({ ...cfg, maximumRemindersPerCheckoutPerDay: value });
    return { ok: true };
  }
  return { ok: false, error: "مورد نامعتبر است." };
}

async function startConfigEdit(
  ctx: BotContext,
  rule: CheckoutNotificationRuleKey,
  field: string,
): Promise<void> {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const prompt = CONFIG_PROMPTS[rule][field];
  if (prompt === undefined) {
    await safeAnswerCallback(ctx, "مورد نامعتبر است.");
    return;
  }
  ctx.session.currentFlow = CO_CFG_FLOW;
  ctx.session.temp.adminCheckoutNtfDraft = { rule, field };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, prompt, new InlineKeyboard().text("انصراف", CO_NTF_CB.page(rule)));
}

async function routeTemplateEdit(
  ctx: BotContext,
  rule: CheckoutNotificationRuleKey,
): Promise<void> {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const key =
    rule === "abandoned"
      ? NOTIF_CHECKOUT_TEMPLATE_KEYS.ABANDONED_CHECKOUT
      : NOTIF_CHECKOUT_TEMPLATE_KEYS.PAYMENT_RETRY;
  const row = await prisma.messageTemplate.findUnique({ where: { key }, select: { id: true } });
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  if (row !== null) {
    // The text-editor callback format (admin:texts:t:<idPrefix>) is owned by
    // text-settings.handler.ts; referenced as a literal here to stay
    // dependency-free of that module. Falls back to just showing the key.
    kb.text("ویرایش متن پیام ✏️", `admin:texts:t:${row.id.slice(0, 8)}`).row();
  }
  kb.text("بازگشت", CO_NTF_CB.page(rule));
  const note =
    row !== null
      ? "برای ویرایش متن این اعلان از دکمه زیر استفاده کنید."
      : "قالب پیام هنوز در پایگاه‌داده ثبت نشده است؛ از «مدیریت متن‌ها» آن را ویرایش کنید.";
  await safeEditOrReply(ctx, `کلید قالب پیام:\n${key}\n\n${note}`, kb);
}

async function sendRuleTestMessage(
  ctx: BotContext,
  rule: CheckoutNotificationRuleKey,
): Promise<void> {
  const chatId = ctx.from?.id;
  if (chatId === undefined) {
    await safeAnswerCallback(ctx, "شناسه چت مدیر در دسترس نیست.");
    return;
  }
  const key =
    rule === "abandoned"
      ? NOTIF_CHECKOUT_TEMPLATE_KEYS.ABANDONED_CHECKOUT
      : NOTIF_CHECKOUT_TEMPLATE_KEYS.PAYMENT_RETRY;
  // Sample display variables ONLY - never a real checkout, price or provider.
  const variables: Record<string, string | number> =
    rule === "abandoned"
      ? {
          product_name: "نمونه محصول",
          payable_amount: "۱۰۰٬۰۰۰ تومان",
          checkout_reference: "۱۲۳۴۵۶۷۸",
          expires_in: "۳۰ دقیقه",
        }
      : {
          product_name: "نمونه محصول",
          payable_amount: "۱۰۰٬۰۰۰ تومان",
          checkout_reference: "۱۲۳۴۵۶۷۸",
          payment_method: "زرین‌پال",
        };
  const text = await getMessageTemplate(key, undefined, variables);
  try {
    await ctx.api.sendMessage(chatId, text);
    await safeAnswerCallback(ctx, "پیام آزمایشی ارسال شد ✅");
  } catch (err) {
    logger.warn("checkout rule test message failed", { rule, error: errorMessage(err) });
    await safeAnswerCallback(ctx, "ارسال پیام آزمایشی ناموفق بود.");
  }
}

adminNotificationsHandler.callbackQuery(/^admin:ntf:co:(abandoned|payment)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearCoCfgFlow(ctx);
  await renderRulePage(ctx, ctx.match[1] as CheckoutNotificationRuleKey, {});
});

adminNotificationsHandler.callbackQuery(/^admin:ntf:co:tg:(abandoned|payment)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearCoCfgFlow(ctx);
  await toggleCheckoutRule(ctx, ctx.match[1] as CheckoutNotificationRuleKey);
});

adminNotificationsHandler.callbackQuery(/^admin:ntf:co:prev:(abandoned|payment)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearCoCfgFlow(ctx);
  await renderRulePage(ctx, ctx.match[1] as CheckoutNotificationRuleKey, { showBreakdown: true });
});

adminNotificationsHandler.callbackQuery(/^admin:ntf:co:tpl:(abandoned|payment)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearCoCfgFlow(ctx);
  await routeTemplateEdit(ctx, ctx.match[1] as CheckoutNotificationRuleKey);
});

adminNotificationsHandler.callbackQuery(/^admin:ntf:co:test:(abandoned|payment)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearCoCfgFlow(ctx);
  await sendRuleTestMessage(ctx, ctx.match[1] as CheckoutNotificationRuleKey);
});

adminNotificationsHandler.callbackQuery(
  /^admin:ntf:co:e:(abandoned|payment):([a-z0-9]+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    await startConfigEdit(ctx, ctx.match[1] as CheckoutNotificationRuleKey, ctx.match[2]);
  },
);

// --- numeric config input (flow "admin_ntf_co:cfg", routed from app.ts) -------

export const adminNotificationsTextHandler = new Composer<BotContext>();

adminNotificationsTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== CO_CFG_FLOW) {
    return next();
  }
  const draft = ctx.session.temp.adminCheckoutNtfDraft;
  if (ctx.admin === null || draft === undefined) {
    clearCoCfgFlow(ctx);
    return next();
  }
  const text = ctx.message.text;
  // A command abandons the edit and runs normally.
  if (text.startsWith("/")) {
    clearCoCfgFlow(ctx);
    return next();
  }
  // MUTATION is OWNER-only even if the flow was somehow entered otherwise.
  if (!isOwner(ctx)) {
    clearCoCfgFlow(ctx);
    await safeReply(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const value = parsePositiveInt(text);
  if (value === null) {
    await safeReply(ctx, "عدد نامعتبر است. لطفاً یک عدد صحیح مثبت وارد کنید.");
    return; // keep the flow so the admin can retry.
  }
  const result =
    draft.rule === "abandoned"
      ? await applyAbandonedEdit(draft.field, value)
      : await applyPaymentEdit(draft.field, value);
  if (!result.ok) {
    await safeReply(ctx, result.error);
    return; // keep the flow so the admin can retry.
  }
  clearSettingsCache();
  logger.info("checkout notification config updated", {
    adminId: ctx.admin.id,
    rule: draft.rule,
    field: draft.field,
  });
  const rule = draft.rule;
  clearCoCfgFlow(ctx);
  await safeReply(ctx, "ذخیره شد ✅");
  await renderRulePage(ctx, rule, {});
});
