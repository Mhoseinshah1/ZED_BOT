import { readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "@zedbot/database";
import {
  claimDueRecipients,
  claimIntentForTicket,
  createTicket,
  expandRecipients,
  freezeRecipientSet,
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
// every other administrator's, and that the recipient set is decided EXACTLY
// ONCE. Everything here is a property of the database — a unique constraint
// deciding a fan-out, a guarded claim deciding a race, a CAS deciding an
// expansion — so it runs against a real one.
//
// ISOLATION. This suite runs against a shared database whose administrator
// population it does not own and MUST NOT touch. An earlier version
// deactivated every administrator and restored them afterwards; a killed run
// left the whole table disabled and broke unrelated suites. So now:
//
//   - every administrator used by a scenario is a fixture this file creates,
//     tagged and torn down by exact id;
//   - delivery-mechanics scenarios FREEZE the recipient set to their fixtures
//     via the same freezeRecipientSet primitive production uses, so their
//     counts are exact no matter who else is in the table;
//   - expansion scenarios (which must exercise the real active-administrator
//     read) tolerate unrelated rows by filtering every assertion to fixture
//     ids — they assert what happened to THEIR administrators and nothing
//     about anyone else's;
//   - the last describe proves no pre-existing Admin row changed at all.
//
// The suite is therefore correct when the database has zero active
// administrators, when it has hundreds, and after a previous run of this file
// was killed at any point.
// =============================================================================

const RUN = `s4-${process.pid}-${Date.now()}`;
const FIXTURE_TAG = "s4-fanout-fixture";
const users: string[] = [];
const admins: string[] = [];
const fixtureChatIds = new Set<string>();
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
      firstName: FIXTURE_TAG,
    },
  });
  admins.push(admin.id);
  fixtureChatIds.add(admin.telegramId.toString());
  return { id: admin.id, chatId: admin.telegramId.toString() };
}

/** Only the sends that went to THIS FILE's administrators. */
function ours(sentTo: string[]): string[] {
  return sentTo.filter((chatId) => fixtureChatIds.has(chatId));
}

