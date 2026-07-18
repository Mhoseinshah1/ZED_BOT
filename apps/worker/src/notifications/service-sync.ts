import {
  PanelStatus,
  ServiceStatus,
  prisma,
  type Prisma,
} from "@zedbot/database";
import type { GetServiceAccountResult, PanelAdapter } from "@zedbot/panel-adapters";
import {
  DEFAULT_SYNC_CONCURRENCY,
  createLogger,
  errorMessage,
  panelSyncLockKey,
} from "@zedbot/shared";

import { acquireLock, releaseLock, type RawRedis } from "../redis.js";
import { isPanelBreakerOpen, recordPanelFailure, recordPanelSuccess } from "./circuit-breaker.js";
import {
  buildWorkerAdapterForPanel,
  normalizeWorkerSubscriptionBase,
} from "./panel-adapter-factory.js";

// =============================================================================
// Worker-owned Service-state synchronization engine (Phase 1, notification/
// retention engine). Reads each panel's live account state and refreshes the
// stored Service rows so the downstream notification scans work off fresh
// usage/status/expiry. Read-only against the panel: it NEVER mutates the panel,
// never renews/deletes/disables anything, never touches orders/payments, and
// NEVER disables a panel. A failed read leaves the Service row completely
// untouched (the user keeps the last stored values) - sync never guesses.
//
// Per panel: fail closed if the lock backend (Redis) is down; skip if the
// circuit breaker is open; take a single per-panel lock; skip inactive panels;
// then either ONE bulk inventory read (adapters that expose listServiceAccounts,
// e.g. XUI) or a bounded, concurrency-limited per-service loop (Marzban, which
// has no bulk endpoint). Panel-wide read failures trip the breaker; a healthy
// read clears it.
//
// Logs carry ONLY a short panel id and safe counts/codes - never usernames,
// subscription URLs, tokens or panel credentials.
// =============================================================================

const log = createLogger("worker:service-sync");

/** Per-panel sync lock TTL: generous vs. a slow panel read, self-freeing on crash. */
const PANEL_SYNC_LOCK_TTL_MS = 120_000;

/** Small pause between per-service batches so a panel is not hammered. */
const BATCH_DELAY_MS = 250;

/**
 * Statuses whose live state is worth refreshing. DELETED/FAILED/CREATING are
 * excluded: nothing meaningful to sync (and never resurrected here).
 */
const SYNC_STATUSES: ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.LIMITED,
  ServiceStatus.EXPIRED,
  ServiceStatus.DISABLED,
];

export interface ServiceStateSyncDeps {
  redis: RawRedis;
}

/** Outcome of one panel's sync. `skipped` is set (with a safe reason) when no read was attempted. */
export interface PanelSyncResult {
  synced: number;
  notFound: number;
  failed: number;
  skipped?: string;
}

/** Minimal Service projection the engine needs (id to update, username to match). */
interface SyncServiceRow {
  id: string;
  username: string;
}

/** Panel status -> ServiceStatus; anything else keeps the stored status. */
const STATUS_TO_SERVICE_STATUS: Partial<Record<string, ServiceStatus>> = {
  active: ServiceStatus.ACTIVE,
  disabled: ServiceStatus.DISABLED,
  expired: ServiceStatus.EXPIRED,
  limited: ServiceStatus.LIMITED,
};

/**
 * Pure, safe mapper from a panel read to a Prisma update. Mirrors the bot's
 * service-sync buildUpdateData: only fields the panel actually reported are
 * written (the panel is the source of truth; nothing is inferred), unlimited
 * quota is stored as 0n, subscription url/token/config links are never
 * overwritten with empty values, and lastSubscriptionUpdateAt is stamped when
 * SOMETHING authoritative was mapped.
 *
 * Returns null when result.ok is false OR the read carried nothing
 * authoritative (so the caller leaves the row untouched rather than stamping a
 * meaningless refresh). NEVER logs.
 *
 * Note vs. the bot mapper: firstConnectedAt is written only when the panel
 * reports it (non-null); this pure function has no current row to gate the
 * "set once" backfill on, and a panel-reported first-connection instant is
 * stable, so re-writing the same value is harmless.
 */
