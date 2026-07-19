import { createHash } from "node:crypto";

import { prisma } from "@zedbot/database";
import {
  STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES,
  STARS_SUB_ENROLLMENT_CLOCK_SKEW_MS,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
  createLogger,
  errorMessage,
  parseStarsSubscriptionPayload,
  starsSubscriptionExecuteJobId,
  type StarsSubscriptionConfig,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { botToken } from "../config.js";
import { getStarTransactions, type WorkerStarTransaction } from "../telegram.js";

// =============================================================================
// getStarTransactions recovery (Phase 2.1, Parts E/F/G/H). Bounded, offset-paged
// scan that recovers ONLY exact `zedbot:sub:` invoice-payment transactions whose
// payload resolves to a local subscription, whose user + amount + period match the
// frozen contract, and which have no local charge yet. Each recoverable transaction
// is handed to the bot-consumed settlement job (idempotent on the Telegram charge
// id) — the worker never renews a Service or mutates money directly. The cursor is
// coordination only; the unique charge id is the sole financial authority.
// =============================================================================

const logger = createLogger("worker:stars-recovery");

export interface RecoveryCounters {
  transactionsChecked: number;
  chargesRecovered: number;
  refundsConfirmed: number;
  requiresReview: number;
  pagesProcessed: number;
}

function emptyCounters(): RecoveryCounters {
  return {
    transactionsChecked: 0,
    chargesRecovered: 0,
    refundsConfirmed: 0,
    requiresReview: 0,
    pagesProcessed: 0,
  };
}

/** One-way short hash of a transaction id (the cursor stores NO raw charge id). */
function hashTransactionId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

async function loadOrCreateCursor(): Promise<{
  nextOffset: number;
  bootstrapCompleted: boolean;
  consecutiveFailureCount: number;
}> {
  const existing = await prisma.telegramStarsReconciliationCursor.findUnique({
    where: { singletonKey: "default" },
  });
  if (existing !== null) {
    return {
      nextOffset: existing.nextOffset,
      bootstrapCompleted: existing.bootstrapCompleted,
      consecutiveFailureCount: existing.consecutiveFailureCount,
    };
  }
  const created = await prisma.telegramStarsReconciliationCursor.upsert({
    where: { singletonKey: "default" },
    create: { singletonKey: "default", bootstrapStartedAt: new Date() },
    update: {},
  });
  return {
    nextOffset: created.nextOffset,
    bootstrapCompleted: created.bootstrapCompleted,
    consecutiveFailureCount: created.consecutiveFailureCount,
  };
}

/** True for an incoming Stars subscription payment transaction (Part F). */
function isSubscriptionPayment(tx: WorkerStarTransaction): boolean {
  const s = tx.source;
  return (
    s !== undefined &&
    s.type === "user" &&
    s.transaction_type === "invoice_payment" &&
    typeof s.invoice_payload === "string" &&
    s.invoice_payload.startsWith("zedbot:sub:") &&
    s.subscription_period === STARS_SUBSCRIPTION_PERIOD_SECONDS &&
    tx.amount > 0
  );
}

/**
 * Attempts to recover ONE lost subscription payment. Enqueues a bot-consumed
 * settlement job when (and only when) the payload resolves to a local subscription
 * whose user + amount match and which has no local charge for this Telegram id.
 * Returns "recovered" | "ignored" | "review".
 */
async function tryRecoverPayment(
  executeQueue: Queue,
  tx: WorkerStarTransaction,
): Promise<"recovered" | "ignored" | "review"> {
  const payloadId = parseStarsSubscriptionPayload(tx.source?.invoice_payload ?? "");
  if (payloadId === null) {
    return "ignored";
  }
  const sub = await prisma.telegramStarsServiceSubscription.findUnique({
    where: { publicPayloadId: payloadId },
  });
  // Never fabricate a subscription from Telegram history (Part E).
  if (sub === null) {
    return "ignored";
  }
  const user = await prisma.user.findUnique({ where: { id: sub.userId } });
  const sourceUserId = tx.source?.user?.id;
  if (user === null || sourceUserId === undefined || user.telegramId !== BigInt(sourceUserId)) {
    return "ignored"; // wrong user — never cross-apply
  }
  if (tx.amount !== sub.starsAmount) {
    return "review"; // amount mismatch — surface, never settle
  }
  // The transaction must not precede enrollment beyond a small clock-skew slack.
  if (tx.date * 1000 < sub.createdAt.getTime() - STARS_SUB_ENROLLMENT_CLOCK_SKEW_MS) {
    return "ignored";
  }
  // Already have a local charge for this Telegram id → idempotent no-op (the live
  // path or a prior recovery owns it; the unique charge id is the authority).
  const existingCharge = await prisma.telegramStarsSubscriptionCharge.findUnique({
    where: { telegramPaymentChargeId: tx.id },
    select: { id: true },
  });
  if (existingCharge !== null) {
    return "ignored";
  }
  // Conservative first-vs-recurring: the FIRST charge only when the subscription
  // has no authoritative first charge id AND no settled/settling charge yet.
  const settledCount = await prisma.telegramStarsSubscriptionCharge.count({
    where: { subscriptionId: sub.id, status: { in: ["SETTLING", "FULFILLING", "COMPLETED"] } },
  });
  const isFirstRecurring = sub.initialTelegramPaymentChargeId === null && settledCount === 0;
  await executeQueue.add(
    STARS_SUBSCRIPTION_EXECUTE_JOB_NAMES.SETTLE_RECOVERED_CHARGE,
    {
      subscriptionId: sub.id,
      telegramPaymentChargeId: tx.id,
      starsAmount: tx.amount,
      telegramTransactionAtSec: tx.date,
      isFirstRecurring,
    },
    {
      jobId: starsSubscriptionExecuteJobId("settle", tx.id),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3600 },
    },
  );
  logger.info("stars subscription payment recovered", { first: isFirstRecurring });
  return "recovered";
}

