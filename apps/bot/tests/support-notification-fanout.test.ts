import { readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "@zedbot/database";
import {
  claimDueIntents,
  claimIntentForTicket,
  createTicket,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_STALE_CLAIM_MS,
} from "@zedbot/support-tickets";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "support-notification-fanout-secret";

import { logger } from "../src/core/logger.js";
import {
  deliverPendingNotifications,
  deliverTicketNotificationNow,
  resetSupportNotificationLoopForTests,
  runSupportNotificationSweep,
  startSupportNotificationLoop,
  supportNotificationLoopStarted,
} from "../src/services/support-notification.service.js";

// =============================================================================
// S4 — the administrator fan-out.
//
// The property under test is that ONE administrator's outcome is independent of
// every other administrator's. The previous version marked the whole event
// delivered as soon as anybody was reached, so with three administrators and
// two failing sends the database said "sent" and the two who never heard about
// the ticket had no row anywhere recording that.
//
// Everything here is a property of the database — a unique constraint deciding
// a fan-out, a guarded claim deciding a race, a terminal state surviving a
// retry — so it runs against a real one.
// =============================================================================

const RUN = `s4-${process.pid}-${Date.now()}`;
const users: string[] = [];
const admins: string[] = [];
let seq = 0;

function requestId(): string {
  seq += 1;
  return `fan${RUN.replace(/[^A-Za-z0-9]/g, "")}${seq}`.slice(0, 64).padEnd(16, "0");
}

let userId = "";

async function makeAdmin(): Promise<{ id: string; chatId: string }> {
  const admin = await prisma.admin.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(admins.length + 7000),
      role: "SUPPORT",
      isActive: true,
    },
  });
  admins.push(admin.id);
  return { id: admin.id, chatId: admin.telegramId.toString() };
}

