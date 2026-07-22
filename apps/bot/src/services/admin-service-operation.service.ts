import { createHash } from "node:crypto";

import {
  AdminRole,
  PanelStatus,
  Prisma,
  prisma,
  ServiceStatus,
  type AdminServiceOperation,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import {
  type AddServiceTimeResult,
  type GetServiceAccountResult,
} from "@zedbot/panel-adapters";
import {
  ADMIN_SERVICE_BLOCKING_STATUSES,
  ADMIN_SERVICE_MAX_TOTAL_BYTES,
  ADMIN_SERVICE_RECONCILE_STATUSES,
  adminServiceSnapshotFingerprintInput,
  adminVolumeGibToBytes,
  isValidAdminServiceNote,
  isValidAdminServiceReason,
  parseAdminTimeDays,
  parseAdminVolumeGib,
  type AdminServiceErrorCode,
  type AdminServiceOperationStatus,
  type AdminServiceOperationType,
  type AdminServiceRequestedUnit,
  type AdminServiceStateSnapshot,
  errorMessage,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { logAdminServiceOperation } from "./admin-service-operation-log.service.js";
import { areAdminServiceMutationsEnabled } from "./admin-service-settings.service.js";
import { calculateExtraTime } from "./extra-time.service.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  panelOperationAvailable,
  serviceSupportsGlobalLifecycle,
} from "./panel-readiness.service.js";
import {
  acquireServiceLock,
  serviceOperationLockKey,
  SERVICE_LOCK_WAIT_MS,
  type ServiceLock,
} from "./service-lock.service.js";
import { regenerateServiceSubscriptionUnlocked } from "./service-link.service.js";
import { readServiceForDiagnostics } from "./service-sync.service.js";
import { toggleServiceStatusUnlocked, type ToggleAction } from "./service-toggle.service.js";

// =============================================================================
// Admin Service Operations — the authoritative executor + read-only refresh +
// read-only reconciliation + internal notes (feat/admin-service-operations,
// §9–§18). This is the SINGLE lifecycle-mutation authority for the admin
// console; it NEVER creates a second lifecycle implementation — enable/disable
// and link regeneration reuse the actor-aware unlocked primitives, and the
// complimentary volume/time grants reuse the low-level Panel mutation + the
// pure calculator while NEVER dispatching a paid Order or touching any
// financial table (§6, §12).
//
// Every mutation follows the §10 sequence: revalidate OWNER → recheck the
// mutation master switch → load Service+Panel+owner → idempotency fast-path →
// acquire the per-Service lock → reload under the lock → eligibility/capability
// → fingerprint compare (stale-preview guard) → PENDING claim → ONE remote
// mutation → classify definite success / failure / UNCERTAIN → persist local
// ONLY on definite success → persist the operation status → release. UNCERTAIN
// never auto-retries (§11): it blocks conflicting mutations and is resolved by
// the read-only reconciliation page only.
// =============================================================================

/** The mutation operation types (everything except the note-only ADD_NOTE). */
export type AdminServiceMutationType = Exclude<AdminServiceOperationType, "ADD_NOTE">;

/** Distinct ServiceEventLog event types for admin grants — NEVER the user's
 * `EXTRA_*_APPLIED` (which carry an orderId and feed financial reporting) and
 * NEVER a `..._BY_USER` type. This is what keeps an admin grant out of every
 * revenue/sales counter (§6, §12). */
export const EXTRA_VOLUME_GRANTED_BY_ADMIN_EVENT_TYPE = "EXTRA_VOLUME_GRANTED_BY_ADMIN";
export const EXTRA_TIME_GRANTED_BY_ADMIN_EVENT_TYPE = "EXTRA_TIME_GRANTED_BY_ADMIN";
export const ADMIN_SERVICE_NOTE_EVENT_TYPE = "ADMIN_SERVICE_NOTE_ADDED";

// -----------------------------------------------------------------------------
// Safe snapshot + fingerprint + idempotency helpers
// -----------------------------------------------------------------------------

/** The ONLY Service fields captured in an operation snapshot (no secrets). */
export function buildAdminServiceSnapshot(
  service: Pick<
    Service,
    "status" | "volumeBytes" | "usedBytes" | "remainingBytes" | "expiresAt" | "lastSubscriptionUpdateAt"
  >,
  panel: Pick<Panel, "status" | "type">,
): AdminServiceStateSnapshot {
  return {
    status: service.status,
    panelStatus: panel.status,
    panelType: panel.type,
    volumeBytes: service.volumeBytes.toString(),
    usedBytes: service.usedBytes.toString(),
    remainingBytes: service.remainingBytes.toString(),
    expiresAt: service.expiresAt === null ? null : service.expiresAt.toISOString(),
    lastSubscriptionUpdateAt:
      service.lastSubscriptionUpdateAt === null
        ? null
        : service.lastSubscriptionUpdateAt.toISOString(),
  };
}

/** Deterministic, non-secret fingerprint of a snapshot's decision-relevant
 * fields — the confirmation compares it so a stale preview can never mutate
 * newer state. */
export function adminServiceSnapshotFingerprint(snapshot: AdminServiceStateSnapshot): string {
  return createHash("sha256")
    .update(adminServiceSnapshotFingerprintInput(snapshot))
    .digest("hex")
    .slice(0, 32);
}

/** Non-secret, deterministic idempotency key: the SAME confirm (same nonce)
 * converges (unique constraint), a fresh preview (new nonce) is a new op. */
export function deriveAdminOperationIdempotencyKey(
  adminId: string,
  serviceId: string,
  type: AdminServiceOperationType,
  requestedCount: number | null,
  nonce: string,
): string {
  return createHash("sha256")
    .update(`${adminId}|${serviceId}|${type}|${requestedCount ?? "∅"}|${nonce}`)
    .digest("hex")
    .slice(0, 40);
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex").slice(0, 32);
}

function parseSnapshot(value: Prisma.JsonValue | null): AdminServiceStateSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.status !== "string" || typeof v.panelStatus !== "string") {
    return null;
  }
  return {
    status: String(v.status),
    panelStatus: String(v.panelStatus),
    panelType: typeof v.panelType === "string" ? v.panelType : "",
    volumeBytes: typeof v.volumeBytes === "string" ? v.volumeBytes : null,
    usedBytes: typeof v.usedBytes === "string" ? v.usedBytes : null,
    remainingBytes: typeof v.remainingBytes === "string" ? v.remainingBytes : null,
    expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null,
    lastSubscriptionUpdateAt:
      typeof v.lastSubscriptionUpdateAt === "string" ? v.lastSubscriptionUpdateAt : null,
  };
}

// -----------------------------------------------------------------------------
// §9 — read-only refresh
// -----------------------------------------------------------------------------

export type AdminServiceRefreshOutcome =
  | { kind: "refreshed"; service: Service }
  | { kind: "not-found" }
  | { kind: "auth-failed" }
  | { kind: "unreachable" }
  | { kind: "panel-inactive"; service: Service | null }
  | { kind: "service-missing" }
  | { kind: "locked" }
  | { kind: "error" };

/**
 * Read-only refresh of ONE Service from its Panel for the admin console (§9).
 * Reuses the shared read-and-sync primitive: exactly ONE authenticated Panel
 * read at most, under the per-Service lock, NEVER a remote mutation, and NO
 * AdminServiceOperation row. It distinguishes a positive not-found from a
 * timeout/auth/unreachable failure, and stays available even while lifecycle
 * mutations are disabled (it never consults the master switch).
 */
