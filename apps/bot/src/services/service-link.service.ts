import {
  PanelStatus,
  prisma,
  ServiceStatus,
  type Panel,
  type Service,
} from "@zedbot/database";
import { type RegenerateSubscriptionResult } from "@zedbot/panel-adapters";
import { errorMessage, type ServiceOperationActor } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import {
  PANEL_OPERATION_UNSUPPORTED_TEXT,
  panelOperationAvailable,
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_OPERATION_TEXT,
} from "./panel-readiness.service.js";
import {
  acquireServiceLock,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceOperationLockKey,
  type ServiceLock,
} from "./service-lock.service.js";

// =============================================================================
// Subscription link regeneration (Phase 19): the user invalidates their OWN
// service's subscription link and gets a fresh one. The EXISTING panel
// account and EXISTING Service row are updated in place - no new Service, no
// CheckoutSession/Payment/Order/WalletTransaction, no username/expiry/volume
// change and NEVER a traffic reset. The panel is called only after an
// explicit confirmation; a failed panel call leaves the stored link/token/
// configs completely untouched. Old/new links and tokens are NEVER logged
// and never stored in event-log metadata.
// =============================================================================

export const SERVICE_SUBSCRIPTION_REGENERATED_EVENT_TYPE = "SERVICE_SUBSCRIPTION_REGENERATED";
// Admin Service Operations: an ADMIN actor's regeneration is audited under a
// distinct event type (§12) — never as the user's `SERVICE_SUBSCRIPTION_REGENERATED`.
export const SERVICE_SUBSCRIPTION_REGENERATED_BY_ADMIN_EVENT_TYPE =
  "SERVICE_SUBSCRIPTION_REGENERATED_BY_ADMIN";

export const REGEN_NOT_FOUND_TEXT = "مورد یافت نشد.";
export const REGEN_UNAVAILABLE_TEXT = "امکان تغییر لینک اشتراک این سرویس وجود ندارد.";
export const REGEN_FAILED_TEXT =
  "تغییر لینک اشتراک با خطا مواجه شد. لطفاً بعداً دوباره تلاش کنید.";
export const REGEN_SUCCESS_TEXT = "لینک اشتراک جدید ساخته شد ✅";

export type ServiceWithPanel = Service & { panel: Panel };

/**
 * Regeneration is offered for these statuses only (mirrors the Phase 18
 * eligible set plus nothing else): CREATING/FAILED/DELETED/EXPIRED never
 * regenerate.
 */
const REGENERATABLE_STATUSES: ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.LIMITED,
  ServiceStatus.DISABLED,
];

/**
 * Status labels for the confirmation preview. Only the REGENERATABLE
 * statuses can ever reach the preview; the map mirrors the "My Services"
 * labels in service-views.ts (kept local to avoid a service->handler
 * import cycle).
 */
const PREVIEW_STATUS_LABELS: Partial<Record<ServiceStatus, string>> = {
  ACTIVE: "فعال ✅",
  LIMITED: "اتمام حجم 📦",
  DISABLED: "غیرفعال ⏸",
};

/**
 * Owner-scoped short-id resolution (same contract as the "My Services"
 * lookup: unknown/ambiguous/deleted/foreign ids all come back null) with the
 * panel included so eligibility can be decided without a second read.
 */
