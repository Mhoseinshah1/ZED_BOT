import { createHash } from "node:crypto";

import { PanelStatus, prisma, ServiceStatus, type Panel, type Service } from "@zedbot/database";
import {
  buildDiagnosticSnapshot,
  DIAGNOSTIC_CODES,
  type DiagnosticEvidenceSource,
  type DiagnosticSnapshot,
  type ServiceDiagnosticAction,
  type ServiceDiagnosticCheck,
  type ServiceDiagnosticCheckStatus,
  type ServiceDiagnosticOverall,
  type ServiceDiagnosticReport,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
  worstOverall,
} from "@zedbot/shared";

import { isConnectionGuideEntryVisible } from "./connection-guide.service.js";
import { panelOperationAvailable } from "./panel-readiness.service.js";
import {
  checkAndArmCooldown,
  serviceDiagnosticsCooldownKey,
} from "./service-lock.service.js";
import {
  diagnosticsCooldownSeconds,
  diagnosticsReadTimeoutMs,
  diagnosticsRecentConnectionHours,
} from "./service-diagnostics-settings.service.js";
import {
  type PanelReadOutcome,
  readServiceForDiagnostics,
  serviceSyncTtlMs,
} from "./service-sync.service.js";
import { writeSystemLog } from "./system-log.service.js";
import {
  resolveServiceDetailActions,
  type ServiceDetailActions,
} from "./user-services.service.js";

// =============================================================================
// Service self-diagnostics (feat/service-self-diagnostics) — core service.
//
// Diagnoses ONLY what the bot can authoritatively know (the Service row, its
// Panel, ONE bounded authenticated panel account read, quota/expiry/status,
// payload availability, connection timestamps, current lifecycle actions) and
// maps that to stable machine codes + a deterministic overall severity. It
// NEVER pretends to inspect the customer's phone, ISP, DNS, app config or
// packet reachability, and it NEVER mutates a Service, Order, wallet or panel.
//
// One authenticated panel account read per run: the shared read-and-sync
// primitive (service-sync.readServiceForDiagnostics) is the ONLY panel call,
// gated by the per-service lock. Failure never overwrites the Service row.
// =============================================================================

/** Aggregate, privacy-safe SystemLog event types (§19). No ids in metadata. */
export const DIAGNOSTIC_EVENTS = {
  COMPLETED: "diagnostics.completed",
  COOLDOWN_HIT: "diagnostics.cooldown_hit",
  LIVE_READ_UNAVAILABLE: "diagnostics.live_read_unavailable",
  SUPPORT_HANDOFF: "diagnostics.support_handoff_started",
  SNAPSHOT_ATTACHED: "diagnostics.snapshot_attached",
} as const;

/** Explicit near-expiry advisory threshold (days). Informational only. */
export const DIAGNOSTIC_NEAR_EXPIRY_DAYS = 3;
/** Low-quota advisory threshold (fraction of total). Only when total is known. */
export const DIAGNOSTIC_LOW_QUOTA_FRACTION = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;

// --- deterministic pure rule engine ------------------------------------------

/** Light check result the pure evaluator emits (Persian is attached later). */
export interface DiagnosticCheckResult {
  key: ServiceDiagnosticCheck["key"];
  status: ServiceDiagnosticCheckStatus;
  code: string;
  /** The overall-severity this check contributes (folded via worstOverall). */
  contributes: ServiceDiagnosticOverall;
}

export interface DiagnosticEvidence {
  /** Freshest Service row (post read-ok update, or the stored row otherwise). */
  service: Service;
  /** The Panel row, or null when the panel record is missing. */
  panel: Panel | null;
  /** The one panel read outcome, or null when no read was attempted. */
  read: PanelReadOutcome | null;
  evidenceSource: DiagnosticEvidenceSource;
  /** True when the adapter supports readService (live verification possible). */
  readSupported: boolean;
  recentConnectionHours: number;
  now: Date;
}

const c = DIAGNOSTIC_CODES;

/** SERVICE_STATE (§9). */
function evaluateServiceState(status: ServiceStatus): DiagnosticCheckResult {
  switch (status) {
    case ServiceStatus.ACTIVE:
      return { key: "SERVICE_STATE", status: "PASS", code: c.SERVICE_STATE_ACTIVE, contributes: "HEALTHY" };
    case ServiceStatus.DISABLED:
      return { key: "SERVICE_STATE", status: "FAIL", code: c.SERVICE_STATE_DISABLED, contributes: "ACTION_REQUIRED" };
    case ServiceStatus.EXPIRED:
      return { key: "SERVICE_STATE", status: "FAIL", code: c.SERVICE_STATE_EXPIRED, contributes: "ACTION_REQUIRED" };
    case ServiceStatus.LIMITED:
      return { key: "SERVICE_STATE", status: "WARNING", code: c.SERVICE_STATE_LIMITED, contributes: "ACTION_REQUIRED" };
    case ServiceStatus.CREATING:
      return { key: "SERVICE_STATE", status: "WARNING", code: c.SERVICE_STATE_CREATING, contributes: "DEGRADED" };
    default:
      // FAILED / DELETED (DELETED should be hidden by the owner lookup).
      return { key: "SERVICE_STATE", status: "FAIL", code: c.SERVICE_STATE_FAILED, contributes: "NEEDS_SUPPORT" };
  }
}

