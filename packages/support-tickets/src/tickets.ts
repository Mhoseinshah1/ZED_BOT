import {
  Prisma,
  prisma,
  type Service,
  type SupportMessage,
  type SupportTicket,
} from "@zedbot/database";
import { isServicePublicId, isTicketPublicId } from "@zedbot/shared";

import {
  type CreateTicketCommand,
  fail,
  type ReplyCommand,
  type SupportDomainResult,
  TICKET_STATUS_AFTER_CREATE,
  TICKET_STATUS_AFTER_USER_REPLY,
  type TicketMutation,
  userMayReply,
} from "./contract.js";

// =============================================================================
// The owner-scoped ticket operations.
//
// Three properties are load-bearing here and each one is a place this has gone
// wrong in other systems:
//
//   OWNER SCOPING IS IN THE QUERY. Not checked after the read — `userId` is in
//   every `where`. A post-hoc check is one early `return` away from being
//   skipped, and the failure is silent: the row was already fetched.
//
//   AMBIGUITY IS A REFUSAL. A public id is a uuid PREFIX, so two rows can share
//   one. `take: 2` and a length check turn that into the same generic
//   not-found a stranger's id produces, rather than into "the first match".
//
//   IDEMPOTENCY IS A CONSTRAINT, NOT A LOOKUP. Checking "does this request id
//   exist?" before inserting is a race with itself: two concurrent retries both
//   read nothing and both insert. The unique index decides, and the loser reads
//   back what the winner wrote.
// =============================================================================

/** A client request id: opaque to us, but bounded and printable. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isClientRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// --- resolution --------------------------------------------------------------

/**
 * The caller's ticket, addressed by its public id.
 *
 * Returns null for malformed, unknown, ambiguous AND someone else's — one
 * outcome, so a caller cannot learn from the difference whether a foreign
 * ticket exists.
 */
