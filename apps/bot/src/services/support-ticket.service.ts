import {
  Prisma,
  prisma,
  type Service,
  type SupportMessage,
  type SupportMessageSenderType,
  type SupportTicket,
  type SupportTicketStatus,
  type User,
} from "@zedbot/database";
import {
  errorMessage,
  isSupportAttachmentType,
  isSupportTicketCategory,
  isSupportTicketOrigin,
  type SupportAttachmentInput,
  type SupportAttachmentType,
  SUPPORT_CAPTION_MAX,
  supportCategoryLabelFa,
  type SupportTicketCategory,
  type SupportTicketOrigin,
} from "@zedbot/shared";
import {
  TICKET_MESSAGE_MAX,
  TICKET_MESSAGE_MIN,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
} from "@zedbot/support-tickets";
import { InlineKeyboard } from "grammy";

import { logger } from "../core/logger.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// Support tickets (Phase 32) - structured user<->admin conversations over
// the pre-existing SupportTicket/SupportMessage models (extended by
// migration 20260710172031: WAITING_ADMIN/WAITING_USER statuses, SYSTEM
// sender, closedByAdminId). Transitions: create -> WAITING_ADMIN with the
// first USER message; user reply (not CLOSED) -> WAITING_ADMIN; admin reply
// (not CLOSED) -> WAITING_USER; close (not CLOSED) -> CLOSED + closedAt +
// closedByAdminId + one SYSTEM message. All transitions are status-guarded
// updateMany inside a transaction, so a stale button can never re-open or
// double-close a ticket. User lookups are owner-scoped; ambiguous short ids
// fail. Notification failures log ids only and never roll back a mutation.
// No payment/order/service/financial row is touched anywhere here.
// =============================================================================

// The bounds are NOT declared here any more. They live in
// @zedbot/support-tickets and are re-exported so every existing importer of
// this module keeps working unchanged. Two copies of "how long may a subject
// be" is exactly how the bot and the Mini App would come to disagree about what
// input is acceptable, and the user who hits the difference is the one who
// typed a valid message into the wrong surface.
export {
  TICKET_SUBJECT_MIN,
  TICKET_SUBJECT_MAX,
  TICKET_MESSAGE_MIN,
  TICKET_MESSAGE_MAX,
} from "@zedbot/support-tickets";
export const TICKETS_PAGE_SIZE = 10;
export const TICKET_MESSAGES_PREVIEW_LIMIT = 10;

export const INVALID_TICKET_SUBJECT_TEXT = `موضوع تیکت باید بین ${TICKET_SUBJECT_MIN} تا ${TICKET_SUBJECT_MAX} کاراکتر باشد.`;
export const INVALID_TICKET_MESSAGE_TEXT = `متن پیام باید بین ${TICKET_MESSAGE_MIN} تا ${TICKET_MESSAGE_MAX} کاراکتر باشد.`;
export const INVALID_TICKET_CAPTION_TEXT = `توضیح فایل باید حداکثر ${SUPPORT_CAPTION_MAX} کاراکتر باشد.`;
export const TICKET_CLOSED_TEXT = "این تیکت بسته شده است و امکان ارسال پاسخ جدید وجود ندارد.";
export const TICKET_ALREADY_CLOSED_TEXT = "این تیکت قبلاً بسته شده است.";
export const TICKET_NOT_FOUND_TEXT = "مورد یافت نشد.";
export const TICKET_CLOSED_SYSTEM_MESSAGE = "تیکت با موفقیت بسته شد.";

export const TICKET_STATUS_ICON: Record<SupportTicketStatus, string> = {
  OPEN: "🟡",
  ANSWERED: "💬",
  WAITING_ADMIN: "⏳",
  WAITING_USER: "💬",
  CLOSED: "✅",
};

export const TICKET_STATUS_LABEL: Record<SupportTicketStatus, string> = {
  OPEN: "باز 🟡",
  ANSWERED: "در انتظار پاسخ کاربر 💬",
  WAITING_ADMIN: "در انتظار پاسخ پشتیبانی ⏳",
  WAITING_USER: "در انتظار پاسخ کاربر 💬",
  CLOSED: "بسته ✅",
};

