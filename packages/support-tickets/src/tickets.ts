import {
  Prisma,
  prisma,
  type Service,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketStatus,
} from "@zedbot/database";
import { canonicalServicePublicId, canonicalTicketPublicId } from "@zedbot/shared";

import {
  fail,
  type IdempotentOutcome,
  idempotentRecordMatches,
  type MiniAppIdempotentOperation,
  mutationFingerprint,
  normalizeCategory,
  normalizeMessage,
  normalizeOrigin,
  normalizeRequestId,
  normalizeSubject,
  type SupportDomainResult,
  TICKET_STATUS_AFTER_CREATE,
  TICKET_STATUS_AFTER_USER_REPLY,
  userMayReply,
} from "./contract.js";

// =============================================================================
// The owner-scoped ticket operations.
//
// Four properties are load-bearing, and each is somewhere this has gone wrong:
//
//   OWNER SCOPING IS IN THE QUERY. `userId` is in every `where`, not checked
//   after the read. A post-hoc check is one early return away from being
//   skipped, and by then the row is already in memory.
//
//   AMBIGUITY IS A REFUSAL. A public id is a uuid PREFIX, so two rows can share
//   one. `take: 2` turns that into the same generic not-found a stranger's id
//   produces, rather than into "the first match".
//
//   NOTHING TRUSTS ITS CALLER. These take raw transport input and normalize it
//   here. A TypeScript interface is a compile-time claim, not a check: JSON
//   parses to `any`, and an object that satisfies the type checker can still
//   carry a 90 KB subject. The normalized values are what get persisted AND
//   what get fingerprinted, so the two can never describe different content.
//
//   IDEMPOTENCY IS RESOLVED BEFORE PRECONDITIONS. A retry must return the
//   original result even after the world moved on — the linked Service deleted,
//   the ticket closed by an admin. Re-checking preconditions first would turn a
//   successful-but-retried create into INVALID_SERVICE, which is a lie: the
//   ticket exists. The stored record answers first; only a MISMATCHED key is
//   refused.
// =============================================================================

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// --- resolution --------------------------------------------------------------

/**
 * The caller's ticket, addressed by its public id.
 *
 * Null for malformed, unknown, ambiguous AND someone else's — one outcome, so a
 * caller cannot learn from the difference whether a foreign ticket exists.
 */
