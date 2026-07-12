import http from "node:http";

import { prisma, type Panel, type User } from "@zedbot/database";
import { encryptSecret, getRedisOptions } from "@zedbot/shared";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "zedbot-panel-tests-shared-secret-00001";

import { EXTRA_TIME_EVENT_TYPE, executeExtraTimeOrder } from "../src/services/extra-time.service.js";
import {
  EXTRA_VOLUME_EVENT_TYPE,
  executeExtraVolumeOrder,
} from "../src/services/extra-volume.service.js";
import { REFUND_PROVISIONING_REASON } from "../src/services/provisioning.service.js";
import {
  acquireServiceLock,
  resetServiceLockClientForTests,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceOperationLockKey,
} from "../src/services/service-lock.service.js";
import { executeRenewalOrder, RENEWAL_EVENT_TYPE } from "../src/services/service-renewal.service.js";
import {
  recoverStaleProvisioningOrders,
  STALE_PIPELINE_MINUTES,
} from "../src/services/startup-recovery.service.js";

// =============================================================================
// Per-service operation serialization (real PostgreSQL + real Redis + a
// mutable mock Marzban panel with injectable delays/failures/barriers).
//
// The lost-update race under test: two PAID orders on ONE service both read
// quota 20 GB, both compute 30 GB, both write 30 GB - the user paid for
// 20 GB and got 10. The attribution race: startup reconciliation observes a
// remote change made by a concurrent LIVE operation and misclassifies a
// stale order as APPLIED. The distributed per-service lock serializes the
// whole read->panel->persist sequence; reconciliation shares the same lock
// and only classifies against exact expected states.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis =
  (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 86_400_000;
const PRICE = 40_000;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// --- mutable mock Marzban panel ------------------------------------------------------
interface MockPanelUser {
  data_limit: number;
  expire: number;
  used_traffic: number;
}
const panelUsers = new Map<string, MockPanelUser>();
let putDelayMs = 0;
let putFailStatus: number | null = null;
let putGate: { promise: Promise<void>; open: () => void } | null = null;
let inFlightPuts = 0;
let maxConcurrentPuts = 0;
let putCount = 0;

function makeGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function userJson(username: string, user: MockPanelUser): string {
  return JSON.stringify({
    username,
    status: "active",
    used_traffic: user.used_traffic,
    data_limit: user.data_limit,
    expire: user.expire,
    subscription_url: `/sub/${username}`,
  });
}

let mockServer: http.Server;
let mockPanelUrl = "";

function startMockPanel(): Promise<void> {
  mockServer = http.createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: string): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      };
      if (req.method === "POST" && req.url === "/api/admin/token") {
        send(200, JSON.stringify({ access_token: "mock-token" }));
        return;
      }
      const reset = /^\/api\/user\/([^/]+)\/reset$/.exec(req.url ?? "");
      if (req.method === "POST" && reset !== null) {
        const username = decodeURIComponent(reset[1] ?? "");
        const user = panelUsers.get(username);
        if (user === undefined) {
          send(404, JSON.stringify({ detail: "User not found" }));
          return;
        }
        user.used_traffic = 0;
        send(200, userJson(username, user));
        return;
      }
      const match = /^\/api\/user\/([^/]+)$/.exec(req.url ?? "");
      if (match !== null) {
        const username = decodeURIComponent(match[1] ?? "");
        const user = panelUsers.get(username);
        if (req.method === "GET") {
          if (user === undefined) {
            send(404, JSON.stringify({ detail: "User not found" }));
            return;
          }
          send(200, userJson(username, user));
          return;
        }
        if (req.method === "PUT") {
          inFlightPuts += 1;
          maxConcurrentPuts = Math.max(maxConcurrentPuts, inFlightPuts);
          putCount += 1;
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            if (putGate !== null) {
              await putGate.promise;
            }
            if (putDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, putDelayMs));
            }
            if (putFailStatus !== null) {
              send(putFailStatus, JSON.stringify({ detail: "injected failure" }));
              return;
            }
            if (user === undefined) {
              send(404, JSON.stringify({ detail: "User not found" }));
              return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              data_limit?: number;
              expire?: number;
            };
            if (typeof body.data_limit === "number") {
              user.data_limit = body.data_limit;
            }
            if (typeof body.expire === "number") {
              user.expire = body.expire;
            }
            send(200, userJson(username, user));
          } finally {
            inFlightPuts -= 1;
          }
          return;
        }
      }
      send(404, JSON.stringify({ detail: "no route" }));
    })();
  });
  return new Promise((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      const address = mockServer.address() as { port: number };
      mockPanelUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

// --- fixtures ------------------------------------------------------------------------
let panel: Panel;
let categoryId: string;
let productId: string;
let redis: Redis;

beforeAll(async () => {
  if (!hasDb || !hasRedis) return;
  await startMockPanel();
  const redisOptions = getRedisOptions();
  redis = new Redis({ ...redisOptions, maxRetriesPerRequest: 1 });
  panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `svcop-panel-${runTag}`,
      baseUrl: mockPanelUrl,
      username: "admin",
      passwordEncrypted: encryptSecret("mock-password"),
      status: "ACTIVE",
    },
  });
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `svcop-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId: panel.id,
      name: `svcop-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
});

