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
// The intent says WHAT happened; this decides WHO still has to be told, WHEN
// anyone tries, and makes sure two workers never try the same thing at once.
// Sending is not here — it needs a bot token, and a package the API imports
// must not be able to reach Telegram.
//
// TWO LEVELS, BECAUSE ONE WAS WRONG. The first version marked the whole intent
// SENT as soon as any administrator was reached. That made one administrator's
// success erase every other administrator's failure: with three administrators
// and two failing sends, the event was recorded as delivered and the two who
// never heard about the ticket had no row anywhere saying so. The contract is
// that ACTIVE ADMINISTRATORS are notified, not that somebody was.
//
// So there is now one durable obligation per administrator, and the intent is
// only an aggregate over them. A retry sends to the recipients that failed, not
// to the ones that succeeded.
//
// THE GUARANTEE IS STILL AT-LEAST-ONCE, per recipient. Exactly-once across a
// process boundary and a third-party API is not available: the send happens
// either before the row is marked sent or after, and a crash in that window
// picks the other failure. We mark AFTER sending, so the window produces a
// duplicate rather than a silent loss — telling one administrator twice is
// recoverable, never telling them is not.
//
// Duplicates stay rare rather than routine because of two things:
//
//   THE CLAIM. Every transition to SENDING is a status-guarded updateMany that
//   proceeds only if it changed exactly one row. Two workers racing means one
//   updates nothing and moves on. "Read the pending rows, then update them"
//   hands the same row to both.
//
//   THE STALE SWEEP. A process that dies mid-send leaves SENDING behind with
//   nobody to finish it, invisible to the claim query forever. A claim older
//   than the threshold is returned to PENDING. This is the ONLY path that can
//   produce a duplicate, which is why the threshold is generous.
// =============================================================================

/** One intent to work, with everything rendering needs already loaded. */
export interface DeliverableIntent {
  id: string;
  kind: string;
  attempts: number;
  ticketId: string;
  messageId: string;
}

/** One administrator still owed this event. */
export interface DeliverableRecipient {
  id: string;
  adminId: string;
  attempts: number;
  /** Read from the Admin row at claim time; never stored on the obligation. */
  adminChatId: string;
}

// --- intent-level claiming ---------------------------------------------------

const CLAIMABLE = {
  id: true,
  kind: true,
  attempts: true,
  ticketId: true,
  messageId: true,
} as const;

/**
 * Claim up to `limit` due intents, atomically, one at a time.
 *
 * One row per statement rather than a bulk update because a bulk `updateMany`
 * cannot report WHICH rows it took, and a worker that claims rows it cannot
 * then identify has claimed them for nobody.
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
    select: CLAIMABLE,
  });

  for (const candidate of candidates) {
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
 * A caller that gets null must NOT send: something else already owns it.
 */
