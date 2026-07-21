import {
  prisma,
  ServiceStatus,
  type Prisma,
  type Service,
} from "@zedbot/database";
import { type GetServiceAccountResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  acquireServiceLock,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceOperationLockKey,
} from "./service-lock.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Service sync (Phase 11 + service-live-sync phase): read-only refresh of one
// Service row from its panel. Reads the panel account, updates the stored
// usage/status fields and nothing else - never mutates the panel, never
// renews/deletes anything, never touches orders/payments/wallets. A failed
// sync leaves the row completely untouched (the user keeps seeing the last
// stored values). Subscription/config links and panel credentials are never
// logged - sync logs carry only serviceId/panelType/syncResult/duration.
//
// The live-sync phase adds syncServiceForDisplay: the automatic, bounded
// sync that runs when a user OPENS a service page - freshness TTL (skip the
// panel when the row was synced moments ago), a display time budget (a slow
// panel can not hang the page; the sync finishes in the background) and
// graceful Persian fallbacks that keep showing the stored values.
// =============================================================================

export const SYNC_OK_TEXT = "اطلاعات سرویس بروزرسانی شد ✅";
export const SYNC_FAILED_USER_TEXT = "بروزرسانی اطلاعات سرویس موقتاً امکان‌پذیر نیست.";
export const SYNC_NOT_FOUND_TEXT = "سرویس در پنل پیدا نشد.";
// Live-sync fallback lines rendered UNDER the stored values on the detail
// page. Never technical - adapter errors stay in logs.
export const SYNC_STALE_FALLBACK_TEXT =
  "امکان دریافت اطلاعات لحظه‌ای سرویس وجود ندارد. آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود.";
export const SYNC_TIMEOUT_FALLBACK_TEXT =
  "آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود. بروزرسانی لحظه‌ای سرویس در دسترس نیست.";
export const SYNC_PANEL_UNAVAILABLE_TEXT =
  "ارتباط با پنل سرویس برقرار نشد. لطفاً کمی بعد دوباره تلاش کنید.";

/** Classified failure cause - drives the user-facing fallback line. */
export type SyncFailureKind =
  | "locked"
  | "panel-inactive"
  | "panel-unreachable"
  | "not-found"
  | "other";

/**
 * Rich, classified outcome of the ONE authenticated panel account read that a
 * sync (or an explicit diagnosis) performs. This is the shared "read-and-sync"
 * primitive contract: syncServiceFromPanel projects it to SyncServiceResult
 * (unchanged public shape), and the diagnostics service consumes it directly so
 * a diagnosis performs AT MOST ONE panel account read and never a second one.
 *
 *   - read-ok        : the panel account was read; the Service row was updated.
 *   - not-found      : POSITIVE absence (panel reported no such account).
 *   - auth-failed    : the panel rejected our credentials (NOT absence).
 *   - unreachable    : transport failure / timeout (NOT absence) - see code.
 *   - panel-inactive : the panel is not ACTIVE; no read was attempted.
 *   - service-missing: owner-scoped lookup failed (unknown/foreign/deleted).
 *   - read-error     : the panel answered unusably (malformed/other).
 *
 * `service` is the freshest row available (updated on read-ok, the stored row
 * otherwise, null only on service-missing). `account` is the normalized panel
 * result when a read was attempted. A failed read NEVER overwrites the row.
 */
export type PanelReadKind =
  | "read-ok"
  | "not-found"
  | "auth-failed"
  | "unreachable"
  | "panel-inactive"
  | "service-missing"
  | "read-error";

export interface PanelReadOutcome {
  kind: PanelReadKind;
  service: Service | null;
  /** Panel id for ops logs; null on service-missing / lock failure. */
  panelId: string | null;
  /** Panel type snapshot (marzban/xui) for safe logs; null on service-missing. */
  panelType: string | null;
  /** Normalized panel result when a read was attempted; null otherwise. */
  account: GetServiceAccountResult | null;
  /** Sanitized diagnostic code when the read failed with one; null otherwise. */
  diagnosticCode: string | null;
}

