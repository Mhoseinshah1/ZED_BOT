import { prisma } from "@zedbot/database";
import {
  AUTO_RENEWAL_MAX_ATTEMPTS,
  AUTO_RENEWAL_MAX_CHARGE_LEAD_MINUTES,
  AUTO_RENEWAL_MAX_GRACE_HOURS,
  AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES,
  AUTO_RENEWAL_MAX_RETENTION_DAYS,
  AUTO_RENEWAL_MAX_SCAN_MINUTES,
  AUTO_RENEWAL_MIN_CHARGE_LEAD_MINUTES,
  AUTO_RENEWAL_MIN_GRACE_HOURS,
  AUTO_RENEWAL_MIN_MAX_ATTEMPTS,
  AUTO_RENEWAL_MIN_PRECHARGE_NOTICE_MINUTES,
  AUTO_RENEWAL_MIN_RETENTION_DAYS,
  AUTO_RENEWAL_MIN_SCAN_MINUTES,
  DEFAULT_WALLET_AUTO_RENEWAL_CONFIG,
  WALLET_AUTO_RENEWAL_ATTEMPT_RETENTION_DAYS_KEY,
  WALLET_AUTO_RENEWAL_CONSENT_VERSION_KEY,
  WALLET_AUTO_RENEWAL_DEFAULT_CHARGE_LEAD_MINUTES_KEY,
  WALLET_AUTO_RENEWAL_ENABLED_KEY,
  WALLET_AUTO_RENEWAL_GRACE_HOURS_KEY,
  WALLET_AUTO_RENEWAL_INSUFFICIENT_RETRY_INTERVALS_KEY,
  WALLET_AUTO_RENEWAL_MAX_ATTEMPTS_PER_CYCLE_KEY,
  WALLET_AUTO_RENEWAL_PRECHARGE_NOTICE_MINUTES_KEY,
  WALLET_AUTO_RENEWAL_SCAN_MINUTES_KEY,
  parseRetryIntervals,
  type WalletAutoRenewalConfig,
} from "@zedbot/shared";

// =============================================================================
// Wallet auto-renewal SETTINGS reader (worker side). Reads the SAME Setting rows
// the bot writes, with the SAME @zedbot/shared bounds/defaults, so the scan and
// the execute consumer see identical configuration. The master switch defaults
// FALSE, so a worker whose install never enabled auto-renewal scans nothing.
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
export async function isWalletAutoRenewalEnabled(): Promise<boolean> {
  return toBool(await settingValue(WALLET_AUTO_RENEWAL_ENABLED_KEY));
}

/** The validated config, every field bounded and code-defaulted. */
export async function getWalletAutoRenewalConfig(): Promise<WalletAutoRenewalConfig> {
  const d = DEFAULT_WALLET_AUTO_RENEWAL_CONFIG;
  const [scan, lead, notice, retries, grace, maxAttempts, retention, consent] = await Promise.all([
    settingValue(WALLET_AUTO_RENEWAL_SCAN_MINUTES_KEY),
    settingValue(WALLET_AUTO_RENEWAL_DEFAULT_CHARGE_LEAD_MINUTES_KEY),
    settingValue(WALLET_AUTO_RENEWAL_PRECHARGE_NOTICE_MINUTES_KEY),
    settingValue(WALLET_AUTO_RENEWAL_INSUFFICIENT_RETRY_INTERVALS_KEY),
    settingValue(WALLET_AUTO_RENEWAL_GRACE_HOURS_KEY),
    settingValue(WALLET_AUTO_RENEWAL_MAX_ATTEMPTS_PER_CYCLE_KEY),
    settingValue(WALLET_AUTO_RENEWAL_ATTEMPT_RETENTION_DAYS_KEY),
    settingValue(WALLET_AUTO_RENEWAL_CONSENT_VERSION_KEY),
  ]);
  return {
    scanMinutes: intSetting(scan, d.scanMinutes, AUTO_RENEWAL_MIN_SCAN_MINUTES, AUTO_RENEWAL_MAX_SCAN_MINUTES),
    defaultChargeLeadMinutes: intSetting(lead, d.defaultChargeLeadMinutes, AUTO_RENEWAL_MIN_CHARGE_LEAD_MINUTES, AUTO_RENEWAL_MAX_CHARGE_LEAD_MINUTES),
    prechargeNoticeMinutes: intSetting(notice, d.prechargeNoticeMinutes, AUTO_RENEWAL_MIN_PRECHARGE_NOTICE_MINUTES, AUTO_RENEWAL_MAX_PRECHARGE_NOTICE_MINUTES),
    insufficientRetryIntervalsMinutes: parseRetryIntervals(retries, d.insufficientRetryIntervalsMinutes),
    graceHours: intSetting(grace, d.graceHours, AUTO_RENEWAL_MIN_GRACE_HOURS, AUTO_RENEWAL_MAX_GRACE_HOURS),
    maxAttemptsPerCycle: intSetting(maxAttempts, d.maxAttemptsPerCycle, AUTO_RENEWAL_MIN_MAX_ATTEMPTS, AUTO_RENEWAL_MAX_ATTEMPTS),
    attemptRetentionDays: intSetting(retention, d.attemptRetentionDays, AUTO_RENEWAL_MIN_RETENTION_DAYS, AUTO_RENEWAL_MAX_RETENTION_DAYS),
    consentVersion: intSetting(consent, d.consentVersion, 1, 1_000_000),
  };
}
