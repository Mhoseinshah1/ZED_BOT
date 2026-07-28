import { type Prisma, prisma, type SupportNotificationIntent } from "@zedbot/database";

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

// --- THE RECIPIENT-SET LINEARIZATION POINT -----------------------------------
//
// One sentence, because everything below is a consequence of it:
//
//   THE RECIPIENT SET IS THE SET OF ADMINISTRATORS ELIGIBLE AT THE INSTANT THE
//   FREEZE TRANSACTION TAKES ITS SNAPSHOT, WHICH IS THE ELIGIBILITY QUERY —
//   THE FIRST STATEMENT OF A REPEATABLE READ TRANSACTION.
//
// PostgreSQL fixes a REPEATABLE READ transaction's snapshot at its first
// statement, not at BEGIN, and every later statement in that transaction reads
// from that same snapshot. Ordering the eligibility query first therefore
// makes the linearization point both early and nameable: an administrator
// whose activation commits after it is invisible to this transaction — to the
// CAS, to the inserts, to everything — and can never appear in the set.
//
// WHY THE ORDER CHANGED. The previous version stamped first and read the
// administrator table afterwards, then claimed the stamp had frozen the set.
// Under READ COMMITTED that claim was false: each statement takes a FRESH
// snapshot, so an administrator committed between the stamp and the read was
// visible to the read and got an obligation for an event that was, by the
// code's own account, already frozen. The bug was in the reasoning, not in the
// SQL, which is why it survived tests that only checked the stamp.
//
// WHY REPEATABLE READ AS WELL as the ordering. Reading first is enough while
// eligibility is one statement. Repeatable Read is what keeps it true if it
// ever becomes two — a join, a settings lookup, a role filter — because then
// "one coherent snapshot" is enforced by the database rather than by whoever
// edits the query next. It costs one retry path, below, and buys a guarantee
// that does not decay.
//
// WHAT THE CAS STILL DECIDES. Not when the set is read — whether this read is
// the authoritative one. Exactly one transaction can move
// `recipientsExpandedAt` off NULL; the winner's snapshot becomes the set, and
// a loser discards its own snapshot without writing a single row.

/**
 * How many times a freeze is retried after a serialization failure.
 *
 * Bounded on purpose. Every retry re-reads a fresh snapshot, and a retry only
 * writes anything if the intent is STILL unfrozen — so retrying cannot widen a
 * set, but retrying forever could pin a worker on a contended row. Two
 * replicas need one retry between them; five is slack, not a strategy.
 */
const FREEZE_MAX_ATTEMPTS = 5;

/** What one freeze attempt did. */
export interface FreezeOutcome {
  /**
   * True when THIS call was the one that froze the set. False means somebody
   * else already did — the correct, expected outcome of every retry.
   */
  frozen: boolean;
  /**
   * Obligations written by this call. Zero with `frozen: true` is a real and
   * valid result: an empty eligible set is a set, frozen as such.
   */
  created: number;
}

/**
 * A serialization failure PostgreSQL raises when two Repeatable Read
 * transactions touch the same row — Prisma surfaces it as P2034, and the raw
 * SQLSTATEs (40001 serialization_failure, 40P01 deadlock_detected) can reach
 * us through raw paths. Anything else is a real error and must not be retried:
 * retrying a foreign-key violation just fails five times more slowly.
 */
function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "P2034" || code === "40001" || code === "40P01") {
    return true;
  }
  const text = err instanceof Error ? err.message.toLowerCase() : "";
  return text.includes("could not serialize") || text.includes("deadlock detected");
}

/** The eligibility query. ONE statement, and the linearization point. */
async function eligibleAdminIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const admins = await tx.admin.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return admins.map((admin) => admin.id);
}

/** The transactional body. Private: the isolation level is not optional. */
async function freezeInTransaction(
  tx: Prisma.TransactionClient,
  intentId: string,
  loadEligibleAdminIds: (tx: Prisma.TransactionClient) => Promise<string[]>,
  now: Date,
): Promise<FreezeOutcome> {
  // (1) THE SNAPSHOT. First statement, so this is where the transaction's view
  // of the database — including who is an administrator — is fixed.
  const adminIds = await loadEligibleAdminIds(tx);

  // (2) THE CAS. Does this snapshot get to be the authoritative one?
  const won = await tx.supportNotificationIntent.updateMany({
    where: { id: intentId, recipientsExpandedAt: null },
    data: { recipientsExpandedAt: now },
  });
  if (won.count === 0) {
    // Already frozen, by an earlier attempt or another replica. The set exists
    // and must not be widened, so this snapshot is discarded unused.
    return { frozen: false, created: 0 };
  }

  // (3) THE OBLIGATIONS, in the same transaction as the stamp. A failure
  // anywhere here — the insert violating a constraint, the process dying —
  // rolls back the stamp WITH the partial rows, so no state can commit in
  // which the intent claims to be expanded while holding half a fan-out. That
  // is exactly why "at least one recipient row exists" was rejected as the
  // completion signal: a partial insert would make it lie.
  if (adminIds.length === 0) {
    // Frozen EMPTY. Nobody was eligible at the snapshot, and an administrator
    // hired tomorrow is not owed yesterday's tickets.
    return { frozen: true, created: 0 };
  }
  const created = await tx.supportNotificationRecipient.createMany({
    data: adminIds.map((adminId) => ({ intentId, adminId })),
    // The unique (intentId, adminId) constraint decides duplicates. With the
    // CAS this is belt-and-braces, but it keeps a manual repair that
    // pre-created a row from failing the whole freeze.
    skipDuplicates: true,
  });
  return { frozen: true, created: created.count };
}