/** PANEL_STATE (§9). Whether the panel itself could be reached/authenticated. */
function evaluatePanelState(ev: DiagnosticEvidence): DiagnosticCheckResult {
  if (ev.panel === null) {
    return { key: "PANEL_STATE", status: "FAIL", code: c.PANEL_MISSING, contributes: "NEEDS_SUPPORT" };
  }
  if (ev.panel.status !== PanelStatus.ACTIVE || ev.read?.kind === "panel-inactive") {
    return { key: "PANEL_STATE", status: "FAIL", code: c.PANEL_INACTIVE, contributes: "UNAVAILABLE" };
  }
  if (!ev.readSupported) {
    // Live verification unavailable — the panel is fine, we just cannot read it
    // live. Do NOT label the account missing; freshness drives the severity.
    return { key: "PANEL_STATE", status: "INFO", code: c.PANEL_READ_UNSUPPORTED, contributes: "HEALTHY" };
  }
  const read = ev.read;
  if (read === null || read.kind === "read-ok" || read.kind === "not-found") {
    // Panel answered (positively, even for a not-found) → the panel is OK.
    return { key: "PANEL_STATE", status: "PASS", code: c.PANEL_OK, contributes: "HEALTHY" };
  }
  if (read.kind === "auth-failed") {
    return { key: "PANEL_STATE", status: "FAIL", code: c.PANEL_AUTH_FAILED, contributes: "NEEDS_SUPPORT" };
  }
  if (read.kind === "unreachable") {
    const timedOut = read.diagnosticCode === "timeout";
    return {
      key: "PANEL_STATE",
      status: "FAIL",
      code: timedOut ? c.PANEL_TIMEOUT : c.PANEL_UNREACHABLE,
      contributes: "UNAVAILABLE",
    };
  }
  // read-error: lock contention is retryable (DEGRADED); malformed = UNAVAILABLE.
  if (read.diagnosticCode === "locked" || read.diagnosticCode === "lock-unavailable") {
    return { key: "PANEL_STATE", status: "WARNING", code: c.PANEL_BUSY, contributes: "DEGRADED" };
  }
  return { key: "PANEL_STATE", status: "FAIL", code: c.PANEL_UNREACHABLE, contributes: "UNAVAILABLE" };
}

/** PANEL_ACCOUNT (§9). Positive absence only ever comes from a live not-found. */
function evaluatePanelAccount(ev: DiagnosticEvidence): DiagnosticCheckResult {
  if (ev.read?.kind === "read-ok") {
    return { key: "PANEL_ACCOUNT", status: "PASS", code: c.ACCOUNT_PRESENT, contributes: "HEALTHY" };
  }
  if (ev.read?.kind === "not-found") {
    return { key: "PANEL_ACCOUNT", status: "FAIL", code: c.ACCOUNT_NOT_FOUND, contributes: "NEEDS_SUPPORT" };
  }
  // No live confirmation → we cannot assert presence or absence.
  return { key: "PANEL_ACCOUNT", status: "UNKNOWN", code: c.ACCOUNT_UNVERIFIED, contributes: "HEALTHY" };
}

/** QUOTA (§9). Uses the raw normalized read when live (to keep the
 * missing-vs-unlimited distinction); otherwise the stored row (0 = unlimited). */
