import { readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "@zedbot/database";
import {
  claimDueRecipients,
  claimIntentForTicket,
  createTicket,
  expandRecipients,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_STALE_CLAIM_MS,
  runRecipientFreeze,
} from "@zedbot/support-tickets";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "support-notification-fanout-secret";

import { logger } from "../src/core/logger.js";
import {
  deliverTicketNotificationNow,
  resetSupportNotificationLoopForTests,
  startSupportNotificationLoop,
  supportNotificationLoopStarted,
  type SupportSweepRunner,
} from "../src/services/support-notification.service.js";

// =============================================================================
// S4 — the administrator fan-out.
//
// The property under test is that ONE administrator's outcome is independent of
// every other administrator's, and that the recipient set is decided EXACTLY
// ONCE, from ONE snapshot. Everything here is a property of the database — a
// unique constraint deciding a fan-out, a guarded claim deciding a race, a CAS
// deciding an expansion — so it runs against a real one.
//
// ISOLATION, AND WHY IT IS WRITTEN THIS WAY
//
// This suite shares a database with every other suite. Two earlier versions
// got that wrong in ways worth recording, because both looked reasonable:
//
//   1. It deactivated every administrator and restored them afterwards. A
//      killed run left the whole table disabled and broke unrelated suites.
//   2. It deleted every PENDING and SENDING notification row in `beforeAll`,
//      to stop stale work starving the sweep. That is not fixture isolation —
//      it is a suite deleting other people's durable work to make its own
//      assertions convenient.
//
// So the rule now is absolute: THIS FILE MUTATES ONLY ROWS IT CREATED. Every
// fixture carries a tag no production code writes, cleanup is scoped through
// those tags and the ids derived from them, and nothing global is deleted,
// settled, retried or deactivated.
//
// The one thing that made the global delete tempting was the sweep: it claims
// due work oldest-first with a bounded batch, so foreign debris could starve
// this file's rows. The answer is not to delete the debris — it is to stop
// calling the global sweep. Delivery scenarios drive `deliverTicketNotification
// Now`, which claims exactly one ticket's intent and then runs the SAME
// per-recipient delivery core the sweep runs. The loop scenarios inject a
// sweep scoped to their own ticket. The only global primitive left anywhere in
// this file is one `recoverStaleClaims()` call, which touches nothing but
// SENDING rows whose claim is older than the stale threshold.
//
// That claim is not asserted, it is PROVEN: `beforeAll` plants unrelated
// notification work — a due PENDING intent and a freshly-claimed SENDING one,
// both fully deliverable — and S9 shows every row of it, and every
// pre-existing row in all five tables this file can reach, byte-for-byte
// unchanged afterwards.
//
// The suite is therefore correct with zero active administrators, with
// hundreds, with unrelated inactive administrators, with unrelated pending
// notification work present, and after a previous run of this file was killed
// at any point.
// =============================================================================

const RUN = `s4-${process.pid}-${Date.now()}`;

/**
 * The ownership markers. `firstName` on User and Admin is the only field this
 * file needs that is free text, never read by production logic, and durable —
 * so a run killed halfway can still be identified by the next one WITHOUT
 * touching a row it did not create.
 */
const FIXTURE_TAG = "s4-fanout-fixture";
/**
 * A second, DIFFERENT tag for the planted "somebody else's work" fixture. It
 * must not match FIXTURE_TAG, because the whole point of the plant is to be
 * invisible to this suite's own cleanup and delivery paths.
 */
const UNRELATED_TAG = "s4-unrelated-fixture";

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

// --- the ownership-scoped fixture lifecycle ----------------------------------

/** Every id this file created, resolved from the durable tags. */
async function fixtureIds(tag: string): Promise<{
  userIds: string[];
  ticketIds: string[];
  adminIds: string[];
}> {
  const [taggedUsers, taggedAdmins] = await Promise.all([
    prisma.user.findMany({ where: { firstName: tag }, select: { id: true } }),
    prisma.admin.findMany({ where: { firstName: tag }, select: { id: true } }),
  ]);
  const userIds = taggedUsers.map((row) => row.id);
  const tickets =
    userIds.length === 0
      ? []
      : await prisma.supportTicket.findMany({
          where: { userId: { in: userIds } },
          select: { id: true },
        });
  return { userIds, ticketIds: tickets.map((row) => row.id), adminIds: taggedAdmins.map((r) => r.id) };
}

/**
 * Delete everything reachable from one tag, and nothing else.
 *
 * Note what is NOT here: no status filter, no "all PENDING rows", no
 * unqualified deleteMany anywhere. Every delete is keyed by an id list derived
 * from rows carrying the tag, so a database full of other suites' work is
 * untouched no matter what state that work is in.
 */
async function purgeFixtures(tag: string): Promise<void> {
  const { userIds, ticketIds, adminIds } = await fixtureIds(tag);
  if (ticketIds.length > 0) {
    await prisma.supportNotificationRecipient.deleteMany({
      where: { intent: { ticketId: { in: ticketIds } } },
    });
    await prisma.supportNotificationIntent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  }
  if (userIds.length > 0) {
    await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (adminIds.length > 0) {
    // Recipient rows pointing at a fixture administrator can belong to an
    // intent this file does not own only if production created one for it —
    // impossible, since these administrators exist for exactly the length of
    // this suite. Scoped by id regardless.
    await prisma.supportNotificationRecipient.deleteMany({
      where: { adminId: { in: adminIds } },
    });
    await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
  }
}

/** The unrelated work the suite must leave completely alone. */
interface PlantedWork {
  userId: string;
  ticketId: string;
  duePendingIntentId: string;
  freshlyClaimedIntentId: string;
}
let planted: PlantedWork | null = null;

/**
 * Plant somebody else's notification work, in the two states that a careless
 * suite would damage:
 *
 *   - a PENDING intent that is DUE RIGHT NOW, which any global claim would
 *     take (`claimDueIntents` orders oldest-first and this is the oldest thing
 *     in the file);
 *   - a SENDING intent claimed SECONDS ago, which a careless stale-recovery
 *     would drag back to PENDING.
 *
 * Both are real, renderable, deliverable rows — not inert debris. If this file
 * touches foreign work anywhere, S9 fails.
 */
async function plantUnrelatedWork(): Promise<PlantedWork> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + 31n,
      firstName: UNRELATED_TAG,
    },
  });
  const made = await createTicket(user.id, {
    subject: "کار سوییت دیگر",
    message: "این ردیف متعلق به این تست نیست",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: `unrelated${RUN.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 64).padEnd(16, "0"),
  });
  if (!made.ok) throw new Error(`plant failed: ${made.error}`);
  const ticketId = made.value.ticket.id;

  // createTicket already wrote the support.ticket_created intent. Make it due.
  const created = await prisma.supportNotificationIntent.findFirstOrThrow({
    where: { ticketId, kind: "support.ticket_created" },
  });
  await prisma.supportNotificationIntent.update({
    where: { id: created.id },
    data: { nextAttemptAt: new Date(Date.now() - 60_000) },
  });

  // A second intent on the same message, mid-flight in another process.
  const claimed = await prisma.supportNotificationIntent.create({
    data: {
      ticketId,
      messageId: made.value.messageId,
      kind: "support.user_replied",
      status: "SENDING",
      attempts: 1,
      claimedAt: new Date(),
    },
  });

  return {
    userId: user.id,
    ticketId,
    duePendingIntentId: created.id,
    freshlyClaimedIntentId: claimed.id,
  };
}

// --- the pre-existing world, snapshotted field by field ----------------------
//
// Not just Admin. Every table a scenario in this file can reach: the two
// notification tables, the two ticket tables, and Admin. `updatedAt` is the
// sharpest field of the lot — Prisma bumps it on ANY update, so equality
// proves not "the values match" but "this row was never written".

interface AdminSnapshot {
  id: string;
  telegramId: bigint;
  isActive: boolean;
  role: string;
  firstName: string | null;
  updatedAt: Date;
}
interface IntentSnapshot {
  id: string;
  status: string;
  attempts: number;
  deliveredCount: number;
  safeErrorCode: string | null;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  sentAt: Date | null;
  recipientsExpandedAt: Date | null;
  updatedAt: Date;
}
interface RecipientSnapshot {
  id: string;
  intentId: string;
  adminId: string;
  status: string;
  attempts: number;
  safeErrorCode: string | null;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  sentAt: Date | null;
  updatedAt: Date;
}
interface TicketSnapshot {
  id: string;
  status: string;
  subject: string | null;
  closedAt: Date | null;
  updatedAt: Date;
}
interface MessageSnapshot {
  id: string;
  ticketId: string;
  senderType: string;
  text: string | null;
}

const preAdmins: AdminSnapshot[] = [];
const preIntents: IntentSnapshot[] = [];
const preRecipients: RecipientSnapshot[] = [];
const preTickets: TicketSnapshot[] = [];
const preMessages: MessageSnapshot[] = [];

const ADMIN_FIELDS = {
  id: true,
  telegramId: true,
  isActive: true,
  role: true,
  firstName: true,
  updatedAt: true,
} as const;
const INTENT_FIELDS = {
  id: true,
  status: true,
  attempts: true,
  deliveredCount: true,
  safeErrorCode: true,
  nextAttemptAt: true,
  claimedAt: true,
  sentAt: true,
  recipientsExpandedAt: true,
  updatedAt: true,
} as const;
const RECIPIENT_FIELDS = {
  id: true,
  intentId: true,
  adminId: true,
  status: true,
  attempts: true,
  safeErrorCode: true,
  nextAttemptAt: true,
  claimedAt: true,
  sentAt: true,
  updatedAt: true,
} as const;
const TICKET_FIELDS = {
  id: true,
  status: true,
  subject: true,
  closedAt: true,
  updatedAt: true,
} as const;
const MESSAGE_FIELDS = { id: true, ticketId: true, senderType: true, text: true } as const;

beforeAll(async () => {
  // A previous run that was KILLED leaves its own tagged fixtures behind, in
  // both flavours. They are this file's debris, identified by tags production
  // never writes, and removing them is the only mutation this file makes to
  // rows it did not create in THIS run.
  await purgeFixtures(FIXTURE_TAG);
  await purgeFixtures(UNRELATED_TAG);

  // Plant the foreign work BEFORE the snapshot, so it is snapshotted with
  // everything else and S9 covers it automatically as well as explicitly.
  planted = await plantUnrelatedWork();

  const [adminRows, intentRows, recipientRows, ticketRows, messageRows] = await Promise.all([
    prisma.admin.findMany({ select: ADMIN_FIELDS }),
    prisma.supportNotificationIntent.findMany({ select: INTENT_FIELDS }),
    prisma.supportNotificationRecipient.findMany({ select: RECIPIENT_FIELDS }),
    prisma.supportTicket.findMany({ select: TICKET_FIELDS }),
    prisma.supportMessage.findMany({ select: MESSAGE_FIELDS }),
  ]);
  preAdmins.push(...adminRows);
  preIntents.push(...intentRows);
  preRecipients.push(...recipientRows);
  preTickets.push(...ticketRows);
  preMessages.push(...messageRows);
});

beforeEach(async () => {
  // Each scenario starts from its own clean slate. Scoped to THIS RUN's user
  // ids — earlier cases in this run leave PENDING intents behind by design
  // (that is what partial delivery means), and a later case must not inherit
  // them. Nothing outside `users` is matched.
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
      firstName: FIXTURE_TAG,
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
  await resetSupportNotificationLoopForTests();
  await purgeFixtures(FIXTURE_TAG);
  // The plant is removed LAST and by its own tag, after S9 has proven it
  // survived untouched.
  await purgeFixtures(UNRELATED_TAG);
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
 * Deliver ONE ticket's pending intent.
 *
 * This is the targeted production path: it claims that ticket's intent and
 * then runs the identical expand → claim recipients → send → settle core the
 * sweep runs. Using it instead of the global sweep is what keeps this file's
 * blast radius equal to its own fixtures — and it is a stronger test of a
 * retry anyway, because it cannot accidentally pass by delivering somebody
 * else's row.
 */
async function deliver(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  ticketId: string,
  kind: "support.ticket_created" | "support.user_replied" = "support.ticket_created",
): Promise<number> {
  return deliverTicketNotificationNow(api, ticketId, kind);
}

/**
 * Freeze the ticket's intent to EXACTLY these administrators, through the same
 * primitive production expansion uses — same isolation level, same CAS, same
 * transaction. Delivery then works this set and only this set, so a scenario's
 * counts do not depend on who else happens to be active in a shared database.
 */
async function freezeTo(ticketId: string, adminIds: string[]): Promise<string> {
  const intent = await prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
  await runRecipientFreeze(intent.id, async () => adminIds);
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

async function intentRow(ticketId: string) {
  return prisma.supportNotificationIntent.findFirstOrThrow({ where: { ticketId } });
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

    const reached = await deliver(api, ticketId);
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

    await deliver(api, ticketId);

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
    await deliver(first.api, ticketId);
    expect(first.sentTo).toEqual([a.chatId]);

    await makeDue(ticketId);
    const second = fakeApi({});
    await deliver(second.api, ticketId);

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
    await deliver(first.api, ticketId);
    expect(first.sentTo).toEqual([a.chatId]);

    // Force the row back into contention every way a caller could: clear the
    // backoff, re-open the intent. The obligation is terminal and must stay so.
    await prisma.supportNotificationRecipient.updateMany({
      where: { intentId },
      data: { nextAttemptAt: new Date(Date.now() - 10_000), claimedAt: null },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId },
      data: { status: "PENDING", nextAttemptAt: null },
    });

    const second = fakeApi({});
    await deliver(second.api, ticketId);
    expect(second.sentTo, "the successful administrator is not messaged twice").toEqual([]);
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("SENT");
  });

  // S4-4 ----------------------------------------------------------------------
  it("S4-4: an administrator who blocked the bot is classified and retried", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id]);
    const { api } = fakeApi({ [b.chatId]: new Error("403: bot was blocked by the user") });

    await deliver(api, ticketId);

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
    await deliver(first.api, ticketId);
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBe("PENDING");

    // Deactivated between attempts — this file's OWN fixture, nobody else's.
    await prisma.admin.update({ where: { id: b.id }, data: { isActive: false } });
    await makeDue(ticketId);

    const second = fakeApi({});
    await deliver(second.api, ticketId);
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
    await deliver(first.api, ticketId);
    expect(ours(first.sentTo)).toEqual([a.chatId]);

    // Promoted afterwards. Documented behaviour: they hear about what happens
    // next, not about the backlog.
    const late = await makeAdmin();
    await makeDue(ticketId);
    const second = fakeApi({});
    await deliver(second.api, ticketId);

    expect(ours(second.sentTo)).toEqual([]);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id]).toBe("SENT");
    expect(states[late.id], "no retroactive obligation").toBeUndefined();
  });

  // S4-7 ----------------------------------------------------------------------
  it("S4-7: concurrent delivery attempts send to each administrator exactly once", async () => {
    const [a, b, c] = [await makeAdmin(), await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id, c.id]);

    const one = fakeApi({});
    const two = fakeApi({});
    const three = fakeApi({});
    // Three workers reaching for the same intent at the same moment. The
    // guarded claim decides; the losers must send nothing at all.
    await Promise.all([
      deliver(one.api, ticketId),
      deliver(two.api, ticketId),
      deliver(three.api, ticketId),
    ]);

    const all = [...one.sentTo, ...two.sentTo, ...three.sentTo];
    expect(all.length, "three sends total, not nine").toBe(3);
    expect(new Set(all)).toEqual(new Set([a.chatId, b.chatId, c.chatId]));
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 3 });
  });

  // S4-8 ----------------------------------------------------------------------
  it("S4-8: an intent recovered after a worker died finishes every outstanding recipient", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const intentId = await freezeTo(ticketId, [a.id, b.id]);

    // A worker claims the intent and its recipients, then dies.
    const intent = await claimIntentForTicket(ticketId, "support.ticket_created");
    expect(intent).not.toBeNull();
    if (intent === null) return;
    const claimed = await claimDueRecipients(intentId);
    expect(claimed).toHaveLength(2);

    // Nothing else can see them: the intent is SENDING, so a fresh attempt
    // claims nothing and sends nothing. A live worker is not interrupted.
    const blocked = fakeApi({});
    expect(await deliver(blocked.api, ticketId)).toBe(0);
    expect(blocked.sentTo).toEqual([]);

    // ARRANGEMENT, not re-implementation: put this intent and its obligations
    // into the state recovery produces — PENDING, claim released, due now — on
    // THIS FILE'S ROWS ONLY.
    //
    // `recoverStaleClaims()` is deliberately NOT called here. It is global by
    // design: it matches every SENDING row in the database whose claim
    // predates the stale threshold, so invoking it from a suite that shares a
    // database drags other suites' abandoned work back to PENDING. That is
    // precisely the kind of mutation this file must never perform, and S9
    // catches it when it happens. The function's own behaviour — fresh claims
    // untouched, abandoned claims returned, terminal rows ignored — is covered
    // by support-notification-intents.test.ts.
    //
    // What is under test HERE is the part only the fan-out owns: once an
    // abandoned intent is back in play, a retry finishes the obligations that
    // are still outstanding, and finishes the aggregate.
    const recoveredAt = new Date(Date.now() - NOTIFICATION_STALE_CLAIM_MS);
    await prisma.supportNotificationRecipient.updateMany({
      where: { intentId, status: "SENDING" },
      data: { status: "PENDING", claimedAt: null, nextAttemptAt: recoveredAt },
    });
    await prisma.supportNotificationIntent.updateMany({
      where: { id: intentId, status: "SENDING" },
      data: { status: "PENDING", claimedAt: null, nextAttemptAt: recoveredAt },
    });

    const rescued = fakeApi({});
    await deliver(rescued.api, ticketId);
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
      await deliver(round.api, ticketId);
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
    // Frozen EMPTY — the durable outcome of expansion finding nobody eligible.
    // Frozen through the same primitive, so the completion path under test is
    // exactly the production one, without needing the shared table to be empty.
    const ticketId = await makeTicket();
    await freezeTo(ticketId, []);
    const { api, sentTo } = fakeApi({});
    await deliver(api, ticketId);
    expect(sentTo).toEqual([]);
    expect(await intentStatus(ticketId)).toEqual({ status: "SENT", deliveredCount: 0 });
  });

  // S4-11 ---------------------------------------------------------------------
  it("S4-11: every administrator failing leaves the intent incomplete, then FAILED", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [a.id, b.id]);

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({}, new Error("500 internal"));
      await deliver(round.api, ticketId);
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
// S10 — the recipient-set linearization point, with the interleaving pinned.
//
// The contract is a statement about an INSTANT inside a transaction: the set
// is the administrators visible at the eligibility query, the first statement
// of a Repeatable Read transaction. No assertion made from outside that
// transaction can demonstrate it — by the time a test can look, the
// transaction has committed and both orderings produce the same visible end
// state unless the timing was controlled.
//
// So these drive the production `expandRecipients` and use its `afterSnapshot`
// seam to stop time exactly once: after the snapshot is fixed, before anything
// is written. What happens in that window is a real, committed administrator
// change on a different connection — the thing the old implementation let
// through.
// =============================================================================

describe("recipient-set linearization point", () => {
  // S10-1 ---------------------------------------------------------------------
  it("S10-1: an administrator committed AFTER the snapshot is excluded", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const late: { id: string; chatId: string }[] = [];
    const outcome = await expandRecipients(intentId, {
      afterSnapshot: async (tx) => {
        // (2) THE ORDERING ITSELF, asserted at the pinned instant.
        //
        // This is what separates the implementation from the one it replaced.
        // The old code stamped `recipientsExpandedAt` FIRST and read the
        // administrator table afterwards, so at this moment the intent already
        // claimed to be frozen while the set had not been read yet — and
        // anything committing in that window landed in a set the code called
        // sealed. Reaching this line with the stamp still NULL is the proof
        // that the snapshot precedes the decision rather than following it.
        const mid = await tx.supportNotificationIntent.findUniqueOrThrow({
          where: { id: intentId },
          select: { recipientsExpandedAt: true },
        });
        expect(
          mid.recipientsExpandedAt,
          "the eligible set is read BEFORE the intent is declared frozen",
        ).toBeNull();

        // (3) Another transaction creates and activates B, and COMMITS, while
        // the freeze transaction is holding its snapshot.
        const b = await makeAdmin();
        late.push(b);
        // Committed for real: visible to a reader outside the freeze.
        const live = await prisma.admin.findUnique({ where: { id: b.id } });
        expect(live?.isActive, "B is genuinely active and committed").toBe(true);
      },
    });

    // (4) The expansion commits.
    expect(outcome.frozen, "this call froze the set").toBe(true);
    const b = late[0];
    expect(b, "B was created inside the window").toBeDefined();

    // (5) B has no recipient row — not now, not ever.
    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { intentId },
      select: { adminId: true },
    });
    const ids = new Set(rows.map((r) => r.adminId));
    expect(ids.has(a.id), "A was eligible at the snapshot").toBe(true);
    expect(ids.has(b.id), "B committed after the snapshot and is excluded").toBe(false);
  });

  // S10-2 ---------------------------------------------------------------------
  it("S10-2: the inverse ordering — an administrator committed BEFORE the snapshot is included", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    // B commits BEFORE the freeze begins, so the snapshot must see it. This is
    // the half that a "freeze everything, include nobody" implementation would
    // pass by accident — without it, S10-1 proves nothing.
    const b = await makeAdmin();
    const live = await prisma.admin.findMany({
      where: { id: { in: [a.id, b.id] }, isActive: true },
      select: { id: true },
    });
    expect(live).toHaveLength(2);

    const outcome = await expandRecipients(intentId);
    expect(outcome.frozen).toBe(true);

    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { intentId },
      select: { adminId: true },
    });
    const ids = new Set(rows.map((r) => r.adminId));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id), "committed before the snapshot, so owed the event").toBe(true);
  });

  // S10-3 ---------------------------------------------------------------------
  it("S10-3: an administrator ACTIVATED (not created) after the snapshot is excluded", async () => {
    // The other way an administrator becomes eligible: an existing inactive row
    // is switched on. Eligibility is `isActive`, so this must behave
    // identically to a fresh insert.
    const a = await makeAdmin();
    const dormant = await makeAdmin();
    await prisma.admin.update({ where: { id: dormant.id }, data: { isActive: false } });

    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const outcome = await expandRecipients(intentId, {
      afterSnapshot: async () => {
        await prisma.admin.update({ where: { id: dormant.id }, data: { isActive: true } });
      },
    });
    expect(outcome.frozen).toBe(true);

    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { intentId },
      select: { adminId: true },
    });
    const ids = new Set(rows.map((r) => r.adminId));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(dormant.id), "activated after the snapshot").toBe(false);
  });

  // S10-4 ---------------------------------------------------------------------
  it("S10-4: two expanders that both snapshot before either commits converge on one set", async () => {
    await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    // The slow expander takes its snapshot and then waits, holding it.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = expandRecipients(intentId, { afterSnapshot: () => gate });

    // Give it a moment to actually reach the seam, then let a second expander
    // run start-to-finish inside the window.
    await vi.waitFor(() => {
      expect(release).toBeTypeOf("function");
    });
    const fast = await expandRecipients(intentId);
    release();
    const slowOutcome = await slow;

    // Exactly one froze the set. The other wrote nothing at all — whether it
    // lost the CAS outright or hit a serialization failure and found the set
    // already frozen on its bounded retry.
    const frozenBy = [fast, slowOutcome].filter((o) => o.frozen);
    expect(frozenBy, "exactly one winner").toHaveLength(1);

    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { intentId },
      select: { adminId: true },
    });
    expect(rows.length, "rows match the winner's set exactly").toBe(frozenBy[0].created);
    const distinct = new Set(rows.map((r) => r.adminId));
    expect(distinct.size, "no administrator duplicated").toBe(rows.length);
  });
});

// =============================================================================
// S7 — the recipient set is frozen exactly once.
//
// The documented contract: an administrator added after an event is first
// picked up never receives it. The boundary is `recipientsExpandedAt`, stamped
// by a CAS in the same transaction as the recipient rows — so these are about
// that transaction: who wins it, what a crash inside it leaves behind, and
// what a retry after it can see.
// =============================================================================

describe("support notification recipient freeze", () => {
  // S7-1 ----------------------------------------------------------------------
  it("S7-1: A exists at expansion, B is added before the retry — only A receives it", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();

    // First attempt fails for A: the set freezes with A in it, A stays owed.
    const first = fakeApi({ [a.chatId]: new Error("500 internal") });
    await deliver(first.api, ticketId);
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("PENDING");
    expect((await intentRow(ticketId)).recipientsExpandedAt, "frozen").not.toBeNull();

    // B is promoted between the attempts.
    const b = await makeAdmin();

    await makeDue(ticketId);
    const retry = fakeApi({});
    await deliver(retry.api, ticketId);

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
    await deliver(first.api, ticketId);

    const b = await makeAdmin();

    // Even before any retry, B must have no row — the set is already sealed.
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBeUndefined();

    // And another attempt while A is backed off creates nothing for B.
    const again = fakeApi({});
    await deliver(again.api, ticketId);
    expect((await fixtureRecipientStates(ticketId))[b.id]).toBeUndefined();
    expect(ours(again.sentTo)).toEqual([]);
  });

  // S7-3 ----------------------------------------------------------------------
  it("S7-3: B added after expansion while A is FAILED — a re-driven intent never widens", async () => {
    const a = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = await freezeTo(ticketId, [a.id]);

    for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      const round = fakeApi({ [a.chatId]: new Error("500 internal") });
      await deliver(round.api, ticketId);
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
    await deliver(redriven.api, ticketId);

    expect(ours(redriven.sentTo)).toEqual([]);
    const states = await fixtureRecipientStates(ticketId);
    expect(states[a.id], "A stays parked").toBe("FAILED");
    expect(states[b.id], "B still has no obligation").toBeUndefined();
  });

  // S7-4 ----------------------------------------------------------------------
  it("S7-4: three concurrent expanders converge on exactly one recipient set", async () => {
    const [a, b] = [await makeAdmin(), await makeAdmin()];
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const results = await Promise.all([
      expandRecipients(intentId),
      expandRecipients(intentId),
      expandRecipients(intentId),
    ]);

    // Exactly one froze the set; the losers inserted zero.
    const winners = results.filter((outcome) => outcome.frozen);
    expect(winners, "one winner").toHaveLength(1);
    const rowCount = await prisma.supportNotificationRecipient.count({ where: { intentId } });
    expect(rowCount, "rows match the winner's set exactly").toBe(winners[0].created);

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

    // Variant 1: the eligibility read itself throws.
    await expect(
      runRecipientFreeze(intentId, async () => {
        throw new Error("injected: admin read died");
      }),
    ).rejects.toThrow("injected");

    let row = await intentRow(ticketId);
    expect(row.recipientsExpandedAt, "stamp rolled back with the failure").toBeNull();
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(0);

    // Variant 2: the INSERT fails (a foreign key nothing satisfies), which is
    // the "crash after inserting only part of the set" shape — the stamp and
    // every row must vanish together.
    await expect(
      runRecipientFreeze(intentId, async () => ["00000000-0000-4000-8000-00000000dead"]),
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
      runRecipientFreeze(intentId, async () => {
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");

    // The real expansion now succeeds and seals the set...
    const created = await expandRecipients(intentId);
    expect(created.frozen).toBe(true);
    expect(created.created).toBeGreaterThan(0);
    expect((await fixtureRecipientStates(ticketId))[a.id]).toBe("PENDING");
    expect((await intentRow(ticketId)).recipientsExpandedAt).not.toBeNull();

    // ...and an administrator promoted afterwards changes nothing.
    const late = await makeAdmin();
    expect(await expandRecipients(intentId), "sealed").toEqual({ frozen: false, created: 0 });
    expect((await fixtureRecipientStates(ticketId))[late.id]).toBeUndefined();
  });

  // S7-7 ----------------------------------------------------------------------
  it("S7-7: repeated expansion is a no-op — same rows, same stamp", async () => {
    await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const first = await expandRecipients(intentId);
    expect(first.frozen).toBe(true);
    const stamped = (await intentRow(ticketId)).recipientsExpandedAt;
    const rows = await prisma.supportNotificationRecipient.count({ where: { intentId } });

    expect(await expandRecipients(intentId)).toEqual({ frozen: false, created: 0 });
    expect(await expandRecipients(intentId)).toEqual({ frozen: false, created: 0 });
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(rows);
    expect((await intentRow(ticketId)).recipientsExpandedAt?.getTime(), "stamp untouched").toBe(
      stamped?.getTime(),
    );
  });

  // S7-8 ----------------------------------------------------------------------
  it("S7-8: an empty eligible set is frozen as a valid empty set, not left unfrozen", async () => {
    const ticketId = await makeTicket();
    const intentId = (await intentRow(ticketId)).id;

    const outcome = await runRecipientFreeze(intentId, async () => []);
    expect(outcome, "frozen, with nobody in it").toEqual({ frozen: true, created: 0 });
    expect(
      (await intentRow(ticketId)).recipientsExpandedAt,
      "an empty set is still a decision, and it is durable",
    ).not.toBeNull();

    // And it does not re-open later, whoever joins.
    await makeAdmin();
    expect(await expandRecipients(intentId)).toEqual({ frozen: false, created: 0 });
    expect(await prisma.supportNotificationRecipient.count({ where: { intentId } })).toBe(0);
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
    await deliver(api, ticketId);

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

  it("S5-2: a delivery failure logs a classified code, not the thrown error", async () => {
    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [admin.id]);
    const leak = new Error(`chat not found: chat_id=${admin.chatId} @leaky ${ticketId}`);
    const { api } = fakeApi({ [admin.chatId]: leak });

    await deliver(api, ticketId);

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
//
// The behavioural cases inject a sweep SCOPED to their own ticket. What they
// are testing is the loop — that it ticks immediately, that a tick's work
// lands, that a failure does not disarm it — not the sweep's global claim
// query, which has its own coverage and which this file must not run. S6-6
// closes the gap that injection would otherwise open: production passes no
// sweep, and the default is the real one.
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

  /** A sweep that delivers exactly one ticket — this file's blast radius. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function scopedSweep(api: any, ticketId: string): SupportSweepRunner {
    return async () => {
      const sent = await deliver(api, ticketId);
      return { recovered: 0, delivered: sent > 0 ? 1 : 0 };
    };
  }

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
    expect(at("const bot = createBot(botToken, getTelegramApiRoot())"), "Api first").toBeLessThan(start);
    expect(at('process.on("SIGTERM"'), "shutdown armed first").toBeLessThan(start);
    expect(at("await connectDatabaseWithRetry()"), "database attempted first").toBeLessThan(start);
  });

  it("S6-3: the loop latches, ticks immediately and never holds the process open", async () => {
    await resetSupportNotificationLoopForTests();
    expect(supportNotificationLoopStarted()).toBe(false);

    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    await freezeTo(ticketId, [admin.id]);
    const { api, sentTo } = fakeApi({});

    const controller = startSupportNotificationLoop(api, scopedSweep(api, ticketId));
    expect(supportNotificationLoopStarted()).toBe(true);
    // A second call must not arm a second interval.
    expect(startSupportNotificationLoop(api), "same controller back").toBe(controller);

    // The immediate tick is fire-and-forget; drain is how a caller waits.
    await controller.stopAndDrain();
    expect(sentTo, "one tick, one send").toEqual([admin.chatId]);
    expect((await intentStatus(ticketId)).status).toBe("SENT");
    expect(supportNotificationLoopStarted()).toBe(false);
  });

  it("S6-4: an intent created WITHOUT immediate delivery is settled by a loop tick", async () => {
    // This is the API's situation exactly: it writes an intent and cannot send.
    const admin = await makeAdmin();
    const ticketId = await makeTicket();
    const intentId = await freezeTo(ticketId, [admin.id]);

    const before = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(before.status, "nobody has delivered it").toBe("PENDING");

    await resetSupportNotificationLoopForTests();
    const { api, sentTo } = fakeApi({});
    const controller = startSupportNotificationLoop(api, scopedSweep(api, ticketId));

    await controller.stopAndDrain();
    const after = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    expect(after.status).toBe("SENT");
    expect(sentTo).toEqual([admin.chatId]);
    expect(await fixtureRecipientStates(ticketId)).toEqual({ [admin.id]: "SENT" });
  });

  it("S6-5: a failing tick does not stop the loop or reject", async () => {
    await resetSupportNotificationLoopForTests();
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
    let controller: ReturnType<typeof startSupportNotificationLoop> | null = null;
    expect(() => {
      controller = startSupportNotificationLoop(exploding, scopedSweep(exploding, ticketId));
    }).not.toThrow();
    expect(supportNotificationLoopStarted()).toBe(true);

    await controller!.stopAndDrain();
    const rows = await prisma.supportNotificationRecipient.findMany({
      where: { adminId: admin.id },
      select: { attempts: true },
    });
    expect(rows.length, "the tick ran and recorded the failure").toBeGreaterThan(0);
    expect(rows[0].attempts).toBeGreaterThan(0);
  });

  it("S6-6: production injects no sweep, and the default sweep is the real one", () => {
    // Injection is a test affordance. If production ever started passing its
    // own sweep, every behavioural case above would keep passing while the
    // real sweep — the only thing that discovers work nobody delivered — went
    // uncalled. So: exactly one argument at the call site...
    expect(entry).toMatch(/startSupportNotificationLoop\(\s*bot\.api\s*\)/);
    // ...and the parameter it falls back to is runSupportNotificationSweep.
    const service = readFileSync(
      path.join(import.meta.dirname, "..", "src", "services", "support-notification.service.ts"),
      "utf8",
    );
    expect(service).toMatch(
      /sweep:\s*SupportSweepRunner\s*=\s*runSupportNotificationSweep/,
      "the default sweep is the production sweep",
    );
  });
});

// =============================================================================
// S9 — the isolation contract, proven rather than promised.
//
// Everything above works exclusively on fixtures this file created. This final
// block proves it, by comparing every pre-existing row in every table this file
// can reach against the snapshot taken before the first test ran — including
// the unrelated notification work planted in `beforeAll` precisely so there is
// something a careless suite WOULD have damaged.
//
// It must stay the LAST describe in the file so every scenario has already
// done its worst.
// =============================================================================

describe("fan-out suite isolation contract", () => {
  function sameDate(a: Date | null, b: Date | null): boolean {
    if (a === null || b === null) return a === b;
    return a.getTime() === b.getTime();
  }

  it("S9-1: no pre-existing Admin row changed", async () => {
    const current = await prisma.admin.findMany({
      where: { id: { in: preAdmins.map((r) => r.id) } },
      select: ADMIN_FIELDS,
    });
    expect(current.length, "no pre-existing administrator was deleted").toBe(preAdmins.length);
    const byId = new Map(current.map((r) => [r.id, r]));
    for (const before of preAdmins) {
      const after = byId.get(before.id);
      expect(after, `admin ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.telegramId).toBe(before.telegramId);
      expect(after.isActive, "activation state untouched").toBe(before.isActive);
      expect(after.role).toBe(before.role);
      expect(after.firstName).toBe(before.firstName);
      // Prisma bumps updatedAt on ANY update, so equality proves not just
      // "same values" but "never written at all".
      expect(after.updatedAt.getTime(), "never written at all").toBe(before.updatedAt.getTime());
    }
  });

  it("S9-2: no pre-existing SupportNotificationIntent changed", async () => {
    const current = await prisma.supportNotificationIntent.findMany({
      where: { id: { in: preIntents.map((r) => r.id) } },
      select: INTENT_FIELDS,
    });
    expect(current.length, "no pre-existing intent was deleted").toBe(preIntents.length);
    const byId = new Map(current.map((r) => [r.id, r]));
    for (const before of preIntents) {
      const after = byId.get(before.id);
      expect(after, `intent ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.status, "not claimed, settled or re-driven").toBe(before.status);
      expect(after.attempts, "not retried").toBe(before.attempts);
      expect(after.deliveredCount).toBe(before.deliveredCount);
      expect(after.safeErrorCode).toBe(before.safeErrorCode);
      expect(sameDate(after.nextAttemptAt, before.nextAttemptAt), "backoff untouched").toBe(true);
      expect(sameDate(after.claimedAt, before.claimedAt), "claim untouched").toBe(true);
      expect(sameDate(after.sentAt, before.sentAt)).toBe(true);
      expect(
        sameDate(after.recipientsExpandedAt, before.recipientsExpandedAt),
        "not expanded by this suite",
      ).toBe(true);
      expect(after.updatedAt.getTime(), "never written at all").toBe(before.updatedAt.getTime());
    }
  });

  it("S9-3: no pre-existing SupportNotificationRecipient changed", async () => {
    const current = await prisma.supportNotificationRecipient.findMany({
      where: { id: { in: preRecipients.map((r) => r.id) } },
      select: RECIPIENT_FIELDS,
    });
    expect(current.length, "no pre-existing obligation was deleted").toBe(preRecipients.length);
    const byId = new Map(current.map((r) => [r.id, r]));
    for (const before of preRecipients) {
      const after = byId.get(before.id);
      expect(after, `recipient ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.intentId).toBe(before.intentId);
      expect(after.adminId).toBe(before.adminId);
      expect(after.status).toBe(before.status);
      expect(after.attempts).toBe(before.attempts);
      expect(after.safeErrorCode).toBe(before.safeErrorCode);
      expect(sameDate(after.nextAttemptAt, before.nextAttemptAt)).toBe(true);
      expect(sameDate(after.claimedAt, before.claimedAt)).toBe(true);
      expect(sameDate(after.sentAt, before.sentAt)).toBe(true);
      expect(after.updatedAt.getTime(), "never written at all").toBe(before.updatedAt.getTime());
    }
  });

  it("S9-4: no pre-existing SupportTicket or SupportMessage changed", async () => {
    const tickets = await prisma.supportTicket.findMany({
      where: { id: { in: preTickets.map((r) => r.id) } },
      select: TICKET_FIELDS,
    });
    expect(tickets.length, "no pre-existing ticket was deleted").toBe(preTickets.length);
    const ticketById = new Map(tickets.map((r) => [r.id, r]));
    for (const before of preTickets) {
      const after = ticketById.get(before.id);
      expect(after, `ticket ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.status).toBe(before.status);
      expect(after.subject).toBe(before.subject);
      expect(sameDate(after.closedAt, before.closedAt)).toBe(true);
      expect(after.updatedAt.getTime(), "never written at all").toBe(before.updatedAt.getTime());
    }

    const messages = await prisma.supportMessage.findMany({
      where: { id: { in: preMessages.map((r) => r.id) } },
      select: MESSAGE_FIELDS,
    });
    expect(messages.length, "no pre-existing message was deleted").toBe(preMessages.length);
    const messageById = new Map(messages.map((r) => [r.id, r]));
    for (const before of preMessages) {
      const after = messageById.get(before.id);
      expect(after, `message ${before.id.slice(0, 8)} still present`).toBeDefined();
      if (after === undefined) continue;
      expect(after.ticketId).toBe(before.ticketId);
      expect(after.senderType).toBe(before.senderType);
      expect(after.text).toBe(before.text);
    }
  });

  it("S9-5: the planted unrelated notification work survived, in its exact original state", async () => {
    // The sharpest assertion in the file. This intent was PENDING and DUE for
    // the whole run — the single most claimable row in the database — and this
    // one was SENDING with a fresh claim, the shape a careless stale-recovery
    // eats. Both are named explicitly rather than left to the bulk comparison
    // above, because "we planted bait and it was not taken" is the claim.
    expect(planted, "the plant exists").not.toBeNull();
    if (planted === null) return;

    const due = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: planted.duePendingIntentId },
    });
    expect(due.status, "still PENDING — never claimed").toBe("PENDING");
    expect(due.attempts, "never attempted").toBe(0);
    expect(due.recipientsExpandedAt, "never expanded").toBeNull();
    expect(due.claimedAt).toBeNull();
    expect(
      await prisma.supportNotificationRecipient.count({ where: { intentId: due.id } }),
      "no obligations were fanned out for somebody else's intent",
    ).toBe(0);

    const claimed = await prisma.supportNotificationIntent.findUniqueOrThrow({
      where: { id: planted.freshlyClaimedIntentId },
    });
    expect(claimed.status, "a fresh claim by another process was left alone").toBe("SENDING");
    expect(claimed.attempts).toBe(1);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: planted.ticketId },
    });
    expect(ticket.status, "somebody else's ticket was not touched").toBe("WAITING_ADMIN");
  });
});
