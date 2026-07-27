import { prisma } from "@zedbot/database";
import {
  claimDueIntents,
  claimIntentForTicket,
  createTicket,
  NOTIFICATION_STALE_CLAIM_MS,
  notificationRetryDelayMs,
  recoverStaleClaims,
  replyToTicket,
  settleIntent,
} from "@zedbot/support-tickets";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  addUserTicketReply,
  createSupportTicket,
} from "../src/services/support-ticket.service.js";

process.env.APP_SECRET ??= "support-notification-intents-secret";

// =============================================================================
// S3 — the notification outbox.
//
// The property under test is not "a message gets sent" — that needs Telegram.
// It is that the DECISION to send survives everything the process can do wrong:
// crashing after the commit, two workers reaching for the same row, a worker
// dying mid-send and leaving a claim nobody owns.
//
// Every one of those is a property of the database, so these run against a real
// one. A mock would agree with whatever the code does.
// =============================================================================

const RUN = `s3-${process.pid}-${Date.now()}`;
const users: string[] = [];
let seq = 0;

function requestId(): string {
  seq += 1;
  return `ntf${RUN.replace(/[^A-Za-z0-9]/g, "")}${seq}`.slice(0, 64).padEnd(16, "0");
}

async function makeUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(users.length + 900),
      firstName: "ntf",
    },
  });
  users.push(user.id);
  return user.id;
}

let userId = "";

beforeEach(async () => {
  userId = await makeUser();
});