export function buildServiceSyncUpdate(
  result: GetServiceAccountResult,
): Prisma.ServiceUpdateInput | null {
  if (!result.ok) {
    return null;
  }
  const data: Prisma.ServiceUpdateInput = {};
  let hasAuthoritative = false;

  const mappedStatus =
    result.status !== undefined ? STATUS_TO_SERVICE_STATUS[result.status] : undefined;
  if (mappedStatus !== undefined) {
    data.status = mappedStatus;
    hasAuthoritative = true;
  }
  if (result.usedBytes !== undefined) {
    data.usedBytes = result.usedBytes;
    hasAuthoritative = true;
  }
  if (result.totalBytes !== undefined) {
    // null = unlimited -> stored as 0n per the schema convention.
    data.volumeBytes = result.totalBytes ?? 0n;
    hasAuthoritative = true;
    if (result.remainingBytes !== undefined) {
      data.remainingBytes = result.remainingBytes ?? 0n;
    }
  }
  if (result.expiresAt !== undefined) {
    data.expiresAt = result.expiresAt;
    hasAuthoritative = true;
  }
  if (result.subscriptionUrl !== undefined && result.subscriptionUrl !== "") {
    data.subscriptionUrl = result.subscriptionUrl;
    hasAuthoritative = true;
  }
  if (result.subscriptionToken !== undefined && result.subscriptionToken !== "") {
    data.subscriptionToken = result.subscriptionToken;
    hasAuthoritative = true;
  }
  if (result.configLinks !== undefined && result.configLinks.length > 0) {
    data.configLinks = result.configLinks;
    hasAuthoritative = true;
  }
  if (result.remoteMetadata !== undefined) {
    data.remoteMetadata = result.remoteMetadata as Prisma.InputJsonObject;
    hasAuthoritative = true;
  }
  if (result.firstConnectedAt !== undefined && result.firstConnectedAt !== null) {
    data.firstConnectedAt = result.firstConnectedAt;
    hasAuthoritative = true;
  }
  if (result.lastConnectedAt !== undefined && result.lastConnectedAt !== null) {
    data.lastConnectedAt = result.lastConnectedAt;
    hasAuthoritative = true;
  }

  if (!hasAuthoritative) {
    return null;
  }
  data.lastSubscriptionUpdateAt = new Date();
  return data;
}

/**
 * Pure freshness check: true when the row was synced within maxAgeMinutes.
 * A never-synced row (null) is never fresh.
 */
export function isServiceStateFresh(
  service: { lastSubscriptionUpdateAt: Date | null },
  maxAgeMinutes: number,
  now: Date = new Date(),
): boolean {
  if (service.lastSubscriptionUpdateAt === null) {
    return false;
  }
  const ageMs = now.getTime() - service.lastSubscriptionUpdateAt.getTime();
  return ageMs >= 0 && ageMs < maxAgeMinutes * 60_000;
}

/** First 8 chars of an id - enough to correlate logs, never the full value. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `worker` over `items` in fixed-size batches with a small inter-batch delay. */
async function runBatched<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  delayMs: number,
): Promise<void> {
  const size = Math.max(1, concurrency);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map(worker));
    if (delayMs > 0 && i + size < items.length) {
      await sleep(delayMs);
    }
  }
}

/**
 * Syncs one panel's active services. See the module header for the full
 * sequence. Always resolves (never rejects); the per-panel lock is released in
 * a finally.
 */
