import { ADMIN_SERVICE_MUTATIONS_ENABLED_KEY } from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  getBooleanSetting,
  getBooleanSettingFresh,
  setSetting,
} from "./settings.service.js";

// =============================================================================
// Admin Service Operations — mutation rollout switch (feat/admin-service-
// operations). Same pattern as service-diagnostics-settings / support-attachment-
// settings: the KEY lives in @zedbot/shared; the master switch defaults FALSE so
// lifecycle mutations are dormant (read-only detail + read-only refresh stay
// available) until the OWNER enables them. Toggling deletes no operation history
// and mutates no Service or Panel.
// =============================================================================

/** Master switch — admin lifecycle mutations are OFF until the OWNER turns them
 * on. Read-only detail and read-only refresh do NOT depend on this flag. */
export async function areAdminServiceMutationsEnabled(): Promise<boolean> {
  return getBooleanSetting(ADMIN_SERVICE_MUTATIONS_ENABLED_KEY, false);
}

/** UNCACHED read of the master switch — for the executor's just-in-time recheck
 * so an OWNER emergency-disable takes effect across all workers immediately
 * (the cached read can lag by the 30s TTL on other instances). */
export async function areAdminServiceMutationsEnabledFresh(): Promise<boolean> {
  return getBooleanSettingFresh(ADMIN_SERVICE_MUTATIONS_ENABLED_KEY, false);
}

export async function setAdminServiceMutationsEnabled(enabled: boolean): Promise<void> {
  await setSetting(ADMIN_SERVICE_MUTATIONS_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

/** Stale-state-safe toggle: only flips when the stored value still matches
 * `expected`, so two concurrent OWNER taps never both "win". */
export async function compareAndSetAdminServiceMutationsEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(ADMIN_SERVICE_MUTATIONS_ENABLED_KEY, expected, next);
}