function evaluateQuota(ev: DiagnosticEvidence): DiagnosticCheckResult {
  const account = ev.read?.kind === "read-ok" ? ev.read.account : null;
  if (account !== null) {
    if (account.totalBytes === undefined) {
      return { key: "QUOTA", status: "UNKNOWN", code: c.QUOTA_UNKNOWN, contributes: "HEALTHY" };
    }
    if (account.totalBytes === null) {
      return { key: "QUOTA", status: "INFO", code: c.QUOTA_UNLIMITED, contributes: "HEALTHY" };
    }
    // Finite total but the panel omitted remaining — the fields are independently
    // optional, and the contract keeps missing fields UNKNOWN (never a reassuring
    // PASS) rather than guessing the remaining quota.
    if (account.remainingBytes === undefined || account.remainingBytes === null) {
      return { key: "QUOTA", status: "UNKNOWN", code: c.QUOTA_UNKNOWN, contributes: "HEALTHY" };
    }
    const remaining = account.remainingBytes;
    if (remaining <= 0n) {
      return { key: "QUOTA", status: "FAIL", code: c.QUOTA_EXHAUSTED, contributes: "ACTION_REQUIRED" };
    }
    if (isLowQuota(remaining, account.totalBytes)) {
      return { key: "QUOTA", status: "WARNING", code: c.QUOTA_LOW, contributes: "HEALTHY" };
    }
    return { key: "QUOTA", status: "PASS", code: c.QUOTA_OK, contributes: "HEALTHY" };
  }
  // Stored evidence: schema convention volumeBytes 0 = unlimited.
  const svc = ev.service;
  if (svc.volumeBytes === 0n) {
    return { key: "QUOTA", status: "INFO", code: c.QUOTA_UNLIMITED, contributes: "HEALTHY" };
  }
  if (svc.remainingBytes <= 0n || svc.status === ServiceStatus.LIMITED) {
    return { key: "QUOTA", status: "FAIL", code: c.QUOTA_EXHAUSTED, contributes: "ACTION_REQUIRED" };
  }
  if (isLowQuota(svc.remainingBytes, svc.volumeBytes)) {
    return { key: "QUOTA", status: "WARNING", code: c.QUOTA_LOW, contributes: "HEALTHY" };
  }
  return { key: "QUOTA", status: "PASS", code: c.QUOTA_OK, contributes: "HEALTHY" };
}

function isLowQuota(remaining: bigint, total: bigint): boolean {
  if (total <= 0n || remaining <= 0n) {
    return false;
  }
  // remaining / total < fraction  <=>  remaining * 1000 < total * (fraction*1000)
  const scaled = BigInt(Math.round(DIAGNOSTIC_LOW_QUOTA_FRACTION * 1000));
  return remaining * 1000n < total * scaled;
}

/** EXPIRY (§9). null = never expires (never coerced from a missing field). */
function evaluateExpiry(ev: DiagnosticEvidence): DiagnosticCheckResult {
  const nearMs = DIAGNOSTIC_NEAR_EXPIRY_DAYS * DAY_MS;
  const account = ev.read?.kind === "read-ok" ? ev.read.account : null;
  if (account !== null) {
    if (account.expiresAt === undefined) {
      return { key: "EXPIRY", status: "UNKNOWN", code: c.EXPIRY_UNKNOWN, contributes: "HEALTHY" };
    }
    if (account.expiresAt === null) {
      return { key: "EXPIRY", status: "INFO", code: c.EXPIRY_NONE, contributes: "HEALTHY" };
    }
    return classifyExpiry(account.expiresAt, ev.now, nearMs);
  }
  const svc = ev.service;
  if (svc.expiresAt === null) {
    return { key: "EXPIRY", status: "INFO", code: c.EXPIRY_NONE, contributes: "HEALTHY" };
  }
  if (svc.status === ServiceStatus.EXPIRED) {
    return { key: "EXPIRY", status: "FAIL", code: c.EXPIRY_EXPIRED, contributes: "ACTION_REQUIRED" };
  }
  return classifyExpiry(svc.expiresAt, ev.now, nearMs);
}

function classifyExpiry(expiresAt: Date, now: Date, nearMs: number): DiagnosticCheckResult {
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return { key: "EXPIRY", status: "FAIL", code: c.EXPIRY_EXPIRED, contributes: "ACTION_REQUIRED" };
  }
  if (remainingMs <= nearMs) {
    return { key: "EXPIRY", status: "WARNING", code: c.EXPIRY_NEAR, contributes: "HEALTHY" };
  }
  return { key: "EXPIRY", status: "PASS", code: c.EXPIRY_OK, contributes: "HEALTHY" };
}

/** CONNECTION_PAYLOAD (§9). Availability only — the payload itself is NEVER read. */
function evaluatePayload(service: Service): DiagnosticCheckResult {
  const hasUrl = service.subscriptionUrl !== null && service.subscriptionUrl !== "";
  const hasConfigs = Array.isArray(service.configLinks) && service.configLinks.length > 0;
  if (hasUrl || hasConfigs) {
    return { key: "CONNECTION_PAYLOAD", status: "PASS", code: c.PAYLOAD_PRESENT, contributes: "HEALTHY" };
  }
  return { key: "CONNECTION_PAYLOAD", status: "FAIL", code: c.PAYLOAD_MISSING, contributes: "ACTION_REQUIRED" };
}

/** CONNECTION_HISTORY (§9). A missing timestamp is NOT proof of never-connected
 * when the panel does not report history — that stays UNKNOWN (non-escalating);
 * a positive never-connected (reported, both absent) is DEGRADED + guide/link. */