/** True for an outgoing (refund/withdrawal) transaction to a user (Part H). */
function isOutgoingRefund(tx: WorkerStarTransaction): boolean {
  const r = tx.receiver;
  return (
    r !== undefined &&
    r.type === "user" &&
    typeof r.invoice_payload === "string" &&
    r.invoice_payload.startsWith("zedbot:sub:")
  );
}

/**
 * Confirms an externally-observed refund ONLY when it matches an existing local
 * charge whose subscription + user are consistent and which is REFUND_PENDING or
 * already REFUNDED (idempotent). Unknown outgoing transactions are ignored — never
 * classified as a subscription refund (Part H).
 */
async function tryReconcileRefund(tx: WorkerStarTransaction): Promise<boolean> {
  const payloadId = parseStarsSubscriptionPayload(tx.receiver?.invoice_payload ?? "");
  if (payloadId === null) {
    return false;
  }
  const sub = await prisma.telegramStarsServiceSubscription.findUnique({
    where: { publicPayloadId: payloadId },
    select: { id: true, userId: true },
  });
  if (sub === null) {
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: sub.userId }, select: { telegramId: true } });
  const receiverUserId = tx.receiver?.user?.id;
  if (user === null || receiverUserId === undefined || user.telegramId !== BigInt(receiverUserId)) {
    return false;
  }
  // Match an outstanding refund by subscription + amount. Confirm exactly once.
  const claimed = await prisma.telegramStarsSubscriptionCharge.updateMany({
    where: { subscriptionId: sub.id, starsAmount: tx.amount, status: "REFUND_PENDING" },
    data: { status: "REFUNDED", refundedAt: new Date(), safeErrorCode: null },
  });
  return claimed.count > 0;
}

export interface RecoveryDeps {
  executeQueue: Queue;
}

