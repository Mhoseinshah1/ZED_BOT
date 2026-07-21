import {
  resolveDiagnosticsCooldownSeconds,
  resolveDiagnosticsReadTimeoutMs,
  resolveDiagnosticsRecentConnectionHours,
  SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT,
  SERVICE_DIAGNOSTICS_COOLDOWN_SECONDS_KEY,
  SERVICE_DIAGNOSTICS_ENABLED_KEY,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_HOURS_KEY,
} from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  deleteSetting,
  getBooleanSetting,
  getSetting,
  setSetting,
} from "./settings.service.js";

// =============================================================================
// Service self-diagnostics — global settings (feat/service-self-diagnostics).
//
// Same pattern as free-trial-settings.service: the KEY constants live in the
// shared typed contract (@zedbot/shared), and every read falls back safely (the
// master switch defaults FALSE, the numeric settings clamp to their bounds).
// The master switch is seeded FALSE for fresh + existing installs; the numeric
// settings are code-owned defaults, so tuning a default never needs a migration.
// =============================================================================

/** Global kill-switch — false until the OWNER explicitly enables diagnostics. */
export async function isServiceDiagnosticsEnabled(): Promise<boolean> {
  return getBooleanSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, false);
}

export async function setServiceDiagnosticsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

/**
 * Atomic flip used by the OWNER enable/disable confirmations: applies ONLY
 * while the stored value still equals `expected`, so a stale confirmation (or
 * two racing owners) can never double-apply a transition. Returns false when
 * the state already moved on.
 */
export async function compareAndSetServiceDiagnosticsEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, expected, next);
}

/** Per owner+Service cooldown between explicit diagnostic runs (seconds). */
export async function diagnosticsCooldownSeconds(): Promise<number> {
  const raw = await getSetting(SERVICE_DIAGNOSTICS_COOLDOWN_SECONDS_KEY, "");
  return resolveDiagnosticsCooldownSeconds(raw === "" ? null : raw);
}

export async function setDiagnosticsCooldownSeconds(value: number): Promise<void> {
  const clamped = resolveDiagnosticsCooldownSeconds(String(value));
  await setSetting(SERVICE_DIAGNOSTICS_COOLDOWN_SECONDS_KEY, String(clamped), "NUMBER");
}

/** How recent a `lastConnectedAt` counts as a "recent" connection (hours). */
export async function diagnosticsRecentConnectionHours(): Promise<number> {
  const raw = await getSetting(SERVICE_DIAGNOSTICS_RECENT_CONNECTION_HOURS_KEY, "");
  return resolveDiagnosticsRecentConnectionHours(raw === "" ? null : raw);
}

export async function setDiagnosticsRecentConnectionHours(value: number): Promise<void> {
  const clamped = resolveDiagnosticsRecentConnectionHours(String(value));
  await setSetting(
    SERVICE_DIAGNOSTICS_RECENT_CONNECTION_HOURS_KEY,
    String(clamped),
    "NUMBER",
  );
}

/** Bounded per-diagnosis panel-read budget (ms), env-overridable + clamped. */
export function diagnosticsReadTimeoutMs(): number {
  return resolveDiagnosticsReadTimeoutMs(process.env.SERVICE_DIAGNOSTICS_READ_TIMEOUT_MS);
}

/** Restores each numeric setting to its code default (deletes the row). */
export async function resetDiagnosticsCooldown(): Promise<void> {
  await deleteSetting(SERVICE_DIAGNOSTICS_COOLDOWN_SECONDS_KEY);
}

export async function resetDiagnosticsRecentConnectionHours(): Promise<void> {
  await deleteSetting(SERVICE_DIAGNOSTICS_RECENT_CONNECTION_HOURS_KEY);
}

/** Default constants re-exported for the OWNER settings page copy. */
export {
  SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
};