function evaluateHistory(ev: DiagnosticEvidence): DiagnosticCheckResult {
  const svc = ev.service;
  if (svc.lastConnectedAt !== null) {
    const ageMs = ev.now.getTime() - svc.lastConnectedAt.getTime();
    if (ageMs <= ev.recentConnectionHours * 60 * 60 * 1000) {
      return { key: "CONNECTION_HISTORY", status: "PASS", code: c.HISTORY_RECENT, contributes: "HEALTHY" };
    }
    // Old last-connect is NOT proof of a current failure — advisory only.
    return { key: "CONNECTION_HISTORY", status: "WARNING", code: c.HISTORY_OLD, contributes: "HEALTHY" };
  }
  if (svc.firstConnectedAt !== null) {
    return { key: "CONNECTION_HISTORY", status: "WARNING", code: c.HISTORY_OLD, contributes: "HEALTHY" };
  }
  // Both absent. Only a LIVE read that actually reports connection-history fields
  // proves "never connected"; otherwise the evidence is unsupported → UNKNOWN.
  const account = ev.read?.kind === "read-ok" ? ev.read.account : null;
  const historyReported =
    account !== null &&
    (account.lastConnectedAt !== undefined || account.firstConnectedAt !== undefined);
  if (historyReported) {
    return { key: "CONNECTION_HISTORY", status: "INFO", code: c.HISTORY_NONE, contributes: "DEGRADED" };
  }
  return { key: "CONNECTION_HISTORY", status: "UNKNOWN", code: c.HISTORY_UNKNOWN, contributes: "HEALTHY" };
}

/** DATA_FRESHNESS (§9). */
function evaluateFreshness(source: DiagnosticEvidenceSource): DiagnosticCheckResult {
  switch (source) {
    case "LIVE_PANEL":
      return { key: "DATA_FRESHNESS", status: "INFO", code: c.FRESHNESS_LIVE, contributes: "HEALTHY" };
    case "FRESH_CACHE":
      return { key: "DATA_FRESHNESS", status: "INFO", code: c.FRESHNESS_CACHE, contributes: "HEALTHY" };
    default:
      return { key: "DATA_FRESHNESS", status: "WARNING", code: c.FRESHNESS_STORED, contributes: "DEGRADED" };
  }
}

/**
 * The DETERMINISTIC, PURE core: evaluates all authoritative checks and folds
 * their severities into ONE overall via the shared precedence (a later PASS can
 * never overwrite a more serious condition). No I/O, no clock reads beyond
 * ev.now, no Persian. Fully unit-testable.
 */
export function evaluateDiagnosticChecks(ev: DiagnosticEvidence): {
  checks: DiagnosticCheckResult[];
  overall: ServiceDiagnosticOverall;
} {
  const serviceState = evaluateServiceState(ev.service.status);
  const panelState = evaluatePanelState(ev);
  const panelAccount = evaluatePanelAccount(ev);

  // FAILED / positive account-absence / missing panel / panel auth must route to
  // support and NEVER present normal connection methods as the fix; when one of
  // those holds we still list the checks but keep the remaining ones advisory.
  const checks: DiagnosticCheckResult[] = [
    serviceState,
    panelState,
    panelAccount,
    evaluateQuota(ev),
    evaluateExpiry(ev),
    evaluatePayload(ev.service),
    evaluateHistory(ev),
    evaluateFreshness(ev.evidenceSource),
  ];

  const overall = checks.reduce<ServiceDiagnosticOverall>(
    (acc, next) => worstOverall(acc, next.contributes),
    "HEALTHY",
  );
  return { checks, overall };
}

// --- recommended-action generation (§11) -------------------------------------

export interface DiagnosticActionInputs {
  service: Service;
  actions: ServiceDetailActions;
  /** Guide entry is available AND the guide system is enabled. */
  guideAvailable: boolean;
  hasSubscriptionUrl: boolean;
  hasConfigs: boolean;
}

/**
 * Generates the ordered, DEDUPED action list. Only actions that are actually
 * available (per resolveServiceDetailActions + payload availability + the guide
 * gate) are ever emitted — no dead buttons. Ordering (§11): the action most
 * likely to resolve the diagnosed condition first, then guide/link/QR, then
 * retry, then support. RETRY and SUPPORT are always available. Every action
 * reuses an EXISTING callback; nothing here mutates anything.
 */
