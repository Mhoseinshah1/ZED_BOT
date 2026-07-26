import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { serviceShortId } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// D3 — the PUBLIC contract carries no database identifiers.
//
// A Service's uuid and a WalletTransaction's uuid are internal handles. They
// also appear in operator logs, support transcripts and admin screens, so once
// one is in a page, a URL or a screenshot it correlates those contexts for
// anyone who ever sees both. The Mini App shows the same short id the bot has
// always shown, ledger rows carry no id at all, and the pagination cursor —
// whose keyset tie-breaker IS a uuid — is sealed rather than merely signed, so
// the second page of any list does not hand one back through the side door.
//
// Also here: the two visibility bugs that live next to the identifier work — a
// service in the terminal DELETED state was still listed, and an already-EXPIRED
// timestamp was counted as "expiring soon".
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-public-ids-secret-0123456789";
const BOT_TOKEN = "616161:AA-miniapp-public-ids-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const OWNER_TELEGRAM_ID = 9_600_000_000_000n + runTag;
const STRANGER_TELEGRAM_ID = OWNER_TELEGRAM_ID + 1n;

/** Two rows deliberately sharing an 8-character prefix (D3-5). */
const AMBIGUOUS_A = "abcdef12-0000-4000-8000-000000000001";
const AMBIGUOUS_B = "abcdef12-0000-4000-8000-000000000002";

let app: FastifyInstance;
let ownerId = "";
let strangerId = "";
let panelId = "";
let ownerCookie = "";
let strangerCookie = "";
/** id → what the fixture is for. Newest-first, matching the API's order. */
let visibleIds: string[] = [];
let statusDeletedId = "";
let strangerServiceId = "";
let expiredServiceId = "";

function signInitData(fields: Record<string, string>): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function signIn(telegramId: bigint): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    payload: {
      initData: signInitData({
        auth_date: String(Math.floor(Date.now() / 1000) - 5),
        query_id: "AApublicids",
        user: `{"id":${telegramId.toString()},"first_name":"Pub"}`,
      }),
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`auth failed ${response.statusCode}: ${response.body}`);
  }
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : String(raw)).split(";")[0];
}

function get(url: string, cookie: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

interface ServiceFixture {
  id?: string;
  userId: string;
  status?: "ACTIVE" | "DELETED";
  deletedAt?: Date | null;
  expiresAt?: Date | null;
  createdAtOffsetMs: number;
  suffix: string;
}

async function makeService(input: ServiceFixture): Promise<string> {
  const row = await prisma.service.create({
    data: {
      ...(input.id === undefined ? {} : { id: input.id }),
      userId: input.userId,
      panelId,
      panelType: "MARZBAN",
      username: `mini-pub-${runTag}-${input.suffix}`,
      status: input.status ?? "ACTIVE",
      deletedAt: input.deletedAt ?? null,
      productNameSnapshot: `Plan ${input.suffix}`,
      panelNameSnapshot: "Panel Pub",
      volumeBytes: 10n * 1024n * 1024n * 1024n,
      usedBytes: 0n,
      remainingBytes: 10n * 1024n * 1024n * 1024n,
      durationDays: 30,
      createdAt: new Date(Date.now() - input.createdAtOffsetMs),
      expiresAt: input.expiresAt === undefined ? new Date(Date.now() + 86_400_000) : input.expiresAt,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  app = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  ownerId = (
    await prisma.user.create({
      data: { telegramId: OWNER_TELEGRAM_ID, firstName: "Pub", balanceToman: 12_000 },
    })
  ).id;
  strangerId = (
    await prisma.user.create({ data: { telegramId: STRANGER_TELEGRAM_ID, firstName: "Str" } })
  ).id;
  panelId = (
    await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: "Panel Pub",
        baseUrl: "https://panel.pub.example",
        username: "pub-admin",
        passwordEncrypted: "blob",
      },
    })
  ).id;

  // Newest first: plain, then the ambiguous pair, then the expired one.
  const plain = await makeService({ userId: ownerId, createdAtOffsetMs: 60_000, suffix: "plain" });
  const ambA = await makeService({
    id: AMBIGUOUS_A,
    userId: ownerId,
    createdAtOffsetMs: 120_000,
    suffix: "amb-a",
  });
  const ambB = await makeService({
    id: AMBIGUOUS_B,
    userId: ownerId,
    createdAtOffsetMs: 180_000,
    suffix: "amb-b",
  });
  expiredServiceId = await makeService({
    userId: ownerId,
    createdAtOffsetMs: 240_000,
    // Already gone: must NOT be counted as "expiring within seven days".
    expiresAt: new Date(Date.now() - 3 * 86_400_000),
    suffix: "expired",
  });
  visibleIds = [plain, ambA, ambB, expiredServiceId];

  // Terminal status, no soft-delete timestamp: the exact shape the previous
  // `deletedAt: null` filter let through.
  statusDeletedId = await makeService({
    userId: ownerId,
    status: "DELETED",
    deletedAt: null,
    createdAtOffsetMs: 30_000,
    suffix: "status-deleted",
  });
  strangerServiceId = await makeService({
    userId: strangerId,
    createdAtOffsetMs: 90_000,
    suffix: "stranger",
  });

  await prisma.walletTransaction.create({
    data: {
      userId: ownerId,
      amountToman: 5_000,
      type: "MANUAL_ADD",
      source: "ADMIN",
      balanceBeforeToman: 7_000,
      balanceAfterToman: 12_000,
    },
  });

  ownerCookie = await signIn(OWNER_TELEGRAM_ID);
  strangerCookie = await signIn(STRANGER_TELEGRAM_ID);
});

