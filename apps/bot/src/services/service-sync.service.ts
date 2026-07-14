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

async function syncServiceFromPanelUnlocked(
  serviceId: string,
  userId: string,
): Promise<SyncServiceResult> {
  const service = await prisma.service.findFirst({
    where: {
      id: serviceId,
      userId,
      deletedAt: null,
      status: { not: ServiceStatus.DELETED },
    },
    include: { panel: true },
  });
  if (service === null) {
    return {
      ok: false,
      service: null,
      error: "service not found",
      safeUserMessage: "مورد یافت نشد.",
      failureKind: "other",
    };
  }
  const { panel, ...serviceRow } = service;

  if (panel.status !== "ACTIVE") {
    return {
      ok: false,
      service: serviceRow,
      error: `panel status is ${panel.status}`,
      safeUserMessage: SYNC_FAILED_USER_TEXT,
      failureKind: "panel-inactive",
    };
  }

  logger.info("service sync started", {
    serviceId: service.id,
    panelId: panel.id,
    panelType: panel.type,
  });

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
    logger.warn("service sync failed", {
      serviceId: service.id,
      panelId: panel.id,
      notFound: result.notFound === true,
      error: result.errorMessage ?? "unknown",
    });
    // Transport/auth-level diagnostics = the PANEL was unreachable (the
    // display path renders a dedicated line for that); everything else is a
    // generic sync failure. notFound = positive absence.
    const code = result.diagnostic?.code;
    const failureKind: SyncFailureKind =
      result.notFound === true
        ? "not-found"
        : code === "unreachable" || code === "timeout" || code === "auth-failed"
          ? "panel-unreachable"
          : "other";
    return {
      ok: false,
      service: serviceRow,
      error: result.errorMessage ?? "unknown",
      // Positive absence (full inventory readable, no client) gets its own
      // message; "could not check" stays a generic retryable failure. The
      // stored row is untouched either way - sync never guesses.
      safeUserMessage: result.notFound === true ? SYNC_NOT_FOUND_TEXT : SYNC_FAILED_USER_TEXT,
      failureKind,
    };
  }

  const updated = await prisma.service.update({
    where: { id: service.id },
    data: buildUpdateData(serviceRow, result),
  });
  logger.info("service sync succeeded", { serviceId: service.id, panelId: panel.id });
  return { ok: true, service: updated, message: SYNC_OK_TEXT };
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