export async function syncPanelServices(
  deps: ServiceStateSyncDeps,
  panelId: string,
): Promise<PanelSyncResult> {
  const { redis } = deps;
  const skip = (reason: string): PanelSyncResult => ({
    synced: 0,
    notFound: 0,
    failed: 0,
    skipped: reason,
  });

  // 1. Fail closed when the lock backend (Redis) is unreachable: without a
  //    working lock we cannot guarantee a single sync per panel, so we do not
  //    run at all rather than risk concurrent writers.
  try {
    await redis.ping();
  } catch (err) {
    log.warn("redis unavailable; skipping panel sync", {
      panel: shortId(panelId),
      code: errorMessage(err),
    });
    return skip("redis-unavailable");
  }

  // 2. Circuit breaker: skip a panel that has been failing.
  if (await isPanelBreakerOpen(redis, panelId)) {
    log.info("panel breaker open; skipping sync", { panel: shortId(panelId) });
    return skip("breaker-open");
  }

  // 3. Per-panel lock: only one sync per panel at a time; contention -> skip.
  const lock = await acquireLock(redis, panelSyncLockKey(panelId), PANEL_SYNC_LOCK_TTL_MS);
  if (lock === null) {
    return skip("lock-contended");
  }

  try {
    const panel = await prisma.panel.findUnique({ where: { id: panelId } });
    if (panel === null) {
      return skip("panel-not-found");
    }
    if (panel.status !== PanelStatus.ACTIVE) {
      return skip("panel-inactive");
    }

    const services: SyncServiceRow[] = await prisma.service.findMany({
      where: { panelId, deletedAt: null, status: { in: SYNC_STATUSES } },
      select: { id: true, username: true },
    });
    if (services.length === 0) {
      return skip("no-services");
    }

    let adapter: PanelAdapter;
    try {
      adapter = buildWorkerAdapterForPanel(panel);
    } catch (err) {
      // Config errors persist; trip the breaker so we stop hammering a panel
      // that cannot be built. The panel is never disabled here.
      await recordPanelFailure(redis, panelId);
      log.warn("panel adapter build failed", {
        panel: shortId(panelId),
        code: errorMessage(err),
      });
      return skip("adapter-config");
    }

    const subscriptionBaseUrl = normalizeWorkerSubscriptionBase(panel);

    if (typeof adapter.listServiceAccounts === "function") {
      return await syncViaBulk(redis, panelId, adapter, services, subscriptionBaseUrl);
    }
    return await syncViaPerService(redis, panelId, adapter, services, subscriptionBaseUrl);
  } finally {
    await releaseLock(redis, lock);
  }
}

/** ONE bulk inventory read (adapters exposing listServiceAccounts), matched locally by username. */
async function syncViaBulk(
  redis: RawRedis,
  panelId: string,
  adapter: PanelAdapter,
  services: SyncServiceRow[],
  subscriptionBaseUrl: string | null,
): Promise<PanelSyncResult> {
  let bulk: GetServiceAccountResult[] | null = null;
  try {
    bulk = (await adapter.listServiceAccounts?.({ subscriptionBaseUrl })) ?? null;
  } catch (err) {
    // The adapter contract is never-throw, but stay defensive.
    log.warn("bulk read threw", { panel: shortId(panelId), code: errorMessage(err) });
    bulk = null;
  }
  if (bulk === null) {
    await recordPanelFailure(redis, panelId);
    log.warn("bulk read failed; leaving rows untouched", { panel: shortId(panelId) });
    return { synced: 0, notFound: 0, failed: 0, skipped: "bulk-read-failed" };
  }

  const byUsername = new Map<string, GetServiceAccountResult>();
  for (const account of bulk) {
    if (typeof account.username === "string" && account.username !== "") {
      byUsername.set(account.username, account);
    }
  }

  let synced = 0;
  let notFound = 0;
  let failed = 0;
  for (const svc of services) {
    const match = byUsername.get(svc.username);
    if (match === undefined) {
      // Full inventory read, no client for this username: positive absence.
      // Leave the row untouched (sync never marks DELETED / guesses).
      notFound += 1;
      continue;
    }
    const update = buildServiceSyncUpdate(match);
    if (update === null) {
      continue;
    }
    try {
      await prisma.service.update({ where: { id: svc.id }, data: update });
      synced += 1;
    } catch (err) {
      // A single row's DB write failing must not abort the panel.
      failed += 1;
      log.warn("service row update failed", { panel: shortId(panelId), code: errorMessage(err) });
    }
  }

  // A readable inventory proves the panel is healthy -> clear the breaker.
  await recordPanelSuccess(redis, panelId);
  log.info("bulk panel sync complete", { panel: shortId(panelId), synced, notFound, failed });
  return { synced, notFound, failed };
}

