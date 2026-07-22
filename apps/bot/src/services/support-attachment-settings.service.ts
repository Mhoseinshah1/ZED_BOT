import {
  resolveSupportAttachmentMaxBytes,
  SUPPORT_ATTACHMENT_MAX_BYTES_KEY,
  SUPPORT_ATTACHMENTS_ENABLED_KEY,
} from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  deleteSetting,
  getBooleanSetting,
  getSetting,
  setSetting,
} from "./settings.service.js";

// =============================================================================
// Support Tickets V2 — attachment rollout settings (feat/support-ticket-
// attachments-service-context). Same pattern as service-diagnostics-settings:
// the KEYS + bounds live in @zedbot/shared; the master switch defaults FALSE
// (support stays text-only until the OWNER enables it); the numeric ceiling is
// code-defaulted + clamped so tuning it never needs a data migration. Disabling
// deletes no attachment metadata — it only stops NEW attachment input.
// =============================================================================

/** Master switch — attachments are OFF until the OWNER turns them on. */
export async function isSupportAttachmentsEnabled(): Promise<boolean> {
  return getBooleanSetting(SUPPORT_ATTACHMENTS_ENABLED_KEY, false);
}

export async function setSupportAttachmentsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SUPPORT_ATTACHMENTS_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
}

/** Stale-state-safe toggle: only flips when the stored value still matches
 * `expected`, so two concurrent OWNER taps never both "win". */
export async function compareAndSetSupportAttachmentsEnabled(
  expected: boolean,
  next: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(SUPPORT_ATTACHMENTS_ENABLED_KEY, expected, next);
}

/** The configured per-attachment byte ceiling, clamped to the shared bounds. */
export async function supportAttachmentMaxBytes(): Promise<number> {
  const raw = await getSetting(SUPPORT_ATTACHMENT_MAX_BYTES_KEY, "");
  return resolveSupportAttachmentMaxBytes(raw === "" ? null : raw);
}

export async function setSupportAttachmentMaxBytes(value: number): Promise<void> {
  const clamped = resolveSupportAttachmentMaxBytes(String(value));
  await setSetting(SUPPORT_ATTACHMENT_MAX_BYTES_KEY, String(clamped), "NUMBER");
}

/** Reset the ceiling to the code default (removes the stored override). */
export async function resetSupportAttachmentMaxBytes(): Promise<void> {
  await deleteSetting(SUPPORT_ATTACHMENT_MAX_BYTES_KEY);
}
