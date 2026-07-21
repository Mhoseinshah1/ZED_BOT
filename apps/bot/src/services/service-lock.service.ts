import { randomBytes } from "node:crypto";

import { getRedisOptions } from "@zedbot/shared";
import { Redis } from "ioredis";

import { logger } from "../core/logger.js";

// =============================================================================
// Distributed per-service operation lock (Redis).
//
// Order-level idempotency (claims, event logs, unique keys) protects one
// Order from applying twice - it does NOT protect two DIFFERENT Orders that
// target the SAME Service. Both can read the same quota/expiry, both compute
// from it, and the second panel write silently overwrites the first (a paid
// mutation is lost while both Orders complete). Reconciliation has the twin
// problem: it can observe another operation's remote change and attribute it
// to a stale Order.
//
// This module serializes the whole critical sequence (read local state ->
// read/mutate panel -> persist Service/EventLog/Order) per service:
//
//   key    zedbot:service-operation:<serviceId>          (existing services)
//          zedbot:service-provisioning:<panelId>:<user>  (before a Service
//                                                         row exists; the
//                                                         username is
//                                                         deterministic per
//                                                         order)
//   value  a cryptographically random ownership token (never logged)
//
// Guarantees:
//   - acquisition is a single atomic `SET key token NX PX ttl`;
//   - bounded waiting with jittered retry, then a RETRYABLE result - paid
//     Orders stay PAID, nothing is refunded, the panel is never called;
//   - release is ownership-safe (compare-and-delete Lua) and runs in the
//     caller's `finally`; an expired lock can never delete a newer owner's;
//   - a heartbeat renews the TTL (compare-and-pexpire Lua) while the
//     operation runs; renewal that finds a foreign token marks the lock
//     LOST and logs an error - the TTL (90s) is already several times the
//     worst-case operation (panel calls are 10s-bounded), so loss means
//     something is seriously wrong;
//   - Redis being unreachable FAILS CLOSED: no lock -> no panel call, no
//     money movement, order stays retryable / reconciliation defers. The
//     bot never proceeds unlocked.
//   - Locks for different services are independent - no global serialization.
// =============================================================================

/** Telegram-facing: another operation currently holds this service. */
export const SERVICE_LOCK_BUSY_TEXT =
  "عملیات دیگری روی این سرویس در حال انجام است. لطفاً چند لحظه دیگر دوباره تلاش کنید.";
/** Telegram-facing: the lock backend is unavailable - try again later. */
export const SERVICE_LOCK_UNAVAILABLE_TEXT =
  "انجام عملیات سرویس موقتاً امکان‌پذیر نیست. لطفاً کمی بعد دوباره تلاش کنید.";
/** Telegram-facing: outcome left undecided; automatic review will settle it. */
export const SERVICE_LOCK_LOST_TEXT =
  "نتیجه عملیات نامشخص ماند؛ وضعیت سفارش به‌صورت خودکار بررسی و اصلاح می‌شود.";

/**
 * TTL vs operation duration: a pipeline performs at most ~4 panel HTTP
 * calls (each AbortSignal-bounded at 10s) plus small DB transactions, so
 * the worst case sits well under 60s. 90s TTL + a 30s heartbeat keeps the
 * lock alive for outliers while still expiring crashed owners quickly.
 */
export const SERVICE_LOCK_TTL_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Default bounded wait for paid operations before returning retryable. */
export const SERVICE_LOCK_WAIT_MS = 5_000;
/** Reconciliation never waits - contention means live work; defer instead. */
export const RECONCILE_LOCK_WAIT_MS = 0;
const RETRY_BASE_DELAY_MS = 150;
const RETRY_JITTER_MS = 100;
const REDIS_CONNECT_TIMEOUT_MS = 2_000;
/**
 * Hard upper bound for every lock command: ioredis reconnect edge cases can
 * otherwise leave a command pending far longer than the connect timeout.
 * A command that cannot settle in this window means the lock backend is
 * unusable - fail closed instead of blocking a payment path.
 */
const COMMAND_TIMEOUT_MS = 3_000;

function commandWithTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("redis command timed out"));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export function serviceOperationLockKey(serviceId: string): string {
  return `zedbot:service-operation:${serviceId}`;
}

/** Provisioning lock for orders that have no Service row yet. */
export function serviceProvisioningLockKey(panelId: string, username: string): string {
  return `zedbot:service-provisioning:${panelId}:${username}`;
}

/** Per owner+Service cooldown key for explicit service diagnostics runs. */
export function serviceDiagnosticsCooldownKey(userId: string, serviceId: string): string {
  return `zedbot:diag-cooldown:${userId}:${serviceId}`;
}

export type CooldownGate =
  | { state: "armed" }
  | { state: "cooling"; remainingMs: number }
  | { state: "degraded" };

/**
 * Best-effort per-key cooldown, reusing the SAME Redis client as the lock (no
 * second client is created for the cooldown feature). Atomically `SET key 1 NX
 * PX ttl`:
 *   - "armed"    : the key was set - the caller MAY proceed (window opened);
 *   - "cooling"  : the key already existed - the caller is inside the window;
 *                  remainingMs comes from PTTL (0 if it just expired);
 *   - "degraded" : Redis is unavailable - FAIL OPEN so a cooldown outage never
 *                  blocks or crashes the bot (the per-service LOCK stays the
 *                  authoritative concurrency guard). Never throws.
 */
