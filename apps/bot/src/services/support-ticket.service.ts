import {
  prisma,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketStatus,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
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

export const TICKET_SUBJECT_MIN = 3;
export const TICKET_SUBJECT_MAX = 100;
export const TICKET_MESSAGE_MIN = 1;
export const TICKET_MESSAGE_MAX = 3000;
export const TICKETS_PAGE_SIZE = 10;
export const TICKET_MESSAGES_PREVIEW_LIMIT = 10;

export const INVALID_TICKET_SUBJECT_TEXT = `موضوع تیکت باید بین ${TICKET_SUBJECT_MIN} تا ${TICKET_SUBJECT_MAX} کاراکتر باشد.`;
export const INVALID_TICKET_MESSAGE_TEXT = `متن پیام باید بین ${TICKET_MESSAGE_MIN} تا ${TICKET_MESSAGE_MAX} کاراکتر باشد.`;
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
};

export interface TicketsPage {
  tickets: (SupportTicket & { user: User })[];
  page: number;
  pages: number;
  total: number;
}

export type TicketMutationOutcome =
  | { ok: true; ticket: SupportTicket }
  | { ok: false; safeMessage: string };

function validSubject(subject: string): boolean {
  return subject.length >= TICKET_SUBJECT_MIN && subject.length <= TICKET_SUBJECT_MAX;
}

function validMessage(text: string): boolean {
  return text.length >= TICKET_MESSAGE_MIN && text.length <= TICKET_MESSAGE_MAX;
}

const MESSAGES_PREVIEW = {
  orderBy: { createdAt: "desc" },
  take: TICKET_MESSAGES_PREVIEW_LIMIT,
} as const;

function chronological(ticket: TicketWithMessages): TicketWithMessages {
  return { ...ticket, messages: [...ticket.messages].reverse() };
}

// --- user side -------------------------------------------------------------------------------

/** New ticket: WAITING_ADMIN + the first USER message, in one transaction. */
export async function createSupportTicket(
  userId: string,
  subject: string,
  messageText: string,
): Promise<TicketMutationOutcome> {
  const cleanSubject = subject.trim();
  const cleanText = messageText.trim();
  if (!validSubject(cleanSubject)) {
    return { ok: false, safeMessage: INVALID_TICKET_SUBJECT_TEXT };
  }
  if (!validMessage(cleanText)) {
    return { ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT };
  }
  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.supportTicket.create({
      data: { userId, subject: cleanSubject, status: "WAITING_ADMIN" },
    });
    await tx.supportMessage.create({
      data: { ticketId: created.id, senderType: "USER", senderUserId: userId, text: cleanText },
    });
    return created;
  });
  logger.info("support ticket created", { ticketId: ticket.id, userId });
  return { ok: true, ticket };
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
    include: { user: true, messages: MESSAGES_PREVIEW },
    take: 2,
  });
  return matches.length === 1 ? chronological(matches[0]) : null;
}

/** USER reply: refused on CLOSED; moves the ticket back to WAITING_ADMIN. */
export async function addUserTicketReply(
  userId: string,
  ticketId: string,
  text: string,
): Promise<TicketMutationOutcome> {
  const cleanText = text.trim();
  if (!validMessage(cleanText)) {
    return { ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT };
  }
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } });
  if (ticket === null) {
    return { ok: false, safeMessage: TICKET_NOT_FOUND_TEXT };
  }
  if (ticket.status === "CLOSED") {
    return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
  }
  const updated = await prisma.$transaction(async (tx) => {
    // Status-guarded: a concurrent close wins and the reply is refused.
    const flipped = await tx.supportTicket.updateMany({
      where: { id: ticketId, userId, status: { not: "CLOSED" } },
      data: { status: "WAITING_ADMIN" },
    });
    if (flipped.count !== 1) {
      return null;
    }
    await tx.supportMessage.create({
      data: { ticketId, senderType: "USER", senderUserId: userId, text: cleanText },
    });
    return tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
  });
  if (updated === null) {
    return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
  }
  logger.info("support ticket user reply", { ticketId, userId });
  return { ok: true, ticket: updated };
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
    include: { user: true, messages: MESSAGES_PREVIEW },
    take: 2,
  });
  return matches.length === 1 ? chronological(matches[0]) : null;
}

/** ADMIN reply: refused on CLOSED; moves the ticket to WAITING_USER. */
export async function addAdminTicketReply(
  adminId: string,
  ticketId: string,
  text: string,
): Promise<TicketMutationOutcome> {
  const cleanText = text.trim();
  if (!validMessage(cleanText)) {
    return { ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT };
  }
  const updated = await prisma.$transaction(async (tx) => {
    const flipped = await tx.supportTicket.updateMany({
      where: { id: ticketId, status: { not: "CLOSED" } },
      data: { status: "WAITING_USER" },
    });
    if (flipped.count !== 1) {
      return null;
    }
    await tx.supportMessage.create({
      data: { ticketId, senderType: "ADMIN", senderAdminId: adminId, text: cleanText },
    });
    return tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
  });
  if (updated === null) {
    return { ok: false, safeMessage: TICKET_CLOSED_TEXT };
  }
  logger.info("support ticket admin reply", { ticketId, adminId });
  return { ok: true, ticket: updated };
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

// --- notifications (fault-isolated; NEVER roll back the ticket mutation) ----------------------

async function loadTicketForNotify(
  ticketId: string,
): Promise<(SupportTicket & { user: User }) | null> {
  return prisma.supportTicket.findUnique({ where: { id: ticketId }, include: { user: true } });
}

function ticketUserLine(user: User): string {
  return `کاربر: ${user.telegramId}${user.username === null || user.username === "" ? "" : ` (@${user.username})`}`;
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
    ].join("\n");
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
    await api.sendMessage(
      ticket.user.telegramId.toString(),
      `${title}\n\nموضوع: ${ticket.subject ?? "-"}`,
      { reply_markup: new InlineKeyboard().text("مشاهده تیکت 🎫", `user:sup:view:${sid}`) },
    );
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
