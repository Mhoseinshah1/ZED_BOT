import { prisma, type Panel } from "@zedbot/database";
import { getRedisOptions } from "@zedbot/shared";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "notification-sync-tests-secret-0123456789";

// The service-sync engine builds its adapter through the worker factory; mock
// the factory so we can drive bulk / per-user / failure behavior deterministically.
let currentAdapter: {
  listServiceAccounts?: (input?: unknown) => Promise<unknown>;
  getServiceAccount: (input: { username: string }) => Promise<unknown>;
} | null = null;

vi.mock("../../worker/src/notifications/panel-adapter-factory.js", () => ({
  buildWorkerAdapterForPanel: () => currentAdapter,
  normalizeWorkerSubscriptionBase: () => null,
  WorkerAdapterConfigError: class extends Error {},
}));

const { syncPanelServices } = await import("../../worker/src/notifications/service-sync.js");
const { panelSyncLockKey, panelBreakerKey } = await import("@zedbot/shared");

// =============================================================================
// Worker service-state sync against a real DB + real Redis (breaker / lock) with
// a mocked adapter. Covers: XUI bulk (one call, matched by username), Marzban
// bounded per-user fallback, the per-panel circuit breaker (opens after repeated
// panel-wide failures, skips while open, clears on a healthy read), lock
// contention, and "never guess" (a failed read leaves the row untouched).
// =============================================================================

const hasDbRedis =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL !== "" &&
  getRedisOptions() !== null;
const d = hasDbRedis ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const GIB = 1024n * 1024n * 1024n;

d("worker service-state sync", () => {
  let seq = 0;
  let redis: Redis;

  beforeAll(() => {
    const opts = getRedisOptions();
    redis = new Redis({
      host: opts!.host,
      port: opts!.port,
      password: opts!.password,
      maxRetriesPerRequest: null,
    });
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  async function makePanel(): Promise<Panel> {
    seq += 1;
    return prisma.panel.create({
      data: { type: "XUI", name: `sync-panel-${runTag}-${seq}`, baseUrl: "https://panel.test" },
    });
  }

  async function makeService(panel: Panel, username: string) {
    const user = await prisma.user.create({ data: { telegramId: runTag + BigInt(++seq) } });
    return prisma.service.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        panelType: panel.type,
        username,
        status: "ACTIVE",
        volumeBytes: 100n * GIB,
        usedBytes: 0n,
      },
    });
  }

  it("XUI bulk: one listServiceAccounts call refreshes each row by username", async () => {
    const panel = await makePanel();
    const s1 = await makeService(panel, `bulk-a-${runTag}`);
    const s2 = await makeService(panel, `bulk-b-${runTag}`);
    let bulkCalls = 0;
    currentAdapter = {
      listServiceAccounts: async () => {
        bulkCalls += 1;
        return [
          { ok: true, username: s1.username, usedBytes: 42n * GIB, status: "active" },
          { ok: true, username: s2.username, usedBytes: 10n * GIB, status: "limited" },
        ];
      },
      getServiceAccount: async () => ({ ok: false }),
    };
    const r = await syncPanelServices({ redis }, panel.id);
    expect(bulkCalls).toBe(1); // ONE bulk call for the whole panel
    expect(r.synced).toBe(2);
    const a = await prisma.service.findUniqueOrThrow({ where: { id: s1.id } });
    expect(a.usedBytes).toBe(42n * GIB);
    expect(a.lastSubscriptionUpdateAt).not.toBeNull();
    const b = await prisma.service.findUniqueOrThrow({ where: { id: s2.id } });
    expect(b.status).toBe("LIMITED");
  });

  it("Marzban fallback: per-user getServiceAccount when no bulk method exists", async () => {
    const panel = await makePanel();
    const s1 = await makeService(panel, `peruser-a-${runTag}`);
    const calls: string[] = [];
    currentAdapter = {
      getServiceAccount: async ({ username }) => {
        calls.push(username);
        return { ok: true, username, usedBytes: 7n * GIB, status: "active" };
      },
    };
    const r = await syncPanelServices({ redis }, panel.id);
    expect(calls).toContain(s1.username);
    expect(r.synced).toBe(1);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: s1.id } })).usedBytes).toBe(7n * GIB);
  });

  it("never guesses: a failed bulk read leaves rows untouched and trips the breaker", async () => {
    const panel = await makePanel();
    const svc = await makeService(panel, `fail-${runTag}`);
    currentAdapter = {
      listServiceAccounts: async () => null, // read failure
      getServiceAccount: async () => ({ ok: false }),
    };
    const r = await syncPanelServices({ redis }, panel.id);
    expect(r.skipped).toBe("bulk-read-failed");
    // row untouched
    const row = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
    expect(row.usedBytes).toBe(0n);
    expect(row.lastSubscriptionUpdateAt).toBeNull();
    // breaker counter incremented
    expect(Number(await redis.get(panelBreakerKey(panel.id)))).toBeGreaterThanOrEqual(1);
  });

  it("circuit breaker opens after repeated failures and skips further syncs", async () => {
    const panel = await makePanel();
    await makeService(panel, `breaker-${runTag}`);
    currentAdapter = {
      listServiceAccounts: async () => null,
      getServiceAccount: async () => ({ ok: false }),
    };
    // Drive the failure counter to the threshold (default 5).
    for (let i = 0; i < 5; i += 1) {
      await syncPanelServices({ redis }, panel.id);
    }
    const r = await syncPanelServices({ redis }, panel.id);
    expect(r.skipped).toBe("breaker-open");
  });

  it("a healthy read clears the breaker (recovery)", async () => {
    const panel = await makePanel();
    const svc = await makeService(panel, `recover-${runTag}`);
    // Prime a couple of failures (below threshold).
    currentAdapter = { listServiceAccounts: async () => null, getServiceAccount: async () => ({ ok: false }) };
    await syncPanelServices({ redis }, panel.id);
    expect(Number(await redis.get(panelBreakerKey(panel.id)))).toBeGreaterThanOrEqual(1);
    // Now the panel answers -> breaker cleared.
    currentAdapter = {
      listServiceAccounts: async () => [{ ok: true, username: svc.username, usedBytes: 1n * GIB, status: "active" }],
      getServiceAccount: async () => ({ ok: false }),
    };
    const r = await syncPanelServices({ redis }, panel.id);
    expect(r.synced).toBe(1);
    expect(await redis.get(panelBreakerKey(panel.id))).toBeNull();
  });

  it("skips when another sync holds the per-panel lock", async () => {
    const panel = await makePanel();
    await makeService(panel, `locked-${runTag}`);
    currentAdapter = {
      listServiceAccounts: async () => [],
      getServiceAccount: async () => ({ ok: false }),
    };
    // Hold the lock elsewhere.
    await redis.set(panelSyncLockKey(panel.id), "held", "PX", 30_000, "NX");
    const r = await syncPanelServices({ redis }, panel.id);
    expect(r.skipped).toBe("lock-contended");
    await redis.del(panelSyncLockKey(panel.id));
  });
});