// -----------------------------------------------------------------------------
// §3 privacy-safe logging for the read primitive. The SAME one-read primitive
// backs three callers with different privacy needs, so every caller declares
// how its logs must be shaped:
//   NORMAL_SYNC   — the display/refresh path: our own DB ids (serviceId/panelId)
//                   are fine (documented, non-secret, and logged bot-wide), but a
//                   raw adapter error is NOT — it may embed a URL/host/token.
//   DIAGNOSTICS   — an explicit user diagnosis: log NOTHING reversible — no
//   OWNER_PREVIEW   serviceId/panelId/userId/username/URL/raw error — only the
//                   operation, panel type, a sanitized code + bounded category,
//                   the outcome and a NON-reversible correlation hash.
// The correlation is a pre-computed sha256(userId:serviceId) slice — a token,
// never a secret; we never hash a URL/credential and then log it.
// -----------------------------------------------------------------------------

export type ServiceReadLogContext =
  | { mode: "NORMAL_SYNC" }
  | { mode: "DIAGNOSTICS"; correlation: string }
  | { mode: "OWNER_PREVIEW"; correlation: string };

const NORMAL_SYNC_LOG_CONTEXT: ServiceReadLogContext = { mode: "NORMAL_SYNC" };

/**
 * Maps a raw adapter error string to a BOUNDED, non-identifying category. The
 * raw string may embed a subscription URL, panel host, token or a panel-body
 * fragment, so this NEVER echoes it — it only pattern-matches into a fixed,
 * closed vocabulary that is always safe to log.
 */
export function scrubErrorCategory(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") {
    return "none";
  }
  const s = raw.toLowerCase();
  if (s.includes("timeout") || s.includes("etimedout") || s.includes("timed out")) return "timeout";
  if (s.includes("econnrefused") || s.includes("connection refused")) return "conn-refused";
  if (s.includes("enotfound") || s.includes("getaddrinfo") || s.includes("dns")) return "dns";
  if (s.includes("econnreset") || s.includes("socket hang up") || s.includes("epipe")) return "conn-reset";
  if (
    s.includes("certificate") ||
    s.includes("self-signed") ||
    s.includes("self signed") ||
    s.includes(" ssl") ||
    s.includes("tls")
  ) {
    return "tls";
  }
  if (s.includes("401") || s.includes("403") || s.includes("unauthorized") || s.includes("forbidden")) return "auth";
  if (s.includes("404") || s.includes("not found")) return "not-found";
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many")) return "rate-limited";
  if (
    s.includes("500") ||
    s.includes("502") ||
    s.includes("503") ||
    s.includes("504") ||
    s.includes("gateway") ||
    s.includes("bad gateway")
  ) {
    return "server-error";
  }
  if (s.includes("json") || s.includes("parse") || s.includes("unexpected token") || s.includes("malformed")) {
    return "malformed";
  }
  return "other";
}

/** The base log fields for a read, shaped by the caller's privacy mode. In
 * DIAGNOSTICS/OWNER_PREVIEW mode NOTHING reversible is included — no serviceId,
 * no panelId, no userId — only the operation, panel type and correlation hash. */
function readLogBaseFields(
  ctx: ServiceReadLogContext,
  serviceId: string,
  panelId: string,
  panelType: string,
): Record<string, unknown> {
  if (ctx.mode === "NORMAL_SYNC") {
    return { serviceId, panelId, panelType };
  }
  return { operation: ctx.mode, panelType, correlation: ctx.correlation };
}

/** A safe, mode-aware read-error outcome (never carries credentials/URLs). */
function readErrorOutcome(
  code: string,
  service: Service | null = null,
  panelId: string | null = null,
  panelType: string | null = null,
): PanelReadOutcome {
  return { kind: "read-error", service, panelId, panelType, account: null, diagnosticCode: code };
}

export type SyncServiceResult =
  | { ok: true; service: Service; message: string }
  | {
      ok: false;
      service: Service | null;
      error: string;
      safeUserMessage: string;
      failureKind: SyncFailureKind;
    };

