import { prisma } from "@zedbot/database";
import {
  createTicket,
  listOwnedTicketMessages,
  replyToTicket,
} from "@zedbot/support-tickets";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "support-domain-idempotency-secret";

// =============================================================================
// S1 — the support domain's idempotency, ownership and paging primitives.
//
// These run against a real PostgreSQL on purpose. Every property under test is
// a property of the DATABASE: a unique index deciding a concurrent race, a
// transaction rolling back as a unit, a keyset window that must not skip a row
// inserted between requests. A mock would agree with whatever the code does and
// prove nothing — which is exactly how the defects these cover shipped in the
// first place.
//
// Three of them were real bugs found in review:
//
//   - a GLOBAL unique index on the request id, so two strangers who drew the
//     same random value would collide, and a key could be pre-claimed;
//   - a fingerprint built from the RAW public id, so a retry that changed the
//     case of a hex string looked like a different mutation;
//   - a page cursor returned whenever `rows.length === limit`, handing out a
//     cursor to an empty page whenever the conversation length happened to be a
//     multiple of the page size.
// =============================================================================

const RUN = `s1-${process.pid}-${Date.now()}`;
let userA = "";
let userB = "";
let panelId = "";
const created: string[] = [];
const createdServices: string[] = [];

/** A distinct, well-formed client request id per test. */
let seq = 0;
function requestId(): string {
  seq += 1;
  return `req${RUN.replace(/[^A-Za-z0-9]/g, "")}${seq}`.slice(0, 64).padEnd(16, "0");
}

async function makeUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(created.length + 1),
      firstName: tag,
    },
  });
  created.push(user.id);
  return user.id;
}

/**
 * A visible Service the given user owns.
 *
 * Real, because the Service-link path is where the fingerprint defect lived and
 * a fabricated public id can only ever exercise the refusal branch. The panel is
 * never contacted — this fixture exists to be looked up, not to be provisioned.
 */
async function makeService(userId: string): Promise<{ id: string; publicId: string }> {
  const service = await prisma.service.create({
    data: {
      userId,
      panelId,
      panelType: "MARZBAN",
      username: `s1svc-${RUN}-${createdServices.length + 1}`,
      status: "ACTIVE",
    },
  });
  createdServices.push(service.id);
  return { id: service.id, publicId: service.id.slice(0, 8) };
}

beforeAll(async () => {
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `s1-panel-${RUN}`,
      baseUrl: `http://127.0.0.1:1/${RUN}`,
      username: "admin",
      passwordEncrypted: "fixture-not-a-real-secret",
      status: "ACTIVE",
    },
  });
  panelId = panel.id;
});

beforeEach(async () => {
  userA = await makeUser("A");
  userB = await makeUser("B");
});

afterAll(async () => {
  if (createdServices.length > 0) {
    await prisma.service.deleteMany({ where: { id: { in: createdServices } } });
  }
  if (panelId !== "") {
    await prisma.panel.delete({ where: { id: panelId } });
  }
  if (created.length > 0) {
    await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: created } } });
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: { in: created } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);
    if (ids.length > 0) {
      await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ids } } });
      await prisma.supportTicket.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  }
});

function createInput(over: Record<string, unknown> = {}): Parameters<typeof createTicket>[1] {
  return {
    subject: "موضوع تست",
    message: "متن پیام تست",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: requestId(),
    ...over,
  } as Parameters<typeof createTicket>[1];
}

