import { prisma } from "@zedbot/database";
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

/** Boolean settings: "true" / "1" / "yes" are truthy (case-insensitive). */
export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const raw = (await getSetting(key, "")).toLowerCase();
  if (raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1" || raw === "yes";
}