export async function resolveOwnedTicket(
  userId: string,
  ticketPublicId: unknown,
): Promise<TicketWithServiceLabel | null> {
  const canonical = canonicalTicketPublicId(ticketPublicId);
  if (canonical === null) {
    return null;
  }
  const matches = await prisma.supportTicket.findMany({
    where: { id: { startsWith: canonical }, userId },
    take: 2,
    // The SAME two Service fields the list carries, for the same reason: a
    // detail screen that showed a different subset of the linked service than
    // the row the user tapped would be a second contract to keep in step.
    include: TICKET_SERVICE_LABEL,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The only Service shape a support response ever carries.
 *
 * `select` inside `include`, declared once: adding a column to Service can
 * never widen a support payload, and every route that returns a ticket returns
 * the identical pair.
 */
const TICKET_SERVICE_LABEL = {
  service: { select: { id: true, username: true } },
} as const;

/**
 * A Service the caller owns and can still see.
 *
 * The visibility rule (`deletedAt` null AND status not DELETED) is the same one
 * every Mini App service read uses. It lives here so the API and the bot cannot
 * hold different opinions about what "still exists" means.
 */
/**
 * The one owner-scoped Service lookup, usable on the global client OR inside a
 * caller's transaction.
 *
 * FOUR CONDITIONS, ALL IN THE QUERY — the authenticated `userId`, not deleted,
 * not terminally DELETED, and exactly one row matching the public prefix. A
 * foreign service, a missing one, a deleted one, an ambiguous prefix and one
 * retired a millisecond ago are indistinguishable from here on purpose: they
 * all mean "you may not link this", and telling them apart would report which
 * service ids exist.
 *
 * The `take: 2` is what makes ambiguity detectable at all. A prefix that
 * matches two rows returns neither.
 */
async function findOwnedService(
  db: Pick<typeof prisma, "service"> | Prisma.TransactionClient,
  userId: string,
  canonical: string,
): Promise<Service | null> {
  const matches = await db.service.findMany({
    where: {
      id: { startsWith: canonical },
      userId,
      deletedAt: null,
      status: { not: "DELETED" },
    },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveOwnedService(
  userId: string,
  servicePublicId: unknown,
): Promise<Service | null> {
  const canonical = canonicalServicePublicId(servicePublicId);
  if (canonical === null) {
    return null;
  }
  return findOwnedService(prisma, userId, canonical);
}

/**
 * Thrown to abort the create transaction when the Service precondition fails.
 *
 * A returned failure inside `$transaction` COMMITS — the callback resolved, so
 * Prisma commits whatever it wrote. The precondition has to roll the ticket
 * back with it, and throwing is the only thing that does that.
 */
class ServicePreconditionFailed extends Error {
  constructor() {
    super("service precondition failed");
    this.name = "ServicePreconditionFailed";
  }
}

// --- idempotency -------------------------------------------------------------

export interface IdempotentReplay {
  ticket: TicketWithServiceLabel;
  messageId: string;
}

/**
 * A prior completed attempt under this key, if it answers THIS request.
 *
 * Three outcomes, and the middle one matters: no record (proceed), a matching
 * record (replay it), or a record for a different mutation (refuse). Returning
 * the stored result for a mismatched key would answer a question nobody asked.
 */
async function replayIfCompleted(
  userId: string,
  clientRequestId: string,
  operation: MiniAppIdempotentOperation,
  targetTicketId: string | null,
  fingerprint: string,
): Promise<SupportDomainResult<IdempotentReplay> | null> {
  const stored = await prisma.miniAppRequestIdempotency.findUnique({
    where: { userId_clientRequestId: { userId, clientRequestId } },
  });
  if (stored === null) {
    return null;
  }
  const outcome: IdempotentOutcome = stored;
  if (!idempotentRecordMatches(outcome, operation, targetTicketId, fingerprint)) {
    return fail("IDEMPOTENCY_CONFLICT");
  }
  // Owner-scoped even though the key is unguessable: an idempotency key is a
  // deduplication token, never an authorisation token.
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: stored.resultTicketId, userId },
    include: TICKET_SERVICE_LABEL,
  });
  if (ticket === null) {
    return fail("TICKET_NOT_FOUND");
  }
  return { ok: true, value: { ticket, messageId: stored.resultMessageId } };
}

// --- create ------------------------------------------------------------------

export interface CreateTicketInput {
  subject: unknown;
  message: unknown;
  category: unknown;
  origin: unknown;
  servicePublicId: unknown;
  clientRequestId: unknown;
}

/**
 * A new ticket, its first USER message and its idempotency record, atomically.
 *
 * All three commit together or none do. A ticket with no message is a row an
 * admin cannot action; an idempotency record without its mutation would make a
 * retry replay something that never happened.
 */
export async function createTicket(
  userId: string,
  input: CreateTicketInput,
): Promise<SupportDomainResult<IdempotentReplay>> {
  const requestId = normalizeRequestId(input.clientRequestId);
  if (!requestId.ok) return requestId;
  const subject = normalizeSubject(input.subject);
  if (!subject.ok) return subject;
  const message = normalizeMessage(input.message);
  if (!message.ok) return message;
  const category = normalizeCategory(input.category);
  if (!category.ok) return category;
  const origin = normalizeOrigin(input.origin);
  if (!origin.ok) return origin;

  // The canonical id drives BOTH the fingerprint and the lookup, so a retry
  // that changes case is the same mutation rather than a conflict. "No service"
  // is its own canonical state, distinct from any id — linking one and linking
  // none must never fingerprint alike.
  const wantsService = input.servicePublicId !== null && input.servicePublicId !== undefined;
  const canonicalService = wantsService ? canonicalServicePublicId(input.servicePublicId) : null;
  if (wantsService && canonicalService === null) {
    return fail("INVALID_SERVICE");
  }
  const fingerprint = mutationFingerprint([
    "SUPPORT_TICKET_CREATE",
    subject.value,
    message.value,
    category.value,
    origin.value,
    canonicalService === null ? "\u0000none" : canonicalService,
  ]);

  // BEFORE preconditions: a retry must survive the Service being deleted since.
  const replay = await replayIfCompleted(
    userId,
    requestId.value,
    "SUPPORT_TICKET_CREATE",
    null,
    fingerprint,
  );
  if (replay !== null) return replay;

  try {
    return await prisma.$transaction(async (tx) => {
      // THE SERVICE IS RESOLVED HERE, INSIDE THE TRANSACTION THAT WRITES THE
      // TICKET. Resolving it beforehand left a window: a service retired
      // between the check and the insert produced a committed ticket pointing
      // at something the user may no longer link. Reading it here means the
      // row that satisfied the precondition is the row the ticket is written
      // against, under one snapshot.
      //
      // Failure THROWS rather than returns: a returned failure inside
      // $transaction resolves the callback, and Prisma commits whatever the
      // callback already wrote.
      let serviceId: string | null = null;
      if (canonicalService !== null) {
        const service = await findOwnedService(tx, userId, canonicalService);
        if (service === null) {
          throw new ServicePreconditionFailed();
        }
        serviceId = service.id;
      }

      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          subject: subject.value,
          status: TICKET_STATUS_AFTER_CREATE,
          category: category.value,
          origin: origin.value,
          serviceId,
        },
        include: TICKET_SERVICE_LABEL,
      });
      const created = await tx.supportMessage.create({
        data: {
          ticketId: ticket.id,
          senderType: "USER",
          senderUserId: userId,
          text: message.value,
        },
      });
      await tx.miniAppRequestIdempotency.create({
        data: {
          userId,
          clientRequestId: requestId.value,
          operation: "SUPPORT_TICKET_CREATE",
          targetTicketId: null,
          fingerprint,
          resultTicketId: ticket.id,
          resultMessageId: created.id,
        },
      });
      // Same transaction as the message: a committed ticket always has its
      // notification intent. The API cannot send anything itself — delivery is
      // a separate, retryable step — so recording the DECISION here is the only
      // thing that makes "support was told" survive a crash.
      await tx.supportNotificationIntent.create({
        data: {
          ticketId: ticket.id,
          messageId: created.id,
          kind: "support.ticket_created",
        },
      });
      return { ok: true as const, value: { ticket, messageId: created.id } };
    });
  } catch (err) {
    if (err instanceof ServicePreconditionFailed) {
      // The ticket, its message, its idempotency row and its notification
      // intent all rolled back with it. Foreign, missing, deleted, ambiguous
      // and just-retired are one answer.
      return fail("INVALID_SERVICE");
    }
    if (!isUniqueViolation(err)) throw err;
    // A concurrent retry of the same attempt won the unique index. Read back
    // what it wrote rather than guessing.
    const raced = await replayIfCompleted(
      userId,
      requestId.value,
      "SUPPORT_TICKET_CREATE",
      null,
      fingerprint,
    );
    if (raced !== null) return raced;
    throw err;
  }
}