/** Per-message preview cap so a 10-message detail stays under 4096 chars. */
export function ticketMessagePreview(text: string | null, max = 300): string {
  const clean = text ?? "";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export type TicketWithMessages = SupportTicket & {
  user: User;
  /** Last TICKET_MESSAGES_PREVIEW_LIMIT messages in chronological order. */
  messages: SupportMessage[];
  /** Service self-diagnostics: the linked Service, when this ticket was opened
   * from a diagnostic run (null for every ordinary ticket). */
  service?: Service | null;
};

export interface TicketsPage {
  tickets: (SupportTicket & { user: User })[];
  page: number;
  pages: number;
  total: number;
}

export type TicketMutationOutcome =
  | { ok: true; ticket: SupportTicket; created?: boolean }
  | { ok: false; safeMessage: string };

/**
 * The content of ONE support message (Support Tickets V2). A valid message has
 * non-empty text OR a validated attachment (or both). `attachment` MUST already
 * be validated by @zedbot/shared validateSupportAttachment — the service stores
 * the reference verbatim and never sees raw Telegram metadata. `sourceUpdateId`
 * is the inbound Telegram update_id used for idempotent processing.
 */
export interface SupportMessageContent {
  text?: string | null;
  attachment?: SupportAttachmentInput;
  sourceUpdateId?: bigint;
  sourceMessageId?: number;
}

function validSubject(subject: string): boolean {
  return subject.length >= TICKET_SUBJECT_MIN && subject.length <= TICKET_SUBJECT_MAX;
}

function validMessage(text: string): boolean {
  return text.length >= TICKET_MESSAGE_MIN && text.length <= TICKET_MESSAGE_MAX;
}

/** A valid message needs non-empty text (1..3000) OR a validated attachment.
 * When an attachment is present the text is an OPTIONAL caption (0..1000). */
function validateContent(
  content: SupportMessageContent,
): { ok: true; text: string | null } | { ok: false; safeMessage: string } {
  const trimmed = typeof content.text === "string" ? content.text.trim() : "";
  if (content.attachment === undefined) {
    if (!validMessage(trimmed)) {
      return { ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT };
    }
    return { ok: true, text: trimmed };
  }
  if (trimmed.length > SUPPORT_CAPTION_MAX) {
    return { ok: false, safeMessage: INVALID_TICKET_CAPTION_TEXT };
  }
  return { ok: true, text: trimmed === "" ? null : trimmed };
}

/** The SupportMessage write fields for one message (text + optional attachment
 * reference + idempotency key). No file bytes — Telegram references only. */
interface MessageWriteFields {
  text: string | null;
  attachmentType?: SupportAttachmentType;
  fileId?: string;
  fileUniqueId?: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSizeBytes?: bigint | null;
  sourceUpdateId?: bigint;
  sourceMessageId?: number;
}

function messageWriteFields(content: SupportMessageContent, text: string | null): MessageWriteFields {
  const a = content.attachment;
  return {
    text,
    ...(a === undefined
      ? {}
      : {
          attachmentType: a.type,
          fileId: a.fileId,
          fileUniqueId: a.fileUniqueId,
          fileName: a.fileName,
          mimeType: a.mimeType,
          fileSizeBytes: a.sizeBytes,
        }),
    ...(content.sourceUpdateId === undefined ? {} : { sourceUpdateId: content.sourceUpdateId }),
    ...(content.sourceMessageId === undefined ? {} : { sourceMessageId: content.sourceMessageId }),
  };
}

/** True for a unique-violation on the inbound Telegram update_id (a duplicate
 * delivery). Handled by returning the ALREADY-created ticket/message. */
function isDuplicateSourceUpdate(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === "string" && t.includes("sourceUpdateId"));
  }
  return typeof target === "string" && target.includes("sourceUpdateId");
}