export function resolveRecommendedActions(
  overall: ServiceDiagnosticOverall,
  checks: DiagnosticCheckResult[],
  inputs: DiagnosticActionInputs,
): ServiceDiagnosticAction[] {
  const codes = new Set(checks.map((ck) => ck.code));
  const ordered: ServiceDiagnosticAction[] = [];
  const push = (action: ServiceDiagnosticAction, available: boolean): void => {
    if (available && !ordered.includes(action)) {
      ordered.push(action);
    }
  };
  const { actions } = inputs;

  // 1) The primary resolving action for the dominant diagnosed condition.
  if (overall === "NEEDS_SUPPORT") {
    // Account-not-found / FAILED / missing panel / auth failure → support only.
    // Never present regeneration/guide as a guaranteed fix here.
    push("OPEN_SUPPORT", true);
  } else if (overall === "UNAVAILABLE") {
    // Panel unreachable/inactive/timeout → retry + support; NEVER a mutation.
    push("RETRY_DIAGNOSTIC", true);
  } else if (overall === "ACTION_REQUIRED") {
    let resolved = false;
    const resolving = (action: ServiceDiagnosticAction, available: boolean): void => {
      if (available && !ordered.includes(action)) {
        ordered.push(action);
        resolved = true;
      }
    };
    if (codes.has(c.SERVICE_STATE_DISABLED)) {
      resolving("ENABLE_SERVICE", actions.toggleAction === "ENABLE");
    }
    if (codes.has(c.SERVICE_STATE_EXPIRED) || codes.has(c.EXPIRY_EXPIRED)) {
      resolving("RENEW_SERVICE", actions.canRenew);
    }
    if (codes.has(c.SERVICE_STATE_LIMITED) || codes.has(c.QUOTA_EXHAUSTED)) {
      resolving("BUY_EXTRA_VOLUME", actions.canBuyExtraVolume);
      resolving("RENEW_SERVICE", actions.canRenew);
    }
    if (codes.has(c.PAYLOAD_MISSING)) {
      // Regeneration ONLY when eligible; it is never presented as a guaranteed
      // fix, so an ineligible payload-missing case falls through to support.
      resolving("REGENERATE_LINK", actions.canRegenerateLink);
    }
    // No eligible resolving action for the diagnosed condition → lead with
    // support rather than a connection method that cannot help.
    if (!resolved) {
      push("OPEN_SUPPORT", true);
    }
  } else if (overall === "DEGRADED") {
    if (codes.has(c.SERVICE_STATE_CREATING)) {
      push("REFRESH_SERVICE", true);
    }
    // Never connected → lead with the connection guide, then link/QR.
    if (codes.has(c.HISTORY_NONE)) {
      push("OPEN_CONNECTION_GUIDE", inputs.guideAvailable);
      push("SHOW_SUBSCRIPTION_LINK", inputs.hasSubscriptionUrl);
      push("SHOW_SUBSCRIPTION_QR", inputs.hasSubscriptionUrl);
    }
    if (codes.has(c.FRESHNESS_STORED)) {
      push("RETRY_DIAGNOSTIC", true);
    }
  }

  // 2) Secondary helpful navigation: guide / link / QR / configs.
  push("OPEN_CONNECTION_GUIDE", inputs.guideAvailable);
  push("SHOW_SUBSCRIPTION_LINK", inputs.hasSubscriptionUrl);
  push("SHOW_SUBSCRIPTION_QR", inputs.hasSubscriptionUrl);
  push("SHOW_CONFIGS", inputs.hasConfigs);
  push("SHOW_CONFIG_QRS", inputs.hasConfigs);

  // 3) Retry, then 4) support — always available.
  push("RETRY_DIAGNOSTIC", true);
  push("OPEN_SUPPORT", true);
  return ordered;
}

/** The single primary recommendation persisted in a support snapshot. */
export function primaryRecommendation(
  actions: ServiceDiagnosticAction[],
): ServiceDiagnosticAction | undefined {
  return actions[0];
}

// --- Persian per-check rendering (code constants, tied to logic §18) ---------