// --- reply -------------------------------------------------------------------

export interface ReplyInput {
  ticketPublicId: unknown;
  message: unknown;
  clientRequestId: unknown;
}

/**
 * One USER message on an open ticket, moving it back to WAITING_ADMIN.
 *
 * The close race: an admin may close between the read that says "open" and the
 * write that appends, so the status is re-checked INSIDE the transaction with a
 * guarded `updateMany` and the reply is refused when that matches nothing. Both
 * orders end somewhere valid — reply-then-close leaves a closed ticket carrying
 * the reply; close-then-reply refuses it — and a reply is never appended to an
 * already-closed ticket.
 */
export async function replyToTicket(
  userId: string,
  input: ReplyInput,
): Promise<SupportDomainResult<IdempotentReplay>> {
  const requestId = normalizeRequestId(input.clientRequestId);
  if (!requestId.ok) return requestId;
  const message = normalizeMessage(input.message);
  if (!message.ok) return message;
  const canonicalTicket = canonicalTicketPublicId(input.ticketPublicId);
  if (canonicalTicket === null) {
    return fail("INVALID_TICKET_ID");
  }

  const ticket = await resolveOwnedTicket(userId, canonicalTicket);
  if (ticket === null) {
    return fail("TICKET_NOT_FOUND");
  }

  const fingerprint = mutationFingerprint([
    "SUPPORT_TICKET_REPLY",
    ticket.id,
    message.value,
  ]);

  // BEFORE the closed check: a retry of a reply that already succeeded must
  // return that reply even though the admin has since closed the ticket.
  const replay = await replayIfCompleted(
    userId,
    requestId.value,
    "SUPPORT_TICKET_REPLY",
    ticket.id,
    fingerprint,
  );
  if (replay !== null) return replay;

  if (!userMayReply(ticket.status)) {
    return fail("TICKET_CLOSED");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const moved = await tx.supportTicket.updateMany({
        where: { id: ticket.id, userId, status: { not: "CLOSED" } },
        data: { status: TICKET_STATUS_AFTER_USER_REPLY },
      });
      if (moved.count === 0) {
        return fail<IdempotentReplay>("TICKET_CLOSED");
      }
      const created = await tx.supportMessage.create({
        data: {
          ticketId: ticket.id,
          senderType: "USER",
          senderUserId: userId,
          text: message.value,
        },
      });
      await tx.miniAppRequestIdempotency.create({
        data: {
          userId,
          clientRequestId: requestId.value,
          operation: "SUPPORT_TICKET_REPLY",
          targetTicketId: ticket.id,
          fingerprint,
          resultTicketId: ticket.id,
          resultMessageId: created.id,
        },
      });
      await tx.supportNotificationIntent.create({
        data: {
          ticketId: ticket.id,
          messageId: created.id,
          kind: "support.user_replied",
        },
      });
      const fresh = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: TICKET_SERVICE_LABEL,
      });
      return { ok: true as const, value: { ticket: fresh, messageId: created.id } };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await replayIfCompleted(
      userId,
      requestId.value,
      "SUPPORT_TICKET_REPLY",
      ticket.id,
      fingerprint,
    );
    if (raced !== null) return raced;
    throw err;
  }
}

