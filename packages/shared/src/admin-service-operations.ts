// =============================================================================
// Admin Service Operations (feat/admin-service-operations) — shared contract.
// Language-neutral, dependency-free typed vocabulary for the per-Service admin
// console: operation types + statuses, the explicit actor contract, the safe
// state-snapshot shape, complimentary volume/time math (checked BigInt, binary
// GiB), bounded validation, the rollout setting key, and the safe error-code /
// logging-bucket vocabulary.
//
// Design rules (same as service-diagnostics.ts / support-tickets-v2.ts):
//   * Behaviour is driven by these machine CODES ONLY — never by comparing
//     Persian strings. Persian rendering lives in the bot view layer.
//   * This module imports NOTHING from @zedbot/database or the bot — pure data +
//     pure functions, so the api/worker/tests can consume it too.
//   * Snapshots + logs here NEVER carry a secret (subscription URL, config link,
//     Panel URL/credentials, token, remote client id, raw response/error).
// =============================================================================

import { clampInt } from "./auto-renewal.js";

// --- operation types ---------------------------------------------------------

/** The stable admin Service operation types. ADD_NOTE is an internal note (no
 * Panel call, no mutation master switch); the rest are lifecycle mutations. */
export const ADMIN_SERVICE_OPERATION_TYPES = [
  "ENABLE",
  "DISABLE",
  "ADD_VOLUME",
  "ADD_TIME",
  "REGENERATE_LINK",
  "ADD_NOTE",
] as const;
export type AdminServiceOperationType = (typeof ADMIN_SERVICE_OPERATION_TYPES)[number];

const OP_TYPE_SET: ReadonlySet<string> = new Set(ADMIN_SERVICE_OPERATION_TYPES);
export function isAdminServiceOperationType(value: unknown): value is AdminServiceOperationType {
  return typeof value === "string" && OP_TYPE_SET.has(value);
}

/** A lifecycle mutation performs at most one remote Panel call and is gated by
 * the mutation master switch + OWNER role + the per-Service lock. ADD_NOTE is
 * neither — any authorized admin may add a note with no Panel call. */
export function adminServiceOperationIsMutation(type: AdminServiceOperationType): boolean {
  return type !== "ADD_NOTE";
}

/** The PanelAdapter capability a mutation requires (null for ADD_NOTE). Kept as
 * a stable string so the bot maps it to its capability gate without importing
 * panel-adapters here. */
export function adminServiceOperationCapability(type: AdminServiceOperationType): string | null {
  switch (type) {
    case "ENABLE":
    case "DISABLE":
      return "toggleService";
    case "ADD_VOLUME":
      return "addVolume";
    case "ADD_TIME":
      return "addTime";
    case "REGENERATE_LINK":
      return "regenerateSubscription";
    case "ADD_NOTE":
      return null;
  }
}

// --- statuses + state machine ------------------------------------------------

export const ADMIN_SERVICE_OPERATION_STATUSES = [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
  "RECONCILIATION_REQUIRED",
  "RECONCILED",
  "CANCELLED",
] as const;
export type AdminServiceOperationStatus = (typeof ADMIN_SERVICE_OPERATION_STATUSES)[number];

const OP_STATUS_SET: ReadonlySet<string> = new Set(ADMIN_SERVICE_OPERATION_STATUSES);
export function isAdminServiceOperationStatus(value: unknown): value is AdminServiceOperationStatus {
  return typeof value === "string" && OP_STATUS_SET.has(value);
}

/** Terminal states — no further transition is allowed. */
export const ADMIN_SERVICE_TERMINAL_STATUSES: readonly AdminServiceOperationStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "RECONCILED",
  "CANCELLED",
];

/** Statuses that BLOCK a new conflicting mutation on the same Service: an
 * in-flight PENDING, or an unresolved UNCERTAIN / RECONCILIATION_REQUIRED whose
 * true remote effect is not yet known. */
export const ADMIN_SERVICE_BLOCKING_STATUSES: readonly AdminServiceOperationStatus[] = [
  "PENDING",
  "UNCERTAIN",
  "RECONCILIATION_REQUIRED",
];

/** Statuses surfaced on the OWNER reconciliation dashboard. */
export const ADMIN_SERVICE_RECONCILE_STATUSES: readonly AdminServiceOperationStatus[] = [
  "UNCERTAIN",
  "RECONCILIATION_REQUIRED",
];

export function isAdminServiceOperationTerminal(status: AdminServiceOperationStatus): boolean {
  return ADMIN_SERVICE_TERMINAL_STATUSES.includes(status);
}
export function isAdminServiceOperationBlocking(status: string): boolean {
  return (ADMIN_SERVICE_BLOCKING_STATUSES as readonly string[]).includes(status);
}