export async function claimIntentForTicket(
  ticketId: string,
  kind: SupportNotificationKind,
  now: Date = new Date(),
): Promise<DeliverableIntent | null> {
  const candidate = await prisma.supportNotificationIntent.findFirst({
    where: { ticketId, kind, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: CLAIMABLE,
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

// --- fan-out -----------------------------------------------------------------

/**
 * Materialize one obligation per currently-active administrator.
 *
 * Called when a worker holds the intent claim, NOT when the ticket is written:
 * a ticket write must not depend on reading the administrator table, and the
 * API — which has no business knowing who the administrators are — writes
 * tickets too.
 *
 * DELIBERATE CONSEQUENCE, DOCUMENTED: an administrator added AFTER an event was
 * first picked up gets no obligation for it. Promoting someone notifies them
 * about what happens next, not about the backlog. The alternative — expanding
 * against the live administrator set on every retry — would mean a new
 * administrator receives a burst of old tickets on their first day, and would
 * make "was this event delivered?" unanswerable, because the answer would
 * depend on when it was asked.
 *
 * Idempotent: re-running on a retry creates nothing new (the unique constraint
 * decides) and leaves already-terminal obligations untouched.
 */
export async function expandRecipients(intentId: string): Promise<number> {
  const admins = await prisma.admin.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  if (admins.length === 0) {
    return 0;
  }
  const created = await prisma.supportNotificationRecipient.createMany({
    data: admins.map((admin) => ({ intentId, adminId: admin.id })),
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Claim the obligations of this intent that are due, one at a time.
 *
 * The administrator's chat id is read HERE, from the Admin row, and returned to
 * the caller in memory. It is never written onto the obligation, so it cannot
 * go stale, cannot leak through a dump of this table, and cannot end up in a
 * queue payload.
 *
 * An administrator deactivated since the fan-out is marked SKIPPED rather than
 * claimed: that is terminal but not a failure, because no number of retries
 * will make a deactivated administrator deliverable.
 */
export async function claimDueRecipients(
  intentId: string,
  now: Date = new Date(),
): Promise<DeliverableRecipient[]> {
  const candidates = await prisma.supportNotificationRecipient.findMany({
    where: {
      intentId,
      status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      adminId: true,
      attempts: true,
      admin: { select: { telegramId: true, isActive: true } },
    },
  });

  const claimed: DeliverableRecipient[] = [];
  for (const candidate of candidates) {
    if (!candidate.admin.isActive) {
      await prisma.supportNotificationRecipient.updateMany({
        where: { id: candidate.id, status: "PENDING" },
        data: { status: "SKIPPED", claimedAt: null, safeErrorCode: "admin-inactive" },
      });
      continue;
    }
    const won = await prisma.supportNotificationRecipient.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "SENDING", claimedAt: now, attempts: { increment: 1 } },
    });
    if (won.count === 1) {
      claimed.push({
        id: candidate.id,
        adminId: candidate.adminId,
        attempts: candidate.attempts + 1,
        adminChatId: candidate.admin.telegramId.toString(),
      });
    }
  }
  return claimed;
}

/** One administrator was told. Terminal, and never re-sent. */
export async function markRecipientSent(
  recipientId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.supportNotificationRecipient.updateMany({
    where: { id: recipientId, status: "SENDING" },
    data: { status: "SENT", sentAt: now, claimedAt: null, safeErrorCode: null },
  });
}

/**
 * One administrator was not told: retry with backoff, or park after enough
 * attempts.
 *
 * A parked FAILED obligation stays in the table on purpose. "Nobody told Ali
 * about ticket 1a2b3c4d" is exactly the thing an operator needs to be able to
 * find later, and deleting it would make the outbox look healthy.
 */
export async function markRecipientFailed(
  recipientId: string,
  attempts: number,
  safeErrorCode: string,
  now: Date = new Date(),
): Promise<void> {
  const exhausted = attempts >= NOTIFICATION_MAX_ATTEMPTS;
  await prisma.supportNotificationRecipient.updateMany({
    where: { id: recipientId, status: "SENDING" },
    data: {
      status: exhausted ? "FAILED" : "PENDING",
      claimedAt: null,
      safeErrorCode,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + notificationRetryDelayMs(attempts)),
    },
  });
}

// --- settling the aggregate --------------------------------------------------

export interface IntentOutcome {
  /** True when every obligation reached a terminal state. */
  complete: boolean;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

/**
 * Recompute the intent from its obligations and settle it if they are all done.
 *
 * COMPLETION IS AN AGGREGATE, not a first-success. The intent becomes SENT only
 * when every obligation is terminal and at least one administrator was actually
 * reached; FAILED when every obligation is terminal and none was. While
 * anything is still retryable the intent goes back to PENDING with backoff, so
 * the sweep picks it up and works the remaining obligations — and only those.
 *
 * An intent with NO obligations at all (no active administrators) is complete
 * immediately: there is nobody to tell, and leaving it PENDING forever would
 * make the backlog gauge alarm on an empty administrator table.
 */
export async function settleIntent(
  intentId: string,
  intentAttempts: number,
  now: Date = new Date(),
): Promise<IntentOutcome> {
  const counts = await prisma.supportNotificationRecipient.groupBy({
    by: ["status"],
    where: { intentId },
    _count: { _all: true },
  });
  const by = (status: string): number =>
    counts.find((c) => c.status === status)?._count._all ?? 0;

  const sent = by("SENT");
  const failed = by("FAILED");
  const skipped = by("SKIPPED");
  const pending = by("PENDING") + by("SENDING");
  const complete = pending === 0;

  if (!complete) {
    const exhausted = intentAttempts >= NOTIFICATION_MAX_ATTEMPTS;
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId, status: "SENDING" },
      data: {
        // Not FAILED even when the intent's own attempts run out: the
        // obligations carry the real state, and parking the aggregate would
        // strand recipients that are still retryable.
        status: "PENDING",
        claimedAt: null,
        nextAttemptAt: exhausted
          ? new Date(now.getTime() + notificationRetryDelayMs(NOTIFICATION_MAX_ATTEMPTS))
          : new Date(now.getTime() + notificationRetryDelayMs(intentAttempts)),
      },
    });
    return { complete, sent, failed, skipped, pending };
  }

  const reachedSomeone = sent > 0 || sent + failed + skipped === 0;
  await prisma.supportNotificationIntent.updateMany({
    where: { id: intentId, status: "SENDING" },
    data: {
      status: reachedSomeone ? "SENT" : "FAILED",
      sentAt: now,
      claimedAt: null,
      nextAttemptAt: null,
      deliveredCount: sent,
    },
  });
  return { complete, sent, failed, skipped, pending };
}

/** Release an intent claim without settling — used when rendering is impossible. */
export async function abandonIntent(
  intentId: string,
  safeErrorCode: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.supportNotificationIntent.updateMany({
    where: { id: intentId, status: "SENDING" },
    data: { status: "FAILED", claimedAt: null, nextAttemptAt: null, safeErrorCode, sentAt: now },
  });
}

// --- stale recovery ----------------------------------------------------------

/**
 * Return claims that outlived the process holding them, at BOTH levels.
 *
 * Recipients first: a recovered intent whose obligations are still stuck in
 * SENDING would be re-claimed and then find nothing due, which looks like
 * progress and is not.
 *
 * The count is worth logging — a non-zero value is the only signal that workers
 * are dying mid-send.
 */
export async function recoverStaleClaims(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_STALE_CLAIM_MS);
  const recipients = await prisma.supportNotificationRecipient.updateMany({
    where: { status: "SENDING", claimedAt: { lt: cutoff } },
    data: { status: "PENDING", claimedAt: null, nextAttemptAt: now },
  });
  const intents = await prisma.supportNotificationIntent.updateMany({
    where: { status: "SENDING", claimedAt: { lt: cutoff } },
    data: { status: "PENDING", claimedAt: null, nextAttemptAt: now },
  });
  return recipients.count + intents.count;
}

/** Operational counts, for a health page. No ticket content is read. */
export async function notificationBacklog(): Promise<{
  pending: number;
  sending: number;
  failed: number;
  recipientsPending: number;
  recipientsFailed: number;
}> {
  const [pending, sending, failed, recipientsPending, recipientsFailed] = await Promise.all([
    prisma.supportNotificationIntent.count({ where: { status: "PENDING" } }),
    prisma.supportNotificationIntent.count({ where: { status: "SENDING" } }),
    prisma.supportNotificationIntent.count({ where: { status: "FAILED" } }),
    prisma.supportNotificationRecipient.count({ where: { status: "PENDING" } }),
    prisma.supportNotificationRecipient.count({ where: { status: "FAILED" } }),
  ]);
  return { pending, sending, failed, recipientsPending, recipientsFailed };
}

// --- writing intents ---------------------------------------------------------

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
