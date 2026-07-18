import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  Prisma,
  prisma,
} from "@zedbot/database";
import {
  NOTIF_BUTTON_KEYS,
  NOTIF_WINBACK_TEMPLATE_KEY,
  NTF_ACTION_CODES,
  buildCustomerWinbackDedupeKey,
  createLogger,
  errorMessage,
  winbackStageKey,
  type NotificationButtonSpec,
  type NotificationPayloadSnapshot,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery, enqueuePanelSync } from "./queues.js";
import { loadWinbackCandidatePage, winbackVariables, type WinbackCandidate } from "./winback-eligibility.js";
import { getWinbackConfig, isNotificationSystemEnabled, isWinbackRuleEnabled } from "./settings.js";

// =============================================================================
// Customer win-back SCAN (Phase 3). Reuses the notification scan queue: creates
// dedupe-guarded SCHEDULED CUSTOMER_WINBACK (MARKETING) rows for genuine previous
// paying customers who currently have NO usable paid service, one per lapse-cycle
// stage (catch-up: only the highest applicable unsent stage). Every eligibility
// decision comes from the shared resolver (winback-eligibility.ts) - identical to
// the admin preview and the delivery re-validation. Stale paid-service state
// enqueues a priority sync and skips the candidate (never guessed inactive). The
// payload carries only safe display values + button specs; no secret, price, id.
// =============================================================================

const log = createLogger("worker:winback-scan");

/** Cursor-batch size + a hard per-run cap (logged if hit) so one sweep is bounded. */
const BATCH_SIZE = 300;
const MAX_PER_SCAN = 5000;

export interface WinbackScanResult {
  scanned: number;
  created: number;
  excludedUncertainService: number;
  syncsEnqueued: number;
  skipped: string | null;
  capped: boolean;
}

function winbackButtons(): NotificationButtonSpec[] {
  return [
    { action: NTF_ACTION_CODES.VIEW_PLANS, buttonTextKey: NOTIF_BUTTON_KEYS.WINBACK_VIEW_PLANS },
    { action: NTF_ACTION_CODES.VIEW_WALLET, buttonTextKey: NOTIF_BUTTON_KEYS.WINBACK_WALLET },
    { action: NTF_ACTION_CODES.SNOOZE_WINBACK, buttonTextKey: NOTIF_BUTTON_KEYS.WINBACK_SNOOZE },
    { action: NTF_ACTION_CODES.MARKETING_OPT_OUT, buttonTextKey: NOTIF_BUTTON_KEYS.WINBACK_OPT_OUT },
  ];
}

function winbackPayload(
  candidate: WinbackCandidate,
  stageDays: number,
  fingerprint: string,
): NotificationPayloadSnapshot {
  return {
    templateKey: NOTIF_WINBACK_TEMPLATE_KEY,
    variables: winbackVariables(candidate.display),
    buttons: winbackButtons(),
    // Safe, non-rendered diagnostics: the stage key + the HASHED lapse-cycle
    // fingerprint (never a raw order id, service id or price).
    meta: { kind: "winback", stageKey: winbackStageKey(stageDays), cycle: fingerprint },
  };
}

/** Creates one SCHEDULED CUSTOMER_WINBACK row (dedupe-guarded) + enqueues delivery. */
async function persist(
  deliveryQueue: Queue,
  candidate: WinbackCandidate,
  stageDays: number,
  fingerprint: string,
  now: Date,
): Promise<boolean> {
  try {
    const row = await prisma.automatedNotification.create({
      data: {
        type: "CUSTOMER_WINBACK",
        category: AutomatedNotificationCategory.MARKETING,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: candidate.userId,
        dedupeKey: buildCustomerWinbackDedupeKey(candidate.userId, fingerprint, stageDays),
        ruleVersion: 1,
        scheduledFor: now,
        availableUntil: null,
        payloadSnapshot: winbackPayload(candidate, stageDays, fingerprint) as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    await enqueueNotificationDelivery(deliveryQueue, row.id);
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false; // dedupe row already exists for this (user, cycle, stage).
    }
    log.warn("winback notification create failed", { error: errorMessage(err) });
    return false;
  }
}

/**
 * One win-back scan sweep. Returns counts; `skipped` is a safe reason when the
 * whole sweep short-circuits (system disabled, rule disabled).
 */
export async function runWinbackScan(
  deliveryQueue: Queue,
  serviceSyncQueue: Queue,
): Promise<WinbackScanResult> {
  const result: WinbackScanResult = {
    scanned: 0,
    created: 0,
    excludedUncertainService: 0,
    syncsEnqueued: 0,
    skipped: null,
    capped: false,
  };
  if (!(await isNotificationSystemEnabled())) {
    return { ...result, skipped: "system-disabled" };
  }
  if (!(await isWinbackRuleEnabled())) {
    return { ...result, skipped: "rule-disabled" };
  }
  const config = await getWinbackConfig();
  const now = new Date();
  const syncedPanels = new Set<string>();

  let cursor: string | undefined;
  for (;;) {
    const page = await loadWinbackCandidatePage(config, now, BATCH_SIZE, cursor);
    if (page.length === 0) {
      break;
    }
    cursor = page[page.length - 1].userId;
    for (const candidate of page) {
      if (result.scanned >= MAX_PER_SCAN) {
        result.capped = true;
        break;
      }
      result.scanned += 1;

      // Uncertain service state: enqueue a priority sync (once per panel per
      // sweep) and skip - a later scan re-evaluates on fresh data.
      if (!candidate.eligibility.eligible && candidate.eligibility.reason === "service-uncertain") {
        result.excludedUncertainService += 1;
        for (const panelId of candidate.needsSyncPanelIds) {
          if (!syncedPanels.has(panelId)) {
            syncedPanels.add(panelId);
            await enqueuePanelSync(serviceSyncQueue, panelId);
            result.syncsEnqueued += 1;
          }
        }
        continue;
      }
      if (!candidate.eligibility.eligible || candidate.lapseCycleFingerprint === null) {
        continue;
      }
      const created = await persist(
        deliveryQueue,
        candidate,
        candidate.eligibility.stageDays,
        candidate.lapseCycleFingerprint,
        now,
      );
      if (created) {
        result.created += 1;
      }
    }
    if (result.capped || page.length < BATCH_SIZE) {
      break;
    }
  }

  if (result.capped) {
    log.warn("winback scan hit the per-run cap", { cap: MAX_PER_SCAN });
  }
  log.info("winback notification scan complete", {
    scanned: result.scanned,
    created: result.created,
    excludedUncertainService: result.excludedUncertainService,
    syncsEnqueued: result.syncsEnqueued,
  });
  return result;
}
