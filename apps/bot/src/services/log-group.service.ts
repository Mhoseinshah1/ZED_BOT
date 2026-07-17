import { prisma, type LogTopic } from "@zedbot/database";
import {
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import { GrammyError } from "grammy";

import { logger } from "../core/logger.js";
import { deleteSetting, getSetting, setSetting } from "./settings.service.js";
import { LOG_GROUP_CHAT_ID_KEY } from "./system-log.service.js";

// =============================================================================
// Telegram operational log group management (ops-logging phase). The group
// binding lives in two Settings (chat id + safe title); the per-topic state
// lives in LogTopic rows keyed by the STABLE OPS_LOG_TOPIC_KEYS (titles are
// operator-editable display only). The bot only manages topics and sends
// TEST messages from here - real deliveries are the worker's job via the
// telegram-operational-logs queue. Every Telegram failure is classified into
// a safe Persian line; raw API payloads/descriptions are never shown to the
// admin and chat ids are masked in page output.
// =============================================================================

export const LOG_GROUP_TITLE_KEY = "log_group_title";

/** Minimal structural send/topic API (grammY Api satisfies this). */
export interface LogGroupApi {
  createForumTopic(
    chatId: number | string,
    name: string,
  ): Promise<{ message_thread_id: number }>;
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { message_thread_id?: number },
  ): Promise<unknown>;
}

export const LOG_GROUP_NOT_CONFIGURED_TEXT = "گروه لاگ هنوز تنظیم نشده است.";
export const LOG_GROUP_TEST_OK_TEXT = "پیام آزمایشی گروه لاگ با موفقیت ارسال شد ✅";

// Safe Persian environment-validation errors, shared by the admin status
// page («بررسی اتصال 🧪» / «بررسی مجدد اتصال ♻️») and the group-side setup
// flow (/setloggroup + the start-group wizard confirmation).
export const NOT_IN_GROUP_TEXT = "این دستور باید داخل گروه لاگ اجرا شود.";
export const NOT_FORUM_TEXT =
  "قابلیت موضوعات گروه فعال نیست. ابتدا Topics را در تنظیمات گروه فعال کنید.";
export const BOT_NOT_ADMIN_TEXT = "ربات باید در این گروه مدیر باشد.";
export const BOT_RIGHTS_INCOMPLETE_TEXT = "دسترسی ارسال پیام یا مدیریت موضوعات کامل نیست.";

/** Masked chat id for page output: first 4 + last 2 digits only. */
export function maskChatId(chatId: string): string {
  const sign = chatId.startsWith("-") ? "-" : "";
  const digits = chatId.replace(/\D/g, "");
  if (digits.length <= 6) {
    return `${sign}${digits}`;
  }
  return `${sign}${digits.slice(0, 4)}…${digits.slice(-2)}`;
}

export interface LogGroupSettings {
  chatId: string | null;
  title: string | null;
}

export async function getLogGroupSettings(): Promise<LogGroupSettings> {
  const chatId = await getSetting(LOG_GROUP_CHAT_ID_KEY, "");
  const title = await getSetting(LOG_GROUP_TITLE_KEY, "");
  return { chatId: chatId === "" ? null : chatId, title: title === "" ? null : title };
}

/** Saves the group binding (title is stored truncated, never markup). */
export async function saveLogGroup(chatId: string, title: string): Promise<void> {
  await setSetting(LOG_GROUP_CHAT_ID_KEY, chatId, "STRING");
  await setSetting(LOG_GROUP_TITLE_KEY, title.slice(0, 120), "STRING");
}

/** Clears the group binding only - LogTopic rows/history stay untouched. */
export async function disconnectLogGroup(): Promise<void> {
  await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
  await deleteSetting(LOG_GROUP_TITLE_KEY);
}

export interface LogGroupStatus {
  configured: boolean;
  chatId: string | null;
  title: string | null;
  enabledTopicCount: number;
  totalTopicCount: number;
  lastSuccessAt: Date | null;
  lastError: { code: string; at: Date } | null;
}

