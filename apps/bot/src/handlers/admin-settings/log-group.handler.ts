import { LogGroupSetupStatus } from "@zedbot/database";
import {
  LOG_GROUP_STARTGROUP_PAYLOAD,
  OPS_LOG_TOPIC_KEYS,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  getActiveSetupAttempt,
  verifyBoundGroupConnection,
  type LogGroupProbeApi,
} from "../../services/log-group-connection.service.js";
import {
  disconnectLogGroup,
  ensureDefaultTopics,
  getLogGroupSettings,
  getLogGroupStatus,
  listOpsTopics,
  LOG_GROUP_NOT_CONFIGURED_TEXT,
  maskChatId,
  setTopicEnabled,
  syncTopics,
  testLogGroup,
} from "../../services/log-group.service.js";
import {
  getLogGroupSetupQueueCounts,
  readWorkerHeartbeat,
} from "../../services/ops-queue.service.js";
import { OPS_EVENTS, writeSystemLog } from "../../services/system-log.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

/** Persian label per setup-attempt status (status BODY + progress page). */
export const LG_ATTEMPT_STATUS_LABELS: Record<LogGroupSetupStatus, string> = {
  [LogGroupSetupStatus.VALIDATED]: "در انتظار تایید",
  [LogGroupSetupStatus.QUEUED]: "در صف",
  [LogGroupSetupStatus.PROVISIONING]: "در حال ساخت تاپیک‌ها",
  [LogGroupSetupStatus.TESTING]: "در حال ارسال پیام آزمایشی",
  [LogGroupSetupStatus.ACTIVE]: "فعال",
  [LogGroupSetupStatus.FAILED]: "ناموفق",
  [LogGroupSetupStatus.CANCELLED]: "لغو شده",
};

// =============================================================================
// «تنظیمات گروه لاگ 📝» (ops-logging phase + log-group wizard) - the admin
// status page, the connection wizard («اتصال گروه لاگ ➕» with the
// start-group URL button), the forum-topic management and test sends. The
// page is STATE-DEPENDENT: an unconfigured binding only offers the wizard /
// guide / recheck actions (never test or topic management), a configured one
// offers the full toolset. The binding itself completes INSIDE the candidate
// group (log-group-setup.handler.ts) and is OWNER-only end to end; the
// status page is admin-readable. Chat ids are always masked in page output;
// Telegram failures are classified into safe Persian lines and raw API
// descriptions never reach the admin. Real log deliveries are the worker's
// job - this page only sends explicit TEST messages.
// =============================================================================

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const CONNECTION_OK_TEXT = "اتصال گروه لاگ برقرار است ✅";

export const LG_CB = {
  root: "admin:lg",
  /**
   * Direct numeric-ID setup entry (both «اتصال با آیدی عددی گروه 🔢» when
   * unbound and «تغییر گروه با آیدی عددی 🔄» when bound). The flow itself
   * lives in log-group-id.handler.ts; the string is registered there.
   */
  id: "admin:lg:id",
  /** Connection wizard - also reachable via «تغییر گروه لاگ» when bound. */
  connect: "admin:lg:connect",
  guide: "admin:lg:guide",
  recheck: "admin:lg:recheck",
  check: "admin:lg:check",
  test: "admin:lg:test",
  ensure: "admin:lg:ensure",
  sync: "admin:lg:sync",
  topics: "admin:lg:topics",
  topicToggle: (key: OpsLogTopicKey): string => `admin:lg:tt:${key}`,
  topicTest: (key: OpsLogTopicKey): string => `admin:lg:tx:${key}`,
  disconnect: "admin:lg:disc",
  disconnectYes: "admin:lg:disc_yes",
} as const;

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

