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

/**
 * The bot-side view of the active group binding. Reads go through the settings
 * cache (30s TTL), so after a WORKER-side activation (the numeric-ID path
 * commits log_group_chat_id/title in its own process) this bot process can
 * serve the PREVIOUS group's chat id/title for up to the TTL - there is no
 * cross-process cache invalidation. This is bounded and safe: it only affects
 * bot-side DISPLAY reads (status page, an admin test send, the
 * boundToCurrentGroup comparison) and always lags toward the previous group
 * (never a not-yet-active one). The safety-critical delivery routing is
 * unaffected - the worker's log-delivery reads the log_group_chat_id Setting
 * directly from the database, never this cache.
 */
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
  /**
   * READY topics: a stable OPS key row that is enabled, has a topicId AND is
   * bound to the CURRENTLY configured group. Old-group mappings count as zero
   * for the current group; no configured group means zero ready.
   */
  enabledTopicCount: number;
  /** Total stable OPS keys (the ceiling - always OPS_LOG_TOPIC_KEYS.length). */
  totalTopicCount: number;
  /** Rows with a topicId bound to the current group (regardless of enabled). */
  boundTopicCount: number;
  /**
   * Rows that need (re)creation for the current group: missing (topicId null)
   * or bound to a DIFFERENT group. Zero when no group is configured (nothing
   * is expected of an unconfigured binding).
   */
  invalidatedTopicCount: number;
  lastSuccessAt: Date | null;
  lastError: { code: string; at: Date } | null;
}

export async function getLogGroupStatus(): Promise<LogGroupStatus> {
  const settings = await getLogGroupSettings();
  const totalTopicCount = OPS_LOG_TOPIC_KEYS.length;
  let enabledTopicCount = 0;
  let boundTopicCount = 0;
  let invalidatedTopicCount = 0;
  let lastSuccessAt: Date | null = null;
  let lastError: LogGroupStatus["lastError"] = null;
  try {
    // Count in JS over the exact stable-key rows so "bound to the current
    // group" is an exact chat-id match (BigInt telegramChatId vs the stored
    // string setting). A corrupted/absent chat-id setting simply matches
    // nothing -> zero ready, never a throw.
    const configuredChatId = settings.chatId;
    const rows = await prisma.logTopic.findMany({
      where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
      select: { key: true, topicId: true, telegramChatId: true, isEnabled: true },
    });
    if (configuredChatId !== null) {
      for (const row of rows) {
        const boundHere =
          row.topicId !== null &&
          row.telegramChatId !== null &&
          row.telegramChatId.toString() === configuredChatId;
        if (boundHere) {
          boundTopicCount += 1;
          if (row.isEnabled) {
            enabledTopicCount += 1;
          }
        }
      }
      // Every stable key not currently bound to this group needs (re)creation.
      invalidatedTopicCount = totalTopicCount - boundTopicCount;
    }
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
    totalTopicCount,
    boundTopicCount,
    invalidatedTopicCount,
    lastSuccessAt,
    lastError,
  };
}

// --- topics ---------------------------------------------------------------------------------

export interface OpsTopicEntry {
  /** LogTopic row id when the row exists (for CAS invalidation); null if not. */
  id: string | null;
  key: OpsLogTopicKey;
  title: string;
  topicId: number | null;
  /** The row's stored telegram chat id (for CAS invalidation), or null. */
  telegramChatId: bigint | null;
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
      id: row?.id ?? null,
      key,
      title: row?.title ?? OPS_LOG_TOPIC_TITLES[key],
      topicId: row?.topicId ?? null,
      telegramChatId: row?.telegramChatId ?? null,
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
      return "موضوع (تاپیک) موردنظر وجود ندارد یا بسته شده است. «ساخت / تعمیر موضوعات پیش‌فرض» را اجرا کنید.";
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
  safeCode?: string;
  safeMessage: string;
}

