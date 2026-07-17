import { OPS_LOG_TOPIC_KEYS, type OpsLogTopicKey } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  classifyTelegramError,
  disconnectLogGroup,
  ensureDefaultTopics,
  getLogGroupSettings,
  getLogGroupStatus,
  listOpsTopics,
  maskChatId,
  saveLogGroup,
  setTopicEnabled,
  syncTopics,
  testLogGroup,
} from "../../services/log-group.service.js";
import { OPS_EVENTS, writeSystemLog } from "../../services/system-log.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «تنظیمات گروه لاگ 📝» (ops-logging phase) - binding the Telegram log group
// (via /setloggroup INSIDE the group), managing the forum topics and test
// sends. The binding itself is OWNER-only end to end; the status page is
// admin-readable. Chat ids are always masked in page output; Telegram
// failures are classified into safe Persian lines and raw API descriptions
// never reach the admin. Real log deliveries are the worker's job - this
// page only sends explicit TEST messages.
// =============================================================================

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const NOT_IN_GROUP_TEXT = "این دستور باید داخل گروه لاگ اجرا شود.";
const NOT_FORUM_TEXT =
  "قابلیت موضوعات گروه فعال نیست. ابتدا Topics را در تنظیمات گروه فعال کنید.";
const BOT_NOT_ADMIN_TEXT = "ربات باید در این گروه مدیر باشد.";
const BOT_RIGHTS_INCOMPLETE_TEXT = "دسترسی ارسال پیام یا مدیریت موضوعات کامل نیست.";
const GROUP_SAVED_TEXT = "این گروه به‌عنوان گروه لاگ ربات ثبت شد ✅";

export const LG_CB = {
  root: "admin:lg",
  check: "admin:lg:check",
  test: "admin:lg:test",
  ensure: "admin:lg:ensure",
  sync: "admin:lg:sync",
  topics: "admin:lg:topics",
  topicToggle: (key: OpsLogTopicKey): string => `admin:lg:tt:${key}`,
  topicTest: (key: OpsLogTopicKey): string => `admin:lg:tx:${key}`,
  disconnect: "admin:lg:disc",
  disconnectYes: "admin:lg:disc_yes",
  /** Sent from the replacement-confirmation message INSIDE the new group. */
  replaceYes: "admin:lg:rep",
  replaceCancel: "admin:lg:rep_no",
} as const;

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