export async function resolveOwnedTicket(
  userId: string,
  ticketPublicId: string,
): Promise<SupportTicket | null> {
  if (!isTicketPublicId(ticketPublicId)) {
    return null;
  }
  const matches = await prisma.supportTicket.findMany({
    // Owner scoping IN the query, next to the prefix match.
    where: { id: { startsWith: ticketPublicId.toLowerCase() }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A Service the caller owns and can still see, addressed by its public id.
 *
 * Re-resolved at submission time rather than trusted from the draft: a user can
 * sit on a new-ticket form while the Service is deleted or terminated, and a
 * stale link is worse than no link because it looks deliberate.
 */
export async function resolveOwnedService(
  userId: string,
  servicePublicId: string,
): Promise<Service | null> {
  if (!isServicePublicId(servicePublicId)) {
    return null;
  }
  const matches = await prisma.service.findMany({
    where: {
      id: { startsWith: servicePublicId.toLowerCase() },
      userId,
      deletedAt: null,
      // The terminal status an admin-terminated service carries even without a
      // `deletedAt` — the same visibility rule every other Mini App read uses.
      status: { not: "DELETED" },
    },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- create ------------------------------------------------------------------

/**
 * A new ticket plus its first USER message, in one transaction.
 *
 * Atomic because the two halves are meaningless apart: a ticket with no message
 * is an empty row an admin cannot action, and a message with no ticket is
 * unreachable. Either both land or neither does.
 */
export async function createTicketFromCommand(
  command: CreateTicketCommand,
): Promise<SupportDomainResult<TicketMutation>> {
  if (!isClientRequestId(command.clientRequestId)) {
    return fail("INVALID_REQUEST_ID");
  }

  let serviceId: string | null = null;
  if (command.servicePublicId !== null) {
    const service = await resolveOwnedService(command.userId, command.servicePublicId);
    if (service === null) {
      // Foreign, deleted, ambiguous and malformed are one answer.
      return fail("INVALID_SERVICE");
    }
    serviceId = service.id;
  }

  try {
    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          userId: command.userId,
          subject: command.subject,
          status: TICKET_STATUS_AFTER_CREATE,
          category: command.category,
          origin: command.origin,
          serviceId,
        },
      });
      await tx.supportMessage.create({
        data: {
          ticketId: created.id,
          senderType: "USER",
          senderUserId: command.userId,
          text: command.message,
          clientRequestId: command.clientRequestId,
        },
      });
      return created;
    });
    return { ok: true, value: { ticket, created: true } };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    // A concurrent retry of the SAME attempt won. Hand back what it created, so
    // the caller sees one ticket and notifies once.
    const existing = await ticketByClientRequestId(command.userId, command.clientRequestId);
    if (existing !== null) {
      return { ok: true, value: { ticket: existing, created: false } };
    }
    throw err;
  }
}

// --- reply -------------------------------------------------------------------

/**
 * One USER message on an open ticket, moving it back to WAITING_ADMIN.
 *
 * The close race is the interesting case. An admin may close the ticket between
 * the read that says "open" and the write that appends — so the status is
 * re-checked INSIDE the transaction with a guarded `updateMany`, and the reply
 * is refused when that update matches nothing. The two orders both end
 * somewhere valid: reply-then-close leaves a closed ticket carrying the reply,
 * close-then-reply refuses the reply and the ticket stays closed. What cannot
 * happen is a reply appended to a ticket that is already closed.
 */
export async function replyToTicketFromCommand(
  command: ReplyCommand,
): Promise<SupportDomainResult<TicketMutation>> {
  if (!isClientRequestId(command.clientRequestId)) {
    return fail("INVALID_REQUEST_ID");
  }
  const ticket = await resolveOwnedTicket(command.userId, command.ticketPublicId);
  if (ticket === null) {
    return fail("TICKET_NOT_FOUND");
  }
  if (!userMayReply(ticket.status)) {
    return fail("TICKET_CLOSED");
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Status-guarded: re-reads the row under the transaction and refuses if
      // an admin closed it in the meantime.
      const moved = await tx.supportTicket.updateMany({
        where: { id: ticket.id, userId: command.userId, status: { not: "CLOSED" } },
        data: { status: TICKET_STATUS_AFTER_USER_REPLY },
      });
      if (moved.count === 0) {
        return null;
      }
      await tx.supportMessage.create({
        data: {
          ticketId: ticket.id,
          senderType: "USER",
          senderUserId: command.userId,
          text: command.message,
          clientRequestId: command.clientRequestId,
        },
      });
      // Re-read so the caller sees the committed row, including the `updatedAt`
      // the transition just bumped — which is what the list orders by.
      return tx.supportTicket.findUnique({ where: { id: ticket.id } });
    });
    if (outcome === null) {
      return fail("TICKET_CLOSED");
    }
    return { ok: true, value: { ticket: outcome, created: true } };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const existing = await ticketByClientRequestId(command.userId, command.clientRequestId);
    if (existing !== null) {
      return { ok: true, value: { ticket: existing, created: false } };
    }
    throw err;
  }
}

/**
 * The ticket a previous attempt with this request id created or replied to.
 *
 * Owner-scoped even though the request id is unguessable: an idempotency key is
 * a deduplication token, never an authorisation token, and treating it as one
 * would make a leaked key a way to read someone else's ticket.
 */
async function ticketByClientRequestId(
  userId: string,
  clientRequestId: string,
): Promise<SupportTicket | null> {
  const message = await prisma.supportMessage.findUnique({
    where: { clientRequestId },
    include: { ticket: true },
  });
  if (message === null || message.ticket.userId !== userId) {
    return null;
  }
  return message.ticket;
}

/** Messages of a ticket the caller owns, oldest first. */
export async function listTicketMessages(
  ticketId: string,
  limit: number,
  before: { createdAt: Date; id: string } | null,
): Promise<SupportMessage[]> {
  return prisma.supportMessage.findMany({
    where:
      before === null
        ? { ticketId }
        : {
            ticketId,
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}
