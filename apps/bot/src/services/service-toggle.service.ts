import {
  PanelStatus,
  prisma,
  ServiceStatus,
  type Panel,
  type Service,
} from "@zedbot/database";
import { type SetServiceStatusResult } from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";

// =============================================================================
// Service enable/disable (Phase 18): the user turns their OWN service off/on.
// The EXISTING panel account and EXISTING Service row change status in place -
// no new Service, no CheckoutSession/Payment/Order/WalletTransaction, no
// username/expiry/volume change and NEVER a traffic reset. The panel is
// updated first; a failed panel call leaves the DB row completely untouched
// and the user only ever sees a safe generic message (raw adapter errors are
// logged internally, never shown).
// =============================================================================

export type ToggleAction = "ENABLE" | "DISABLE";

export const SERVICE_DISABLED_EVENT_TYPE = "SERVICE_DISABLED_BY_USER";
export const SERVICE_ENABLED_EVENT_TYPE = "SERVICE_ENABLED_BY_USER";

export const TOGGLE_NOT_FOUND_TEXT = "مورد یافت نشد.";
export const TOGGLE_UNAVAILABLE_TEXT = "امکان تغییر وضعیت این سرویس وجود ندارد.";
export const TOGGLE_EXPIRED_TEXT = "این سرویس منقضی شده و ابتدا باید تمدید شود.";
export const TOGGLE_FAILED_TEXT =
  "تغییر وضعیت سرویس با خطا مواجه شد. لطفاً بعداً دوباره تلاش کنید.";
export const TOGGLE_ALREADY_DONE_TEXT = "وضعیت سرویس قبلاً همین حالت بوده است.";
export const TOGGLE_DISABLED_OK_TEXT = "سرویس با موفقیت خاموش شد ✅";
export const TOGGLE_ENABLED_OK_TEXT = "سرویس با موفقیت روشن شد ✅";

export type ServiceWithPanel = Service & { panel: Panel };

/**
 * Owner-scoped short-id resolution (same contract as the "My Services"
 * lookup: unknown/ambiguous/deleted/foreign ids all come back null) with the
 * panel included so toggle eligibility can be decided without a second read.
 */
