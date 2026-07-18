import { randomUUID, createHash } from "node:crypto";

import { BACKUP_LOCK_KEY } from "@zedbot/shared";
import type { Queue } from "bullmq";

// =============================================================================
// Raw Redis access. The worker deliberately has NO direct ioredis dependency:
// pnpm's isolated node_modules make bullmq's ioredis un-importable from here,
// and adding a second redis client would double the connection count. Instead
// we reuse the connection BullMQ already holds (queue.client). BullMQ wraps
// the ioredis instance in a Proxy that forwards any command it does not
// override to the raw client with native ioredis varargs semantics, so the
// small typed subset below is safe at runtime.
// =============================================================================

export interface RawRedis {
  ping(): Promise<string>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** The shared (non-blocking) connection behind a BullMQ queue. */
export async function rawRedisClient(queue: Queue): Promise<RawRedis> {
  return (await queue.client) as unknown as RawRedis;
}

// --- backup lock -----------------------------------------------------------

/** Lock TTL: generously above the pg_dump watchdog so a live run never loses
 * its lock, but a crashed worker frees the system within 30 minutes. */
export const BACKUP_LOCK_TTL_MS = 30 * 60_000;

export interface BackupLock {
  token: string;
}

/** SET NX PX - returns null when another backup currently holds the lock. */
export async function acquireBackupLock(redis: RawRedis): Promise<BackupLock | null> {
  const token = randomUUID();
  const result = await redis.set(BACKUP_LOCK_KEY, token, "PX", BACKUP_LOCK_TTL_MS, "NX");
  return result === "OK" ? { token } : null;
}

// Compare-and-delete so we never release a lock a later run re-acquired.
const RELEASE_LOCK_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Releases the lock only when we still own it. Never throws. */
export async function releaseBackupLock(redis: RawRedis, lock: BackupLock): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, BACKUP_LOCK_KEY, lock.token);
  } catch {
    // The lock expires on its own via the PX TTL; nothing else to do.
  }
}

// --- generic named lock (SET NX PX + compare-and-delete release) -------------

export interface HeldLock {
  key: string;
  token: string;
}

/** SET NX PX on an arbitrary key; null when another holder currently owns it. */
export async function acquireLock(
  redis: RawRedis,
  key: string,
  ttlMs: number,
): Promise<HeldLock | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? { key, token } : null;
}

/** Releases a generic lock only when we still own it. Never throws. */
export async function releaseLock(redis: RawRedis, lock: HeldLock): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lock.key, lock.token);
  } catch {
    // TTL frees it; nothing else to do.
  }
}

// --- log aggregation counters ------------------------------------------------

export const LOG_AGGREGATION_WINDOW_SECONDS = 300;

/** Stable short hash for "the same log line" (eventType + message). */
export function logAggregationHash(eventType: string, message: string): string {
  return createHash("sha256").update(`${eventType}\n${message}`).digest("hex").slice(0, 16);
}

/**
 * INCRements the 5-minute aggregation counter for one (topic, log line) pair
 * and returns the new count. Count 1 means "first occurrence - send it";
 * higher counts mean the identical line was already sent inside the window
 * and the delivery should be skipped as "aggregated".
 *
 * Simplification (documented on purpose): no flush sweep sends a trailing
 * "repeated N times" summary - when the counter expires the aggregation
 * window simply resets and the next occurrence is delivered again.
 */
export async function bumpLogAggregation(
  redis: RawRedis,
  topicKey: string,
  hash: string,
): Promise<number> {
  const key = `zedbot:logagg:${topicKey}:${hash}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, LOG_AGGREGATION_WINDOW_SECONDS);
  }
  return count;
}
