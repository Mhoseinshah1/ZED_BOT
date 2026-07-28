import { createLogger, errorMessage } from "@zedbot/shared";
import {
  createTicket,
  isSupportDomainError,
  listOwnedTicketMessages,
  listOwnedTickets,
  replyToTicket,
  resolveOwnedTicket,
  summarizeOwnedTickets,
  supportDomainErrorStatus,
  ticketHasAttachments,
  userMayReply,
} from "@zedbot/support-tickets";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { MiniAppAccessUser } from "./access-policy.js";
import { clampPageSize, decodeCursor, encodeCursor } from "./cursor.js";
import {
  toMiniAppMessage,
  toMiniAppTicketDetail,
  toMiniAppTicketSummary,
} from "./serializers.js";
import {
  checkSupportMutation,
  createSupportMutationLimiters,
  sendMutationRejection,
} from "./support-guards.js";

const logger = createLogger("api");

// =============================================================================
// The Support Center HTTP surface.
//
// Unlike the rest of the Mini App API this one WRITES — a ticket and a reply
// are the only things a person can create from the browser. Everything that
// makes writing safe lives either in the mutation gate (transport, origin,
// content type, rate) or in @zedbot/support-tickets (validation, ownership,
// idempotency, the notification intent). This file is the seam between them
// and owns exactly three things: reading the request, choosing a status code,
// and shaping the response.
//
// TEXT ONLY. There is no upload route, no attachment download and no file
// metadata in any response. Tickets raised from Telegram can carry files; the
// Mini App says one exists and hands off to the bot to look at it. Adding a
// download here would mean re-deciding, in a second place, who may read a
// file — and the answer would eventually differ from the bot's.
//
// NO UUID EVER CROSSES THIS BOUNDARY. Tickets are addressed by public short
// id, resolved through the domain's owner-scoped resolver, and paging uses
// sealed cursors that carry the row's sort key without granting access to it.
//
// THE API STILL CANNOT SEND A TELEGRAM MESSAGE. Creating a ticket writes a
// notification intent in the same transaction as the message; the bot's sweep
// turns that into a message to the administrators. This module imports no
// grammY and holds no bot token, which is exactly why the intent exists.
// =============================================================================

/** Page size ceiling for messages, shared with every other paged collection. */
const DEFAULT_MESSAGE_PAGE = 20;

/**
 * Bounds a ticket body. The domain caps a message at 3000 characters and a
 * subject at 100; 8 KiB of JSON holds both several times over in the worst
 * case (every character a 6-byte escape) and still refuses anything that is
 * trying to be a file.
 */
export const SUPPORT_BODY_LIMIT_BYTES = 8 * 1024;

type SupportErrorCode =
  | "NOT_AUTHENTICATED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "INTERNAL"
  | string;

function fail(reply: FastifyReply, status: number, code: SupportErrorCode): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

/** Body fields arrive as `unknown`: the domain normalizers are the validators. */
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const raw: unknown = request.body;
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

export interface SupportRouteOptions {
  allowedOrigins: ReadonlySet<string>;
  /** True when plaintext must be refused. Injected so tests can drive both. */
  production: boolean;
}