export async function refreshAdminServiceReadOnly(
  serviceId: string,
  ownerUserId: string,
): Promise<AdminServiceRefreshOutcome> {
  const outcome = await readServiceForDiagnostics(serviceId, ownerUserId, {
    persist: true,
    logContext: { mode: "NORMAL_SYNC" },
  });
  switch (outcome.kind) {
    case "read-ok":
      return { kind: "refreshed", service: outcome.service as Service };
    case "not-found":
      return { kind: "not-found" };
    case "auth-failed":
      return { kind: "auth-failed" };
    case "unreachable":
      return { kind: "unreachable" };
    case "panel-inactive":
      return { kind: "panel-inactive", service: outcome.service };
    case "service-missing":
      return { kind: "service-missing" };
    default:
      // read-error (includes lock contention / unavailable via diagnosticCode).
      return outcome.diagnosticCode === "locked" ? { kind: "locked" } : { kind: "error" };
  }
}

// -----------------------------------------------------------------------------
// Executor
// -----------------------------------------------------------------------------

export interface ExecuteAdminServiceOperationInput {
  type: AdminServiceMutationType;
  serviceId: string;
  adminId: string;
  reason: string;
  /** GiB for ADD_VOLUME, days for ADD_TIME; null for toggles/regen. */
  requestedCount?: number | null;
  expectedFingerprint: string;
  /** One-shot confirmation nonce (drives idempotencyKey + confirmationNonceHash). */
  nonce: string;
  /** Inbound Telegram update_id for replay protection (optional). */
  sourceUpdateId?: bigint | null;
  notifyUser?: boolean;
}

export type ExecuteAdminServiceOperationResult =
  | {
      outcome: "succeeded";
      operationId: string;
      changed: boolean;
      ownerUserId: string | null;
      /** True when the user should be notified once (change happened + notify flag). */
      notifyUser: boolean;
      afterSnapshot: AdminServiceStateSnapshot | null;
    }
  | {
      outcome: "uncertain";
      operationId: string;
      status: Extract<AdminServiceOperationStatus, "UNCERTAIN" | "RECONCILIATION_REQUIRED">;
      errorCode: AdminServiceErrorCode;
    }
  | { outcome: "failed"; operationId: string; errorCode: AdminServiceErrorCode }
  | { outcome: "rejected"; errorCode: AdminServiceErrorCode };

/** Applier result — the appliers own the ONE remote mutation + local persist. */
type ApplierResult =
  | { kind: "success"; changed: boolean; confirmedAfter: AdminServiceStateSnapshot }
  | {
      kind: "uncertain";
      status: Extract<AdminServiceOperationStatus, "UNCERTAIN" | "RECONCILIATION_REQUIRED">;
      projectedAfter: AdminServiceStateSnapshot | null;
      errorCode: AdminServiceErrorCode;
    }
  | { kind: "failed"; errorCode: AdminServiceErrorCode };

/** DB-level status sets an operation may target (the fresh Panel read inside an
 * applier re-verifies unlimited-quota / never-expiry precisely). */
const ELIGIBLE_STATUS: Record<AdminServiceMutationType, ServiceStatus[]> = {
  ENABLE: [ServiceStatus.DISABLED],
  DISABLE: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED],
  // Volume/time grants use the addServiceTime mechanism, which sets status
  // "active" on the panel — so they are NOT offered on a DISABLED service (it
  // must be ENABLED first; otherwise the panel would silently re-enable while
  // the local row stays DISABLED). Extending an EXPIRED service via time is the
  // intended "give more time" revival.
  ADD_VOLUME: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED],
  ADD_TIME: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED, ServiceStatus.EXPIRED],
  REGENERATE_LINK: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED, ServiceStatus.DISABLED],
};

function requestedUnitFor(type: AdminServiceMutationType): AdminServiceRequestedUnit | null {
  if (type === "ADD_VOLUME") return "GIB";
  if (type === "ADD_TIME") return "DAY";
  return null;
}

/** Maps a terminal/blocking existing operation (idempotency convergence) to a
 * result WITHOUT re-running the remote mutation. */
function resultFromExisting(op: AdminServiceOperation): ExecuteAdminServiceOperationResult {
  switch (op.status) {
    case "SUCCEEDED":
    case "RECONCILED":
      return {
        outcome: "succeeded",
        operationId: op.id,
        changed: false,
        ownerUserId: op.targetUserId,
        // A converged double-click never re-notifies.
        notifyUser: false,
        afterSnapshot: parseSnapshot(op.afterSnapshot),
      };
    case "UNCERTAIN":
    case "RECONCILIATION_REQUIRED":
      return {
        outcome: "uncertain",
        operationId: op.id,
        status: op.status,
        errorCode: (op.safeErrorCode as AdminServiceErrorCode | null) ?? "PANEL_UNCERTAIN",
      };
    case "FAILED":
      return {
        outcome: "failed",
        operationId: op.id,
        errorCode: (op.safeErrorCode as AdminServiceErrorCode | null) ?? "VALIDATION",
      };
    default:
      // PENDING (still in flight) or CANCELLED — treat as a live conflict.
      return { outcome: "rejected", errorCode: "CONFLICTING_OPERATION" };
  }
}

/**
 * THE authoritative admin lifecycle-mutation executor. Never throws for the
 * expected rejection/failure cases (they come back as typed results); an
 * unexpected internal error is caught and mapped to a safe rejection.
 */