/** A Telegram API stand-in whose failures are chosen per chat id. */
function fakeApi(behaviour: Record<string, "ok" | Error>) {
  const sentTo: string[] = [];
  return {
    sentTo,
    api: {
      sendMessage: async (chatId: string): Promise<unknown> => {
        const outcome = behaviour[chatId] ?? "ok";
        if (outcome !== "ok") {
          throw outcome;
        }
        sentTo.push(chatId);
        return { message_id: 1 };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/**
 * Administrators previously active in this database, restored afterwards.
 *
 * The fan-out is "every active administrator", so a case that expects three
 * obligations needs exactly three active administrators. The shared test
 * database accumulates them across runs, and vitest is configured with
 * `fileParallelism: false`, so taking the whole set out of the way for this one
 * file and putting it back is safe — and far more honest than asserting on
 * whatever count happens to be there.
 */
const previouslyActive: string[] = [];

beforeAll(async () => {
  const active = await prisma.admin.findMany({ where: { isActive: true }, select: { id: true } });
  previouslyActive.push(...active.map((a) => a.id));
  await prisma.admin.updateMany({ where: { isActive: true }, data: { isActive: false } });

  // The sweep claims the OLDEST due intents first, so a stale backlog from an
  // earlier run would be worked instead of this file's rows and every
  // assertion about what was sent would be measuring someone else's tickets.
  await prisma.supportNotificationRecipient.deleteMany({
    where: { intent: { status: { in: ["PENDING", "SENDING"] } } },
  });
  await prisma.supportNotificationIntent.deleteMany({
    where: { status: { in: ["PENDING", "SENDING"] } },
  });
});

beforeEach(async () => {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(users.length + 4000),
      firstName: "fan",
    },
  });
  users.push(user.id);
  userId = user.id;
  // Every case owns its administrators, so one case's deactivation cannot
  // change another's expected fan-out size.
  await prisma.admin.updateMany({ where: { id: { in: admins } }, data: { isActive: false } });
});

afterAll(async () => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  const ids = tickets.map((t) => t.id);
  await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: users } } });
  if (ids.length > 0) {
    await prisma.supportNotificationRecipient.deleteMany({
      where: { intent: { ticketId: { in: ids } } },
    });
    await prisma.supportNotificationIntent.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.supportTicket.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.admin.deleteMany({ where: { id: { in: admins } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  if (previouslyActive.length > 0) {
    await prisma.admin.updateMany({
      where: { id: { in: previouslyActive } },
      data: { isActive: true },
    });
  }
});

async function makeTicket(): Promise<string> {
  const made = await createTicket(userId, {
    subject: "موضوع فن‌اوت",
    message: "متن فن‌اوت",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: requestId(),
  });
  if (!made.ok) throw new Error(`create failed: ${made.error}`);
  return made.value.ticket.id;
}

async function recipientStates(ticketId: string): Promise<Record<string, string>> {
  const rows = await prisma.supportNotificationRecipient.findMany({
    where: { intent: { ticketId } },
    select: { adminId: true, status: true },
  });
  return Object.fromEntries(rows.map((r) => [r.adminId, r.status]));
}

async function intentStatus(ticketId: string): Promise<{ status: string; deliveredCount: number }> {
  const row = await prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
  return { status: row.status, deliveredCount: row.deliveredCount };
}

describe("support notification fan-out", () => {
  // S4-1 ----------------------------------------------------------------------
  it("S4-1: three administrators all succeed — one obligation each, all terminal", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const { api, sentTo } = fakeApi({});

    const reached = await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");
    expect(reached).toBe(3);
    expect(new Set(sentTo)).toEqual(new Set([a.chatId, b.chatId, c.chatId]));

    const states = await recipientStates(ticketId);
    expect(states).toEqual({ [a.id]: "SENT", [b.id]: "SENT", [c.id]: "SENT" });
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 3 });
  });

  // S4-2 ----------------------------------------------------------------------
  it("S4-2: one succeeds and two fail — the intent is NOT marked delivered", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const { api } = fakeApi({
      [b.chatId]: new Error("500 internal"),
      [c.chatId]: new Error("500 internal"),
    });

    await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");

    const states = await recipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    // Retryable, so back to PENDING rather than FAILED.
    expect(states[b.id]).toBe("PENDING");
    expect(states[c.id]).toBe("PENDING");
    // THE REGRESSION: one success used to mark the whole event SENT.
    const intent = await intentStatus(ticketId);
    expect(intent.status, "not complete while anyone is still owed").toBe("PENDING");
  });

  // S4-3 ----------------------------------------------------------------------
  it("S4-3: a retry reaches only the administrators who did not get it", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();

    const first = fakeApi({
      [b.chatId]: new Error("500 internal"),
      [c.chatId]: new Error("500 internal"),
    });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect(first.sentTo).toEqual([a.chatId]);

    // Make the failed obligations due again.
    await prisma.supportNotificationRecipient.updateMany({
      where: { intent: { ticketId }, status: "PENDING" },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { ticketId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);

    // The successful recipient is NOT messaged again.
    expect(second.sentTo).not.toContain(a.chatId);
    expect(new Set(second.sentTo)).toEqual(new Set([b.chatId, c.chatId]));
    expect(await recipientStates(ticketId)).toEqual({
      [a.id]: "SENT",
      [b.id]: "SENT",
      [c.id]: "SENT",
    });
    expect((await intentStatus(ticketId)).status, "complete once all terminal").toBe("SENT");
  });

  // S4-3b ---------------------------------------------------------------------
  it("S4-3b: a SENT obligation is never claimable again, whatever the query asks for", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const first = fakeApi({});
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect(first.sentTo).toEqual([a.chatId]);

    const { claimDueRecipients } = await import("@zedbot/support-tickets");
    const intent = await prisma.supportNotificationIntent.findFirstOrThrow({
      where: { ticketId },
    });

    // Force the row back into contention every way a caller could: clear the
    // backoff, re-open the intent. The obligation is terminal and must stay so.
    await prisma.supportNotificationRecipient.updateMany({
      where: { intentId: intent.id },
      data: { nextAttemptAt: new Date(Date.now() - 10_000), claimedAt: null },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intent.id },
      data: { status: "SENDING", nextAttemptAt: null },
    });

    expect(await claimDueRecipients(intent.id), "SENT is not claimable").toEqual([]);

    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);
    expect(second.sentTo, "the successful administrator is not messaged twice").toEqual([]);
    expect((await recipientStates(ticketId))[a.id]).toBe("SENT");
  });

  // S4-4 ----------------------------------------------------------------------
  it("S4-4: an administrator who blocked the bot is classified and retried", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const { api } = fakeApi({ [b.chatId]: new Error("403: bot was blocked by the user") });

    await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");

    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { intent: { ticketId } },
      select: { adminId: true, status: true, safeErrorCode: true, attempts: true },
    });
    const blocked = rows.find((r) => r.adminId === b.id);
    expect(blocked?.status).toBe("PENDING");
    expect(blocked?.safeErrorCode, "classified, not raw").toBe("blocked-by-admin");
    expect(blocked?.attempts).toBe(1);
    expect(rows.find((r) => r.adminId === a.id)?.status).toBe("SENT");
  });

  // S4-5 ----------------------------------------------------------------------
  it("S4-5: an administrator deactivated before the retry is SKIPPED, not failed", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();

    const first = fakeApi({ [b.chatId]: new Error("500 internal") });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect((await recipientStates(ticketId))[b.id]).toBe("PENDING");

    // Deactivated between attempts.
    await prisma.admin.update({ where: { id: b.id }, data: { isActive: false } });
    await prisma.supportNotificationRecipient.updateMany({
      where: { intent: { ticketId }, status: "PENDING" },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { ticketId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);
    expect(second.sentTo, "nothing sent to a deactivated administrator").toEqual([]);

    const states = await recipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[b.id], "terminal but not a failure").toBe("SKIPPED");
    // All terminal and someone was reached.
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 1 });
  });

  // S4-6 ----------------------------------------------------------------------
  it("S4-6: an administrator added AFTER the fan-out gets no obligation for it", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const first = fakeApi({});
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");

    // Promoted afterwards. Documented behaviour: they hear about what happens
    // next, not about the backlog.
    const late = await makeAdmin();
    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);

    expect(second.sentTo).toEqual([]);
    const states = await recipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[late.id], "no retroactive obligation").toBeUndefined();
  });

  // S4-7 ----------------------------------------------------------------------
  it("S4-7: concurrent sweep replicas send to each administrator exactly once", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();

    const one = fakeApi({});
    const two = fakeApi({});
    const three = fakeApi({});
    await Promise.all([
      deliverPendingNotifications(one.api, 20),
      deliverPendingNotifications(two.api, 20),
      deliverPendingNotifications(three.api, 20),
    ]);

    const all = [...one.sentTo, ...two.sentTo, ...three.sentTo];
    expect(all.length, "three sends total, not nine").toBe(3);
    expect(new Set(all)).toEqual(new Set([a.chatId, b.chatId, c.chatId]));
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 3 });
  });

  // S4-8 ----------------------------------------------------------------------
  it("S4-8: a recipient claim abandoned mid-send is recovered and finished", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();

    // A worker claims the intent and one recipient, then dies.
    const intent = await claimIntentForTicket(ticketId, "support.ticket_created");
    expect(intent).not.toBeNull();
    if (intent === null) return;
    const { expandRecipients, claimDueRecipients } = await import("@zedbot/support-tickets");
    await expandRecipients(intent.id);
    const claimed = await claimDueRecipients(intent.id);
    expect(claimed).toHaveLength(2);

    // Nothing else can see them: a fresh sweep finds no due work.
    const blocked = fakeApi({});
    expect(await deliverPendingNotifications(blocked.api, 20)).toBe(0);
    expect(blocked.sentTo).toEqual([]);

    // A fresh claim is not stale.
    const fresh = fakeApi({});
    await runSupportNotificationSweep(fresh.api);
    expect(fresh.sentTo, "a live worker is not interrupted").toEqual([]);

    // Age both levels past the threshold.
    const stale = new Date(Date.now() - NOTIFICATION_STALE_CLAIM_MS - 1000);
    await prisma.supportNotificationRecipient.updateMany({
      where: { intentId: intent.id },
      data: { claimedAt: stale },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intent.id },
      data: { claimedAt: stale },
    });

    const rescued = fakeApi({});
    await runSupportNotificationSweep(rescued.api);
    expect(new Set(rescued.sentTo)).toEqual(new Set([a.chatId, b.chatId]));
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 2 });
  });

  // S4-9 ----------------------------------------------------------------------
  it("S4-9: a recipient that exhausts its attempts is parked and kept", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({ [b.chatId]: new Error("500 internal") });
      await deliverPendingNotifications(round.api, 20);
      const past = new Date(Date.now() - 1000);
      await prisma.supportNotificationRecipient.updateMany({
        where: { intent: { ticketId }, status: "PENDING" },
        data: { nextAttemptAt: past },
      });
      await prisma.supportNotificationIntent.updateMany({
        where: { ticketId, status: "PENDING" },
        data: { nextAttemptAt: past },
      });
    }

    const states = await recipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[b.id], "parked for an operator to find").toBe("FAILED");
    expect(
      await prisma.supportNotificationRecipient.count({
        where: { intent: { ticketId }, adminId: b.id },
      }),
      "kept, not deleted",
    ).toBe(1);
    // All terminal, someone was reached.
    expect((await intentStatus(ticketId)).status).toBe("SENT");
  });

  // S4-10 ---------------------------------------------------------------------
  it("S4-10: with NO active administrators the intent completes rather than looping", async () => {
    const ticketId = await makeTicket();
    const { api, sentTo } = fakeApi({});
    await deliverPendingNotifications(api, 20);
    expect(sentTo).toEqual([]);
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 0 });
  });

  // S4-11 ---------------------------------------------------------------------
  it("S4-11: every administrator failing leaves the intent incomplete, then FAILED", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const err = new Error("500 internal");

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({ [a.chatId]: err, [b.chatId]: err });
      await deliverPendingNotifications(round.api, 20);
      const past = new Date(Date.now() - 1000);
      await prisma.supportNotificationRecipient.updateMany({
        where: { intent: { ticketId }, status: "PENDING" },
        data: { nextAttemptAt: past },
      });
      await prisma.supportNotificationIntent.updateMany({
        where: { ticketId, status: "PENDING" },
        data: { nextAttemptAt: past },
      });
    }

    expect(await recipientStates(ticketId)).toEqual({ [a.id]: "FAILED", [b.id]: "FAILED" });
    expect((await intentStatus(ticketId)).status, "nobody was told").toBe("FAILED");
  });
});