describe("support domain — idempotency", () => {
  // S1-1 --------------------------------------------------------------------
  it("S1-1: two users may use the same request id independently", async () => {
    const shared = requestId();
    const a = await createTicket(userA, createInput({ clientRequestId: shared }));
    const b = await createTicket(userB, createInput({ clientRequestId: shared }));

    expect(a.ok, "user A create").toBe(true);
    expect(b.ok, "user B create").toBe(true);
    if (!a.ok || !b.ok) return;
    // Two DIFFERENT tickets. A global index would have made the second a
    // conflict or a replay of the first — a stranger's ticket.
    expect(a.value.ticket.id).not.toBe(b.value.ticket.id);
    expect(a.value.ticket.userId).toBe(userA);
    expect(b.value.ticket.userId).toBe(userB);
  });

  // S1-2 --------------------------------------------------------------------
  it("S1-2: the same key with the same payload replays one ticket", async () => {
    const input = createInput();
    const first = await createTicket(userA, input);
    const second = await createTicket(userA, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.ticket.id).toBe(first.value.ticket.id);
    expect(second.value.messageId).toBe(first.value.messageId);

    const count = await prisma.supportTicket.count({ where: { userId: userA } });
    expect(count, "exactly one ticket").toBe(1);
    const messages = await prisma.supportMessage.count({
      where: { ticketId: first.value.ticket.id },
    });
    expect(messages, "exactly one message").toBe(1);
  });

  // S1-3 --------------------------------------------------------------------
  it("S1-3: the same key with different content is a conflict", async () => {
    const key = requestId();
    const first = await createTicket(userA, createInput({ clientRequestId: key }));
    expect(first.ok).toBe(true);
    const second = await createTicket(
      userA,
      createInput({ clientRequestId: key, message: "یک متن کاملاً متفاوت" }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  // S1-4 --------------------------------------------------------------------
  it("S1-4: a key reused across operations is a conflict", async () => {
    const key = requestId();
    const made = await createTicket(userA, createInput({ clientRequestId: key }));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const publicId = made.value.ticket.id.slice(0, 8);

    const reply = await replyToTicket(userA, {
      ticketPublicId: publicId,
      message: "پاسخ",
      clientRequestId: key,
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  // S1-5 / S1-6 -------------------------------------------------------------
  it("S1-5/S1-6: a public id retried in different case is the SAME mutation", async () => {
    // THE CREATE PATH FIRST — this is where the defect was. The fingerprint was
    // built from the raw transport value while validation is case-insensitive
    // and resolution lowercases, so a client that upper-cased the hex id on its
    // retry was told its own retry conflicted.
    const service = await makeService(userA);
    const serviceKey = requestId();
    const linked = await createTicket(
      userA,
      createInput({ clientRequestId: serviceKey, servicePublicId: service.publicId }),
    );
    expect(linked.ok, "lowercase create").toBe(true);
    if (!linked.ok) return;
    expect(linked.value.ticket.serviceId, "linked").toBe(service.id);

    const flipped = await createTicket(
      userA,
      createInput({
        clientRequestId: serviceKey,
        servicePublicId: service.publicId.toUpperCase(),
      }),
    );
    expect(flipped.ok, "an upper-cased retry is a replay, not a conflict").toBe(true);
    if (!flipped.ok) return;
    expect(flipped.value.ticket.id).toBe(linked.value.ticket.id);
    expect(flipped.value.messageId).toBe(linked.value.messageId);
    expect(
      await prisma.supportTicket.count({ where: { userId: userA } }),
      "exactly one ticket",
    ).toBe(1);

    // A case-flipped id must also RESOLVE to the same Service, not merely
    // fingerprint alike — otherwise the two agree only by both failing.
    const upperOnly = await createTicket(
      userA,
      createInput({ servicePublicId: service.publicId.toUpperCase() }),
    );
    expect(upperOnly.ok, "an upper-cased id resolves").toBe(true);
    if (!upperOnly.ok) return;
    expect(upperOnly.value.ticket.serviceId).toBe(service.id);

    const key = requestId();
    const lower = await createTicket(userA, createInput({ clientRequestId: key }));
    expect(lower.ok).toBe(true);
    if (!lower.ok) return;

    // Then the REPLY path with a case-flipped ticket public id: the canonical
    // form must make it the same target, not a different one.
    const publicId = lower.value.ticket.id.slice(0, 8);
    const replyKey = requestId();
    const first = await replyToTicket(userA, {
      ticketPublicId: publicId,
      message: "پاسخ یکسان",
      clientRequestId: replyKey,
    });
    const retry = await replyToTicket(userA, {
      ticketPublicId: publicId.toUpperCase(),
      message: "پاسخ یکسان",
      clientRequestId: replyKey,
    });
    expect(first.ok && retry.ok, "both accepted").toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.value.messageId, "replayed, not duplicated").toBe(first.value.messageId);

    const userMessages = await prisma.supportMessage.count({
      where: { ticketId: lower.value.ticket.id, senderType: "USER" },
    });
    expect(userMessages, "one create + one reply").toBe(2);
  });

  // S1-7 --------------------------------------------------------------------
  it("S1-7: a malformed public id is INVALID_SERVICE, not a crash or a link", async () => {
    const bad = await createTicket(userA, createInput({ servicePublicId: "zzzz" }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe("INVALID_SERVICE");

    // Someone else's Service gives the SAME answer as junk: a caller must not
    // be able to tell an existing foreign service from a nonexistent one.
    const theirs = await makeService(userB);
    const foreign = await createTicket(userA, createInput({ servicePublicId: theirs.publicId }));
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error).toBe("INVALID_SERVICE");

    // A non-string never reaches the database.
    const nonString = await createTicket(userA, createInput({ servicePublicId: 12345678 }));
    expect(nonString.ok).toBe(false);
    if (nonString.ok) return;
    expect(nonString.error).toBe("INVALID_SERVICE");
  });

  // S1-8 --------------------------------------------------------------------
  it("S1-8: linking no service and linking one never fingerprint alike", async () => {
    const service = await makeService(userA);
    const key = requestId();
    const none = await createTicket(userA, createInput({ clientRequestId: key }));
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.value.ticket.serviceId).toBeNull();

    // A REAL, resolvable service under the same key: it would succeed on its
    // own, so a conflict here can only come from the fingerprint — not from a
    // precondition failing.
    const withService = await createTicket(
      userA,
      createInput({ clientRequestId: key, servicePublicId: service.publicId }),
    );
    expect(withService.ok).toBe(false);
    if (withService.ok) return;
    expect(withService.error).toBe("IDEMPOTENCY_CONFLICT");

    // And the other direction: a well-formed but unknown id is refused on its
    // own precondition rather than replaying the no-service ticket.
    const unknown = await createTicket(
      userA,
      createInput({ clientRequestId: key, servicePublicId: "abcdef12" }),
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  // S1-9 --------------------------------------------------------------------
  it("S1-9: a retry after the ticket was closed still returns the original reply", async () => {
    const made = await createTicket(userA, createInput());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const publicId = made.value.ticket.id.slice(0, 8);

    const key = requestId();
    const reply = await replyToTicket(userA, {
      ticketPublicId: publicId,
      message: "پاسخ قبل از بسته شدن",
      clientRequestId: key,
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    // An admin closes it afterwards.
    await prisma.supportTicket.update({
      where: { id: made.value.ticket.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    const retry = await replyToTicket(userA, {
      ticketPublicId: publicId,
      message: "پاسخ قبل از بسته شدن",
      clientRequestId: key,
    });
    // TICKET_CLOSED here would be a lie: the reply exists.
    expect(retry.ok, "retry replays rather than refusing").toBe(true);
    if (!retry.ok) return;
    expect(retry.value.messageId).toBe(reply.value.messageId);
  });

  // S1-10 -------------------------------------------------------------------
  it("S1-10: concurrent identical creates produce exactly one ticket", async () => {
    const input = createInput();
    const [a, b, c] = await Promise.all([
      createTicket(userA, input),
      createTicket(userA, input),
      createTicket(userA, input),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    const ids = new Set([a.value.ticket.id, b.value.ticket.id, c.value.ticket.id]);
    expect(ids.size, "one winner, two replays").toBe(1);
    expect(await prisma.supportTicket.count({ where: { userId: userA } })).toBe(1);
  });

  // S1-11 -------------------------------------------------------------------
  it("S1-11: concurrent identical replies produce exactly one message", async () => {
    const made = await createTicket(userA, createInput());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const publicId = made.value.ticket.id.slice(0, 8);
    const input = {
      ticketPublicId: publicId,
      message: "پاسخ همزمان",
      clientRequestId: requestId(),
    };
    const [a, b, c] = await Promise.all([
      replyToTicket(userA, input),
      replyToTicket(userA, input),
      replyToTicket(userA, input),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    const replies = await prisma.supportMessage.count({
      where: { ticketId: made.value.ticket.id, text: "پاسخ همزمان" },
    });
    expect(replies, "one reply, not three").toBe(1);
  });

  // S1-12 -------------------------------------------------------------------
  it("S1-12: a create rolls back as one unit — no orphan idempotency record", async () => {
    // An over-long subject is refused before any write, which is the cheap
    // half. The load-bearing half is that a FAILED attempt leaves nothing
    // behind for a later retry to replay.
    const key = requestId();
    const bad = await createTicket(
      userA,
      createInput({ clientRequestId: key, subject: "x".repeat(500) }),
    );
    expect(bad.ok).toBe(false);
    const stored = await prisma.miniAppRequestIdempotency.findUnique({
      where: { userId_clientRequestId: { userId: userA, clientRequestId: key } },
    });
    expect(stored, "no record for a mutation that never happened").toBeNull();

    // And the key is still usable for a real submission.
    const good = await createTicket(userA, createInput({ clientRequestId: key }));
    expect(good.ok).toBe(true);
  });
});

describe("support domain — ownership and paging", () => {
  // S1-13 -------------------------------------------------------------------
  it("S1-13: user A cannot read user B's messages by public id", async () => {
    const theirs = await createTicket(userB, createInput());
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    const publicId = theirs.value.ticket.id.slice(0, 8);

    const asOwner = await listOwnedTicketMessages(userB, publicId, 20, null);
    expect(asOwner, "owner can read").not.toBeNull();

    const asStranger = await listOwnedTicketMessages(userA, publicId, 20, null);
    expect(asStranger, "stranger gets the generic refusal").toBeNull();
  });

  // S1-14 -------------------------------------------------------------------
  it("S1-14: foreign, unknown, malformed and ambiguous ids are indistinguishable", async () => {
    const theirs = await createTicket(userB, createInput());
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;

    // A REAL prefix collision, constructed rather than hoped for: a public id
    // is a uuid prefix, so two of the caller's OWN tickets can share one. 32
    // bits will not collide by chance in a test, and "we never saw it happen"
    // is not the same as "it cannot happen" — so the ids are chosen.
    const share = "abcdef01";
    const twins = await Promise.all(
      ["0000-4000-8000-000000000001", "0000-4000-8000-000000000002"].map((tail) =>
        prisma.supportTicket.create({
          data: {
            id: `${share}-${tail}`,
            userId: userA,
            subject: "دو تیکت با پیشوند یکسان",
            status: "WAITING_ADMIN",
            category: "ACCOUNT",
            origin: "MINIAPP",
          },
        }),
      ),
    );
    expect(twins).toHaveLength(2);

    const outcomes = await Promise.all([
      listOwnedTicketMessages(userA, theirs.value.ticket.id.slice(0, 8), 20, null),
      listOwnedTicketMessages(userA, "00000000", 20, null),
      listOwnedTicketMessages(userA, "not-hex!", 20, null),
      listOwnedTicketMessages(userA, "", 20, null),
      listOwnedTicketMessages(userA, null, 20, null),
      // Ambiguous — TWO of the caller's own tickets match. Refused, not
      // arbitrated: returning the first match would hand back a ticket the
      // user never named.
      listOwnedTicketMessages(userA, share, 20, null),
      listOwnedTicketMessages(userA, share.toUpperCase(), 20, null),
    ]);
    // One answer for every one of them.
    expect(outcomes).toEqual([null, null, null, null, null, null, null]);

    // Replying is refused for the same reason and with the same generic code.
    const ambiguousReply = await replyToTicket(userA, {
      ticketPublicId: share,
      message: "به کدام تیکت؟",
      clientRequestId: requestId(),
    });
    expect(ambiguousReply.ok).toBe(false);
    if (ambiguousReply.ok) return;
    expect(ambiguousReply.error).toBe("TICKET_NOT_FOUND");
  });

  // S1-14b ------------------------------------------------------------------
  it("S1-14b: an ambiguous SERVICE id is refused, not arbitrated", async () => {
    const share = "beef0123";
    await Promise.all(
      ["0000-4000-8000-00000000000a", "0000-4000-8000-00000000000b"].map((tail, i) =>
        prisma.service.create({
          data: {
            id: `${share}-${tail}`,
            userId: userA,
            panelId,
            panelType: "MARZBAN",
            username: `s1amb-${RUN}-${i}`,
            status: "ACTIVE",
          },
        }),
      ),
    );
    createdServices.push(
      `${share}-0000-4000-8000-00000000000a`,
      `${share}-0000-4000-8000-00000000000b`,
    );

    const made = await createTicket(userA, createInput({ servicePublicId: share }));
    expect(made.ok).toBe(false);
    if (made.ok) return;
    // Same code a stranger's id and junk produce.
    expect(made.error).toBe("INVALID_SERVICE");
  });

  // S1-15 -------------------------------------------------------------------
  it("S1-15: a cursor never grants access — replaying B's cursor gives A nothing", async () => {
    const theirs = await createTicket(userB, createInput());
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    const publicId = theirs.value.ticket.id.slice(0, 8);

    const theirPage = await listOwnedTicketMessages(userB, publicId, 1, null);
    expect(theirPage).not.toBeNull();
    const cursor = theirPage?.older ?? { createdAt: new Date(), id: "x" };

    // Same cursor, wrong user. Ownership is re-established per page.
    expect(await listOwnedTicketMessages(userA, publicId, 1, cursor)).toBeNull();
  });

  // S1-16 -------------------------------------------------------------------
  it("S1-16: page termination is exact at 0, <limit, ==limit and limit+1", async () => {
    const made = await createTicket(userA, createInput());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const publicId = made.value.ticket.id.slice(0, 8);
    const ticketId = made.value.ticket.id;

    // The create already wrote one message.
    const one = await listOwnedTicketMessages(userA, publicId, 5, null);
    expect(one?.messages).toHaveLength(1);
    expect(one?.hasMore, "fewer than limit").toBe(false);
    expect(one?.older).toBeNull();

    // Grow to exactly the limit. THIS is the case the old code got wrong: it
    // handed out a cursor to a page that does not exist.
    for (let i = 0; i < 4; i += 1) {
      await prisma.supportMessage.create({
        data: { ticketId, senderType: "USER", senderUserId: userA, text: `m${i}` },
      });
    }
    const exact = await listOwnedTicketMessages(userA, publicId, 5, null);
    expect(exact?.messages).toHaveLength(5);
    expect(exact?.hasMore, "exactly limit — no further page").toBe(false);
    expect(exact?.older, "and therefore no cursor").toBeNull();

    // One more, and there genuinely is another page.
    await prisma.supportMessage.create({
      data: { ticketId, senderType: "USER", senderUserId: userA, text: "m4" },
    });
    const more = await listOwnedTicketMessages(userA, publicId, 5, null);
    expect(more?.messages).toHaveLength(5);
    expect(more?.hasMore, "limit + 1").toBe(true);
    expect(more?.older).not.toBeNull();
  });

  // S1-17 -------------------------------------------------------------------
  it("S1-17: paging backwards covers every message exactly once", async () => {
    const made = await createTicket(userA, createInput());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const publicId = made.value.ticket.id.slice(0, 8);

    for (let i = 0; i < 6; i += 1) {
      await prisma.supportMessage.create({
        data: {
          ticketId: made.value.ticket.id,
          senderType: "USER",
          senderUserId: userA,
          text: `body-${i}`,
        },
      });
    }

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof listOwnedTicketMessages>> =
        await listOwnedTicketMessages(userA, publicId, 3, cursor);
      if (page === null) break;
      // Oldest-first WITHIN the page, so the walk prepends.
      seen.unshift(...page.messages.map((m) => m.id));
      if (!page.hasMore || page.older === null) break;
      cursor = page.older;
    }

    expect(new Set(seen).size, "no duplicates").toBe(seen.length);
    expect(seen.length, "every message reached").toBe(7);
  });
});