export async function executeAdminServiceOperation(
  input: ExecuteAdminServiceOperationInput,
): Promise<ExecuteAdminServiceOperationResult> {
  const notifyUser = input.notifyUser ?? true;

  // 0. Validate the mandatory reason + the requested value BEFORE any work.
  if (!isValidAdminServiceReason(input.reason)) {
    return { outcome: "rejected", errorCode: "VALIDATION" };
  }
  const requestedCount = input.requestedCount ?? null;
  if (input.type === "ADD_VOLUME") {
    if (requestedCount === null || parseAdminVolumeGib(String(requestedCount)) === null) {
      return { outcome: "rejected", errorCode: "VALUE_OUT_OF_RANGE" };
    }
  } else if (input.type === "ADD_TIME") {
    if (requestedCount === null || parseAdminTimeDays(String(requestedCount)) === null) {
      return { outcome: "rejected", errorCode: "VALUE_OUT_OF_RANGE" };
    }
  }

  // 1. Revalidate OWNER against the LIVE admin row (role may have changed).
  const admin = await prisma.admin.findUnique({ where: { id: input.adminId } });
  if (admin === null || !admin.isActive || admin.role !== AdminRole.OWNER) {
    return { outcome: "rejected", errorCode: "NOT_OWNER" };
  }

  // 2. Recheck the mutation master switch (a stale/direct callback fails closed).
  if (!(await areAdminServiceMutationsEnabled())) {
    return { outcome: "rejected", errorCode: "MUTATIONS_DISABLED" };
  }

  // 3. Idempotency fast-path (before taking the lock): same confirm converges.
  const idempotencyKey = deriveAdminOperationIdempotencyKey(
    input.adminId,
    input.serviceId,
    input.type,
    requestedCount,
    input.nonce,
  );
  const existingByKey = await prisma.adminServiceOperation.findUnique({
    where: { idempotencyKey },
  });
  if (existingByKey !== null) {
    return resultFromExisting(existingByKey);
  }
  if (input.sourceUpdateId !== undefined && input.sourceUpdateId !== null) {
    const replay = await prisma.adminServiceOperation.findUnique({
      where: { sourceUpdateId: input.sourceUpdateId },
    });
    if (replay !== null) {
      return resultFromExisting(replay);
    }
  }

  // 4. Per-Service lock — the whole mutation sequence is serialized; Redis
  //    unavailable FAILS CLOSED (no Panel call, no row).
  const acquisition = await acquireServiceLock(
    serviceOperationLockKey(input.serviceId),
    SERVICE_LOCK_WAIT_MS,
  );
  if (!acquisition.ok) {
    return {
      outcome: "rejected",
      errorCode: acquisition.reason === "contended" ? "LOCK_BUSY" : "LOCK_UNAVAILABLE",
    };
  }

  try {
    // 5. Reload Service + Panel + owner UNDER the lock (authoritative state).
    const found = await prisma.service.findFirst({
      where: { id: input.serviceId, deletedAt: null, status: { not: ServiceStatus.DELETED } },
      include: { panel: true },
    });
    if (found === null) {
      return { outcome: "rejected", errorCode: "SERVICE_NOT_FOUND" };
    }
    const { panel, ...service } = found;

    // 6. Remote-model gate: legacy per-inbound XUI services are never mutated
    //    through the global-client endpoints and never silently migrated.
    if (!serviceSupportsGlobalLifecycle(service)) {
      return { outcome: "rejected", errorCode: "XUI_LEGACY_UNSUPPORTED" };
    }
    // 7. Panel must be ACTIVE.
    if (panel.status !== PanelStatus.ACTIVE) {
      return { outcome: "rejected", errorCode: "PANEL_INACTIVE" };
    }
    // 8. Capability gate. Volume grants preserve used via the addServiceTime
    //    mechanism (see applyAdminVolumeGrant), so they require BOTH the
    //    declared addVolume capability and the addTime mechanism; every panel
    //    in this codebase that implements one implements the other.
    if (!adminMutationCapabilityAvailable(input.type, panel)) {
      return { outcome: "rejected", errorCode: "CAPABILITY_UNSUPPORTED" };
    }
    // 9. DB-level status eligibility.
    if (!ELIGIBLE_STATUS[input.type].includes(service.status)) {
      return { outcome: "rejected", errorCode: "INELIGIBLE_STATUS" };
    }
    if (input.type === "ENABLE" && isServiceExpired(service)) {
      // Enabling an expired service would fake activity — it must renew/extend.
      return { outcome: "rejected", errorCode: "INELIGIBLE_STATUS" };
    }
    if (input.type === "ADD_VOLUME" && service.volumeBytes <= 0n) {
      return { outcome: "rejected", errorCode: "UNLIMITED_BLOCKED" };
    }
    if (input.type === "ADD_TIME" && service.expiresAt === null) {
      return { outcome: "rejected", errorCode: "NEVER_EXPIRING_BLOCKED" };
    }

    // 10. Conflicting-operation guard (§8, §11): an unresolved PENDING /
    //     UNCERTAIN / RECONCILIATION_REQUIRED op on this Service blocks a new
    //     mutation (checked under the lock so it is race-safe).
    const conflicting = await prisma.adminServiceOperation.count({
      where: {
        serviceId: service.id,
        status: { in: ADMIN_SERVICE_BLOCKING_STATUSES as unknown as string[] },
      },
    });
    if (conflicting > 0) {
      return { outcome: "rejected", errorCode: "CONFLICTING_OPERATION" };
    }

    // 11. Stale-preview guard: the confirmation carries the fingerprint of the
    //     snapshot the admin saw; if the decision-relevant state changed since,
    //     fail closed and make the admin re-preview.
    const beforeSnapshot = buildAdminServiceSnapshot(service, panel);
    if (adminServiceSnapshotFingerprint(beforeSnapshot) !== input.expectedFingerprint) {
      return { outcome: "rejected", errorCode: "STALE_PREVIEW" };
    }

    // 12. PENDING claim — the durable audit/reconciliation row. The unique
    //     idempotencyKey converges a concurrent double-execution (P2002).
    let operation: AdminServiceOperation;
    try {
      operation = await prisma.adminServiceOperation.create({
        data: {
          serviceId: service.id,
          targetUserId: service.userId,
          adminId: input.adminId,
          type: input.type,
          status: "PENDING",
          reason: input.reason.trim(),
          requestedValue: requestedCount === null ? null : BigInt(requestedCount),
          requestedUnit: requestedUnitFor(input.type),
          notifyUser,
          idempotencyKey,
          sourceUpdateId: input.sourceUpdateId ?? null,
          confirmationNonceHash: hashNonce(input.nonce),
          beforeSnapshot: beforeSnapshot as unknown as Prisma.InputJsonObject,
          startedAt: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const raced = await prisma.adminServiceOperation.findUnique({ where: { idempotencyKey } });
        if (raced !== null) {
          return resultFromExisting(raced);
        }
      }
      throw err;
    }

    // 13. The ONE remote mutation + local persist (applier-owned), then classify.
    const applied = await runApplier(
      input.type,
      service,
      panel,
      operation.id,
      input.adminId,
      requestedCount,
      acquisition.lock,
    );

    // 14. Persist the operation status from the classification.
    const completedAt = new Date();
    if (applied.kind === "success") {
      await prisma.adminServiceOperation.update({
        where: { id: operation.id },
        data: {
          status: "SUCCEEDED",
          completedAt,
          afterSnapshot: applied.confirmedAfter as unknown as Prisma.InputJsonObject,
          safeErrorCode: null,
        },
      });
      await safeLog(operation, "SUCCEEDED", panel.type, null);
      return {
        outcome: "succeeded",
        operationId: operation.id,
        changed: applied.changed,
        ownerUserId: service.userId,
        notifyUser: notifyUser && applied.changed,
        afterSnapshot: applied.confirmedAfter,
      };
    }
    if (applied.kind === "uncertain") {
      await prisma.adminServiceOperation.update({
        where: { id: operation.id },
        data: {
          status: applied.status,
          completedAt,
          afterSnapshot:
            applied.projectedAfter === null
              ? undefined
              : (applied.projectedAfter as unknown as Prisma.InputJsonObject),
          safeErrorCode: applied.errorCode,
        },
      });
      await safeLog(operation, applied.status, panel.type, applied.errorCode);
      return {
        outcome: "uncertain",
        operationId: operation.id,
        status: applied.status,
        errorCode: applied.errorCode,
      };
    }
    await prisma.adminServiceOperation.update({
      where: { id: operation.id },
      data: { status: "FAILED", completedAt, safeErrorCode: applied.errorCode },
    });
    await safeLog(operation, "FAILED", panel.type, applied.errorCode);
    return { outcome: "failed", operationId: operation.id, errorCode: applied.errorCode };
  } catch (err) {
    logger.error("admin service operation executor crashed", {
      serviceId: input.serviceId,
      type: input.type,
      error: errorMessage(err),
    });
    return { outcome: "rejected", errorCode: "VALIDATION" };
  } finally {
    await acquisition.lock.release();
  }
}

/** Whether the Panel's adapter supports the mechanism this mutation uses. */
function adminMutationCapabilityAvailable(type: AdminServiceMutationType, panel: Panel): boolean {
  switch (type) {
    case "ENABLE":
    case "DISABLE":
      return panelOperationAvailable(panel, "toggleService");
    case "REGENERATE_LINK":
      return panelOperationAvailable(panel, "regenerateSubscription");
    case "ADD_TIME":
      return panelOperationAvailable(panel, "addTime");
    case "ADD_VOLUME":
      // Preserve-used quota set uses the addTime mechanism; the addVolume
      // capability is the declared one for the button.
      return (
        panelOperationAvailable(panel, "addVolume") && panelOperationAvailable(panel, "addTime")
      );
  }
}

function isServiceExpired(service: Pick<Service, "expiresAt">, now: Date = new Date()): boolean {
  return service.expiresAt !== null && service.expiresAt.getTime() <= now.getTime();
}

async function safeLog(
  operation: AdminServiceOperation,
  status: AdminServiceOperationStatus,
  panelType: string | null,
  errorCode: AdminServiceErrorCode | null,
): Promise<void> {
  await logAdminServiceOperation({
    operationId: operation.id,
    type: operation.type as AdminServiceOperationType,
    status,
    serviceId: operation.serviceId,
    adminId: operation.adminId ?? "unknown",
    panelType,
    requestedUnit: operation.requestedUnit as AdminServiceRequestedUnit | null,
    requestedValue: operation.requestedValue,
    safeErrorCode: errorCode,
  });
}

// -----------------------------------------------------------------------------
// Appliers — the ONE remote mutation + local persist per operation type
// -----------------------------------------------------------------------------

/**
 * Verify-after-write for a FAILED grant mutation (§11). Some adapters (Marzban's
 * addServiceTime / renew) do NOT flag an ambiguous modify-timeout as `uncertain`,
 * so a definite-looking failure may actually have landed. A possibly/actually
 * applied grant must NEVER be classified FAILED (which would invite a retry and
 * double-grant); it becomes RECONCILIATION_REQUIRED (the reconciler confirms and
 * syncs local). Only a fresh read that POSITIVELY shows the pre-state is a
 * definite FAILURE. `applied(read)` is the per-operation "did the target land?"
 * predicate.
 */
async function verifyGrantFailure(
  service: Service,
  panel: Panel,
  projectedAfter: AdminServiceStateSnapshot,
  applied: (read: GetServiceAccountResult) => "applied" | "not-applied" | "inconclusive",
): Promise<ApplierResult> {
  const adapter = buildAdapterForPanel(panel);
  let read: GetServiceAccountResult;
  try {
    read = await adapter.getServiceAccount({
      username: service.username,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch {
    return { kind: "uncertain", status: "UNCERTAIN", projectedAfter, errorCode: "PANEL_UNCERTAIN" };
  }
  if (!read.ok) {
    return { kind: "uncertain", status: "UNCERTAIN", projectedAfter, errorCode: "PANEL_UNCERTAIN" };
  }
  const verdict = applied(read);
  if (verdict === "not-applied") {
    return { kind: "failed", errorCode: "PANEL_REJECTED" };
  }
  if (verdict === "applied") {
    // The change LANDED despite the error — never re-issue it; the read-only
    // reconciler will confirm and sync the local row.
    return {
      kind: "uncertain",
      status: "RECONCILIATION_REQUIRED",
      projectedAfter,
      errorCode: "INCONSISTENT_REMOTE_STATE",
    };
  }
  return { kind: "uncertain", status: "UNCERTAIN", projectedAfter, errorCode: "PANEL_UNCERTAIN" };
}

async function runApplier(
  type: AdminServiceMutationType,
  service: Service,
  panel: Panel,
  operationId: string,
  adminId: string,
  requestedCount: number | null,
  lock: ServiceLock,
): Promise<ApplierResult> {
  switch (type) {
    case "ENABLE":
    case "DISABLE":
      // The toggle's persist is a status-guarded updateMany (filtered on the
      // allowed previous statuses), so a concurrent status change can never be
      // stale-overwritten — no lock-loss abort is needed here.
      return applyAdminToggle(service, panel, type, operationId, adminId);
    case "REGENERATE_LINK":
      return applyAdminRegen(service, panel, operationId, adminId);
    case "ADD_VOLUME":
      return applyAdminVolumeGrant(service, panel, operationId, requestedCount ?? 0, lock);
    case "ADD_TIME":
      return applyAdminTimeGrant(service, panel, operationId, requestedCount ?? 0, lock);
  }
}

/** Shared lock-loss abort (§ concurrency): if the heartbeat found a foreign
 * token during a long panel op, persisting our quota/expiry could overwrite a
 * newer operation's state. Leave the op for reconciliation instead of writing. */
function lockLostResult(projectedAfter: AdminServiceStateSnapshot): ApplierResult {
  return {
    kind: "uncertain",
    status: "RECONCILIATION_REQUIRED",
    projectedAfter,
    errorCode: "INCONSISTENT_REMOTE_STATE",
  };
}

/** ENABLE/DISABLE reuse the actor-aware unlocked toggle primitive (§12). */
async function applyAdminToggle(
  service: Service,
  panel: Panel,
  action: ToggleAction,
  operationId: string,
  adminId: string,
): Promise<ApplierResult> {
  const outcome = await toggleServiceStatusUnlocked(service.userId, service.id, action, {
    actor: { kind: "ADMIN", adminId, operationId },
  });
  if (outcome.ok) {
    return {
      kind: "success",
      changed: !outcome.alreadyDone,
      confirmedAfter: buildAdminServiceSnapshot(outcome.service, panel),
    };
  }
  if (outcome.uncertain === true) {
    return {
      kind: "uncertain",
      status: "UNCERTAIN",
      projectedAfter: null,
      errorCode: "PANEL_UNCERTAIN",
    };
  }
  return { kind: "failed", errorCode: "PANEL_REJECTED" };
}

/** REGENERATE_LINK reuses the actor-aware unlocked regeneration primitive; the
 * new link is NEVER exposed to or stored on the admin surface (§17, §21). */
async function applyAdminRegen(
  service: Service,
  panel: Panel,
  operationId: string,
  adminId: string,
): Promise<ApplierResult> {
  const outcome = await regenerateServiceSubscriptionUnlocked(service.userId, service.id, {
    actor: { kind: "ADMIN", adminId, operationId },
  });
  if (outcome.ok) {
    return {
      kind: "success",
      changed: true,
      confirmedAfter: buildAdminServiceSnapshot(outcome.service, panel),
    };
  }
  if (outcome.uncertain === true) {
    // A regeneration either happened or not and cannot be verified by a
    // read-only reconcile; route to manual review (safe to re-run — idempotent).
    return {
      kind: "uncertain",
      status: "RECONCILIATION_REQUIRED",
      projectedAfter: null,
      errorCode: "PANEL_UNCERTAIN",
    };
  }
  return { kind: "failed", errorCode: "PANEL_REJECTED" };
}

/**
 * Complimentary volume grant (§14): a FRESH Panel read establishes the
 * authoritative current total (block unlimited/unknown), then ONE absolute-set
 * increases total+remaining equally while PRESERVING used and NEVER resetting
 * traffic. The reset-free mechanism is addServiceTime (addServiceVolume zeroes
 * usage on both adapters), passing the CURRENT expiry through unchanged (the
 * panel's `0 = no expiry` convention preserves a never-expiring service). No
 * Order/CheckoutSession/Payment/Wallet row is ever touched; the audit event is
 * a distinct admin type that no revenue counter reads (§6).
 */
async function applyAdminVolumeGrant(
  service: Service,
  panel: Panel,
  operationId: string,
  grantGib: number,
  lock: ServiceLock,
): Promise<ApplierResult> {
  const adapter = buildAdapterForPanel(panel);
  const subscriptionBaseUrl = normalizeSubscriptionBase(panel);

  // Fresh read before the absolute-set (§14).
  let read: GetServiceAccountResult;
  try {
    read = await adapter.getServiceAccount({ username: service.username, subscriptionBaseUrl });
  } catch (err) {
    read = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!read.ok) {
    // Could not establish the current quota → NO mutation attempted → definite
    // failure (panel state untouched).
    return { kind: "failed", errorCode: "PANEL_REJECTED" };
  }
  if (read.totalBytes === undefined) {
    return { kind: "failed", errorCode: "UNKNOWN_QUOTA" };
  }
  if (read.totalBytes === null || read.totalBytes <= 0n) {
    return { kind: "failed", errorCode: "UNLIMITED_BLOCKED" };
  }

  let grantBytes: bigint;
  try {
    grantBytes = adminVolumeGibToBytes(grantGib);
  } catch {
    return { kind: "failed", errorCode: "VALUE_OUT_OF_RANGE" };
  }
  const currentTotal = read.totalBytes;
  const newTotal = currentTotal + grantBytes;
  if (newTotal > ADMIN_SERVICE_MAX_TOTAL_BYTES) {
    return { kind: "failed", errorCode: "OVERFLOW" };
  }
  const currentUsed = read.usedBytes ?? service.usedBytes;
  const currentExpiry = read.expiresAt !== undefined ? read.expiresAt : service.expiresAt;
  // 0 = no expiry on both panels, so a never-expiring service stays so.
  const expiryForSet = currentExpiry ?? new Date(0);

  const projectedRemaining = newTotal - currentUsed > 0n ? newTotal - currentUsed : 0n;
  const projectedAfter: AdminServiceStateSnapshot = {
    status: service.status,
    panelStatus: panel.status,
    panelType: panel.type,
    volumeBytes: newTotal.toString(),
    usedBytes: currentUsed.toString(),
    remainingBytes: projectedRemaining.toString(),
    expiresAt: currentExpiry === null ? null : currentExpiry.toISOString(),
    lastSubscriptionUpdateAt: null,
  };

  // The ONE remote mutation — absolute-set of the new total, expiry unchanged,
  // traffic PRESERVED (addServiceTime never resets usage).
  let res: AddServiceTimeResult;
  try {
    res = await adapter.addServiceTime({
      username: service.username,
      totalBytes: newTotal,
      expiresAt: expiryForSet,
      subscriptionBaseUrl,
    });
  } catch (err) {
    res = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!res.ok && res.uncertain === true) {
    return {
      kind: "uncertain",
      status: "UNCERTAIN",
      projectedAfter,
      errorCode: "PANEL_UNCERTAIN",
    };
  }
  if (!res.ok) {
    // Verify-after-write (§11): a possibly-applied grant must never be FAILED.
    return verifyGrantFailure(service, panel, projectedAfter, (read) => {
      if (read.totalBytes === undefined || read.totalBytes === null) {
        return "inconclusive";
      }
      if (read.totalBytes >= newTotal) {
        return "applied";
      }
      return read.totalBytes <= currentTotal ? "not-applied" : "inconclusive";
    });
  }

  // Lock-loss guard (P1): the panel DEFINITELY set the new total, but if the
  // per-service lock was lost during the call, persisting could overwrite a
  // newer operation's state. Defer to reconciliation instead of writing.
  if (lock.isLost()) {
    return lockLostResult(projectedAfter);
  }

  const now = new Date();
  const finalUsed = res.usedBytes ?? currentUsed;
  const finalRemaining =
    res.remainingBytes !== undefined && res.remainingBytes !== null
      ? res.remainingBytes
      : newTotal - finalUsed > 0n
        ? newTotal - finalUsed
        : 0n;
  // DISABLED services are ineligible for volume grants, so the panel's
  // status "active" (set by addServiceTime) matches: exhausted → LIMITED.
  const nextStatus = finalRemaining <= 0n ? ServiceStatus.LIMITED : ServiceStatus.ACTIVE;

  const persist = (): Promise<void> =>
    prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateManyMutationInput = {
        volumeBytes: newTotal,
        usedBytes: finalUsed,
        remainingBytes: finalRemaining,
        status: nextStatus,
        lastSubscriptionUpdateAt: now,
      };
      // Expiry is deliberately NOT written — a volume grant never changes time.
      const updated = await tx.service.updateMany({
        where: { id: service.id, deletedAt: null },
        data,
      });
      if (updated.count !== 1) {
        throw new Error("service row vanished during admin volume grant");
      }
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: service.userId,
          panelId: panel.id,
          eventType: EXTRA_VOLUME_GRANTED_BY_ADMIN_EVENT_TYPE,
          // NO orderId — an admin grant is never a paid order (§6). Amounts are
          // safe non-secret evidence.
          metadata: {
            operationId,
            addedGib: grantGib,
            previousTotalBytes: currentTotal.toString(),
            newTotalBytes: newTotal.toString(),
          },
        },
      });
    });

  try {
    await persist();
  } catch (err) {
    logger.error("admin volume grant persistence failed after panel success", {
      serviceId: service.id,
      error: errorMessage(err),
    });
    try {
      await persist();
    } catch {
      // The Panel DEFINITELY set the new total but the local row did not —
      // reconciliation-required (never re-issue the Panel mutation).
      return {
        kind: "uncertain",
        status: "RECONCILIATION_REQUIRED",
        projectedAfter,
        errorCode: "INCONSISTENT_REMOTE_STATE",
      };
    }
  }

  return {
    kind: "success",
    changed: true,
    confirmedAfter: {
      status: nextStatus,
      panelStatus: panel.status,
      panelType: panel.type,
      volumeBytes: newTotal.toString(),
      usedBytes: finalUsed.toString(),
      remainingBytes: finalRemaining.toString(),
      expiresAt: currentExpiry === null ? null : currentExpiry.toISOString(),
      lastSubscriptionUpdateAt: now.toISOString(),
    },
  };
}

