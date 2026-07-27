import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { serviceShortId } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// E3 — the read-only contract the Mini App was specified with, completed.
//
// Four gaps, all of which made the app look finished while quietly under-
// answering: the dashboard returned three services where five were asked for,
// `/me` returned a profile with no idea how many services the account has, no
// response said WHEN it was generated or how fresh its data was, and a service
// summary omitted its location, its freshness and how many days are left.
//
// The freshness rule is the part worth stating precisely, because a vague one
// is worse than none: `dataFreshnessTimestamp` is the OLDEST database write
// among the services in the response, so "everything here is at least this
// fresh" is true of every row rather than of the luckiest one. It is DATABASE
// freshness — nothing in this surface calls a panel, so nothing here can speak
// for a panel's state.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-contract-secret-0123456789";
const BOT_TOKEN = "818181:AA-miniapp-contract-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");
const { remainingDaysUntil } = await import("../src/miniapp/serializers.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const USER_TELEGRAM_ID = 9_700_000_000_000n + runTag;

const DAY_MS = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let userId = "";
let panelId = "";
let cookie = "";
/** Newest-first, as the API orders them. Seven visible + two invisible. */
let visibleIds: string[] = [];
let unlimitedId = "";
let expiredId = "";
let softDeletedId = "";
let statusDeletedId = "";

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

function get(url: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

async function makeService(input: {
  suffix: string;
  createdAgoMs: number;
  updatedAgoMs?: number;
  expiresAt?: Date | null;
  durationDays?: number;
  status?: "ACTIVE" | "DELETED";
  deletedAt?: Date | null;
}): Promise<string> {
  const row = await prisma.service.create({
    data: {
      userId,
      panelId,
      panelType: "MARZBAN",
      username: `mini-contract-${runTag}-${input.suffix}`,
      status: input.status ?? "ACTIVE",
      deletedAt: input.deletedAt ?? null,
      productNameSnapshot: `Plan ${input.suffix}`,
      panelNameSnapshot: "Panel Contract",
      serviceLocation: "MULTI_LOCATION",
      volumeBytes: 20n * 1024n * 1024n * 1024n,
      usedBytes: 1n * 1024n * 1024n * 1024n,
      remainingBytes: 19n * 1024n * 1024n * 1024n,
      durationDays: input.durationDays ?? 30,
      createdAt: new Date(Date.now() - input.createdAgoMs),
      updatedAt: new Date(Date.now() - (input.updatedAgoMs ?? input.createdAgoMs)),
      expiresAt: input.expiresAt === undefined ? new Date(Date.now() + 10 * DAY_MS) : input.expiresAt,
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

  userId = (
    await prisma.user.create({
      data: { telegramId: USER_TELEGRAM_ID, firstName: "Contract", balanceToman: 42_000 },
    })
  ).id;
  panelId = (
    await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: "Panel Contract",
        baseUrl: "https://panel.contract.example",
        username: "contract-admin",
        passwordEncrypted: "blob",
      },
    })
  ).id;

  // SEVEN visible services, so "at most five recent" is a real bound rather
  // than an accident of the fixture size.
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(await makeService({ suffix: `plain-${i}`, createdAgoMs: (i + 1) * 60_000 }));
  }
  // Unlimited: no expiry at all.
  unlimitedId = await makeService({
    suffix: "unlimited",
    createdAgoMs: 6 * 60_000,
    durationDays: 0,
    expiresAt: null,
  });
  ids.push(unlimitedId);
  // Already expired, and deliberately the OLDEST write in the account so it
  // sets the conservative freshness floor when it is in the slice.
  expiredId = await makeService({
    suffix: "expired",
    createdAgoMs: 7 * 60_000,
    updatedAgoMs: 30 * DAY_MS,
    expiresAt: new Date(Date.now() - 3 * DAY_MS),
  });
  ids.push(expiredId);
  visibleIds = ids;

  // Two that must be invisible to every count and every list.
  softDeletedId = await makeService({
    suffix: "soft-deleted",
    createdAgoMs: 30_000,
    deletedAt: new Date(),
  });
  statusDeletedId = await makeService({
    suffix: "status-deleted",
    createdAgoMs: 40_000,
    status: "DELETED",
  });

  const auth = await app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    payload: {
      initData: signInitData({
        auth_date: String(Math.floor(Date.now() / 1000) - 5),
        query_id: "AAcontract",
        user: `{"id":${USER_TELEGRAM_ID.toString()},"first_name":"Contract"}`,
      }),
    },
  });
  if (auth.statusCode !== 200) {
    throw new Error(`auth failed ${auth.statusCode}: ${auth.body}`);
  }
  const raw = auth.headers["set-cookie"];
  cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(";")[0];
});

