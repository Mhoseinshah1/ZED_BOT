import { LowBalanceBackfillStatus } from "@zedbot/database";
import {
  formatTomanAmount,
  LOW_BALANCE_ENABLED_KEY,
  LOW_BALANCE_TEMPLATE_KEY,
  parseTomanAmount,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  cancelLowBalanceBackfill,
  countBackfillCandidates,
  describeBoundaries,
  getLatestBackfill,
  setLowBalanceRearmMargin,
  setLowBalanceThreshold,
  startLowBalanceBackfill,
  type BackfillView,
} from "../../services/low-balance/low-balance-admin.service.js";
import {
  getLowBalanceConfig,
  getLowBalanceOverview,
  type LowBalanceOverview,
} from "../../services/low-balance/low-balance.service.js";
import { clearSettingsCache, compareAndSetBooleanSetting } from "../../services/settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Low wallet balance — ADMIN page (§11). OWNER-only.
//
// The whole surface is aggregate-only: counts, boundaries and run progress. It
// never lists, searches or names a user, so an operator cannot use it to find
// out who is short of money.
//
// Two things on this page can change what users receive, and both are guarded:
//
//   * ENABLING the feature. On its own this notifies NOBODY — the state machine
//     seeds existing users silently and only future crossings alert. That is
//     the safe default and the page says so in plain Persian.
//
//   * The BACKFILL, which is the explicit "also tell the people who are already
//     low" action. It has its own confirmation screen showing the exact number
//     of messages it would produce before anything is queued.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

export const LB_ADMIN_CB = {
  root: "admin:lowbal:root",
  enable: "admin:lowbal:enable",
  disable: "admin:lowbal:disable",
  threshold: "admin:lowbal:threshold",
  margin: "admin:lowbal:margin",
  template: "admin:lowbal:template",
  preview: "admin:lowbal:preview",
  backfill: "admin:lowbal:backfill",
  backfillConfirm: "admin:lowbal:bf:go",
  backfillCancel: "admin:lowbal:bf:stop",
} as const;

/** Session flow keys for the two numeric entry screens. */
const FLOW_THRESHOLD = "lowbal:threshold";
const FLOW_MARGIN = "lowbal:margin";

const DEFAULT_TEMPLATE =
  "⚠️ موجودی کیف پول شما رو به اتمام است.\n\n" +
  "موجودی فعلی: {balance}\n" +
  "حد هشدار: {threshold}\n\n" +
  "برای جلوگیری از قطع شدن سرویس‌ها، کیف پول خود را شارژ کنید.";

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function backfillStatusLabel(status: LowBalanceBackfillStatus): string {
  switch (status) {
    case LowBalanceBackfillStatus.PENDING:
      return "در صف";
    case LowBalanceBackfillStatus.RUNNING:
      return "در حال اجرا";
    case LowBalanceBackfillStatus.COMPLETED:
      return "پایان‌یافته";
    case LowBalanceBackfillStatus.CANCELLED:
      return "لغو شده";
    case LowBalanceBackfillStatus.FAILED:
      return "ناموفق";
  }
}

function isBackfillActive(run: BackfillView | null): boolean {
  return (
    run !== null &&
    (run.status === LowBalanceBackfillStatus.PENDING ||
      run.status === LowBalanceBackfillStatus.RUNNING)
  );
}