export function registerSupportRoutes(secured: FastifyInstance, options: SupportRouteOptions): void {
  const limiters = createSupportMutationLimiters();

  /** Every authenticated handler starts the same way. */
  function requireUser(request: FastifyRequest, reply: FastifyReply): MiniAppAccessUser | null {
    const user = request.miniAppUser;
    if (user === undefined) {
      void fail(reply, 401, "NOT_AUTHENTICATED");
      return null;
    }
    return user;
  }

  /** The gate, applied identically by both mutations. */
  function guard(request: FastifyRequest, reply: FastifyReply, userId: string): boolean {
    const rejection = checkSupportMutation(request, {
      allowedOrigins: options.allowedOrigins,
      limiters,
      userId,
      production: options.production,
    });
    if (rejection !== null) {
      void sendMutationRejection(reply, rejection);
      return false;
    }
    return true;
  }

  // --- summary ---------------------------------------------------------------

  secured.get("/support/summary", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return reply;
    try {
      const summary = await summarizeOwnedTickets(user.id);
      return reply.send({ ok: true, summary });
    } catch (err) {
      logger.error("mini app support summary failed", { error: errorMessage(err) });
      return fail(reply, 503, "INTERNAL");
    }
  });

  // --- ticket list -----------------------------------------------------------

  secured.get<{ Querystring: Record<string, string | undefined> }>(
    "/support/tickets",
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (user === null) return reply;

      const size = clampPageSize(request.query.limit);
      const rawCursor = request.query.cursor;
      let after: { updatedAt: Date; id: string } | null = null;
      if (rawCursor !== undefined && rawCursor !== "") {
        const decoded = decodeCursor(rawCursor, "support-tickets");
        if (decoded === null) {
          // Forged, tampered, expired-format or minted for another collection
          // — one answer, so the failure shape teaches nothing.
          return fail(reply, 400, "BAD_REQUEST");
        }
        after = { updatedAt: new Date(decoded.createdAtMs), id: decoded.id };
      }

      try {
        const page = await listOwnedTickets(user.id, size, after);
        return reply.send({
          ok: true,
          items: page.tickets.map(toMiniAppTicketSummary),
          nextCursor:
            page.next === null
              ? null
              : encodeCursor("support-tickets", {
                  createdAtMs: page.next.updatedAt.getTime(),
                  id: page.next.id,
                }),
        });
      } catch (err) {
        logger.error("mini app support list failed", { error: errorMessage(err) });
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- ticket detail ---------------------------------------------------------

  secured.get<{ Params: { ticketId: string } }>(
    "/support/tickets/:ticketId",
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (user === null) return reply;
      try {
        // Ownership is established by the domain resolver, in the query. A
        // malformed id, an unknown one, an ambiguous prefix and somebody
        // else's ticket are all 404: telling them apart would confirm which
        // ticket ids exist.
        const ticket = await resolveOwnedTicket(user.id, request.params.ticketId);
        if (ticket === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const hasAttachments = await ticketHasAttachments(ticket.id);
        return reply.send({
          ok: true,
          ticket: toMiniAppTicketDetail(ticket, {
            canReply: userMayReply(ticket.status),
            hasAttachments,
          }),
        });
      } catch (err) {
        logger.error("mini app support detail failed", { error: errorMessage(err) });
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- message pagination ----------------------------------------------------

  secured.get<{
    Params: { ticketId: string };
    Querystring: Record<string, string | undefined>;
  }>("/support/tickets/:ticketId/messages", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return reply;

    const size = clampPageSize(request.query.limit ?? String(DEFAULT_MESSAGE_PAGE));
    const rawCursor = request.query.cursor;
    let older: { createdAt: Date; id: string } | null = null;
    if (rawCursor !== undefined && rawCursor !== "") {
      const decoded = decodeCursor(rawCursor, "support-messages");
      if (decoded === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      older = { createdAt: new Date(decoded.createdAtMs), id: decoded.id };
    }

    try {
      // The cursor says WHERE to continue; `userId` says WHETHER there is
      // anything to continue. Ownership is re-established on every page, so a
      // cursor lifted from another session is worth nothing.
      const page = await listOwnedTicketMessages(user.id, request.params.ticketId, size, older);
      if (page === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      return reply.send({
        ok: true,
        items: page.messages.map(toMiniAppMessage),
        nextCursor:
          page.older === null
            ? null
            : encodeCursor("support-messages", {
                createdAtMs: page.older.createdAt.getTime(),
                id: page.older.id,
              }),
      });
    } catch (err) {
      logger.error("mini app support messages failed", { error: errorMessage(err) });
      return fail(reply, 503, "INTERNAL");
    }
  });

  // --- create ----------------------------------------------------------------

  secured.post(
    "/support/tickets",
    { bodyLimit: SUPPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (user === null) return reply;
      if (!guard(request, reply, user.id)) return reply;

      const body = bodyOf(request);
      try {
        // ORIGIN IS FORCED, not read from the body. A ticket raised here came
        // from the Mini App by definition, and letting the client claim
        // otherwise would corrupt the only field that says where support
        // requests actually come from.
        const result = await createTicket(user.id, {
          subject: body.subject,
          message: body.message,
          category: body.category,
          servicePublicId: body.serviceId ?? null,
          origin: "MINIAPP",
          clientRequestId: body.clientRequestId,
        });
        if (!result.ok) {
          return fail(reply, supportDomainErrorStatus(result.error), result.error);
        }
        const hasAttachments = await ticketHasAttachments(result.value.ticket.id);
        return reply.code(201).send({
          ok: true,
          ticket: toMiniAppTicketDetail(result.value.ticket, {
            canReply: userMayReply(result.value.ticket.status),
            hasAttachments,
          }),
        });
      } catch (err) {
        return handleWriteFailure(reply, err, "create");
      }
    },
  );

  // --- reply -----------------------------------------------------------------

  secured.post<{ Params: { ticketId: string } }>(
    "/support/tickets/:ticketId/replies",
    { bodyLimit: SUPPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (user === null) return reply;
      if (!guard(request, reply, user.id)) return reply;

      const body = bodyOf(request);
      try {
        const result = await replyToTicket(user.id, {
          ticketPublicId: request.params.ticketId,
          message: body.message,
          clientRequestId: body.clientRequestId,
        });
        if (!result.ok) {
          // TICKET_CLOSED is a 409 and stays distinguishable from a 404: the
          // Mini App has to tell the difference between "this conversation is
          // over, start a new one" and "this ticket does not exist".
          return fail(reply, supportDomainErrorStatus(result.error), result.error);
        }
        const hasAttachments = await ticketHasAttachments(result.value.ticket.id);
        return reply.code(201).send({
          ok: true,
          ticket: toMiniAppTicketDetail(result.value.ticket, {
            canReply: userMayReply(result.value.ticket.status),
            hasAttachments,
          }),
        });
      } catch (err) {
        return handleWriteFailure(reply, err, "reply");
      }
    },
  );
}

/**
 * A write that threw rather than returning a domain error.
 *
 * The domain returns a result for everything it decided; reaching here means
 * the database refused or something unexpected happened. The client is told
 * INTERNAL and nothing else — no message, no constraint name, no id — and the
 * reason goes to the server log WITHOUT the request body, which is the ticket
 * text a user just typed.
 */
function handleWriteFailure(reply: FastifyReply, err: unknown, operation: string): FastifyReply {
  if (isSupportDomainError((err as { code?: unknown } | null)?.code)) {
    // Defensive: a domain error that escaped as a throw still maps correctly.
    const code = (err as { code: string }).code;
    return fail(reply, supportDomainErrorStatus(code as never), code);
  }
  logger.error("mini app support write failed", { operation, error: errorMessage(err) });
  return fail(reply, 503, "INTERNAL");
}
