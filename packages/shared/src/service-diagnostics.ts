// =============================================================================
// Service self-diagnostics (feat/service-self-diagnostics) — shared contract.
//
// Language-neutral, dependency-free contract for the user-facing «بررسی مشکل
// سرویس 🛠» capability: the master-switch + bounded setting keys, the typed
// diagnostic vocabulary (check keys / statuses / overall / evidence / actions),
// the STABLE machine codes, the deterministic overall-severity precedence, and
// the strict support-snapshot schema + validator.
//
// Design rules honoured here:
//   * Behaviour is driven by these machine codes/enums ONLY — never by comparing
//     Persian strings. Persian rendering lives in the bot view layer.
//   * This module imports NOTHING from @zedbot/database or the bot — it is pure
//     data + pure functions, so the worker/api/tests can consume it too.
//   * Setting KEYS live here (a shared typed contract), not as scattered string
//     literals across handlers.
// =============================================================================

import { clampInt } from "./auto-renewal.js";

// --- master switch + bounded settings ----------------------------------------

/** Master switch. Default FALSE — the whole capability is dormant until the
 * OWNER explicitly enables it. Disabling deletes no data and mutates nothing. */
export const SERVICE_DIAGNOSTICS_ENABLED_KEY = "service_diagnostics_enabled";

/** Per owner+Service cooldown between explicit diagnostic runs (seconds). */
export const SERVICE_DIAGNOSTICS_COOLDOWN_SECONDS_KEY =
  "service_diagnostics_cooldown_seconds";
export const SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT = 30;
export const SERVICE_DIAGNOSTICS_COOLDOWN_MIN = 5;
export const SERVICE_DIAGNOSTICS_COOLDOWN_MAX = 600;

/** How recent a `lastConnectedAt` counts as a "recent" connection (hours). */
export const SERVICE_DIAGNOSTICS_RECENT_CONNECTION_HOURS_KEY =
  "service_diagnostics_recent_connection_hours";
export const SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT = 72;
export const SERVICE_DIAGNOSTICS_RECENT_CONNECTION_MIN = 1;
export const SERVICE_DIAGNOSTICS_RECENT_CONNECTION_MAX = 720;

/** Bounded panel-read budget for one explicit diagnosis (milliseconds). A slow
 * panel must never hang the Telegram callback; on expiry the report is returned
 * with the freshest available (cache / stored) evidence and the underlying read
 * keeps running safely in the background (see docs). Env override is
 * SERVICE_DIAGNOSTICS_READ_TIMEOUT_MS. */
export const SERVICE_DIAGNOSTICS_READ_TIMEOUT_DEFAULT_MS = 8_000;
export const SERVICE_DIAGNOSTICS_READ_TIMEOUT_MIN_MS = 1_000;
export const SERVICE_DIAGNOSTICS_READ_TIMEOUT_MAX_MS = 30_000;

/** Clamp a raw (string|null) setting value to the cooldown bound. */
export function resolveDiagnosticsCooldownSeconds(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(
    n,
    SERVICE_DIAGNOSTICS_COOLDOWN_MIN,
    SERVICE_DIAGNOSTICS_COOLDOWN_MAX,
    SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT,
  );
}

/** Clamp a raw (string|null) setting value to the recent-connection bound. */
export function resolveDiagnosticsRecentConnectionHours(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(
    n,
    SERVICE_DIAGNOSTICS_RECENT_CONNECTION_MIN,
    SERVICE_DIAGNOSTICS_RECENT_CONNECTION_MAX,
    SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
  );
}

/** Clamp a raw (string|number|undefined) env value to the read-timeout bound. */
export function resolveDiagnosticsReadTimeoutMs(raw: string | undefined): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(
    n,
    SERVICE_DIAGNOSTICS_READ_TIMEOUT_MIN_MS,
    SERVICE_DIAGNOSTICS_READ_TIMEOUT_MAX_MS,
    SERVICE_DIAGNOSTICS_READ_TIMEOUT_DEFAULT_MS,
  );
}

// --- typed diagnostic contract -----------------------------------------------