// --- message history ---------------------------------------------------------

export interface MessagePage {
  /** Chronological for display, oldest first WITHIN the page. */
  messages: SupportMessage[];
  /** True only when an older row actually exists. */
  hasMore: boolean;
  /** Keyset position of the oldest row returned, or null when there is no more. */
  older: { createdAt: Date; id: string } | null;
}

/**
 * The latest messages of a ticket the caller owns, paging BACKWARDS.
 *
 * OWNERSHIP IS RE-ESTABLISHED HERE, on every page. It takes a `userId` and a
 * PUBLIC id and does the owner-scoped lookup itself, because a
 * `SupportTicket` object is not proof of anything: it is a plain row that any
 * caller can construct or carry over from an earlier, unrelated check. The
 * previous signature relied on every caller remembering to have authorized
 * first, which is the post-hoc pattern the resolver exists to avoid — and a
 * cursor must never be the thing that grants access, only the thing that says
 * where to continue.
 *
 * Selected DESCENDING and reversed for display. A conversation is read from its
 * end: the first page must be the newest messages and "older" must walk
 * backwards. Selecting oldest-first would open a ticket at its beginning and
 * could never reach the end in bounded time.
 *
 * `limit + 1` rows are fetched so "is there another page?" is answered by a row
 * that actually exists. Returning a cursor whenever `rows.length === limit`
 * hands out a cursor for a page that is empty exactly when the conversation
 * length is a multiple of the page size — a bug that hides until it doesn't.
 */