/** Finds the ticket that a previously-processed inbound update landed on. */
async function ticketBySourceUpdate(sourceUpdateId: bigint): Promise<SupportTicket | null> {
  const message = await prisma.supportMessage.findUnique({
    where: { sourceUpdateId },
    select: { ticketId: true },
  });
  if (message === null) {
    return null;
  }
  return prisma.supportTicket.findUnique({ where: { id: message.ticketId } });
}

const MESSAGES_PREVIEW = {
  orderBy: { createdAt: "desc" },
  take: TICKET_MESSAGES_PREVIEW_LIMIT,
} as const;

function chronological(ticket: TicketWithMessages): TicketWithMessages {
  return { ...ticket, messages: [...ticket.messages].reverse() };
}

// --- user side -------------------------------------------------------------------------------

/**
 * Everything needed to open ONE ticket (Support Tickets V2). `serviceId` MUST
 * already be owner-scoped by the caller; `diagnosticSnapshot` MUST already be
 * validated (validateDiagnosticSnapshot) and secret-free; the attachment inside
 * `content` MUST already be validated (validateSupportAttachment). Every V2
 * field is additive — a text-only GENERAL ticket sets none of them.
 */
export interface CreateSupportTicketInput {
  userId: string;
  subject: string;
  content: SupportMessageContent;
  category?: SupportTicketCategory | null;
  origin?: SupportTicketOrigin | null;
  serviceId?: string | null;
  diagnosticSnapshot?: unknown;
}

/**
 * New ticket: WAITING_ADMIN + the first USER message, in one transaction. When
 * `content.sourceUpdateId` is set, a DUPLICATE Telegram delivery (same
 * update_id) never creates a second ticket — the unique constraint rejects the
 * second first-message insert, and the ALREADY-created ticket is returned with
 * `created: false` so the caller notifies exactly once.
 */
export async function createSupportTicket(
  input: CreateSupportTicketInput,
): Promise<TicketMutationOutcome> {
  const cleanSubject = input.subject.trim();
  if (!validSubject(cleanSubject)) {
    return { ok: false, safeMessage: INVALID_TICKET_SUBJECT_TEXT };
  }
  const content = validateContent(input.content);
  if (!content.ok) {
    return content;
  }
  const category = isSupportTicketCategory(input.category) ? input.category : null;
  const origin = isSupportTicketOrigin(input.origin) ? input.origin : null;
  const serviceId = input.serviceId ?? null;
  const snapshot =
    input.diagnosticSnapshot === undefined || input.diagnosticSnapshot === null
      ? undefined
      : (input.diagnosticSnapshot as Prisma.InputJsonValue);
  const fields = messageWriteFields(input.content, content.text);
  try {
    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          userId: input.userId,
          subject: cleanSubject,
          status: "WAITING_ADMIN",
          category,
          origin,
          serviceId,
          ...(snapshot === undefined ? {} : { diagnosticSnapshot: snapshot }),
        },
      });
      await tx.supportMessage.create({
        data: { ticketId: created.id, senderType: "USER", senderUserId: input.userId, ...fields },
      });
      return created;
    });
    logger.info("support ticket created", {
      ticketId: ticket.id,
      userId: input.userId,
      category: category ?? "none",
      origin: origin ?? "none",
      hasAttachment: input.content.attachment !== undefined,
    });
    return { ok: true, ticket, created: true };
  } catch (err) {
    if (input.content.sourceUpdateId !== undefined && isDuplicateSourceUpdate(err)) {
      const existing = await ticketBySourceUpdate(input.content.sourceUpdateId);
      if (existing !== null) {
        return { ok: true, ticket: existing, created: false };
      }
    }
    throw err;
  }
}

