import {
  attributionReconcileJobId,
  AUTO_RENEWAL_JOB_NAMES,
  AUTO_RENEWAL_QUEUE_NAME,
  BACKUP_JOB_NAMES,
  BACKUP_QUEUE_NAME,
  getRedisOptions,
  LOG_DELIVERY_JOB_NAME,
  LOG_DELIVERY_QUEUE_NAME,
  LOG_GROUP_SETUP_JOB_NAME,
  LOG_GROUP_SETUP_QUEUE_NAME,
  logGroupSetupJobId,
  NOTIFICATION_JOB_NAMES,
  NOTIFICATION_MAINTENANCE_QUEUE_NAME,
  NOTIFICATION_WORKER_STATUS_KEY,
  REFERRAL_EXECUTE_QUEUE_NAME,
  REFERRAL_JOB_NAMES,
  REFERRAL_QUEUE_NAME,
  REFERRAL_WORKER_STATUS_KEY,
  STARS_SUBSCRIPTION_JOB_NAMES,
  STARS_SUBSCRIPTION_QUEUE_NAME,
  WORKER_CAPABILITIES_KEY,
  WORKER_HEARTBEAT_KEY,
  REFERRAL_EXECUTE_HEARTBEAT_KEY,
  referralCorrelationHash,
  referralCreditJobId,
  referralReverseJobId,
  type NotificationWorkerStatus,
  type ReferralWorkerStatus,
  type WorkerCapabilities,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { logger } from "../core/logger.js";

// =============================================================================
// Bot-side BullMQ PRODUCERS for the ops contract (packages/shared/src/ops.ts):
// the bot only ENQUEUES database-backup and telegram-operational-log jobs -
// the worker service consumes them (pg_dump, verification, cleanup and the
// actual Telegram log-group sends all run there, never in the bot process).
// Everything here fails SOFT: Redis unconfigured/unreachable returns null /
// false and callers show a safe Persian error - an admin tap or a log write
// must never crash or hang the bot. All Redis commands are hard-bounded by a
// local timeout because BullMQ producer connections use
// maxRetriesPerRequest: null (required by BullMQ) and would otherwise queue
// commands forever while Redis is down.
// =============================================================================

const COMMAND_TIMEOUT_MS = 5_000;
const REDIS_CONNECT_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms = COMMAND_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ops redis command timed out"));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

// --- lazy singleton queues -----------------------------------------------------------------

interface QueuePair {
  backup: Queue;
  logDelivery: Queue;
  logGroupSetup: Queue;
  notifMaintenance: Queue;
  autoRenewalControl: Queue;
  starsSubscriptionControl: Queue;
  referralControl: Queue;
  referralExecute: Queue;
}

let queues: QueuePair | null = null;
let queuesFingerprint = "";

function getQueues(): QueuePair | null {
  const options = getRedisOptions();
  if (options === null) {
    return null;
  }
  const fingerprint = `${options.host}:${options.port}`;
  if (queues !== null && queuesFingerprint === fingerprint) {
    return queues;
  }
  if (queues !== null) {
    void queues.backup.close().catch(() => undefined);
    void queues.logDelivery.close().catch(() => undefined);
    void queues.logGroupSetup.close().catch(() => undefined);
    void queues.notifMaintenance.close().catch(() => undefined);
    void queues.autoRenewalControl.close().catch(() => undefined);
    void queues.starsSubscriptionControl.close().catch(() => undefined);
    queues = null;
  }
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const connection = {
    host: options.host,
    port: options.port,
    password: options.password,
    maxRetriesPerRequest: null,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  };
  const backup = new Queue(BACKUP_QUEUE_NAME, { connection });
  const logDelivery = new Queue(LOG_DELIVERY_QUEUE_NAME, { connection });
  const logGroupSetup = new Queue(LOG_GROUP_SETUP_QUEUE_NAME, { connection });
  const notifMaintenance = new Queue(NOTIFICATION_MAINTENANCE_QUEUE_NAME, { connection });
  const autoRenewalControl = new Queue(AUTO_RENEWAL_QUEUE_NAME, { connection });
  const starsSubscriptionControl = new Queue(STARS_SUBSCRIPTION_QUEUE_NAME, { connection });
  const referralControl = new Queue(REFERRAL_QUEUE_NAME, { connection });
  const referralExecute = new Queue(REFERRAL_EXECUTE_QUEUE_NAME, { connection });
  for (const queue of [backup, logDelivery, logGroupSetup, notifMaintenance, autoRenewalControl, starsSubscriptionControl, referralControl, referralExecute]) {
    queue.on("error", (err) => {
      logger.warn("ops queue redis error", { queue: queue.name, error: errorText(err) });
    });
  }
  queues = { backup, logDelivery, logGroupSetup, notifMaintenance, autoRenewalControl, starsSubscriptionControl, referralControl, referralExecute };
  queuesFingerprint = fingerprint;
  return queues;
}

/** Test hook: drops the cached queues/client so env changes take effect. */
export async function resetOpsQueueForTests(): Promise<void> {
  if (queues !== null) {
    await queues.backup.close().catch(() => undefined);
    await queues.logDelivery.close().catch(() => undefined);
    await queues.logGroupSetup.close().catch(() => undefined);
    await queues.notifMaintenance.close().catch(() => undefined);
    await queues.autoRenewalControl.close().catch(() => undefined);
    await queues.starsSubscriptionControl.close().catch(() => undefined);
    await queues.referralControl.close().catch(() => undefined);
    await queues.referralExecute.close().catch(() => undefined);
    queues = null;
    queuesFingerprint = "";
  }
  if (reader !== null) {
    reader.disconnect();
    reader = null;
    readerFingerprint = "";
  }
}

// --- enqueue helpers -------------------------------------------------------------------------

/**
 * Enqueues the CREATE job for one BackupOperation. jobId = operationId, so
 * repeated admin taps on the same active operation can never produce a
 * second job (BullMQ deduplicates on the job id). Returns false (fail-soft)
 * when Redis is unconfigured or unreachable.
 */
export async function enqueueBackupCreate(operationId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.backup.add(
        BACKUP_JOB_NAMES.CREATE,
        { operationId },
        {
          jobId: operationId,
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
        },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("backup create enqueue failed", { operationId, error: errorText(err) });
    return false;
  }
}

/**
 * Enqueues a VERIFY job for one BackupOperation. The job id is derived from
 * the operation (dedupes rapid double-taps) but completed/failed verify jobs
 * are removed so a later re-verification is always possible.
 */
export async function enqueueBackupVerify(
  operationId: string,
  fileShortId?: string,
): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.backup.add(
        BACKUP_JOB_NAMES.VERIFY,
        { operationId, fileShortId: fileShortId ?? null },
        { jobId: `${operationId}:verify`, removeOnComplete: true, removeOnFail: true },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("backup verify enqueue failed", { operationId, error: errorText(err) });
    return false;
  }
}