/** The authoritative checks a diagnostic run evaluates (order = display order). */
export const SERVICE_DIAGNOSTIC_CHECK_KEYS = [
  "SERVICE_STATE",
  "PANEL_STATE",
  "PANEL_ACCOUNT",
  "QUOTA",
  "EXPIRY",
  "CONNECTION_PAYLOAD",
  "CONNECTION_HISTORY",
  "DATA_FRESHNESS",
] as const;
export type ServiceDiagnosticCheckKey = (typeof SERVICE_DIAGNOSTIC_CHECK_KEYS)[number];

export const SERVICE_DIAGNOSTIC_CHECK_STATUSES = [
  "PASS",
  "INFO",
  "WARNING",
  "FAIL",
  "UNKNOWN",
] as const;
export type ServiceDiagnosticCheckStatus =
  (typeof SERVICE_DIAGNOSTIC_CHECK_STATUSES)[number];

export const SERVICE_DIAGNOSTIC_OVERALLS = [
  "HEALTHY",
  "ACTION_REQUIRED",
  "DEGRADED",
  "UNAVAILABLE",
  "NEEDS_SUPPORT",
] as const;
export type ServiceDiagnosticOverall = (typeof SERVICE_DIAGNOSTIC_OVERALLS)[number];

export const DIAGNOSTIC_EVIDENCE_SOURCES = [
  "LIVE_PANEL",
  "FRESH_CACHE",
  "STORED_ONLY",
] as const;
export type DiagnosticEvidenceSource = (typeof DIAGNOSTIC_EVIDENCE_SOURCES)[number];

export const SERVICE_DIAGNOSTIC_ACTIONS = [
  "RETRY_DIAGNOSTIC",
  "REFRESH_SERVICE",
  "OPEN_CONNECTION_GUIDE",
  "SHOW_SUBSCRIPTION_LINK",
  "SHOW_SUBSCRIPTION_QR",
  "SHOW_CONFIGS",
  "SHOW_CONFIG_QRS",
  "ENABLE_SERVICE",
  "RENEW_SERVICE",
  "BUY_EXTRA_VOLUME",
  "REGENERATE_LINK",
  "OPEN_SUPPORT",
] as const;
export type ServiceDiagnosticAction = (typeof SERVICE_DIAGNOSTIC_ACTIONS)[number];

export interface ServiceDiagnosticCheck {
  key: ServiceDiagnosticCheckKey;
  status: ServiceDiagnosticCheckStatus;
  /** Stable, screaming-snake machine code (see DIAGNOSTIC_CODES). */
  code: string;
  /** Persian, already SAFE-plain-text line for this check (built in the bot). */
  userMessage: string;
}

export interface ServiceDiagnosticReport {
  overall: ServiceDiagnosticOverall;
  evidenceSource: DiagnosticEvidenceSource;
  checkedAt: Date;
  checks: ServiceDiagnosticCheck[];
  recommendedActions: ServiceDiagnosticAction[];
}

// --- stable machine codes ----------------------------------------------------
// Screaming-snake, [A-Z0-9_], immutable wire+log+snapshot contract. Persian
// rendering maps off these — the codes NEVER change once shipped.