/** The user's own tickets, latest activity first, 10/page. */
export async function listUserTickets(userId: string, page: number): Promise<TicketsPage> {
  const where = { userId };
  const total = await prisma.supportTicket.count({ where });
  const pages = Math.max(1, Math.ceil(total / TICKETS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const tickets = await prisma.supportTicket.findMany({
    where,
    include: { user: true },
    orderBy: { updatedAt: "desc" },
    skip: (safePage - 1) * TICKETS_PAGE_SIZE,
    take: TICKETS_PAGE_SIZE,
  });
  return { tickets, page: safePage, pages, total };
}

/** Owner-scoped detail by short id (ambiguity fails), last 10 messages. */
export async function getUserTicketDetail(
  userId: string,
  ticketShortId: string,
): Promise<TicketWithMessages | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(ticketShortId)) {
    return null;
  }
  const matches = await prisma.supportTicket.findMany({
    where: { id: { startsWith: ticketShortId }, userId },
    include: { user: true, messages: MESSAGES_PREVIEW, service: true },
    take: 2,
  });
  return matches.length === 1 ? chronological(matches[0]) : null;
}

/** One ticket reply (Support Tickets V2): text and/or a validated attachment. */
export interface AddReplyInput {
  ticketId: string;
  content: SupportMessageContent;
}

/** USER reply: refused on CLOSED; moves the ticket back to WAITING_ADMIN. A
 * duplicate inbound update (same sourceUpdateId) creates no second message and
 * flips no status again — the existing ticket is returned with created:false. */
export async function addUserTicketReply(
  userId: string,
  input: AddReplyInput,
): Promise<TicketMutationOutcome> {
  const content = validateContent(input.content);
  if (!content.ok) {
    return content;
  }
  const ticket = await prisma.supportTicket.findFirst({ where: { id: input.ticketId, userId } });
  if (ticket === null) {
    return { ok: false, safeMessage: TICKET_NOT_FOUND_TEXT };
  }
  if (ticket.status === "CLOSED") {
    return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
  }
  const fields = messageWriteFields(input.content, content.text);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Status-guarded: a concurrent close wins and the reply is refused. The
      // message insert (with the unique sourceUpdateId) is LAST, so a duplicate
      // update rolls back the whole tx — including the status flip.
      const flipped = await tx.supportTicket.updateMany({
        where: { id: input.ticketId, userId, status: { not: "CLOSED" } },
        data: { status: "WAITING_ADMIN" },
      });
      if (flipped.count !== 1) {
        return null;
      }
      await tx.supportMessage.create({
        data: { ticketId: input.ticketId, senderType: "USER", senderUserId: userId, ...fields },
      });
      return tx.supportTicket.findUniqueOrThrow({ where: { id: input.ticketId } });
    });
    if (updated === null) {
      return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
    }
    logger.info("support ticket user reply", {
      ticketId: input.ticketId,
      userId,
      hasAttachment: input.content.attachment !== undefined,
    });
    return { ok: true, ticket: updated, created: true };
  } catch (err) {
    if (input.content.sourceUpdateId !== undefined && isDuplicateSourceUpdate(err)) {
      const existing = await ticketBySourceUpdate(input.content.sourceUpdateId);
      if (existing !== null) {
        return { ok: true, ticket: existing, created: false };
      }
    }
    throw err;
  }
}

// --- admin side ------------------------------------------------------------------------------

export type AdminTicketFilter = "open" | "waiting_admin" | "waiting_user" | "closed";

/** Legacy ANSWERED rows behave like WAITING_USER so they stay visible. */
function filterStatuses(filter: AdminTicketFilter): SupportTicketStatus[] {
  switch (filter) {
    case "open":
      return ["OPEN", "WAITING_ADMIN", "WAITING_USER", "ANSWERED"];
    case "waiting_admin":
      return ["OPEN", "WAITING_ADMIN"];
    case "waiting_user":
      return ["WAITING_USER", "ANSWERED"];
    case "closed":
      return ["CLOSED"];
  }
}

