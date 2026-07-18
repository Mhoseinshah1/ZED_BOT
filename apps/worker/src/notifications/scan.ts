import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  Prisma,
  ServiceSource,
  ServiceStatus,
  prisma,
  type AutomatedNotificationType,
} from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  isServiceKindGateOpen,
  isUserGateOpenForCategory,
  type NotificationUserGates,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery } from "./queues.js";
import {
  planExpiry,
  planStatus,
  planTraffic,
  type NotificationPlan,
  type RulePanelState,
  type RuleServiceState,
} from "./rules.js";
import {
  getExpiryThresholds,
  getServiceStateMaxAgeMinutes,
  getTrafficThresholds,
  getTrialThresholds,
  isNotificationRuleEnabled,
  isNotificationSystemEnabled,
} from "./settings.js";
import { isServiceStateFresh } from "./service-sync.js";

// =============================================================================
// Notification SCAN (feat/notification-retention-engine, Phase 1). Evaluates
// the enabled rules (expiry / traffic / trial) against fresh Service state and
// creates the dedupe-guarded SCHEDULED AutomatedNotification rows, then enqueues
// each for delivery. The scan is conservative: the master switch off, a rule
// off, the user's category/service gate closed, a stale panel signal (traffic /
// status) or an existing dedupe row all mean "create nothing". Every payload it
// writes is safe-by-construction (template key + display variables + button
// specs) - no secret ever enters the row. Delivery re-validates everything.
// =============================================================================

const log = createLogger("worker:notif-scan");

/** Statuses worth evaluating (DELETED/CREATING/FAILED are never alerted). */
const CANDIDATE_STATUSES: ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.LIMITED,
  ServiceStatus.EXPIRED,
];

/** Hard cap per scan run so one sweep can never run unbounded; logged if hit. */
const MAX_SERVICES_PER_SCAN = 5000;
const BATCH_SIZE = 500;

interface ScanServiceRow {
  id: string;
  userId: string;
  username: string;
  note: string | null;
  productNameSnapshot: string | null;
  status: ServiceStatus;
  source: ServiceSource;
  convertedToPaidAt: Date | null;
  volumeBytes: bigint;
  usedBytes: bigint;
  expiresAt: Date | null;
  lastSubscriptionUpdateAt: Date | null;
  user: {
    status: string;
    cronNotificationsEnabled: boolean;
    serviceNotificationsEnabled: boolean;
    paymentNotificationsEnabled: boolean;
    marketingMessagesEnabled: boolean;
  };
  panel: { status: string; renewalEnabled: boolean };
  notificationPreference: {
    expiryEnabled: boolean | null;
    trafficEnabled: boolean | null;
    statusEnabled: boolean | null;
  } | null;
}

function toGates(user: ScanServiceRow["user"]): NotificationUserGates {
  return {
    active: user.status === "ACTIVE",
    cronNotificationsEnabled: user.cronNotificationsEnabled,
    serviceNotificationsEnabled: user.serviceNotificationsEnabled,
    paymentNotificationsEnabled: user.paymentNotificationsEnabled,
    marketingMessagesEnabled: user.marketingMessagesEnabled,
  };
}

function toRuleService(row: ScanServiceRow): RuleServiceState {
  return {
    id: row.id,
    username: row.username,
    note: row.note,
    productNameSnapshot: row.productNameSnapshot,
    status: row.status,
    volumeBytes: row.volumeBytes,
    usedBytes: row.usedBytes,
    expiresAt: row.expiresAt,
  };
}

export interface ScanResult {
  scanned: number;
  created: number;
  skipped: string | null;
  capped: boolean;
}

/**
 * One scan sweep. Returns counts; `skipped` is a safe reason string when the
 * whole sweep short-circuits (system disabled, no rule enabled).
 */
