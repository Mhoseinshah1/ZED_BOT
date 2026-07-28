import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
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

let app: FastifyInstance;
let ownerId = "";
let strangerId = "";
let ownerCookie = "";
let strangerCookie = "";
let seq = 0;

const ORIGIN = "https://miniapp.test.example";

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

  ownerCookie = await signIn(OWNER_TELEGRAM_ID);
  strangerCookie = await signIn(STRANGER_TELEGRAM_ID);
});

afterAll(async () => {
  if (!hasDb) return;
  await app?.close();
  const ids = [ownerId, strangerId].filter((id) => id !== "");
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
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
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
    expect(summary.open + summary.closed).toBe(summary.total);
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
    // The DTO has no place to put one.
    expect(Object.keys(items[0]).sort()).toEqual(
      ["createdAt", "hasAttachment", "key", "senderType", "text"].sort(),
    );

    const asStranger = await app.inject({
      method: "GET",
      url: `/api/miniapp/support/tickets/${publicId}/messages`,
      headers: { cookie: strangerCookie },
    });
    expect(asStranger.statusCode).toBe(404);
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

  it("SC-22: an oversized body is refused by the route's own limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/miniapp/support/tickets",
      headers: mutating(ownerCookie),
      payload: {
        subject: "بزرگ",
        message: "x".repeat(20_000),
        category: "ACCOUNT",
        clientRequestId: requestId(),
      },
    });
    expect([400, 413]).toContain(response.statusCode);
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
