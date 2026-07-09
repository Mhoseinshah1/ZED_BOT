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

// =============================================================================
// Service sync (Phase 11): read-only refresh of one Service row from its
// panel. Reads the panel account, updates the stored usage/status fields and
// nothing else - never mutates the panel, never renews/deletes anything.
// A failed sync leaves the row completely untouched (the user keeps seeing
// the last stored values). Subscription/config links are never logged.
// =============================================================================

const SYNC_FAILED_USER_TEXT =
  "بروزرسانی از پنل ناموفق بود. آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود.";

export type SyncServiceResult =
  | { ok: true; service: Service; message: string }
  | { ok: false; service: Service | null; error: string; safeUserMessage: string };

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
    return { ok: false, service: null, error: "service not found", safeUserMessage: "مورد یافت نشد." };
  }
  const { panel, ...serviceRow } = service;

  if (panel.status !== "ACTIVE") {
    return {
      ok: false,
      service: serviceRow,
      error: `panel status is ${panel.status}`,
      safeUserMessage: SYNC_FAILED_USER_TEXT,
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
      error: result.errorMessage ?? "unknown",
    });
    return {
      ok: false,
      service: serviceRow,
      error: result.errorMessage ?? "unknown",
      safeUserMessage: SYNC_FAILED_USER_TEXT,
    };
  }

  const updated = await prisma.service.update({
    where: { id: service.id },
    data: buildUpdateData(serviceRow, result),
  });
  logger.info("service sync succeeded", { serviceId: service.id, panelId: panel.id });
  return { ok: true, service: updated, message: "اطلاعات از پنل بروزرسانی شد." };
}
