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
  DEFAULT_TRAFFIC_THRESHOLDS,
  DEFAULT_TRIAL_THRESHOLDS,
  DEFAULT_TIMEZONE,
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
  DEFAULT_ABANDONED_CHECKOUT_CONFIG,
  DEFAULT_FAILED_PAYMENT_CONFIG,
  NOTIF_ABANDONED_CONFIG_KEY,
  NOTIF_CHECKOUT_RULE_ENABLED_KEYS,
  NOTIF_PAYMENT_RETRY_CONFIG_KEY,
  parseAbandonedCheckoutConfig,
  parseFailedPaymentConfig,
  type AbandonedCheckoutConfig,
  type CheckoutNotificationRuleKey,
  type FailedPaymentConfig,
  DEFAULT_RETENTION_SCAN_MINUTES,
  DEFAULT_WINBACK_CONFIG,
  NOTIF_RETENTION_SCAN_MINUTES_KEY,
  NOTIF_WINBACK_CONFIG_KEY,
  NOTIF_WINBACK_ENABLED_KEY,
  parseWinbackConfig,
  type WinbackConfig,
} from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  getBooleanSetting,
  getSetting,
  setSetting,
} from "../settings.service.js";

// =============================================================================
// Notification-engine settings wrappers (feat/notification-retention-engine,
// Phase 1). Every value is a validated, defaulted read of a Setting row; the
// master switch + per-rule switches default FALSE so an existing installation
// is fully dormant until an operator explicitly enables the system. All parsing
// happens in @zedbot/shared (pure, unit-tested); this module only binds it to
// the Setting store.
// =============================================================================

/** MASTER switch. False for every existing install until explicitly enabled. */
export async function isNotificationSystemEnabled(): Promise<boolean> {
  return getBooleanSetting(NOTIF_ENABLED_KEY, false);
}

/** Atomic master toggle (race-free enable/disable). */
export async function compareAndSetNotificationSystemEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(NOTIF_ENABLED_KEY, expected, next);
}

export async function isNotificationRuleEnabled(rule: NotificationRuleKey): Promise<boolean> {
  return getBooleanSetting(NOTIF_RULE_ENABLED_KEYS[rule], false);
}

export async function setNotificationRuleEnabled(
  rule: NotificationRuleKey,
  enabled: boolean,
): Promise<void> {
  await setSetting(NOTIF_RULE_ENABLED_KEYS[rule], enabled ? "true" : "false", "BOOLEAN");
}

export async function anyNotificationRuleEnabled(): Promise<boolean> {
  const [expiry, traffic, trial] = await Promise.all([
    isNotificationRuleEnabled("expiry"),
    isNotificationRuleEnabled("traffic"),
    isNotificationRuleEnabled("trial"),
  ]);
  return expiry || traffic || trial;
}

export async function getDefaultTimezone(): Promise<string> {
  return resolveTimezone(await getSetting(NOTIF_DEFAULT_TIMEZONE_KEY, ""), DEFAULT_TIMEZONE);
}

export async function setDefaultTimezone(timezone: string): Promise<void> {
  await setSetting(NOTIF_DEFAULT_TIMEZONE_KEY, resolveTimezone(timezone), "STRING");
}