/**
 * Runs one bounded transaction-recovery pass. During bootstrap it pages forward
 * from the persisted offset (advancing it) until a short page; in steady state it
 * re-scans the most recent pages from offset 0 (new transactions prepend) so lost
 * live updates are caught, bounded by lookback + maxPagesPerRun. On any API failure
 * it records the failure WITHOUT resetting the cursor.
 */
export async function runStarsTransactionRecovery(
  deps: RecoveryDeps,
  config: StarsSubscriptionConfig,
): Promise<RecoveryCounters & { cursorStale: boolean; nextOffset: number }> {
  const counters = emptyCounters();
  const token = botToken();
  if (token === null) {
    logger.warn("stars recovery skipped: no bot token");
    return { ...counters, cursorStale: false, nextOffset: 0 };
  }

  const cursor = await loadOrCreateCursor();
  const bootstrap = !cursor.bootstrapCompleted;
  let persistentOffset = cursor.nextOffset;
  let runOffset = bootstrap ? cursor.nextOffset : 0;
  const lookbackMs = config.transactionLookbackHours * 3_600_000;
  const oldestRelevant = Date.now() - lookbackMs;
  let cursorStale = false;
  let bootstrapCompletedNow = false;

  for (let page = 0; page < config.maxPagesPerRun; page += 1) {
    const res = await getStarTransactions({
      token,
      offset: runOffset,
      limit: config.transactionPageSize,
    });
    if (!res.ok) {
      // Do NOT reset the cursor after an API error (Part E).
      await prisma.telegramStarsReconciliationCursor.update({
        where: { singletonKey: "default" },
        data: {
          lastFailedRunAt: new Date(),
          consecutiveFailureCount: { increment: 1 },
          safeLastErrorCode: res.safeErrorCode,
        },
      });
      cursorStale = true;
      break;
    }

    let oldestDateSec = Number.POSITIVE_INFINITY;
    let newestTx: WorkerStarTransaction | null = null;
    for (const tx of res.transactions) {
      counters.transactionsChecked += 1;
      oldestDateSec = Math.min(oldestDateSec, tx.date);
      if (newestTx === null || tx.date > newestTx.date) {
        newestTx = tx;
      }
      try {
        if (isSubscriptionPayment(tx)) {
          const outcome = await tryRecoverPayment(deps.executeQueue, tx);
          if (outcome === "recovered") counters.chargesRecovered += 1;
          else if (outcome === "review") counters.requiresReview += 1;
        } else if (isOutgoingRefund(tx)) {
          if (await tryReconcileRefund(tx)) counters.refundsConfirmed += 1;
        }
        // Everything else (one-time zedbot:pay:, paid media, gifts, premium,
        // unknown) is deliberately ignored.
      } catch (err) {
        logger.warn("stars recovery transaction failed", { error: errorMessage(err) });
      }
    }
    counters.pagesProcessed += 1;

    if (bootstrap) {
      persistentOffset = cursor.nextOffset + counters.transactionsChecked;
    }
    await prisma.telegramStarsReconciliationCursor.update({
      where: { singletonKey: "default" },
      data: {
        nextOffset: persistentOffset,
        lastTransactionAt: newestTx === null ? undefined : new Date(newestTx.date * 1000),
        lastTransactionIdHash: newestTx === null ? undefined : hashTransactionId(newestTx.id),
        lastSuccessfulRunAt: new Date(),
        consecutiveFailureCount: 0,
        safeLastErrorCode: null,
        ...(bootstrap && res.transactions.length < config.transactionPageSize
          ? { bootstrapCompleted: true }
          : {}),
      },
    });

    runOffset += res.transactions.length;
    const shortPage = res.transactions.length < config.transactionPageSize;
    if (shortPage) {
      if (bootstrap) bootstrapCompletedNow = true;
      break;
    }
    // Steady state: stop once we have paged past the lookback window.
    if (!bootstrap && oldestDateSec * 1000 < oldestRelevant) {
      break;
    }
  }

  if (bootstrapCompletedNow) {
    logger.info("stars recovery bootstrap complete");
  }
  return { ...counters, cursorStale, nextOffset: persistentOffset };
}
