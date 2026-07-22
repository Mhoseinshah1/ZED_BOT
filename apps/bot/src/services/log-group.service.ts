import { prisma, type LogTopic } from "@zedbot/database";
import {
  LOG_GROUP_CHAT_ID_RE,
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import { GrammyError } from "grammy";

import { logger } from "../core/logger.js";
import { clearSettingCacheKeys, deleteSetting, setSetting } from "./settings.service.js";
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

// Postgres int8 (the BigInt telegramChatId column) range. A stored chat id
// outside it - a manually corrupted Setting, or an over-long value that slipped
// a shape regex - must be treated as an INVALID binding here, never routed to
// and never allowed to throw from BigInt().
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

/**
 * Validates a stored chat-id string for BINDING use: the `-100…` supergroup
 * shape AND int8-column compatibility. Returns the value when safe, else null
 * (no throw). The digit-length cap bounds BigInt() before the range check.
 */
function chatIdForBinding(value: string): string | null {
  if (!LOG_GROUP_CHAT_ID_RE.test(value) || !/^-?[0-9]{1,19}$/.test(value)) {
    return null;
  }
  try {
    const big = BigInt(value);
    return big >= INT8_MIN && big <= INT8_MAX ? value : null;
  } catch {
    return null;
  }
}

/** The authoritative, uncached view of the active log-group binding (§2). */
export interface LogGroupBinding {
  /** True only when a well-formed, routable chat id is stored. */
  configured: boolean;
  /** The valid `-100…` chat id, or null when unconfigured/invalid. */
  chatId: string | null;
  title: string | null;
  /** A chat-id value is stored but is malformed / out of int8 range. */
  invalid: boolean;
}

/**
 * DATABASE-AUTHORITATIVE binding read (§2). Queries both Setting keys directly
 * through Prisma in ONE query and NEVER uses the 30s process-local settings
 * cache - so a worker-side activation in a separate process is visible to this
 * bot process immediately, with no cross-process cache-invalidation dependency.
 * A malformed/out-of-range stored chat id returns an explicit invalid-binding
 * state (configured:false, invalid:true) rather than routing to it or throwing.
 * The full chat id is never logged. Use this for every correctness-sensitive
 * destination decision.
 */
/** Parses the two Setting rows into the validated binding (shared by the
 * fresh read and the coherent snapshot). */
function parseBindingRows(rows: Array<{ key: string; value: string }>): LogGroupBinding {
  const rawChatId = rows.find((r) => r.key === LOG_GROUP_CHAT_ID_KEY)?.value ?? "";
  const rawTitle = rows.find((r) => r.key === LOG_GROUP_TITLE_KEY)?.value ?? "";
  const title = rawTitle === "" ? null : rawTitle;
  if (rawChatId.trim() === "") {
    return { configured: false, chatId: null, title, invalid: false };
  }
  const chatId = chatIdForBinding(rawChatId.trim());
  if (chatId === null) {
    // A value is stored but unusable - fail safe as an explicit invalid state
    // (never route a Telegram mutation/test to a corrupted id).
    logger.warn("stored log-group chat id is malformed - treating binding as invalid");
    return { configured: false, chatId: null, title, invalid: true };
  }
  return { configured: true, chatId, title, invalid: false };
}

export async function readLogGroupBindingFresh(): Promise<LogGroupBinding> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [LOG_GROUP_CHAT_ID_KEY, LOG_GROUP_TITLE_KEY] } },
      select: { key: true, value: true },
    });
    return parseBindingRows(rows);
  } catch (err) {
    logger.warn("fresh log-group binding read failed", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return { configured: false, chatId: null, title: null, invalid: false };
  }
}

/**
 * The active group binding. Now delegates to the DATABASE-AUTHORITATIVE fresh
 * read (§2) - no process-local cache decides where a Telegram mutation/test is
 * sent. An invalid stored binding degrades to `chatId: null` here (fail safe).
 */
export async function getLogGroupSettings(): Promise<LogGroupSettings> {
  const binding = await readLogGroupBindingFresh();
  return { chatId: binding.chatId, title: binding.title };
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

/**
 * Self-healing cache invalidation (§6): drop the two log-group Setting cache
 * keys after a worker-side activation is observed ACTIVE. Correctness does NOT
 * depend on this (every routing-sensitive read is uncached via
 * readLogGroupBindingFresh); it only keeps any OTHER cached generic reads of
 * these keys from lagging. Never throws.
 */
export function invalidateLogGroupSettingCache(): void {
  clearSettingCacheKeys([LOG_GROUP_CHAT_ID_KEY, LOG_GROUP_TITLE_KEY]);
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
  // One coherent snapshot drives the binding + all current-group readiness
  // counts (§9) - never a cached group id combined with fresh topic rows.
  const snapshot = await loadLogGroupRoutingSnapshot();
  let lastSuccessAt: Date | null = null;
  let lastError: LogGroupStatus["lastError"] = null;
  try {
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
    configured: snapshot.configured,
    chatId: snapshot.chatId,
    title: snapshot.title,
    enabledTopicCount: snapshot.enabledReadyCount,
    totalTopicCount: snapshot.totalTopicCount,
    boundTopicCount: snapshot.boundTopicCount,
    invalidatedTopicCount: snapshot.invalidatedTopicCount,
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

/** Merges LogTopic rows over the stable key list against a chat id (pure). */
function topicsForChatId(rows: LogTopic[], chatId: string | null): OpsTopicEntry[] {
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
        chatId !== null &&
        row.telegramChatId.toString() === chatId,
    };
  });
}