export async function listAdminTickets(
  filter: AdminTicketFilter,
  page: number,
): Promise<TicketsPage> {
  const where = { status: { in: filterStatuses(filter) } };
  const total = await prisma.supportTicket.count({ where });
  const pages = Math.max(1, Math.ceil(total / TICKETS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const tickets = await prisma.supportTicket.findMany({
    where,
    include: { user: true },
    orderBy: { updatedAt: "desc" },
    skip: (safePage - 1) * TICKETS_PAGE_SIZE,
    take: TICKETS_PAGE_SIZE,
  });
  return { tickets, page: safePage, pages, total };
}

export interface AdminTicketCounts {
  open: number;
  waitingAdmin: number;
  waitingUser: number;
  closed: number;
}

export async function getAdminTicketCounts(): Promise<AdminTicketCounts> {
  const groups = await prisma.supportTicket.groupBy({ by: ["status"], _count: { _all: true } });
  const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
  const count = (statuses: SupportTicketStatus[]): number =>
    statuses.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0);
  return {
    open: count(filterStatuses("open")),
    waitingAdmin: count(filterStatuses("waiting_admin")),
    waitingUser: count(filterStatuses("waiting_user")),
    closed: count(filterStatuses("closed")),
  };
}

/** Admin detail by short id (all users; ambiguity fails), last 10 messages. */
export async function getAdminTicketDetail(
  ticketShortId: string,
): Promise<TicketWithMessages | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(ticketShortId)) {
    return null;
  }
  const matches = await prisma.supportTicket.findMany({
    where: { id: { startsWith: ticketShortId } },
    include: { user: true, messages: MESSAGES_PREVIEW, service: true },
    take: 2,
  });
  return matches.length === 1 ? chronological(matches[0]) : null;
}

/** ADMIN reply: refused on CLOSED; moves the ticket to WAITING_USER. Duplicate
 * inbound updates are idempotent on sourceUpdateId (created:false, no re-notify). */
export async function addAdminTicketReply(
  adminId: string,
  input: AddReplyInput,
): Promise<TicketMutationOutcome> {
  const content = validateContent(input.content);
  if (!content.ok) {
    return content;
  }
  const fields = messageWriteFields(input.content, content.text);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const flipped = await tx.supportTicket.updateMany({
        where: { id: input.ticketId, status: { not: "CLOSED" } },
        data: { status: "WAITING_USER" },
      });
      if (flipped.count !== 1) {
        return null;
      }
      await tx.supportMessage.create({
        data: { ticketId: input.ticketId, senderType: "ADMIN", senderAdminId: adminId, ...fields },
      });
      return tx.supportTicket.findUniqueOrThrow({ where: { id: input.ticketId } });
    });
    if (updated === null) {
      return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
    }
    logger.info("support ticket admin reply", {
      ticketId: input.ticketId,
      adminId,
      hasAttachment: input.content.attachment !== undefined,
    });
    return { ok: true, ticket: updated, created: true };
  } catch (err) {
    if (input.content.sourceUpdateId !== undefined && isDuplicateSourceUpdate(err)) {
      const existing = await ticketBySourceUpdate(input.content.sourceUpdateId);
      if (existing !== null) {
        return { ok: true, ticket: existing, created: false };
      }
    }
    throw err;
  }
}

/** CLOSE (idempotent-safe): CLOSED + closedAt/By + one SYSTEM message. */
export async function closeSupportTicket(
  adminId: string,
  ticketId: string,
): Promise<TicketMutationOutcome> {
  const updated = await prisma.$transaction(async (tx) => {
    const flipped = await tx.supportTicket.updateMany({
      where: { id: ticketId, status: { not: "CLOSED" } },
      data: { status: "CLOSED", closedAt: new Date(), closedByAdminId: adminId },
    });
    if (flipped.count !== 1) {
      return null;
    }
    await tx.supportMessage.create({
      data: { ticketId, senderType: "SYSTEM", text: TICKET_CLOSED_SYSTEM_MESSAGE },
    });
    return tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
  });
  if (updated === null) {
    return { ok: false, safeMessage: TICKET_ALREADY_CLOSED_TEXT };
  }
  logger.info("support ticket closed", { ticketId, adminId });
  return { ok: true, ticket: updated };
}