/** Enqueues one retention-cleanup pass (executed by the worker). */
export async function enqueueBackupCleanup(): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.backup.add(
        BACKUP_JOB_NAMES.CLEANUP,
        {},
        { jobId: "manual-cleanup", removeOnComplete: true, removeOnFail: true },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("backup cleanup enqueue failed", { error: errorText(err) });
    return false;
  }
}

/**
 * Enqueues the Telegram delivery of one SystemLogDelivery row. jobId =
 * deliveryId (idempotent); completed/failed jobs are removed because the
 * delivery ROW is the durable source of truth and a stuck delivery must be
 * re-enqueueable.
 */
export async function enqueueLogDelivery(deliveryId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.logDelivery.add(
        LOG_DELIVERY_JOB_NAME,
        { deliveryId },
        {
          jobId: deliveryId,
          attempts: 5,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("log delivery enqueue failed", { deliveryId, error: errorText(err) });
    return false;
  }
}

/**
 * Enqueues the PROVISION_LOG_GROUP job for one LogGroupSetupAttempt. jobId =
 * log-group-setup-<attemptId>, so a repeated OWNER confirmation of the same
 * attempt never creates a second provisioning job (BullMQ deduplicates on the
 * id). Attempts/backoff live in the worker's default job options; the DB row
 * is the durable resume point, so completed/failed jobs are removed. Returns
 * false (fail-soft) when Redis is unconfigured or unreachable - the caller
 * shows a safe error and the QUEUED row can be re-enqueued.
 */
export async function enqueueLogGroupSetup(attemptId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.logGroupSetup.add(
        LOG_GROUP_SETUP_JOB_NAME,
        { attemptId },
        {
          jobId: logGroupSetupJobId(attemptId),
          attempts: 3,
          backoff: { type: "exponential", delay: 15_000 },
        },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("log group setup enqueue failed", { attemptId, error: errorText(err) });
    return false;
  }
}

/**
 * Analytics phase (Phase 4): the AFTER-COMMIT attribution hook. Enqueues the
 * evidence-based attribution evaluation of ONE completed Order onto the worker's
 * notification-maintenance queue, carrying ONLY the orderId (never revenue, user
 * or notification data). jobId = per-order (idempotent), so repeated dispatches
 * of the same completed order collapse onto one job; the `orderId @unique`
 * attribution row is the durable convergence anchor regardless. Fail-soft: Redis
 * unconfigured/unreachable returns false and the periodic batch reconciler picks
 * the order up later — payment fulfillment must never wait on or fail because of
 * analytics. NEVER call inside the payment transaction (this runs after commit).
 */
export async function enqueueAttributionReconcile(orderId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.notifMaintenance.add(
        NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION,
        { orderId },
        { jobId: attributionReconcileJobId(orderId), removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("attribution reconcile enqueue failed", { orderId, error: errorText(err) });
    return false;
  }
}

/**
 * Analytics phase (Phase 4): OWNER-triggered manual attribution reconcile. Kicks
 * the batch sweep + reversal reconciler once (jobId-deduped so a double-tap can't
 * stack runs). Fail-soft: returns false when Redis is unavailable.
 */
export async function enqueueAttributionBatchNow(): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      Promise.all([
        pair.notifMaintenance.add(
          NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH,
          {},
          { jobId: "attribution-batch-manual", removeOnComplete: true, removeOnFail: true },
        ),
        pair.notifMaintenance.add(
          NOTIFICATION_JOB_NAMES.RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS,
          {},
          { jobId: "attribution-reversals-manual", removeOnComplete: true, removeOnFail: true },
        ),
      ]),
    );
    return true;
  } catch (err) {
    logger.warn("attribution manual reconcile enqueue failed", { error: errorText(err) });
    return false;
  }
}