export const DIAGNOSTIC_CODES = {
  // SERVICE_STATE
  SERVICE_STATE_ACTIVE: "SERVICE_STATE_ACTIVE",
  SERVICE_STATE_DISABLED: "SERVICE_STATE_DISABLED",
  SERVICE_STATE_EXPIRED: "SERVICE_STATE_EXPIRED",
  SERVICE_STATE_LIMITED: "SERVICE_STATE_LIMITED",
  SERVICE_STATE_CREATING: "SERVICE_STATE_CREATING",
  SERVICE_STATE_FAILED: "SERVICE_STATE_FAILED",
  // PANEL_STATE
  PANEL_OK: "PANEL_OK",
  PANEL_MISSING: "PANEL_MISSING",
  PANEL_INACTIVE: "PANEL_INACTIVE",
  PANEL_READ_UNSUPPORTED: "PANEL_READ_UNSUPPORTED",
  PANEL_UNREACHABLE: "PANEL_UNREACHABLE",
  PANEL_TIMEOUT: "PANEL_TIMEOUT",
  PANEL_AUTH_FAILED: "PANEL_AUTH_FAILED",
  PANEL_BUSY: "PANEL_BUSY",
  // PANEL_ACCOUNT
  ACCOUNT_PRESENT: "ACCOUNT_PRESENT",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  ACCOUNT_UNVERIFIED: "ACCOUNT_UNVERIFIED",
  // QUOTA
  QUOTA_UNLIMITED: "QUOTA_UNLIMITED",
  QUOTA_OK: "QUOTA_OK",
  QUOTA_LOW: "QUOTA_LOW",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  QUOTA_UNKNOWN: "QUOTA_UNKNOWN",
  // EXPIRY
  EXPIRY_NONE: "EXPIRY_NONE",
  EXPIRY_OK: "EXPIRY_OK",
  EXPIRY_NEAR: "EXPIRY_NEAR",
  EXPIRY_EXPIRED: "EXPIRY_EXPIRED",
  EXPIRY_UNKNOWN: "EXPIRY_UNKNOWN",
  // CONNECTION_PAYLOAD
  PAYLOAD_PRESENT: "PAYLOAD_PRESENT",
  PAYLOAD_MISSING: "PAYLOAD_MISSING",
  // CONNECTION_HISTORY
  HISTORY_RECENT: "HISTORY_RECENT",
  HISTORY_OLD: "HISTORY_OLD",
  HISTORY_NONE: "HISTORY_NONE",
  HISTORY_UNKNOWN: "HISTORY_UNKNOWN",
  // DATA_FRESHNESS
  FRESHNESS_LIVE: "FRESHNESS_LIVE",
  FRESHNESS_CACHE: "FRESHNESS_CACHE",
  FRESHNESS_STORED: "FRESHNESS_STORED",
} as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

/** Every known code, as a Set for O(1) snapshot validation. */
export const KNOWN_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set(
  Object.values(DIAGNOSTIC_CODES),
);

// --- the single source of truth: code → (check key + allowed statuses) --------
// EVERY diagnostic code belongs to exactly one check key and may only carry the
// statuses listed here — the SAME contract the deterministic evaluator emits.
// This is the ONE place validation, Persian rendering and version migrations
// look up a code's meaning: nothing derives a code's key/status from string
// prefixes at runtime. Immutable; a new code is added HERE (and to
// DIAGNOSTIC_CODES) or it does not exist.

export interface DiagnosticCodeSpec {
  /** The check key this code belongs to. */
  key: ServiceDiagnosticCheckKey;
  /** The statuses this code is allowed to carry (usually exactly one). */
  statuses: readonly ServiceDiagnosticCheckStatus[];
}