export async function getToggleableServiceByShortId(
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

/**
 * Which toggle the user may see for this service, or null for none:
 * ACTIVE/LIMITED + panel ACTIVE -> DISABLE; DISABLED + panel ACTIVE + not
 * expired -> ENABLE. CREATING/FAILED/EXPIRED (and DELETED) never toggle.
 */
export function availableToggleAction(
  service: Pick<Service, "status" | "expiresAt" | "username">,
  panelStatus: PanelStatus,
  now: Date = new Date(),
): ToggleAction | null {
  if (panelStatus !== PanelStatus.ACTIVE || service.username === "") {
    return null;
  }
  if (service.status === ServiceStatus.ACTIVE || service.status === ServiceStatus.LIMITED) {
    return "DISABLE";
  }
  if (service.status === ServiceStatus.DISABLED) {
    const expired = service.expiresAt !== null && service.expiresAt.getTime() <= now.getTime();
    return expired ? null : "ENABLE";
  }
  return null;
}

/** Toggle button for the detail view (rendered only when action is allowed). */
export async function resolveToggleAction(service: Service): Promise<ToggleAction | null> {
  const panel = await prisma.panel.findUnique({
    where: { id: service.panelId },
    select: { status: true },
  });
  return panel === null ? null : availableToggleAction(service, panel.status);
}

export type ToggleEligibility =
  | { eligible: true }
  | { eligible: false; internalReason: string; safeUserMessage: string };

/** Validates one action against the CURRENT service/panel state. */
export function toggleEligibility(
  service: Pick<Service, "status" | "expiresAt" | "username">,
  panelStatus: PanelStatus,
  action: ToggleAction,
  now: Date = new Date(),
): ToggleEligibility {
  if (service.username === "") {
    return {
      eligible: false,
      internalReason: "service has no panel username",
      safeUserMessage: TOGGLE_UNAVAILABLE_TEXT,
    };
  }
  if (panelStatus !== PanelStatus.ACTIVE) {
    return {
      eligible: false,
      internalReason: `panel status is ${panelStatus}`,
      safeUserMessage: TOGGLE_UNAVAILABLE_TEXT,
    };
  }
  if (action === "DISABLE") {
    if (service.status !== ServiceStatus.ACTIVE && service.status !== ServiceStatus.LIMITED) {
      return {
        eligible: false,
        internalReason: `service status ${service.status} cannot be disabled`,
        safeUserMessage: TOGGLE_UNAVAILABLE_TEXT,
      };
    }
    return { eligible: true };
  }
  if (service.status !== ServiceStatus.DISABLED) {
    return {
      eligible: false,
      internalReason: `service status ${service.status} cannot be enabled`,
      safeUserMessage: TOGGLE_UNAVAILABLE_TEXT,
    };
  }
  if (service.expiresAt !== null && service.expiresAt.getTime() <= now.getTime()) {
    // Expired services must go through renewal - enabling would fake activity.
    return {
      eligible: false,
      internalReason: "service is expired",
      safeUserMessage: TOGGLE_EXPIRED_TEXT,
    };
  }
  return { eligible: true };
}

/** HTML confirmation screen shown BEFORE any panel call happens. */
export function buildTogglePreview(service: Service, action: ToggleAction): string {
  const title = action === "DISABLE" ? "خاموش کردن سرویس ⏸" : "روشن کردن سرویس ▶️";
  const lines = [
    `<b>${title}</b>`,
    "",
    `نام سرویس: ${escapeHtml(service.productNameSnapshot ?? service.username)}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    "",
  ];
  if (action === "DISABLE") {
    lines.push(
      "آیا از خاموش کردن این سرویس مطمئن هستید؟",
      "⚠️ تا زمانی که سرویس خاموش باشد، امکان اتصال وجود ندارد.",
    );
  } else {
    lines.push("آیا از روشن کردن این سرویس مطمئن هستید؟");
  }
  return lines.join("\n");
}

export type ToggleOutcome =
  | { ok: true; service: Service; action: ToggleAction; alreadyDone: boolean }
  | { ok: false; error: string; safeUserMessage: string };

/** True when the service is already in the state `action` asks for. */
function isAlreadyInDesiredState(status: ServiceStatus, action: ToggleAction): boolean {
  return action === "DISABLE"
    ? status === ServiceStatus.DISABLED
    : status === ServiceStatus.ACTIVE || status === ServiceStatus.LIMITED;
}

/**
 * Executes one toggle: re-reads the service scoped to the owner, validates
 * eligibility, updates the panel FIRST and only then the Service row plus a
 * ServiceEventLog entry. Double clicks are absorbed twice: an up-front
 * "already in the desired state" check (no event log) and an updateMany
 * filtered on the allowed previous statuses so a concurrent toggle can never
 * double-apply or overwrite a newer state.
 */
export async function toggleServiceStatus(
  userId: string,
  serviceId: string,
  action: ToggleAction,
): Promise<ToggleOutcome> {
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
    return { ok: false, error: "service not found", safeUserMessage: TOGGLE_NOT_FOUND_TEXT };
  }
  const { panel, ...service } = found;

  // Stale button / double click: nothing to do, no event log.
  if (isAlreadyInDesiredState(service.status, action)) {
    return { ok: true, service, action, alreadyDone: true };
  }

  const now = new Date();
  const eligibility = toggleEligibility(service, panel.status, action, now);
  if (!eligibility.eligible) {
    return {
      ok: false,
      error: eligibility.internalReason,
      safeUserMessage: eligibility.safeUserMessage,
    };
  }

  logger.info("service toggle started", {
    serviceId: service.id,
    panelId: panel.id,
    panelType: panel.type,
    action,
  });

  // Panel first - the DB row only changes after the panel accepted the toggle.
  let panelResult: SetServiceStatusResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    panelResult = await adapter.setServiceStatus({
      username: service.username,
      enabled: action === "ENABLE",
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    panelResult = { ok: false, errorMessage: errorMessage(err) };
  }
  if (!panelResult.ok) {
    logger.warn("service toggle panel update failed", {
      serviceId: service.id,
      panelId: panel.id,
      action,
      error: panelResult.errorMessage ?? "unknown",
    });
    return {
      ok: false,
      error: panelResult.errorMessage ?? "unknown adapter error",
      safeUserMessage: TOGGLE_FAILED_TEXT,
    };
  }

  // ENABLE with exhausted finite traffic comes back as LIMITED, not ACTIVE.
  const effectiveVolume =
    panelResult.totalBytes !== undefined ? (panelResult.totalBytes ?? 0n) : service.volumeBytes;
  const effectiveRemaining =
    panelResult.remainingBytes !== undefined && panelResult.remainingBytes !== null
      ? panelResult.remainingBytes
      : service.remainingBytes;
  const nextStatus =
    action === "DISABLE"
      ? ServiceStatus.DISABLED
      : effectiveVolume > 0n && effectiveRemaining <= 0n
        ? ServiceStatus.LIMITED
        : ServiceStatus.ACTIVE;
  const allowedPrevious =
    action === "DISABLE"
      ? [ServiceStatus.ACTIVE, ServiceStatus.LIMITED]
      : [ServiceStatus.DISABLED];

  // Sync-style refresh: only fields the panel actually reported are written.
  const data: {
    status: ServiceStatus;
    lastSubscriptionUpdateAt: Date;
    usedBytes?: bigint;
    remainingBytes?: bigint;
    expiresAt?: Date | null;
    subscriptionUrl?: string;
    configLinks?: string[];
  } = { status: nextStatus, lastSubscriptionUpdateAt: now };
  if (panelResult.usedBytes !== undefined) {
    data.usedBytes = panelResult.usedBytes;
  }
  if (panelResult.remainingBytes !== undefined && panelResult.remainingBytes !== null) {
    data.remainingBytes = panelResult.remainingBytes;
  }
  if (panelResult.expiresAt !== undefined) {
    data.expiresAt = panelResult.expiresAt;
  }
  if (panelResult.subscriptionUrl !== undefined && panelResult.subscriptionUrl !== "") {
    data.subscriptionUrl = panelResult.subscriptionUrl;
  }
  if (panelResult.configLinks !== undefined && panelResult.configLinks.length > 0) {
    data.configLinks = panelResult.configLinks;
  }

  // Concurrency guard: the row only changes if it is STILL in a status this
  // action is allowed to leave; the event log lands in the same transaction.
  const persist = (): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.service.updateMany({
        where: { id: service.id, userId, deletedAt: null, status: { in: allowedPrevious } },
        data,
      });
      if (updated.count === 0) {
        return false;
      }
      await tx.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId,
          panelId: panel.id,
          eventType:
            action === "DISABLE" ? SERVICE_DISABLED_EVENT_TYPE : SERVICE_ENABLED_EVENT_TYPE,
          metadata: { action, previousStatus: service.status, newStatus: nextStatus },
        },
      });
      return true;
    });

  // The panel already switched, so persistence retries once (Phase 9.1 rule);
  // still failing -> safe error, the user can retry or refresh (which
  // re-syncs the status from the panel anyway).
  let applied: boolean;
  try {
    applied = await persist();
  } catch (err) {
    logger.error("service toggle persistence failed after panel success", {
      serviceId: service.id,
      action,
      error: errorMessage(err),
    });
    try {
      applied = await persist();
    } catch (retryErr) {
      logger.error("service toggle persistence retry failed", {
        serviceId: service.id,
        action,
        error: errorMessage(retryErr),
      });
      return {
        ok: false,
        error: "toggle persistence failed after panel success",
        safeUserMessage: TOGGLE_FAILED_TEXT,
      };
    }
  }

  const current = await prisma.service.findFirst({
    where: { id: service.id, userId },
  });
  if (current === null) {
    return { ok: false, error: "service vanished", safeUserMessage: TOGGLE_NOT_FOUND_TEXT };
  }
  if (!applied) {
    // A concurrent caller changed the status between our read and write. If
    // it already reached the desired state this is just a double click.
    if (isAlreadyInDesiredState(current.status, action)) {
      return { ok: true, service: current, action, alreadyDone: true };
    }
    logger.warn("service toggle lost concurrency race", {
      serviceId: service.id,
      action,
      currentStatus: current.status,
    });
    return { ok: false, error: "concurrent status change", safeUserMessage: TOGGLE_FAILED_TEXT };
  }

  logger.info("service toggle succeeded", {
    serviceId: service.id,
    panelId: panel.id,
    action,
    previousStatus: service.status,
    newStatus: nextStatus,
  });
  return { ok: true, service: current, action, alreadyDone: false };
}
