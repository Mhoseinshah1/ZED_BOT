import { prisma } from "@zedbot/database";
import {
  DEFAULT_STARS_SUBSCRIPTION_CONFIG,
  STARS_SUB_MAX_CURSOR_STALE_MINUTES,
  STARS_SUB_MAX_GRACE_MINUTES,
  STARS_SUB_MAX_LOOKBACK_HOURS,
  STARS_SUB_MAX_PAGES_PER_RUN,
  STARS_SUB_MAX_PAGE_SIZE,
  STARS_SUB_MAX_RECONCILE_MINUTES,
  STARS_SUB_MAX_REFUND_ATTEMPTS,
  STARS_SUB_MAX_REFUND_RETRY_MINUTES,
  STARS_SUB_MAX_RETENTION_DAYS,
  STARS_SUB_MIN_CURSOR_STALE_MINUTES,
  STARS_SUB_MIN_GRACE_MINUTES,
  STARS_SUB_MIN_LOOKBACK_HOURS,
  STARS_SUB_MIN_PAGES_PER_RUN,
  STARS_SUB_MIN_PAGE_SIZE,
  STARS_SUB_MIN_RECONCILE_MINUTES,
  STARS_SUB_MIN_REFUND_ATTEMPTS,
  STARS_SUB_MIN_REFUND_RETRY_MINUTES,
  STARS_SUB_MIN_RETENTION_DAYS,
  TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_CHARGE_RETENTION_DAYS_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_CURSOR_STALE_MINUTES_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_GRACE_MINUTES_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_MAX_PAGES_PER_RUN_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_RECONCILE_MINUTES_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_REFUND_MAX_ATTEMPTS_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_REFUND_RETRY_MINUTES_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_TRANSACTION_LOOKBACK_HOURS_KEY,
  TELEGRAM_STARS_SUBSCRIPTION_TRANSACTION_PAGE_SIZE_KEY,
  type StarsSubscriptionConfig,
} from "@zedbot/shared";

// =============================================================================
// Telegram Stars subscription SETTINGS reader (worker side). Reads the SAME
// Setting rows the bot honours, with the SAME @zedbot/shared bounds/defaults, so
// the worker recovery/PAST_DUE/refund/cleanup jobs and the bot see identical
// configuration. The master switch defaults FALSE — a worker whose install never
// enabled Stars subscriptions performs no recovery, PAST_DUE, or refund work.
// =============================================================================

async function settingValue(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value.trim() ?? "";
  return value === "" ? null : value;
}

function toBool(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function intSetting(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** MASTER switch (false for every install until the OWNER enables it). */
export async function isStarsSubscriptionsEnabled(): Promise<boolean> {
  return toBool(await settingValue(TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY));
}

/** The validated config, every field bounded and code-defaulted. */
export async function getStarsSubscriptionConfig(): Promise<StarsSubscriptionConfig> {
  const d = DEFAULT_STARS_SUBSCRIPTION_CONFIG;
  const [grace, reconcile, lookback, maxAttempts, retention, maxPages, pageSize, refundRetry, cursorStale] =
    await Promise.all([
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_GRACE_MINUTES_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_RECONCILE_MINUTES_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_TRANSACTION_LOOKBACK_HOURS_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_REFUND_MAX_ATTEMPTS_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_CHARGE_RETENTION_DAYS_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_MAX_PAGES_PER_RUN_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_TRANSACTION_PAGE_SIZE_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_REFUND_RETRY_MINUTES_KEY),
      settingValue(TELEGRAM_STARS_SUBSCRIPTION_CURSOR_STALE_MINUTES_KEY),
    ]);
  return {
    graceMinutes: intSetting(grace, d.graceMinutes, STARS_SUB_MIN_GRACE_MINUTES, STARS_SUB_MAX_GRACE_MINUTES),
    reconcileMinutes: intSetting(reconcile, d.reconcileMinutes, STARS_SUB_MIN_RECONCILE_MINUTES, STARS_SUB_MAX_RECONCILE_MINUTES),
    transactionLookbackHours: intSetting(lookback, d.transactionLookbackHours, STARS_SUB_MIN_LOOKBACK_HOURS, STARS_SUB_MAX_LOOKBACK_HOURS),
    refundMaxAttempts: intSetting(maxAttempts, d.refundMaxAttempts, STARS_SUB_MIN_REFUND_ATTEMPTS, STARS_SUB_MAX_REFUND_ATTEMPTS),
    pendingEnrollmentMinutes: d.pendingEnrollmentMinutes,
    chargeRetentionDays: intSetting(retention, d.chargeRetentionDays, STARS_SUB_MIN_RETENTION_DAYS, STARS_SUB_MAX_RETENTION_DAYS),
    consentVersion: d.consentVersion,
    maxPagesPerRun: intSetting(maxPages, d.maxPagesPerRun, STARS_SUB_MIN_PAGES_PER_RUN, STARS_SUB_MAX_PAGES_PER_RUN),
    transactionPageSize: intSetting(pageSize, d.transactionPageSize, STARS_SUB_MIN_PAGE_SIZE, STARS_SUB_MAX_PAGE_SIZE),
    refundRetryMinutes: intSetting(refundRetry, d.refundRetryMinutes, STARS_SUB_MIN_REFUND_RETRY_MINUTES, STARS_SUB_MAX_REFUND_RETRY_MINUTES),
    cursorStaleMinutes: intSetting(cursorStale, d.cursorStaleMinutes, STARS_SUB_MIN_CURSOR_STALE_MINUTES, STARS_SUB_MAX_CURSOR_STALE_MINUTES),
  };
}