afterAll(async () => {
  if (!hasDb) {
    return;
  }
  await app.close();
  await prisma.walletTransaction.deleteMany({ where: { userId: { in: [ownerId, strangerId] } } });
  await prisma.service.deleteMany({ where: { userId: { in: [ownerId, strangerId] } } });
  await prisma.panel.deleteMany({ where: { id: panelId } });
  await prisma.user.deleteMany({
    where: { telegramId: { in: [OWNER_TELEGRAM_ID, STRANGER_TELEGRAM_ID] } },
  });
  await prisma.$disconnect();
});

describe.runIf(hasDb)("mini app public identifiers", () => {
  // D3-1 -----------------------------------------------------------------
  it("D3-1: no response body contains a Service database uuid", async () => {
    const urls = [
      "/api/miniapp/dashboard",
      "/api/miniapp/services",
      "/api/miniapp/services?limit=1",
      `/api/miniapp/services/${serviceShortId({ id: visibleIds[0] })}`,
    ];
    for (const url of urls) {
      const response = await get(url, ownerCookie);
      expect(response.statusCode, url).toBe(200);
      for (const uuid of [...visibleIds, statusDeletedId, strangerServiceId]) {
        expect(response.body, `${url} leaked ${uuid}`).not.toContain(uuid);
      }
    }
  });

  // D3-2 -----------------------------------------------------------------
  it("D3-2: the id it does return is exactly the short id the bot shows", async () => {
    const response = await get("/api/miniapp/services", ownerCookie);
    const ids = (response.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual(visibleIds.map((id) => serviceShortId({ id })));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  // D3-3 -----------------------------------------------------------------
  it("D3-3: the detail route takes the public id and refuses the full uuid", async () => {
    const publicId = serviceShortId({ id: visibleIds[0] });
    const viaPublic = await get(`/api/miniapp/services/${publicId}`, ownerCookie);
    expect(viaPublic.statusCode).toBe(200);
    expect(viaPublic.json().service.id).toBe(publicId);

    // The uuid is not an accepted input, so an attacker who obtained one from
    // a log or a support transcript still cannot address a row with it.
    const viaUuid = await get(`/api/miniapp/services/${visibleIds[0]}`, ownerCookie);
    expect(viaUuid.statusCode).toBe(404);
  });

  // D3-4 -----------------------------------------------------------------
  it("D3-4: malformed, unknown, foreign and deleted are one identical 404", async () => {
    const cases = [
      "zzzzzzzz", // right length, not hex
      "abc", // too short — no prefix probing
      "abcdef1234567890", // too long
      "00000000", // well-formed, no such service
      serviceShortId({ id: strangerServiceId }), // someone else's
      serviceShortId({ id: statusDeletedId }), // terminal state
      "..%2f..%2fetc", // not an id at all
    ];
    const bodies = new Set<string>();
    for (const id of cases) {
      const response = await get(`/api/miniapp/services/${id}`, ownerCookie);
      expect(response.statusCode, id).toBe(404);
      bodies.add(response.body);
    }
    // ONE body for every case: the failure shape teaches nothing.
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0])).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  // D3-5 -----------------------------------------------------------------
  it("D3-5: an ambiguous prefix is a 404, never a guess between two services", async () => {
    expect(serviceShortId({ id: AMBIGUOUS_A })).toBe(serviceShortId({ id: AMBIGUOUS_B }));
    const response = await get(
      `/api/miniapp/services/${serviceShortId({ id: AMBIGUOUS_A })}`,
      ownerCookie,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  // D3-6 -----------------------------------------------------------------
  it("D3-6: a service in the terminal DELETED state is invisible everywhere", async () => {
    const list = await get("/api/miniapp/services", ownerCookie);
    const ids = (list.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).not.toContain(serviceShortId({ id: statusDeletedId }));

    const dashboard = (await get("/api/miniapp/dashboard", ownerCookie)).json();
    // Four visible fixtures; the DELETED one is in none of the numbers.
    expect(dashboard.services.total).toBe(visibleIds.length);
    expect(dashboard.services.byStatus.DELETED).toBeUndefined();
    const recentIds = (dashboard.services.recent as Array<{ id: string }>).map((s) => s.id);
    expect(recentIds).not.toContain(serviceShortId({ id: statusDeletedId }));

    const detail = await get(
      `/api/miniapp/services/${serviceShortId({ id: statusDeletedId })}`,
      ownerCookie,
    );
    expect(detail.statusCode).toBe(404);
  });

  // D3-7 -----------------------------------------------------------------
  it("D3-7: a wallet transaction carries no id at all", async () => {
    for (const url of ["/api/miniapp/wallet/transactions", "/api/miniapp/dashboard"]) {
      const response = await get(url, ownerCookie);
      expect(response.statusCode, url).toBe(200);
      const body = response.json();
      const rows =
        url === "/api/miniapp/dashboard" ? body.wallet.recentTransactions : body.items;
      expect((rows as unknown[]).length).toBeGreaterThan(0);
      for (const row of rows as Array<Record<string, unknown>>) {
        expect(Object.keys(row)).not.toContain("id");
      }
    }
    // And no ledger uuid appears anywhere in the payload either.
    const stored = await prisma.walletTransaction.findMany({
      where: { userId: ownerId },
      select: { id: true },
    });
    const body = (await get("/api/miniapp/wallet/transactions", ownerCookie)).body;
    for (const row of stored) {
      expect(body).not.toContain(row.id);
    }
  });

  // D3-8 -----------------------------------------------------------------
  it("D3-8: the cursor is opaque — no uuid survives decoding it, and it still pages correctly", async () => {
    const first = await get("/api/miniapp/services?limit=1", ownerCookie);
    const cursor = first.json().nextCursor as string;
    expect(cursor).toBeTruthy();

    // Try every reversible reading a client could attempt.
    const candidates = [cursor, ...cursor.split(".")];
    const decodings = candidates.flatMap((part) => [
      part,
      Buffer.from(part, "base64url").toString("utf8"),
      Buffer.from(part, "base64url").toString("hex"),
      Buffer.from(part, "base64").toString("utf8"),
    ]);
    for (const decoded of decodings) {
      for (const uuid of visibleIds) {
        expect(decoded).not.toContain(uuid);
        // Not even the uuid with its dashes stripped.
        expect(decoded).not.toContain(uuid.replace(/-/g, ""));
      }
      expect(decoded).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }

    // Keyset ordering is intact: paging one at a time walks every row once.
    const seen: string[] = [];
    let next: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url: string =
        next === null
          ? "/api/miniapp/services?limit=1"
          : `/api/miniapp/services?limit=1&cursor=${encodeURIComponent(next)}`;
      const page = await get(url, ownerCookie);
      expect(page.statusCode).toBe(200);
      const body = page.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      next = body.nextCursor;
      if (next === null) {
        break;
      }
    }
    // Every row exactly once, in order. (Uniqueness of the SHORT ids is
    // deliberately not asserted: two fixtures here share an 8-character prefix
    // on purpose — that is what D3-5 exercises. The equality above is the
    // walk-once property, since a skipped or repeated row changes the sequence.)
    expect(seen).toEqual(visibleIds.map((id) => serviceShortId({ id })));
    expect(seen).toHaveLength(visibleIds.length);

    // Tamper detection: flipping any character invalidates it.
    const flipped = `${cursor.slice(0, -1)}${cursor.slice(-1) === "A" ? "B" : "A"}`;
    const tampered = await get(
      `/api/miniapp/services?cursor=${encodeURIComponent(flipped)}`,
      ownerCookie,
    );
    expect(tampered.statusCode).toBe(400);
  });

  // D3-9 -----------------------------------------------------------------
  it("D3-9: a cursor is bound to its collection and cannot be replayed on another", async () => {
    const serviceCursor = (await get("/api/miniapp/services?limit=1", ownerCookie)).json()
      .nextCursor as string;
    expect(serviceCursor).toBeTruthy();

    const replayed = await get(
      `/api/miniapp/wallet/transactions?cursor=${encodeURIComponent(serviceCursor)}`,
      ownerCookie,
    );
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toEqual({ ok: false, code: "BAD_REQUEST" });

    // The same cursor is still valid where it belongs — the refusal above is
    // the binding, not a broken cursor.
    const ownCollection = await get(
      `/api/miniapp/services?cursor=${encodeURIComponent(serviceCursor)}`,
      ownerCookie,
    );
    expect(ownCollection.statusCode).toBe(200);
  });

  // D3-10 ----------------------------------------------------------------
  it("D3-10: an already-expired service is not counted as expiring within seven days", async () => {
    const dashboard = (await get("/api/miniapp/dashboard", ownerCookie)).json();
    // Three fixtures expire tomorrow; one expired three days ago. Counting the
    // past as "soon" would report 4.
    expect(dashboard.services.expiringWithin7Days).toBe(visibleIds.length - 1);

    // Move the expired one to just inside the window and it counts again — so
    // the assertion above is about the boundary, not about the row being
    // excluded for some other reason.
    await prisma.service.update({
      where: { id: expiredServiceId },
      data: { expiresAt: new Date(Date.now() + 3 * 86_400_000) },
    });
    const after = (await get("/api/miniapp/dashboard", ownerCookie)).json();
    expect(after.services.expiringWithin7Days).toBe(visibleIds.length);

    // And a service expiring beyond the window is not "soon" either.
    await prisma.service.update({
      where: { id: expiredServiceId },
      data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    const beyond = (await get("/api/miniapp/dashboard", ownerCookie)).json();
    expect(beyond.services.expiringWithin7Days).toBe(visibleIds.length - 1);
  });

  // D3-11 ----------------------------------------------------------------
  it("D3-11: a stranger's session sees none of the owner's public ids", async () => {
    const list = await get("/api/miniapp/services", strangerCookie);
    expect(list.statusCode).toBe(200);
    const ids = (list.json().items as Array<{ id: string }>).map((i) => i.id);
    for (const uuid of visibleIds) {
      expect(ids).not.toContain(serviceShortId({ id: uuid }));
    }
    expect(ids).toContain(serviceShortId({ id: strangerServiceId }));
  });
});