const CHECK_FA: Record<string, string> = {
  [c.SERVICE_STATE_ACTIVE]: "وضعیت سرویس: فعال",
  [c.SERVICE_STATE_DISABLED]: "وضعیت سرویس: خاموش است",
  [c.SERVICE_STATE_EXPIRED]: "وضعیت سرویس: منقضی شده",
  [c.SERVICE_STATE_LIMITED]: "وضعیت سرویس: محدود شده (اتمام حجم)",
  [c.SERVICE_STATE_CREATING]: "وضعیت سرویس: در حال آماده‌سازی",
  [c.SERVICE_STATE_FAILED]: "وضعیت سرویس: ساخت سرویس ناموفق بوده است",
  [c.PANEL_OK]: "ارتباط با سرور سرویس: برقرار",
  [c.PANEL_MISSING]: "ارتباط با سرور سرویس: سرور سرویس در دسترس نیست",
  [c.PANEL_INACTIVE]: "ارتباط با سرور سرویس: سرور موقتاً غیرفعال است",
  [c.PANEL_READ_UNSUPPORTED]: "ارتباط با سرور سرویس: بررسی لحظه‌ای برای این سرور در دسترس نیست",
  [c.PANEL_UNREACHABLE]: "ارتباط با سرور سرویس: برقرار نشد",
  [c.PANEL_TIMEOUT]: "ارتباط با سرور سرویس: پاسخ در زمان مقرر دریافت نشد",
  [c.PANEL_AUTH_FAILED]: "ارتباط با سرور سرویس: نیازمند بررسی پشتیبانی",
  [c.PANEL_BUSY]: "ارتباط با سرور سرویس: عملیات دیگری در حال انجام است، کمی بعد دوباره تلاش کنید",
  [c.ACCOUNT_PRESENT]: "حساب سرویس روی سرور: یافت شد",
  [c.ACCOUNT_NOT_FOUND]: "حساب سرویس روی سرور: یافت نشد؛ نیازمند بررسی پشتیبانی",
  [c.ACCOUNT_UNVERIFIED]: "حساب سرویس روی سرور: امکان بررسی لحظه‌ای نبود",
  [c.QUOTA_UNLIMITED]: "حجم: نامحدود",
  [c.QUOTA_OK]: "حجم: در دسترس",
  [c.QUOTA_LOW]: "حجم: رو به اتمام",
  [c.QUOTA_EXHAUSTED]: "حجم: به پایان رسیده است",
  [c.QUOTA_UNKNOWN]: "حجم: اطلاعات حجم در دسترس نیست",
  [c.EXPIRY_NONE]: "زمان: بدون انقضا",
  [c.EXPIRY_OK]: "زمان: معتبر",
  [c.EXPIRY_NEAR]: "زمان: نزدیک به انقضا",
  [c.EXPIRY_EXPIRED]: "زمان: منقضی شده است",
  [c.EXPIRY_UNKNOWN]: "زمان: اطلاعات انقضا در دسترس نیست",
  [c.PAYLOAD_PRESENT]: "اطلاعات اتصال: موجود است",
  [c.PAYLOAD_MISSING]: "اطلاعات اتصال: موجود نیست",
  [c.HISTORY_RECENT]: "آخرین اتصال: اخیراً ثبت شده است",
  [c.HISTORY_OLD]: "آخرین اتصال: مدتی از آخرین اتصال گذشته است",
  [c.HISTORY_NONE]: "آخرین اتصال: هنوز اتصال موفقی ثبت نشده است",
  [c.HISTORY_UNKNOWN]: "آخرین اتصال: اطلاعات اتصال در دسترس نیست",
  [c.FRESHNESS_LIVE]: "منبع اطلاعات: بررسی لحظه‌ای انجام شد",
  [c.FRESHNESS_CACHE]: "منبع اطلاعات: اطلاعات به‌روز اخیر",
  [c.FRESHNESS_STORED]: "منبع اطلاعات: آخرین اطلاعات ذخیره‌شده",
};

/** Persian line for a check code (falls back to the code — never a secret). */
export function diagnosticCheckMessage(code: string): string {
  return CHECK_FA[code] ?? code;
}

/** Admin/owner-facing Persian labels for the overall result (code constants). */
const OVERALL_FA: Record<ServiceDiagnosticOverall, string> = {
  HEALTHY: "سالم",
  ACTION_REQUIRED: "نیازمند اقدام",
  DEGRADED: "قابل بررسی",
  UNAVAILABLE: "عدم دسترسی",
  NEEDS_SUPPORT: "نیازمند پشتیبانی",
};

export function diagnosticOverallLabel(overall: ServiceDiagnosticOverall): string {
  return OVERALL_FA[overall];
}

/** Admin/owner-facing Persian labels for the evidence source (code constants). */
const EVIDENCE_FA: Record<DiagnosticEvidenceSource, string> = {
  LIVE_PANEL: "بررسی لحظه‌ای",
  FRESH_CACHE: "اطلاعات به‌روز اخیر",
  STORED_ONLY: "اطلاعات ذخیره‌شده",
};

export function diagnosticEvidenceLabel(source: DiagnosticEvidenceSource): string {
  return EVIDENCE_FA[source];
}

// --- one-read execution ------------------------------------------------------

export interface DiagnosticCooldownState {
  onCooldown: boolean;
  remainingSeconds: number;
}

/** Checks (and arms) the per owner+Service cooldown. Fail-open on Redis outage. */
export async function checkDiagnosticsCooldown(
  userId: string,
  serviceId: string,
): Promise<DiagnosticCooldownState> {
  const seconds = await diagnosticsCooldownSeconds();
  const gate = await checkAndArmCooldown(
    serviceDiagnosticsCooldownKey(userId, serviceId),
    seconds * 1000,
  );
  if (gate.state === "cooling") {
    return { onCooldown: true, remainingSeconds: Math.max(1, Math.ceil(gate.remainingMs / 1000)) };
  }
  // armed OR degraded (Redis unavailable → never block).
  return { onCooldown: false, remainingSeconds: 0 };
}

export interface DiagnosticRun {
  report: ServiceDiagnosticReport;
  primary: ServiceDiagnosticAction | undefined;
  /** The freshest Service row (live on read-ok, stored otherwise). */
  service: Service;
}

/**
 * Runs one full diagnosis. Performs AT MOST ONE authenticated panel account
 * read (bounded + lock-guarded via readServiceForDiagnostics), never mutates a
 * Service/panel, and never throws — every failure degrades to a safe report.
 * Assumes the caller already validated ownership + the master switch + cooldown.
 */