const ALLOWED_TRANSITIONS: Readonly<Record<AdminServiceOperationStatus, readonly AdminServiceOperationStatus[]>> = {
  PENDING: ["SUCCEEDED", "FAILED", "UNCERTAIN", "RECONCILIATION_REQUIRED", "CANCELLED"],
  UNCERTAIN: ["RECONCILIATION_REQUIRED", "RECONCILED", "FAILED"],
  RECONCILIATION_REQUIRED: ["RECONCILED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  RECONCILED: [],
  CANCELLED: [],
};

/** Whether a status transition is valid (audit-safe state machine). */
export function canTransitionAdminServiceOperation(
  from: AdminServiceOperationStatus,
  to: AdminServiceOperationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// --- actor contract ----------------------------------------------------------

/** WHO performed a lifecycle action. USER keeps the existing user-facing event
 * types + messages; ADMIN records the admin, the durable operation id and an
 * admin-specific event type so an admin action is never audited as the customer. */
export type ServiceOperationActor =
  | { kind: "USER"; userId: string }
  | { kind: "ADMIN"; adminId: string; operationId: string };

// --- safe state snapshot -----------------------------------------------------

/**
 * The ONLY Service fields captured in an operation before/after snapshot. Every
 * value is a plain string (BigInt/Date already serialised) so the snapshot is
 * JSON-safe and fingerprintable. NEVER add subscriptionUrl / configLinks /
 * username / remote client id / Panel URL / Panel credentials / token / raw
 * Panel response / raw error to this shape.
 */
export interface AdminServiceStateSnapshot {
  status: string;
  panelStatus: string;
  panelType: string;
  volumeBytes: string | null;
  usedBytes: string | null;
  remainingBytes: string | null;
  expiresAt: string | null;
  lastSubscriptionUpdateAt: string | null;
}

/** The stable, canonical fingerprint input for a snapshot — a stale preview can
 * never mutate newer state because the confirmation compares this fingerprint.
 * Deterministic field order; the bot hashes the result.
 *
 * DELIBERATELY only the DECISION-relevant structural fields are fingerprinted:
 * status, panelStatus, panelType, volumeBytes (total quota) and expiresAt. The
 * VOLATILE usage counters (usedBytes / remainingBytes) and the sync timestamp
 * (lastSubscriptionUpdateAt) are EXCLUDED — they change on every background
 * refresh and as the customer consumes traffic, and the appliers always take a
 * fresh Panel read before an absolute-set anyway, so folding them in would only
 * produce false "stale preview" rejections without adding any safety. A change
 * to the total quota, the status or the expiry (the things an admin's decision
 * actually hinges on) still invalidates the preview. */
export function adminServiceSnapshotFingerprintInput(snapshot: AdminServiceStateSnapshot): string {
  return [
    snapshot.status,
    snapshot.panelStatus,
    snapshot.panelType,
    snapshot.volumeBytes ?? "∅",
    snapshot.expiresAt ?? "∅",
  ].join("|");
}

// --- rollout setting ---------------------------------------------------------

/** Master switch for lifecycle mutations. Default FALSE — read-only Service
 * detail + read-only refresh stay available; every mutation button is hidden and
 * every stale/direct mutation callback fails closed until the OWNER enables it. */
export const ADMIN_SERVICE_MUTATIONS_ENABLED_KEY = "admin_service_mutations_enabled";

// --- complimentary volume (binary GiB) ---------------------------------------

/** 1 GiB = 1024^3 bytes (binary), used consistently — never floating point. */
export const ADMIN_SERVICE_GIB_BYTES = 1024n * 1024n * 1024n;

export const ADMIN_SERVICE_VOLUME_MIN_GIB = 1;
export const ADMIN_SERVICE_VOLUME_MAX_GIB = 10_000;
export const ADMIN_SERVICE_VOLUME_PRESETS_GIB: readonly number[] = [1, 5, 10, 20, 50];

/** Parse an integer GiB amount from raw admin text, bounded to [1, 10000].
 * Returns null for non-integer / out-of-range input (never clamps silently). */
export function parseAdminVolumeGib(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < ADMIN_SERVICE_VOLUME_MIN_GIB || n > ADMIN_SERVICE_VOLUME_MAX_GIB) {
    return null;
  }
  return n;
}

/** Checked GiB→bytes conversion (BigInt). Throws on a non-positive / out-of-range
 * amount so an overflow can never silently produce a wrong quota. */
export function adminVolumeGibToBytes(gib: number): bigint {
  if (!Number.isInteger(gib) || gib < ADMIN_SERVICE_VOLUME_MIN_GIB || gib > ADMIN_SERVICE_VOLUME_MAX_GIB) {
    throw new RangeError(`admin volume GiB out of range: ${gib}`);
  }
  return BigInt(gib) * ADMIN_SERVICE_GIB_BYTES;
}

/** Guard against absurd absolute totals coming back from a Panel absolute-set.
 * A finite total above this ceiling (~1 EiB) is treated as inconsistent. */
export const ADMIN_SERVICE_MAX_TOTAL_BYTES = 1024n * 1024n * 1024n * 1024n * 1024n * 1024n; // 2^60

// --- complimentary time ------------------------------------------------------

export const ADMIN_SERVICE_TIME_MIN_DAYS = 1;
export const ADMIN_SERVICE_TIME_MAX_DAYS = 3650;
export const ADMIN_SERVICE_TIME_PRESETS_DAYS: readonly number[] = [1, 3, 7, 15, 30];

/** Parse an integer day amount from raw admin text, bounded to [1, 3650]. */
export function parseAdminTimeDays(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < ADMIN_SERVICE_TIME_MIN_DAYS || n > ADMIN_SERVICE_TIME_MAX_DAYS) {
    return null;
  }
  return n;
}

