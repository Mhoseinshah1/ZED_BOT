import { prisma, type SupportNotificationIntent } from "@zedbot/database";

import {
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_STALE_CLAIM_MS,
  notificationRetryDelayMs,
  type SupportNotificationKind,
} from "./contract.js";

// =============================================================================
// Delivering the intents.
//
// The intent says WHAT happened; this decides WHEN someone tries to tell
// support about it, and makes sure two workers never try at once. Sending
// itself is not here — it needs a bot token, and a package that the API imports
// must not be able to reach Telegram.
//
// The delivery guarantee is AT-LEAST-ONCE, deliberately. Exactly-once across a
// process boundary and a third-party API is not available: the send either
// happens before the row is marked sent or after, and whichever order is
// chosen, a crash in the gap picks the other failure. Telling support twice
// about one ticket is recoverable; never telling them is not.
//
// Two things make duplicates rare rather than routine:
//
//   THE CLAIM. A worker moves PENDING -> SENDING with a status-guarded
//   updateMany and proceeds only if it changed exactly one row. Two workers
//   racing means one of them updates nothing and moves on. This is the same
//   discipline the log-delivery sweep uses, for the same reason: "read the
//   pending rows, then update them" hands the same row to both.
//
//   THE STALE SWEEP. A process that dies mid-send leaves SENDING behind with
//   nobody to finish it. Nothing else would ever pick it up, so a claim older
//   than the threshold is returned to PENDING. This is the ONLY path that can
//   produce a duplicate, which is why the threshold is generous.
// =============================================================================

/** One intent to deliver, with everything rendering needs already loaded. */
export interface DeliverableIntent {
  id: string;
  kind: string;
  attempts: number;
  ticketId: string;
  messageId: string;
}

/**
 * Claim up to `limit` due intents, atomically, one at a time.
 *
 * Claimed one row per statement rather than in a bulk update because a bulk
 * `updateMany` cannot report WHICH rows it took — and a worker that claims rows
 * it cannot then identify has claimed them for nobody.
 */
export async function claimDueIntents(
  limit: number,
  now: Date = new Date(),
): Promise<DeliverableIntent[]> {
  const claimed: DeliverableIntent[] = [];
  const candidates = await prisma.supportNotificationIntent.findMany({
    where: {
      status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, kind: true, attempts: true, ticketId: true, messageId: true },
  });

  for (const candidate of candidates) {
    // Status-guarded: the row this worker read may already be another's.
    const won = await prisma.supportNotificationIntent.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "SENDING", claimedAt: now, attempts: { increment: 1 } },
    });
    if (won.count === 1) {
      claimed.push({ ...candidate, attempts: candidate.attempts + 1 });
    }
  }
  return claimed;
}

/**
 * Claim the pending intent for ONE ticket, so the process that just wrote it
 * can deliver without waiting for a sweep.
 *
 * Null when there is nothing to claim — no intent, or the sweep took it first.
 * A caller that gets null must NOT send: something else already owns it, and
 * sending anyway is how one ticket becomes two admin messages.
 */
export async function claimIntentForTicket(
  ticketId: string,
  kind: SupportNotificationKind,
  now: Date = new Date(),
): Promise<DeliverableIntent | null> {
  const candidate = await prisma.supportNotificationIntent.findFirst({
    where: { ticketId, kind, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, attempts: true, ticketId: true, messageId: true },
  });
  if (candidate === null) {
    return null;
  }
  const won = await prisma.supportNotificationIntent.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "SENDING", claimedAt: now, attempts: { increment: 1 } },
  });
  return won.count === 1 ? { ...candidate, attempts: candidate.attempts + 1 } : null;
}

/**
 * Return claims that outlived the process holding them.
 *
 * Returns how many were recovered so a caller can log it: a non-zero count here
 * is the signal that workers are dying mid-send, which nothing else reports.
 */
export async function recoverStaleClaims(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_STALE_CLAIM_MS);
  const recovered = await prisma.supportNotificationIntent.updateMany({
    where: { status: "SENDING", claimedAt: { lt: cutoff } },
    data: { status: "PENDING", claimedAt: null, nextAttemptAt: now },
  });
  return recovered.count;
}

/** Mark a claim delivered. `deliveredCount` is how many admins were reached. */
export async function markIntentSent(
  intentId: string,
  deliveredCount: number,
  now: Date = new Date(),
): Promise<void> {
  await prisma.supportNotificationIntent.updateMany({
    where: { id: intentId, status: "SENDING" },
    data: {
      status: "SENT",
      sentAt: now,
      claimedAt: null,
      deliveredCount,
      safeErrorCode: null,
    },
  });
}

/**
 * Mark a claim failed: retry with backoff, or park it after enough attempts.
 *
 * `safeErrorCode` is a short scrubbed marker — never a Telegram payload and
 * never ticket text. An intent that reaches FAILED stays in the table on
 * purpose: an alert nobody received is exactly the thing an operator needs to
 * be able to find later.
 */
export async function markIntentFailed(
  intentId: string,
  attempts: number,
  safeErrorCode: string,
  now: Date = new Date(),
): Promise<void> {
  const exhausted = attempts >= NOTIFICATION_MAX_ATTEMPTS;
  await prisma.supportNotificationIntent.updateMany({
    where: { id: intentId, status: "SENDING" },
    data: {
      status: exhausted ? "FAILED" : "PENDING",
      claimedAt: null,
      safeErrorCode,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + notificationRetryDelayMs(attempts)),
    },
  });
}

/** Operational counts, for a health page. No ticket content is read. */
export async function notificationBacklog(): Promise<{
  pending: number;
  sending: number;
  failed: number;
}> {
  const [pending, sending, failed] = await Promise.all([
    prisma.supportNotificationIntent.count({ where: { status: "PENDING" } }),
    prisma.supportNotificationIntent.count({ where: { status: "SENDING" } }),
    prisma.supportNotificationIntent.count({ where: { status: "FAILED" } }),
  ]);
  return { pending, sending, failed };
}

/**
 * Record an intent for a message written OUTSIDE the shared domain.
 *
 * The bot's own create/reply paths carry attachments and Telegram idempotency
 * that the shared commands do not model, so they still write their own rows —
 * but the notification must be as durable there as it is here. Callers pass
 * their transaction client so the intent lands in the SAME transaction as the
 * message; passing the global client would reintroduce exactly the gap this
 * exists to close.
 */
export type IntentWriter = {
  supportNotificationIntent: {
    create: (args: {
      data: { ticketId: string; messageId: string; kind: string };
    }) => Promise<SupportNotificationIntent>;
  };
};

export async function recordIntent(
  tx: IntentWriter,
  ticketId: string,
  messageId: string,
  kind: SupportNotificationKind,
): Promise<void> {
  await tx.supportNotificationIntent.create({ data: { ticketId, messageId, kind } });
}
