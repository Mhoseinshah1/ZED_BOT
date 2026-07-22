import { Prisma, prisma, type SettingType } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";

// Small TTL cache so every update does not hit the database for settings.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string | null; at: number }>();

/** Test hook / admin-edit hook: drops the settings cache. */
export function clearSettingsCache(): void {
  cache.clear();
}

/** Drops specific keys from the settings cache (targeted self-healing). */
export function clearSettingCacheKeys(keys: string[]): void {
  for (const key of keys) {
    cache.delete(key);
  }
}

/**
 * Reads a Setting value. Falls back (and never throws) when the key is
 * missing or the database is unavailable.
 */
export async function getSetting(key: string, fallback = ""): Promise<string> {
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? fallback;
  }
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    const value = row?.value ?? null;
    cache.set(key, { value, at: Date.now() });
    return value ?? fallback;
  } catch (err) {
    logger.warn("setting lookup failed, using fallback", { key, error: errorMessage(err) });
    return fallback;
  }
}

/** The exact truthy set getBooleanSetting accepts (case-insensitive). */
const TRUTHY_SETTING_VALUES = ["true", "1", "yes"];

/** Boolean settings: "true" / "1" / "yes" are truthy (case-insensitive). */
export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const raw = (await getSetting(key, "")).toLowerCase();
  if (raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Reads a Setting BYPASSING the 30s process-local cache (and refreshes it).
 * For emergency master switches that must take effect across all workers the
 * instant an OWNER flips them — the local cache is per-process, so a stale
 * `true` on another instance would otherwise keep accepting actions for up to
 * the TTL. Never throws; falls back on a DB error.
 */
export async function getSettingFresh(key: string, fallback = ""): Promise<string> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    const value = row?.value ?? null;
    cache.set(key, { value, at: Date.now() });
    return value ?? fallback;
  } catch (err) {
    logger.warn("fresh setting lookup failed, using fallback", { key, error: errorMessage(err) });
    return fallback;
  }
}

/** Uncached boolean read (see getSettingFresh) for emergency master switches. */
export async function getBooleanSettingFresh(key: string, fallback: boolean): Promise<boolean> {
  const raw = (await getSettingFresh(key, "")).toLowerCase();
  if (raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Writes (upserts) a Setting and refreshes the cache entry so the new value
 * is visible immediately (no 30s TTL lag for the writer's own reads).
 */
export async function setSetting(key: string, value: string, type: SettingType): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value, type },
    create: { key, value, type },
  });
  cache.set(key, { value, at: Date.now() });
}

/**
 * Atomic compare-and-set for a boolean Setting: flips the row to `next`
 * ONLY while its current boolean interpretation (absent row = false, same
 * truthy set as getBooleanSetting) still equals `expected`. Every branch is
 * a single conditional statement - there is no read-check-write window, so
 * two racing admins can never both "win" the same transition. Returns false
 * when the stored state moved on (stale confirmation).
 */
export async function compareAndSetBooleanSetting(
  key: string,
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  const value = next ? "true" : "false";
  const truthy = { in: TRUTHY_SETTING_VALUES, mode: Prisma.QueryMode.insensitive };
  if (expected) {
    const updated = await prisma.setting.updateMany({
      where: { key, value: truthy },
      data: { value, type: "BOOLEAN" },
    });
    if (updated.count === 0) {
      return false; // absent or already falsy - not the expected "enabled"
    }
  } else {
    const updated = await prisma.setting.updateMany({
      where: { key, NOT: { value: truthy } },
      data: { value, type: "BOOLEAN" },
    });
    if (updated.count === 0) {
      // No falsy row: the key is absent (create claims the transition) or a
      // concurrent writer already enabled it (unique violation = CAS lost).
      try {
        await prisma.setting.create({ data: { key, value, type: "BOOLEAN" } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return false;
        }
        throw err;
      }
    }
  }
  cache.set(key, { value, at: Date.now() });
  return true;
}

/**
 * Transaction-aware Setting upsert: writes through the given Prisma client (a
 * $transaction client, so the write commits atomically with its siblings).
 *
 * Deliberately does NOT touch the process cache. The enclosing transaction may
 * roll back, and seeding the cache with an uncommitted value would make this
 * process advertise a group that was never activated until the 30s TTL expired
 * (and would let a concurrent same-process read observe the new value before
 * commit). The caller MUST clearSettingsCache() AFTER the transaction commits
 * (see activateLogGroup) so the committed value is read fresh; on rollback the
 * cache is untouched and keeps serving the previous, still-active group.
 */
export async function setSettingWithClient(
  client: Prisma.TransactionClient,
  key: string,
  value: string,
  type: SettingType,
): Promise<void> {
  await client.setting.upsert({
    where: { key },
    update: { value, type },
    create: { key, value, type },
  });
}

/**
 * Removes a Setting row (missing key is fine) and refreshes the cache so the
 * deletion is visible immediately, like setSetting.
 */
export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
  cache.set(key, { value: null, at: Date.now() });
}