export const DIAGNOSTIC_CODE_CONTRACT: Readonly<Record<DiagnosticCode, DiagnosticCodeSpec>> = {
  // SERVICE_STATE
  SERVICE_STATE_ACTIVE: { key: "SERVICE_STATE", statuses: ["PASS"] },
  SERVICE_STATE_DISABLED: { key: "SERVICE_STATE", statuses: ["FAIL"] },
  SERVICE_STATE_EXPIRED: { key: "SERVICE_STATE", statuses: ["FAIL"] },
  SERVICE_STATE_LIMITED: { key: "SERVICE_STATE", statuses: ["WARNING"] },
  SERVICE_STATE_CREATING: { key: "SERVICE_STATE", statuses: ["WARNING"] },
  SERVICE_STATE_FAILED: { key: "SERVICE_STATE", statuses: ["FAIL"] },
  // PANEL_STATE
  PANEL_OK: { key: "PANEL_STATE", statuses: ["PASS"] },
  PANEL_MISSING: { key: "PANEL_STATE", statuses: ["FAIL"] },
  PANEL_INACTIVE: { key: "PANEL_STATE", statuses: ["FAIL"] },
  PANEL_READ_UNSUPPORTED: { key: "PANEL_STATE", statuses: ["INFO"] },
  PANEL_UNREACHABLE: { key: "PANEL_STATE", statuses: ["FAIL"] },
  PANEL_TIMEOUT: { key: "PANEL_STATE", statuses: ["FAIL"] },
  PANEL_AUTH_FAILED: { key: "PANEL_STATE", statuses: ["FAIL"] },
  PANEL_BUSY: { key: "PANEL_STATE", statuses: ["WARNING"] },
  // PANEL_ACCOUNT
  ACCOUNT_PRESENT: { key: "PANEL_ACCOUNT", statuses: ["PASS"] },
  ACCOUNT_NOT_FOUND: { key: "PANEL_ACCOUNT", statuses: ["FAIL"] },
  ACCOUNT_UNVERIFIED: { key: "PANEL_ACCOUNT", statuses: ["UNKNOWN"] },
  // QUOTA
  QUOTA_UNLIMITED: { key: "QUOTA", statuses: ["INFO"] },
  QUOTA_OK: { key: "QUOTA", statuses: ["PASS"] },
  QUOTA_LOW: { key: "QUOTA", statuses: ["WARNING"] },
  QUOTA_EXHAUSTED: { key: "QUOTA", statuses: ["FAIL"] },
  QUOTA_UNKNOWN: { key: "QUOTA", statuses: ["UNKNOWN"] },
  // EXPIRY
  EXPIRY_NONE: { key: "EXPIRY", statuses: ["INFO"] },
  EXPIRY_OK: { key: "EXPIRY", statuses: ["PASS"] },
  EXPIRY_NEAR: { key: "EXPIRY", statuses: ["WARNING"] },
  EXPIRY_EXPIRED: { key: "EXPIRY", statuses: ["FAIL"] },
  EXPIRY_UNKNOWN: { key: "EXPIRY", statuses: ["UNKNOWN"] },
  // CONNECTION_PAYLOAD
  PAYLOAD_PRESENT: { key: "CONNECTION_PAYLOAD", statuses: ["PASS"] },
  PAYLOAD_MISSING: { key: "CONNECTION_PAYLOAD", statuses: ["FAIL"] },
  // CONNECTION_HISTORY
  HISTORY_RECENT: { key: "CONNECTION_HISTORY", statuses: ["PASS"] },
  HISTORY_OLD: { key: "CONNECTION_HISTORY", statuses: ["WARNING"] },
  HISTORY_NONE: { key: "CONNECTION_HISTORY", statuses: ["INFO"] },
  HISTORY_UNKNOWN: { key: "CONNECTION_HISTORY", statuses: ["UNKNOWN"] },
  // DATA_FRESHNESS
  FRESHNESS_LIVE: { key: "DATA_FRESHNESS", statuses: ["INFO"] },
  FRESHNESS_CACHE: { key: "DATA_FRESHNESS", statuses: ["INFO"] },
  FRESHNESS_STORED: { key: "DATA_FRESHNESS", statuses: ["WARNING"] },
};

/** Looks up a code's contract, or null for an unknown code. The ONLY sanctioned
 * way to learn a code's check key + allowed statuses (used by the validator and
 * available to the Persian renderer / migrations). */
export function diagnosticCodeSpec(code: string): DiagnosticCodeSpec | null {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODE_CONTRACT, code)
    ? DIAGNOSTIC_CODE_CONTRACT[code as DiagnosticCode]
    : null;
}

// --- overall-severity precedence ---------------------------------------------
// Deterministic ordering (most severe wins). Precedence (§10):
//   NEEDS_SUPPORT > UNAVAILABLE > ACTION_REQUIRED > DEGRADED > HEALTHY.
// A later PASS can never overwrite a more serious condition.

export const OVERALL_SEVERITY: Record<ServiceDiagnosticOverall, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  ACTION_REQUIRED: 2,
  UNAVAILABLE: 3,
  NEEDS_SUPPORT: 4,
};

/** Returns the more-severe of two overalls. */
export function worstOverall(
  a: ServiceDiagnosticOverall,
  b: ServiceDiagnosticOverall,
): ServiceDiagnosticOverall {
  return OVERALL_SEVERITY[a] >= OVERALL_SEVERITY[b] ? a : b;
}