export async function listOwnedTicketMessages(
  userId: string,
  ticketPublicId: unknown,
  limit: number,
  olderThan: { createdAt: Date; id: string } | null,
): Promise<MessagePage | null> {
  const ticket = await resolveOwnedTicket(userId, ticketPublicId);
  if (ticket === null) {
    // Malformed, unknown, ambiguous and foreign are one answer.
    return null;
  }
  const rows = await prisma.supportMessage.findMany({
    where:
      olderThan === null
        ? { ticketId: ticket.id }
        : {
            ticketId: ticket.id,
            OR: [
              { createdAt: { lt: olderThan.createdAt } },
              { createdAt: olderThan.createdAt, id: { lt: olderThan.id } },
            ],
          },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page.length === 0 ? null : page[page.length - 1];
  return {
    messages: page.reverse(),
    hasMore,
    older: hasMore && oldest !== null ? { createdAt: oldest.createdAt, id: oldest.id } : null,
  };
}

// --- ticket listing ----------------------------------------------------------

/**
 * A ticket with just enough of its linked Service to label it.
 *
 * The username, never the panel: a person recognises "which of my accounts is
 * this about" from the name they use to log in, and the panel a service lives
 * on is infrastructure the Support Center has no business publishing.
 */
export type TicketWithServiceLabel = SupportTicket & {
  service: { id: string; username: string } | null;
};

export interface TicketPage {
  /** Newest first — a support inbox opens on what just happened. */
  tickets: TicketWithServiceLabel[];
  /** True only when a further row actually exists. */
  hasMore: boolean;
  /** Keyset position of the last row returned, or null when there is no more. */
  next: { updatedAt: Date; id: string } | null;
}

/**
 * The caller's own tickets, newest activity first, keyset-paged.
 *
 * OWNERSHIP IS IN THE QUERY. `userId` is a WHERE clause, not a filter applied
 * to a result — there is no shape of cursor, page size or concurrent write
 * that can make this return somebody else's ticket.
 *
 * ORDERED BY `updatedAt`, NOT `createdAt`. A support list is about what needs
 * attention, and a reply on an old ticket moves it to the top. `id` breaks
 * ties, so two tickets touched in the same millisecond still have exactly one
 * ordering and a cursor can never skip or repeat one.
 *
 * `limit + 1` rows are fetched so "is there another page?" is answered by a row
 * that exists rather than inferred from `rows.length === limit`, which hands
 * out a cursor to an empty page whenever the total is a multiple of the page
 * size.
 */
export async function listOwnedTickets(
  userId: string,
  limit: number,
  after: { updatedAt: Date; id: string } | null,
): Promise<TicketPage> {
  const rows = await prisma.supportTicket.findMany({
    where:
      after === null
        ? { userId }
        : {
            userId,
            OR: [
              { updatedAt: { lt: after.updatedAt } },
              { updatedAt: after.updatedAt, id: { lt: after.id } },
            ],
          },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    // Two fields of the Service and no more. `select` rather than `include` so
    // adding a column to Service can never widen what a support list returns.
    include: { service: { select: { id: true, username: true } } },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.length === 0 ? null : page[page.length - 1];
  return {
    tickets: page,
    hasMore,
    next: hasMore && last !== null ? { updatedAt: last.updatedAt, id: last.id } : null,
  };
}

/**
 * WHO IS THE CONVERSATION WAITING ON?
 *
 * The stored status has five values, two of which are legacy: this schema has
 * carried `OPEN` and `ANSWERED` since before `WAITING_ADMIN`/`WAITING_USER`
 * existed, and old rows still hold them. A person does not care which
 * generation of the enum their ticket was written in — they care whether the
 * ball is in their court. So the mapping is made once, here, and every count
 * and every list row derives from it.
 *
 *   SUPPORT — the team owes a reply: WAITING_ADMIN, and legacy OPEN, which
 *             meant exactly that before the enum was split.
 *   USER    — the user owes a reply: WAITING_USER, and legacy ANSWERED, which
 *             meant "support has answered, over to you".
 *   null    — CLOSED: nobody is waiting.
 */
export type TicketWaitingParty = "USER" | "SUPPORT";

const WAITING_SUPPORT_STATUSES: readonly SupportTicketStatus[] = ["WAITING_ADMIN", "OPEN"];
const WAITING_USER_STATUSES: readonly SupportTicketStatus[] = ["WAITING_USER", "ANSWERED"];

export function ticketWaitingParty(status: SupportTicketStatus): TicketWaitingParty | null {
  if (WAITING_SUPPORT_STATUSES.includes(status)) return "SUPPORT";
  if (WAITING_USER_STATUSES.includes(status)) return "USER";
  return null;
}

/** Counts for the Support Center landing. Owner-scoped, no ticket text read. */
export interface TicketSummary {
  total: number;
  /** Waiting on the team. */
  waitingSupport: number;
  /** Waiting on the user — the number that should draw the eye. */
  waitingUser: number;
  closed: number;
}

export async function summarizeOwnedTickets(userId: string): Promise<TicketSummary> {
  const grouped = await prisma.supportTicket.groupBy({
    by: ["status"],
    where: { userId },
    _count: { _all: true },
  });
  let total = 0;
  let waitingSupport = 0;
  let waitingUser = 0;
  let closed = 0;
  for (const row of grouped) {
    const count = row._count._all;
    total += count;
    const party = ticketWaitingParty(row.status);
    if (party === "SUPPORT") waitingSupport += count;
    else if (party === "USER") waitingUser += count;
    else closed += count;
  }
  return { total, waitingSupport, waitingUser, closed };
}

/** Does this ticket have at least one attachment? No file id is returned. */
export async function ticketHasAttachments(ticketId: string): Promise<boolean> {
  const found = await prisma.supportMessage.findFirst({
    where: { ticketId, fileId: { not: null } },
    select: { id: true },
  });
  return found !== null;
}