/**
 * Wallet auto-renewal (Phase 1): OWNER-triggered manual SCAN. Enqueues one
 * SCAN_WALLET_AUTO_RENEWALS job onto the worker's control queue (jobId-deduped
 * so a double-tap can't stack scans). The worker still no-ops the scan while
 * the master switch is off, so this can never charge behind a disabled system.
 * Fail-soft: returns false when Redis is unavailable.
 */
export async function enqueueAutoRenewalScanNow(): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.autoRenewalControl.add(
        AUTO_RENEWAL_JOB_NAMES.SCAN_WALLET_AUTO_RENEWALS,
        {},
        { jobId: "war-scan-manual", removeOnComplete: true, removeOnFail: true },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("auto-renewal manual scan enqueue failed", { error: errorText(err) });
    return false;
  }
}

/**
 * OWNER manual reconcile (Part Q): enqueues the transaction / expiration / refund
 * reconcile jobs onto the worker-owned stars-subscription queue and returns
 * immediately (the worker scans Telegram — never the callback). Fixed job ids
 * prevent a duplicate active manual run while one is queued.
 */
export async function enqueueStarsSubscriptionReconcileNow(): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      Promise.all([
        pair.starsSubscriptionControl.add(
          STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS,
          {},
          { jobId: "stars-sub-tx-manual", removeOnComplete: true, removeOnFail: true },
        ),
        pair.starsSubscriptionControl.add(
          STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_EXPIRATIONS,
          {},
          { jobId: "stars-sub-exp-manual", removeOnComplete: true, removeOnFail: true },
        ),
        pair.starsSubscriptionControl.add(
          STARS_SUBSCRIPTION_JOB_NAMES.RECONCILE_STARS_SUBSCRIPTION_REFUNDS,
          {},
          { jobId: "stars-sub-refund-manual", removeOnComplete: true, removeOnFail: true },
        ),
      ]),
    );
    return true;
  } catch (err) {
    logger.warn("stars subscription manual reconcile enqueue failed", { error: errorText(err) });
    return false;
  }
}