function formatTime(when: Date): string {
  return `${when.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

// --- admin-area composer -----------------------------------------------------------------------

export const logGroupHandler = new Composer<BotContext>();

export async function renderLogGroupPage(ctx: BotContext, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  // The richer status block: connection state (with an in-flight setup made
  // visible), topic readiness, worker liveness and the setup-queue depth all
  // come from the shared services - no chat id ever leaves the page unmasked.
  const [status, activeAttempt, heartbeat, queueCounts] = await Promise.all([
    getLogGroupStatus(),
    getActiveSetupAttempt(),
    readWorkerHeartbeat(),
    getLogGroupSetupQueueCounts(),
  ]);
  const connectionState =
    activeAttempt !== null
      ? "در حال راه‌اندازی"
      : status.configured
        ? "متصل ✅"
        : "تنظیم نشده";
  // §16: richer, secret-free setup-queue depth (waiting/active/delayed/failed).
  const queueLine =
    queueCounts === null
      ? "صف راه‌اندازی: نامشخص"
      : `صف راه‌اندازی: ${queueCounts.waiting} در انتظار | ${queueCounts.active} فعال | ${queueCounts.delayed} با تاخیر | ${queueCounts.failed} ناموفق`;
  const lines = [
    "تنظیمات گروه لاگ 📝",
    "",
    `وضعیت اتصال: ${connectionState}`,
    `نام گروه: ${status.title ?? "بدون نام"}`,
    `شناسه گروه: ${status.chatId === null ? "-" : maskChatId(status.chatId)}`,
    // Current-group readiness breakdown (never old-group counts): ready
    // (enabled + bound), bound, and needing (re)creation.
    `تاپیک‌های آماده: ${status.enabledTopicCount} از ${status.totalTopicCount}`,
    `متصل به گروه فعلی: ${status.boundTopicCount} | نیازمند ساخت/تعمیر: ${status.invalidatedTopicCount}`,
    // The heartbeat key carries a TTL, so its very presence means "alive
    // recently" - readWorkerHeartbeat returns null when absent/unreachable.
    `Worker: ${heartbeat !== null ? "فعال ✅" : "غیرفعال ❌"}`,
    queueLine,
    `آخرین ارسال موفق: ${status.lastSuccessAt === null ? "—" : formatTime(status.lastSuccessAt)}`,
    `آخرین خطا: ${status.lastError === null ? "—" : `${status.lastError.code} (${formatTime(status.lastError.at)})`}`,
  ];
  if (activeAttempt !== null) {
    lines.push(
      `عملیات راه‌اندازی: ${LG_ATTEMPT_STATUS_LABELS[activeAttempt.status]}`,
      `تاپیک‌های ساخته‌شده: ${activeAttempt.createdTopicCount} از ${status.totalTopicCount}`,
    );
    if (activeAttempt.safeErrorCode !== null) {
      lines.push(`آخرین کد خطای راه‌اندازی: ${activeAttempt.safeErrorCode}`);
    }
  }
  const kb = new InlineKeyboard();
  if (!status.configured) {
    // Unconfigured: numeric-ID setup FIRST, then the add-bot wizard / guide /
    // recheck - no test/topic actions exist for a binding that is not there.
    kb.text("اتصال با آیدی عددی گروه 🔢", LG_CB.id)
      .row()
      .text("افزودن ربات به گروه ➕", LG_CB.connect)
      .row()
      .text("راهنمای ساخت گروه", LG_CB.guide)
      .row()
      .text("بررسی مجدد اتصال ♻️", LG_CB.recheck)
      .row()
      .text("بازگشت", CB.ADMIN_GENERAL_SETTINGS);
  } else {
    kb.text("بررسی اتصال 🧪", LG_CB.check)
      .row()
      .text("ارسال پیام آزمایشی", LG_CB.test)
      .row()
      .text("ساخت / تعمیر موضوعات پیش‌فرض", LG_CB.ensure)
      .row()
      .text("همگام‌سازی موضوعات", LG_CB.sync)
      .row()
      .text("مدیریت موضوعات", LG_CB.topics)
      .row()
      .text("تغییر گروه با آیدی عددی 🔄", LG_CB.id)
      .row()
      .text("افزودن ربات به گروه دیگر ➕", LG_CB.connect)
      .row()
      .text("قطع اتصال گروه", LG_CB.disconnect)
      .row()
      .text("بازگشت", CB.ADMIN_GENERAL_SETTINGS);
  }
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

logGroupHandler.callbackQuery(LG_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLogGroupPage(ctx);
});

// --- connection wizard -------------------------------------------------------------------------

/** Exact wizard body (log-group wizard spec) - do not reword. */
const WIZARD_BODY = [
  "📝 اتصال گروه لاگ",
  "",
  "۱. یک سوپرگروه خصوصی بسازید.",
  "۲. قابلیت موضوعات یا Topics را فعال کنید.",
  "۳. ربات را با دسترسی ارسال پیام و مدیریت موضوعات، مدیر گروه کنید.",
  "۴. دکمه زیر را بزنید و گروه را انتخاب کنید.",
  "۵. داخل گروه، اتصال را تایید کنید.",
].join("\n");

// «اتصال گروه لاگ ➕» / «تغییر گروه لاگ»: the start-group URL button lets
// the OWNER pick the group; Telegram then posts "/start zedlog" inside it,
// which the group-side setup composer turns into the confirmation prompt.
// OWNER-only because the binding it starts is OWNER-only end to end.
logGroupHandler.callbackQuery(LG_CB.connect, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const settings = await getLogGroupSettings();
  const lines: string[] = [];
  if (settings.chatId !== null) {
    // Reached via «تغییر گروه لاگ» - warn that confirming a new group
    // replaces the current binding.
    lines.push(
      `⚠️ گروه لاگ فعلی: ${settings.title ?? "بدون نام"} (${maskChatId(settings.chatId)})`,
      "با تایید گروه جدید، گروه فعلی جایگزین می‌شود.",
      "",
    );
  }
  lines.push(WIZARD_BODY);
  // NEVER hardcode the bot username - ctx.me carries the live identity.
  const kb = new InlineKeyboard()
    .url(
      "افزودن ربات به گروه ➕",
      `https://t.me/${ctx.me.username}?startgroup=${LOG_GROUP_STARTGROUP_PAYLOAD}`,
    )
    .row()
    .text("بررسی مجدد اتصال ♻️", LG_CB.recheck)
    .row()
    .text("انصراف", LG_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
});

