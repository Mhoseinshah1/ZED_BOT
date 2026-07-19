import {
  AutoRenewalMandateStatus,
  AutoRenewalPauseReason,
  PanelStatus,
  Prisma,
  prisma,
  type ServiceAutoRenewalMandate,
} from "@zedbot/database";
import {
  AUTO_RENEWAL_JOB_NAMES,
  autoRenewalExecuteJobId,
  autoRenewalIdempotencyKey,
  buildAutoRenewalCycleFingerprint,
  createLogger,
  errorMessage,
  isAutoRenewalDue,
  isWithinAutoRenewalGrace,
  resolveAutoRenewalCharge,
  type WalletAutoRenewalConfig,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { isServiceStateFresh } from "../notifications/service-sync.js";
import { getServiceStateMaxAgeMinutes } from "../notifications/settings.js";
import { enqueuePanelSync } from "../notifications/queues.js";
import { getWalletAutoRenewalConfig, isWalletAutoRenewalEnabled } from "./settings.js";

// =============================================================================
// Wallet auto-renewal SCAN (worker side). Finds ACTIVE mandates whose Service is
// inside the charge-lead window on FRESH panel-backed state, creates ONE durable
// SCHEDULED attempt per Service expiry cycle (DB-authoritative dedup via the
// @@unique([mandateId, expiryCycleFingerprint]) constraint), and enqueues an
// EXECUTE job onto the bot-consumed execute queue. It NEVER moves money, NEVER
// mutates a panel and NEVER guesses an expiry: a stale Service state enqueues a
// priority sync and defers; a Panel outage never leads to a charge. Product/price
// ineligibility PAUSES the mandate with a safe reason (the user must re-consent
// to a new plan / a higher ceiling). Bounded batch + cursor pagination + a
// distributed scan lock keep concurrent scheduler copies from creating duplicates.
// =============================================================================

const log = createLogger("worker:war-scan");

/** Max mandates examined per scan (bounded work). */
const SCAN_BATCH = 500;
/** When a Service state is stale, re-evaluate this soon (after the sync lands). */
const UNCERTAIN_RETRY_MINUTES = 15;

export interface AutoRenewalScanResult {
  scanned: number;
  due: number;
  attemptsCreated: number;
  enqueued: number;
  deferredUncertain: number;
  paused: number;
  skipped?: string;
}

/** Mutable status the heartbeat reads (last scan + rolling counters). */
export interface AutoRenewalScanState {
  lastScanAt: string | null;
  dueCount: number;
}
export function createAutoRenewalScanState(): AutoRenewalScanState {
  return { lastScanAt: null, dueCount: 0 };
}

async function pauseMandate(
  mandateId: string,
  reason: AutoRenewalPauseReason,
  safeErrorCode: string,
): Promise<void> {
  await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, status: AutoRenewalMandateStatus.ACTIVE },
    data: {
      status: AutoRenewalMandateStatus.PAUSED,
      pauseReason: reason,
      pausedAt: new Date(),
      safeLastErrorCode: safeErrorCode,
      lastEvaluatedAt: new Date(),
    },
  });
}

async function deferMandate(mandateId: string, nextEvaluationAt: Date): Promise<void> {
  await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, status: AutoRenewalMandateStatus.ACTIVE },
    data: { lastEvaluatedAt: new Date(), nextEvaluationAt },
  });
}

/**
 * Evaluates one ACTIVE mandate. Returns an outcome the scan tallies. Only
 * DB-level checks here (no panel calls); the execute consumer does the
 * authoritative capability re-validation before any charge.
 */