afterAll(async () => {
  if (users.length === 0) return;
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  const ids = tickets.map((t) => t.id);
  await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: users } } });
  if (ids.length > 0) {
    // Intents cascade from the ticket, but delete explicitly so a failure here
    // is visible rather than silently relying on the constraint.
    await prisma.supportNotificationIntent.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.supportTicket.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

function domainCreate(over: Record<string, unknown> = {}): Parameters<typeof createTicket>[1] {
  return {
    subject: "موضوع اعلان",
    message: "متن اعلان",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: requestId(),
    ...over,
  } as Parameters<typeof createTicket>[1];
}

describe("support notification intents", () => {
  // S3-1 ----------------------------------------------------------------------
  it("S3-1: a created ticket always has exactly one intent, bound to its message", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const intents = await prisma.supportNotificationIntent.findMany({
      where: { ticketId: made.value.ticket.id },
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe("support.ticket_created");
    expect(intents[0].messageId, "bound to the message, not just the ticket").toBe(
      made.value.messageId,
    );
    expect(intents[0].status).toBe("PENDING");
    expect(intents[0].attempts).toBe(0);
  });

  // S3-2 ----------------------------------------------------------------------
  it("S3-2: a user reply produces its own intent with the reply kind", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const reply = await replyToTicket(userId, {
      ticketPublicId: made.value.ticket.id.slice(0, 8),
      message: "پاسخ کاربر",
      clientRequestId: requestId(),
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    const kinds = await prisma.supportNotificationIntent.findMany({
      where: { ticketId: made.value.ticket.id },
      orderBy: { createdAt: "asc" },
      select: { kind: true, messageId: true },
    });
    expect(kinds.map((k) => k.kind)).toEqual([
      "support.ticket_created",
      "support.user_replied",
    ]);
    expect(kinds[1].messageId).toBe(reply.value.messageId);
  });

  // S3-3 ----------------------------------------------------------------------
  it("S3-3: a REPLAYED mutation creates no second intent", async () => {
    // The retry returns the original result without writing anything, so the
    // admins must not be told twice about one reply.
    const input = domainCreate();
    const first = await createTicket(userId, input);
    const second = await createTicket(userId, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok) return;

    const count = await prisma.supportNotificationIntent.count({
      where: { ticketId: first.value.ticket.id },
    });
    expect(count, "one intent, not two").toBe(1);
  });

  // S3-4 ----------------------------------------------------------------------
  it("S3-4: concurrent identical creates produce exactly one intent", async () => {
    const input = domainCreate();
    const results = await Promise.all([
      createTicket(userId, input),
      createTicket(userId, input),
      createTicket(userId, input),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const total = await prisma.supportNotificationIntent.count({
      where: { ticket: { userId } },
    });
    expect(total, "one winner, two replays").toBe(1);
  });

  // S3-5 ----------------------------------------------------------------------
  it("S3-5: a FAILED mutation leaves no intent behind", async () => {
    const bad = await createTicket(userId, domainCreate({ subject: "x".repeat(500) }));
    expect(bad.ok).toBe(false);
    const count = await prisma.supportNotificationIntent.count({ where: { ticket: { userId } } });
    expect(count, "nothing to notify about a ticket that never existed").toBe(0);
  });

  // S3-6 ----------------------------------------------------------------------
  it("S3-6: the BOT's own create and reply are just as durable", async () => {
    // The bot writes its own rows because it carries attachments and Telegram
    // idempotency the shared commands do not model. The intent must be written
    // there too, or the durability guarantee only holds for the Mini App.
    const made = await createSupportTicket({
      userId,
      subject: "تیکت از ربات",
      content: { text: "متن از ربات" },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const reply = await addUserTicketReply(userId, {
      ticketId: made.ticket.id,
      content: { text: "پاسخ از ربات" },
    });
    expect(reply.ok).toBe(true);

    const kinds = await prisma.supportNotificationIntent.findMany({
      where: { ticketId: made.ticket.id },
      orderBy: { createdAt: "asc" },
      select: { kind: true },
    });
    expect(kinds.map((k) => k.kind)).toEqual([
      "support.ticket_created",
      "support.user_replied",
    ]);
  });

  // S3-7 ----------------------------------------------------------------------
  it("S3-7: only ONE of two concurrent claims wins the same intent", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const [a, b, c] = await Promise.all([
      claimIntentForTicket(made.value.ticket.id, "support.ticket_created"),
      claimIntentForTicket(made.value.ticket.id, "support.ticket_created"),
      claimIntentForTicket(made.value.ticket.id, "support.ticket_created"),
    ]);
    const winners = [a, b, c].filter((x) => x !== null);
    expect(winners, "exactly one claim, or the admins hear about it twice").toHaveLength(1);

    const row = await prisma.supportNotificationIntent.findFirstOrThrow({
      where: { ticketId: made.value.ticket.id },
    });
    expect(row.status).toBe("SENDING");
    expect(row.attempts, "incremented once, not three times").toBe(1);
  });

  // S3-8 ----------------------------------------------------------------------
  it("S3-8: the sweep and the immediate path never both take one intent", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const [direct, swept] = await Promise.all([
      claimIntentForTicket(made.value.ticket.id, "support.ticket_created"),
      claimDueIntents(20),
    ]);
    const sweptThis = swept.filter((i) => i.ticketId === made.value.ticket.id);
    const takenBy = (direct === null ? 0 : 1) + sweptThis.length;
    expect(takenBy, "one owner").toBe(1);
  });

  // S3-9 ----------------------------------------------------------------------
  it("S3-9: a claim that outlives its process is recovered, and only then", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const claimed = await claimIntentForTicket(made.value.ticket.id, "support.ticket_created");
    expect(claimed).not.toBeNull();

    // A FRESH claim is not stale: recovering it would race the worker that is
    // still sending, which is the one path that can produce a duplicate.
    expect(await recoverStaleClaims(), "fresh claim untouched").toBe(0);

    // Age it past the threshold.
    await prisma.supportNotificationIntent.updateMany({
      where: { ticketId: made.value.ticket.id },
      data: { claimedAt: new Date(Date.now() - NOTIFICATION_STALE_CLAIM_MS - 1000) },
    });
    expect(await recoverStaleClaims(), "abandoned claim returned").toBe(1);

    const row = await prisma.supportNotificationIntent.findFirstOrThrow({
      where: { ticketId: made.value.ticket.id },
    });
    expect(row.status).toBe("PENDING");
    expect(row.claimedAt).toBeNull();
  });

  // S3-10 ---------------------------------------------------------------------
  it("S3-10: a completed intent is terminal and never claimed again", async () => {
    const made = await createTicket(userId, domainCreate());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const claimed = await claimIntentForTicket(made.value.ticket.id, "support.ticket_created");
    expect(claimed).not.toBeNull();
    if (claimed === null) return;

    // No obligations at all: nobody to tell, so the aggregate is complete
    // immediately rather than looping forever on an empty administrator table.
    const outcome = await settleIntent(claimed.id, claimed.attempts);
    expect(outcome.complete).toBe(true);
    expect(outcome.pending).toBe(0);

    const row = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    expect(row.status).toBe("SENT");
    expect(row.sentAt).not.toBeNull();

    expect(
      await claimIntentForTicket(made.value.ticket.id, "support.ticket_created"),
      "terminal",
    ).toBeNull();
    expect(await recoverStaleClaims(), "SENT is not a stale claim").toBe(0);
  });

  // S3-11 ---------------------------------------------------------------------
  it("S3-11: an intent with work still outstanding is rescheduled, not completed", async () => {
    const admin = await prisma.admin.create({
      data: { telegramId: BigInt(Date.now()) * 1000n + 31n, role: "SUPPORT", isActive: false },
    });
    try {
      const made = await createTicket(userId, domainCreate());
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const claimed = await claimIntentForTicket(made.value.ticket.id, "support.ticket_created");
      expect(claimed).not.toBeNull();
      if (claimed === null) return;

      // One obligation left unfinished — the shape a partial fan-out leaves.
      await prisma.supportNotificationRecipient.create({
        data: { intentId: claimed.id, adminId: admin.id, status: "PENDING" },
      });

      const now = new Date();
      const outcome = await settleIntent(claimed.id, claimed.attempts, now);
      expect(outcome.complete, "somebody is still owed").toBe(false);
      expect(outcome.pending).toBe(1);

      const row = await prisma.supportNotificationIntent.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      // Back to PENDING rather than SENT: an aggregate must not claim delivery
      // while an obligation is outstanding.
      expect(row.status).toBe("PENDING");
      expect(row.nextAttemptAt?.getTime()).toBe(
        now.getTime() + notificationRetryDelayMs(claimed.attempts),
      );

      // Held back by the backoff, then due.
      const early = await claimDueIntents(50, now);
      expect(early.some((i) => i.id === claimed.id), "not yet due").toBe(false);
      const later = new Date(now.getTime() + notificationRetryDelayMs(claimed.attempts) + 1000);
      const due = await claimDueIntents(50, later);
      expect(due.some((i) => i.id === claimed.id), "due later").toBe(true);
    } finally {
      await prisma.supportNotificationRecipient.deleteMany({ where: { adminId: admin.id } });
      await prisma.admin.delete({ where: { id: admin.id } });
    }
  });

  // S3-12 ---------------------------------------------------------------------
  it("S3-12: the intent holds references only — no ticket text", async () => {
    const secretSubject = "موضوع-محرمانه-یکتا";
    const secretBody = "متن-محرمانه-یکتا";
    const made = await createTicket(
      userId,
      domainCreate({ subject: secretSubject, message: secretBody }),
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const row = await prisma.supportNotificationIntent.findFirstOrThrow({
      where: { ticketId: made.value.ticket.id },
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secretSubject);
    expect(serialized).not.toContain(secretBody);
  });

  // S3-13 ---------------------------------------------------------------------
  it("S3-13: backoff is monotonic and capped", async () => {
    const delays = [1, 2, 3, 4, 5, 6, 10].map(notificationRetryDelayMs);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i], `attempt ${i + 1} never waits less`).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    // Capped: an admin waiting an hour for a ticket alert is the same as never
    // being told.
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