/**
 * Sends the standard test message to ONE topic (SYSTEM by default), and NEVER
 * falls back to the group's General thread. A test only ever proves the EXACT
 * configured topic accepted a message, so before sending it requires: a
 * configured chat id, a LogTopic row that exists, has a topicId, is bound to
 * the CURRENTLY configured chat, and is enabled. Any missing requirement
 * returns a typed result (topic-unmapped / topic-disabled) - it does not send
 * a message that could land in General and falsely report success.
 */
export async function testLogGroup(
  api: LogGroupApi,
  key: OpsLogTopicKey = "SYSTEM",
): Promise<LogGroupTestResult> {
  const settings = await getLogGroupSettings();
  if (settings.chatId === null) {
    return { ok: false, safeCode: "log-group-unset", safeMessage: LOG_GROUP_NOT_CONFIGURED_TEXT };
  }
  const topics = await listOpsTopics();
  const topic = topics.find((t) => t.key === key);
  // The exact topic must be mapped to the CURRENT group - never send without a
  // proven message_thread_id (that would deliver to General and lie about it).
  if (topic === undefined || topic.topicId === null || !topic.boundToCurrentGroup) {
    return {
      ok: false,
      safeCode: "topic-unmapped",
      safeMessage: `تاپیک ${key} به گروه فعلی متصل نیست.`,
    };
  }
  if (!topic.isEnabled) {
    return {
      ok: false,
      safeCode: "topic-disabled",
      safeMessage: "این تاپیک غیرفعال است؛ ابتدا آن را فعال کنید.",
    };
  }
  const threadId = topic.topicId;
  try {
    await api.sendMessage(
      settings.chatId,
      key === "SYSTEM"
        ? LOG_GROUP_TEST_OK_TEXT
        : `پیام آزمایشی موضوع «${topic.title}» با موفقیت ارسال شد ✅`,
      { message_thread_id: threadId },
    );
    return { ok: true, safeMessage: LOG_GROUP_TEST_OK_TEXT };
  } catch (err) {
    // §11: if Telegram reports the topic itself is gone/closed, invalidate ONLY
    // this exact mapping (CAS) so «ساخت / تعمیر موضوعات پیش‌فرض» recreates it -
    // every other healthy topic is untouched.
    if (isTopicGoneError(err) && topic.id !== null && topic.telegramChatId !== null) {
      await invalidateStaleTopic({
        id: topic.id,
        expectedTopicId: threadId,
        expectedChatId: topic.telegramChatId,
      }).catch(() => undefined);
      return { ok: false, safeCode: "topic-missing", safeMessage: classifyTelegramError(err) };
    }
    return { ok: false, safeCode: "send-failed", safeMessage: classifyTelegramError(err) };
  }
}

/** True when a GrammyError means the specific topic is deleted or closed. */
function isTopicGoneError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) {
    return false;
  }
  const d = err.description.toLowerCase();
  return (
    d.includes("message thread not found") ||
    d.includes("thread not found") ||
    d.includes("topic_deleted") ||
    d.includes("topic_closed") ||
    d.includes("topic is closed")
  );
}

/**
 * Compare-and-swap invalidation of ONE stale topic mapping (§11). Clears the
 * topicId ONLY when the row still matches the exact (id, expected topicId,
 * expected chat id) the failed delivery/test observed - so a concurrent
 * repair/reactivation that already rebound the key is never clobbered, and one
 * topic's failure never invalidates the others. The stable key, title,
 * isEnabled flag and audit history are all preserved; the row simply becomes
 * "missing" (topicId null) so ensureDefaultTopics recreates it and the status
 * page shows it as needing repair. Returns true when this exact mapping was
 * the one invalidated.
 */
export async function invalidateStaleTopic(input: {
  id: string;
  expectedTopicId: number;
  expectedChatId: bigint;
}): Promise<boolean> {
  const result = await prisma.logTopic.updateMany({
    where: { id: input.id, topicId: input.expectedTopicId, telegramChatId: input.expectedChatId },
    data: { topicId: null },
  });
  return result.count > 0;
}