/**
 * Referral financial-safety phase: the AFTER-COMMIT durable credit hook. Enqueues
 * the idempotent commission credit of ONE completed Order onto the bot-consumed
 * referral execute queue, carrying ONLY the orderId. jobId = per-order, so a
 * re-fired dispatch collapses onto one job; the unique orderId commission row is
 * the durable convergence anchor regardless. Bounded retries with backoff make a
 * transient DB error recover automatically; the periodic worker credit scan is the
 * catch-all for a Redis flush / missed enqueue. Fail-soft: Redis unavailable
 * returns false and the scan picks the order up later. NEVER call inside the
 * payment transaction (runs after commit).
 */
export async function enqueueReferralCredit(orderId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.referralExecute.add(
        REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION,
        { orderId },
        {
          jobId: referralCreditJobId(orderId),
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { age: 24 * 3600 },
        },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("referral credit enqueue failed", { corr: referralCorrelationHash(orderId), error: errorText(err) });
    return false;
  }
}

/**
 * Durable referral reversal hook: enqueues the clawback of ONE refunded order's
 * commission onto the bot-consumed execute queue (orderId only). jobId = per-order.
 * Fail-soft; the worker reversal scan is the authoritative catch-all, so a lost
 * enqueue is recovered.
 */
export async function enqueueReferralReverse(orderId: string): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      pair.referralExecute.add(
        REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION,
        { orderId },
        {
          jobId: referralReverseJobId(orderId),
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { age: 24 * 3600 },
        },
      ),
    );
    return true;
  } catch (err) {
    logger.warn("referral reverse enqueue failed", { corr: referralCorrelationHash(orderId), error: errorText(err) });
    return false;
  }
}

/**
 * OWNER-triggered manual referral reconcile: kicks the credit, reversal and debt-
 * recovery scans once (jobId-deduped so a double-tap can't stack runs). The worker
 * no-ops every scan while the master switch is off, so this can never pay behind a
 * disabled system. Fail-soft: returns false when Redis is unavailable.
 */
export async function enqueueReferralReconcileNow(): Promise<boolean> {
  const pair = getQueues();
  if (pair === null) {
    return false;
  }
  try {
    await withTimeout(
      Promise.all([
        pair.referralControl.add(REFERRAL_JOB_NAMES.SCAN_REFERRAL_CREDITS, {}, { jobId: "ref-credits-manual", removeOnComplete: true, removeOnFail: true }),
        pair.referralControl.add(REFERRAL_JOB_NAMES.SCAN_REFERRAL_REVERSALS, {}, { jobId: "ref-reversals-manual", removeOnComplete: true, removeOnFail: true }),
        pair.referralControl.add(REFERRAL_JOB_NAMES.RECOVER_REFERRAL_DEBTS, {}, { jobId: "ref-recovery-manual", removeOnComplete: true, removeOnFail: true }),
      ]),
    );
    return true;
  } catch (err) {
    logger.warn("referral manual reconcile enqueue failed", { error: errorText(err) });
    return false;
  }
}