afterAll(async () => {
  if (!hasDb) {
    return;
  }
  await app.close();
  await prisma.service.deleteMany({ where: { userId } });
  await prisma.panel.deleteMany({ where: { id: panelId } });
  await prisma.user.deleteMany({ where: { telegramId: USER_TELEGRAM_ID } });
  await prisma.$disconnect();
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe.runIf(hasDb)("mini app read-only contract", () => {
  // E3-1 -----------------------------------------------------------------
  it("E3-1: the dashboard returns AT MOST five recent services, and five transactions", async () => {
    const response = await get("/api/miniapp/dashboard");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Seven exist; the slice is bounded at five and is not merely "all of them".
    expect(visibleIds.length).toBeGreaterThan(5);
    expect(body.services.recent).toHaveLength(5);
    expect(body.wallet.recentTransactions.length).toBeLessThanOrEqual(5);
    // Newest first, and the bound is applied to the newest — not an arbitrary five.
    expect(body.services.recent.map((s: { id: string }) => s.id)).toEqual(
      visibleIds.slice(0, 5).map((id) => serviceShortId({ id })),
    );
  });

  // E3-2 / E3-3 ----------------------------------------------------------
  it("E3-2/3: /me counts match the database and ignore deleted services", async () => {
    const response = await get("/api/miniapp/me");
    expect(response.statusCode).toBe(200);
    const body = response.json();

    const total = await prisma.service.count({
      where: { userId, deletedAt: null, status: { not: "DELETED" } },
    });
    const active = await prisma.service.count({
      where: { userId, deletedAt: null, status: "ACTIVE" },
    });
    expect(body.services).toEqual({ active, total });
    expect(body.services.total).toBe(visibleIds.length);

    // The two invisible rows exist and are excluded by BOTH deletion markers.
    const everything = await prisma.service.count({ where: { userId } });
    expect(everything).toBe(visibleIds.length + 2);
    expect(await prisma.service.findUnique({ where: { id: softDeletedId } })).not.toBeNull();
    expect(await prisma.service.findUnique({ where: { id: statusDeletedId } })).not.toBeNull();
  });

  // E3-4 -----------------------------------------------------------------
  it("E3-4: both dashboard timestamps are valid ISO-8601 instants", async () => {
    const before = Date.now();
    const body = (await get("/api/miniapp/dashboard")).json();
    const after = Date.now();

    expect(body.serverTimestamp).toMatch(ISO);
    expect(body.dataFreshnessTimestamp).toMatch(ISO);
    const server = Date.parse(body.serverTimestamp);
    expect(Number.isNaN(server)).toBe(false);
    // Generation time, so it lands inside the window the request occupied.
    expect(server).toBeGreaterThanOrEqual(before - 1_000);
    expect(server).toBeLessThanOrEqual(after + 1_000);
  });

  // E3-5 -----------------------------------------------------------------
  it("E3-5: data freshness is the OLDEST write in the slice, never the newest", async () => {
    const body = (await get("/api/miniapp/dashboard")).json();
    const returned = body.services.recent as Array<{ id: string; lastSyncedAt: string }>;
    const stamps = returned.map((s) => Date.parse(s.lastSyncedAt));
    const freshness = Date.parse(body.dataFreshnessTimestamp);

    expect(freshness).toBe(Math.min(...stamps));
    // The distinction only means something when the rows differ, so prove they do.
    expect(Math.min(...stamps)).toBeLessThan(Math.max(...stamps));
    // "Everything here is at least this fresh" — true of every row.
    for (const stamp of stamps) {
      expect(stamp).toBeGreaterThanOrEqual(freshness);
    }
    // And it never claims to be newer than the response itself.
    expect(freshness).toBeLessThanOrEqual(Date.parse(body.serverTimestamp));
  });

  // E3-6 -----------------------------------------------------------------
  it("E3-6: service summaries carry location, last sync and remaining days", async () => {
    const list = (await get("/api/miniapp/services")).json();
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items as Array<Record<string, unknown>>) {
      expect(typeof item.location).toBe("string");
      expect(item.location).not.toBe("");
      expect(String(item.lastSyncedAt)).toMatch(ISO);
      expect(Object.keys(item)).toContain("remainingDays");
    }

    // The detail is a SUPERSET of the summary, so the two cannot disagree.
    const publicId = serviceShortId({ id: visibleIds[0] });
    const detail = (await get(`/api/miniapp/services/${publicId}`)).json().service;
    const summary = (list.items as Array<{ id: string }>).find((i) => i.id === publicId);
    expect(detail.location).toBe(summary?.location);
    expect(detail.lastSyncedAt).toBe((summary as { lastSyncedAt: string }).lastSyncedAt);
    expect(detail.remainingDays).toBe((summary as { remainingDays: number | null }).remainingDays);
  });

  // E3-7 -----------------------------------------------------------------
  it("E3-7: remaining days distinguishes unlimited, expired and future", async () => {
    const byId = new Map<string, { remainingDays: number | null; expiresAt: string | null }>();
    for (const id of [unlimitedId, expiredId, visibleIds[0]]) {
      const service = (await get(`/api/miniapp/services/${serviceShortId({ id })}`)).json().service;
      byId.set(id, service);
    }

    // Unlimited: the field does not apply, and `null` says so. Not 0, which
    // would render as an expiry countdown that never moves.
    expect(byId.get(unlimitedId)?.expiresAt).toBeNull();
    expect(byId.get(unlimitedId)?.remainingDays).toBeNull();

    // Expired: zero, never negative.
    expect(byId.get(expiredId)?.remainingDays).toBe(0);

    // Future: a positive whole number of days.
    const future = byId.get(visibleIds[0])?.remainingDays;
    expect(future).not.toBeNull();
    expect(future).toBeGreaterThan(0);

    // The pure rule, at its boundaries.
    const now = Date.UTC(2026, 0, 1);
    expect(remainingDaysUntil(null, now)).toBeNull();
    expect(remainingDaysUntil(new Date(now), now)).toBe(0);
    expect(remainingDaysUntil(new Date(now - 1), now)).toBe(0);
    // One second left is still a day remaining, not zero.
    expect(remainingDaysUntil(new Date(now + 1_000), now)).toBe(1);
    expect(remainingDaysUntil(new Date(now + DAY_MS), now)).toBe(1);
    expect(remainingDaysUntil(new Date(now + DAY_MS + 1), now)).toBe(2);
  });

  // E3-8 -----------------------------------------------------------------
  it("E3-8: the completed contract still leaks no uuid, secret or panel identity", async () => {
    const secrets = [...visibleIds, softDeletedId, statusDeletedId, panelId, userId];
    for (const url of [
      "/api/miniapp/me",
      "/api/miniapp/dashboard",
      "/api/miniapp/services",
      `/api/miniapp/services/${serviceShortId({ id: visibleIds[0] })}`,
      "/api/miniapp/wallet/transactions",
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      for (const secret of secrets) {
        expect(response.body, `${url} leaked ${secret}`).not.toContain(secret);
      }
      expect(response.body, url).not.toContain("panel.contract.example");
      expect(response.body, url).not.toContain("panelId");
    }
  });

  // E3-9 -----------------------------------------------------------------
  it("E3-9: the whole surface is still read-only — no route accepts a mutation", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const url of [
        "/api/miniapp/me",
        "/api/miniapp/dashboard",
        "/api/miniapp/services",
        "/api/miniapp/wallet/transactions",
      ]) {
        const response = await app.inject({ method, url, headers: { cookie }, payload: {} });
        // 404 (no such route) or 405 — never a success, and never a 4xx that
        // implies the route exists and merely disliked the payload.
        expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
      }
    }
  });

  // E3-10 ----------------------------------------------------------------
  it("E3-10: an unauthenticated caller gets none of the new fields", async () => {
    for (const url of ["/api/miniapp/me", "/api/miniapp/dashboard"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.body, url).not.toContain("serverTimestamp");
      expect(response.body, url).not.toContain("dataFreshnessTimestamp");
      expect(response.body, url).not.toContain("services");
    }
  });
});
