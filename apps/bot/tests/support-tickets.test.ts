import { prisma, type Admin, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase32-test-secret-phase32-test-secret";

import {
  addAdminTicketReply,
  addUserTicketReply,
  closeSupportTicket,
  createSupportTicket,
  getAdminTicketDetail,
  getUserTicketDetail,
  INVALID_TICKET_MESSAGE_TEXT,
  INVALID_TICKET_SUBJECT_TEXT,
  listAdminTickets,
  listUserTickets,
  notifyAdminsAboutNewTicket,
  notifyUserAboutAdminReply,
  notifyUserTicketClosed,
  TICKET_ALREADY_CLOSED_TEXT,
  TICKET_CLOSED_SYSTEM_MESSAGE,
  TICKET_CLOSED_TEXT,
  TICKET_MESSAGE_MAX,
  TICKET_SUBJECT_MAX,
  ticketMessagePreview,
} from "../src/services/support-ticket.service.js";

// =============================================================================
// Phase 32 support tickets: create/reply/close transitions, owner scoping,
// admin filters and fault-isolated notifications. Shared disposable
// PostgreSQL (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

describe.runIf(hasDb)("support tickets (Phase 32)", () => {
  let userA: User;
  let userB: User;
  let admin: Admin;
  let flakyAdminTid: bigint;
  let inactiveAdminTid: bigint;

  function recorder(failChatIds: string[] = []) {
    const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
    return {
      calls,
      api: {
        sendMessage: async (
          chatId: string,
          text: string,
          other?: Record<string, unknown>,
        ): Promise<unknown> => {
          if (failChatIds.includes(chatId)) {
            throw new Error("blocked");
          }
          calls.push({ chatId, text, other });
          return {};
        },
      },
    };
  }

  async function newTicket(user: User, subject: string, text = "پیام اولیه") {
    const outcome = await createSupportTicket(user.id, subject, text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("createSupportTicket failed");
    return outcome.ticket;
  }

  beforeAll(async () => {
    userA = await prisma.user.create({ data: { telegramId: runTag + 939n } });
    userB = await prisma.user.create({ data: { telegramId: runTag + 940n } });
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 941n, role: "OWNER", isActive: true },
    });
    flakyAdminTid = runTag + 942n;
    inactiveAdminTid = runTag + 943n;
    await prisma.admin.create({
      data: { telegramId: flakyAdminTid, role: "OWNER", isActive: true },
    });
    await prisma.admin.create({
      data: { telegramId: inactiveAdminTid, role: "OWNER", isActive: false },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates WAITING_ADMIN tickets with the first USER message", async () => {
    const ticket = await newTicket(userA, `مشکل اتصال ${runTag}`, "سرویس من وصل نمی‌شود.");
    expect(ticket.status).toBe("WAITING_ADMIN");
    expect(ticket.userId).toBe(userA.id);

    const messages = await prisma.supportMessage.findMany({ where: { ticketId: ticket.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].senderType).toBe("USER");
    expect(messages[0].senderUserId).toBe(userA.id);
    expect(messages[0].text).toBe("سرویس من وصل نمی‌شود.");
  });

  it("validates subject and message bounds", async () => {
    const shortSubject = await createSupportTicket(userA.id, "اب", "متن معتبر");
    expect(shortSubject).toEqual({ ok: false, safeMessage: INVALID_TICKET_SUBJECT_TEXT });
    const longSubject = await createSupportTicket(
      userA.id,
      "x".repeat(TICKET_SUBJECT_MAX + 1),
      "متن معتبر",
    );
    expect(longSubject).toEqual({ ok: false, safeMessage: INVALID_TICKET_SUBJECT_TEXT });
    const emptyMessage = await createSupportTicket(userA.id, "موضوع معتبر", "   ");
    expect(emptyMessage).toEqual({ ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT });
    const longMessage = await createSupportTicket(
      userA.id,
      "موضوع معتبر",
      "y".repeat(TICKET_MESSAGE_MAX + 1),
    );
    expect(longMessage).toEqual({ ok: false, safeMessage: INVALID_TICKET_MESSAGE_TEXT });
  });

  it("list and detail are owner-scoped; short-id gibberish fails", async () => {
    const mine = await newTicket(userA, `تیکت من ${runTag}`);
    const foreign = await newTicket(userB, `تیکت دیگری ${runTag}`);

    const page = await listUserTickets(userA.id, 1);
    const ids = page.tickets.map((ticket) => ticket.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(foreign.id);

    expect(await getUserTicketDetail(userA.id, mine.id.slice(0, 8))).not.toBeNull();
    expect(await getUserTicketDetail(userB.id, mine.id.slice(0, 8))).toBeNull();
    expect(await getUserTicketDetail(userA.id, "zzzz")).toBeNull();
    expect(await getAdminTicketDetail("zzzz")).toBeNull();
    // Admins see any user's ticket.
    expect(await getAdminTicketDetail(foreign.id.slice(0, 8))).not.toBeNull();
  });

  it("user reply: WAITING_ADMIN transition, refused after close", async () => {
    const ticket = await newTicket(userA, `پاسخ کاربر ${runTag}`);
    await addAdminTicketReply(admin.id, ticket.id, "بررسی شد.");
    expect(
      (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    ).toBe("WAITING_USER");

    const reply = await addUserTicketReply(userA.id, ticket.id, "هنوز مشکل دارم.");
    expect(reply.ok).toBe(true);
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("WAITING_ADMIN");
    const userMessages = await prisma.supportMessage.count({
      where: { ticketId: ticket.id, senderType: "USER" },
    });
    expect(userMessages).toBe(2);

    // Foreign user cannot reply at all.
    const foreignReply = await addUserTicketReply(userB.id, ticket.id, "من نیستم");
    expect(foreignReply.ok).toBe(false);

    await closeSupportTicket(admin.id, ticket.id);
    const closedReply = await addUserTicketReply(userA.id, ticket.id, "بعد از بستن");
    expect(closedReply).toEqual({ ok: false, safeMessage: TICKET_CLOSED_TEXT });
  });

  it("admin reply: WAITING_USER transition, refused after close", async () => {
    const ticket = await newTicket(userB, `پاسخ ادمین ${runTag}`);
    const reply = await addAdminTicketReply(admin.id, ticket.id, "سلام، در حال بررسی هستیم.");
    expect(reply.ok).toBe(true);
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("WAITING_USER");
    const adminMessage = await prisma.supportMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, senderType: "ADMIN" },
    });
    expect(adminMessage.senderAdminId).toBe(admin.id);

    await closeSupportTicket(admin.id, ticket.id);
    const closedReply = await addAdminTicketReply(admin.id, ticket.id, "دیر شد");
    expect(closedReply).toEqual({ ok: false, safeMessage: TICKET_CLOSED_TEXT });
  });

  it("close: CLOSED + closedAt/closedByAdminId + SYSTEM message; repeat is safe", async () => {
    const ticket = await newTicket(userA, `بستن ${runTag}`);
    const closed = await closeSupportTicket(admin.id, ticket.id);
    expect(closed.ok).toBe(true);

    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt).not.toBeNull();
    expect(after.closedByAdminId).toBe(admin.id);
    const systemMessages = await prisma.supportMessage.findMany({
      where: { ticketId: ticket.id, senderType: "SYSTEM" },
    });
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].text).toBe(TICKET_CLOSED_SYSTEM_MESSAGE);

    const again = await closeSupportTicket(admin.id, ticket.id);
    expect(again).toEqual({ ok: false, safeMessage: TICKET_ALREADY_CLOSED_TEXT });
    expect(
      await prisma.supportMessage.count({ where: { ticketId: ticket.id, senderType: "SYSTEM" } }),
    ).toBe(1);
  });

  it("admin filters return only their statuses", async () => {
    const waiting = await newTicket(userA, `فیلتر-منتظر ${runTag}`);
    const answered = await newTicket(userA, `فیلتر-پاسخ ${runTag}`);
    await addAdminTicketReply(admin.id, answered.id, "پاسخ");
    const closed = await newTicket(userA, `فیلتر-بسته ${runTag}`);
    await closeSupportTicket(admin.id, closed.id);

    const waitingAdmin = await listAdminTickets("waiting_admin", 1);
    expect(waitingAdmin.tickets.map((t) => t.id)).toContain(waiting.id);
    expect(waitingAdmin.tickets.every((t) => t.status === "WAITING_ADMIN" || t.status === "OPEN")).toBe(true);

    const waitingUser = await listAdminTickets("waiting_user", 1);
    expect(waitingUser.tickets.map((t) => t.id)).toContain(answered.id);
    expect(
      waitingUser.tickets.every((t) => t.status === "WAITING_USER" || t.status === "ANSWERED"),
    ).toBe(true);

    const closedList = await listAdminTickets("closed", 1);
    expect(closedList.tickets.map((t) => t.id)).toContain(closed.id);
    expect(closedList.tickets.every((t) => t.status === "CLOSED")).toBe(true);

    const open = await listAdminTickets("open", 1);
    const openIds = open.tickets.map((t) => t.id);
    expect(openIds).toContain(waiting.id);
    expect(openIds).toContain(answered.id);
    expect(openIds).not.toContain(closed.id);
  });

  it("notifies active admins only; one blocked admin does not stop the rest", async () => {
    const ticket = await newTicket(userA, `اعلان ${runTag}`);
    const { api, calls } = recorder([flakyAdminTid.toString()]);
    const reached = await notifyAdminsAboutNewTicket(api, ticket.id);

    expect(reached).toBe(calls.length);
    expect(reached).toBeGreaterThanOrEqual(1);
    const chatIds = calls.map((c) => c.chatId);
    expect(chatIds).toContain(admin.telegramId.toString());
    expect(chatIds).not.toContain(flakyAdminTid.toString());
    expect(chatIds).not.toContain(inactiveAdminTid.toString());
    for (const call of calls) {
      expect(call.text).toContain("🎫 تیکت جدید");
      expect(call.text).toContain(ticket.id.slice(0, 8));
      expect(JSON.stringify(call.other?.reply_markup ?? {})).toContain(
        `admin:sup:view:${ticket.id.slice(0, 8)}`,
      );
    }
  });

  it("user notifications carry the subject and the view button; failures are safe", async () => {
    const subject = `اعلان کاربر ${runTag}`;
    const ticket = await newTicket(userA, subject);

    const replyNotice = recorder();
    expect(await notifyUserAboutAdminReply(replyNotice.api, ticket.id)).toBe(true);
    expect(replyNotice.calls).toHaveLength(1);
    expect(replyNotice.calls[0].chatId).toBe(userA.telegramId.toString());
    expect(replyNotice.calls[0].text).toContain("پاسخ پشتیبانی ارسال شد 💬");
    expect(replyNotice.calls[0].text).toContain(subject);
    expect(JSON.stringify(replyNotice.calls[0].other?.reply_markup ?? {})).toContain(
      `user:sup:view:${ticket.id.slice(0, 8)}`,
    );

    const closeNotice = recorder([userA.telegramId.toString()]);
    expect(await notifyUserTicketClosed(closeNotice.api, ticket.id)).toBe(false);
    expect(closeNotice.calls).toHaveLength(0);
  });

  it("previews long messages without breaking short ones", () => {
    expect(ticketMessagePreview("کوتاه")).toBe("کوتاه");
    expect(ticketMessagePreview(null)).toBe("");
    const long = "z".repeat(500);
    const preview = ticketMessagePreview(long);
    expect(preview.length).toBe(301);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe.skipIf(hasDb)("support tickets (skipped)", () => {
  it("ticket tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
