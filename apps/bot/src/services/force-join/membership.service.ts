import { type ForceJoinChannel } from "@zedbot/database";
import { getRedisOptions, isForceJoinMembershipActive } from "@zedbot/shared";
import { Redis } from "ioredis";

import { logger } from "../../core/logger.js";
import { OPS_EVENTS, writeSystemLog } from "../system-log.service.js";
import { recordValidationError } from "./force-join-channel.service.js";

// =============================================================================
// Mandatory channel membership (Force Join): live membership CHECKER.
//
// For an enabled force join, decides whether a user may pass by checking their
// LIVE membership (§4.9: no verified-once, no joinedAt — D9) in every ACTIVE
// channel. Membership is authoritative from Telegram; Redis is only a bounded
// cache in front of it (§4.12):
//   - Redis DOWN never fails the check (D8) — every cache op is fail-open and a
//     miss just queries Telegram directly.
//   - API errors are NEVER cached as a membership result; only joined (~90s) and
//     not-joined (~10s) verdicts are.
//   - The explicit "بررسی عضویت" callback bypasses the NEGATIVE cache so a user
//     who just joined is verified immediately.
//   - Keys carry userTelegramId (as string — T6), the channel DB id and the
//     channel version (updatedAt), so any edit/rebind/activation invalidates
//     naturally. The Telegram chat id is NEVER put in a key/log.
//
// Failure taxonomy (§4.11): a channel that the bot can no longer verify (lost
// access / deleted / renamed) is EXCLUDED from gating (never bricks users — D4)
// and raises a durable, per-channel-per-window deduplicated OWNER alert. A
// transient/network failure fails CLOSED without lying (D2).
// =============================================================================

const REDIS_CONNECT_TIMEOUT_MS = 2_000;
/** joined verdict cache TTL (~60–120s window; §4.12). */
const JOINED_TTL_S = 90;
/** not-joined verdict cache TTL (~5–15s window; §4.12). */
const NOT_JOINED_TTL_S = 10;
/** One unverifiable-channel alert per channel per this rolling window (§4.11). */
const ALERT_WINDOW_S = 3_600;
/** Per-user debounce on the explicit "بررسی عضویت" re-check (§4.9). */
const CHECK_DEBOUNCE_S = 4;

let client: Redis | null = null;
let clientFingerprint = "";