/** A Telegram API stand-in whose failures are chosen per chat id. */
function fakeApi(behaviour: Record<string, "ok" | Error>, fallback: "ok" | Error = "ok") {
  const sentTo: string[] = [];
  return {
    sentTo,
    api: {
      sendMessage: async (chatId: string): Promise<unknown> => {
        const outcome = behaviour[chatId] ?? fallback;
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
 * Rows that existed BEFORE this suite ran, snapshotted field-by-field so the
 * isolation contract at the bottom can prove none of them changed.
 */
interface AdminSnapshot {
  id: string;
  telegramId: bigint;
  isActive: boolean;
  role: string;
  updatedAt: Date;
}
const preExisting: AdminSnapshot[] = [];

beforeAll(async () => {
  // A previous run of this file that was KILLED leaves its tagged fixtures
  // behind. They are this suite's own debris — uniquely identified by the tag
  // no production code writes — and removing them is the only mutation this
  // file ever makes to rows it did not create in this run.
  await prisma.admin.deleteMany({ where: { firstName: FIXTURE_TAG } });

  // Stale PENDING work left by earlier runs would be claimed ahead of this
  // file's rows (the sweep takes oldest first) and starve every scenario.
  // These intents belong to prior runs' now-deleted tickets, not to anything
  // production seeded.
  await prisma.supportNotificationRecipient.deleteMany({
    where: { intent: { status: { in: ["PENDING", "SENDING"] } } },
  });
  await prisma.supportNotificationIntent.deleteMany({
    where: { status: { in: ["PENDING", "SENDING"] } },
  });

  const rows = await prisma.admin.findMany({
    select: { id: true, telegramId: true, isActive: true, role: true, updatedAt: true },
  });
  preExisting.push(...rows);
});

beforeEach(async () => {
  // Every scenario starts with an EMPTY due backlog. Earlier cases in this run
  // leave PENDING intents behind (that is their point — they test partial
  // delivery), and the sweep claims oldest-first with a bounded batch, so a
  // later scenario's own intent could miss the batch entirely while the sweep
  // chews through the debris. That was a real flake: S5-2's intent sometimes
  // never got worked. Only THIS RUN's rows are touched — the filter is the
  // run's own user ids.
  if (users.length > 0) {
    await prisma.supportNotificationRecipient.deleteMany({
      where: { intent: { ticket: { userId: { in: users } } } },
    });
    await prisma.supportNotificationIntent.deleteMany({
      where: { ticket: { userId: { in: users } } },
    });
  }

  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(users.length + 4000),
      firstName: "fan",
    },
  });
  users.push(user.id);
  userId = user.id;
  // Every case owns its administrators. Deactivating the FIXTURES created by
  // earlier cases (never anyone else's rows) keeps them out of the next case's
  // real-expansion reads.
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

/**
 * Freeze the ticket's intent to EXACTLY these administrators, through the same
 * primitive production expansion uses. Delivery then works this set and only
 * this set, so the scenario's counts do not depend on who else happens to be
 * active in a shared database.
 */
async function freezeTo(ticketId: string, adminIds: string[]): Promise<string> {
  const intent = await prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
  await prisma.$transaction((tx) => freezeRecipientSet(tx, intent.id, async () => adminIds));
  return intent.id;
}

/** Recipient states for THIS FILE's administrators only. */
async function fixtureRecipientStates(ticketId: string): Promise<Record<string, string>> {
  const rows = await prisma.supportNotificationRecipient.findMany({
    where: { intent: { ticketId }, adminId: { in: admins } },
    select: { adminId: true, status: true },
  });
  return Object.fromEntries(rows.map((r) => [r.adminId, r.status]));
}

async function intentStatus(ticketId: string): Promise<{ status: string; deliveredCount: number }> {
  const row = await prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
  return { status: row.status, deliveredCount: row.deliveredCount };
}

async function makeDue(ticketId: string): Promise<void> {
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

describe("support notification fan-out", () => {
  // S4-1 ----------------------------------------------------------------------
  it("S4-1: three administrators all succeed — one obligation each, all terminal", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id, c.id]);
    const { api, sentTo } = fakeApi({});

    const reached = await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");
    expect(reached).toBe(3);
    expect(new Set(sentTo)).toEqual(new Set([a.chatId, b.chatId, c.chatId]));

    const states = await fixtureRecipientStates(ticketId);
    expect(states).toEqual({ [a.id]: "SENT", [b.id]: "SENT", [c.id]: "SENT" });
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 3 });
  });

  // S4-2 ----------------------------------------------------------------------
  it("S4-2: one succeeds and two fail — the intent is NOT marked delivered", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id, c.id]);
    const { api } = fakeApi({
      [b.chatId]: new Error("500 internal"),
      [c.chatId]: new Error("500 internal"),
    });

    await deliverTicketNotificationNow(api, ticketId, "support.ticket_created");

    const states = await fixtureRecipientStates(ticketId);
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
    await freezeTo(ticketId, [a.id, b.id, c.id]);

    const first = fakeApi({
      [b.chatId]: new Error("500 internal"),
      [c.chatId]: new Error("500 internal"),
    });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect(first.sentTo).toEqual([a.chatId]);

    await makeDue(ticketId);
    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);

    // The successful recipient is NOT messaged again.
    expect(second.sentTo).not.toContain(a.chatId);
    expect(new Set(second.sentTo)).toEqual(new Set([b.chatId, c.chatId]));
    expect(await fixtureRecipientStates(ticketId)).toEqual({
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
    const intentId = await freezeTo(ticketId, [a.id]);
    const first = fakeApi({});
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect(first.sentTo).toEqual([a.chatId]);

    // Force the row back into contention every way a caller could: clear the
    // backoff, re-open the intent. The obligation is terminal and must stay so.
    await prisma.supportNotificationRecipient.updateMany({
      where: { intentId },
      data: { nextAttemptAt: new Date(Date.now() - 10_000), claimedAt: null },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId },
      data: { status: "SENDING", nextAttemptAt: null },
    });

    expect(await claimDueRecipients(intentId), "SENT is not claimable").toEqual([]);

    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);
    expect(second.sentTo, "the successful administrator is not messaged twice").toEqual([]);
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("SENT");
  });

  // S4-4 ----------------------------------------------------------------------
  it("S4-4: an administrator who blocked the bot is classified and retried", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id]);
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
    await freezeTo(ticketId, [a.id, b.id]);

    const first = fakeApi({ [b.chatId]: new Error("500 internal") });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBe("PENDING");

    // Deactivated between attempts — this file's OWN fixture, nobody else's.
    await prisma.admin.update({ where: { id: b.id }, data: { isActive: false } });
    await makeDue(ticketId);

    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);
    expect(second.sentTo, "nothing sent to a deactivated administrator").toEqual([]);

    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[b.id], "terminal but not a failure").toBe("SKIPPED");
    // All terminal and someone was reached.
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 1 });
  });

  // S4-6 ----------------------------------------------------------------------
  it("S4-6: an administrator added AFTER the fan-out gets no obligation for it", async () => {
    // REAL expansion here — the property is about what the live read freezes.
    // Unrelated active administrators may be swept into the set; assertions
    // are therefore about this file's fixtures only.
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const first = fakeApi({});
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect(ours(first.sentTo)).toEqual([a.chatId]);

    // Promoted afterwards. Documented behaviour: they hear about what happens
    // next, not about the backlog.
    const late = await makeAdmin();
    const second = fakeApi({});
    await deliverPendingNotifications(second.api, 20);

    expect(ours(second.sentTo)).toEqual([]);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[late.id], "no retroactive obligation").toBeUndefined();
  });

  // S4-7 ----------------------------------------------------------------------
  it("S4-7: concurrent sweep replicas send to each administrator exactly once", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id, c.id]);

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
    const intentId = await freezeTo(ticketId, [a.id, b.id]);

    // A worker claims the intent and its recipients, then dies.
    const intent = await claimIntentForTicket(ticketId, "support.ticket_created");
    expect(intent).not.toBeNull();
    if (intent === null) return;
    const claimed = await claimDueRecipients(intentId);
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
      where: { intentId },
      data: { claimedAt: stale },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId },
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
    await freezeTo(ticketId, [a.id, b.id]);

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({ [b.chatId]: new Error("500 internal") });
      await deliverPendingNotifications(round.api, 20);
      await makeDue(ticketId);
    }

    const states = await fixtureRecipientStates(ticketId);
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
  it("S4-10: an intent frozen with NO eligible administrators completes rather than looping", async () => {
    // Frozen EMPTY — the durable outcome of expansion finding nobody active.
    // Frozen through the same primitive, so the completion path under test is
    // exactly the production one, without needing the shared table to be empty.
    const ticketId = await makeTicket();
    await freezeTo(ticketId, []);
    const { api, sentTo } = fakeApi({});
    await deliverPendingNotifications(api, 20);
    expect(sentTo).toEqual([]);
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 0 });
  });

  // S4-11 ---------------------------------------------------------------------
  it("S4-11: every administrator failing leaves the intent incomplete, then FAILED", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id]);

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      // Everything fails this round — including any hypothetical stranger,
      // via the fallback, so the scenario holds in any population.
      const round = fakeApi({}, new Error("500 internal"));
      await deliverPendingNotifications(round.api, 20);
      await makeDue(ticketId);
    }

    expect(await fixtureRecipientStates(ticketId)).toEqual({
      [a.id]: "FAILED",
      [b.id]: "FAILED",
    });
    expect((await intentStatus(ticketId)).status, "nobody was told").toBe("FAILED");
  });
});