/**
 * Complimentary time grant (§16): reuses the pure calculateExtraTime calculator
 * (future = current expiry + days, past = now + days), then ONE absolute-set of
 * the new expiry via addServiceTime with quota unchanged and usage NEVER reset.
 * No financial row is touched; the audit event is a distinct admin type (§6).
 */
async function applyAdminTimeGrant(
  service: Service,
  panel: Panel,
  operationId: string,
  grantDays: number,
  lock: ServiceLock,
): Promise<ApplierResult> {
  const adapter = buildAdapterForPanel(panel);
  const subscriptionBaseUrl = normalizeSubscriptionBase(panel);

  // Fresh read to anchor the extension on the authoritative current expiry.
  let read: GetServiceAccountResult;
  try {
    read = await adapter.getServiceAccount({ username: service.username, subscriptionBaseUrl });
  } catch (err) {
    read = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!read.ok) {
    return { kind: "failed", errorCode: "PANEL_REJECTED" };
  }
  const currentExpiry = read.expiresAt !== undefined ? read.expiresAt : service.expiresAt;
  if (currentExpiry === undefined) {
    return { kind: "failed", errorCode: "UNKNOWN_EXPIRY" };
  }
  if (currentExpiry === null) {
    return { kind: "failed", errorCode: "NEVER_EXPIRING_BLOCKED" };
  }

  if (parseAdminTimeDays(String(grantDays)) === null) {
    return { kind: "failed", errorCode: "VALUE_OUT_OF_RANGE" };
  }
  const now = new Date();
  const newExpiry = calculateExtraTime({ expiresAt: currentExpiry }, grantDays, now);
  // Quota passed through unchanged (null = unlimited).
  const quotaForSet =
    read.totalBytes !== undefined
      ? read.totalBytes
      : service.volumeBytes > 0n
        ? service.volumeBytes
        : null;

  const projectedAfter: AdminServiceStateSnapshot = {
    status: service.status,
    panelStatus: panel.status,
    panelType: panel.type,
    volumeBytes: (quotaForSet ?? 0n).toString(),
    usedBytes: (read.usedBytes ?? service.usedBytes).toString(),
    remainingBytes: service.remainingBytes.toString(),
    expiresAt: newExpiry.toISOString(),
    lastSubscriptionUpdateAt: null,
  };

  let res: AddServiceTimeResult;
  try {
    res = await adapter.addServiceTime({
      username: service.username,
      totalBytes: quotaForSet,
      expiresAt: newExpiry,
      subscriptionBaseUrl,
    });
  } catch (err) {
    res = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!res.ok && res.uncertain === true) {
    return {
      kind: "uncertain",
      status: "UNCERTAIN",
      projectedAfter,
      errorCode: "PANEL_UNCERTAIN",
    };
  }
  if (!res.ok) {
    // Verify-after-write (§11): a possibly-applied extension must never be FAILED.
    const targetMs = newExpiry.getTime();
    const currentMs = currentExpiry.getTime();
    return verifyGrantFailure(service, panel, projectedAfter, (read) => {
      if (read.expiresAt === undefined || read.expiresAt === null) {
        return "inconclusive";
      }
      const seen = read.expiresAt.getTime();
      if (seen >= targetMs - 60_000) {
        return "applied";
      }
      return Math.abs(seen - currentMs) <= 60_000 ? "not-applied" : "inconclusive";
    });
  }

  // Lock-loss guard (P1): the panel DEFINITELY set the new expiry — defer to
  // reconciliation rather than overwrite a newer operation's state.
  if (lock.isLost()) {
    return lockLostResult(projectedAfter);
  }

  const finalExpiry =
    res.expiresAt !== undefined && res.expiresAt !== null ? res.expiresAt : newExpiry;
  // Persist the LIVE usage/remaining from the fresh read + mutation result (P2)
  // rather than deriving status from a possibly-stale stored value. quotaForSet
  // is the unchanged current quota (null = unlimited → 0n convention).
  const finalTotal = quotaForSet ?? 0n;
  const finalUsed = res.usedBytes ?? read.usedBytes ?? service.usedBytes;
  const finalRemaining =
    res.remainingBytes !== undefined && res.remainingBytes !== null
      ? res.remainingBytes
      : read.remainingBytes !== undefined && read.remainingBytes !== null
        ? read.remainingBytes
        : finalTotal > 0n
          ? finalTotal - finalUsed > 0n
            ? finalTotal - finalUsed
            : 0n
          : service.remainingBytes;
  // DISABLED services are ineligible for time grants; extending time revives an
  // EXPIRED service. Exhausted finite traffic stays LIMITED (time never resets
  // usage), otherwise ACTIVE — derived from the LIVE remaining.
  const nextStatus =
    finalTotal > 0n && finalRemaining <= 0n ? ServiceStatus.LIMITED : ServiceStatus.ACTIVE;

  const persist = (): Promise<void> =>
    prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateManyMutationInput = {
        expiresAt: finalExpiry,
        status: nextStatus,
        usedBytes: finalUsed,
        remainingBytes: finalRemaining,
        lastSubscriptionUpdateAt: now,
      };
      const updated = await tx.service.updateMany({
        where: { id: service.id, deletedAt: null },
        data,
      });
      if (updated.count !== 1) {
        throw new Error("service row vanished during admin time grant");
      }
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: service.userId,
          panelId: panel.id,
          eventType: EXTRA_TIME_GRANTED_BY_ADMIN_EVENT_TYPE,
          metadata: {
            operationId,
            addedDays: grantDays,
            previousExpiresAt: currentExpiry.toISOString(),
            newExpiresAt: finalExpiry.toISOString(),
          },
        },
      });
    });

  try {
    await persist();
  } catch (err) {
    logger.error("admin time grant persistence failed after panel success", {
      serviceId: service.id,
      error: errorMessage(err),
    });
    try {
      await persist();
    } catch {
      return {
        kind: "uncertain",
        status: "RECONCILIATION_REQUIRED",
        projectedAfter,
        errorCode: "INCONSISTENT_REMOTE_STATE",
      };
    }
  }

  return {
    kind: "success",
    changed: true,
    confirmedAfter: {
      status: nextStatus,
      panelStatus: panel.status,
      panelType: panel.type,
      volumeBytes: finalTotal.toString(),
      usedBytes: finalUsed.toString(),
      remainingBytes: finalRemaining.toString(),
      expiresAt: finalExpiry.toISOString(),
      lastSubscriptionUpdateAt: now.toISOString(),
    },
  };
}