/**
 * COHERENT routing snapshot (§3): the fresh binding AND all stable LogTopic
 * rows read in ONE transaction, so the displayed group, readiness counts,
 * selected destination, exact topic mapping and CAS-expected values all derive
 * from the SAME consistent state - never an old chat id paired with new topic
 * rows (or the reverse). This is the single source every routing-sensitive
 * admin action reloads before deciding.
 */
export interface LogGroupRoutingSnapshot {
  configured: boolean;
  invalid: boolean;
  chatId: string | null;
  title: string | null;
  topics: OpsTopicEntry[];
  totalTopicCount: number;
  /** Topics with a topicId bound to the current group (any enabled state). */
  boundTopicCount: number;
  /** Enabled AND bound to the current group (the "ready" delivery targets). */
  enabledReadyCount: number;
  /** Stable keys needing (re)creation for this group (missing + mismatched). */
  invalidatedTopicCount: number;
  missing: OpsLogTopicKey[];
  mismatched: OpsLogTopicKey[];
}

export async function loadLogGroupRoutingSnapshot(): Promise<LogGroupRoutingSnapshot> {
  let binding: LogGroupBinding = { configured: false, chatId: null, title: null, invalid: false };
  let rows: LogTopic[] = [];
  try {
    const result = await prisma.$transaction(async (tx) => {
      const settingRows = await tx.setting.findMany({
        where: { key: { in: [LOG_GROUP_CHAT_ID_KEY, LOG_GROUP_TITLE_KEY] } },
        select: { key: true, value: true },
      });
      const topicRows = await tx.logTopic.findMany({
        where: { key: { in: [...OPS_LOG_TOPIC_KEYS] } },
      });
      return { settingRows, topicRows };
    });
    binding = parseBindingRows(result.settingRows);
    rows = result.topicRows;
  } catch (err) {
    logger.warn("log-group routing snapshot failed", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
  const topics = topicsForChatId(rows, binding.chatId);
  let boundTopicCount = 0;
  let enabledReadyCount = 0;
  const missing: OpsLogTopicKey[] = [];
  const mismatched: OpsLogTopicKey[] = [];
  for (const t of topics) {
    if (binding.chatId === null) {
      continue;
    }
    if (t.boundToCurrentGroup) {
      boundTopicCount += 1;
      if (t.isEnabled) {
        enabledReadyCount += 1;
      }
    } else if (t.topicId === null) {
      missing.push(t.key);
    } else {
      mismatched.push(t.key);
    }
  }
  return {
    configured: binding.configured,
    invalid: binding.invalid,
    chatId: binding.chatId,
    title: binding.title,
    topics,
    totalTopicCount: OPS_LOG_TOPIC_KEYS.length,
    boundTopicCount,
    enabledReadyCount,
    invalidatedTopicCount: binding.chatId === null ? 0 : missing.length + mismatched.length,
    missing,
    mismatched,
  };
}

/** All operational topics, merged over the stable key list (stable order). */
export async function listOpsTopics(): Promise<OpsTopicEntry[]> {
  return (await loadLogGroupRoutingSnapshot()).topics;
}

/** Flips ONE topic's enabled flag (row is created with defaults if absent). */
export async function setTopicEnabled(key: OpsLogTopicKey, enabled: boolean): Promise<void> {
  await prisma.logTopic.upsert({
    where: { key },
    update: { isEnabled: enabled },
    create: { key, title: OPS_LOG_TOPIC_TITLES[key], isEnabled: enabled },
  });
}

// ensureDefaultTopics (inline bot-side forum-topic creation) was REMOVED in the
// post-activation hotfix: topic repair now runs through the durable worker
// pipeline (queueLogGroupRepair -> LogGroupSetupAttempt), which reads the
// binding fresh, honours the Telegram timeout / 429 / setup lock and atomically
// reasserts the current group. No bot callback performs createForumTopic writes.

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
  const snapshot = await loadLogGroupRoutingSnapshot();
  return {
    total: snapshot.totalTopicCount,
    ready: snapshot.boundTopicCount,
    missing: snapshot.missing,
    mismatched: snapshot.mismatched,
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
  // One coherent snapshot: the destination chat id AND the topic mapping come
  // from the SAME consistent read (§3), never a cached group with fresh topics.
  const snapshot = await loadLogGroupRoutingSnapshot();
  if (snapshot.chatId === null) {
    return { ok: false, safeCode: "log-group-unset", safeMessage: LOG_GROUP_NOT_CONFIGURED_TEXT };
  }
  const settings = { chatId: snapshot.chatId };
  const topic = snapshot.topics.find((t) => t.key === key);
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
