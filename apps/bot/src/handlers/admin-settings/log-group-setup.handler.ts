import { prisma } from "@zedbot/database";
import { errorMessage, LOG_GROUP_STARTGROUP_PAYLOAD } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  BOT_NOT_ADMIN_TEXT,
  BOT_RIGHTS_INCOMPLETE_TEXT,
  ensureDefaultTopics,
  getLogGroupSettings,
  maskChatId,
  NOT_FORUM_TEXT,
  NOT_IN_GROUP_TEXT,
  saveLogGroup,
  testLogGroup,
} from "../../services/log-group.service.js";
import { OPS_EVENTS, writeSystemLog } from "../../services/system-log.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { getStartPayload } from "../../utils/telegram.js";

// =============================================================================
// GROUP-SIDE completion of the log-group connection wizard (legacy-upgrade /
// log-group-wizard phase). Both entry points - the /setloggroup command and
// the "/start zedlog" message Telegram posts when the wizard's start-group
// URL button adds the bot to a group - land on ONE confirmation prompt inside
// the candidate group; the binding itself only happens on the explicit
// «تایید اتصال گروه ✅» press. This composer is registered at BOT level,
// BEFORE the generic startHandler (the start-group payload must be consumed
// before the generic /start) and OUTSIDE the admin: callback gate (the admin
// area only covers private-chat admin:* callbacks) - so every handler here
// re-verifies the sender/presser is an active OWNER admin itself, and the
// confirm press re-validates the whole environment because the prompt may be
// stale or forwarded. Chat ids are only ever shown masked.
// =============================================================================

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
export const GROUP_SAVED_TEXT = "این گروه به‌عنوان گروه لاگ ربات ثبت شد ✅";
export const SETUP_CONFIRM_TEXT = "این گروه به‌عنوان گروه لاگ ربات ثبت شود؟";
export const SETUP_CANCELLED_TEXT = "اتصال گروه لاگ لغو شد.";
const NOT_GROUP_MEMBER_TEXT = "برای تایید اتصال باید عضو همین گروه باشید.";

export const LGSET_CB = {
  yes: "lgset:yes",
  no: "lgset:no",
} as const;

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

/**
 * Full environment validation for binding THIS chat as the log group.
 * Returns null when everything is fine, otherwise the safe Persian error.
 */
export async function validateLogGroupChat(ctx: BotContext): Promise<string | null> {
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
    // The Bot API exposes no per-admin "send messages" flag for supergroups
    // (can_post_messages exists for channels only, can_send_messages for
    // RESTRICTED members only) - administrator status honestly implies send
    // rights here, so can_manage_topics is the only explicit right to check.
    if (me.can_manage_topics !== true) {
      return BOT_RIGHTS_INCOMPLETE_TEXT;
    }
  } catch {
    return BOT_NOT_ADMIN_TEXT;
  }
  return null;
}

/**
 * Shared entry for BOTH group-side triggers: verifies the sender is an
 * active OWNER admin, validates the chat environment and shows the ONE
 * binding confirmation prompt (with a replacement warning when a DIFFERENT
 * group is currently bound - pressing confirm IS the replacement consent).
 */
async function promptLogGroupSetup(ctx: BotContext): Promise<void> {
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
  const lines: string[] = [];
  if (existing.chatId !== null && existing.chatId !== String(chat.id)) {
    lines.push(
      "یک گروه لاگ دیگر قبلاً تنظیم شده است:",
      `${existing.title ?? "بدون نام"} (${maskChatId(existing.chatId)})`,
      "با تایید، گروه فعلی جایگزین می‌شود.",
      "",
    );
  }
  lines.push(SETUP_CONFIRM_TEXT);
  await safeReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard()
      .text("تایید اتصال گروه ✅", LGSET_CB.yes)
      .row()
      .text("انصراف", LGSET_CB.no),
  );
}

export const logGroupSetupHandler = new Composer<BotContext>();

// Entry 1: /setloggroup sent INSIDE the candidate group.
logGroupSetupHandler.command("setloggroup", async (ctx) => {
  await promptLogGroupSetup(ctx);
});

