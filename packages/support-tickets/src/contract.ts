import type { SupportTicket, SupportTicketStatus } from "@zedbot/database";
import {
  isSupportTicketCategory,
  isSupportTicketOrigin,
  type SupportTicketCategory,
  type SupportTicketOrigin,
  supportCategoryPrefersService,
} from "@zedbot/shared";

// =============================================================================
// The support-ticket contract, with no transport in it.
//
// This package exists because the same rules have to hold in two processes that
// share nothing else. The bot receives a Telegram update; the API receives a
// JSON body. If each one validated a subject, decided a status transition and
// scoped a query its own way, the two would agree today and drift apart the
// first time someone edited one of them — and the direction that drift takes is
// not symmetric. A bot bug annoys a user; an API bug is reachable by anyone
// with a cookie.
//
// So everything that decides an OUTCOME lives here: the length bounds, the
// status transitions, the owner scoping, the Service-link policy, the category
// vocabulary and the idempotency rule. What stays outside is everything that
// decides a PRESENTATION: Persian strings, keyboards, HTTP status codes.
//
// The bounds are deliberately IMPORTED from the bot's existing constants rather
// than re-chosen, because a user who typed a 3000-character message in the bot
// yesterday must be able to type one in the Mini App today. They are re-exported
// here so the bot can eventually depend on this package rather than the reverse.
// =============================================================================

/** Subject bounds. Identical to the bot's original `TICKET_SUBJECT_MIN/MAX`. */
export const TICKET_SUBJECT_MIN = 3;
export const TICKET_SUBJECT_MAX = 100;

/** Message bounds. Identical to the bot's original `TICKET_MESSAGE_MIN/MAX`. */
export const TICKET_MESSAGE_MIN = 1;
export const TICKET_MESSAGE_MAX = 3000;

/**
 * Every way a domain command can be refused, as a STABLE code.
 *
 * Codes rather than sentences because two transports render errors differently
 * and neither should be handed prose written for the other. The API maps these
 * to HTTP statuses and the frontend maps them to Persian; the bot maps them to
 * its own existing Persian strings. Adding a case here forces both to handle it.
 */
export const SUPPORT_DOMAIN_ERRORS = [
  "INVALID_SUBJECT",
  "INVALID_MESSAGE",
  "INVALID_CATEGORY",
  "INVALID_ORIGIN",
  "INVALID_SERVICE",
  "TICKET_NOT_FOUND",
  "TICKET_CLOSED",
  "INVALID_REQUEST_ID",
] as const;
export type SupportDomainError = (typeof SUPPORT_DOMAIN_ERRORS)[number];

export type SupportDomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SupportDomainError };

export function fail<T>(error: SupportDomainError): SupportDomainResult<T> {
  return { ok: false, error };
}

// --- validation --------------------------------------------------------------

/**
 * Trim first, then measure.
 *
 * A subject of a hundred spaces is not a subject, and measuring before trimming
 * would accept it. Both transports send whitespace users did not mean to type —
 * a Telegram client appends none, but a mobile keyboard's autocomplete does.
 */
export function normalizeSubject(raw: unknown): SupportDomainResult<string> {
  if (typeof raw !== "string") {
    return fail("INVALID_SUBJECT");
  }
  const clean = raw.trim();
  if (clean.length < TICKET_SUBJECT_MIN || clean.length > TICKET_SUBJECT_MAX) {
    return fail("INVALID_SUBJECT");
  }
  return { ok: true, value: clean };
}

export function normalizeMessage(raw: unknown): SupportDomainResult<string> {
  if (typeof raw !== "string") {
    return fail("INVALID_MESSAGE");
  }
  const clean = raw.trim();
  if (clean.length < TICKET_MESSAGE_MIN || clean.length > TICKET_MESSAGE_MAX) {
    return fail("INVALID_MESSAGE");
  }
  return { ok: true, value: clean };
}

/**
 * A category code, never a label.
 *
 * Persian labels are display text an operator can, in principle, see changed;
 * behaviour keyed off a label would change with it. `isSupportTicketCategory`
 * is the same guard the bot uses.
 */
export function normalizeCategory(raw: unknown): SupportDomainResult<SupportTicketCategory> {
  return isSupportTicketCategory(raw) ? { ok: true, value: raw } : fail("INVALID_CATEGORY");
}

export function normalizeOrigin(raw: unknown): SupportDomainResult<SupportTicketOrigin> {
  return isSupportTicketOrigin(raw) ? { ok: true, value: raw } : fail("INVALID_ORIGIN");
}

// --- the Service-link policy -------------------------------------------------

/**
 * Whether a category leads with the Service picker.
 *
 * MIRRORED, not re-decided. The bot shows the picker up front for CONNECTION and
 * SERVICE_MANAGEMENT and offers an explicit opt-in for the rest, so an unrelated
 * Service is never stapled onto a PAYMENT or ACCOUNT ticket. The Mini App asks
 * this same function rather than encoding its own list, because "the two
 * surfaces should behave the same" is only true if one of them is not allowed to
 * have an opinion.
 *
 * Note what this is NOT: it is not a requirement. No category makes a Service
 * mandatory in the bot, so none does here either — the picker is offered, and a
 * user may proceed without one.
 */
export function categoryPrefersService(category: SupportTicketCategory): boolean {
  return supportCategoryPrefersService(category);
}

/** A Service is never mandatory — the bot has no category that requires one. */
export function categoryRequiresService(_category: SupportTicketCategory): boolean {
  return false;
}

// --- status ------------------------------------------------------------------

/**
 * A user may reply while the ticket is not closed.
 *
 * Deliberately expressed as "not CLOSED" rather than a list of open statuses:
 * the enum still carries a legacy `ANSWERED` value from before this flow
 * existed, and a whitelist would silently lock those tickets.
 */
export function userMayReply(status: SupportTicketStatus): boolean {
  return status !== "CLOSED";
}

/** Where a ticket lands after each actor speaks. The whole transition table. */
export const TICKET_STATUS_AFTER_CREATE: SupportTicketStatus = "WAITING_ADMIN";
export const TICKET_STATUS_AFTER_USER_REPLY: SupportTicketStatus = "WAITING_ADMIN";
export const TICKET_STATUS_AFTER_ADMIN_REPLY: SupportTicketStatus = "WAITING_USER";

/** True when the ticket is waiting on the USER rather than on support. */
export function isWaitingForUser(status: SupportTicketStatus): boolean {
  return status === "WAITING_USER" || status === "ANSWERED";
}

// --- shapes ------------------------------------------------------------------

export interface CreateTicketCommand {
  userId: string;
  subject: string;
  message: string;
  category: SupportTicketCategory;
  origin: SupportTicketOrigin;
  /** A PUBLIC service id, or null. Never a database uuid from a client. */
  servicePublicId: string | null;
  /** Cryptographically random, one per explicit submission attempt. */
  clientRequestId: string;
}

export interface ReplyCommand {
  userId: string;
  /** The PUBLIC ticket id from the route. */
  ticketPublicId: string;
  message: string;
  clientRequestId: string;
}

export interface TicketMutation {
  ticket: SupportTicket;
  /**
   * False when this exact `clientRequestId` had already been applied, so the
   * caller can notify admins once rather than once per retry.
   */
  created: boolean;
}