async function getIntSetting(key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = await getSetting(key, "");
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

export async function getServiceStateMaxAgeMinutes(): Promise<number> {
  return getIntSetting(
    NOTIF_SERVICE_STATE_MAX_AGE_MINUTES_KEY,
    DEFAULT_SERVICE_STATE_MAX_AGE_MINUTES,
    1,
    24 * 60,
  );
}

export async function getSyncConcurrency(): Promise<number> {
  return getIntSetting(NOTIF_SYNC_CONCURRENCY_KEY, DEFAULT_SYNC_CONCURRENCY, 1, 20);
}

export async function getDailyLimitDefault(): Promise<number> {
  return getIntSetting(NOTIF_DAILY_LIMIT_DEFAULT_KEY, DEFAULT_DAILY_LIMIT, 1, 50);
}

export async function getExpiryThresholds(): Promise<ExpiryThreshold[]> {
  return parseExpiryThresholds(await getSetting(NOTIF_EXPIRY_THRESHOLDS_KEY, ""), DEFAULT_EXPIRY_THRESHOLDS);
}

export async function getTrialThresholds(): Promise<ExpiryThreshold[]> {
  return parseExpiryThresholds(await getSetting(NOTIF_TRIAL_THRESHOLDS_KEY, ""), DEFAULT_TRIAL_THRESHOLDS);
}

export async function getTrafficThresholds(): Promise<number[]> {
  return parseTrafficThresholds(await getSetting(NOTIF_TRAFFIC_THRESHOLDS_KEY, ""), DEFAULT_TRAFFIC_THRESHOLDS);
}

export async function getDefaultQuietHours(): Promise<QuietHoursConfig> {
  return parseQuietHours(await getSetting(NOTIF_QUIET_HOURS_DEFAULT_KEY, ""), DEFAULT_QUIET_HOURS);
}

export async function setDefaultQuietHours(config: QuietHoursConfig): Promise<void> {
  await setSetting(NOTIF_QUIET_HOURS_DEFAULT_KEY, JSON.stringify(config), "JSON");
}

export interface NotificationScheduleMinutes {
  serviceSync: number;
  serviceScan: number;
  reconcile: number;
  cleanup: number;
}

export async function getScheduleMinutes(): Promise<NotificationScheduleMinutes> {
  const [serviceSync, serviceScan, reconcile, cleanup] = await Promise.all([
    getIntSetting(NOTIF_SCHEDULE_KEYS.serviceSyncMinutes, DEFAULT_SCHEDULE_MINUTES.serviceSync, 1, 24 * 60),
    getIntSetting(NOTIF_SCHEDULE_KEYS.serviceScanMinutes, DEFAULT_SCHEDULE_MINUTES.serviceScan, 1, 24 * 60),
    getIntSetting(NOTIF_SCHEDULE_KEYS.reconcileMinutes, DEFAULT_SCHEDULE_MINUTES.reconcile, 1, 24 * 60),
    getIntSetting(NOTIF_SCHEDULE_KEYS.cleanupMinutes, DEFAULT_SCHEDULE_MINUTES.cleanup, 5, 30 * 24 * 60),
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
    getIntSetting(NOTIF_HISTORY_RETENTION_DAYS_KEY, DEFAULT_HISTORY_RETENTION_DAYS, 1, 3650),
    getIntSetting(NOTIF_FAILED_RETENTION_DAYS_KEY, DEFAULT_FAILED_RETENTION_DAYS, 1, 3650),
    getIntSetting(NOTIF_DEAD_LETTER_RETENTION_DAYS_KEY, DEFAULT_DEAD_LETTER_RETENTION_DAYS, 1, 3650),
  ]);
  return { history, failed, deadLetter };
}

// =============================================================================
// Checkout-payment reminders (Phase 2). Two independent rule switches +
// validated JSON configs, mirroring the Phase-1 rule helpers above. Both rules
// default FALSE (the parsers own all validation, so a malformed stored value
// falls back to the shared default and the engine never sees invalid config).
// These write ONLY their own Setting keys - never the master switch and never a
// service-notification rule.
// =============================================================================

export async function isCheckoutRuleEnabled(rule: CheckoutNotificationRuleKey): Promise<boolean> {
  return getBooleanSetting(NOTIF_CHECKOUT_RULE_ENABLED_KEYS[rule], false);
}

export async function setCheckoutRuleEnabled(
  rule: CheckoutNotificationRuleKey,
  enabled: boolean,
): Promise<void> {
  await setSetting(NOTIF_CHECKOUT_RULE_ENABLED_KEYS[rule], enabled ? "true" : "false", "BOOLEAN");
}

/** True when either checkout-payment rule (abandoned OR payment-retry) is on. */
export async function anyCheckoutRuleEnabled(): Promise<boolean> {
  const [abandoned, payment] = await Promise.all([
    isCheckoutRuleEnabled("abandoned"),
    isCheckoutRuleEnabled("payment"),
  ]);
  return abandoned || payment;
}

export async function getAbandonedCheckoutConfig(): Promise<AbandonedCheckoutConfig> {
  return parseAbandonedCheckoutConfig(
    await getSetting(NOTIF_ABANDONED_CONFIG_KEY, ""),
    DEFAULT_ABANDONED_CHECKOUT_CONFIG,
  );
}

/** Validates via the shared parser (defaulting invalid input) before persisting the full JSON. */
export async function setAbandonedCheckoutConfig(cfg: AbandonedCheckoutConfig): Promise<void> {
  const validated = parseAbandonedCheckoutConfig(cfg, DEFAULT_ABANDONED_CHECKOUT_CONFIG);
  await setSetting(NOTIF_ABANDONED_CONFIG_KEY, JSON.stringify(validated), "JSON");
}

export async function getFailedPaymentConfig(): Promise<FailedPaymentConfig> {
  return parseFailedPaymentConfig(
    await getSetting(NOTIF_PAYMENT_RETRY_CONFIG_KEY, ""),
    DEFAULT_FAILED_PAYMENT_CONFIG,
  );
}

/** Validates via the shared parser (defaulting invalid input) before persisting the full JSON. */
export async function setFailedPaymentConfig(cfg: FailedPaymentConfig): Promise<void> {
  const validated = parseFailedPaymentConfig(cfg, DEFAULT_FAILED_PAYMENT_CONFIG);
  await setSetting(NOTIF_PAYMENT_RETRY_CONFIG_KEY, JSON.stringify(validated), "JSON");
}

// =============================================================================
// Customer win-back (Phase 3). One MARKETING rule switch + a validated JSON
// config, mirroring the Phase-2 helpers. The rule defaults FALSE (no marketing
// until the OWNER enables it). Writes ONLY the win-back Setting keys.
// =============================================================================

export async function isWinbackRuleEnabled(): Promise<boolean> {
  return getBooleanSetting(NOTIF_WINBACK_ENABLED_KEY, false);
}

export async function setWinbackRuleEnabled(enabled: boolean): Promise<void> {
  await setSetting(NOTIF_WINBACK_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

export async function getWinbackConfig(): Promise<WinbackConfig> {
  return parseWinbackConfig(await getSetting(NOTIF_WINBACK_CONFIG_KEY, ""), DEFAULT_WINBACK_CONFIG);
}

/** Validates via the shared parser (defaulting invalid input) before persisting the full JSON. */
export async function setWinbackConfig(cfg: WinbackConfig): Promise<void> {
  const validated = parseWinbackConfig(cfg, DEFAULT_WINBACK_CONFIG);
  await setSetting(NOTIF_WINBACK_CONFIG_KEY, JSON.stringify(validated), "JSON");
}

export async function getRetentionScanMinutes(): Promise<number> {
  const raw = await getSetting(NOTIF_RETENTION_SCAN_MINUTES_KEY, "");
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 60 || n > 7 * 24 * 60) {
    return DEFAULT_RETENTION_SCAN_MINUTES;
  }
  return n;
}