// «راهنمای ساخت گروه»: static help for building a wizard-ready group.
logGroupHandler.callbackQuery(LG_CB.guide, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "راهنمای ساخت گروه لاگ 📝",
      "",
      "۱. در تلگرام یک گروه جدید بسازید و آن را خصوصی نگه دارید (سوپرگروه).",
      "۲. در تنظیمات گروه، قابلیت موضوعات (Topics) را فعال کنید.",
      "۳. ربات را به گروه اضافه کنید و آن را مدیر گروه کنید.",
      "۴. در دسترسی‌های مدیر، «ارسال پیام» و «مدیریت موضوعات» را فعال کنید.",
      "۵. از صفحه «اتصال گروه لاگ ➕» دکمه افزودن ربات را بزنید، یا دستور /setloggroup را داخل همان گروه بفرستید.",
      "۶. داخل گروه، دکمه «تایید اتصال گروه ✅» را بزنید تا اتصال ثبت شود.",
    ].join("\n"),
    new InlineKeyboard().text("بازگشت", LG_CB.root),
  );
});

/** Probe surface over the live grammY api (supplies the bot id). */
function buildProbeApi(ctx: BotContext): LogGroupProbeApi {
  return {
    getChat: (chatId) => ctx.api.getChat(chatId),
    getChatMember: (chatId, userId) => ctx.api.getChatMember(chatId, userId),
    me: { id: ctx.me.id },
  };
}

/**
 * Full read-only health check of the BOUND group against the shared target
 * policy (§10): chat exists, is a supergroup, forum still on, bot still a
 * member + admin, manage-topics still granted, sending not restricted. Sends
 * nothing into the group. Returns the toast line (safe message or OK).
 */
async function verifyBoundGroupRights(ctx: BotContext, chatId: string): Promise<string> {
  const verdict = await verifyBoundGroupConnection(buildProbeApi(ctx), chatId);
  return verdict.ok ? CONNECTION_OK_TEXT : verdict.safeMessage;
}

// «بررسی مجدد اتصال ♻️» (wizard poll): re-reads the binding state and, when
// configured, re-verifies the bot's rights like «بررسی اتصال 🧪» does, then
// lands back on the state-dependent root page - so the OWNER sees the
// configured page as soon as the group-side confirmation completes.
// Read-only, hence admin-readable like the status page itself.
logGroupHandler.callbackQuery(LG_CB.recheck, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const settings = await getLogGroupSettings();
  if (settings.chatId === null) {
    await renderLogGroupPage(ctx, LOG_GROUP_NOT_CONFIGURED_TEXT);
    return;
  }
  await renderLogGroupPage(ctx, await verifyBoundGroupRights(ctx, settings.chatId));
});

// «بررسی اتصال 🧪»: verifies the binding + the bot's rights WITHOUT sending
// anything into the group.
logGroupHandler.callbackQuery(LG_CB.check, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const settings = await getLogGroupSettings();
  if (settings.chatId === null) {
    await renderLogGroupPage(ctx, LOG_GROUP_NOT_CONFIGURED_TEXT);
    return;
  }
  await renderLogGroupPage(ctx, await verifyBoundGroupRights(ctx, settings.chatId));
});

logGroupHandler.callbackQuery(LG_CB.test, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const result = await testLogGroup(ctx.api);
  await renderLogGroupPage(ctx, result.safeMessage);
});