function formatTime(when: Date): string {
  return `${when.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

// --- /setloggroup (registered at bot level - must work inside group chats) ---------------------

export const setLogGroupCommand = new Composer<BotContext>();

/**
 * Full environment validation for binding THIS chat as the log group.
 * Returns null when everything is fine, otherwise the safe Persian error.
 */
async function validateLogGroupChat(ctx: BotContext): Promise<string | null> {
  const chat = ctx.chat;
  if (chat === undefined || chat.type !== "supergroup") {
    return NOT_IN_GROUP_TEXT;
  }
  if (chat.is_forum !== true) {
    return NOT_FORUM_TEXT;
  }
  try {
    const me = await ctx.getChatMember(ctx.me.id);
    if (me.status !== "administrator") {
      return BOT_NOT_ADMIN_TEXT;
    }
    if (me.can_manage_topics !== true) {
      return BOT_RIGHTS_INCOMPLETE_TEXT;
    }
  } catch {
    return BOT_NOT_ADMIN_TEXT;
  }
  return null;
}

/** Persists the binding, seeds the topics and confirms - shared save path. */
async function applyLogGroupBinding(ctx: BotContext): Promise<void> {
  const chat = ctx.chat;
  const admin = ctx.admin;
  if (chat === undefined || admin === null) {
    return;
  }
  const title = "title" in chat && typeof chat.title === "string" ? chat.title : "بدون نام";
  await saveLogGroup(String(chat.id), title);
  const ensured = await ensureDefaultTopics(ctx.api);
  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.LOG_GROUP_CHANGED,
    message: "operational log group was (re)configured",
    metadata: { topicCreated: ensured.createdCount, topicFailed: ensured.failedCount },
    topicKey: "SECURITY",
    adminId: admin.id,
  });
  logger.info("log group configured", { adminId: admin.id });
  const lines = [GROUP_SAVED_TEXT];
  if (ensured.createdCount > 0) {
    lines.push(`موضوعات ساخته‌شده: ${ensured.createdCount}`);
  }
  if (ensured.failedCount > 0 && ensured.safeMessage !== null) {
    lines.push(`⚠️ ${ensured.failedCount} موضوع ساخته نشد: ${ensured.safeMessage}`);
  }
  await safeReply(ctx, lines.join("\n"));
}

setLogGroupCommand.command("setloggroup", async (ctx) => {
  // OWNER verification by the SENDER's telegram id (attach-user already
  // resolved it) - the admin-area gate does not run for group commands.
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeReply(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const problem = await validateLogGroupChat(ctx);
  if (problem !== null) {
    await safeReply(ctx, problem);
    return;
  }
  const chat = ctx.chat;
  if (chat === undefined) {
    return;
  }
  const existing = await getLogGroupSettings();
  if (existing.chatId !== null && existing.chatId !== String(chat.id)) {
    // A DIFFERENT group is already bound - require explicit confirmation.
    await safeReply(
      ctx,
      [
        "یک گروه لاگ دیگر قبلاً تنظیم شده است:",
        `${existing.title ?? "بدون نام"} (${maskChatId(existing.chatId)})`,
        "",
        "آیا گروه فعلی جایگزین شود؟",
      ].join("\n"),
      new InlineKeyboard()
        .text("تایید جایگزینی ✅", LG_CB.replaceYes)
        .row()
        .text("انصراف", LG_CB.replaceCancel),
    );
    return;
  }
  await applyLogGroupBinding(ctx);
});

// --- admin-area composer -----------------------------------------------------------------------

export const logGroupHandler = new Composer<BotContext>();

// Replacement confirmation - pressed INSIDE the candidate group, so the
// chat of THIS callback is the group being bound. Everything is re-verified
// (the confirmation may be stale or forwarded).
logGroupHandler.callbackQuery(LG_CB.replaceYes, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const problem = await validateLogGroupChat(ctx);
  if (problem !== null) {
    await safeAnswerCallback(ctx, problem);
    return;
  }
  await safeAnswerCallback(ctx);
  await applyLogGroupBinding(ctx);
});

logGroupHandler.callbackQuery(LG_CB.replaceCancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx, "لغو شد.");
  await safeEditOrReply(
    ctx,
    "جایگزینی گروه لاگ لغو شد.",
    new InlineKeyboard().text("بازگشت", LG_CB.root),
  );
});

async function renderLogGroupPage(ctx: BotContext, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  const status = await getLogGroupStatus();
  const lines = ["تنظیمات گروه لاگ 📝", ""];
  if (!status.configured) {
    lines.push(
      "وضعیت: تنظیم نشده ❌",
      "",
      "برای اتصال، ربات را در یک سوپرگروه با قابلیت Topics مدیر کنید و دستور /setloggroup را داخل همان گروه بفرستید.",
    );
  } else {
    lines.push(
      "وضعیت: متصل ✅",
      `نام گروه: ${status.title ?? "بدون نام"}`,
      `شناسه گروه: ${status.chatId === null ? "-" : maskChatId(status.chatId)}`,
      `موضوعات فعال: ${status.enabledTopicCount} از ${status.totalTopicCount}`,
      `آخرین ارسال موفق: ${status.lastSuccessAt === null ? "—" : formatTime(status.lastSuccessAt)}`,
      `آخرین خطا: ${status.lastError === null ? "—" : `${status.lastError.code} (${formatTime(status.lastError.at)})`}`,
    );
  }
  const kb = new InlineKeyboard()
    .text("بررسی اتصال 🧪", LG_CB.check)
    .row()
    .text("ارسال پیام آزمایشی", LG_CB.test)
    .row()
    .text("ساخت موضوعات پیش‌فرض", LG_CB.ensure)
    .row()
    .text("همگام‌سازی موضوعات", LG_CB.sync)
    .row()
    .text("مدیریت موضوعات", LG_CB.topics)
    .row()
    .text("قطع اتصال گروه", LG_CB.disconnect)
    .row()
    .text("بازگشت", CB.ADMIN_GENERAL_SETTINGS);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

logGroupHandler.callbackQuery(LG_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLogGroupPage(ctx);
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
    await renderLogGroupPage(ctx, "گروه لاگ هنوز تنظیم نشده است.");
    return;
  }
  let toast: string;
  try {
    const me = await ctx.api.getChatMember(settings.chatId, ctx.me.id);
    if (me.status !== "administrator") {
      toast = BOT_NOT_ADMIN_TEXT;
    } else if (me.can_manage_topics !== true) {
      toast = BOT_RIGHTS_INCOMPLETE_TEXT;
    } else {
      toast = "اتصال گروه لاگ برقرار است ✅";
    }
  } catch (err) {
    toast = classifyTelegramError(err);
  }
  await renderLogGroupPage(ctx, toast);
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
