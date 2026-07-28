import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { serviceShortId } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// SC — the Support Center HTTP surface.
//
// This is the only part of the Mini App API that WRITES something a user owns,
// so the questions are different from the read surface's. Not just "does it
// return the right rows" but: can somebody else's ticket be reached, can a
// closed conversation be reopened, can a retry create a second ticket, can a
// cursor from one collection be replayed against another, and does a mutation
// survive being sent from another origin, as a form post, or fifty times a
// minute.
//
// Every fixture is created by this file and torn down by exact id.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-support-test-secret-0123456789abcdef";
const BOT_TOKEN = "424243:AA-miniapp-support-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_PUBLIC_URL = "https://miniapp.test.example/miniapp";
// inject() presents one client address for the whole file, and every scenario
// here shares one user, so the production ceilings would throttle the suite
// itself. Both are raised for the file and SC-24 lowers the support one back
// to prove the 429 path against the real route.
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";
process.env.MINIAPP_SUPPORT_RATE_LIMIT = "1000";

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const OWNER_TELEGRAM_ID = 9_400_000_000_000n + runTag;
const STRANGER_TELEGRAM_ID = OWNER_TELEGRAM_ID + 1n;
/**
 * A user with EXACTLY ONE ticket, used only by the status-bucket scenario.
 *
 * The mapping is measured on a summary that describes one row and nothing
 * else, so "which bucket did this status land in" is read directly off the
 * response instead of inferred from a delta against a shared population.
 */
const LEGACY_TELEGRAM_ID = OWNER_TELEGRAM_ID + 2n;

let app: FastifyInstance;
let ownerId = "";
let strangerId = "";
let ownerCookie = "";
let strangerCookie = "";
let legacyId = "";
let legacyCookie = "";
let seq = 0;
let panelId = "";
/** Every Service row this file creates, so teardown can be exact. */
const serviceIds: string[] = [];
/** The owner's own live service — the one that may legitimately be linked. */
let ownedServiceId = "";
let ownedServicePublicId = "";

const ORIGIN = "https://miniapp.test.example";

/**
 * EXACTLY the fields a ticket-list item may carry, sorted.
 *
 * Asserted as an equality, not a subset: a field added to the serializer
 * without a decision — a database uuid, panel metadata, an internal note —
 * fails here rather than shipping.
 */
const TICKET_SUMMARY_FIELDS = [
  "category",
  "createdAt",
  "id",
  "service",
  "status",
  "subject",
  "updatedAt",
  "waitingParty",
].sort();

function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function initDataFor(telegramId: bigint): string {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - 5),
    query_id: "AAF-support",
    user: `{"id":${telegramId.toString()},"first_name":"Test","username":"tester"}`,
  });
}