/**
 * Freeze one intent's recipient set, exactly once, from one coherent snapshot.
 *
 * `loadEligibleAdminIds` is a parameter rather than an inline query for two
 * reasons: a test can inject a failing or poisoned loader and prove the
 * rollback through this exact code path instead of a re-implementation, and a
 * test can pin the interleaving by waiting inside it — after the snapshot is
 * fixed, before anything is written — which is the only way to demonstrate the
 * linearization point rather than assert it in a comment.
 *
 * RETRY. A Repeatable Read transaction that loses a write race raises a
 * serialization failure instead of blocking. That is the concurrent-expander
 * case, and it is retried up to FREEZE_MAX_ATTEMPTS times with a fresh
 * snapshot each time. A retry whose CAS finds the intent already frozen
 * returns `frozen: false` and writes nothing, so retries converge on the first
 * winner's set and can never widen it. Non-serialization errors propagate on
 * the first attempt.
 */
export async function runRecipientFreeze(
  intentId: string,
  loadEligibleAdminIds: (tx: Prisma.TransactionClient) => Promise<string[]>,
  now: Date = new Date(),
): Promise<FreezeOutcome> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= FREEZE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => freezeInTransaction(tx, intentId, loadEligibleAdminIds, now),
        { isolationLevel: "RepeatableRead" },
      );
    } catch (err) {
      if (!isSerializationFailure(err)) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError;
}

/** Options for {@link expandRecipients}. */
export interface ExpandOptions {
  now?: Date;
  /**
   * Awaited AFTER the authoritative snapshot is fixed and BEFORE the CAS.
   *
   * A test seam, and a deliberate one: the guarantee under test is about an
   * instant in time inside a transaction, and no assertion made from outside
   * that transaction can pin it. A test that activates an administrator here
   * proves — through the production function, not a copy of it — that the
   * administrator is excluded.
   *
   * It receives the transaction client so a test can also assert what is true
   * AT that instant. The load-bearing one: the intent is not yet stamped. That
   * is what separates this implementation from the one it replaced, where the
   * stamp went first and the eligibility read followed it — leaving a window
   * in which the code had already declared the set frozen but had not yet read
   * it, so an administrator committing inside the window was included in a set
   * the code called sealed.
   */
  afterSnapshot?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * Materialize one obligation per administrator eligible at the snapshot.
 *
 * Called when a worker holds the intent claim, NOT when the ticket is written:
 * a ticket write must not depend on reading the administrator table, and the
 * API — which has no business knowing who the administrators are — writes
 * tickets too.
 *
 * DELIBERATE CONSEQUENCE, DOCUMENTED AND ENFORCED: an administrator whose
 * activation commits after the snapshot gets no obligation for this event, on
 * the first attempt or any retry. Promoting someone notifies them about what
 * happens next, not about the backlog — and re-reading the live set on retry
 * would also make "was this event delivered?" unanswerable, because the answer
 * would change depending on when it was asked.
 */
export async function expandRecipients(
  intentId: string,
  options: ExpandOptions = {},
): Promise<FreezeOutcome> {
  const { now = new Date(), afterSnapshot } = options;
  return runRecipientFreeze(
    intentId,
    async (tx) => {
      const ids = await eligibleAdminIds(tx);
      if (afterSnapshot !== undefined) {
        await afterSnapshot(tx);
      }
      return ids;
    },
    now,
  );
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

export interface RecoverStaleClaimsOptions {
  now?: Date;
  /**
   * Restrict recovery to the tickets named here.
   *
   * OMITTED IS THE PRODUCTION CALL: the loop sweeps everything, because a claim
   * abandoned by a process that no longer exists has nobody left to name it.
   *
   * Supplying ids is for a caller that must not touch work it does not own —
   * an operator recovering one known ticket, and any test that shares a
   * database with other suites. An unbounded sweep from such a caller would
   * un-claim rows another worker (or another suite) is in the middle of
   * sending, which is precisely the duplicate-delivery window this mechanism
   * exists to close.
   *
   * An EMPTY array recovers nothing. It means "these tickets", and there are
   * none — treating it as "everything" would turn a caller's empty filter into
   * a full-table sweep, which is the worst possible reading.
   */
  ticketIds?: readonly string[];
}

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
export async function recoverStaleClaims(
  options: RecoverStaleClaimsOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - NOTIFICATION_STALE_CLAIM_MS);
  const scope = options.ticketIds;
  const recipients = await prisma.supportNotificationRecipient.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: cutoff },
      ...(scope === undefined ? {} : { intent: { ticketId: { in: [...scope] } } }),
    },
    data: { status: "PENDING", claimedAt: null, nextAttemptAt: now },
  });
  const intents = await prisma.supportNotificationIntent.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: cutoff },
      ...(scope === undefined ? {} : { ticketId: { in: [...scope] } }),
    },
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