// -----------------------------------------------------------------------------
// §17 — internal notes (no Panel call, no lock, no master switch)
// -----------------------------------------------------------------------------

export type AddAdminServiceNoteResult =
  | { ok: true; operationId: string }
  | { ok: false; errorCode: AdminServiceErrorCode };

/**
 * Records ONE immutable internal note against a Service (§17). No Panel call,
 * no per-Service lock and NO mutation master switch — any authorized admin may
 * add a note. The body is length-validated and stored verbatim in the operation
 * `reason` column (rendered HTML-escaped at display time, never logged — §21).
 * Idempotent on the confirmation nonce.
 */
export async function addAdminServiceNote(input: {
  serviceId: string;
  adminId: string;
  note: string;
  nonce: string;
  sourceUpdateId?: bigint | null;
}): Promise<AddAdminServiceNoteResult> {
  if (!isValidAdminServiceNote(input.note)) {
    return { ok: false, errorCode: "VALIDATION" };
  }
  const found = await prisma.service.findFirst({
    where: { id: input.serviceId, deletedAt: null, status: { not: ServiceStatus.DELETED } },
    include: { panel: true },
  });
  if (found === null) {
    return { ok: false, errorCode: "SERVICE_NOT_FOUND" };
  }
  const { panel, ...service } = found;
  const idempotencyKey = deriveAdminOperationIdempotencyKey(
    input.adminId,
    input.serviceId,
    "ADD_NOTE",
    null,
    input.nonce,
  );
  const now = new Date();
  const snapshot = buildAdminServiceSnapshot(service, panel);
  try {
    const op = await prisma.adminServiceOperation.create({
      data: {
        serviceId: service.id,
        targetUserId: service.userId,
        adminId: input.adminId,
        type: "ADD_NOTE",
        status: "SUCCEEDED",
        reason: input.note.trim(),
        requestedValue: null,
        requestedUnit: null,
        // Notes are internal — the customer is never notified.
        notifyUser: false,
        idempotencyKey,
        sourceUpdateId: input.sourceUpdateId ?? null,
        confirmationNonceHash: hashNonce(input.nonce),
        beforeSnapshot: snapshot as unknown as Prisma.InputJsonObject,
        afterSnapshot: snapshot as unknown as Prisma.InputJsonObject,
        startedAt: now,
        completedAt: now,
      },
    });
    // Correlated audit event — carries only the operation id, never the body.
    await prisma.serviceEventLog.create({
      data: {
        serviceId: service.id,
        userId: service.userId,
        panelId: panel.id,
        eventType: ADMIN_SERVICE_NOTE_EVENT_TYPE,
        metadata: { operationId: op.id },
      },
    });
    await logAdminServiceOperation({
      operationId: op.id,
      type: "ADD_NOTE",
      status: "SUCCEEDED",
      serviceId: service.id,
      adminId: input.adminId,
      panelType: panel.type,
      requestedUnit: null,
      requestedValue: null,
      safeErrorCode: null,
    });
    return { ok: true, operationId: op.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.adminServiceOperation.findUnique({ where: { idempotencyKey } });
      if (raced !== null) {
        return { ok: true, operationId: raced.id };
      }
    }
    logger.error("admin service note failed", {
      serviceId: input.serviceId,
      error: errorMessage(err),
    });
    return { ok: false, errorCode: "VALIDATION" };
  }
}