// --- reason + note bounds ----------------------------------------------------

/** Mandatory internal reason for every lifecycle mutation (bounded plain text). */
export const ADMIN_SERVICE_REASON_MIN = 3;
export const ADMIN_SERVICE_REASON_MAX = 500;
/** Internal note bounds (§17). Shares the operation `reason` column. */
export const ADMIN_SERVICE_NOTE_MIN = 1;
export const ADMIN_SERVICE_NOTE_MAX = 1000;

export function isValidAdminServiceReason(reason: string): boolean {
  const n = reason.trim().length;
  return n >= ADMIN_SERVICE_REASON_MIN && n <= ADMIN_SERVICE_REASON_MAX;
}
export function isValidAdminServiceNote(note: string): boolean {
  const n = note.trim().length;
  return n >= ADMIN_SERVICE_NOTE_MIN && n <= ADMIN_SERVICE_NOTE_MAX;
}

// --- requested unit ----------------------------------------------------------

export const ADMIN_SERVICE_REQUESTED_UNITS = ["GIB", "DAY"] as const;
export type AdminServiceRequestedUnit = (typeof ADMIN_SERVICE_REQUESTED_UNITS)[number];

// --- safe error-code vocabulary ----------------------------------------------

/** Typed, safe machine error codes an operation can record / display. None ever
 * echoes a raw Panel response or thrown error. */
export const ADMIN_SERVICE_ERROR_CODES = [
  "MUTATIONS_DISABLED",
  "NOT_OWNER",
  "SERVICE_NOT_FOUND",
  "STALE_PREVIEW",
  "LOCK_BUSY",
  "LOCK_UNAVAILABLE",
  "CAPABILITY_UNSUPPORTED",
  "PANEL_INACTIVE",
  "XUI_LEGACY_UNSUPPORTED",
  "INELIGIBLE_STATUS",
  "UNKNOWN_QUOTA",
  "UNLIMITED_BLOCKED",
  "UNKNOWN_EXPIRY",
  "NEVER_EXPIRING_BLOCKED",
  "VALUE_OUT_OF_RANGE",
  "OVERFLOW",
  "INCONSISTENT_REMOTE_STATE",
  "PANEL_REJECTED",
  "PANEL_UNCERTAIN",
  "CONFLICTING_OPERATION",
  "VALIDATION",
] as const;
export type AdminServiceErrorCode = (typeof ADMIN_SERVICE_ERROR_CODES)[number];

// --- privacy-safe logging buckets --------------------------------------------

/** A coarse, non-reversible bucket for a requested value (never the exact
 * amount, which could correlate a specific grant). */
export function adminServiceRequestedValueBucket(
  unit: AdminServiceRequestedUnit | null,
  value: bigint | number | null,
): string {
  if (unit === null || value === null) {
    return "none";
  }
  const n = typeof value === "bigint" ? Number(value) : value;
  if (unit === "GIB") {
    if (n <= 1) return "gib:1";
    if (n <= 5) return "gib:2-5";
    if (n <= 20) return "gib:6-20";
    if (n <= 100) return "gib:21-100";
    if (n <= 1000) return "gib:101-1000";
    return "gib:1000+";
  }
  // DAY
  if (n <= 1) return "day:1";
  if (n <= 7) return "day:2-7";
  if (n <= 30) return "day:8-30";
  if (n <= 90) return "day:31-90";
  if (n <= 365) return "day:91-365";
  return "day:365+";
}

/** Numeric config read from a Setting string, clamped to safe bounds (uses the
 * shared clampInt so out-of-range / unparseable falls back to the default). */
export function resolveAdminServiceConfigInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(n, min, max, fallback);
}

// --- short ids ---------------------------------------------------------------

/** The 8-char short id used in callback data for a Service / operation (kept
 * well under Telegram's 64-byte callback limit). */
export function adminServiceShortId(id: string): string {
  return id.slice(0, 8);
}