/** Folds a list of overall candidates to the most severe (HEALTHY when empty). */
export function worstOverallOf(
  candidates: readonly ServiceDiagnosticOverall[],
): ServiceDiagnosticOverall {
  return candidates.reduce<ServiceDiagnosticOverall>(
    (acc, next) => worstOverall(acc, next),
    "HEALTHY",
  );
}

// --- support snapshot schema (strict) ----------------------------------------
// The ONLY diagnostic data that is ever persisted, and only after EXPLICIT
// support handoff. It carries stable codes/statuses/overall/evidence/checkedAt
// and the selected primary recommendation — NEVER a subscription URL, config,
// token, remote client id, panel credential, raw panel message or free-form
// text. `version` lets the reader evolve the shape safely.

export const DIAGNOSTIC_SNAPSHOT_VERSION = 1;
/** Hard cap on persisted checks (== number of check keys). */
export const DIAGNOSTIC_SNAPSHOT_MAX_CHECKS = SERVICE_DIAGNOSTIC_CHECK_KEYS.length;

/**
 * The EXACT set of check keys a snapshot of a given version must carry — every
 * key present exactly once, no extras, no omissions. A real report always emits
 * all authoritative checks, so version 1 requires the full canonical set. A
 * future schema change bumps DIAGNOSTIC_SNAPSHOT_VERSION and adds its required
 * set here; the validator reads the set for the snapshot's declared version, so
 * old-version snapshots keep validating against their own contract (migrations).
 */
export const DIAGNOSTIC_SNAPSHOT_REQUIRED_KEYS: Readonly<
  Record<number, readonly ServiceDiagnosticCheckKey[]>
> = {
  [DIAGNOSTIC_SNAPSHOT_VERSION]: SERVICE_DIAGNOSTIC_CHECK_KEYS,
};

export interface DiagnosticSnapshotCheck {
  key: ServiceDiagnosticCheckKey;
  status: ServiceDiagnosticCheckStatus;
  code: string;
}

export interface DiagnosticSnapshot {
  version: number;
  overall: ServiceDiagnosticOverall;
  evidenceSource: DiagnosticEvidenceSource;
  /** ISO-8601 timestamp string (UTC). */
  checkedAt: string;
  checks: DiagnosticSnapshotCheck[];
  /** The selected primary recommendation, when one applies. */
  primaryRecommendation?: ServiceDiagnosticAction;
}

const CHECK_KEY_SET: ReadonlySet<string> = new Set(SERVICE_DIAGNOSTIC_CHECK_KEYS);
const CHECK_STATUS_SET: ReadonlySet<string> = new Set(SERVICE_DIAGNOSTIC_CHECK_STATUSES);
const OVERALL_SET: ReadonlySet<string> = new Set(SERVICE_DIAGNOSTIC_OVERALLS);
const EVIDENCE_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_EVIDENCE_SOURCES);
const ACTION_SET: ReadonlySet<string> = new Set(SERVICE_DIAGNOSTIC_ACTIONS);
/** Code shape a persisted snapshot may carry (bounded, no free-form content). */
const SNAPSHOT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,47}$/;

/** Builds a strict, bounded snapshot from a finished report + a chosen primary
 * action. Only the safe fields are copied; nothing free-form is preserved. */
export function buildDiagnosticSnapshot(
  report: ServiceDiagnosticReport,
  primaryRecommendation?: ServiceDiagnosticAction,
): DiagnosticSnapshot {
  return {
    version: DIAGNOSTIC_SNAPSHOT_VERSION,
    overall: report.overall,
    evidenceSource: report.evidenceSource,
    checkedAt: report.checkedAt.toISOString(),
    checks: report.checks
      .slice(0, DIAGNOSTIC_SNAPSHOT_MAX_CHECKS)
      .map((c) => ({ key: c.key, status: c.status, code: c.code })),
    ...(primaryRecommendation !== undefined ? { primaryRecommendation } : {}),
  };
}