/** Panel status -> ServiceStatus; "unknown" keeps the stored status. */
const STATUS_TO_SERVICE_STATUS: Partial<Record<string, ServiceStatus>> = {
  active: ServiceStatus.ACTIVE,
  disabled: ServiceStatus.DISABLED,
  expired: ServiceStatus.EXPIRED,
  limited: ServiceStatus.LIMITED,
};

/**
 * Update payload from a successful adapter read. Only fields the panel
 * actually reported are written; the panel is the source of truth, so
 * nothing is inferred (e.g. no local auto-EXPIRED). subscriptionUrl is
 * never overwritten with null, configLinks only when the adapter returned
 * links, expiresAt only when the panel reported it explicitly (null there
 * means "never expires"), username is never touched.
 */
function buildUpdateData(service: Service, result: GetServiceAccountResult): Prisma.ServiceUpdateInput {
  const data: Prisma.ServiceUpdateInput = { lastSubscriptionUpdateAt: new Date() };
  const mappedStatus =
    result.status !== undefined ? STATUS_TO_SERVICE_STATUS[result.status] : undefined;
  if (mappedStatus !== undefined) {
    data.status = mappedStatus;
  }
  if (result.usedBytes !== undefined) {
    data.usedBytes = result.usedBytes;
  }
  if (result.totalBytes !== undefined) {
    // null = unlimited -> stored as 0n per the schema convention.
    data.volumeBytes = result.totalBytes ?? 0n;
    if (result.remainingBytes !== undefined) {
      data.remainingBytes = result.remainingBytes ?? 0n;
    }
  }
  if (result.expiresAt !== undefined) {
    data.expiresAt = result.expiresAt;
  }
  if (result.subscriptionUrl !== undefined && result.subscriptionUrl !== "") {
    data.subscriptionUrl = result.subscriptionUrl;
  }
  if (result.subscriptionToken !== undefined && result.subscriptionToken !== "") {
    data.subscriptionToken = result.subscriptionToken;
  }
  if (result.configLinks !== undefined && result.configLinks.length > 0) {
    data.configLinks = result.configLinks;
  }
  if (result.remoteMetadata !== undefined) {
    // Fresh non-secret remote evidence (client emails + attached inbound
    // ids) keeps the GLOBAL_CLIENT / LEGACY_PER_INBOUND classification
    // current - recording what the panel reports, never migrating anything.
    data.remoteMetadata = result.remoteMetadata as Prisma.InputJsonObject;
  }
  if (
    result.firstConnectedAt !== undefined &&
    result.firstConnectedAt !== null &&
    service.firstConnectedAt === null
  ) {
    data.firstConnectedAt = result.firstConnectedAt;
  }
  if (result.lastConnectedAt !== undefined && result.lastConnectedAt !== null) {
    data.lastConnectedAt = result.lastConnectedAt;
    if (service.firstConnectedAt === null && data.firstConnectedAt === undefined) {
      data.firstConnectedAt = result.lastConnectedAt;
    }
  }
  return data;
}

/**
 * The SAME field-mapping as buildUpdateData, but applied to an IN-MEMORY copy of
 * the row instead of persisting it. Used by the read-only (persist: false) path
 * so a preview reasons over the freshly-read live state — keeping the evaluated
 * status/history/quota consistent with LIVE_PANEL evidence — while the stored row
 * is never written. Only fields the panel actually reported are applied.
 */