afterAll(async () => {
  if (!hasDb || !hasRedis) return;
  mockServer?.close();
  resetServiceLockClientForTests();
  await redis?.quit();
});

async function createUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq) } });
}

/** Aligned to whole unix seconds so panel <-> DB comparisons are exact. */
function secondsDate(msFromNow: number): { date: Date; unix: number } {
  const unix = Math.floor((Date.now() + msFromNow) / 1000);
  return { date: new Date(unix * 1000), unix };
}

interface ServiceFixture {
  serviceId: string;
  username: string;
  userId: string;
}

async function createServiceWithPanelUser(
  user: User,
  opts: { volumeGb: number; expireMsFromNow: number },
): Promise<ServiceFixture & { expiry: { date: Date; unix: number } }> {
  seq += 1;
  const username = `svcop-${runTag}-${seq}`;
  const expiry = secondsDate(opts.expireMsFromNow);
  const volumeBytes = BigInt(opts.volumeGb) * GIB;
  const service = await prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      productId,
      panelType: "MARZBAN",
      username,
      status: "ACTIVE",
      volumeBytes,
      usedBytes: 0n,
      remainingBytes: volumeBytes,
      expiresAt: expiry.date,
      startsAt: new Date(),
    },
  });
  panelUsers.set(username, {
    data_limit: Number(volumeBytes),
    expire: expiry.unix,
    used_traffic: 0,
  });
  return { serviceId: service.id, username, userId: user.id, expiry };
}

async function createPaidOrder(
  user: User,
  serviceId: string,
  type: "SERVICE_RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME",
  plan: { volumeGb?: number; durationDays?: number },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type,
      status: "PAID",
      productId,
      serviceId,
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      volumeGbSnapshot: plan.volumeGb ?? 0,
      durationDaysSnapshot: plan.durationDays ?? 0,
      paidAt: new Date(),
    },
  });
  return order.id;
}