// Entry 2: the wizard's start-group deep link. When the URL button adds the
// bot to a group, Telegram posts "/start zedlog" there. Intercept /start
// ONLY for group chats AND only for this exact payload - private-chat
// /start and group /start with any other payload fall through untouched to
// the generic startHandler.
logGroupSetupHandler.command("start", async (ctx, next) => {
  const chat = ctx.chat;
  if (chat === undefined || (chat.type !== "group" && chat.type !== "supergroup")) {
    return next();
  }
  if (getStartPayload(ctx) !== LOG_GROUP_STARTGROUP_PAYLOAD) {
    return next();
  }
  await promptLogGroupSetup(ctx);
});

// Confirmation press INSIDE the candidate group. The prompt may be stale or
// forwarded, so EVERYTHING is re-verified: the presser must be an active
// OWNER admin AND still a member of this group, and the chat environment
// must still validate. The whole action is idempotent - a repeated press
// re-binds the same group, ensureDefaultTopics creates zero new topics and
// the success message is simply shown again.
logGroupSetupHandler.callbackQuery(LGSET_CB.yes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const problem = await validateLogGroupChat(ctx);
  if (problem !== null) {
    await safeAnswerCallback(ctx, problem);
    return;
  }
  const chat = ctx.chat;
  const from = ctx.from;
  if (chat === undefined || from === undefined) {
    return;
  }
  try {
    const presser = await ctx.getChatMember(from.id);
    if (presser.status === "left" || presser.status === "kicked") {
      await safeAnswerCallback(ctx, NOT_GROUP_MEMBER_TEXT);
      return;
    }
  } catch {
    await safeAnswerCallback(ctx, NOT_GROUP_MEMBER_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);

  const existing = await getLogGroupSettings();
  const replaced = existing.chatId !== null && existing.chatId !== String(chat.id);
  const title = "title" in chat && typeof chat.title === "string" ? chat.title : "بدون نام";
  await saveLogGroup(String(chat.id), title);
  const ensured = await ensureDefaultTopics(ctx.api);
  const test = await testLogGroup(ctx.api);

  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.LOG_GROUP_CHANGED,
    message: "operational log group was (re)configured",
    metadata: {
      replaced,
      topicCreated: ensured.createdCount,
      topicFailed: ensured.failedCount,
    },
    topicKey: "SECURITY",
    adminId: admin.id,
  });
  try {
    await prisma.auditLog.create({
      data: {
        actorTelegramId: admin.telegramId,
        actorType: "ADMIN",
        action: "log_group_connected",
        entityType: "Setting",
        entityId: null,
        metadata: { replaced, adminId: admin.id },
      },
    });
  } catch (err) {
    logger.warn("log group connect audit log failed", { error: errorMessage(err) });
  }
  logger.info("log group configured", { adminId: admin.id, replaced });

  const lines = [GROUP_SAVED_TEXT];
  if (ensured.createdCount > 0) {
    lines.push(`موضوعات ساخته‌شده: ${ensured.createdCount}`);
  }
  if (ensured.existingCount > 0) {
    lines.push(`موضوعات موجود: ${ensured.existingCount}`);
  }
  if (ensured.failedCount > 0 && ensured.safeMessage !== null) {
    lines.push(`⚠️ ${ensured.failedCount} موضوع ساخته نشد: ${ensured.safeMessage}`);
  }
  lines.push(test.ok ? "پیام آزمایشی ارسال شد ✅" : `پیام آزمایشی: ${test.safeMessage}`);
  await safeEditOrReply(ctx, lines.join("\n"));
});

logGroupSetupHandler.callbackQuery(LGSET_CB.no, async (ctx) => {
  if (ctx.admin === null) {
    // Non-admin presses only clear the spinner - the prompt stays put.
    await safeAnswerCallback(ctx);
    return;
  }
  await safeAnswerCallback(ctx, "لغو شد.");
  await safeEditOrReply(ctx, SETUP_CANCELLED_TEXT);
});