function getClient(): Redis | null {
  const options = getRedisOptions();
  if (options === null) {
    return null;
  }
  const fingerprint = `${options.host}:${options.port}`;
  if (client !== null && clientFingerprint === fingerprint) {
    return client;
  }
  if (client !== null) {
    client.disconnect();
    client = null;
  }
  const redis = new Redis({
    host: options.host,
    port: options.port,
    password: options.password,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on("error", (err) => {
    logger.warn("force-join membership redis error", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  });
  client = redis;
  clientFingerprint = fingerprint;
  return client;
}

/** Test hook: drops the cached client so env changes take effect. */
export function resetForceJoinRedisForTests(): void {
  if (client !== null) {
    client.disconnect();
    client = null;
    clientFingerprint = "";
  }
  memAlertDedup.clear();
}

// --- cache (all ops fail-open — D8) ------------------------------------------

function membershipKey(userTelegramId: bigint, channel: ForceJoinChannel): string {
  // T6: BigInt serialized to string; version = channel updatedAt epoch ms.
  return `fj:m:${userTelegramId.toString()}:${channel.id}:${channel.updatedAt.getTime()}`;
}

async function cacheGet(key: string): Promise<string | null> {
  const redis = getClient();
  if (redis === null) {
    return null;
  }
  try {
    return await redis.get(key);
  } catch {
    return null; // D8: never let a cache read fail the check
  }
}

async function cacheSet(key: string, value: "1" | "0", ttlS: number): Promise<void> {
  const redis = getClient();
  if (redis === null) {
    return;
  }
  try {
    await redis.set(key, value, "EX", ttlS);
  } catch {
    // D8: caching is best-effort; a write failure is irrelevant to correctness.
  }
}

// --- unverifiable-channel alert dedup (§4.11) --------------------------------

// Process-local fallback used ONLY when Redis is unavailable, so a broken
// channel cannot flood the ops log with one row per user request. Bounded per
// process; a cluster may emit one alert per process per window, which is a safe
// degradation (the membership DECISION never depends on this).
const memAlertDedup = new Map<string, number>();

async function shouldEmitChannelAlert(channelId: string, errorClass: string): Promise<boolean> {
  const key = `fj:alert:${channelId}:${errorClass}`;
  const redis = getClient();
  if (redis !== null) {
    try {
      const res = await redis.set(key, "1", "EX", ALERT_WINDOW_S, "NX");
      return res === "OK";
    } catch {
      // fall through to the process-local window
    }
  }
  const now = Date.now();
  const expiry = memAlertDedup.get(key);
  if (expiry !== undefined && expiry > now) {
    return false;
  }
  memAlertDedup.set(key, now + ALERT_WINDOW_S * 1_000);
  return true;
}

async function emitUnverifiableAlert(channel: ForceJoinChannel, errorClass: string): Promise<void> {
  if (!(await shouldEmitChannelAlert(channel.id, errorClass))) {
    return;
  }
  await recordValidationError(channel.id, errorClass);
  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.FORCE_JOIN_CHANNEL_UNVERIFIABLE,
    // No secret: the channel DB id + class only; the chat id / invite link never
    // appear (§4.11, T6).
    message: `Force-join required channel became unverifiable (${errorClass}).`,
    metadata: { channelId: channel.id, errorClass, isPrivate: channel.isPrivate },
    topicKey: "SYSTEM",
  });
}

// --- per-user re-check debounce (§4.9) ---------------------------------------

/**
 * Rate-limits the explicit "بررسی عضویت" re-check per user (a few seconds), so a
 * user tapping repeatedly cannot hammer the Telegram API. Returns true when the
 * caller may proceed with a check, false while still within the debounce window.
 * Redis down → returns true (no debounce, but the check still runs — D8); it
 * NEVER produces a false "not joined".
 */
export async function acquireForceJoinCheckSlot(userTelegramId: bigint): Promise<boolean> {
  const redis = getClient();
  if (redis === null) {
    return true;
  }
  try {
    const res = await redis.set(
      `fj:debounce:${userTelegramId.toString()}`,
      "1",
      "EX",
      CHECK_DEBOUNCE_S,
      "NX",
    );
    return res === "OK";
  } catch {
    return true;
  }
}

// --- per-channel membership check --------------------------------------------

/** The Telegram surface the checker needs (handler injects an adapter over ctx.api). */
export interface ForceJoinMembershipApi {
  getChatMember(
    chatId: number | string,
    userId: number,
  ): Promise<{ status: string; is_member?: boolean }>;
}

type ChannelCheck = "JOINED" | "NOT_JOINED" | "TEMP" | "UNVERIFIABLE";

/**
 * Classifies a getChatMember error. A "user is not a participant" error means
 * the user is simply NOT joined (§4.8), whereas a chat-access error means the
 * BOT can no longer verify the channel — a config problem, not the user's fault
 * (§4.11). Rate limits / 5xx / network are transient. Unknown permanent errors
 * are treated as unverifiable so a mystery failure never bricks the user.
 */
function classifyMemberCheckError(err: unknown): "TEMP" | "NOT_JOINED" | "UNVERIFIABLE" {
  const code = (err as { error_code?: unknown } | null)?.error_code;
  const desc = String((err as { description?: unknown } | null)?.description ?? "").toLowerCase();
  if (code === 429 || (typeof code === "number" && code >= 500)) {
    return "TEMP";
  }
  const userAbsentMarkers = [
    "user not found",
    "user_not_participant",
    "participant",
    "member not found",
    "user_id_invalid",
  ];
  if (userAbsentMarkers.some((m) => desc.includes(m))) {
    return "NOT_JOINED";
  }
  const botAccessMarkers = [
    "chat not found",
    "bot is not a member",
    "member list is inaccessible",
    "not enough rights",
    "chat_admin_required",
    "channel_private",
    "peer_id_invalid",
    "chat_id_invalid",
    "bot was kicked",
  ];
  if (botAccessMarkers.some((m) => desc.includes(m))) {
    return "UNVERIFIABLE";
  }
  if (typeof code === "number" && code >= 400 && code < 500) {
    return "UNVERIFIABLE";
  }
  return "TEMP";
}

async function checkChannel(
  api: ForceJoinMembershipApi,
  userTelegramId: bigint,
  channel: ForceJoinChannel,
  bypassNegativeCache: boolean,
): Promise<ChannelCheck> {
  const key = membershipKey(userTelegramId, channel);
  const cached = await cacheGet(key);
  if (cached === "1") {
    return "JOINED"; // a positive verdict is always trusted for its TTL
  }
  if (cached === "0" && !bypassNegativeCache) {
    return "NOT_JOINED";
  }
  // Cache miss, or a negative verdict that the explicit re-check bypasses.

  let member: { status: string; is_member?: boolean };
  try {
    member = await api.getChatMember(Number(channel.chatId), Number(userTelegramId));
  } catch (err) {
    const cls = classifyMemberCheckError(err);
    if (cls === "TEMP") {
      return "TEMP"; // never cached; fail closed without lying (D2)
    }
    if (cls === "UNVERIFIABLE") {
      return "UNVERIFIABLE"; // excluded from gating (D4) + alert (§4.11)
    }
    // The user genuinely is not a participant.
    await cacheSet(key, "0", NOT_JOINED_TTL_S);
    return "NOT_JOINED";
  }

  if (isForceJoinMembershipActive(member.status, member.is_member)) {
    await cacheSet(key, "1", JOINED_TTL_S);
    return "JOINED";
  }
  await cacheSet(key, "0", NOT_JOINED_TTL_S);
  return "NOT_JOINED";
}

// --- gate outcome -------------------------------------------------------------

export type ForceJoinGateOutcome =
  | { decision: "PASS" }
  | { decision: "MISSING"; missing: ForceJoinChannel[] }
  | { decision: "TEMP_FAILURE" };

export interface EvaluateMembershipArgs {
  api: ForceJoinMembershipApi;
  userTelegramId: bigint;
  /** The active-channel snapshot, read ONCE per request by the caller (§4.13). */
  channels: ForceJoinChannel[];
  /** True for the explicit "بررسی عضویت" re-check — bypasses the negative cache. */
  bypassNegativeCache?: boolean;
}

/**
 * Evaluates the force-join gate against a single active-channel snapshot. All
 * channels are checked concurrently; the outcome is derived deterministically:
 *   - any genuinely NOT-joined channel  → MISSING (only those channels shown),
 *   - else any transient failure        → TEMP_FAILURE (fail closed, D2),
 *   - else                              → PASS (this also covers D4: when every
 *     active channel is unverifiable, nothing is missing and nothing is temp,
 *     so the user passes and the bot never bricks).
 * Unverifiable channels are excluded from the decision and raise a deduplicated
 * OWNER alert as a side effect.
 */
export async function evaluateForceJoinMembership(
  args: EvaluateMembershipArgs,
): Promise<ForceJoinGateOutcome> {
  const { api, userTelegramId, channels, bypassNegativeCache = false } = args;

  const results = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      check: await checkChannel(api, userTelegramId, channel, bypassNegativeCache),
    })),
  );

  const missing: ForceJoinChannel[] = [];
  let tempFailure = false;
  const alerts: Promise<void>[] = [];

  for (const { channel, check } of results) {
    if (check === "JOINED") {
      continue;
    }
    if (check === "NOT_JOINED") {
      missing.push(channel);
    } else if (check === "TEMP") {
      tempFailure = true;
    } else {
      // UNVERIFIABLE — excluded from gating; alert owners (deduped).
      alerts.push(
        emitUnverifiableAlert(channel, "UNVERIFIABLE").catch((err) => {
          logger.warn("force-join: alert emission failed", {
            channelId: channel.id,
            error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
          });
        }),
      );
    }
  }
  await Promise.all(alerts);

  if (missing.length > 0) {
    return { decision: "MISSING", missing };
  }
  if (tempFailure) {
    return { decision: "TEMP_FAILURE" };
  }
  return { decision: "PASS" };
}