export async function runServiceDiagnostics(
  service: Service,
  userId: string,
  opts: { persist?: boolean } = {},
): Promise<DiagnosticRun> {
  const startedAt = Date.now();
  // A transient DB hiccup while loading the panel must NOT throw out of a
  // diagnosis (the handler renders a report, never a crash) — degrade to a
  // stored-only report with no panel.
  let panel: Panel | null = null;
  let recentConnectionHours = SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT;
  try {
    [panel, recentConnectionHours] = await Promise.all([
      prisma.panel.findUnique({ where: { id: service.panelId } }),
      diagnosticsRecentConnectionHours(),
    ]);
  } catch {
    panel = null;
  }

  const readSupported =
    panel !== null &&
    panel.status === PanelStatus.ACTIVE &&
    panelOperationAvailable(panel, "readService");

  let freshest = service;
  let read: PanelReadOutcome | null = null;
  let evidenceSource: DiagnosticEvidenceSource = evidenceFromStored(service);

  if (readSupported) {
    // Explicit diagnosis requests FRESH evidence (bypasses the display TTL), but
    // is cut off at a bounded budget so the callback never hangs. On timeout the
    // underlying read continues safely in the background (never rejects) and
    // persists for next time; the cooldown bounds how often that can happen. The
    // whole read is wrapped so a DB/adapter error degrades to stored evidence
    // instead of throwing — runServiceDiagnostics NEVER throws.
    try {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<"diag-timeout">((resolve) => {
        timer = setTimeout(() => resolve("diag-timeout"), diagnosticsReadTimeoutMs());
      });
      const raced = await Promise.race([
        readServiceForDiagnostics(service.id, userId, { persist: opts.persist ?? true }),
        budget,
      ]).finally(() => clearTimeout(timer));

      if (raced === "diag-timeout") {
        read = {
          kind: "unreachable",
          service,
          panelId: panel?.id ?? null,
          panelType: panel?.type ?? null,
          account: null,
          diagnosticCode: "timeout",
        };
        evidenceSource = evidenceFromStored(service);
      } else {
        read = raced;
        if (raced.kind === "read-ok" && raced.service !== null) {
          freshest = raced.service;
          evidenceSource = "LIVE_PANEL";
        } else {
          freshest = raced.service ?? service;
          evidenceSource = evidenceFromStored(freshest);
        }
      }
    } catch {
      read = {
        kind: "read-error",
        service,
        panelId: panel?.id ?? null,
        panelType: panel?.type ?? null,
        account: null,
        diagnosticCode: "exception",
      };
      evidenceSource = evidenceFromStored(service);
    }
  }

  const evidence: DiagnosticEvidence = {
    service: freshest,
    panel,
    read,
    evidenceSource,
    readSupported,
    recentConnectionHours,
    now: new Date(),
  };
  const { checks, overall } = evaluateDiagnosticChecks(evidence);

  const [actions, guideAvailable] = await Promise.all([
    safeResolveActions(freshest),
    guideEntryAvailable(freshest),
  ]);
  const recommendedActions = resolveRecommendedActions(overall, checks, {
    service: freshest,
    actions,
    guideAvailable,
    hasSubscriptionUrl: freshest.subscriptionUrl !== null && freshest.subscriptionUrl !== "",
    hasConfigs: Array.isArray(freshest.configLinks) && freshest.configLinks.length > 0,
  });
  const primary = primaryRecommendation(recommendedActions);

  const report: ServiceDiagnosticReport = {
    overall,
    evidenceSource,
    checkedAt: evidence.now,
    checks: checks.map<ServiceDiagnosticCheck>((ck) => ({
      key: ck.key,
      status: ck.status,
      code: ck.code,
      userMessage: diagnosticCheckMessage(ck.code),
    })),
    recommendedActions,
  };

  await logDiagnosticCompleted(report, userId, service.id, Date.now() - startedAt);
  if (read !== null && read.kind !== "read-ok" && read.kind !== "not-found") {
    void writeSystemLog({
      level: "INFO",
      eventType: DIAGNOSTIC_EVENTS.LIVE_READ_UNAVAILABLE,
      message: "diagnostics live panel read unavailable",
      metadata: {
        panelType: read.panelType ?? "unknown",
        code: read.diagnosticCode ?? read.kind,
        correlation: correlationHash(userId, service.id),
      },
    });
  }

  return { report, primary, service: freshest };
}

/** Freshness of the STORED row relative to the display TTL. */
function evidenceFromStored(service: Service): DiagnosticEvidenceSource {
  const ttlMs = serviceSyncTtlMs();
  if (
    ttlMs > 0 &&
    service.lastSubscriptionUpdateAt !== null &&
    Date.now() - service.lastSubscriptionUpdateAt.getTime() < ttlMs
  ) {
    return "FRESH_CACHE";
  }
  return "STORED_ONLY";
}

