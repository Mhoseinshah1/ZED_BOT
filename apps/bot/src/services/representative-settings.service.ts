import {
  REPRESENTATIVE_APPLICATIONS_ENABLED_KEY,
  REPRESENTATIVE_CHECKOUT_ENABLED_KEY,
  REPRESENTATIVE_PROGRAM_ENABLED_KEY,
} from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  getBooleanSetting,
  getBooleanSettingFresh,
  setSetting,
} from "./settings.service.js";

// =============================================================================
// Representative Program — rollout switches (feat/representative-program, §3).
// Same pattern as admin-service-settings / support-attachment-settings: the KEYS
// live in @zedbot/shared; all three default FALSE so the program is dormant
// (menu entry hidden, dashboard + applications + reseller checkout all closed)
// until the OWNER enables it. Toggling deletes no application, cancels no
// settled Payment/paid Order, and revokes no provisioned Service.
// =============================================================================

/** Master switch — the whole program is hidden/closed until the OWNER turns it
 * on. The main-menu representative row is shown only when this is true. */
export async function isRepresentativeProgramEnabled(): Promise<boolean> {
  return getBooleanSetting(REPRESENTATIVE_PROGRAM_ENABLED_KEY, false);
}

/** Gates NEW applications only — existing applications keep their status. */
export async function areRepresentativeApplicationsEnabled(): Promise<boolean> {
  return getBooleanSetting(REPRESENTATIVE_APPLICATIONS_ENABLED_KEY, false);
}

/** Gates NEW reseller-priced checkout creation — settled payments and paid
 * orders are never cancelled by flipping this. */
export async function isRepresentativeCheckoutEnabled(): Promise<boolean> {
  return getBooleanSetting(REPRESENTATIVE_CHECKOUT_ENABLED_KEY, false);
}

/** UNCACHED reads for the just-in-time gates at money-moving points, so an OWNER
 * emergency-disable takes effect across all workers immediately (the cached read
 * can lag by the settings TTL on other instances). */
export async function isRepresentativeProgramEnabledFresh(): Promise<boolean> {
  return getBooleanSettingFresh(REPRESENTATIVE_PROGRAM_ENABLED_KEY, false);
}
export async function isRepresentativeCheckoutEnabledFresh(): Promise<boolean> {
  return getBooleanSettingFresh(REPRESENTATIVE_CHECKOUT_ENABLED_KEY, false);
}

async function setBool(key: string, enabled: boolean): Promise<void> {
  await setSetting(key, enabled ? "true" : "false", "BOOLEAN");
}

export async function setRepresentativeProgramEnabled(enabled: boolean): Promise<void> {
  await setBool(REPRESENTATIVE_PROGRAM_ENABLED_KEY, enabled);
}
export async function setRepresentativeApplicationsEnabled(enabled: boolean): Promise<void> {
  await setBool(REPRESENTATIVE_APPLICATIONS_ENABLED_KEY, enabled);
}
export async function setRepresentativeCheckoutEnabled(enabled: boolean): Promise<void> {
  await setBool(REPRESENTATIVE_CHECKOUT_ENABLED_KEY, enabled);
}

/** Stale-state-safe toggles: two concurrent OWNER taps never both "win". */
export function compareAndSetRepresentativeProgramEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(REPRESENTATIVE_PROGRAM_ENABLED_KEY, expected, next);
}
export function compareAndSetRepresentativeApplicationsEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(REPRESENTATIVE_APPLICATIONS_ENABLED_KEY, expected, next);
}
export function compareAndSetRepresentativeCheckoutEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(REPRESENTATIVE_CHECKOUT_ENABLED_KEY, expected, next);
}