function overviewText(overview: LowBalanceOverview, run: BackfillView | null): string {
  const lines = [
    "⚠️ <b>هشدار کاهش موجودی کیف پول</b>",
    "",
    `وضعیت: ${overview.config.enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    "",
    "<b>مرزها:</b>",
    ...describeBoundaries(overview.config).map((line) => `• ${line}`),
    "",
    "<b>وضعیت کاربران:</b>",
    `زیر حد هشدار: ${overview.belowThreshold}`,
    `هشدار داده‌شده: ${overview.alerted}`,
    `آمادهٔ هشدار: ${overview.armed}`,
    "",
    "<b>پیام‌ها:</b>",
    `در صف ارسال: ${overview.queued}`,
    `ارسال‌شده (۲۴ ساعت اخیر): ${overview.sentRecently}`,
    `لغوشده به دلیل شارژ مجدد (۲۴ ساعت اخیر): ${overview.cancelledRecovered}`,
    `ناموفق نهایی: ${overview.terminalFailures}`,
  ];
  if (run !== null) {
    lines.push(
      "",
      "<b>ارسال به کاربران کم‌موجودی فعلی:</b>",
      `وضعیت: ${backfillStatusLabel(run.status)}`,
      `بررسی‌شده: ${run.processedCount} — در صف: ${run.queuedCount} — رد‌شده: ${run.skippedCount}`,
    );
  }
  if (!overview.config.enabled) {
    lines.push(
      "",
      "فعال‌سازی به‌تنهایی هیچ پیامی ارسال نمی‌کند: فقط کاهش‌های بعدی هشدار می‌گیرند.",
    );
  }
  return lines.join("\n");
}

function overviewKeyboard(overview: LowBalanceOverview, run: BackfillView | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (overview.config.enabled) {
    kb.text("غیرفعال‌سازی ⛔", LB_ADMIN_CB.disable).row();
  } else {
    kb.text("فعال‌سازی ✅", LB_ADMIN_CB.enable).row();
  }
  kb.text(`حد هشدار: ${formatTomanAmount(overview.config.thresholdToman)}`, LB_ADMIN_CB.threshold)
    .row()
    .text(
      `فاصلهٔ آماده‌سازی دوباره: ${formatTomanAmount(overview.config.rearmMarginToman)}`,
      LB_ADMIN_CB.margin,
    )
    .row()
    .text("متن پیام ✏️", LB_ADMIN_CB.template)
    .row()
    .text("پیش‌نمایش پیام 👁", LB_ADMIN_CB.preview)
    .row();
  if (isBackfillActive(run)) {
    kb.text("توقف ارسال به کاربران کم‌موجودی ⏹", LB_ADMIN_CB.backfillCancel).row();
  } else if (overview.config.enabled) {
    kb.text("ارسال برای کاربران کم‌موجودی فعلی 📣", LB_ADMIN_CB.backfill).row();
  }
  kb.text("بروزرسانی ♻️", LB_ADMIN_CB.root)
    .row()
    .text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  const [overview, run] = await Promise.all([getLowBalanceOverview(), getLatestBackfill()]);
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, overviewText(overview, run), overviewKeyboard(overview, run), {
    parseMode: "HTML",
  });
}

export const lowBalanceAdminHandler = new Composer<BotContext>();

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = null;
  await renderOverview(ctx);
  ctx.session.lastMenu = LB_ADMIN_CB.root;
});

// --- master switch ------------------------------------------------------------

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.enable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  if (!(await compareAndSetBooleanSetting(LOW_BALANCE_ENABLED_KEY, false, true))) {
    await renderOverview(ctx, "این قابلیت از قبل فعال است.");
    return;
  }
  clearSettingsCache();
  logger.info("low-balance notifications enabled", { adminId: admin.id });
  await renderOverview(ctx, "فعال شد ✅ — فقط کاهش‌های بعدی هشدار می‌گیرند.");
});

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.disable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const flipped = await compareAndSetBooleanSetting(LOW_BALANCE_ENABLED_KEY, true, false);
  if (flipped) {
    clearSettingsCache();
    logger.info("low-balance notifications disabled", { adminId: admin.id });
  }
  await renderOverview(ctx, flipped ? "غیرفعال شد." : "این قابلیت از قبل غیرفعال است.");
});

// --- boundaries ---------------------------------------------------------------

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.threshold, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = FLOW_THRESHOLD;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "حد هشدار را بر حسب <b>تومان</b> ارسال کنید (فقط عدد صحیح).",
      "",
      "وقتی موجودی کاربر به این مقدار یا کمتر برسد، یک هشدار ارسال می‌شود.",
    ].join("\n"),
    new InlineKeyboard().text("انصراف", LB_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.margin, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = FLOW_MARGIN;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "فاصلهٔ آماده‌سازی دوباره را بر حسب <b>تومان</b> ارسال کنید (فقط عدد صحیح).",
      "",
      "کاربر تا وقتی موجودی‌اش از «حد هشدار + این مقدار» بیشتر نشود، هشدار دوباره نمی‌گیرد.",
      "مقدار صفر یعنی به‌محض عبور از حد هشدار، دوباره آماده می‌شود (پرسروصداترین حالت).",
    ].join("\n"),
    new InlineKeyboard().text("انصراف", LB_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

// --- message template ---------------------------------------------------------

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.template, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const template = await getMessageTemplate(LOW_BALANCE_TEMPLATE_KEY, DEFAULT_TEMPLATE);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "✏️ <b>متن پیام هشدار</b>",
      "",
      "متن فعلی:",
      `<pre>${escapeHtml(template)}</pre>`,
      "",
      "جای‌گذاری‌ها: <code>{balance}</code> موجودی فعلی، <code>{threshold}</code> حد هشدار.",
      "",
      "برای ویرایش از بخش «مدیریت متن‌ها» استفاده کنید.",
    ].join("\n"),
    new InlineKeyboard().text("بازگشت", LB_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.preview, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const [config, template] = await Promise.all([
    getLowBalanceConfig(),
    getMessageTemplate(LOW_BALANCE_TEMPLATE_KEY, DEFAULT_TEMPLATE),
  ]);
  // Rendered with SAMPLE numbers only; no real user is read for the preview.
  const sampleBalance = Math.max(0, config.thresholdToman - 5_000);
  const rendered = template
    .replaceAll("{balance}", formatTomanAmount(sampleBalance))
    .replaceAll("{threshold}", formatTomanAmount(config.thresholdToman));
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    ["👁 <b>پیش‌نمایش</b> (نمونه — به هیچ کاربری ارسال نمی‌شود)", "", escapeHtml(rendered)].join(
      "\n",
    ),
    new InlineKeyboard().text("بازگشت", LB_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

// --- backfill (§12) -----------------------------------------------------------

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.backfill, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const config = await getLowBalanceConfig();
  if (!config.enabled) {
    await renderOverview(ctx, "ابتدا این قابلیت را فعال کنید.");
    return;
  }
  const candidates = await countBackfillCandidates(config);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "📣 <b>ارسال برای کاربران کم‌موجودی فعلی</b>",
      "",
      "این کار برای کاربرانی که <b>هم‌اکنون</b> زیر حد هشدار هستند پیام می‌فرستد.",
      "حالت پیش‌فرض و امن «فقط کاهش‌های بعدی» است؛ این گزینه استثناست.",
      "",
      `حد هشدار: ${formatTomanAmount(config.thresholdToman)}`,
      "",
      // An ESTIMATE, and labelled as one. The number is measured now; the run
      // re-checks balance, status and preferences for every single user before
      // it queues anything, so the count that is finally sent can only be this
      // or lower. Presenting it as "messages that will be sent" claimed a
      // certainty no honest implementation can have.
      `<b>برآورد دریافت‌کنندگان واجد شرایط در حال حاضر: ${candidates.expectedRecipients}</b>`,
      "",
      "تعداد نهایی ارسال‌شده ممکن است کمتر باشد: پیش از ثبت و پیش از ارسال،",
      "موجودی و تنظیمات هر کاربر دوباره بررسی می‌شود.",
      "",
      "<b>جزئیات:</b>",
      `زیر حد هشدار: ${candidates.belowThreshold}`,
      `خاموش‌کرده هشدار موجودی: ${candidates.lowBalanceOptOuts}`,
      `خاموش‌کرده اعلان‌های پرداخت: ${candidates.paymentCategoryOptOuts}`,
      `از قبل هشدار گرفته: ${candidates.alreadyNotified}`,
      "",
      "ادامه می‌دهید؟",
    ].join("\n"),
    new InlineKeyboard()
      .text("بله، ارسال شود ✅", LB_ADMIN_CB.backfillConfirm)
      .row()
      .text("انصراف", LB_ADMIN_CB.root),
    { parseMode: "HTML" },
  );
});

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.backfillConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const result = await startLowBalanceBackfill(admin.id);
  if (!result.ok) {
    // Three distinct reasons, three distinct messages. Reporting an unrelated
    // database fault as "already running" told the OWNER a run existed when
    // none did, and hid the real problem.
    const toast =
      result.reason === "disabled"
        ? "ابتدا این قابلیت را فعال کنید."
        : result.reason === "already-running"
          ? "یک اجرا از قبل در جریان است."
          : "اجرا آغاز نشد. لطفاً دوباره تلاش کنید.";
    await renderOverview(ctx, toast);
    return;
  }
  logger.info("low-balance backfill started", {
    adminId: admin.id,
    expectedRecipients: result.candidates.expectedRecipients,
  });
  await renderOverview(ctx, "اجرا آغاز شد ✅");
});

lowBalanceAdminHandler.callbackQuery(LB_ADMIN_CB.backfillCancel, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const cancelled = await cancelLowBalanceBackfill();
  if (cancelled) {
    logger.info("low-balance backfill cancelled", { adminId: admin.id });
  }
  await renderOverview(
    ctx,
    cancelled ? "اجرا متوقف شد. پیام‌های ارسال‌شده بازگردانده نمی‌شوند." : "اجرای فعالی وجود ندارد.",
  );
});

// --- numeric entry (self-gating on currentFlow) -------------------------------

export const lowBalanceAdminTextHandler = new Composer<BotContext>();

lowBalanceAdminTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow !== FLOW_THRESHOLD && flow !== FLOW_MARGIN) {
    return next();
  }
  if (ctx.admin === null || ctx.admin.role !== "OWNER") {
    ctx.session.currentFlow = null;
    return next();
  }
  // Accepts Persian/Arabic digits and thousands separators; rejects decimals,
  // because a fractional Toman cannot exist in the canonical INTEGER column.
  const parsed = parseTomanAmount(ctx.message.text);
  if (!parsed.ok) {
    await safeReply(
      ctx,
      parsed.error === "NOT_AN_INTEGER"
        ? "مبلغ باید عدد صحیح تومان باشد (بدون اعشار)."
        : parsed.error === "NEGATIVE"
          ? "مبلغ نمی‌تواند منفی باشد."
          : parsed.error === "TOO_LARGE"
            ? "این مقدار از سقف مجاز موجودی بیشتر است."
            : "لطفاً فقط یک عدد معتبر ارسال کنید.",
    );
    return;
  }

  const result =
    flow === FLOW_THRESHOLD
      ? await setLowBalanceThreshold(parsed.value)
      : await setLowBalanceRearmMargin(parsed.value);
  if (!result.ok) {
    await safeReply(
      ctx,
      result.reason === "would-overflow"
        ? "این مقدار به همراه مقدار دیگر از سقف مجاز موجودی بیشتر می‌شود."
        : "مقدار خارج از محدودهٔ مجاز است.",
    );
    return;
  }
  ctx.session.currentFlow = null;
  logger.info("low-balance boundary changed", {
    adminId: ctx.admin.id,
    field: flow === FLOW_THRESHOLD ? "threshold" : "margin",
  });

  const [overview, run] = await Promise.all([getLowBalanceOverview(), getLatestBackfill()]);
  await safeReply(ctx, overviewText(overview, run), overviewKeyboard(overview, run), {
    parseMode: "HTML",
  });
});
