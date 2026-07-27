import {
  Prisma,
  prisma,
  type Service,
  type SupportMessage,
  type SupportTicket,
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
): Promise<SupportTicket | null> {
  const canonical = canonicalTicketPublicId(ticketPublicId);
  if (canonical === null) {
    return null;
  }
  const matches = await prisma.supportTicket.findMany({
    where: { id: { startsWith: canonical }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A Service the caller owns and can still see.
 *
 * The visibility rule (`deletedAt` null AND status not DELETED) is the same one
 * every Mini App service read uses. It lives here so the API and the bot cannot
 * hold different opinions about what "still exists" means.
 */
export async function resolveOwnedService(
  userId: string,
  servicePublicId: unknown,
): Promise<Service | null> {
  const canonical = canonicalServicePublicId(servicePublicId);
  if (canonical === null) {
    return null;
  }
  const matches = await prisma.service.findMany({
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

// --- idempotency -------------------------------------------------------------

export interface IdempotentReplay {
  ticket: SupportTicket;
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

  let serviceId: string | null = null;
  if (canonicalService !== null) {
    const service = await resolveOwnedService(userId, canonicalService);
    if (service === null) {
      return fail("INVALID_SERVICE");
    }
    serviceId = service.id;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          subject: subject.value,
          status: TICKET_STATUS_AFTER_CREATE,
          category: category.value,
          origin: origin.value,
          serviceId,
        },
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
      return { ok: true as const, value: { ticket, messageId: created.id } };
    });
  } catch (err) {
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
      const fresh = await tx.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
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