/**
 * Strictly CROSS-validates an arbitrary JSON value as a DiagnosticSnapshot and
 * returns a canonically-ordered copy, or null on ANY deviation. Fails closed on:
 *   - a version with no known required-key set;
 *   - an unknown overall / evidenceSource / primaryRecommendation;
 *   - an unparseable checkedAt;
 *   - a check whose code is not a KNOWN code, whose code does not belong to its
 *     stated key, or whose status is not allowed for that code (per the single
 *     DIAGNOSTIC_CODE_CONTRACT — never a runtime string-prefix guess);
 *   - a duplicate key, a duplicate code, an extra check, or a missing required
 *     check (the snapshot must carry EXACTLY the version's required key set).
 * Unknown top-level / per-check fields are tolerated but dropped. On success the
 * returned checks are re-ordered into canonical SERVICE_DIAGNOSTIC_CHECK_KEYS
 * order. Never throws.
 */
export function validateDiagnosticSnapshot(raw: unknown): DiagnosticSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    return null;
  }
  const requiredKeys = DIAGNOSTIC_SNAPSHOT_REQUIRED_KEYS[obj.version];
  if (requiredKeys === undefined) {
    return null;
  }
  const requiredKeySet: ReadonlySet<string> = new Set(requiredKeys);
  if (typeof obj.overall !== "string" || !OVERALL_SET.has(obj.overall)) {
    return null;
  }
  if (typeof obj.evidenceSource !== "string" || !EVIDENCE_SET.has(obj.evidenceSource)) {
    return null;
  }
  if (typeof obj.checkedAt !== "string") {
    return null;
  }
  const parsedAt = Date.parse(obj.checkedAt);
  if (Number.isNaN(parsedAt)) {
    return null;
  }
  // Exactly the required number of checks — no extras, no omissions.
  if (!Array.isArray(obj.checks) || obj.checks.length !== requiredKeys.length) {
    return null;
  }
  const byKey = new Map<ServiceDiagnosticCheckKey, DiagnosticSnapshotCheck>();
  const seenCodes = new Set<string>();
  for (const entry of obj.checks) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.key !== "string" || !CHECK_KEY_SET.has(c.key)) {
      return null;
    }
    if (typeof c.status !== "string" || !CHECK_STATUS_SET.has(c.status)) {
      return null;
    }
    // Bounded code shape (defence in depth) AND a KNOWN code whose contract
    // matches the stated key + status — no string-prefix inference.
    if (typeof c.code !== "string" || !SNAPSHOT_CODE_PATTERN.test(c.code)) {
      return null;
    }
    const spec = diagnosticCodeSpec(c.code);
    if (spec === null) {
      return null; // unknown code
    }
    const key = c.key as ServiceDiagnosticCheckKey;
    const status = c.status as ServiceDiagnosticCheckStatus;
    if (spec.key !== key) {
      return null; // code does not belong to this check key
    }
    if (!spec.statuses.includes(status)) {
      return null; // status not allowed for this code
    }
    if (!requiredKeySet.has(key)) {
      return null; // a check key not required by this version
    }
    if (byKey.has(key)) {
      return null; // duplicate key
    }
    if (seenCodes.has(c.code)) {
      return null; // duplicate code
    }
    seenCodes.add(c.code);
    byKey.set(key, { key, status, code: c.code });
  }
  // Every required key must be present exactly once.
  if (byKey.size !== requiredKeys.length) {
    return null;
  }
  let primaryRecommendation: ServiceDiagnosticAction | undefined;
  if (obj.primaryRecommendation !== undefined) {
    if (
      typeof obj.primaryRecommendation !== "string" ||
      !ACTION_SET.has(obj.primaryRecommendation)
    ) {
      return null;
    }
    primaryRecommendation = obj.primaryRecommendation as ServiceDiagnosticAction;
  }
  // Normalize to canonical display order (independent of input ordering).
  const checks: DiagnosticSnapshotCheck[] = [];
  for (const key of SERVICE_DIAGNOSTIC_CHECK_KEYS) {
    const check = byKey.get(key);
    if (check !== undefined) {
      checks.push(check);
    }
  }
  return {
    version: obj.version,
    overall: obj.overall as ServiceDiagnosticOverall,
    evidenceSource: obj.evidenceSource as DiagnosticEvidenceSource,
    checkedAt: new Date(parsedAt).toISOString(),
    checks,
    ...(primaryRecommendation !== undefined ? { primaryRecommendation } : {}),
  };
}