// --- attachment retrieval (owner/admin scoped; references only) -------------------------------

/** A resolved attachment reference, ready to re-send via Telegram fileId. Never
 * carries file bytes or a download URL — only the stored Telegram reference. */
export interface ResolvedSupportAttachment {
  messageId: string;
  type: SupportAttachmentType;
  fileId: string;
  fileName: string | null;
  senderType: SupportMessageSenderType;
}

const SHORT_ID_RE = /^[0-9a-f-]{4,32}$/i;

/** Resolves exactly one attachment message that BELONGS TO the given ticket. A
 * bare message short id is never trusted — it must match a message whose
 * ticketId is `ticketId` and that actually carries an attachment. */
async function resolveTicketAttachment(
  ticketId: string,
  messageShortId: string,
): Promise<ResolvedSupportAttachment | null> {
  if (!SHORT_ID_RE.test(messageShortId)) {
    return null;
  }
  const matches = await prisma.supportMessage.findMany({
    where: {
      id: { startsWith: messageShortId },
      ticketId,
      fileId: { not: null },
      attachmentType: { not: null },
    },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  const message = matches[0];
  if (
    message.fileId === null ||
    message.attachmentType === null ||
    !isSupportAttachmentType(message.attachmentType)
  ) {
    return null;
  }
  return {
    messageId: message.id,
    type: message.attachmentType,
    fileId: message.fileId,
    fileName: message.fileName,
    senderType: message.senderType,
  };
}

/** USER attachment retrieval: the ticket must be OWNER-scoped, and the message
 * must belong to that ticket and carry an attachment. */
export async function resolveUserAttachment(
  userId: string,
  ticketShortId: string,
  messageShortId: string,
): Promise<ResolvedSupportAttachment | null> {
  if (!SHORT_ID_RE.test(ticketShortId)) {
    return null;
  }
  const tickets = await prisma.supportTicket.findMany({
    where: { id: { startsWith: ticketShortId }, userId },
    take: 2,
  });
  if (tickets.length !== 1) {
    return null;
  }
  return resolveTicketAttachment(tickets[0].id, messageShortId);
}

/** ADMIN attachment retrieval: any ticket, but the message must still belong to
 * the resolved ticket and carry an attachment. */
export async function resolveAdminAttachment(
  ticketShortId: string,
  messageShortId: string,
): Promise<ResolvedSupportAttachment | null> {
  if (!SHORT_ID_RE.test(ticketShortId)) {
    return null;
  }
  const tickets = await prisma.supportTicket.findMany({
    where: { id: { startsWith: ticketShortId } },
    take: 2,
  });
  if (tickets.length !== 1) {
    return null;
  }
  return resolveTicketAttachment(tickets[0].id, messageShortId);
}

// --- notifications (fault-isolated; NEVER roll back the ticket mutation) ----------------------

/** Loads the ticket for a notification with the SAFE relations §21 needs: the
 * owner (for addressing), the linked Service (public label only), and the most
 * recent message (to derive the "has attachment" indicator). No attachment
 * fileId / caption / secret ever leaves this function. */
async function loadTicketForNotify(ticketId: string): Promise<
  | (SupportTicket & {
      user: User;
      service: Service | null;
      messages: Pick<SupportMessage, "attachmentType" | "fileId">[];
    })
  | null
> {
  return prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: true,
      service: true,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { attachmentType: true, fileId: true },
      },
    },
  });
}

function ticketUserLine(user: User): string {
  return `کاربر: ${user.telegramId}${user.username === null || user.username === "" ? "" : ` (@${user.username})`}`;
}

/** The stable Persian category line, or null when the ticket predates categories.
 * Display-only — the raw code is never shown and never drives behaviour. */
function ticketCategoryLine(category: string | null): string | null {
  const label = supportCategoryLabelFa(category);
  return label === null ? null : `دسته: ${label}`;
}

/** The linked-Service PUBLIC label line (username only; never quota / config /
 * secret), or null when the ticket has no still-resolvable linked Service. */