export async function checkAndArmCooldown(key: string, ttlMs: number): Promise<CooldownGate> {
  const redis = getClient();
  if (redis === null) {
    return { state: "degraded" };
  }
  try {
    const set = await commandWithTimeout(redis.set(key, "1", "PX", ttlMs, "NX"));
    if (set === "OK") {
      return { state: "armed" };
    }
    let remainingMs = 0;
    try {
      const pttl = await commandWithTimeout(redis.pttl(key));
      remainingMs = typeof pttl === "number" && pttl > 0 ? pttl : 0;
    } catch {
      remainingMs = 0;
    }
    return { state: "cooling", remainingMs };
  } catch (err) {
    logger.warn("cooldown check failed - failing open", { error: errorText(err) });
    return { state: "degraded" };
  }
}

/** Clears a cooldown key (test hook / explicit reset). Never throws. */
export async function clearCooldown(key: string): Promise<void> {
  const redis = getClient();
  if (redis === null) {
    return;
  }
  try {
    await commandWithTimeout(redis.del(key));
  } catch {
    // Best-effort - the TTL will expire it anyway.
  }
}

export interface ServiceLock {
  readonly key: string;
  /** True once a heartbeat found a foreign/expired token. */
  isLost(): boolean;
  /** Ownership-safe release; always call from `finally`. Never throws. */
  release(): Promise<void>;
}

export type ServiceLockAcquisition =
  | { ok: true; lock: ServiceLock }
  | { ok: false; reason: "contended" | "unavailable" };

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
    // Fail-closed configuration: a command may queue briefly during the
    // initial connect, but after ONE failed reconnect attempt it rejects
    // (maxRetriesPerRequest) - an unreachable Redis surfaces within
    // milliseconds (refused) or the 2s connect timeout, never blocks, and
    // reconnection keeps retrying in the background with a capped delay.
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on("error", (err) => {
    // Never log connection details or auth material - message only.
    logger.warn("service lock redis error", {
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  });
  client = redis;
  clientFingerprint = fingerprint;
  return client;
}

/** Test hook: drops the cached client so env changes take effect. */
export function resetServiceLockClientForTests(): void {
  if (client !== null) {
    client.disconnect();
    client = null;
    clientFingerprint = "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLock(redis: Redis, key: string, token: string): ServiceLock {
  let lost = false;
  let released = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const renewed = await commandWithTimeout(
          redis.eval(RENEW_LUA, 1, key, token, String(SERVICE_LOCK_TTL_MS)),
        );
        if (renewed !== 1 && !released) {
          lost = true;
          clearInterval(heartbeat);
          // Serious: the TTL is far above the worst-case operation, so a
          // foreign token means expiry under extreme stall or manual
          // interference. Callers check isLost() before final persistence.
          logger.error("service lock ownership lost during operation", { key });
        }
      } catch {
        // Transient Redis error - the TTL keeps counting; retry next tick.
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    key,
    isLost: () => lost,
    async release(): Promise<void> {
      released = true;
      clearInterval(heartbeat);
      try {
        await commandWithTimeout(redis.eval(RELEASE_LUA, 1, key, token));
      } catch (err) {
        // The TTL will expire the key; never throw from a finally-release.
        logger.warn("service lock release failed - TTL will expire it", {
          key,
          error: errorText(err),
        });
      }
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

/**
 * One cheap availability probe (random key, immediate release). Lets batch
 * callers (the startup reconciliation sweep) fail closed ONCE instead of
 * paying the unavailable-command timeout per order.
 */
export async function isLockBackendAvailable(): Promise<boolean> {
  const probeKey = `zedbot:service-lock:probe:${randomBytes(8).toString("hex")}`;
  const probe = await acquireServiceLock(probeKey, 0);
  if (!probe.ok) {
    // A random key can only fail as "unavailable".
    return false;
  }
  await probe.lock.release();
  return true;
}

/**
 * Acquires the lock, waiting up to `waitMs` with jittered retries.
 * `waitMs = 0` performs exactly one attempt. Never throws.
 */
export async function acquireServiceLock(
  key: string,
  waitMs: number = SERVICE_LOCK_WAIT_MS,
): Promise<ServiceLockAcquisition> {
  const redis = getClient();
  if (redis === null) {
    return { ok: false, reason: "unavailable" };
  }
  const token = randomBytes(24).toString("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    let result: "OK" | null;
    try {
      result = await commandWithTimeout(redis.set(key, token, "PX", SERVICE_LOCK_TTL_MS, "NX"));
    } catch (err) {
      logger.warn("service lock acquisition failed - treating as unavailable", {
        key,
        error: errorText(err),
      });
      return { ok: false, reason: "unavailable" };
    }
    if (result === "OK") {
      return { ok: true, lock: makeLock(redis, key, token) };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, reason: "contended" };
    }
    const delay = RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
    await sleep(Math.min(delay, remaining));
  }
}