/** Reads the worker-published referral reconciliation status snapshot; null on any error. */
export async function readReferralWorkerStatus(): Promise<ReferralWorkerStatus | null> {
  const redis = getReader();
  if (redis === null) {
    return null;
  }
  try {
    const raw = await withTimeout(redis.get(REFERRAL_WORKER_STATUS_KEY));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const v = parsed as Record<string, unknown>;
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      enabled: v.enabled === true,
      lastScanAt: typeof v.lastScanAt === "string" ? v.lastScanAt : null,
      creditScanEnqueued: num(v.creditScanEnqueued),
      reversalScanEnqueued: num(v.reversalScanEnqueued),
      recoveryScanEnqueued: num(v.recoveryScanEnqueued),
      paidCount: num(v.paidCount),
      reversedCount: num(v.reversedCount),
      reversalPendingCount: num(v.reversalPendingCount),
      reversalPendingOutstandingToman: num(v.reversalPendingOutstandingToman),
      executeFailures: num(v.executeFailures),
      checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Reads the referral EXECUTE consumer liveness heartbeat (bot process). The key
 * carries a TTL, so its presence already means "the consumer that moves the money
 * is alive recently". Returns null when absent or Redis is unavailable.
 */
export async function readReferralExecuteHeartbeat(): Promise<WorkerHeartbeat | null> {
  const redis = getReader();
  if (redis === null) {
    return null;
  }
  try {
    const raw = await withTimeout(redis.get(REFERRAL_EXECUTE_HEARTBEAT_KEY));
    if (raw === null) {
      return null;
    }
    const millis = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(millis)) {
      return { at: null, ageSeconds: null };
    }
    return { at: new Date(millis), ageSeconds: Math.max(0, Math.round((Date.now() - millis) / 1000)) };
  } catch {
    return null;
  }
}

/** Waiting+active+failed counts for the log-group-setup queue (status page). */
export async function getLogGroupSetupQueueCounts(): Promise<BackupQueueCounts | null> {
  const pair = getQueues();
  if (pair === null) {
    return null;
  }
  try {
    const counts = await withTimeout(
      pair.logGroupSetup.getJobCounts("waiting", "active", "delayed", "failed"),
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch (err) {
    logger.warn("log group setup queue counts failed", { error: errorText(err) });
    return null;
  }
}

// --- worker heartbeat / capabilities (read-only ioredis client) --------------------------------

let reader: Redis | null = null;
let readerFingerprint = "";

function getReader(): Redis | null {
  const options = getRedisOptions();
  if (options === null) {
    return null;
  }
  const fingerprint = `${options.host}:${options.port}`;
  if (reader !== null && readerFingerprint === fingerprint) {
    return reader;
  }
  if (reader !== null) {
    reader.disconnect();
    reader = null;
  }
  const redis = new Redis({
    host: options.host,
    port: options.port,
    password: options.password,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    // Fail fast: health/status reads must never block an admin page.
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on("error", (err) => {
    logger.debug("ops redis reader error", { error: errorText(err) });
  });
  reader = redis;
  readerFingerprint = fingerprint;
  return reader;
}

export interface WorkerHeartbeat {
  /** Parsed heartbeat time; null when the stored value is not a timestamp. */
  at: Date | null;
  /** Seconds since the heartbeat; null when the value was unparseable. */
  ageSeconds: number | null;
}

/**
 * Reads the worker liveness key. The key carries a TTL, so its PRESENCE
 * already means "alive recently" even when the value cannot be parsed.
 * Returns null when the key is absent or Redis is unavailable.
 */
export async function readWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  const redis = getReader();
  if (redis === null) {
    return null;
  }
  try {
    const raw = await withTimeout(redis.get(WORKER_HEARTBEAT_KEY));
    if (raw === null) {
      return null;
    }
    const millis = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(millis)) {
      return { at: null, ageSeconds: null };
    }
    return {
      at: new Date(millis),
      ageSeconds: Math.max(0, Math.round((Date.now() - millis) / 1000)),
    };
  } catch {
    return null;
  }
}

/**
 * Reads the worker-published notification-engine status snapshot (the live view
 * behind the admin notification page). Mirrors readWorkerHeartbeat: the JSON is
 * parsed defensively and any absence/parse error becomes null - the admin page
 * must never crash or hang on a missing/malformed key. The key carries the
 * heartbeat TTL, so caller freshness is judged from the parsed checkedAt.
 */
export async function readNotificationWorkerStatus(): Promise<NotificationWorkerStatus | null> {
  const redis = getReader();
  if (redis === null) {
    return null;
  }
  try {
    const raw = await withTimeout(redis.get(NOTIFICATION_WORKER_STATUS_KEY));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    return {
      schedulerActive: value.schedulerActive === true,
      lastServiceSyncAt:
        typeof value.lastServiceSyncAt === "string" ? value.lastServiceSyncAt : null,
      lastServiceScanAt:
        typeof value.lastServiceScanAt === "string" ? value.lastServiceScanAt : null,
      deliveryWaiting: typeof value.deliveryWaiting === "number" ? value.deliveryWaiting : 0,
      deliveryFailed: typeof value.deliveryFailed === "number" ? value.deliveryFailed : 0,
      deadLetter: typeof value.deadLetter === "number" ? value.deadLetter : 0,
      checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
      // Checkout-payment reminders (Phase 2). Optional so a Phase-1 worker's
      // snapshot still parses; the admin page renders "نامشخص" / 0 when absent.
      lastCheckoutScanAt:
        typeof value.lastCheckoutScanAt === "string" ? value.lastCheckoutScanAt : null,
      abandonedCheckoutCandidates:
        typeof value.abandonedCheckoutCandidates === "number"
          ? value.abandonedCheckoutCandidates
          : 0,
      paymentRetryCandidates:
        typeof value.paymentRetryCandidates === "number" ? value.paymentRetryCandidates : 0,
      // Customer win-back (Phase 3). Optional so an older worker's snapshot still
      // parses; the admin win-back page renders "نامشخص" when absent.
      lastRetentionScanAt:
        typeof value.lastRetentionScanAt === "string" ? value.lastRetentionScanAt : null,
    };
  } catch {
    return null;
  }
}

/** Reads the worker-published capability snapshot; null on any error. */
export async function readWorkerCapabilities(): Promise<WorkerCapabilities | null> {
  const redis = getReader();
  if (redis === null) {
    return null;
  }
  try {
    const raw = await withTimeout(redis.get(WORKER_CAPABILITIES_KEY));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    return {
      pgDumpVersion: typeof value.pgDumpVersion === "string" ? value.pgDumpVersion : null,
      backupDirWritable: value.backupDirWritable === true,
      backupDir: typeof value.backupDir === "string" ? value.backupDir : "",
      // Baked image build identity; older workers do not publish it yet.
      gitSha: typeof value.gitSha === "string" ? value.gitSha : null,
      checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    };
  } catch {
    return null;
  }
}

export interface BackupQueueCounts {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

/** Backup-queue depth for the health page; null when Redis is unavailable. */
export async function getBackupQueueCounts(): Promise<BackupQueueCounts | null> {
  const pair = getQueues();
  if (pair === null) {
    return null;
  }
  try {
    const counts = await withTimeout(
      pair.backup.getJobCounts("waiting", "active", "failed", "delayed"),
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch (err) {
    logger.debug("backup queue counts unavailable", { error: errorText(err) });
    return null;
  }
}

export interface OpsRedisPing {
  ok: boolean;
  latencyMs: number | null;
}

/** One real PING with latency for the health page. Never throws. */
export async function pingOpsRedis(): Promise<OpsRedisPing> {
  const redis = getReader();
  if (redis === null) {
    return { ok: false, latencyMs: null };
  }
  const startedAt = Date.now();
  try {
    await withTimeout(redis.ping());
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: null };
  }
}