export async function getLinkRegeneratableServiceByShortId(
  shortId: string,
  userId: string,
): Promise<ServiceWithPanel | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: {
      id: { startsWith: shortId },
      userId,
      deletedAt: null,
      status: { not: ServiceStatus.DELETED },
    },
    include: { panel: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export type LinkRegenerationEligibility =
  | { eligible: true }
  | { eligible: false; internalReason: string; safeUserMessage: string };

/** Validates regeneration against the CURRENT service/panel state. */
export function linkRegenerationEligibility(
  service: Pick<Service, "status" | "username" | "panelId">,
  panelStatus: PanelStatus,
): LinkRegenerationEligibility {
  if (service.username === "" || service.panelId === "") {
    return {
      eligible: false,
      internalReason: "service has no panel username/panel",
      safeUserMessage: REGEN_UNAVAILABLE_TEXT,
    };
  }
  if (panelStatus !== PanelStatus.ACTIVE) {
    return {
      eligible: false,
      internalReason: `panel status is ${panelStatus}`,
      safeUserMessage: REGEN_UNAVAILABLE_TEXT,
    };
  }
  if (!REGENERATABLE_STATUSES.includes(service.status)) {
    return {
      eligible: false,
      internalReason: `service status ${service.status} cannot regenerate its link`,
      safeUserMessage: REGEN_UNAVAILABLE_TEXT,
    };
  }
  return { eligible: true };
}

function formatPreviewDate(date: Date | null): string {
  return date === null ? "نامحدود" : `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

/** HTML confirmation screen shown BEFORE any panel call happens. */
export function buildLinkRegenerationPreview(service: Service): string {
  return [
    "<b>تغییر لینک اشتراک 🔄</b>",
    "",
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `وضعیت: ${PREVIEW_STATUS_LABELS[service.status] ?? service.status}`,
    `انقضا: ${formatPreviewDate(service.expiresAt)}`,
    "",
    "با تغییر لینک اشتراک، لینک قبلی غیرفعال می‌شود. ادامه می‌دهید؟",
  ].join("\n");
}

export type RegenerateLinkOutcome =
  | { ok: true; service: Service }
  // `uncertain` is set when the panel outcome was indeterminate, or the panel
  // definitely re-keyed but the local persist failed — the admin executor maps
  // this to a reconciliation-required operation. User callers ignore it.
  | { ok: false; error: string; safeUserMessage: string; uncertain?: boolean };

/** Actor-aware options (§12). Omitting `actor` = the existing USER behaviour.
 * `lock` (when provided) is checked for ownership loss right before persistence
 * so a regeneration that outran a lost lock defers instead of overwriting a
 * newer operation's state. */
export interface RegenActorOptions {
  actor?: ServiceOperationActor;
  lock?: ServiceLock;
}

/** Panel status -> ServiceStatus; anything else keeps the stored status. */
const STATUS_TO_SERVICE_STATUS: Partial<Record<string, ServiceStatus>> = {
  active: ServiceStatus.ACTIVE,
  disabled: ServiceStatus.DISABLED,
  expired: ServiceStatus.EXPIRED,
  limited: ServiceStatus.LIMITED,
};

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Executes one regeneration: re-reads the service scoped to the owner,
 * validates eligibility, calls the panel and only on a VALIDATED success
 * updates the Service row + writes the ServiceEventLog (one transaction).
 * A repeated confirmed click simply regenerates again (each run is an
 * explicit user confirmation); the last successful link wins and the DB is
 * never left half-written.
 */
export async function regenerateServiceSubscription(
  userId: string,
  serviceId: string,
): Promise<RegenerateLinkOutcome> {
  // CONCURRENCY: regeneration revokes/rewrites remote subscription state
  // and persists it - serialized per service with the shared distributed
  // lock; contention/unavailability fails closed with a retryable message.
  const acquisition = await acquireServiceLock(serviceOperationLockKey(serviceId));
  if (!acquisition.ok) {
    return {
      ok: false,
      error: `service lock ${acquisition.reason}`,
      safeUserMessage:
        acquisition.reason === "contended"
          ? SERVICE_LOCK_BUSY_TEXT
          : SERVICE_LOCK_UNAVAILABLE_TEXT,
    };
  }
  try {
    return await regenerateServiceSubscriptionUnlocked(userId, serviceId, {
      actor: { kind: "USER", userId },
      lock: acquisition.lock,
    });
  } finally {
    await acquisition.lock.release();
  }
}

/**
 * Lock-FREE regeneration body (the caller MUST already hold
 * `serviceOperationLockKey(serviceId)`). `ownerUserId` scopes the Service
 * lookup/persist to its owner. The actor (default USER) drives ONLY the
 * ServiceEventLog event type + metadata; every capability / remote-model /
 * eligibility gate and the validate-before-persist ordering are identical, and
 * NO old/new link or token is ever logged. Exported so the admin operations
 * executor can reuse it under the lock it already holds — without auditing the
 * regeneration as the user or exposing the new link to the admin surface.
 */
export async function regenerateServiceSubscriptionUnlocked(
  ownerUserId: string,
  serviceId: string,
  options: RegenActorOptions = {},
): Promise<RegenerateLinkOutcome> {
  const userId = ownerUserId;
  const actor: ServiceOperationActor = options.actor ?? { kind: "USER", userId };
  const found = await prisma.service.findFirst({
    where: {
      id: serviceId,
      userId,
      deletedAt: null,
      status: { not: ServiceStatus.DELETED },
    },
    include: { panel: true },
  });
  if (found === null) {
    return { ok: false, error: "service not found", safeUserMessage: REGEN_NOT_FOUND_TEXT };
  }
  const { panel, ...service } = found;

  // Capability model: subscription regeneration must be implemented by the
  // panel's adapter (Marzban revokes; XUI re-keys the client's subId, which
  // is what the subscription resolves by) - returning the old link as "new"
  // would be a fake success, so unsupported panels are blocked with a clear
  // message instead.
  if (!panelOperationAvailable(panel, "regenerateSubscription")) {
    return {
      ok: false,
      error: "panel does not support regenerateSubscription",
      safeUserMessage: PANEL_OPERATION_UNSUPPORTED_TEXT,
    };
  }

  // Remote-model gate: legacy per-inbound XUI services are never mutated
  // through the global-client endpoints and never silently migrated.
  if (!serviceSupportsGlobalLifecycle(service)) {
    return {
      ok: false,
      error: "xui legacy per-inbound service - global lifecycle unsupported",
      safeUserMessage: XUI_LEGACY_OPERATION_TEXT,
    };
  }

  const eligibility = linkRegenerationEligibility(service, panel.status);
  if (!eligibility.eligible) {
    return {
      ok: false,
      error: eligibility.internalReason,
      safeUserMessage: eligibility.safeUserMessage,
    };
  }

  logger.info("subscription regeneration started", {
    serviceId: service.id,
    panelId: panel.id,
    panelType: panel.type,
    action: "REGENERATE_SUBSCRIPTION",
  });

  let panelResult: RegenerateSubscriptionResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    panelResult = await adapter.regenerateSubscription({
      username: service.username,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    panelResult = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!panelResult.ok) {
    logger.warn("subscription regeneration panel call failed", {
      serviceId: service.id,
      panelId: panel.id,
      error: panelResult.errorMessage ?? "unknown",
    });
    return {
      ok: false,
      error: panelResult.errorMessage ?? "unknown adapter error",
      safeUserMessage: REGEN_FAILED_TEXT,
      uncertain: panelResult.uncertain === true,
    };
  }

  // Validate the success before touching the DB: the panel must have
  // returned at least one fresh link artifact for the SAME username -
  // anything else is treated as a failure, never half-applied.
  const newUrl = hasText(panelResult.subscriptionUrl) ? panelResult.subscriptionUrl : undefined;
  const newToken = hasText(panelResult.subscriptionToken)
    ? panelResult.subscriptionToken
    : undefined;
  const newConfigLinks =
    panelResult.configLinks !== undefined && panelResult.configLinks.length > 0
      ? panelResult.configLinks
      : undefined;
  if (newUrl === undefined && newToken === undefined && newConfigLinks === undefined) {
    logger.warn("subscription regeneration returned no link artifacts", {
      serviceId: service.id,
      panelId: panel.id,
    });
    return {
      ok: false,
      error: "panel returned no subscription url/token/config links",
      safeUserMessage: REGEN_FAILED_TEXT,
    };
  }
  if (panelResult.username !== undefined && panelResult.username !== service.username) {
    logger.warn("subscription regeneration returned a different username", {
      serviceId: service.id,
      panelId: panel.id,
    });
    return {
      ok: false,
      error: "panel returned a different username",
      safeUserMessage: REGEN_FAILED_TEXT,
    };
  }

  const now = new Date();
  const previousHadSubscriptionUrl =
    service.subscriptionUrl !== null && service.subscriptionUrl !== "";

  const data: {
    lastSubscriptionUpdateAt: Date;
    subscriptionUrl?: string;
    subscriptionToken?: string;
    configLinks?: string[];
    usedBytes?: bigint;
    remainingBytes?: bigint;
    expiresAt?: Date | null;
    status?: ServiceStatus;
  } = { lastSubscriptionUpdateAt: now };
  if (newUrl !== undefined) {
    data.subscriptionUrl = newUrl;
  }
  if (newToken !== undefined) {
    data.subscriptionToken = newToken;
  }
  if (newConfigLinks !== undefined) {
    data.configLinks = newConfigLinks;
  }
  // Optional read-only sync fields - only when the panel reported them.
  // Volume (total quota) is deliberately NOT written: regeneration never
  // changes what was sold.
  if (panelResult.usedBytes !== undefined) {
    data.usedBytes = panelResult.usedBytes;
  }
  if (panelResult.remainingBytes !== undefined && panelResult.remainingBytes !== null) {
    data.remainingBytes = panelResult.remainingBytes;
  }
  if (panelResult.expiresAt !== undefined) {
    data.expiresAt = panelResult.expiresAt;
  }
  const mappedStatus =
    panelResult.status !== undefined ? STATUS_TO_SERVICE_STATUS[panelResult.status] : undefined;
  if (mappedStatus !== undefined) {
    data.status = mappedStatus;
  }
  const newHasSubscriptionUrl = newUrl !== undefined ? true : previousHadSubscriptionUrl;

  // Lock-loss guard: the panel DEFINITELY re-keyed, but if the per-service lock
  // was lost during the call, persisting could overwrite a newer operation's
  // status/usage/expiry (this persist is not pre-state-guarded). Defer to
  // reconciliation instead of writing. Only enforced when a lock was passed
  // (the actor-aware admin/user callers); other callers keep prior behaviour.
  if (options.lock?.isLost() === true) {
    logger.warn("subscription regeneration: lock lost before persist - deferring", {
      serviceId: service.id,
      panelId: panel.id,
    });
    return {
      ok: false,
      error: "service lock lost before regeneration persist",
      safeUserMessage: REGEN_FAILED_TEXT,
      uncertain: true,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.service.updateMany({
        where: { id: service.id, userId, deletedAt: null },
        data,
      });
      if (updated.count !== 1) {
        throw new Error("service row vanished during regeneration");
      }
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId,
          panelId: panel.id,
          // ACTOR-aware (§12): an admin regeneration is audited distinctly and
          // correlated to its operation id — never as the user's event type.
          eventType:
            actor.kind === "ADMIN"
              ? SERVICE_SUBSCRIPTION_REGENERATED_BY_ADMIN_EVENT_TYPE
              : SERVICE_SUBSCRIPTION_REGENERATED_EVENT_TYPE,
          // NEVER store old/new links or tokens here - booleans only.
          metadata: {
            action: "REGENERATE_SUBSCRIPTION",
            previousHadSubscriptionUrl,
            newHasSubscriptionUrl,
            ...(actor.kind === "ADMIN" ? { operationId: actor.operationId } : {}),
          },
        },
      });
    });
  } catch (err) {
    logger.error("subscription regeneration persistence failed after panel success", {
      serviceId: service.id,
      panelId: panel.id,
      error: errorMessage(err),
    });
    return {
      ok: false,
      error: "regeneration persistence failed after panel success",
      safeUserMessage: REGEN_FAILED_TEXT,
      // The panel DEFINITELY re-keyed but the local row did not — the admin
      // executor must reconcile (never re-issue the panel regeneration).
      uncertain: true,
    };
  }

  const current = await prisma.service.findFirst({ where: { id: service.id, userId } });
  if (current === null) {
    return { ok: false, error: "service vanished", safeUserMessage: REGEN_NOT_FOUND_TEXT };
  }
  logger.info("subscription regeneration succeeded", {
    serviceId: service.id,
    panelId: panel.id,
    action: "REGENERATE_SUBSCRIPTION",
  });
  return { ok: true, service: current };
}
