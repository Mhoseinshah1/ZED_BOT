import { randomUUID } from "node:crypto";

import {
  ActorType,
  LogGroupSetupStatus,
  Prisma,
  prisma,
  type LogGroupSetupAttempt,
} from "@zedbot/database";
import {
  evaluateLogGroupTarget,
  LOG_GROUP_CHAT_ID_SETTING_KEY,
  LOG_GROUP_SAFE_MESSAGES,
  LOG_GROUP_TITLE_SETTING_KEY,
  normalizeChatIdInput,
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
  type EvaluateLogGroupResult,
  type LogGroupSafeCode,
  type LogGroupTargetProbe,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import { GrammyError } from "grammy";

import { logger } from "../core/logger.js";
import { getLogGroupSettings, maskChatId } from "./log-group.service.js";
import { enqueueLogGroupSetup } from "./ops-queue.service.js";
import { clearSettingsCache, setSettingWithClient } from "./settings.service.js";

// =============================================================================
// Direct-log-group-setup phase: the SHARED log-group connection lifecycle.
// One validation policy (evaluateLogGroupTarget), one durable operation
// (LogGroupSetupAttempt), one atomic activation (activateLogGroupBindings) -
// the numeric-ID flow, /setloggroup and the start-group wizard all converge
// here. Topic creation and the test send run in the worker
// (telegram-log-group-setup queue), never inline in a Telegram callback.
//
// Trust boundary: the active group is NEVER overwritten until the staged
// group is fully provisioned and the direct SYSTEM test send succeeds, so a
// failed setup leaves the previous log destination working untouched. Full
// chat ids live only in the database (delivery needs them); every admin page
// and audit row uses the masked form.
// =============================================================================

/** Persian ID-format rejection (spec verbatim). */
export const INVALID_CHAT_ID_TEXT =
  "آیدی گروه معتبر نیست.\n\nآیدی عددی سوپرگروه باید با -100 شروع شود.";

/** Another setup is already provisioning (only one runs at a time). */
export const SETUP_ALREADY_RUNNING_TEXT =
  "یک عملیات راه‌اندازی گروه لاگ در حال انجام است. لطفاً تا پایان آن صبر کنید.";

/** Fallback when Redis/queue is unavailable at enqueue time. */
export const SETUP_QUEUE_UNAVAILABLE_TEXT =
  "صف راه‌اندازی در دسترس نیست. سرویس worker و Redis را بررسی کنید.";

// The in-flight states that occupy the single active-setup slot.
const RUNNING_STATUSES: LogGroupSetupStatus[] = [
  LogGroupSetupStatus.QUEUED,
  LogGroupSetupStatus.PROVISIONING,
  LogGroupSetupStatus.TESTING,
];
// The states an attempt can still be cancelled from.
const CANCELLABLE_STATUSES: LogGroupSetupStatus[] = [
  LogGroupSetupStatus.VALIDATED,
  ...RUNNING_STATUSES,
];

/** Minimal grammY-ish Api surface this service needs (Api satisfies it). */
export interface LogGroupProbeApi {
  getChat(chatId: number | string): Promise<{
    type: string;
    is_forum?: boolean;
    username?: string;
    title?: string;
  }>;
  getChatMember(
    chatId: number | string,
    userId: number,
  ): Promise<{ status: string; can_manage_topics?: boolean; can_post_messages?: boolean }>;
  readonly me?: { id: number };
}

// --- masked audit + safe metadata --------------------------------------------

/** Short attempt id for callback data + display (never the chat id). */
export function attemptShortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Writes a safe audit row for a connection-lifecycle event. Metadata carries
 * ONLY the admin id, attempt id, masked chat reference and safe codes -
 * never the full chat id, titles beyond a length bound or Telegram payloads.
 */
export async function auditLogGroupConnection(
  action: string,
  data: {
    adminId?: string;
    adminTelegramId?: bigint | null;
    attemptId?: string;
    chatId?: string | bigint | null;
    topicKey?: string;
    safeCode?: string | null;
    extra?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: ActorType.ADMIN,
        actorTelegramId: data.adminTelegramId ?? null,
        action,
        entityType: "LogGroupSetupAttempt",
        entityId: data.attemptId ?? null,
        metadata: {
          ...(data.adminId === undefined ? {} : { adminId: data.adminId }),
          ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId }),
          ...(data.chatId === undefined || data.chatId === null
            ? {}
            : { maskedChatId: maskChatId(String(data.chatId)) }),
          ...(data.topicKey === undefined ? {} : { topicKey: data.topicKey }),
          ...(data.safeCode === undefined || data.safeCode === null
            ? {}
            : { safeCode: data.safeCode }),
          ...(data.extra ?? {}),
        },
      },
    });
  } catch (err) {
    logger.warn("log group audit write failed", {
      action,
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
}

// --- probe + validation ------------------------------------------------------

/**
 * Calls Telegram (via the bot's grammY api) to build the normalized probe the
 * shared policy consumes: getChat (existence/type/forum/username/title),
 * getChatMember for the bot (status + can_manage_topics), getChatMember for
 * the requesting OWNER (membership). Raw errors are swallowed into the
 * normalized shape - a "chat not found" getChat failure becomes found:false;
 * a bot-membership lookup failure leaves botStatus null (→ BOT_NOT_MEMBER).
 */
export async function probeLogGroupTarget(
  api: LogGroupProbeApi,
  chatId: string,
  ownerTelegramId: number,
): Promise<LogGroupTargetProbe> {
  const probe: LogGroupTargetProbe = {
    found: false,
    chatType: null,
    isForum: false,
    username: null,
    title: null,
    botStatus: null,
    botCanManageTopics: false,
    botCanSend: true,
    ownerIsMember: false,
  };

  try {
    const chat = await api.getChat(chatId);
    probe.found = true;
    probe.chatType = chat.type;
    probe.isForum = chat.is_forum === true;
    probe.username = typeof chat.username === "string" ? chat.username : null;
    probe.title = typeof chat.title === "string" ? chat.title.slice(0, 120) : null;
  } catch {
    // Any getChat failure (chat not found, bot not a member, migrated) means
    // the target is not reachable as a group the bot can operate in.
    return probe;
  }

  const botId = api.me?.id;
  if (botId !== undefined) {
    try {
      const botMember = await api.getChatMember(chatId, botId);
      probe.botStatus = botMember.status;
      probe.botCanManageTopics = botMember.can_manage_topics === true;
      // Telegram exposes no per-admin send flag for supergroups; only flip
      // send to false on an explicit deny (restricted member).
      if (botMember.can_post_messages === false && botMember.status !== "administrator") {
        probe.botCanSend = false;
      }
    } catch {
      probe.botStatus = null; // → BOT_NOT_MEMBER
    }
  }

  try {
    const ownerMember = await api.getChatMember(chatId, ownerTelegramId);
    probe.ownerIsMember = !["left", "kicked"].includes(ownerMember.status);
  } catch {
    probe.ownerIsMember = false;
  }

  return probe;
}

/**
 * Read-only health check of the CURRENTLY bound destination against the shared
 * target policy (§10): chat exists, is a supergroup, forum still enabled, bot
 * is still a member + administrator, manage-topics still granted, sending not
 * explicitly restricted. OWNER membership is a SETUP-only requirement and is
 * treated as satisfied here. Sends NOTHING into the group - a read-only
 * connection check must never post a message (a send test is a separate,
 * explicit action). Returns the shared evaluate verdict with its safe message.
 */
export async function verifyBoundGroupConnection(
  api: LogGroupProbeApi,
  chatId: string,
): Promise<EvaluateLogGroupResult> {
  // probeLogGroupTarget needs a user id for the (setup-only) OWNER membership
  // probe; the bot's own id is always a present member, so reusing it keeps the
  // check read-only and independent of any specific OWNER while ownerIsMember is
  // then treated as satisfied regardless.
  const probeUserId = api.me?.id ?? 0;
  const probe = await probeLogGroupTarget(api, chatId, probeUserId);
  probe.ownerIsMember = true;
  return evaluateLogGroupTarget(probe);
}

export interface PrepareLogGroupOk {
  ok: true;
  chatId: string;
  title: string;
  isPublic: boolean;
  previous: { chatId: string; title: string | null } | null;
}
export interface PrepareLogGroupErr {
  ok: false;
  safeMessage: string;
  safeCode: LogGroupSafeCode | "INVALID_INPUT";
}
export type PrepareLogGroupResult = PrepareLogGroupOk | PrepareLogGroupErr;

/**
 * Normalizes + validates a numeric chat id against the shared policy. Returns
 * the safe title, public flag and the currently active group (for the
 * replacement warning). Does NOT persist anything.
 */
export async function prepareLogGroupConnection(
  api: LogGroupProbeApi,
  rawInput: string,
  ownerTelegramId: number,
): Promise<PrepareLogGroupResult> {
  const normalized = normalizeChatIdInput(rawInput);
  if (!normalized.ok) {
    return { ok: false, safeMessage: INVALID_CHAT_ID_TEXT, safeCode: "INVALID_INPUT" };
  }
  const probe = await probeLogGroupTarget(api, normalized.chatId, ownerTelegramId);
  const verdict = evaluateLogGroupTarget(probe);
  if (!verdict.ok) {
    return { ok: false, safeMessage: verdict.safeMessage, safeCode: verdict.safeCode };
  }
  const current = await getLogGroupSettings();
  return {
    ok: true,
    chatId: normalized.chatId,
    title: verdict.title,
    isPublic: verdict.isPublic,
    previous: current.chatId === null ? null : { chatId: current.chatId, title: current.title },
  };
}

// --- setup attempt lifecycle -------------------------------------------------

export type CreateAttemptResult =
  | { ok: true; attempt: LogGroupSetupAttempt }
  | { ok: false; reason: "active-exists"; activeAttempt: LogGroupSetupAttempt }
  | { ok: false; reason: "invalid-input" };

// Postgres int8 (the BigInt column) range. A chat id outside it - a manually
// corrupted stored Setting, or an over-long value that slipped the shape regex
// - must fail safely here, never throw a raw SyntaxError from BigInt() nor a
// numeric-out-of-range at insert time.
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

/**
 * Parses a chat-id string into a BigInt ONLY when it is a plain integer within
 * the int8 column range; returns null otherwise (no throw). The digit-length
 * cap bounds BigInt() cost before the range check runs.
 */
export function safeChatIdBigInt(value: string): bigint | null {
  if (!/^-?[0-9]{1,19}$/.test(value)) {
    return null;
  }
  try {
    const big = BigInt(value);
    return big >= INT8_MIN && big <= INT8_MAX ? big : null;
  } catch {
    return null;
  }
}

/**
 * Creates a VALIDATED setup attempt for a validated target. Refuses when a
 * setup is already provisioning (QUEUED/PROVISIONING/TESTING) - only one runs
 * at a time. Multiple VALIDATED previews may coexist (the OWNER may enter
 * another id); they never occupy the active slot until confirmed.
 */
export async function createLogGroupSetupAttempt(input: {
  chatId: string;
  title: string;
  adminId: string;
  previous: { chatId: string; title: string | null } | null;
}): Promise<CreateAttemptResult> {
  const running = await prisma.logGroupSetupAttempt.findFirst({
    where: { status: { in: RUNNING_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
  if (running !== null) {
    return { ok: false, reason: "active-exists", activeAttempt: running };
  }
  const chatIdBig = safeChatIdBigInt(input.chatId);
  if (chatIdBig === null) {
    // Defensive: the validated numeric-ID flow never produces an out-of-range
    // id (probe-gated), but never insert one that would overflow the column.
    return { ok: false, reason: "invalid-input" };
  }
  // A corrupted stored PREVIOUS chat id (informational only - the replacement
  // warning) degrades to "no previous recorded" rather than throwing.
  const previousChatIdBig =
    input.previous === null ? null : safeChatIdBigInt(input.previous.chatId);
  const attempt = await prisma.logGroupSetupAttempt.create({
    data: {
      chatId: chatIdBig,
      safeTitle: input.title.slice(0, 120),
      status: LogGroupSetupStatus.VALIDATED,
      requestedByAdminId: input.adminId,
      previousChatId: previousChatIdBig,
      previousTitle: input.previous?.title ?? null,
      idempotencyKey: randomUUID(),
    },
  });
  return { ok: true, attempt };
}

export async function getSetupAttemptById(id: string): Promise<LogGroupSetupAttempt | null> {
  return prisma.logGroupSetupAttempt.findUnique({ where: { id } });
}

/**
 * Ambiguity-safe short-id resolution (§14). A callback short id is only the
 * first 8 hex chars of a uuid, so two attempts CAN share a prefix. Resolving
 * to "the newest" would silently act on the wrong attempt, so this never
 * chooses: zero matches -> not-found, exactly one -> found, two or more ->
 * ambiguous. Every callback fails closed on not-found/ambiguous.
 */
export type ShortIdLookup =
  | { status: "found"; attempt: LogGroupSetupAttempt }
  | { status: "not-found" }
  | { status: "ambiguous" };

export async function getSetupAttemptByShortId(shortId: string): Promise<ShortIdLookup> {
  if (!/^[0-9a-f]{4,12}$/.test(shortId)) {
    return { status: "not-found" };
  }
  // take: 2 is enough to distinguish exactly-one from two-or-more without
  // scanning the whole table.
  const rows = await prisma.logGroupSetupAttempt.findMany({
    where: { id: { startsWith: shortId } },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  if (rows.length === 0) {
    return { status: "not-found" };
  }
  if (rows.length > 1) {
    return { status: "ambiguous" };
  }
  return { status: "found", attempt: rows[0] };
}

/** The one attempt currently occupying the active-setup slot, if any. */
export async function getActiveSetupAttempt(): Promise<LogGroupSetupAttempt | null> {
  return prisma.logGroupSetupAttempt.findFirst({
    where: { status: { in: RUNNING_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
}

export interface ConfirmResult {
  ok: boolean;
  safeMessage?: string;
  attempt?: LogGroupSetupAttempt;
}

/**
 * Confirms a validated attempt: re-validates the OWNER (caller-supplied) and
 * re-probes the group (revalidate before committing), then atomically claims
 * the single active-setup slot (VALIDATED → QUEUED, activeSlot = 1) and
 * enqueues the worker provisioning job. The unique activeSlot makes "only one
 * setup at a time" DB-authoritative: a second concurrent confirm of a
 * different attempt hits P2002 and is told a setup is already running.
 */
export async function confirmLogGroupConnection(
  api: LogGroupProbeApi,
  attemptId: string,
  ownerTelegramId: number,
): Promise<ConfirmResult> {
  const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
  if (attempt === null) {
    return { ok: false, safeMessage: "عملیات راه‌اندازی پیدا نشد." };
  }
  // Repeated confirmation of an already-running/finished attempt converges to
  // the same attempt (idempotent) - just return it so the caller shows the
  // live progress page.
  if (attempt.status !== LogGroupSetupStatus.VALIDATED) {
    return { ok: true, attempt };
  }

  // Revalidate the group immediately before committing (permissions may have
  // changed since the preview). Provisioning + the direct test in the worker
  // are the final authority, but this catches obvious drift early.
  const probe = await probeLogGroupTarget(api, String(attempt.chatId), ownerTelegramId);
  const verdict = evaluateLogGroupTarget(probe);
  if (!verdict.ok) {
    return { ok: false, safeMessage: verdict.safeMessage };
  }

  let claimed: LogGroupSetupAttempt;
  try {
    // CAS VALIDATED → QUEUED + occupy the active slot in one write.
    const updated = await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.VALIDATED },
      data: { status: LogGroupSetupStatus.QUEUED, activeSlot: 1 },
    });
    if (updated.count === 0) {
      // Someone else already advanced this attempt; reuse its live state.
      const fresh = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
      return fresh === null
        ? { ok: false, safeMessage: "عملیات راه‌اندازی پیدا نشد." }
        : { ok: true, attempt: fresh };
    }
    const freshClaimed = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
    if (freshClaimed === null) {
      // Row deleted concurrently between the claim and this read - fail safely
      // instead of dereferencing null.
      return { ok: false, safeMessage: "عملیات راه‌اندازی پیدا نشد." };
    }
    claimed = freshClaimed;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // The unique activeSlot is taken by another running setup.
      return { ok: false, safeMessage: SETUP_ALREADY_RUNNING_TEXT };
    }
    throw err;
  }

  const enqueued = await enqueueLogGroupSetup(attemptId);
  if (!enqueued) {
    // Roll the claim back so the OWNER can retry once Redis is back; free the
    // active slot so the next attempt is not blocked forever. The rollback is
    // best-effort: if THIS write also throws (the same outage), swallow it so
    // the OWNER still gets the safe queue-unavailable message - the stranded
    // QUEUED row is then reclaimed by the startup resume sweep, never leaked.
    await freeSlotBestEffort(attemptId, "redis-unavailable");
    return { ok: false, safeMessage: SETUP_QUEUE_UNAVAILABLE_TEXT };
  }
  return { ok: true, attempt: claimed };
}

/**
 * Frees the single active-setup slot for a still-QUEUED attempt after an
 * enqueue failure, WITHOUT letting the free-write's own failure propagate. A
 * throw here (same Redis/DB outage that failed the enqueue) would otherwise
 * strand the row at QUEUED/activeSlot=1 with no job. Swallowing it keeps the
 * caller's safe message intact; the startup resume sweep reclaims the row.
 */
export async function freeSlotBestEffort(attemptId: string, safeErrorCode: string): Promise<void> {
  try {
    await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.QUEUED },
      data: {
        status: LogGroupSetupStatus.FAILED,
        activeSlot: null,
        safeErrorCode,
        failedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn("log group slot free (enqueue rollback) failed", {
      attemptId,
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
}

/**
 * Cancels a not-yet-active attempt (VALIDATED/QUEUED/PROVISIONING/TESTING).
 * Frees the active slot, preserves the currently active group, keeps the
 * attempt row (audit history) and NEVER deletes Telegram topics or logs -
 * already-created staged topics stay stored for a safe retry.
 */
export async function cancelSetupAttempt(attemptId: string): Promise<boolean> {
  const cancelled = await prisma.logGroupSetupAttempt.updateMany({
    where: { id: attemptId, status: { in: CANCELLABLE_STATUSES } },
    data: { status: LogGroupSetupStatus.CANCELLED, activeSlot: null, failedAt: new Date() },
  });
  return cancelled.count > 0;
}

// --- atomic activation (shared by worker + group-side flows) -----------------

export interface StagedTopicBindings {
  [topicKey: string]: number;
}

/** Parses the attempt's stored topicBindings JSON into a typed map. */
export function parseTopicBindings(value: unknown): StagedTopicBindings {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const out: StagedTopicBindings = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((OPS_LOG_TOPIC_KEYS as readonly string[]).includes(key) && typeof v === "number") {
      out[key] = v;
    }
  }
  return out;
}

/**
 * THE atomic log-group activation. Switches the active group Settings and the
 * active LogTopic bindings together in one transaction - partial activation
 * is impossible. Both the worker (numeric-ID path) and the bot group-side
 * flows converge on this so there is a single activation policy. Uses the
 * shared Setting-key + topic constants.
 */
export async function activateLogGroupBindings(
  client: Prisma.TransactionClient,
  input: { chatId: string; title: string; bindings: StagedTopicBindings },
): Promise<void> {
  await setSettingWithClient(client, LOG_GROUP_CHAT_ID_SETTING_KEY, input.chatId, "STRING");
  await setSettingWithClient(
    client,
    LOG_GROUP_TITLE_SETTING_KEY,
    input.title.slice(0, 120),
    "STRING",
  );
  const telegramChatId = safeChatIdBigInt(input.chatId);
  if (telegramChatId === null) {
    // A malformed chat id must roll the whole activation back cleanly (the
    // previous group stays active) rather than throw a raw SyntaxError.
    throw new Error("invalid chat id for activation");
  }
  for (const key of OPS_LOG_TOPIC_KEYS) {
    const topicId = input.bindings[key];
    if (typeof topicId !== "number") {
      continue; // A key with no staged topic keeps whatever it had.
    }
    await client.logTopic.upsert({
      where: { key },
      update: { topicId, telegramChatId },
      create: { key, title: OPS_LOG_TOPIC_TITLES[key as OpsLogTopicKey], topicId, telegramChatId },
    });
  }
}

/**
 * Runs activateLogGroupBindings in a fresh transaction and refreshes the
 * settings cache so the new group is visible immediately. Used by the bot
 * group-side flows; the worker performs the equivalent tx with its own client
 * (see apps/worker/src/log-group-setup.ts) using the same shared constants.
 */
export async function activateLogGroup(input: {
  chatId: string;
  title: string;
  bindings: StagedTopicBindings;
}): Promise<void> {
  await prisma.$transaction((tx) => activateLogGroupBindings(tx, input));
  clearSettingsCache();
}

// --- shared grammY topic provisioning (group-side + legacy) ------------------

export interface GroupSideProvisionResult {
  bindings: StagedTopicBindings;
  createdCount: number;
  reusedCount: number;
  failedKey: OpsLogTopicKey | null;
  safeMessage: string | null;
}

/** Structural forum-topic creator (grammY Api satisfies it). */
export interface ForumTopicApi {
  createForumTopic(chatId: number | string, name: string): Promise<{ message_thread_id: number }>;
}

/**
 * Transport-agnostic staged topic provisioning for a specific chat id: for
 * each stable OPS key not already in `existing`, creates a forum topic and
 * records the binding. Returns the merged bindings; stops at the first
 * failure with a safe message (the caller decides whether to persist/abort).
 * Used bot-side (grammY) for the group-side flows and the legacy
 * ensureDefaultTopics wrapper; the worker has its own fetch-based twin for
 * the durable numeric-ID path.
 */
export async function createDefaultForumTopics(
  api: ForumTopicApi,
  chatId: string,
  existing: StagedTopicBindings = {},
): Promise<GroupSideProvisionResult> {
  const bindings: StagedTopicBindings = { ...existing };
  let createdCount = 0;
  let reusedCount = 0;
  for (const key of OPS_LOG_TOPIC_KEYS) {
    if (typeof bindings[key] === "number") {
      reusedCount += 1;
      continue;
    }
    try {
      const topic = await api.createForumTopic(chatId, OPS_LOG_TOPIC_TITLES[key]);
      bindings[key] = topic.message_thread_id;
      createdCount += 1;
    } catch (err) {
      return {
        bindings,
        createdCount,
        reusedCount,
        failedKey: key,
        safeMessage: classifyForumTopicError(err),
      };
    }
  }
  return { bindings, createdCount, reusedCount, failedKey: null, safeMessage: null };
}

/** Safe Persian classification of a forum-topic creation failure. */
function classifyForumTopicError(err: unknown): string {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) {
      return LOG_GROUP_SAFE_MESSAGES.SEND_UNAVAILABLE;
    }
    const d = err.description.toLowerCase();
    if (d.includes("not enough rights") || d.includes("chat_admin_required")) {
      return LOG_GROUP_SAFE_MESSAGES.MISSING_TOPIC_PERMISSION;
    }
    if (d.includes("forum")) {
      return LOG_GROUP_SAFE_MESSAGES.TOPICS_DISABLED;
    }
    if (d.includes("chat not found")) {
      return LOG_GROUP_SAFE_MESSAGES.NOT_FOUND;
    }
  }
  return "ساخت تاپیک ناموفق بود.";
}