async function evaluateMandate(
  mandate: ServiceAutoRenewalMandate,
  config: WalletAutoRenewalConfig,
  maxAgeMinutes: number,
  now: Date,
  serviceSyncQueue: Queue,
  executeQueue: Queue,
): Promise<{ due: boolean; created: boolean; enqueued: boolean; uncertain: boolean; paused: boolean }> {
  const base = { due: false, created: false, enqueued: false, uncertain: false, paused: false };

  const service = await prisma.service.findUnique({ where: { id: mandate.serviceId } });
  if (
    service === null ||
    service.userId !== mandate.userId ||
    service.deletedAt !== null ||
    service.status === "DELETED"
  ) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.SERVICE_INELIGIBLE, "service-missing");
    return { ...base, paused: true };
  }
  // Unlimited-time Services (no finite expiry) are never auto-renewed.
  if (service.expiresAt === null) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.SERVICE_INELIGIBLE, "service-unlimited");
    return { ...base, paused: true };
  }

  const expiresAtEpoch = service.expiresAt.getTime();
  const nowEpoch = now.getTime();

  // Not yet in the charge-lead window -> re-evaluate near the lead boundary.
  if (!isAutoRenewalDue({ expiresAtEpoch, nowEpoch, chargeLeadMinutes: mandate.chargeLeadMinutes })) {
    const leadMs = mandate.chargeLeadMinutes * 60_000;
    await deferMandate(mandate.id, new Date(expiresAtEpoch - leadMs));
    return base;
  }
  // Past the grace window -> abandon this cycle (do not renew a long-dead expiry).
  if (!isWithinAutoRenewalGrace({ expiresAtEpoch, nowEpoch, graceHours: config.graceHours })) {
    await deferMandate(mandate.id, new Date(nowEpoch + 24 * 3_600_000));
    return { ...base, due: true };
  }

  // Never charge on a stale Service state: enqueue a priority sync and defer.
  if (!isServiceStateFresh(service, maxAgeMinutes, now)) {
    await enqueuePanelSync(serviceSyncQueue, service.panelId);
    await deferMandate(mandate.id, new Date(nowEpoch + UNCERTAIN_RETRY_MINUTES * 60_000));
    return { ...base, due: true, uncertain: true };
  }

  // Product re-validation (DB level): active, category active, same panel, price.
  const product = await prisma.product.findUnique({
    where: { id: mandate.productId },
    include: { category: true, panel: true },
  });
  if (
    product === null ||
    !product.isActive ||
    product.type !== "SERVICE_PRODUCT" ||
    product.panelId !== service.panelId ||
    product.category === null ||
    !product.category.isActive ||
    product.panel === null
  ) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.PRODUCT_UNAVAILABLE, "product-unavailable");
    return { ...base, due: true, paused: true };
  }
  if (product.panel.status !== PanelStatus.ACTIVE) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.PANEL_UNAVAILABLE, "panel-unavailable");
    return { ...base, due: true, paused: true };
  }
  // Price ceiling (also re-enforced inside the wallet transaction at execute).
  const charge = resolveAutoRenewalCharge(product.priceToman, mandate.maximumChargeToman);
  if (charge.reason === "price-above-limit") {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.PRICE_ABOVE_LIMIT, "price-above-limit");
    return { ...base, due: true, paused: true };
  }
  if (!charge.eligible) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.PRODUCT_UNAVAILABLE, "invalid-price");
    return { ...base, due: true, paused: true };
  }

  // Defer while an open financial reconciliation touches this user (never charge
  // during a financial review).
  const openReview = await prisma.financialReconciliationCase.count({
    where: { userId: mandate.userId, status: { in: ["OPEN", "IN_REVIEW"] } },
  });
  if (openReview > 0) {
    await deferMandate(mandate.id, new Date(nowEpoch + UNCERTAIN_RETRY_MINUTES * 60_000));
    return { ...base, due: true };
  }

  // One attempt per expiry cycle (DB-authoritative).
  const fingerprint = buildAutoRenewalCycleFingerprint({
    serviceId: service.id,
    expiresAtEpoch,
    productId: product.id,
  });
  if (fingerprint === null) {
    await pauseMandate(mandate.id, AutoRenewalPauseReason.SERVICE_INELIGIBLE, "no-cycle");
    return { ...base, due: true, paused: true };
  }
  const idempotencyKey = autoRenewalIdempotencyKey(mandate.id, fingerprint);

  let attemptId: string | null = null;
  let created = false;
  try {
    const attempt = await prisma.serviceAutoRenewalAttempt.create({
      data: {
        mandateId: mandate.id,
        serviceId: service.id,
        userId: mandate.userId,
        productId: product.id,
        expiryCycleFingerprint: fingerprint,
        idempotencyKey,
        expectedServiceExpiresAt: service.expiresAt,
        expectedProductPriceToman: product.priceToman,
        authorizedMaximumChargeToman: mandate.maximumChargeToman,
      },
      select: { id: true, status: true },
    });
    attemptId = attempt.id;
    created = true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.serviceAutoRenewalAttempt.findUnique({
        where: { mandateId_expiryCycleFingerprint: { mandateId: mandate.id, expiryCycleFingerprint: fingerprint } },
        select: { id: true, status: true },
      });
      // Re-enqueue only a non-terminal existing attempt (resume after restart).
      if (existing !== null && ["SCHEDULED", "CLAIMED", "PAYMENT_CREATED", "FULFILLING"].includes(existing.status)) {
        attemptId = existing.id;
      }
    } else {
      throw err;
    }
  }

  await deferMandate(mandate.id, new Date(nowEpoch + UNCERTAIN_RETRY_MINUTES * 60_000));

  if (attemptId === null) {
    return { ...base, due: true, created };
  }
  await executeQueue.add(
    AUTO_RENEWAL_JOB_NAMES.EXECUTE_WALLET_AUTO_RENEWAL,
    { attemptId },
    { jobId: autoRenewalExecuteJobId(attemptId), removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  );
  return { due: true, created, enqueued: true, uncertain: false, paused: false };
}