// -----------------------------------------------------------------------------
// §19 — user notification bookkeeping (the handler sends the actual message)
// -----------------------------------------------------------------------------

/**
 * CAS-marks the operation as user-notified. Returns true only for the caller
 * that transitioned userNotifiedAt from null → now, so the customer is notified
 * AT MOST ONCE even under a double delivery.
 */
export async function markAdminOperationUserNotified(operationId: string): Promise<boolean> {
  const res = await prisma.adminServiceOperation.updateMany({
    where: { id: operationId, userNotifiedAt: null },
    data: { userNotifiedAt: new Date() },
  });
  return res.count === 1;
}

// -----------------------------------------------------------------------------
// §18 — read-only reconciliation
// -----------------------------------------------------------------------------

export type AdminReconcileOutcome =
  | { kind: "reconciled"; operationId: string; newStatus: "RECONCILED" | "FAILED" }
  | { kind: "still-uncertain" }
  | { kind: "not-reconcilable" }
  | { kind: "not-found" };

/** Tolerance for expiry comparison (panels round to the second/day). */
const RECONCILE_TIME_TOLERANCE_MS = 60_000;

function safeBigInt(value: string | null): bigint | null {
  if (value === null) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Read-only reconciliation of ONE UNCERTAIN / RECONCILIATION_REQUIRED operation
 * (§18): performs a single fresh Panel read (which also syncs the local row from
 * Panel truth), classifies the operation against its stored projected/confirmed
 * target and, ONLY with positive evidence, marks it RECONCILED or FAILED. It
 * NEVER repeats the remote mutation and NEVER writes anything the read did not
 * establish; an inconclusive read leaves the operation untouched for a later
 * attempt. A regeneration cannot be verified by a read and always stays for
 * manual review.
 */
export async function reconcileAdminServiceOperation(
  operationId: string,
  reconciledByAdminId: string,
): Promise<AdminReconcileOutcome> {
  const op = await prisma.adminServiceOperation.findUnique({ where: { id: operationId } });
  if (op === null) {
    return { kind: "not-found" };
  }
  if (!(ADMIN_SERVICE_RECONCILE_STATUSES as readonly string[]).includes(op.status)) {
    return { kind: "not-reconcilable" };
  }
  if (op.serviceId === null || op.targetUserId === null) {
    return { kind: "not-reconcilable" };
  }
  const svc = await prisma.service.findUnique({
    where: { id: op.serviceId },
    include: { panel: true },
  });
  if (svc === null) {
    return { kind: "not-reconcilable" };
  }
  // ONE fresh read (persist: true syncs the local row from Panel truth).
  const read = await refreshAdminServiceReadOnly(op.serviceId, op.targetUserId);
  if (read.kind !== "refreshed") {
    // No clean read → leave the operation as-is for another attempt.
    return { kind: "still-uncertain" };
  }
  const verdict = classifyReconciliation(op, read.service);
  if (verdict === "inconclusive") {
    return { kind: "still-uncertain" };
  }
  const newStatus: "RECONCILED" | "FAILED" = verdict === "applied" ? "RECONCILED" : "FAILED";
  const afterSnapshot = buildAdminServiceSnapshot(read.service, svc.panel);
  const updated = await prisma.adminServiceOperation.updateMany({
    where: { id: op.id, status: op.status },
    data: {
      status: newStatus,
      reconciledAt: new Date(),
      reconciledByAdminId,
      afterSnapshot: afterSnapshot as unknown as Prisma.InputJsonObject,
    },
  });
  if (updated.count !== 1) {
    // A concurrent reconciliation/state change won — nothing more to do.
    return { kind: "still-uncertain" };
  }
  await safeLog(
    op,
    newStatus,
    svc.panel.type,
    newStatus === "FAILED"
      ? ((op.safeErrorCode as AdminServiceErrorCode | null) ?? "INCONSISTENT_REMOTE_STATE")
      : null,
  );
  return { kind: "reconciled", operationId: op.id, newStatus };
}

export type AdminReviewOutcome =
  | { kind: "resolved" }
  | { kind: "not-found" }
  | { kind: "not-reconcilable" };

/**
 * OWNER-controlled terminal resolution (§18) for a blocking operation an
 * automatic reconcile cannot classify — notably an uncertain REGENERATE_LINK,
 * whose link change is not read-verifiable. The OWNER, having reviewed it (e.g.
 * confirmed with the user or safely re-run the idempotent regeneration), marks
 * it RECONCILED so the service is no longer blocked from later mutations. This
 * never touches the panel and writes no service state.
 */
export async function markAdminServiceOperationReviewed(
  operationId: string,
  reviewedByAdminId: string,
): Promise<AdminReviewOutcome> {
  const op = await prisma.adminServiceOperation.findUnique({ where: { id: operationId } });
  if (op === null) {
    return { kind: "not-found" };
  }
  if (!(ADMIN_SERVICE_RECONCILE_STATUSES as readonly string[]).includes(op.status)) {
    return { kind: "not-reconcilable" };
  }
  const updated = await prisma.adminServiceOperation.updateMany({
    where: { id: op.id, status: op.status },
    data: { status: "RECONCILED", reconciledAt: new Date(), reconciledByAdminId: reviewedByAdminId },
  });
  if (updated.count !== 1) {
    return { kind: "not-reconcilable" };
  }
  await safeLog(op, "RECONCILED", null, null);
  return { kind: "resolved" };
}

function classifyReconciliation(
  op: AdminServiceOperation,
  fresh: Service,
): "applied" | "not-applied" | "inconclusive" {
  const target = parseSnapshot(op.afterSnapshot);
  switch (op.type) {
    case "ENABLE":
      if (fresh.status === ServiceStatus.ACTIVE || fresh.status === ServiceStatus.LIMITED) {
        return "applied";
      }
      return fresh.status === ServiceStatus.DISABLED ? "not-applied" : "inconclusive";
    case "DISABLE":
      if (fresh.status === ServiceStatus.DISABLED) {
        return "applied";
      }
      return fresh.status === ServiceStatus.ACTIVE || fresh.status === ServiceStatus.LIMITED
        ? "not-applied"
        : "inconclusive";
    case "ADD_VOLUME": {
      const targetTotal = target === null ? null : safeBigInt(target.volumeBytes);
      if (targetTotal === null) {
        return "inconclusive";
      }
      if (fresh.volumeBytes >= targetTotal) {
        return "applied";
      }
      const beforeTotal = safeBigInt(parseSnapshot(op.beforeSnapshot)?.volumeBytes ?? null);
      if (beforeTotal !== null && fresh.volumeBytes <= beforeTotal) {
        return "not-applied";
      }
      return "inconclusive";
    }
    case "ADD_TIME": {
      const targetMs = target?.expiresAt === undefined || target?.expiresAt === null
        ? NaN
        : Date.parse(target.expiresAt);
      if (Number.isNaN(targetMs) || fresh.expiresAt === null) {
        return "inconclusive";
      }
      if (fresh.expiresAt.getTime() >= targetMs - RECONCILE_TIME_TOLERANCE_MS) {
        return "applied";
      }
      const beforeExpiry = parseSnapshot(op.beforeSnapshot)?.expiresAt ?? null;
      const beforeMs = beforeExpiry === null ? NaN : Date.parse(beforeExpiry);
      if (
        !Number.isNaN(beforeMs) &&
        Math.abs(fresh.expiresAt.getTime() - beforeMs) <= RECONCILE_TIME_TOLERANCE_MS
      ) {
        return "not-applied";
      }
      return "inconclusive";
    }
    default:
      // REGENERATE_LINK (and any unknown type) — a link change cannot be
      // verified by a read; always leave it for manual review.
      return "inconclusive";
  }
}

// -----------------------------------------------------------------------------
// Read helpers for the detail / history / reconciliation views (§8, §18, §19)
// -----------------------------------------------------------------------------

/** Count of unresolved (blocking) operations on a Service — the detail page's
 * "operations awaiting review" badge and the conflicting-op guard source. */
export function countUnresolvedAdminOperations(serviceId: string): Promise<number> {
  return prisma.adminServiceOperation.count({
    where: { serviceId, status: { in: [...ADMIN_SERVICE_BLOCKING_STATUSES] } },
  });
}

/** The latest N operations for a Service (detail page shows the most recent 3). */
export function latestAdminServiceOperations(
  serviceId: string,
  limit = 3,
): Promise<AdminServiceOperation[]> {
  return prisma.adminServiceOperation.findMany({
    where: { serviceId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** The most recent internal note for a Service (detail page shows the latest). */
export function latestAdminServiceNote(serviceId: string): Promise<AdminServiceOperation | null> {
  return prisma.adminServiceOperation.findFirst({
    where: { serviceId, type: "ADD_NOTE" },
    orderBy: { createdAt: "desc" },
  });
}

export function getAdminServiceOperationById(id: string): Promise<AdminServiceOperation | null> {
  return prisma.adminServiceOperation.findUnique({ where: { id } });
}

/** Resolve an operation by its 8-char short id (take-2 ambiguity safety). */
export async function getAdminServiceOperationByShortId(
  shortId: string,
): Promise<AdminServiceOperation | null> {
  if (!/^[0-9a-f-]{4,36}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.adminServiceOperation.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export interface AdminOperationPage {
  operations: AdminServiceOperation[];
  page: number;
  pages: number;
  total: number;
}

/** Paginated operation history for one Service (§19). */
export async function listAdminServiceOperations(
  serviceId: string,
  page: number,
  pageSize = 5,
): Promise<AdminOperationPage> {
  const total = await prisma.adminServiceOperation.count({ where: { serviceId } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const operations = await prisma.adminServiceOperation.findMany({
    where: { serviceId },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * pageSize,
    take: pageSize,
  });
  return { operations, page: safePage, pages, total };
}

/** Count of operations awaiting reconciliation across ALL services (dashboard). */
export function countReconciliationOperations(): Promise<number> {
  return prisma.adminServiceOperation.count({
    where: { status: { in: [...ADMIN_SERVICE_RECONCILE_STATUSES] } },
  });
}

/** Paginated reconciliation dashboard: UNCERTAIN / RECONCILIATION_REQUIRED
 * operations across all services, oldest first (§18). */
export async function listReconciliationOperations(
  page: number,
  pageSize = 5,
): Promise<AdminOperationPage> {
  const where = { status: { in: [...ADMIN_SERVICE_RECONCILE_STATUSES] } };
  const total = await prisma.adminServiceOperation.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const operations = await prisma.adminServiceOperation.findMany({
    where,
    orderBy: { createdAt: "asc" },
    skip: (safePage - 1) * pageSize,
    take: pageSize,
  });
  return { operations, page: safePage, pages, total };
}

// -----------------------------------------------------------------------------
// Detail resolution + button eligibility (§7, §8)
// -----------------------------------------------------------------------------

export interface AdminServiceDetail {
  service: Service;
  panel: Panel;
  owner: User | null;
}

/**
 * Admin-scoped Service resolution by 8-char short id — take-2 ambiguity safety
 * (an ambiguous or unknown prefix resolves to null), excludes deleted, and
 * includes the Panel + owner so the detail page needs no second query (§7).
 */
export async function getAdminServiceDetail(shortId: string): Promise<AdminServiceDetail | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: { id: { startsWith: shortId }, deletedAt: null, status: { not: ServiceStatus.DELETED } },
    include: { panel: true, user: true },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  const { panel, user, ...service } = matches[0];
  return { service, panel, owner: user };
}

const ALL_ADMIN_MUTATION_TYPES: AdminServiceMutationType[] = [
  "ENABLE",
  "DISABLE",
  "ADD_VOLUME",
  "ADD_TIME",
  "REGENERATE_LINK",
];

/**
 * The mutation types STRUCTURALLY eligible for this Service+Panel right now
 * (adapter supports it, remote model is global, panel ACTIVE, status eligible,
 * value-domain valid). The view layers the switch / OWNER / conflicting-op
 * gates on top (§8) — this function never consults the DB or the switch.
 */
export function adminServiceEligibleMutations(
  service: Service,
  panel: Panel,
): AdminServiceMutationType[] {
  if (!serviceSupportsGlobalLifecycle(service) || panel.status !== PanelStatus.ACTIVE) {
    return [];
  }
  const out: AdminServiceMutationType[] = [];
  for (const type of ALL_ADMIN_MUTATION_TYPES) {
    if (!adminMutationCapabilityAvailable(type, panel)) {
      continue;
    }
    if (!ELIGIBLE_STATUS[type].includes(service.status)) {
      continue;
    }
    if (type === "ENABLE" && isServiceExpired(service)) {
      continue;
    }
    if (type === "ADD_VOLUME" && service.volumeBytes <= 0n) {
      continue;
    }
    if (type === "ADD_TIME" && service.expiresAt === null) {
      continue;
    }
    out.push(type);
  }
  return out;
}
