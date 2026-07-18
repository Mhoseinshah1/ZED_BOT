import { prisma } from "@zedbot/database";
import {
  DEFAULT_DAILY_LIMIT,
  DEFAULT_DEAD_LETTER_RETENTION_DAYS,
  DEFAULT_EXPIRY_THRESHOLDS,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_SCHEDULE_MINUTES,
  DEFAULT_SERVICE_STATE_MAX_AGE_MINUTES,
  DEFAULT_SYNC_CONCURRENCY,
  DEFAULT_TIMEZONE,
  DEFAULT_TRAFFIC_THRESHOLDS,
  DEFAULT_TRIAL_THRESHOLDS,
  NOTIF_DAILY_LIMIT_DEFAULT_KEY,
  NOTIF_DEAD_LETTER_RETENTION_DAYS_KEY,
  NOTIF_DEFAULT_TIMEZONE_KEY,
  NOTIF_ENABLED_KEY,
  NOTIF_EXPIRY_THRESHOLDS_KEY,
  NOTIF_FAILED_RETENTION_DAYS_KEY,
  NOTIF_HISTORY_RETENTION_DAYS_KEY,
  NOTIF_QUIET_HOURS_DEFAULT_KEY,
  NOTIF_RULE_ENABLED_KEYS,
  NOTIF_SCHEDULE_KEYS,
  NOTIF_SERVICE_STATE_MAX_AGE_MINUTES_KEY,
  NOTIF_SYNC_CONCURRENCY_KEY,
  NOTIF_TRAFFIC_THRESHOLDS_KEY,
  NOTIF_TRIAL_THRESHOLDS_KEY,
  parseExpiryThresholds,
  parseQuietHours,
  parseTrafficThresholds,
  resolveTimezone,
  type ExpiryThreshold,
  type NotificationRuleKey,
  type QuietHoursConfig,
} from "@zedbot/shared";

// =============================================================================
// Worker-side notification-engine settings READER (feat/notification-retention-
// engine, Phase 1). The bot owns writes (notification-settings.service.ts); the
// worker only reads Setting rows and parses them with the SAME pure @zedbot/
// shared helpers, so the scan/delivery loops see identical configuration. The
// master switch + per-rule switches default FALSE, so a worker whose install
// never enabled the engine schedules and delivers nothing.
// =============================================================================

/** Raw trimmed Setting value, or null when unset/blank. */
async function settingValue(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value.trim() ?? "";
  return value === "" ? null : value;
}

function toBool(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  const v = raw.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

async function intSetting(key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = await settingValue(key);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

/** MASTER switch. False for every existing install until explicitly enabled. */
export async function isNotificationSystemEnabled(): Promise<boolean> {
  return toBool(await settingValue(NOTIF_ENABLED_KEY));
}

export async function isNotificationRuleEnabled(rule: NotificationRuleKey): Promise<boolean> {
  return toBool(await settingValue(NOTIF_RULE_ENABLED_KEYS[rule]));
}

export async function getDefaultTimezone(): Promise<string> {
  return resolveTimezone(await settingValue(NOTIF_DEFAULT_TIMEZONE_KEY), DEFAULT_TIMEZONE);
}

export async function getServiceStateMaxAgeMinutes(): Promise<number> {
  return intSetting(
    NOTIF_SERVICE_STATE_MAX_AGE_MINUTES_KEY,
    DEFAULT_SERVICE_STATE_MAX_AGE_MINUTES,
    1,
    24 * 60,
  );
}

export async function getSyncConcurrency(): Promise<number> {
  return intSetting(NOTIF_SYNC_CONCURRENCY_KEY, DEFAULT_SYNC_CONCURRENCY, 1, 20);
}

export async function getDailyLimitDefault(): Promise<number> {
  return intSetting(NOTIF_DAILY_LIMIT_DEFAULT_KEY, DEFAULT_DAILY_LIMIT, 1, 50);
}

export async function getExpiryThresholds(): Promise<ExpiryThreshold[]> {
  return parseExpiryThresholds(await settingValue(NOTIF_EXPIRY_THRESHOLDS_KEY), DEFAULT_EXPIRY_THRESHOLDS);
}

export async function getTrialThresholds(): Promise<ExpiryThreshold[]> {
  return parseExpiryThresholds(await settingValue(NOTIF_TRIAL_THRESHOLDS_KEY), DEFAULT_TRIAL_THRESHOLDS);
}

export async function getTrafficThresholds(): Promise<number[]> {
  return parseTrafficThresholds(await settingValue(NOTIF_TRAFFIC_THRESHOLDS_KEY), DEFAULT_TRAFFIC_THRESHOLDS);
}

export async function getDefaultQuietHours(): Promise<QuietHoursConfig> {
  return parseQuietHours(await settingValue(NOTIF_QUIET_HOURS_DEFAULT_KEY), DEFAULT_QUIET_HOURS);
}

export interface NotificationScheduleMinutes {
  serviceSync: number;
  serviceScan: number;
  reconcile: number;
  cleanup: number;
}

export async function getScheduleMinutes(): Promise<NotificationScheduleMinutes> {
  const [serviceSync, serviceScan, reconcile, cleanup] = await Promise.all([
    intSetting(NOTIF_SCHEDULE_KEYS.serviceSyncMinutes, DEFAULT_SCHEDULE_MINUTES.serviceSync, 1, 24 * 60),
    intSetting(NOTIF_SCHEDULE_KEYS.serviceScanMinutes, DEFAULT_SCHEDULE_MINUTES.serviceScan, 1, 24 * 60),
    intSetting(NOTIF_SCHEDULE_KEYS.reconcileMinutes, DEFAULT_SCHEDULE_MINUTES.reconcile, 1, 24 * 60),
    intSetting(NOTIF_SCHEDULE_KEYS.cleanupMinutes, DEFAULT_SCHEDULE_MINUTES.cleanup, 5, 30 * 24 * 60),
  ]);
  return { serviceSync, serviceScan, reconcile, cleanup };
}

export interface NotificationRetentionDays {
  history: number;
  failed: number;
  deadLetter: number;
}

export async function getRetentionDays(): Promise<NotificationRetentionDays> {
  const [history, failed, deadLetter] = await Promise.all([
    intSetting(NOTIF_HISTORY_RETENTION_DAYS_KEY, DEFAULT_HISTORY_RETENTION_DAYS, 1, 3650),
    intSetting(NOTIF_FAILED_RETENTION_DAYS_KEY, DEFAULT_FAILED_RETENTION_DAYS, 1, 3650),
    intSetting(NOTIF_DEAD_LETTER_RETENTION_DAYS_KEY, DEFAULT_DEAD_LETTER_RETENTION_DAYS, 1, 3650),
  ]);
  return { history, failed, deadLetter };
}