/**
 * Runs one auto-renewal scan. `serviceSyncQueue` re-arms stale panel state;
 * `executeQueue` is the bot-consumed EXECUTE queue.
 */
export async function runAutoRenewalScan(
  serviceSyncQueue: Queue,
  executeQueue: Queue,
  state?: AutoRenewalScanState,
  now: Date = new Date(),
): Promise<AutoRenewalScanResult> {
  const empty: AutoRenewalScanResult = {
    scanned: 0,
    due: 0,
    attemptsCreated: 0,
    enqueued: 0,
    deferredUncertain: 0,
    paused: 0,
  };
  if (!(await isWalletAutoRenewalEnabled())) {
    return { ...empty, skipped: "system-disabled" };
  }
  const [config, maxAgeMinutes] = await Promise.all([
    getWalletAutoRenewalConfig(),
    getServiceStateMaxAgeMinutes(),
  ]);

  const mandates = await prisma.serviceAutoRenewalMandate.findMany({
    where: {
      status: AutoRenewalMandateStatus.ACTIVE,
      OR: [{ nextEvaluationAt: null }, { nextEvaluationAt: { lte: now } }],
    },
    orderBy: [{ nextEvaluationAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: SCAN_BATCH,
  });

  const result = { ...empty };
  for (const mandate of mandates) {
    result.scanned += 1;
    try {
      const outcome = await evaluateMandate(mandate, config, maxAgeMinutes, now, serviceSyncQueue, executeQueue);
      if (outcome.due) result.due += 1;
      if (outcome.created) result.attemptsCreated += 1;
      if (outcome.enqueued) result.enqueued += 1;
      if (outcome.uncertain) result.deferredUncertain += 1;
      if (outcome.paused) result.paused += 1;
    } catch (err) {
      log.warn("auto-renewal mandate evaluation failed", {
        mandate: mandate.id.slice(0, 8),
        error: errorMessage(err),
      });
    }
  }
  if (state !== undefined) {
    state.lastScanAt = now.toISOString();
    state.dueCount = result.due;
  }
  if (result.attemptsCreated > 0 || result.paused > 0) {
    log.info("auto-renewal scan complete", {
      scanned: result.scanned,
      due: result.due,
      created: result.attemptsCreated,
      paused: result.paused,
    });
  }
  return result;
}

// --- reconcile + cleanup -----------------------------------------------------

/** SCHEDULED/CLAIMED attempts older than this without progress are re-armed. */
const ORPHAN_MS = 15 * 60_000;

export interface AutoRenewalReconcileResult {
  requeued: number;
  cancelledStale: number;
}

/**
 * Reconcile safety net: re-arms attempts whose mandate is still due but whose
 * execute job was lost (SCHEDULED/CLAIMED past the orphan age), and cancels
 * attempts whose cycle no longer matches the live Service (a manual renewal moved
 * the expiry) so a stale cycle can never charge later.
 */
export async function runAutoRenewalReconcile(
  executeQueue: Queue,
  now: Date = new Date(),
): Promise<AutoRenewalReconcileResult> {
  if (!(await isWalletAutoRenewalEnabled())) {
    return { requeued: 0, cancelledStale: 0 };
  }
  const orphanCutoff = new Date(now.getTime() - ORPHAN_MS);
  const stuck = await prisma.serviceAutoRenewalAttempt.findMany({
    where: {
      status: { in: ["SCHEDULED", "CLAIMED"] },
      updatedAt: { lt: orphanCutoff },
    },
    select: { id: true, serviceId: true, expiryCycleFingerprint: true, productId: true },
    take: 500,
  });
  let requeued = 0;
  let cancelledStale = 0;
  for (const attempt of stuck) {
    const service = await prisma.service.findUnique({
      where: { id: attempt.serviceId },
      select: { expiresAt: true },
    });
    const liveFingerprint =
      service === null
        ? null
        : buildAutoRenewalCycleFingerprint({
            serviceId: attempt.serviceId,
            expiresAtEpoch: service.expiresAt?.getTime() ?? null,
            productId: attempt.productId,
          });
    if (liveFingerprint !== attempt.expiryCycleFingerprint) {
      // The Service cycle changed (e.g. a manual renewal) -> this attempt is stale.
      const cancelled = await prisma.serviceAutoRenewalAttempt.updateMany({
        where: { id: attempt.id, status: { in: ["SCHEDULED", "CLAIMED"] } },
        data: { status: "CANCELLED", cancelledAt: now, safeErrorCode: "cycle-changed" },
      });
      cancelledStale += cancelled.count;
      continue;
    }
    await executeQueue
      .add(
        AUTO_RENEWAL_JOB_NAMES.EXECUTE_WALLET_AUTO_RENEWAL,
        { attemptId: attempt.id },
        { jobId: autoRenewalExecuteJobId(attempt.id), removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
      )
      .catch(() => undefined);
    requeued += 1;
  }
  if (requeued > 0 || cancelledStale > 0) {
    log.info("auto-renewal reconcile complete", { requeued, cancelledStale });
  }
  return { requeued, cancelledStale };
}

/** Terminal attempt statuses eligible for retention cleanup. */
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "DEAD_LETTER", "CANCELLED", "SKIPPED"] as const;

export interface AutoRenewalCleanupResult {
  deleted: number;
}

/**
 * Prunes terminal attempts older than the retention window. Standalone deleteMany
 * on the attempt table ONLY — never touches mandates, Orders, Payments,
 * CheckoutSessions, WalletTransactions or the latest successful attempt an active
 * mandate references (that attempt's order id lives on the mandate, not here).
 */
export async function runAutoRenewalCleanup(now: Date = new Date()): Promise<AutoRenewalCleanupResult> {
  const config = await getWalletAutoRenewalConfig();
  const cutoff = new Date(now.getTime() - config.attemptRetentionDays * 24 * 3_600_000);
  const res = await prisma.serviceAutoRenewalAttempt.deleteMany({
    where: { status: { in: [...TERMINAL_STATUSES] }, updatedAt: { lt: cutoff } },
  });
  if (res.count > 0) {
    log.info("auto-renewal cleanup complete", { deleted: res.count });
  }
  return { deleted: res.count };
}