async function signIn(telegramId: bigint): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { initData: initDataFor(telegramId) },
  });
  if (response.statusCode !== 200) {
    throw new Error(`auth failed ${response.statusCode}: ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return raw.split(";")[0];
}

/** A fresh idempotency key in the domain's required shape. */
function requestId(): string {
  seq += 1;
  return `sc${runTag.toString()}x${seq}`.replace(/[^A-Za-z0-9_-]/g, "").padEnd(16, "0").slice(0, 64);
}

/** The headers a real Mini App mutation carries. */
function mutating(cookie: string) {
  return { cookie, origin: ORIGIN, "content-type": "application/json" };
}

interface CreateOverrides {
  subject?: unknown;
  message?: unknown;
  category?: unknown;
  serviceId?: unknown;
  clientRequestId?: string;
}

async function createTicketVia(cookie: string, overrides: CreateOverrides = {}) {
  return app.inject({
    method: "POST",
    url: "/api/miniapp/support/tickets",
    headers: mutating(cookie),
    payload: {
      subject: overrides.subject ?? "موضوع آزمایشی پشتیبانی",
      message: overrides.message ?? "متن آزمایشی پشتیبانی",
      category: overrides.category ?? "ACCOUNT",
      clientRequestId: overrides.clientRequestId ?? requestId(),
      ...(overrides.serviceId === undefined ? {} : { serviceId: overrides.serviceId }),
    },
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  app = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  const owner = await prisma.user.create({
    data: { telegramId: OWNER_TELEGRAM_ID, firstName: "SupportOwner" },
  });
  ownerId = owner.id;
  const stranger = await prisma.user.create({
    data: { telegramId: STRANGER_TELEGRAM_ID, firstName: "SupportStranger" },
  });
  strangerId = stranger.id;
  const legacy = await prisma.user.create({
    data: { telegramId: LEGACY_TELEGRAM_ID, firstName: "SupportLegacy" },
  });
  legacyId = legacy.id;

  ownerCookie = await signIn(OWNER_TELEGRAM_ID);
  strangerCookie = await signIn(STRANGER_TELEGRAM_ID);
  legacyCookie = await signIn(LEGACY_TELEGRAM_ID);

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: "Support Panel",
      baseUrl: "https://support-panel.internal.example",
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
    },
  });
  panelId = panel.id;
  const owned = await makeService(ownerId, "owned");
  ownedServiceId = owned.id;
  ownedServicePublicId = serviceShortId(owned);
});

/** One live Service, on the shared panel, owned by `userId`. */
async function makeService(userId: string, label: string) {
  const service = await prisma.service.create({
    data: {
      userId,
      panelId,
      panelType: "MARZBAN",
      username: `sc-${runTag.toString()}-${label}`,
      status: "ACTIVE",
      volumeBytes: 1n,
      usedBytes: 0n,
      remainingBytes: 1n,
      durationDays: 30,
    },
  });
  serviceIds.push(service.id);
  return service;
}

afterAll(async () => {
  if (!hasDb) return;
  await app?.close();
  const ids = [ownerId, strangerId, legacyId].filter((id) => id !== "");
  if (ids.length > 0) {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: { in: ids } },
      select: { id: true },
    });
    const ticketIds = tickets.map((row) => row.id);
    if (ticketIds.length > 0) {
      await prisma.supportNotificationRecipient.deleteMany({
        where: { intent: { ticketId: { in: ticketIds } } },
      });
      await prisma.supportNotificationIntent.deleteMany({
        where: { ticketId: { in: ticketIds } },
      });
      await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
    }
    await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: ids } } });
    if (serviceIds.length > 0) {
      await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (panelId !== "") {
    await prisma.panel.deleteMany({ where: { id: panelId } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("mini app support center", () => {
  // --- creating --------------------------------------------------------------

  it("SC-1: creates a ticket and returns it by public id, never a uuid", async () => {
    const response = await createTicketVia(ownerCookie);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.ticket.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.ticket.status).toBe("WAITING_ADMIN");
    expect(body.ticket.canReply).toBe(true);
    expect(body.ticket.hasAttachments).toBe(false);

    // No database uuid anywhere in the response.
    const row = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId },
      orderBy: { createdAt: "desc" },
    });
    expect(response.body).not.toContain(row.id);
    expect(response.body).not.toContain(ownerId);
  });

  it("SC-2: the ticket is written with MINIAPP origin even if the body claims otherwise", async () => {
    const response = await createTicketVia(ownerCookie, {
      // A client must not be able to disguise where a request came from.
      ...({ origin: "TELEGRAM" } as Record<string, unknown>),
      subject: "منشا جعلی",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().ticket.origin).toBe("MINIAPP");
  });

  it("SC-3: creating writes a notification intent the bot will deliver", async () => {
    const response = await createTicketVia(ownerCookie, { subject: "نیت اعلان" });
    expect(response.statusCode).toBe(201);
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "نیت اعلان" },
    });
    const intents = await prisma.supportNotificationIntent.findMany({
      where: { ticketId: ticket.id },
    });
    // The API cannot send a Telegram message; the durable intent is how the
    // administrators eventually hear about this.
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe("support.ticket_created");
    expect(intents[0].status).toBe("PENDING");
  });

  it("SC-4: replaying the same clientRequestId creates no second ticket", async () => {
    const key = requestId();
    const first = await createTicketVia(ownerCookie, { subject: "تکرار", clientRequestId: key });
    expect(first.statusCode).toBe(201);
    const second = await createTicketVia(ownerCookie, { subject: "تکرار", clientRequestId: key });
    expect(second.statusCode).toBe(201);
    expect(second.json().ticket.id, "the same ticket comes back").toBe(first.json().ticket.id);
    expect(await prisma.supportTicket.count({ where: { userId: ownerId, subject: "تکرار" } })).toBe(
      1,
    );
  });

  it("SC-5: the same key with a DIFFERENT payload is a conflict, not a silent replay", async () => {
    const key = requestId();
    expect((await createTicketVia(ownerCookie, { subject: "اول", clientRequestId: key })).statusCode)
      .toBe(201);
    const changed = await createTicketVia(ownerCookie, { subject: "دوم", clientRequestId: key });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("SC-6: validation failures map to 400 with the domain's own code", async () => {
    const short = await createTicketVia(ownerCookie, { subject: "ب" });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("INVALID_SUBJECT");

    const empty = await createTicketVia(ownerCookie, { message: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("INVALID_MESSAGE");

    const category = await createTicketVia(ownerCookie, { category: "NOT_A_CATEGORY" });
    expect(category.statusCode).toBe(400);
    expect(category.json().code).toBe("INVALID_CATEGORY");

    const key = await createTicketVia(ownerCookie, { clientRequestId: "tooshort" });
    expect(key.statusCode).toBe(400);
    expect(key.json().code).toBe("INVALID_REQUEST_ID");
  });

  it("SC-7: a service the caller does not own is rejected, not silently dropped", async () => {
    const response = await createTicketVia(ownerCookie, { serviceId: "deadbeef" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_SERVICE");
  });

  // --- linking a service -----------------------------------------------------
  //
  // The precondition is evaluated INSIDE the transaction that writes the
  // ticket, so "the row that satisfied the check" and "the row the ticket
  // points at" are the same row under one snapshot. These scenarios walk every
  // way that check can fail, and prove each one leaves NOTHING behind.

  it("SC-26: a service the caller owns is linked, and comes back as a public id", async () => {
    const response = await createTicketVia(ownerCookie, {
      subject: "با سرویس",
      serviceId: ownedServicePublicId,
    });
    expect(response.statusCode).toBe(201);
    const ticket = response.json().ticket;
    expect(ticket.service).not.toBeNull();
    expect(ticket.service.id).toBe(ownedServicePublicId);
    expect(ticket.service.id).toMatch(/^[0-9a-f]{8}$/);
    // The account name is the label; the database uuid appears nowhere.
    expect(ticket.service.label).toBe(`sc-${runTag.toString()}-owned`);
    expect(response.body).not.toContain(ownedServiceId);

    const row = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "با سرویس" },
    });
    expect(row.serviceId).toBe(ownedServiceId);
  });

  it("SC-27: foreign, missing, deleted, soft-deleted and ambiguous are ONE answer, and write nothing", async () => {
    const foreign = await makeService(strangerId, "foreign");
    const retired = await makeService(ownerId, "retired");
    await prisma.service.update({ where: { id: retired.id }, data: { status: "DELETED" } });
    const softDeleted = await makeService(ownerId, "soft");
    await prisma.service.update({
      where: { id: softDeleted.id },
      data: { deletedAt: new Date() },
    });

    const cases: Array<[string, string]> = [
      ["another user's service", serviceShortId(foreign)],
      ["a service that never existed", "0123abcd"],
      ["a service retired to DELETED", serviceShortId(retired)],
      ["a soft-deleted service", serviceShortId(softDeleted)],
      ["a malformed id", "not-hex!!"],
    ];

    for (const [label, serviceId] of cases) {
      const before = await prisma.supportTicket.count({ where: { userId: ownerId } });
      const response = await createTicketVia(ownerCookie, {
        subject: `رد ${label}`,
        serviceId,
      });
      // Identical code for all five: telling them apart would report which
      // service ids exist and which of them belong to somebody else.
      expect(response.statusCode, label).toBe(400);
      expect(response.json().code, label).toBe("INVALID_SERVICE");
      // AND the refusal rolled everything back. A returned failure inside a
      // Prisma transaction COMMITS whatever the callback wrote, so this is the
      // assertion that distinguishes a real rollback from a reported one.
      expect(await prisma.supportTicket.count({ where: { userId: ownerId } }), label).toBe(before);
      expect(
        await prisma.supportTicket.count({ where: { userId: ownerId, subject: `رد ${label}` } }),
        label,
      ).toBe(0);
    }
  });

  it("SC-28: an AMBIGUOUS prefix is refused rather than resolved to the first match", async () => {
    // Two of the caller's own services sharing a public-id prefix. Both are
    // legitimately linkable on their own; the prefix that names both names
    // neither, because picking one would be a guess about what was meant.
    const a = await makeService(ownerId, "ambig-a");
    const b = await makeService(ownerId, "ambig-b");
    const shared = "aaaaaaaa";
    await prisma.$executeRawUnsafe(
      `UPDATE "Service" SET id = $1 WHERE id = $2`,
      `${shared}-0000-4000-8000-000000000001`,
      a.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Service" SET id = $1 WHERE id = $2`,
      `${shared}-0000-4000-8000-000000000002`,
      b.id,
    );
    serviceIds.push(`${shared}-0000-4000-8000-000000000001`);
    serviceIds.push(`${shared}-0000-4000-8000-000000000002`);

    const before = await prisma.supportTicket.count({ where: { userId: ownerId } });
    const response = await createTicketVia(ownerCookie, {
      subject: "مبهم",
      serviceId: shared,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_SERVICE");
    expect(await prisma.supportTicket.count({ where: { userId: ownerId } })).toBe(before);
  });

  it("SC-29: a service retired between the read and the write cannot be linked", async () => {
    // The transactional check exists for exactly this: a service that was
    // linkable when the browser rendered the picker, and is not by the time
    // the ticket is written.
    const doomed = await makeService(ownerId, "doomed");
    const publicId = serviceShortId(doomed);

    // The picker's own read still shows it — this is the state the client saw.
    const visible = await app.inject({
      method: "GET",
      url: `/api/miniapp/services/${publicId}`,
      headers: { cookie: ownerCookie },
    });
    expect(visible.statusCode).toBe(200);

    // …and now it is retired, before the create lands.
    await prisma.service.update({ where: { id: doomed.id }, data: { status: "DELETED" } });

    const before = await prisma.supportTicket.count({ where: { userId: ownerId } });
    const response = await createTicketVia(ownerCookie, {
      subject: "بازنشسته",
      serviceId: publicId,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_SERVICE");
    // No committed ticket pointing at something the user may no longer link.
    expect(await prisma.supportTicket.count({ where: { userId: ownerId } })).toBe(before);
    expect(
      await prisma.supportTicket.count({ where: { userId: ownerId, serviceId: doomed.id } }),
    ).toBe(0);
  });

  it("SC-30: a replay returns the ORIGINAL ticket even after the linked service is retired", async () => {
    // THE ORDERING PROPERTY. Idempotency is resolved BEFORE the mutable
    // precondition is re-evaluated: the ticket already exists, so answering
    // INVALID_SERVICE on the retry would be a lie about what happened.
    const service = await makeService(ownerId, "replay");
    const publicId = serviceShortId(service);
    const key = requestId();

    const first = await createTicketVia(ownerCookie, {
      subject: "پخش دوباره",
      serviceId: publicId,
      clientRequestId: key,
    });
    expect(first.statusCode).toBe(201);
    const originalId = first.json().ticket.id;

    await prisma.service.update({ where: { id: service.id }, data: { status: "DELETED" } });

    const replay = await createTicketVia(ownerCookie, {
      subject: "پخش دوباره",
      serviceId: publicId,
      clientRequestId: key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().ticket.id).toBe(originalId);
    expect(
      await prisma.supportTicket.count({ where: { userId: ownerId, subject: "پخش دوباره" } }),
    ).toBe(1);
  });

  it("SC-31: a retry that CHANGES the linked service is a conflict, not a second ticket", async () => {
    const key = requestId();
    const first = await createTicketVia(ownerCookie, {
      subject: "تعویض سرویس",
      serviceId: ownedServicePublicId,
      clientRequestId: key,
    });
    expect(first.statusCode).toBe(201);

    // Linking a service and linking NONE are different mutations, so the same
    // key describing the second one must not replay the first.
    const changed = await createTicketVia(ownerCookie, {
      subject: "تعویض سرویس",
      serviceId: null,
      clientRequestId: key,
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  // --- reading ---------------------------------------------------------------

  it("SC-8: the summary counts only the caller's own tickets", async () => {
    await createTicketVia(strangerCookie, { subject: "غریبه" });
    const mine = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/summary",
      headers: { cookie: ownerCookie },
    });
    expect(mine.statusCode).toBe(200);
    const summary = mine.json().summary;
    const ownTickets = await prisma.supportTicket.count({ where: { userId: ownerId } });
    expect(summary.total).toBe(ownTickets);
    // The three buckets partition the total: every ticket is waiting on
    // somebody or is closed, and none is counted twice.
    expect(summary.waitingSupport + summary.waitingUser + summary.closed).toBe(summary.total);
  });

  it("SC-8b: every status lands in the right bucket, legacy values included", async () => {
    // Rows carrying the pre-split enum values still have to land somewhere a
    // person understands. `OPEN` meant "the team owes a reply" and `ANSWERED`
    // meant "support has answered, over to you", so that is where they count.
    //
    // Measured on a user with EXACTLY ONE ticket, so the whole summary is
    // about that one row and the assertion is an equality rather than a delta.
    const created = await createTicketVia(legacyCookie, { subject: "قدیمی" });
    expect(created.statusCode).toBe(201);
    const ticketId = (
      await prisma.supportTicket.findFirstOrThrow({ where: { userId: legacyId } })
    ).id;

    for (const [status, bucket] of [
      ["OPEN", "waitingSupport"],
      ["WAITING_ADMIN", "waitingSupport"],
      ["ANSWERED", "waitingUser"],
      ["WAITING_USER", "waitingUser"],
      ["CLOSED", "closed"],
    ] as const) {
      await prisma.supportTicket.update({ where: { id: ticketId }, data: { status } });
      const response = await app.inject({
        method: "GET",
        url: "/api/miniapp/support/summary",
        headers: { cookie: legacyCookie },
      });
      expect(response.json().summary, status).toEqual({
        total: 1,
        waitingSupport: bucket === "waitingSupport" ? 1 : 0,
        waitingUser: bucket === "waitingUser" ? 1 : 0,
        closed: bucket === "closed" ? 1 : 0,
      });
      // And the LIST agrees with the counts about the same row — one mapping,
      // not two that can drift.
      const list = await app.inject({
        method: "GET",
        url: "/api/miniapp/support/tickets",
        headers: { cookie: legacyCookie },
      });
      const item = list.json().items[0];
      expect(item.status, status).toBe(status);
      expect(item.waitingParty, status).toBe(
        bucket === "closed" ? null : bucket === "waitingUser" ? "USER" : "SUPPORT",
      );
    }
  });

  it("SC-8c: the summary carries the recent tickets, in the list's own shape", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/summary",
      headers: { cookie: ownerCookie },
    });
    const body = response.json();
    expect(Array.isArray(body.recentTickets)).toBe(true);
    expect(body.recentTickets.length).toBeGreaterThan(0);
    // Bounded — this is a preview beside the counts, not the list.
    expect(body.recentTickets.length).toBeLessThanOrEqual(5);
    // Newest activity first, the same order the list uses.
    const stamps = body.recentTickets.map((t: { updatedAt: string }) => Date.parse(t.updatedAt));
    expect([...stamps].sort((a: number, b: number) => b - a)).toEqual(stamps);
    for (const item of body.recentTickets) {
      expect(Object.keys(item).sort()).toEqual(TICKET_SUMMARY_FIELDS);
    }
  });

  it("SC-9: the list is newest-activity first and pages with an opaque cursor", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/tickets?limit=2",
      headers: { cookie: ownerCookie },
    });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.id).toMatch(/^[0-9a-f]{8}$/);
    }
    // Ordered by updatedAt descending.
    const stamps = page.items.map((i: { updatedAt: string }) => Date.parse(i.updatedAt));
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    if (page.nextCursor !== null) {
      const second = await app.inject({
        method: "GET",
        url: `/api/miniapp/support/tickets?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        headers: { cookie: ownerCookie },
      });
      expect(second.statusCode).toBe(200);
      const firstIds = new Set(page.items.map((i: { id: string }) => i.id));
      for (const item of second.json().items) {
        expect(firstIds.has(item.id), "no row appears on two pages").toBe(false);
      }
    }
  });

  it("SC-9b: every list item carries EXACTLY the eight contract fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/tickets?limit=50",
      headers: { cookie: ownerCookie },
    });
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(TICKET_SUMMARY_FIELDS);
      expect(item.id).toMatch(/^[0-9a-f]{8}$/);
      // `waitingParty` is a decided value, not the raw status echoed back.
      expect([null, "USER", "SUPPORT"]).toContain(item.waitingParty);
      expect(item.waitingParty === null).toBe(item.status === "CLOSED");
      if (item.service !== null) {
        const service = item.service as Record<string, unknown>;
        // The linked service is a public id and a label — nothing else, and
        // certainly no panel.
        expect(Object.keys(service).sort()).toEqual(["id", "label"]);
        expect(service.id).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // Panel metadata never had a field here, and must never acquire one.
    for (const forbidden of ["panel", "panelId", "panelName", "userId", "serviceId"]) {
      expect(response.body, forbidden).not.toContain(`"${forbidden}"`);
    }
  });

  it("SC-10: the list never contains another user's ticket", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/tickets?limit=50",
      headers: { cookie: ownerCookie },
    });
    const ids = response.json().items.map((i: { id: string }) => i.id);
    const strangerTickets = await prisma.supportTicket.findMany({
      where: { userId: strangerId },
      select: { id: true },
    });
    for (const foreign of strangerTickets) {
      expect(ids).not.toContain(foreign.id.slice(0, 8));
    }
  });

  it("SC-11: a cursor minted for another collection is refused", async () => {
    const services = await app.inject({
      method: "GET",
      url: "/api/miniapp/services?limit=1",
      headers: { cookie: ownerCookie },
    });
    const foreignCursor = services.json().nextCursor;
    // Only meaningful when the other collection actually produced one.
    const cursor = typeof foreignCursor === "string" ? foreignCursor : "c2.notacursor";
    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets?cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("BAD_REQUEST");
  });

  it("SC-12: ticket detail is owner-scoped — a stranger's ticket is 404, not 403", async () => {
    const mine = await createTicketVia(ownerCookie, { subject: "مال من" });
    const publicId = mine.json().ticket.id;

    const asOwner = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}`,
      headers: { cookie: ownerCookie },
    });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json().ticket.id).toBe(publicId);

    const asStranger = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}`,
      headers: { cookie: strangerCookie },
    });
    // 404 rather than 403: a 403 would confirm the ticket exists.
    expect(asStranger.statusCode).toBe(404);
    expect(asStranger.json().code).toBe("NOT_FOUND");
  });

  it("SC-13: a malformed or unknown ticket id is the same 404", async () => {
    for (const id of ["zzzzzzzz", "1", "../../etc/passwd", "00000000"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/miniapp/support/tickets/${encodeURIComponent(id)}`,
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode, id).toBe(404);
    }
  });

  it("SC-14: messages are owner-scoped, chronological within a page, and carry no file id", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "پیام‌ها" });
    const publicId = created.json().ticket.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}/messages?limit=10`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].senderType).toBe("USER");
    expect(items[0].text).toBe("متن آزمایشی پشتیبانی");
    expect(items[0].hasAttachment).toBe(false);
    // FOUR FIELDS, and no identifier among them. The DTO has no place to put
    // one, so a file id cannot leak through a field nobody thought about.
    expect(Object.keys(items[0]).sort()).toEqual(
      ["createdAt", "hasAttachment", "senderType", "text"].sort(),
    );

    const asStranger = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}/messages`,
      headers: { cookie: strangerCookie },
    });
    expect(asStranger.statusCode).toBe(404);
  });

  it("SC-14b: a message response contains no part of the message's uuid", async () => {
    // The defect this replaces: messages carried a "display key" that was the
    // first twelve hex characters of the row's uuid. It was only ever a React
    // key, but it was still a piece of a primary key on the wire — stable
    // enough to correlate across responses, and short enough to invite the
    // same startsWith lookup the ticket resolver uses.
    const created = await createTicketVia(ownerCookie, { subject: "بدون شناسه" });
    const publicId = created.json().ticket.id;
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "بدون شناسه" },
    });
    const messages = await prisma.supportMessage.findMany({
      where: { ticketId: ticket.id },
      select: { id: true },
    });
    expect(messages.length).toBeGreaterThan(0);

    const response = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}/messages?limit=50`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;

    for (const { id } of messages) {
      const hex = id.replace(/-/g, "");
      // The whole uuid, the unhyphenated form, and every prefix length that a
      // "shortened" identifier might plausibly have been cut to.
      expect(body, "full uuid").not.toContain(id);
      expect(body, "uuid without hyphens").not.toContain(hex);
      expect(body, "first 8 hex characters").not.toContain(hex.slice(0, 8));
      expect(body, "first 12 hex characters").not.toContain(hex.slice(0, 12));
      expect(body, "first 16 hex characters").not.toContain(hex.slice(0, 16));
    }
  });

  it("SC-14c: the SAME absence holds for a long thread and for every page of it", async () => {
    // One page could pass by luck; a thread deep enough to page proves the
    // property is in the serializer rather than in this fixture.
    const created = await createTicketVia(ownerCookie, { subject: "نخ بلند" });
    const publicId = created.json().ticket.id;
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "نخ بلند" },
    });
    for (let i = 0; i < 6; i += 1) {
      await prisma.supportMessage.create({
        data: { ticketId: ticket.id, senderType: "ADMIN", text: `پاسخ ${i}` },
      });
    }
    const ids = (
      await prisma.supportMessage.findMany({
        where: { ticketId: ticket.id },
        select: { id: true },
      })
    ).map((row) => row.id.replace(/-/g, ""));

    let cursor: string | null = null;
    let pages = 0;
    do {
      const url =
        cursor === null
          ? `/api/miniapp/support/tickets/${publicId}/messages?limit=3`
          : `/api/miniapp/support/tickets/${publicId}/messages?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const page = await app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
      expect(page.statusCode).toBe(200);
      for (const hex of ids) {
        for (const width of [8, 12, 16, 32]) {
          expect(page.body, `page ${pages} / ${width} chars`).not.toContain(hex.slice(0, width));
        }
      }
      cursor = page.json().nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    // The thread really did page, so more than one response was inspected.
    expect(pages).toBeGreaterThan(1);
  });

  it("SC-15: an attachment is announced but never described", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "ضمیمه" });
    const publicId = created.json().ticket.id;
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "ضمیمه" },
    });
    // A file arrived through the bot, which is the only path that can add one.
    await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        senderType: "ADMIN",
        text: "فایل پیوست شد",
        fileId: "BQACAgQAAxkBAAI-secret-file-id",
        fileName: "invoice.pdf",
        mimeType: "application/pdf",
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}`,
      headers: { cookie: ownerCookie },
    });
    expect(detail.json().ticket.hasAttachments).toBe(true);

    const messages = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}/messages`,
      headers: { cookie: ownerCookie },
    });
    const withFile = messages.json().items.find((m: { hasAttachment: boolean }) => m.hasAttachment);
    expect(withFile).toBeDefined();
    // The indicator, and nothing else: no id, no name, no mime type, no size.
    expect(messages.body).not.toContain("BQACAgQ");
    expect(messages.body).not.toContain("invoice.pdf");
    expect(messages.body).not.toContain("application/pdf");
  });

  // --- replying --------------------------------------------------------------

  it("SC-16: a reply appends to the caller's own ticket and records an intent", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "پاسخ" });
    const publicId = created.json().ticket.id;

    const reply = await app.inject({
      method: "POST",
      url: `/api/miniapp/support/tickets/${publicId}/replies`,
      headers: mutating(ownerCookie),
      payload: { message: "پاسخ کاربر", clientRequestId: requestId() },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().ticket.status).toBe("WAITING_ADMIN");

    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "پاسخ" },
    });
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(2);
    expect(
      await prisma.supportNotificationIntent.count({
        where: { ticketId: ticket.id, kind: "support.user_replied" },
      }),
    ).toBe(1);
  });

  it("SC-17: replying to a CLOSED ticket is a 409 the client can act on", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "بسته" });
    const publicId = created.json().ticket.id;
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "بسته" },
    });
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    const reply = await app.inject({
      method: "POST",
      url: `/api/miniapp/support/tickets/${publicId}/replies`,
      headers: mutating(ownerCookie),
      payload: { message: "دیر رسید", clientRequestId: requestId() },
    });
    // Distinguishable from a 404: the Mini App has to tell "this conversation
    // is over" apart from "no such ticket".
    expect(reply.statusCode).toBe(409);
    expect(reply.json().code).toBe("TICKET_CLOSED");

    const detail = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}`,
      headers: { cookie: ownerCookie },
    });
    expect(detail.json().ticket.canReply).toBe(false);
  });

  it("SC-18: a stranger cannot reply to a ticket they do not own", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "دزدی" });
    const publicId = created.json().ticket.id;
    const reply = await app.inject({
      method: "POST",
      url: `/api/miniapp/support/tickets/${publicId}/replies`,
      headers: mutating(strangerCookie),
      payload: { message: "من نیستم", clientRequestId: requestId() },
    });
    expect(reply.statusCode).toBe(404);
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "دزدی" },
    });
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
  });

  it("SC-19: a replayed reply key appends nothing a second time", async () => {
    const created = await createTicketVia(ownerCookie, { subject: "تکرار پاسخ" });
    const publicId = created.json().ticket.id;
    const key = requestId();
    const payload = { message: "یک بار", clientRequestId: key };

    const first = await app.inject({
      method: "POST",
      url: `/api/miniapp/support/tickets/${publicId}/replies`,
      headers: mutating(ownerCookie),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/miniapp/support/tickets/${publicId}/replies`,
      headers: mutating(ownerCookie),
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { userId: ownerId, subject: "تکرار پاسخ" },
    });
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(2);
  });

  // --- the mutation gate -----------------------------------------------------

  it("SC-20: a mutation from another origin is refused before anything is written", async () => {
    const before = await prisma.supportTicket.count({ where: { userId: ownerId } });
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: { cookie: ownerCookie, origin: "https://evil.example", "content-type": "application/json" },
      payload: {
        subject: "از جای دیگر",
        message: "نباید نوشته شود",
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN_ORIGIN");
    expect(await prisma.supportTicket.count({ where: { userId: ownerId } })).toBe(before);
  });

  it("SC-21: a non-JSON content type is 415, not a silently empty body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: {
        cookie: ownerCookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "subject=x&message=y",
    });
    // Fastify refuses the media type itself before the handler; either way the
    // answer is 415 and nothing was written.
    expect(response.statusCode).toBe(415);
  });

  // --- the body limit --------------------------------------------------------
  //
  // THE DOMAIN BOUNDS UTF-16 CODE UNITS; HTTP BOUNDS BYTES. The two were 3000
  // and 8192, which is a contradiction: 3000 valid Persian characters are 6000
  // bytes, 3000 CJK characters are 9000, and a client whose JSON serializer
  // escapes non-ASCII spends six bytes per code unit. The transport was
  // therefore refusing messages the domain would have accepted — a silent 413
  // on text a user was told was within the limit.
  //
  // The limit is now DERIVED from the domain's own constants, so these tests
  // are the proof that the derivation covers the worst case rather than a
  // number somebody rounded up.

  it("SC-22: 3000 Persian characters — the domain's exact maximum — is accepted", async () => {
    // Persian is two bytes per character in UTF-8: 6000 bytes, past the old
    // 8 KiB once the subject and envelope are added at scale.
    const message = "ا".repeat(3000);
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "ط".repeat(100),
        message,
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect(response.statusCode, response.body.slice(0, 200)).toBe(201);
  });

  it("SC-22b: 3000 three-byte CJK characters is accepted", async () => {
    // 9000 bytes of message alone — comfortably over the old ceiling.
    const message = "語".repeat(3000);
    expect(Buffer.byteLength(message, "utf8")).toBe(9000);
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "語".repeat(100),
        message,
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect(response.statusCode, response.body.slice(0, 200)).toBe(201);
  });

  it("SC-22c: newline-heavy valid input is accepted", async () => {
    // Every newline is `\n` in JSON — two bytes for one code unit — so a
    // message that is mostly line breaks costs nearly double what it looks.
    const message = `${"سطر\n".repeat(749)}پایا`;
    // Exactly at the bound, and roughly a quarter of it is escape sequences.
    expect([...message].length).toBe(3000);
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "چند خطی",
        message,
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect(response.statusCode, response.body.slice(0, 200)).toBe(201);
  });

  it("SC-22d: the WORST CASE — a maximal payload with every code unit JSON-escaped — is accepted", async () => {
    // The actual bound the limit is derived from. Not every client serializes
    // this way, but `JSON.stringify` with `ensure_ascii`-style escaping is
    // common enough that a payload built this way must not be refused: six
    // bytes (`\uXXXX`) per code unit, for the maximum subject AND message.
    const escaped = (text: string): string =>
      [...text].map((ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("");
    const raw = `{"subject":"${escaped("ط".repeat(100))}","message":"${escaped(
      "ا".repeat(3000),
    )}","category":"ACCOUNT","clientRequestId":"${requestId()}"}`;
    // This is the size the limit exists to admit — assert it, so a limit
    // quietly lowered below the worst case fails here rather than in the field.
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(18_000);

    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: raw,
    });
    expect(response.statusCode, response.body.slice(0, 200)).toBe(201);
    // And it really was the escaped text that landed, decoded correctly.
    const ticket = response.json().ticket;
    const messages = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${ticket.id}/messages`,
      headers: { cookie: ownerCookie },
    });
    expect(messages.json().items[0].text).toBe("ا".repeat(3000));
  });

  it("SC-22e: 3001 characters is refused by the DOMAIN, with its own code", async () => {
    // One character past the bound is a 400 INVALID_MESSAGE — a refusal the
    // user can act on — and NOT a transport-level 413, which says nothing.
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "یک نویسه بیشتر",
        message: "ا".repeat(3001),
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_MESSAGE");
  });

  it("SC-22f: a genuinely oversized body is still refused by the transport", async () => {
    // The limit is bounded, not removed: a file-sized body never reaches the
    // JSON parser, let alone the domain.
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "بزرگ",
        message: "x".repeat(2_000_000),
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect([400, 413]).toContain(response.statusCode);
  });

  it("SC-22g: the limit is derived from the domain's bounds, not chosen by eye", async () => {
    const { SUPPORT_MUTATION_BODY_LIMIT_BYTES, SUPPORT_MUTATION_WORST_CASE_BYTES } = await import(
      "@zedbot/support-tickets"
    );
    const { SUPPORT_BODY_LIMIT_BYTES } = await import("../src/miniapp/support-routes.js");
    // ONE authoritative number: the route does not restate it.
    expect(SUPPORT_BODY_LIMIT_BYTES).toBe(SUPPORT_MUTATION_BODY_LIMIT_BYTES);
    // And it admits the worst case the domain can produce.
    expect(SUPPORT_MUTATION_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(
      SUPPORT_MUTATION_WORST_CASE_BYTES,
    );
    // Still bounded: a limit large enough to accept an upload is not a limit.
    expect(SUPPORT_MUTATION_BODY_LIMIT_BYTES).toBeLessThan(256 * 1024);
  });

  it("SC-23: an unauthenticated caller reaches nothing", async () => {
    for (const [method, url] of [
      ["GET", "/api/miniapp/support/summary"],
      ["GET", "/api/miniapp/support/tickets"],
      ["GET", "/api/miniapp/support/tickets/deadbeef"],
      ["GET", "/api/miniapp/support/tickets/deadbeef/messages"],
      ["POST", "/api/miniapp/support/tickets"],
      ["POST", "/api/miniapp/support/tickets/deadbeef/replies"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        payload: method === "POST" ? {} : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().code).toBe("NOT_AUTHENTICATED");
    }
  });

  it("SC-24: sustained mutations are rate limited with a Retry-After", async () => {
    // The ceiling is lowered for this scenario only, so the 429 comes from the
    // real route and the real limiter rather than from a stub.
    const raised = process.env.MINIAPP_SUPPORT_RATE_LIMIT;
    process.env.MINIAPP_SUPPORT_RATE_LIMIT = "2";
    try {
      let limited: Awaited<ReturnType<typeof createTicketVia>> | null = null;
      for (let i = 0; i < 12; i += 1) {
        const response = await createTicketVia(ownerCookie, { subject: `فشار ${i}` });
        if (response.statusCode === 429) {
          limited = response;
          break;
        }
      }
      expect(limited, "the limiter engaged").not.toBeNull();
      if (limited === null) return;
      expect(limited.json().code).toBe("RATE_LIMITED");
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      process.env.MINIAPP_SUPPORT_RATE_LIMIT = raised;
    }
  });

  it("SC-24b: a limit that is nonsense falls back to the default instead of failing open", async () => {
    // Every knob in this API clamps rather than throwing, because the
    // alternative to a bad value must never be "no limit at all".
    const raised = process.env.MINIAPP_SUPPORT_RATE_LIMIT;
    process.env.MINIAPP_SUPPORT_RATE_LIMIT = "not-a-number";
    try {
      const { resolveMiniAppSupportRateLimit, MINIAPP_SUPPORT_RATE_LIMIT_DEFAULT } = await import(
        "../src/miniapp/config.js"
      );
      const resolved = resolveMiniAppSupportRateLimit();
      expect(resolved.value).toBe(MINIAPP_SUPPORT_RATE_LIMIT_DEFAULT);
      expect(resolved.resolution).toBe("invalid");
    } finally {
      process.env.MINIAPP_SUPPORT_RATE_LIMIT = raised;
    }
  });

  it("SC-25: no response ever carries a database uuid", async () => {
    // The strongest form of the identifier rule: assert on what is ABSENT, so
    // a field added later without thought is caught rather than a field we
    // remembered to check.
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const list = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/tickets?limit=20",
      headers: { cookie: ownerCookie },
    });
    expect(list.body).not.toMatch(uuid);
    const summary = await app.inject({
      method: "GET",
      url: "/api/miniapp/support/summary",
      headers: { cookie: ownerCookie },
    });
    expect(summary.body).not.toMatch(uuid);
  });
});