async function guideEntryAvailable(service: Service): Promise<boolean> {
  try {
    return await isConnectionGuideEntryVisible(service);
  } catch {
    return false;
  }
}

/** resolveServiceDetailActions, but a DB error degrades to "no actions" instead
 * of throwing (keeps runServiceDiagnostics throw-free). */
async function safeResolveActions(service: Service): Promise<ServiceDetailActions> {
  try {
    return await resolveServiceDetailActions(service);
  } catch {
    return {
      toggleAction: null,
      canBuyExtraVolume: false,
      canBuyExtraTime: false,
      canRegenerateLink: false,
      canRenew: false,
    };
  }
}

// --- snapshot + logging ------------------------------------------------------

/** Builds the strict, secret-free snapshot persisted only on support handoff. */
export function snapshotForSupport(
  report: ServiceDiagnosticReport,
  primary: ServiceDiagnosticAction | undefined,
): DiagnosticSnapshot {
  return buildDiagnosticSnapshot(report, primary);
}

/** Short, non-reversible correlation hash (§19) — never exposes ids. */
export function correlationHash(userId: string, serviceId: string): string {
  return createHash("sha256").update(`${userId}:${serviceId}`).digest("hex").slice(0, 12);
}

async function logDiagnosticCompleted(
  report: ServiceDiagnosticReport,
  userId: string,
  serviceId: string,
  durationMs: number,
): Promise<void> {
  const counts: Record<ServiceDiagnosticCheckStatus, number> = {
    PASS: 0,
    INFO: 0,
    WARNING: 0,
    FAIL: 0,
    UNKNOWN: 0,
  };
  for (const check of report.checks) {
    counts[check.status] += 1;
  }
  await writeSystemLog({
    level: "INFO",
    eventType: DIAGNOSTIC_EVENTS.COMPLETED,
    message: "service diagnostics completed",
    metadata: {
      overall: report.overall,
      evidenceSource: report.evidenceSource,
      counts,
      durationMs,
      correlation: correlationHash(userId, serviceId),
    },
  });
}

/** Emits the cooldown-hit aggregate event (no ids). */
export async function logDiagnosticCooldownHit(
  userId: string,
  serviceId: string,
): Promise<void> {
  await writeSystemLog({
    level: "INFO",
    eventType: DIAGNOSTIC_EVENTS.COOLDOWN_HIT,
    message: "service diagnostics cooldown hit",
    metadata: { correlation: correlationHash(userId, serviceId) },
  });
}

/** Emits the support-handoff-started aggregate event (no ids). */
export async function logDiagnosticSupportHandoff(
  userId: string,
  serviceId: string,
): Promise<void> {
  await writeSystemLog({
    level: "INFO",
    eventType: DIAGNOSTIC_EVENTS.SUPPORT_HANDOFF,
    message: "service diagnostics support handoff started",
    metadata: { correlation: correlationHash(userId, serviceId) },
  });
}

/** Emits the safe-snapshot-attached aggregate event (no ids). */
export async function logDiagnosticSnapshotAttached(
  userId: string,
  serviceId: string,
): Promise<void> {
  await writeSystemLog({
    level: "INFO",
    eventType: DIAGNOSTIC_EVENTS.SNAPSHOT_ATTACHED,
    message: "service diagnostics snapshot attached to support ticket",
    metadata: { correlation: correlationHash(userId, serviceId) },
  });
}

/** Admin/OWNER-authorized service lookup by uuid-prefix short id (ANY owner) —
 * used ONLY by the read-only OWNER preview. Returns null for unknown, ambiguous
 * or deleted services. The preview never creates a ticket or mutates anything. */
export async function getServiceByShortIdForAdmin(shortId: string): Promise<Service | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: {
      id: { startsWith: shortId },
      deletedAt: null,
      status: { not: ServiceStatus.DELETED },
    },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Counts of ACTIVE panels that do / do not support a live readService call —
 * shown on the OWNER settings page so an operator understands how much of their
 * fleet can be verified live vs stored-only (§17). */
export async function countDiagnosticsPanelSupport(): Promise<{
  readable: number;
  unreadable: number;
}> {
  const panels = await prisma.panel.findMany({ where: { status: PanelStatus.ACTIVE } });
  let readable = 0;
  for (const panel of panels) {
    if (panelOperationAvailable(panel, "readService")) {
      readable += 1;
    }
  }
  return { readable, unreadable: panels.length - readable };
}

/** Aggregate counts of diagnostic events over a bounded recent window (§17). */
export async function diagnosticsEventCounts(
  sinceHours: number,
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await prisma.systemLog.groupBy({
    by: ["eventType"],
    where: {
      eventType: { in: Object.values(DIAGNOSTIC_EVENTS) },
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.eventType] = row._count._all;
  }
  return out;
}
