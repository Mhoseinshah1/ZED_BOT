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
 * Removes a Setting row (missing key is fine) and refreshes the cache so the
 * deletion is visible immediately, like setSetting.
 */
export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
  cache.set(key, { value: null, at: Date.now() });
}