export async function getLogGroupStatus(): Promise<LogGroupStatus> {
  const settings = await getLogGroupSettings();
  let enabledTopicCount = 0;
  let lastSuccessAt: Date | null = null;
  let lastError: LogGroupStatus["lastError"] = null;
  try {
    enabledTopicCount = await prisma.logTopic.count({
      where: { key: { in: [...OPS_LOG_TOPIC_KEYS] }, isEnabled: true, topicId: { not: null } },
    });
    const lastSent = await prisma.systemLogDelivery.findFirst({
      where: { status: "SENT" },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    lastSuccessAt = lastSent?.sentAt ?? null;
    const lastFailed = await prisma.systemLogDelivery.findFirst({
      where: { status: { in: ["FAILED", "DEAD_LETTER"] } },
      orderBy: { updatedAt: "desc" },
      select: { safeErrorCode: true, updatedAt: true },
    });
    if (lastFailed !== null) {
      lastError = { code: lastFailed.safeErrorCode ?? "unknown", at: lastFailed.updatedAt };
    }
  } catch (err) {
    logger.warn("log group status query failed", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
  return {
    configured: settings.chatId !== null,
    chatId: settings.chatId,
    title: settings.title,
    enabledTopicCount,
    totalTopicCount: OPS_LOG_TOPIC_KEYS.length,
    lastSuccessAt,
    lastError,
  };
}

// --- topics ---------------------------------------------------------------------------------

export interface OpsTopicEntry {
  key: OpsLogTopicKey;
  title: string;
  topicId: number | null;
  isEnabled: boolean;
  /** True when the stored chat id matches the configured group. */
  boundToCurrentGroup: boolean;
}

/** All operational topics, merged over the stable key list (stable order). */
export async function listOpsTopics(): Promise<OpsTopicEntry[]> {
  const settings = await getLogGroupSettings();
  let rows: LogTopic[] = [];
  try {
    rows = await prisma.logTopic.findMany({ where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } } });
  } catch (err) {
    logger.warn("log topic list failed", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return OPS_LOG_TOPIC_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      title: row?.title ?? OPS_LOG_TOPIC_TITLES[key],
      topicId: row?.topicId ?? null,
      isEnabled: row?.isEnabled ?? true,
      boundToCurrentGroup:
        row?.topicId !== null &&
        row?.telegramChatId !== null &&
        row?.telegramChatId !== undefined &&
        settings.chatId !== null &&
        row.telegramChatId.toString() === settings.chatId,
    };
  });
}

/** Flips ONE topic's enabled flag (row is created with defaults if absent). */
export async function setTopicEnabled(key: OpsLogTopicKey, enabled: boolean): Promise<void> {
  await prisma.logTopic.upsert({
    where: { key },
    update: { isEnabled: enabled },
    create: { key, title: OPS_LOG_TOPIC_TITLES[key], isEnabled: enabled },
  });
}

export interface EnsureTopicsResult {
  ok: boolean;
  createdCount: number;
  existingCount: number;
  failedCount: number;
  safeMessage: string | null;
}

/**
 * Ensures every stable topic key has a LogTopic row AND a real forum topic
 * in the configured group. Idempotent: rows already bound to the current
 * group are skipped; missing/mismatched ones get a fresh createForumTopic.
 */
export async function ensureDefaultTopics(api: LogGroupApi): Promise<EnsureTopicsResult> {
  const settings = await getLogGroupSettings();
  if (settings.chatId === null) {
    return {
      ok: false,
      createdCount: 0,
      existingCount: 0,
      failedCount: 0,
      safeMessage: LOG_GROUP_NOT_CONFIGURED_TEXT,
    };
  }
  const chatId = settings.chatId;
  let createdCount = 0;
  let existingCount = 0;
  let failedCount = 0;
  let firstError: string | null = null;
  for (const key of OPS_LOG_TOPIC_KEYS) {
    const row = await prisma.logTopic.upsert({
      where: { key },
      update: {},
      create: { key, title: OPS_LOG_TOPIC_TITLES[key] },
    });
    if (row.topicId !== null && row.telegramChatId?.toString() === chatId) {
      existingCount += 1;
      continue;
    }
    try {
      const topic = await api.createForumTopic(chatId, row.title);
      await prisma.logTopic.update({
        where: { key },
        data: { topicId: topic.message_thread_id, telegramChatId: BigInt(chatId) },
      });
      createdCount += 1;
    } catch (err) {
      failedCount += 1;
      firstError ??= classifyTelegramError(err);
      logger.warn("forum topic creation failed", {
        key,
        error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
      });
    }
  }
  return {
    ok: failedCount === 0,
    createdCount,
    existingCount,
    failedCount,
    safeMessage: firstError,
  };
}

export interface SyncTopicsReport {
  total: number;
  ready: number;
  /** Keys with no forum topic yet (need «ساخت موضوعات پیش‌فرض»). */
  missing: OpsLogTopicKey[];
  /** Keys bound to a DIFFERENT chat than the configured group. */
  mismatched: OpsLogTopicKey[];
}

/** Read-only reconciliation report - which topics need (re)creation. */
export async function syncTopics(): Promise<SyncTopicsReport> {
  const topics = await listOpsTopics();
  const missing = topics.filter((t) => t.topicId === null).map((t) => t.key);
  const mismatched = topics
    .filter((t) => t.topicId !== null && !t.boundToCurrentGroup)
    .map((t) => t.key);
  return {
    total: topics.length,
    ready: topics.length - missing.length - mismatched.length,
    missing,
    mismatched,
  };
}

// --- test sends -------------------------------------------------------------------------------

/** Safe Persian classification of a Telegram send/topic failure. */
export function classifyTelegramError(err: unknown): string {
  if (err instanceof GrammyError) {
    const description = err.description.toLowerCase();
    if (err.error_code === 429) {
      return "محدودیت نرخ تلگرام (429) - کمی بعد دوباره تلاش کنید.";
    }
    if (description.includes("chat not found")) {
      return "گروه پیدا نشد. ربات باید عضو گروه باشد.";
    }
    if (description.includes("bot was kicked") || description.includes("bot is not a member")) {
      return "ربات از گروه حذف شده است.";
    }
    if (description.includes("not enough rights") || description.includes("chat_admin_required")) {
      return "ربات باید در این گروه مدیر باشد و دسترسی مدیریت موضوعات داشته باشد.";
    }
    if (
      description.includes("message thread not found") ||
      description.includes("topic_deleted") ||
      description.includes("topic_closed")
    ) {
      return "موضوع (تاپیک) موردنظر وجود ندارد یا بسته شده است. «ساخت موضوعات پیش‌فرض» را اجرا کنید.";
    }
    if (description.includes("forum")) {
      return "قابلیت موضوعات (Topics) گروه فعال نیست.";
    }
    return "ارسال به گروه لاگ ناموفق بود. دسترسی‌های ربات را بررسی کنید.";
  }
  return "ارسال به گروه لاگ ناموفق بود. اتصال شبکه را بررسی کنید.";
}

export interface LogGroupTestResult {
  ok: boolean;
  safeMessage: string;
}

/** Sends the standard test message to ONE topic (SYSTEM by default). */
export async function testLogGroup(
  api: LogGroupApi,
  key: OpsLogTopicKey = "SYSTEM",
): Promise<LogGroupTestResult> {
  const settings = await getLogGroupSettings();
  if (settings.chatId === null) {
    return { ok: false, safeMessage: LOG_GROUP_NOT_CONFIGURED_TEXT };
  }
  const topics = await listOpsTopics();
  const topic = topics.find((t) => t.key === key);
  try {
    await api.sendMessage(
      settings.chatId,
      key === "SYSTEM"
        ? LOG_GROUP_TEST_OK_TEXT
        : `پیام آزمایشی موضوع «${topic?.title ?? key}» با موفقیت ارسال شد ✅`,
      topic?.topicId !== null && topic?.topicId !== undefined && topic.boundToCurrentGroup
        ? { message_thread_id: topic.topicId }
        : undefined,
    );
    return { ok: true, safeMessage: LOG_GROUP_TEST_OK_TEXT };
  } catch (err) {
    return { ok: false, safeMessage: classifyTelegramError(err) };
  }
}