logGroupHandler.callbackQuery(LG_CB.ensure, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const result = await ensureDefaultTopics(ctx.api);
  const toast =
    result.safeMessage !== null && !result.ok
      ? result.safeMessage
      : `موضوعات آماده شد ✅ (جدید: ${result.createdCount} | موجود: ${result.existingCount})`;
  await renderLogGroupPage(ctx, toast);
});

logGroupHandler.callbackQuery(LG_CB.sync, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const report = await syncTopics();
  const lines = [
    "همگام‌سازی موضوعات 🔄",
    "",
    `آماده: ${report.ready} از ${report.total}`,
  ];
  if (report.missing.length > 0) {
    lines.push(`بدون موضوع: ${report.missing.join("، ")}`);
  }
  if (report.mismatched.length > 0) {
    lines.push(`متصل به گروه دیگر: ${report.mismatched.join("، ")}`);
  }
  if (report.missing.length > 0 || report.mismatched.length > 0) {
    lines.push("", "برای ساخت/اصلاح، «ساخت موضوعات پیش‌فرض» را اجرا کنید.");
  } else {
    lines.push("", "همه موضوعات با گروه فعلی همگام هستند ✅");
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text("بازگشت", LG_CB.root),
  );
});

async function renderTopicsPage(ctx: BotContext, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  const topics = await listOpsTopics();
  const kb = new InlineKeyboard();
  for (const topic of topics) {
    kb.text(
      `${topic.isEnabled ? "✅" : "❌"} ${topic.title}`,
      LG_CB.topicToggle(topic.key),
    )
      .text("ارسال تست", LG_CB.topicTest(topic.key))
      .row();
  }
  kb.text("بازگشت", LG_CB.root);
  await safeEditOrReply(
    ctx,
    [
      "مدیریت موضوعات گروه لاگ",
      "",
      "با دکمه اول هر ردیف، ارسال لاگ آن موضوع فعال/غیرفعال می‌شود.",
      "غیرفعال کردن فقط ارسال را متوقف می‌کند؛ لاگ‌ها همچنان ذخیره می‌شوند.",
    ].join("\n"),
    kb,
  );
}

logGroupHandler.callbackQuery(LG_CB.topics, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderTopicsPage(ctx);
});

/** Callback param -> stable topic key; unknown/forged values fail safe. */
function parseTopicKey(raw: string): OpsLogTopicKey | null {
  return (OPS_LOG_TOPIC_KEYS as readonly string[]).includes(raw)
    ? (raw as OpsLogTopicKey)
    : null;
}

logGroupHandler.callbackQuery(/^admin:lg:tt:([A-Z_]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const key = parseTopicKey(ctx.match[1]);
  if (key === null) {
    await safeAnswerCallback(ctx, "موضوع نامعتبر است.");
    return;
  }
  const topics = await listOpsTopics();
  const current = topics.find((t) => t.key === key);
  const next = !(current?.isEnabled ?? true);
  await setTopicEnabled(key, next);
  await renderTopicsPage(ctx, next ? "موضوع فعال شد ✅" : "موضوع غیرفعال شد.");
});

logGroupHandler.callbackQuery(/^admin:lg:tx:([A-Z_]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const key = parseTopicKey(ctx.match[1]);
  if (key === null) {
    await safeAnswerCallback(ctx, "موضوع نامعتبر است.");
    return;
  }
  const result = await testLogGroup(ctx.api, key);
  await renderTopicsPage(ctx, result.ok ? "پیام آزمایشی ارسال شد ✅" : result.safeMessage);
});

logGroupHandler.callbackQuery(LG_CB.disconnect, async (ctx) => {
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
    "قطع اتصال گروه لاگ\n\nارسال لاگ‌ها به گروه متوقف می‌شود؛ موضوعات و تاریخچه حذف نمی‌شوند. ادامه می‌دهید؟",
    new InlineKeyboard()
      .text("بله، قطع اتصال", LG_CB.disconnectYes)
      .row()
      .text("انصراف", LG_CB.root),
  );
});

logGroupHandler.callbackQuery(LG_CB.disconnectYes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await disconnectLogGroup();
  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.LOG_GROUP_CHANGED,
    message: "operational log group was disconnected",
    topicKey: "SECURITY",
    adminId: admin.id,
  });
  logger.info("log group disconnected", { adminId: admin.id });
  await renderLogGroupPage(ctx, "اتصال گروه لاگ قطع شد.");
});
