import { getBooleanSetting, getSetting, setSetting } from "./settings.service.js";

// =============================================================================
// Free-trial global settings (free-trial phase). Same pattern as
// payment-settings.service: key constants + built-in fallbacks over the
// Setting registry, NOT seeded - reads fall back safely when the row is
// missing. The feature is DISABLED by default for fresh and existing
// installations; per-panel readiness gates on top of these.
// =============================================================================

export const FREE_TRIAL_ENABLED_KEY = "free_trial_enabled";
export const FREE_TRIAL_ONCE_PER_USER_KEY = "free_trial_once_per_user";
export const FREE_TRIAL_COOLDOWN_DAYS_KEY = "free_trial_cooldown_days";
export const FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY = "free_trial_require_no_previous_purchase";
export const FREE_TRIAL_REQUIRE_MEMBERSHIP_KEY = "free_trial_require_channel_membership";
export const FREE_TRIAL_NOTICE_TEXT_KEY = "free_trial_notice_text";

/** Global kill-switch - false until an operator explicitly enables trials. */
export async function isFreeTrialEnabled(): Promise<boolean> {
  return getBooleanSetting(FREE_TRIAL_ENABLED_KEY, false);
}

export async function setFreeTrialEnabled(enabled: boolean): Promise<void> {
  await setSetting(FREE_TRIAL_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

/** Lifetime policy: one trial per user across the whole bot (default). */
export async function isFreeTrialOncePerUser(): Promise<boolean> {
  return getBooleanSetting(FREE_TRIAL_ONCE_PER_USER_KEY, true);
}

/**
 * Optional cooldown between trials in days; only meaningful when the
 * lifetime once-per-user policy is off. null = no cooldown configured.
 */
export async function freeTrialCooldownDays(): Promise<number | null> {
  const raw = await getSetting(FREE_TRIAL_COOLDOWN_DAYS_KEY, "");
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** When true, only users with NO successful paid order may take a trial. */
export async function freeTrialRequiresNoPreviousPurchase(): Promise<boolean> {
  return getBooleanSetting(FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY, false);
}

/**
 * When true, trial claims additionally require the forced-join membership
 * gate. NOTE: real getChatMember verification is a documented later phase
 * repo-wide (force-join.handler placeholder); this setting inherits that
 * gate's current behavior and hardens automatically when it does.
 */
export async function freeTrialRequiresChannelMembership(): Promise<boolean> {
  return getBooleanSetting(FREE_TRIAL_REQUIRE_MEMBERSHIP_KEY, false);
}

/** Optional operator notice appended to the trial confirmation page. */
export async function freeTrialNoticeText(): Promise<string> {
  return getSetting(FREE_TRIAL_NOTICE_TEXT_KEY, "");
}