function projectServiceFromAccount(service: Service, result: GetServiceAccountResult): Service {
  const projected: Service = { ...service, lastSubscriptionUpdateAt: new Date() };
  const mappedStatus =
    result.status !== undefined ? STATUS_TO_SERVICE_STATUS[result.status] : undefined;
  if (mappedStatus !== undefined) {
    projected.status = mappedStatus;
  }
  if (result.usedBytes !== undefined) {
    projected.usedBytes = result.usedBytes;
  }
  if (result.totalBytes !== undefined) {
    projected.volumeBytes = result.totalBytes ?? 0n;
    if (result.remainingBytes !== undefined) {
      projected.remainingBytes = result.remainingBytes ?? 0n;
    }
  }
  if (result.expiresAt !== undefined) {
    projected.expiresAt = result.expiresAt;
  }
  if (result.subscriptionUrl !== undefined && result.subscriptionUrl !== "") {
    projected.subscriptionUrl = result.subscriptionUrl;
  }
  if (result.configLinks !== undefined && result.configLinks.length > 0) {
    projected.configLinks = result.configLinks;
  }
  if (
    result.firstConnectedAt !== undefined &&
    result.firstConnectedAt !== null &&
    service.firstConnectedAt === null
  ) {
    projected.firstConnectedAt = result.firstConnectedAt;
  }
  if (result.lastConnectedAt !== undefined && result.lastConnectedAt !== null) {
    projected.lastConnectedAt = result.lastConnectedAt;
    if (service.firstConnectedAt === null && projected.firstConnectedAt === null) {
      projected.firstConnectedAt = result.lastConnectedAt;
    }
  }
  return projected;
}

/**
 * Refreshes one service from its panel, scoped to the owner. Read-only from
 * the panel's perspective; the Service row is only updated on a successful
 * read. All error strings are internal-safe; safeUserMessage is what the
 * user may see.
 */
export async function syncServiceFromPanel(
  serviceId: string,
  userId: string,
): Promise<SyncServiceResult> {
  // CONCURRENCY: sync WRITES local Service state from a panel read - racing
  // a mutation could overwrite freshly-persisted values with a stale panel
  // snapshot. It therefore takes the same per-service lock as mutations;
  // contention/unavailability fails closed with a retryable message.
  const acquisition = await acquireServiceLock(serviceOperationLockKey(serviceId));
  if (!acquisition.ok) {
    return {
      ok: false,
      service: null,
      error: `service lock ${acquisition.reason}`,
      safeUserMessage:
        acquisition.reason === "contended"
          ? SERVICE_LOCK_BUSY_TEXT
          : SERVICE_LOCK_UNAVAILABLE_TEXT,
      failureKind: "locked",
    };
  }
  try {
    return await syncServiceFromPanelUnlocked(serviceId, userId);
  } finally {
    await acquisition.lock.release();
  }
}

/**
 * The shared "read-and-sync" primitive (LOCK-FREE - the caller holds the
 * per-service lock). Performs AT MOST ONE authenticated panel account read and,
 * on success ONLY, updates the Service row. Returns the rich classified
 * PanelReadOutcome; it never throws and never mutates the panel. Both
 * syncServiceFromPanel and the diagnostics service build on this single read so
 * a run can never issue a second panel request.
 */