async function ageOrder(orderId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() - (${STALE_PIPELINE_MINUTES + 10} * interval '1 minute') WHERE "id" = ${orderId}`;
}

async function markProvisioning(orderId: string): Promise<void> {
  await prisma.order.update({ where: { id: orderId }, data: { status: "PROVISIONING" } });
}

function staleCutoff(): Date {
  return new Date(Date.now() - STALE_PIPELINE_MINUTES * 60_000);
}

async function eventCount(serviceId: string, eventType: string): Promise<number> {
  return prisma.serviceEventLog.count({ where: { serviceId, eventType } });
}

async function refundCount(orderId: string): Promise<number> {
  return prisma.walletTransaction.count({
    where: { relatedOrderId: orderId, reason: REFUND_PROVISIONING_REASON },
  });
}

describe.runIf(hasDb && hasRedis)("per-service operation serialization", () => {
  it("1. two concurrent extra-volume orders both land: 20 GB + 10 + 10 -> 40 GB", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const [a, b] = await Promise.all([
      createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 }),
      createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 }),
    ]);

    putDelayMs = 60; // widen the would-be race window
    try {
      const [ra, rb] = await Promise.all([executeExtraVolumeOrder(a), executeExtraVolumeOrder(b)]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
    } finally {
      putDelayMs = 0;
    }

    // NO lost update: the second operation computed from the first's result.
    expect(panelUsers.get(svc.username)!.data_limit).toBe(Number(40n * GIB)); // NEVER 30 GB
    const service = await prisma.service.findUniqueOrThrow({ where: { id: svc.serviceId } });
    expect(service.volumeBytes).toBe(40n * GIB);
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(2);
    expect(await refundCount(a)).toBe(0);
    expect(await refundCount(b)).toBe(0);
    for (const id of [a, b]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
    }
  });

  it("2. two concurrent extra-time orders both land: +10d and +20d -> +30d total", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 5 * DAY_MS });
    const [a, b] = await Promise.all([
      createPaidOrder(user, svc.serviceId, "EXTRA_TIME", { durationDays: 10 }),
      createPaidOrder(user, svc.serviceId, "EXTRA_TIME", { durationDays: 20 }),
    ]);

    const [ra, rb] = await Promise.all([executeExtraTimeOrder(a), executeExtraTimeOrder(b)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    const expected = svc.expiry.unix + 30 * 86_400; // initial + 10d + 20d
    expect(panelUsers.get(svc.username)!.expire).toBe(expected); // NO lost update
    const service = await prisma.service.findUniqueOrThrow({ where: { id: svc.serviceId } });
    expect(service.expiresAt?.getTime()).toBe(expected * 1000);
    expect(await eventCount(svc.serviceId, EXTRA_TIME_EVENT_TYPE)).toBe(2);
  });

  it("3. renewal and extra-volume concurrently keep BOTH effects", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 5 * DAY_MS });
    const [renewal, extra] = await Promise.all([
      createPaidOrder(user, svc.serviceId, "SERVICE_RENEWAL", { volumeGb: 15, durationDays: 30 }),
      createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 }),
    ]);

    const [rr, re] = await Promise.all([executeRenewalOrder(renewal), executeExtraVolumeOrder(extra)]);
    expect(rr.ok).toBe(true);
    expect(re.ok).toBe(true);

    // Either execution order yields 20 + 15 + 10 = 45 GB and expiry + 30d.
    expect(panelUsers.get(svc.username)!.data_limit).toBe(Number(45n * GIB));
    expect(panelUsers.get(svc.username)!.expire).toBe(svc.expiry.unix + 30 * 86_400);
    expect(await eventCount(svc.serviceId, RENEWAL_EVENT_TYPE)).toBe(1);
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(1);
    expect(await refundCount(renewal)).toBe(0);
    expect(await refundCount(extra)).toBe(0);
  });

  it("4. the same order executed twice concurrently mutates once", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const orderId = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });

    const putsBefore = putCount;
    const [ra, rb] = await Promise.all([
      executeExtraVolumeOrder(orderId),
      executeExtraVolumeOrder(orderId),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    expect(putCount - putsBefore).toBe(1); // ONE remote mutation
    expect(panelUsers.get(svc.username)!.data_limit).toBe(Number(30n * GIB));
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(1);
    expect(await refundCount(orderId)).toBe(0);
  });

  it("5. reconciliation defers while a live mutation holds the service, then attributes correctly", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const liveOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    const staleOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(staleOrder);
    await ageOrder(staleOrder);

    // Hold the live mutation INSIDE the panel adapter call.
    putGate = makeGate();
    const live = executeExtraVolumeOrder(liveOrder);
    try {
      for (let i = 0; i < 100 && inFlightPuts === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(inFlightPuts).toBe(1); // live op is mid-panel-call, lock held

      const report = await recoverStaleProvisioningOrders(staleCutoff());
      expect(report.deferredOrders).toBeGreaterThanOrEqual(1);
      expect(report.completedOrders).toBe(0); // NEVER attributes the live change
      expect(report.refundedOrders).toBe(0);
      const stale = await prisma.order.findUniqueOrThrow({ where: { id: staleOrder } });
      expect(stale.status).toBe("PROVISIONING"); // untouched while contended
    } finally {
      putGate.open();
      putGate = null;
    }
    const liveOutcome = await live;
    expect(liveOutcome.ok).toBe(true);

    // After the live op settles, reconciliation runs under the lock: the
    // panel now equals the (updated) stored state, so the stale order is
    // proven UNAPPLIED and refunded - never completed off another order's
    // remote change.
    await recoverStaleProvisioningOrders(staleCutoff());
    const stale = await prisma.order.findUniqueOrThrow({ where: { id: staleOrder } });
    expect(stale.status).toBe("FAILED");
    expect(await refundCount(staleOrder)).toBe(1);
    expect(panelUsers.get(svc.username)!.data_limit).toBe(Number(30n * GIB)); // live effect only
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(1);
  });

  it("6. two reconciliation sweeps racing settle one stale order exactly once", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const staleOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(staleOrder);
    await ageOrder(staleOrder);
    // Panel equals the stored pre-state: proven unapplied -> refund path.

    await Promise.all([
      recoverStaleProvisioningOrders(staleCutoff()),
      recoverStaleProvisioningOrders(staleCutoff()),
    ]);
    // A deferred loser retries on the next sweep.
    await recoverStaleProvisioningOrders(staleCutoff());

    const stale = await prisma.order.findUniqueOrThrow({ where: { id: staleOrder } });
    expect(stale.status).toBe("FAILED");
    expect(await refundCount(staleOrder)).toBe(1); // NEVER twice
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
  });

  it("7. operations on DIFFERENT services run concurrently (no global lock)", async () => {
    const user = await createUser();
    const svc1 = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const svc2 = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const [a, b] = await Promise.all([
      createPaidOrder(user, svc1.serviceId, "EXTRA_VOLUME", { volumeGb: 10 }),
      createPaidOrder(user, svc2.serviceId, "EXTRA_VOLUME", { volumeGb: 10 }),
    ]);

    maxConcurrentPuts = 0;
    putDelayMs = 400;
    try {
      const [ra, rb] = await Promise.all([executeExtraVolumeOrder(a), executeExtraVolumeOrder(b)]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
    } finally {
      putDelayMs = 0;
    }
    expect(maxConcurrentPuts).toBe(2); // the two panel writes overlapped
  });

  it("8. the lock is released after a panel failure and can be re-acquired", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const orderId = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });

    putFailStatus = 500;
    try {
      const outcome = await executeExtraVolumeOrder(orderId);
      expect(outcome.ok).toBe(false); // panel failed -> FAILED + refund
    } finally {
      putFailStatus = null;
    }
    expect(await refundCount(orderId)).toBe(1);

    // No stale Redis key: the next acquirer succeeds immediately.
    expect(await redis.exists(serviceOperationLockKey(svc.serviceId))).toBe(0);
    const acquisition = await acquireServiceLock(serviceOperationLockKey(svc.serviceId), 0);
    expect(acquisition.ok).toBe(true);
    if (acquisition.ok) {
      await acquisition.lock.release();
    }
  });

  it("9. an expired owner can never delete the next owner's lock", async () => {
    const key = `zedbot:service-operation:test-${runTag}-${++seq}`;
    const first = await acquireServiceLock(key, 0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Simulate TTL expiry of owner A, then owner B acquires the same key.
    await redis.pexpire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await acquireServiceLock(key, 0);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await first.lock.release(); // A's compare-and-delete must be a no-op
    expect(await redis.exists(key)).toBe(1); // B still holds the lock
    await second.lock.release();
    expect(await redis.exists(key)).toBe(0);
  });

  it("10. a paid order under contention stays PAID and retryable - panel untouched", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const orderId = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });

    const key = serviceOperationLockKey(svc.serviceId);
    await redis.set(key, "foreign-owner-token", "PX", 30_000, "NX");
    const putsBefore = putCount;
    try {
      const outcome = await executeExtraVolumeOrder(orderId);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.refunded).toBe(false);
      expect(!outcome.ok && outcome.error).toBe(SERVICE_LOCK_BUSY_TEXT);
    } finally {
      await redis.del(key);
    }

    expect(putCount).toBe(putsBefore); // panel never called
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PAID"); // retryable, NOT refunded
    expect(await refundCount(orderId)).toBe(0);
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);

    // Explicit retry after the contention clears succeeds.
    const retry = await executeExtraVolumeOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(panelUsers.get(svc.username)!.data_limit).toBe(Number(30n * GIB));
  }, 20_000);

  it("11. Redis unavailable fails closed: no panel call, no money movement, reconciliation defers", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const paidOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    const staleOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(staleOrder);
    await ageOrder(staleOrder);

    const originalUrl = process.env.REDIS_URL;
    const originalHost = process.env.REDIS_HOST;
    resetServiceLockClientForTests();
    process.env.REDIS_URL = "redis://:wrong@127.0.0.1:1";
    delete process.env.REDIS_HOST;
    const putsBefore = putCount;
    try {
      const outcome = await executeExtraVolumeOrder(paidOrder);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.refunded).toBe(false);
      expect(!outcome.ok && outcome.error).toBe(SERVICE_LOCK_UNAVAILABLE_TEXT);

      const report = await recoverStaleProvisioningOrders(staleCutoff());
      expect(report.deferredOrders).toBeGreaterThanOrEqual(1);
      expect(report.refundedOrders).toBe(0);
      expect(report.completedOrders).toBe(0);
    } finally {
      if (originalUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = originalUrl;
      if (originalHost !== undefined) process.env.REDIS_HOST = originalHost;
      resetServiceLockClientForTests();
    }

    expect(putCount).toBe(putsBefore); // panel never touched
    expect((await prisma.order.findUniqueOrThrow({ where: { id: paidOrder } })).status).toBe("PAID");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: staleOrder } })).status).toBe(
      "PROVISIONING",
    );
    expect(await refundCount(paidOrder)).toBe(0);
    expect(await refundCount(staleOrder)).toBe(0);
  });

  it("12. exact attribution: a quota explainable only by another operation stays UNKNOWN", async () => {
    const user = await createUser();
    const svc = await createServiceWithPanelUser(user, { volumeGb: 20, expireMsFromNow: 30 * DAY_MS });
    const staleOrder = await createPaidOrder(user, svc.serviceId, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(staleOrder);
    await ageOrder(staleOrder);
    // Remote quota is 35 GB: not the pre-state (20) and not this order's
    // exact expected result (20 remaining + 10 = 30) - unattributable.
    panelUsers.get(svc.username)!.data_limit = Number(35n * GIB);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.deferredOrders).toBeGreaterThanOrEqual(1);

    const stale = await prisma.order.findUniqueOrThrow({ where: { id: staleOrder } });
    expect(stale.status).toBe("PROVISIONING"); // no completion, no refund
    expect(await refundCount(staleOrder)).toBe(0);
    expect(await eventCount(svc.serviceId, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
  });
});

describe.runIf(!hasDb || !hasRedis)("per-service operation serialization (skipped)", () => {
  it("requires DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDb && hasRedis).toBe(false);
  });
});