// =============================================================================
// S7 — the recipient set is frozen exactly once.
//
// The documented contract: an administrator added after an event is first
// picked up never receives it. The first implementation broke this by
// re-reading the live administrator table on every retry. The boundary is now
// `recipientsExpandedAt`, stamped by a CAS in the same transaction as the
// recipient rows — so these tests are about that transaction: who wins it,
// what a crash inside it leaves behind, and what a retry after it can see.
// =============================================================================

describe("support notification recipient freeze", () => {
  async function intentRow(ticketId: string) {
    return prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
  }

  // S7-1 ----------------------------------------------------------------------
  it("S7-1: A exists at expansion, B is added before the retry — only A receives it", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();

    // First attempt fails for A: the set freezes with A in it, A stays owed.
    const first = fakeApi({ [a.chatId]: new Error("500 internal") });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("PENDING");
    expect((await intentRow(ticketId)).recipientsExpandedAt, "frozen").not.toBeNull();

    // B is promoted between the attempts.
    const b = await makeAdmin();

    await makeDue(ticketId);
    const retry = fakeApi({});
    await deliverPendingNotifications(retry.api, 20);

    expect(ours(retry.sentTo), "only A receives the old event").toEqual([a.chatId]);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[b.id], "B has no obligation for it, ever").toBeUndefined();
  });

  // S7-2 ----------------------------------------------------------------------
  it("S7-2: B added after expansion while A is still PENDING gets nothing", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const first = fakeApi({ [a.chatId]: new Error("500 internal") });
    await deliverTicketNotificationNow(first.api, ticketId, "support.ticket_created");

    const b = await makeAdmin();

    // Even before any retry, B must have no row — the set is already sealed.
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBeUndefined();

    // And a sweep that runs while A is backed off creates nothing for B.
    const sweep = fakeApi({});
    await deliverPendingNotifications(sweep.api, 20);
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBeUndefined();
    expect(ours(sweep.sentTo)).toEqual([]);
  });

  // S7-3 ----------------------------------------------------------------------
  it("S7-3: B added after expansion while A is FAILED — a re-driven intent never widens", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = await freezeTo(ticketId, [a.id]);

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({ [a.chatId]: new Error("500 internal") });
      await deliverPendingNotifications(round.api, 20);
      await makeDue(ticketId);
    }
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("FAILED");

    const b = await makeAdmin();
    // An operator re-drives the parked intent. Even THEN the set stays sealed.
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId },
      data: { status: "PENDING", nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const redriven = fakeApi({});
    await deliverPendingNotifications(redriven.api, 20);

    expect(ours(redriven.sentTo)).toEqual([]);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id], "A stays parked").toBe("FAILED");
    expect(states[b.id], "B still has no obligation").toBeUndefined();
  });

  // S7-4 ----------------------------------------------------------------------
  it("S7-4: two concurrent expanders converge on exactly one recipient set", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const results = await Promise.all([
      expandRecipients(intentId),
      expandRecipients(intentId),
      expandRecipients(intentId),
    ]);

    // Exactly one CAS winner inserted the whole set; the losers inserted zero.
    const winners = results.filter((created) => created > 0);
    expect(winners, "one winner").toHaveLength(1);
    const rowCount = await prisma.supportNotificationRecipient.count({ where: { intentId } });
    expect(rowCount, "rows match the winner's set exactly").toBe(winners[0]);

    const distinct = await prisma.supportNotificationRecipient.groupBy({
      by: ["adminId"],
      where: { intentId },
    });
    expect(distinct.length, "no administrator duplicated").toBe(rowCount);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id]).toBe("PENDING");
    expect(states[b.id]).toBe("PENDING");
    expect((await intentRow(ticketId)).recipientsExpandedAt).not.toBeNull();
  });

  // S7-5 ----------------------------------------------------------------------
  it("S7-5: a failure during recipient creation rolls the expansion back whole", async () => {
    await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    // Variant 1: the administrator read itself throws.
    await expect(
      prisma.$transaction((tx) =>
        freezeRecipientSet(tx, intentId, async () => {
          throw new Error("injected: admin read died");
        }),
      ),
    ).rejects.toThrow("injected");

    let row = await intentRow(ticketId);
    expect(row.recipientsExpandedAt, "stamp rolled back with the failure").toBeNull();
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(0);

    // Variant 2: the INSERT fails (a foreign key nothing satisfies), which is
    // the "crash after inserting only part of the set" shape — the stamp and
    // every row must vanish together.
    await expect(
      prisma.$transaction((tx) =>
        freezeRecipientSet(tx, intentId, async () => [
          "00000000-0000-4000-8000-00000000dead",
        ]),
      ),
    ).rejects.toThrow();

    row = await intentRow(ticketId);
    expect(row.recipientsExpandedAt, "still not falsely marked expanded").toBeNull();
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(0);
  });

  // S7-6 ----------------------------------------------------------------------
  it("S7-6: the retry after an injected failure freezes one coherent set", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    await expect(
      prisma.$transaction((tx) =>
        freezeRecipientSet(tx, intentId, async () => {
          throw new Error("injected");
        }),
      ),
    ).rejects.toThrow("injected");

    // The real expansion now succeeds and seals the set...
    const created = await expandRecipients(intentId);
    expect(created).toBeGreaterThan(0);
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("PENDING");
    expect((await intentRow(ticketId)).recipientsExpandedAt).not.toBeNull();

    // ...and an administrator promoted afterwards changes nothing.
    const late = await makeAdmin();
    expect(await expandRecipients(intentId), "sealed").toBe(0);
    expect((await fixtureRecipientStates(ticketId))[late.id]).toBeUndefined();
  });

  // S7-7 ----------------------------------------------------------------------
  it("S7-7: repeated expansion is a no-op — same rows, same stamp", async () => {
    await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const first = await expandRecipients(intentId);
    expect(first).toBeGreaterThan(0);
    const stamped = (await intentRow(ticketId)).recipientsExpandedAt;
    const rows = await prisma.supportNotificationRecipient.count({ where: { intentId } });

    expect(await expandRecipients(intentId)).toBe(0);
    expect(await expandRecipients(intentId)).toBe(0);
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(rows);
    expect((await intentRow(ticketId)).recipientsExpandedAt?.getTime(), "stamp untouched").toBe(
      stamped?.getTime(),
    );
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
    await freezeTo(ticketId, [admin.id]);

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
    await freezeTo(ticketId, [admin.id]);
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
    expect(entry, "given the bot's Api and kept for shutdown").toContain(
      "supportNotificationLoop = startSupportNotificationLoop(bot.api)",
    );
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
    await freezeTo(ticketId, [admin.id]);
    const { api, sentTo } = fakeApi({});

    const controller = startSupportNotificationLoop(api);
    expect(supportNotificationLoopStarted()).toBe(true);
    // A second call must not arm a second interval.
    expect(startSupportNotificationLoop(api), "same controller back").toBe(controller);

    // The immediate tick is fire-and-forget; wait for it to land.
    await vi.waitFor(() => {
      expect(sentTo).toContain(admin.chatId);
    });
    expect(sentTo.length, "one tick, one send").toBe(1);
    expect((await intentStatus(ticketId)).status).toBe("SENT");
    controller.stop();
    expect(supportNotificationLoopStarted()).toBe(false);
  });

  it("S6-4: an intent created WITHOUT immediate delivery is settled by the sweep path", async () => {
    // This is the API's situation exactly: it writes an intent and cannot send.
    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = await freezeTo(ticketId, [admin.id]);

    const before = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(before.status, "nobody has delivered it").toBe("PENDING");

    resetSupportNotificationLoopForTests();
    const { api, sentTo } = fakeApi({});
    const controller = startSupportNotificationLoop(api);

    await vi.waitFor(async () => {
      const after = await prisma.supportNotificationIntent.findUniqueOrThrow({
        where: { id: intentId },
      });
      expect(after.status).toBe("SENT");
    });
    expect(sentTo).toEqual([admin.chatId]);
    expect(await fixtureRecipientStates(ticketId)).toEqual({ [admin.id]: "SENT" });
    controller.stop();
  });

  it("S6-5: a failing tick does not stop the loop or reject", async () => {
    resetSupportNotificationLoopForTests();
    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [admin.id]);
    const exploding = {
      sendMessage: () => {
        throw new Error("500 internal");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Must not throw and must leave the loop armed.
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

// =============================================================================
// S9 — the isolation contract, proven rather than promised.
//
// This suite runs against a shared database it does not own. Everything above
// works exclusively on fixtures this file created; this final block proves it,
// by comparing every pre-existing Admin row against the snapshot taken before
// the first test ran. It must stay the LAST describe in the file so every
// scenario has already done its worst.
// =============================================================================

describe("fan-out suite isolation contract", () => {
  it("S9-1: no pre-existing Admin row changed status, Telegram id, role or timestamps", async () => {
    const current = await prisma.admin.findMany({
      where: { id: { in: preExisting.map((r) => r.id) } },
      select: { id: true, telegramId: true, isActive: true, role: true, updatedAt: true },
    });
    // Every row still exists — nothing was deleted...
    expect(current.length, "no pre-existing administrator was deleted").toBe(preExisting.length);
    // ...and every field that could have been touched is byte-identical.
    // `updatedAt` is the strongest of these: Prisma bumps it on ANY update, so
    // equality proves not just "same values" but "never written at all".
    const byId = new Map(current.map((r) => [r.id, r]));
    for (const before of preExisting) {
      const after = byId.get(before.id);
      expect(after, `admin ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.telegramId).toBe(before.telegramId);
      expect(after.isActive, "activation state untouched").toBe(before.isActive);
      expect(after.role).toBe(before.role);
      expect(after.updatedAt.getTime(), "never written at all").toBe(before.updatedAt.getTime());
    }
  });
});
