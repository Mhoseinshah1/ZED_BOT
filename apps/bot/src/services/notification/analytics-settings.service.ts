import { Prisma, SettingType, prisma } from "@zedbot/database";
import {
  DEFAULT_ATTRIBUTION_CONFIG,
  NOTIF_ANALYTICS_CSV_EXPORT_ENABLED_KEY,
  NOTIF_ANALYTICS_ENABLED_KEY,
  NOTIF_ANALYTICS_REPORTING_TIMEZONE_KEY,
  NOTIF_ANALYTICS_STARTED_AT_KEY,
  NOTIF_ATTRIBUTION_CONFIG_KEY,
  parseAttributionConfig,
  resolveTimezone,
  type AttributionConfig,
} from "@zedbot/shared";

import { getBooleanSetting, getSetting, setSetting } from "../settings.service.js";

// =============================================================================
// Analytics & attribution SETTINGS (Phase 4), bot side. The worker reads the SAME
// Setting rows with the SAME @zedbot/shared parsers. Enabling analytics stamps
// `notification_analytics_started_at` EXACTLY ONCE (never overwritten), so
// attribution always begins from that instant forward and is never back-filled
// over historical orders. Disabling never clears the start instant (re-enabling
// keeps the original horizon). All mutations are OWNER-gated by the handler.
// =============================================================================

export async function isAnalyticsEnabled(): Promise<boolean> {
  return getBooleanSetting(NOTIF_ANALYTICS_ENABLED_KEY, false);
}

export async function isCsvExportEnabled(): Promise<boolean> {
  return getBooleanSetting(NOTIF_ANALYTICS_CSV_EXPORT_ENABLED_KEY, false);
}

/** The stamped analytics-start instant, or null when analytics was never enabled. */
export async function getAnalyticsStartedAt(): Promise<Date | null> {
  const raw = (await getSetting(NOTIF_ANALYTICS_STARTED_AT_KEY, "")).trim();
  if (raw === "") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export async function getAnalyticsReportingTimezone(): Promise<string> {
  return resolveTimezone(await getSetting(NOTIF_ANALYTICS_REPORTING_TIMEZONE_KEY, ""));
}

export async function getAnalyticsAttributionConfig(): Promise<AttributionConfig> {
  return parseAttributionConfig(
    await getSetting(NOTIF_ATTRIBUTION_CONFIG_KEY, ""),
    DEFAULT_ATTRIBUTION_CONFIG,
  );
}

/**
 * Stamps the analytics-start instant EXACTLY ONCE. A racing or repeated enable
 * converges on the first-written value (unique key -> P2002 -> no overwrite), so
 * the attribution horizon can never move and no historical back-fill is opened.
 */
async function stampStartedAtOnce(now: Date): Promise<void> {
  try {
    await prisma.setting.create({
      data: { key: NOTIF_ANALYTICS_STARTED_AT_KEY, value: now.toISOString(), type: "STRING" },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return; // already stamped -> keep the original horizon.
    }
    throw err;
  }
}

/**
 * Enables analytics: stamps the start instant (once) BEFORE flipping the switch,
 * so an attribution that fires the instant analytics turns on always sees a valid
 * horizon. Idempotent. Returns the effective start instant.
 */
export async function enableAnalytics(now: Date = new Date()): Promise<Date> {
  await stampStartedAtOnce(now);
  await setBooleanSetting(NOTIF_ANALYTICS_ENABLED_KEY, true);
  const started = await getAnalyticsStartedAt();
  return started ?? now;
}

/** Disables analytics. The start instant is preserved (re-enable keeps history). */
export async function disableAnalytics(): Promise<void> {
  await setBooleanSetting(NOTIF_ANALYTICS_ENABLED_KEY, false);
}

export async function setCsvExportEnabled(enabled: boolean): Promise<void> {
  await setBooleanSetting(NOTIF_ANALYTICS_CSV_EXPORT_ENABLED_KEY, enabled);
}

/** Upsert a boolean Setting + refresh the 30s settings cache (via setSetting). */
async function setBooleanSetting(key: string, enabled: boolean): Promise<void> {
  await setSetting(key, enabled ? "true" : "false", SettingType.BOOLEAN);
}