/** Bounded, concurrency-limited per-service reads (Marzban - no bulk endpoint). */
async function syncViaPerService(
  redis: RawRedis,
  panelId: string,
  adapter: PanelAdapter,
  services: SyncServiceRow[],
  subscriptionBaseUrl: string | null,
): Promise<PanelSyncResult> {
  const counters = { synced: 0, notFound: 0, failed: 0 };
  // Any read that proves the panel actually answered (an ok read or a positive
  // 404). If NOTHING answered and everything failed, that is a panel-level
  // read failure worth tripping the breaker for; per-service errors alone are
  // not (one bad account must not open the breaker).
  let sawPanelResponse = false;

  const worker = async (svc: SyncServiceRow): Promise<void> => {
    let result: GetServiceAccountResult;
    try {
      result = await adapter.getServiceAccount({ username: svc.username, subscriptionBaseUrl });
    } catch (err) {
      // A per-service adapter error must NOT abort the panel - count and move on.
      counters.failed += 1;
      log.warn("per-service read threw", { panel: shortId(panelId), code: errorMessage(err) });
      return;
    }
    if (!result.ok) {
      if (result.notFound === true) {
        counters.notFound += 1;
        sawPanelResponse = true; // a definite 404 means the panel answered.
      } else {
        counters.failed += 1;
      }
      return;
    }
    sawPanelResponse = true;
    const update = buildServiceSyncUpdate(result);
    if (update === null) {
      return;
    }
    try {
      await prisma.service.update({ where: { id: svc.id }, data: update });
      counters.synced += 1;
    } catch (err) {
      counters.failed += 1;
      log.warn("service row update failed", { panel: shortId(panelId), code: errorMessage(err) });
    }
  };

  await runBatched(services, DEFAULT_SYNC_CONCURRENCY, worker, BATCH_DELAY_MS);

  if (!sawPanelResponse && counters.failed > 0) {
    // Definite panel-level read failure across the board.
    await recordPanelFailure(redis, panelId);
  } else {
    await recordPanelSuccess(redis, panelId);
  }
  log.info("per-service panel sync complete", {
    panel: shortId(panelId),
    synced: counters.synced,
    notFound: counters.notFound,
    failed: counters.failed,
  });
  return { synced: counters.synced, notFound: counters.notFound, failed: counters.failed };
}

/**
 * Top-level entry: groups all sync-eligible services by panel (one distinct
 * query) and syncs each panel SEQUENTIALLY (concurrency lives WITHIN a panel).
 * One panel failing never aborts the others.
 */
export async function runServiceStateSync(
  deps: ServiceStateSyncDeps,
): Promise<{ panels: number; synced: number; failed: number }> {
  const rows = await prisma.service.findMany({
    where: { deletedAt: null, status: { in: SYNC_STATUSES } },
    distinct: ["panelId"],
    select: { panelId: true },
  });

  let panels = 0;
  let synced = 0;
  let failed = 0;
  for (const { panelId } of rows) {
    panels += 1;
    try {
      const result = await syncPanelServices(deps, panelId);
      synced += result.synced;
      failed += result.failed;
    } catch (err) {
      // syncPanelServices is designed never to reject; guard anyway so one
      // panel can never abort the whole sweep.
      failed += 1;
      log.error("panel sync crashed", { panel: shortId(panelId), code: errorMessage(err) });
    }
  }
  log.info("service-state sync sweep complete", { panels, synced, failed });
  return { panels, synced, failed };
}