async function readServiceAccountAndSyncUnlocked(
  serviceId: string,
  userId: string,
  persist = true,
  logContext: ServiceReadLogContext = NORMAL_SYNC_LOG_CONTEXT,
): Promise<PanelReadOutcome> {
  // §4: the owner-scoped DB lookup is wrapped — a DB hiccup degrades to a safe
  // typed read-error instead of throwing out of the primitive.
  let service: Prisma.ServiceGetPayload<{ include: { panel: true } }> | null;
  try {
    service = await prisma.service.findFirst({
      where: {
        id: serviceId,
        userId,
        deletedAt: null,
        status: { not: ServiceStatus.DELETED },
      },
      include: { panel: true },
    });
  } catch {
    // No panel/service context yet — log only the operation + correlation.
    if (logContext.mode !== "NORMAL_SYNC") {
      logger.warn("service diagnostics read error", {
        operation: logContext.mode,
        stage: "db-lookup",
        correlation: logContext.correlation,
      });
    } else {
      logger.warn("service sync error", { serviceId, stage: "db-lookup" });
    }
    return readErrorOutcome("db-error");
  }
  if (service === null) {
    return {
      kind: "service-missing",
      service: null,
      panelId: null,
      panelType: null,
      account: null,
      diagnosticCode: null,
    };
  }
  const { panel, ...serviceRow } = service;

  if (panel.status !== "ACTIVE") {
    return {
      kind: "panel-inactive",
      service: serviceRow,
      panelId: panel.id,
      panelType: panel.type,
      account: null,
      diagnosticCode: null,
    };
  }

  const baseFields = readLogBaseFields(logContext, service.id, panel.id, panel.type);
  logger.info(
    logContext.mode === "NORMAL_SYNC" ? "service sync started" : "service diagnostics read started",
    baseFields,
  );

  // §4: adapter construction + the account read are wrapped; a thrown error
  // becomes a NORMAL failed-read result (the raw message is sanitized below,
  // never logged verbatim).
  let result: GetServiceAccountResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    result = await adapter.getServiceAccount({
      username: service.username,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    result = { ok: false, errorMessage: errorMessage(err) };
  }

  if (!result.ok) {
    const code = result.diagnostic?.code ?? null;
    // §3: NEVER log the raw errorMessage (it may embed a URL/host/token). Log a
    // sanitized code + a bounded scrubbed category instead, in every mode.
    logger.warn(
      logContext.mode === "NORMAL_SYNC" ? "service sync failed" : "service diagnostics read failed",
      {
        ...baseFields,
        notFound: result.notFound === true,
        code: code ?? "unknown",
        category: scrubErrorCategory(result.errorMessage),
      },
    );
    const kind: PanelReadKind =
      result.notFound === true
        ? "not-found"
        : code === "auth-failed"
          ? "auth-failed"
          : code === "unreachable" || code === "timeout"
            ? "unreachable"
            : "read-error";
    return {
      kind,
      service: serviceRow,
      panelId: panel.id,
      panelType: panel.type,
      account: result,
      diagnosticCode: code,
    };
  }

  // Read-only mode (the OWNER preview): the account was read live, but the row
  // is NOT written — the preview promises to change nothing. The returned
  // `service` is an IN-MEMORY projection of the live read so the report reasons
  // over the fresh state (consistent with LIVE_PANEL evidence) without any DB
  // write; `account` also carries the live result.
  if (!persist) {
    logger.info(
      logContext.mode === "NORMAL_SYNC"
        ? "service sync succeeded"
        : "service diagnostics read succeeded",
      baseFields,
    );
    return {
      kind: "read-ok",
      service: projectServiceFromAccount(serviceRow, result),
      panelId: panel.id,
      panelType: panel.type,
      account: result,
      diagnosticCode: null,
    };
  }

  // §4: the persist write is wrapped. A successful read whose DB update fails
  // must not throw out of the primitive; it fails closed to a safe read-error
  // that still carries the STORED row (a failed read NEVER overwrites the row).
  let updated: Service;
  try {
    updated = await prisma.service.update({
      where: { id: service.id },
      data: buildUpdateData(serviceRow, result),
    });
  } catch {
    if (logContext.mode !== "NORMAL_SYNC") {
      logger.warn("service diagnostics read error", {
        operation: logContext.mode,
        stage: "db-update",
        panelType: panel.type,
        correlation: logContext.correlation,
      });
    } else {
      logger.warn("service sync error", { serviceId: service.id, panelId: panel.id, stage: "db-update" });
    }
    return readErrorOutcome("persist-error", serviceRow, panel.id, panel.type);
  }
  logger.info(
    logContext.mode === "NORMAL_SYNC" ? "service sync succeeded" : "service diagnostics read succeeded",
    baseFields,
  );
  return {
    kind: "read-ok",
    service: updated,
    panelId: panel.id,
    panelType: panel.type,
    account: result,
    diagnosticCode: null,
  };
}

/** Projects the rich PanelReadOutcome to the (unchanged) SyncServiceResult and
 * emits the sync-path ops log on a panel-connection failure. */
async function syncServiceFromPanelUnlocked(
  serviceId: string,
  userId: string,
): Promise<SyncServiceResult> {
  const outcome = await readServiceAccountAndSyncUnlocked(serviceId, userId);
  switch (outcome.kind) {
    case "read-ok":
      // outcome.service is the updated row on read-ok.
      return { ok: true, service: outcome.service as Service, message: SYNC_OK_TEXT };
    case "service-missing":
      return {
        ok: false,
        service: null,
        error: "service not found",
        safeUserMessage: "مورد یافت نشد.",
        failureKind: "other",
      };
    case "panel-inactive":
      return {
        ok: false,
        service: outcome.service,
        error: "panel status is not ACTIVE",
        safeUserMessage: SYNC_FAILED_USER_TEXT,
        failureKind: "panel-inactive",
      };
    default: {
      // not-found | auth-failed | unreachable | read-error
      const failureKind: SyncFailureKind =
        outcome.kind === "not-found"
          ? "not-found"
          : outcome.kind === "auth-failed" || outcome.kind === "unreachable"
            ? "panel-unreachable"
            : "other";
      if (failureKind === "panel-unreachable") {
        // Ops log (PANEL topic) - THE central panel-connection-failure signal.
        // Ids + safe diagnostic code only; never URLs, credentials or raw errors.
        void writeSystemLog({
          level: "WARN",
          eventType: OPS_EVENTS.PANEL_CONNECTION_FAILED,
          message: "panel connection failed during service sync",
          metadata: {
            panelId: outcome.panelId ?? "unknown",
            panelType: outcome.panelType ?? "unknown",
            code: outcome.diagnosticCode ?? "unknown",
          },
          topicKey: "PANEL",
          serviceId,
        });
      }
      return {
        ok: false,
        service: outcome.service,
        error: outcome.account?.errorMessage ?? "unknown",
        safeUserMessage:
          outcome.kind === "not-found" ? SYNC_NOT_FOUND_TEXT : SYNC_FAILED_USER_TEXT,
        failureKind,
      };
    }
  }
}

/**
 * Diagnostics entry point: takes the SAME per-service lock as sync and runs the
 * SAME single read-and-sync primitive, returning the rich PanelReadOutcome. Lock
 * contention returns a synthetic `read-error` outcome carrying a `locked`
 * diagnosticCode (the diagnostics service maps this to a retryable report - never
 * an exception). Never throws. The Service row is updated ONLY on read-ok, and
 * the primitive issues AT MOST ONE authenticated panel account read.
 */
export async function readServiceForDiagnostics(
  serviceId: string,
  userId: string,
  opts: { persist?: boolean; logContext: ServiceReadLogContext },
): Promise<PanelReadOutcome> {
  // §4: TRULY never-throw. Every step is wrapped so no exception escapes:
  //   - lock ACQUISITION (Redis down / throwing) → safe lock-unavailable;
  //   - the read body → itself never-throw, but guarded as defence in depth;
  //   - lock RELEASE (in finally) → swallowed so it can NEVER replace the
  //     classified result.
  let acquisition: Awaited<ReturnType<typeof acquireServiceLock>>;
  try {
    acquisition = await acquireServiceLock(serviceOperationLockKey(serviceId));
  } catch {
    return readErrorOutcome("lock-unavailable");
  }
  if (!acquisition.ok) {
    return readErrorOutcome(acquisition.reason === "contended" ? "locked" : "lock-unavailable");
  }
  try {
    return await readServiceAccountAndSyncUnlocked(
      serviceId,
      userId,
      opts.persist ?? true,
      opts.logContext,
    );
  } catch {
    return readErrorOutcome("read-error");
  } finally {
    try {
      await acquisition.lock.release();
    } catch {
      // A release failure must NEVER replace the classified result above; a
      // stale lock expires on its own TTL. Swallowed intentionally.
    }
  }
}

// --- automatic display sync (service-live-sync phase) ------------------------------------

/** Freshness TTL: a row synced this recently is served as-is. 0 disables the cache. */
export function serviceSyncTtlMs(): number {
  const parsed = Number.parseInt(process.env.SERVICE_SYNC_TTL_SECONDS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : 60_000;
}

/**
 * Display time budget: how long opening a page may WAIT for the panel. On
 * expiry the page renders stored values; the sync keeps running in the
 * background and lands in the DB for the next open.
 */
export function serviceSyncDisplayTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SERVICE_SYNC_DISPLAY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8_000;
}

/** Opt-in: also live-sync the services shown on the «سرویس‌های من» list page. */
export function serviceListSyncEnabled(): boolean {
  return (process.env.SERVICE_LIST_SYNC_ENABLED ?? "").toLowerCase() === "true";
}

export type DisplaySyncOutcome =
  | "synced"
  | "cache-fresh"
  | "timeout"
  | "panel-unavailable"
  | "not-found"
  | "locked"
  | "failed";

export interface DisplaySyncResult {
  /** Freshest available row - live on success, the stored row otherwise. */
  service: Service;
  /** true = the rendered data is live (synced now or within the TTL). */
  fresh: boolean;
  /** Persian fallback line for the detail page; null when fresh. */
  notice: string | null;
  outcome: DisplaySyncOutcome;
}

const FAILURE_NOTICE: Record<SyncFailureKind, string> = {
  locked: SYNC_STALE_FALLBACK_TEXT,
  "panel-inactive": SYNC_PANEL_UNAVAILABLE_TEXT,
  "panel-unreachable": SYNC_PANEL_UNAVAILABLE_TEXT,
  "not-found": SYNC_NOT_FOUND_TEXT,
  other: SYNC_STALE_FALLBACK_TEXT,
};

const FAILURE_OUTCOME: Record<SyncFailureKind, DisplaySyncOutcome> = {
  locked: "locked",
  "panel-inactive": "panel-unavailable",
  "panel-unreachable": "panel-unavailable",
  "not-found": "not-found",
  other: "failed",
};

/**
 * The automatic sync behind OPENING a service page: panel -> normalize ->
 * update row -> render, without making the bot slow. Fresh rows (synced
 * within the TTL) skip the panel entirely; a slow panel is cut off at the
 * display budget (the underlying sync keeps running in the background and
 * persists for the next open - syncServiceFromPanel never rejects, so the
 * abandoned promise is safe); every failure falls back to the stored row
 * plus a safe Persian notice. Never throws. Logs carry ONLY serviceId,
 * panelType, syncResult and durationMs - no tokens, no URLs, no errors from
 * the panel body.
 */
export async function syncServiceForDisplay(
  service: Service,
  userId: string,
): Promise<DisplaySyncResult> {
  const startedAt = Date.now();
  const ttlMs = serviceSyncTtlMs();
  if (
    ttlMs > 0 &&
    service.lastSubscriptionUpdateAt !== null &&
    startedAt - service.lastSubscriptionUpdateAt.getTime() < ttlMs
  ) {
    // Freshly synced - serve the stored row without touching the panel.
    logger.debug("service display sync", {
      serviceId: service.id,
      panelType: service.panelType,
      syncResult: "cache-fresh",
      durationMs: 0,
    });
    return { service, fresh: true, notice: null, outcome: "cache-fresh" };
  }

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<"display-timeout">((resolve) => {
    timer = setTimeout(() => resolve("display-timeout"), serviceSyncDisplayTimeoutMs());
  });
  const raced = await Promise.race([syncServiceFromPanel(service.id, userId), budget]).finally(
    () => clearTimeout(timer),
  );

  const durationMs = Date.now() - startedAt;
  if (raced === "display-timeout") {
    logger.info("service display sync", {
      serviceId: service.id,
      panelType: service.panelType,
      syncResult: "timeout",
      durationMs,
    });
    return { service, fresh: false, notice: SYNC_TIMEOUT_FALLBACK_TEXT, outcome: "timeout" };
  }
  if (raced.ok) {
    logger.info("service display sync", {
      serviceId: service.id,
      panelType: service.panelType,
      syncResult: "synced",
      durationMs,
    });
    return { service: raced.service, fresh: true, notice: null, outcome: "synced" };
  }
  logger.info("service display sync", {
    serviceId: service.id,
    panelType: service.panelType,
    syncResult: FAILURE_OUTCOME[raced.failureKind],
    durationMs,
  });
  return {
    service: raced.service ?? service,
    fresh: false,
    notice: FAILURE_NOTICE[raced.failureKind],
    outcome: FAILURE_OUTCOME[raced.failureKind],
  };
}