// =============================================================================
// S5 — notification logs carry nothing sensitive.
//
// A Telegram error string is arbitrary text written by a third party: it can
// echo the chat id, the @username, the message body, or all three. Path-based
// redaction in the logger cannot help — it can drop a field named `token`, but
// it cannot find an unknown substring inside `error`. So the raw error must
// never reach the logger in the first place, and these assert that by capturing
// what the logger was actually called with.
// =============================================================================

describe("support notification log safety", () => {
  const captured: unknown[] = [];

  beforeEach(() => {
    captured.length = 0;
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation((message: string, meta?: unknown) => {
        captured.push({ message, meta });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("S5-1: no chat id, username, ticket text or uuid reaches the logs", async () => {
    const admin = await makeAdmin();
    const ticketId = await makeTicket();

    // An error carrying every one of the forbidden substrings at once.
    const leak = new Error(
      `429 Too Many Requests: chat_id=${admin.chatId} @support_boss ticket=${ticketId} ` +
        `body="متن فن‌اوت" subject="موضوع فن‌اوت"`,
    );
    const { api } = fakeApi({ [admin.chatId]: leak });
    await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");

    const dump = JSON.stringify(captured);
    expect(dump, "captured something to assert on").not.toBe("[]");
    expect(dump, "chat id").not.toContain(admin.chatId);
    expect(dump, "username").not.toContain("support_boss");
    expect(dump, "full ticket uuid").not.toContain(ticketId);
    expect(dump, "ticket body").not.toContain("متن فن‌اوت");
    expect(dump, "ticket subject").not.toContain("موضوع فن‌اوت");
    expect(dump, "raw Telegram error").not.toContain("Too Many Requests");
    expect(dump, "administrator id").not.toContain(admin.id);

    // And what it DID log is the classified code.
    expect(dump).toContain("rate-limited");
  });

  it("S5-2: a sweep failure logs a classified code, not the thrown error", async () => {
    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    const leak = new Error(`chat not found: chat_id=${admin.chatId} @leaky ${ticketId}`);
    const { api } = fakeApi({ [admin.chatId]: leak });

    await deliverPendingNotifications(api, 20);

    const dump = JSON.stringify(captured);
    expect(dump).not.toContain(admin.chatId);
    expect(dump).not.toContain("leaky");
    expect(dump).not.toContain(ticketId);
    expect(dump).toContain("chat-missing");
  });
});

// =============================================================================
// S6 — the loop is actually started by the production entrypoint.
//
// A delivery mechanism nobody invokes is an outage with tests. This asserts the
// wiring itself, in the file that runs in production, because a unit test of
// the loop function passes just as happily when nothing calls it.
// =============================================================================

describe("support notification startup wiring", () => {
  const raw = readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");

  /**
   * The entrypoint with comments removed.
   *
   * Scanning the raw text was wrong and a mutation proved it: commenting the
   * call out left every assertion passing, because `// startSupportNotification
   * Loop(bot.api)` still contains the string being searched for. A wiring test
   * that a comment satisfies is worse than no wiring test — it certifies an
   * outage. Strings are preserved (they can't contain a call) and only the
   * comment forms this file actually uses are stripped.
   */
  const entry = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");

  it("S6-1: the bot entrypoint imports and starts the loop, exactly once", () => {
    expect(entry, "imported by the production entrypoint").toMatch(
      /import\s*\{[^}]*startSupportNotificationLoop[^}]*\}\s*from\s*"\.\/services\/support-notification\.service\.js"/s,
    );
    const calls = entry.split("startSupportNotificationLoop(").length - 1;
    expect(calls, "called exactly once").toBe(1);
    expect(entry, "given the bot's Api").toContain("startSupportNotificationLoop(bot.api)");
  });

  it("S6-2: it is started after the Api exists, the database is attempted and shutdown is armed", () => {
    const at = (needle: string): number => {
      const i = entry.indexOf(needle);
      expect(i, `${needle} present`).toBeGreaterThan(-1);
      return i;
    };
    const start = at("startSupportNotificationLoop(bot.api)");
    expect(at("const bot = createBot(botToken)"), "Api first").toBeLessThan(start);
    expect(at('process.on("SIGTERM"'), "shutdown armed first").toBeLessThan(start);
    expect(at("await connectDatabase()"), "database attempted first").toBeLessThan(start);
  });

  it("S6-3: the loop latches, ticks immediately and never holds the process open", async () => {
    resetSupportNotificationLoopForTests();
    expect(supportNotificationLoopStarted()).toBe(false);

    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    const { api, sentTo } = fakeApi({});

    startSupportNotificationLoop(api);
    expect(supportNotificationLoopStarted()).toBe(true);
    // A second call must not arm a second interval.
    startSupportNotificationLoop(api);

    // The immediate tick is fire-and-forget; wait for it to land.
    await vi.waitFor(() => {
      expect(sentTo).toContain(admin.chatId);
    });
    expect(sentTo.length, "one tick, one send").toBe(1);
    expect((await intentStatus(ticketId)).status).toBe("SENT");
    resetSupportNotificationLoopForTests();
  });

  it("S6-4: an intent created WITHOUT immediate delivery is settled by the sweep path", async () => {
    // This is the API's situation exactly: it writes an intent and cannot send.
    const admin = await makeAdmin();
    const ticketId = await makeTicket();

    const before = await prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
    expect(before.status, "nobody has touched it").toBe("PENDING");
    expect(
      await prisma.supportNotificationRecipient.count({ where: { intentId: before.id } }),
      "no fan-out yet",
    ).toBe(0);

    resetSupportNotificationLoopForTests();
    const { api, sentTo } = fakeApi({});
    startSupportNotificationLoop(api);

    await vi.waitFor(async () => {
      const after = await prisma.supportNotificationIntent.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.status).toBe("SENT");
    });
    expect(sentTo).toEqual([admin.chatId]);
    expect(await recipientStates(ticketId)).toEqual({ [admin.id]: "SENT" });
    resetSupportNotificationLoopForTests();
  });

  it("S6-5: a failing tick does not stop the loop or reject", async () => {
    resetSupportNotificationLoopForTests();
    const admin = await makeAdmin();
    await makeTicket();
    const exploding = {
      sendMessage: () => {
        throw new Error("500 internal");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Must not throw and must leave the latch set, so the interval is armed.
    expect(() => {
      startSupportNotificationLoop(exploding);
    }).not.toThrow();
    expect(supportNotificationLoopStarted()).toBe(true);

    await vi.waitFor(async () => {
      const rows = await prisma.supportNotificationRecipient.findMany({
        where: { adminId: admin.id },
        select: { attempts: true },
      });
      expect(rows.length).toBeGreaterThan(0);
    });
    resetSupportNotificationLoopForTests();
  });
});

// Referenced by S4-8 without being re-imported at the top: keeping the import
// local there proves the package exports it, which is what the Bot depends on.
void claimDueIntents;