function ticketServiceLine(service: Service | null): string | null {
  return service === null ? null : `سرویس مرتبط: ${service.username}`;
}

/** A text-only «📎 دارای ضمیمه» indicator when the latest message carries a
 * retrievable attachment reference. Never reveals the fileId, name or caption. */
function ticketAttachmentLine(
  messages: Pick<SupportMessage, "attachmentType" | "fileId">[],
): string | null {
  const latest = messages[0];
  if (
    latest !== undefined &&
    latest.fileId !== null &&
    latest.attachmentType !== null &&
    isSupportAttachmentType(latest.attachmentType)
  ) {
    return "📎 دارای ضمیمه";
  }
  return null;
}

/** Sends one text to every ACTIVE admin; returns how many were reached. */
async function notifyActiveAdmins(
  api: DeliverySendApi,
  ticketId: string,
  title: string,
): Promise<number> {
  let reached = 0;
  try {
    const ticket = await loadTicketForNotify(ticketId);
    if (ticket === null) {
      return 0;
    }
    const sid = ticket.id.slice(0, 8);
    const text = [
      title,
      "",
      `تیکت: ${sid}`,
      ticketUserLine(ticket.user),
      `موضوع: ${ticket.subject ?? "-"}`,
      ticketCategoryLine(ticket.category),
      ticketServiceLine(ticket.service),
      ticketAttachmentLine(ticket.messages),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    const keyboard = new InlineKeyboard().text("مشاهده تیکت 🎫", `admin:sup:view:${sid}`);
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { telegramId: true },
    });
    for (const admin of admins) {
      try {
        await api.sendMessage(admin.telegramId.toString(), text, { reply_markup: keyboard });
        reached += 1;
      } catch (err) {
        logger.warn("support ticket admin notification failed", {
          ticketId,
          adminTelegramId: admin.telegramId.toString(),
          error: errorMessage(err),
        });
      }
    }
  } catch (err) {
    logger.warn("support ticket admin notification failed", {
      ticketId,
      error: errorMessage(err),
    });
  }
  return reached;
}

export async function notifyAdminsAboutNewTicket(
  api: DeliverySendApi,
  ticketId: string,
): Promise<number> {
  return notifyActiveAdmins(api, ticketId, "🎫 تیکت جدید");
}

export async function notifyAdminsAboutUserReply(
  api: DeliverySendApi,
  ticketId: string,
): Promise<number> {
  return notifyActiveAdmins(api, ticketId, "💬 پاسخ جدید کاربر در تیکت");
}

/** Sends one text + view button to the ticket's owner; returns success. */
async function notifyTicketUser(
  api: DeliverySendApi,
  ticketId: string,
  title: string,
): Promise<boolean> {
  try {
    const ticket = await loadTicketForNotify(ticketId);
    if (ticket === null) {
      return false;
    }
    const sid = ticket.id.slice(0, 8);
    const text = [
      title,
      "",
      `موضوع: ${ticket.subject ?? "-"}`,
      ticketCategoryLine(ticket.category),
      ticketServiceLine(ticket.service),
      ticketAttachmentLine(ticket.messages),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    await api.sendMessage(ticket.user.telegramId.toString(), text, {
      reply_markup: new InlineKeyboard().text("مشاهده تیکت 🎫", `user:sup:view:${sid}`),
    });
    return true;
  } catch (err) {
    logger.warn("support ticket user notification failed", {
      ticketId,
      error: errorMessage(err),
    });
    return false;
  }
}

export async function notifyUserAboutAdminReply(
  api: DeliverySendApi,
  ticketId: string,
): Promise<boolean> {
  return notifyTicketUser(api, ticketId, "پاسخ پشتیبانی ارسال شد 💬");
}

export async function notifyUserTicketClosed(
  api: DeliverySendApi,
  ticketId: string,
): Promise<boolean> {
  return notifyTicketUser(api, ticketId, "تیکت شما با موفقیت بسته شد.");
}