export async function runServiceNotificationScan(deliveryQueue: Queue): Promise<ScanResult> {
  if (!(await isNotificationSystemEnabled())) {
    return { scanned: 0, created: 0, skipped: "system-disabled", capped: false };
  }
  const [expiryOn, trafficOn, trialOn] = await Promise.all([
    isNotificationRuleEnabled("expiry"),
    isNotificationRuleEnabled("traffic"),
    isNotificationRuleEnabled("trial"),
  ]);
  if (!expiryOn && !trafficOn && !trialOn) {
    return { scanned: 0, created: 0, skipped: "no-rule-enabled", capped: false };
  }
  const [expiryThresholds, trafficThresholds, trialThresholds, maxAgeMinutes] = await Promise.all([
    getExpiryThresholds(),
    getTrafficThresholds(),
    getTrialThresholds(),
    getServiceStateMaxAgeMinutes(),
  ]);

  const now = new Date();
  let scanned = 0;
  let created = 0;
  let capped = false;
  let cursor: string | undefined;

  for (;;) {
    const rows = (await prisma.service.findMany({
      where: { deletedAt: null, status: { in: CANDIDATE_STATUSES } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        userId: true,
        username: true,
        note: true,
        productNameSnapshot: true,
        status: true,
        source: true,
        convertedToPaidAt: true,
        volumeBytes: true,
        usedBytes: true,
        expiresAt: true,
        lastSubscriptionUpdateAt: true,
        user: {
          select: {
            status: true,
            cronNotificationsEnabled: true,
            serviceNotificationsEnabled: true,
            paymentNotificationsEnabled: true,
            marketingMessagesEnabled: true,
          },
        },
        panel: { select: { status: true, renewalEnabled: true } },
        notificationPreference: {
          select: { expiryEnabled: true, trafficEnabled: true, statusEnabled: true },
        },
      },
    })) as ScanServiceRow[];
    if (rows.length === 0) {
      break;
    }
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      if (scanned >= MAX_SERVICES_PER_SCAN) {
        capped = true;
        break;
      }
      scanned += 1;
      created += await evaluateService(deliveryQueue, row, now, {
        expiryOn,
        trafficOn,
        trialOn,
        expiryThresholds,
        trialThresholds,
        trafficThresholds,
        maxAgeMinutes,
      });
    }
    if (capped || rows.length < BATCH_SIZE) {
      break;
    }
  }

  if (capped) {
    log.warn("notification scan hit the per-run service cap", { cap: MAX_SERVICES_PER_SCAN, scanned });
  }
  log.info("notification scan complete", { scanned, created });
  return { scanned, created, skipped: null, capped };
}

interface ScanConfig {
  expiryOn: boolean;
  trafficOn: boolean;
  trialOn: boolean;
  expiryThresholds: Awaited<ReturnType<typeof getExpiryThresholds>>;
  trialThresholds: Awaited<ReturnType<typeof getTrialThresholds>>;
  trafficThresholds: number[];
  maxAgeMinutes: number;
}

/** Evaluates one service against every enabled rule; returns rows created. */
async function evaluateService(
  deliveryQueue: Queue,
  row: ScanServiceRow,
  now: Date,
  cfg: ScanConfig,
): Promise<number> {
  const gates = toGates(row.user);
  // The whole engine only sends SERVICE-category notifications in Phase 1; if
  // the user's SERVICE gate is shut, nothing about this service is created.
  if (!isUserGateOpenForCategory(gates, "SERVICE")) {
    return 0;
  }
  const trial = row.source === ServiceSource.FREE_TRIAL && row.convertedToPaidAt === null;
  const panel: RulePanelState = { status: row.panel.status, renewalEnabled: row.panel.renewalEnabled };
  const service = toRuleService(row);
  const fresh = isServiceStateFresh(row, cfg.maxAgeMinutes, now);
  const override = row.notificationPreference;

  const plans: NotificationPlan[] = [];

  if (trial) {
    // Trial services: time-based trial rule only (near-expiry / expired).
    if (cfg.trialOn && isServiceKindGateOpen(gates, "expiry", override)) {
      const plan = planExpiry(service, panel, cfg.trialThresholds, now, true);
      if (plan !== null) {
        plans.push(plan);
      }
    }
  } else {
    if (cfg.expiryOn && isServiceKindGateOpen(gates, "expiry", override)) {
      const plan = planExpiry(service, panel, cfg.expiryThresholds, now, false);
      if (plan !== null) {
        plans.push(plan);
      }
    }
    // Traffic + status derive from panel sync -> require FRESH state.
    if (cfg.trafficOn && fresh && isServiceKindGateOpen(gates, "traffic", override)) {
      const plan = planTraffic(service, panel, cfg.trafficThresholds, now);
      if (plan !== null) {
        plans.push(plan);
      }
    }
    if (fresh && isServiceKindGateOpen(gates, "status", override)) {
      const plan = planStatus(service, panel, now);
      if (plan !== null) {
        plans.push(plan);
      }
    }
  }

  let created = 0;
  for (const plan of plans) {
    if (await persistNotification(deliveryQueue, row.userId, row.id, plan, now)) {
      created += 1;
    }
  }
  return created;
}

/** Creates one SCHEDULED row (dedupe-guarded) + enqueues delivery. */
async function persistNotification(
  deliveryQueue: Queue,
  userId: string,
  serviceId: string,
  plan: NotificationPlan,
  now: Date,
): Promise<boolean> {
  try {
    const notification = await prisma.automatedNotification.create({
      data: {
        type: plan.type as AutomatedNotificationType,
        category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId,
        serviceId,
        dedupeKey: plan.dedupeKey,
        ruleVersion: 1,
        scheduledFor: now,
        availableUntil: plan.availableUntil,
        payloadSnapshot: plan.payload as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    await enqueueNotificationDelivery(deliveryQueue, notification.id);
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Dedupe row already exists for this (service, threshold, cycle) - the
      // notification was already created this cycle. Nothing to do.
      return false;
    }
    log.warn("notification create failed", { error: errorMessage(err) });
    return false;
  }
}
