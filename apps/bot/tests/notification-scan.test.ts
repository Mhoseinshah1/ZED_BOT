import {
  prisma,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "notification-scan-tests-secret-0123456789";

import { runServiceNotificationScan } from "../../worker/src/notifications/scan.js";

// =============================================================================
// Notification SCAN against a real DB. Covers: globally-disabled default, rule
// gating, expiry/traffic/trial bucket creation, dedupe by expiry cycle + quota
// cycle (renewal / extra volume re-open a cycle), the freshness gate for
// panel-derived signals, per-service + user opt-out, and concurrent-scan
// idempotency (the dedupeKey unique makes a double scan create ONE row).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const KEYS = {
  master: "automated_notifications_enabled",
  expiry: "notification_rule_expiry_enabled",
  traffic: "notification_rule_traffic_enabled",
  trial: "notification_rule_trial_enabled",
};

async function setBool(key: string, on: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: on ? "true" : "false", type: "BOOLEAN" },
    update: { value: on ? "true" : "false" },
  });
}

function fakeQueue() {
  return { add: vi.fn(async () => undefined) } as never;
}

const GIB = 1024n * 1024n * 1024n;

d("notification scan", () => {
  let seq = 0;
  let panel: Panel;

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `ntf-scan-panel-${runTag}`, baseUrl: "https://panel.test", renewalEnabled: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Every rule ON by default in these tests except where a case turns them off.
    await Promise.all([
      setBool(KEYS.master, true),
      setBool(KEYS.expiry, true),
      setBool(KEYS.traffic, true),
      setBool(KEYS.trial, true),
    ]);
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
  }

  async function makeService(user: User, overrides: Partial<Service> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `ntf-scan-svc-${runTag}-${seq}`,
        status: "ACTIVE",
        volumeBytes: 100n * GIB,
        usedBytes: 0n,
        lastSubscriptionUpdateAt: new Date(),
        ...overrides,
      },
    });
  }

  async function notifsFor(serviceId: string) {
    return prisma.automatedNotification.findMany({ where: { serviceId } });
  }

  it("creates nothing while the system is globally disabled", async () => {
    await setBool(KEYS.master, false);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const r = await runServiceNotificationScan(fakeQueue());
    expect(r.skipped).toBe("system-disabled");
    expect(await notifsFor(service.id)).toHaveLength(0);
  });

  it("creates nothing when no rule is enabled", async () => {
    await Promise.all([setBool(KEYS.expiry, false), setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const r = await runServiceNotificationScan(fakeQueue());
    expect(r.skipped).toBe("no-rule-enabled");
    expect(await notifsFor(service.id)).toHaveLength(0);
  });

  it("creates ONE expiry notice and dedupes on re-scan within the same cycle", async () => {
    await Promise.all([setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await runServiceNotificationScan(fakeQueue());
    await runServiceNotificationScan(fakeQueue());
    const rows = await notifsFor(service.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("SERVICE_EXPIRY");
  });

  it("re-alerts after a renewal (new expiry cycle)", async () => {
    await Promise.all([setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await runServiceNotificationScan(fakeQueue());
    // Renew, then approach expiry again -> a distinct cycle -> a new row.
    await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 2 * 3600_000 + 30 * 24 * 3600_000) } });
    await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 1 * 3600_000) } });
    await runServiceNotificationScan(fakeQueue());
    expect((await notifsFor(service.id)).length).toBeGreaterThanOrEqual(2);
  });

  it("creates a traffic notice at 90% and dedupes; extra-volume re-opens the quota cycle", async () => {
    await Promise.all([setBool(KEYS.expiry, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { volumeBytes: 100n * GIB, usedBytes: 92n * GIB });
    await runServiceNotificationScan(fakeQueue());
    await runServiceNotificationScan(fakeQueue());
    let rows = (await notifsFor(service.id)).filter((r) => r.type === "SERVICE_TRAFFIC");
    expect(rows).toHaveLength(1);
    // Extra volume: raise the quota -> new quota cycle -> re-alert allowed.
    await prisma.service.update({ where: { id: service.id }, data: { volumeBytes: 200n * GIB, usedBytes: 185n * GIB } });
    await runServiceNotificationScan(fakeQueue());
    rows = (await notifsFor(service.id)).filter((r) => r.type === "SERVICE_TRAFFIC");
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("skips traffic on STALE service state (freshness gate)", async () => {
    await Promise.all([setBool(KEYS.expiry, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, {
      volumeBytes: 100n * GIB,
      usedBytes: 95n * GIB,
      lastSubscriptionUpdateAt: new Date(Date.now() - 60 * 60_000), // 1h old -> stale
    });
    await runServiceNotificationScan(fakeQueue());
    expect((await notifsFor(service.id)).filter((r) => r.type === "SERVICE_TRAFFIC")).toHaveLength(0);
  });

  it("creates a TRIAL_NEAR_EXPIRY for a fresh trial service", async () => {
    await Promise.all([setBool(KEYS.expiry, false), setBool(KEYS.traffic, false)]);
    const user = await makeUser();
    const service = await makeService(user, { source: "FREE_TRIAL", expiresAt: new Date(Date.now() + 9 * 60_000) });
    await runServiceNotificationScan(fakeQueue());
    const rows = await notifsFor(service.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("TRIAL_NEAR_EXPIRY");
  });

  it("respects the per-service expiry opt-out", async () => {
    await Promise.all([setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await prisma.serviceNotificationPreference.create({ data: { serviceId: service.id, expiryEnabled: false } });
    await runServiceNotificationScan(fakeQueue());
    expect(await notifsFor(service.id)).toHaveLength(0);
  });

  it("respects the user category opt-out", async () => {
    await Promise.all([setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser({ serviceNotificationsEnabled: false });
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await runServiceNotificationScan(fakeQueue());
    expect(await notifsFor(service.id)).toHaveLength(0);
  });

  it("two concurrent scans create exactly ONE row per (service, threshold, cycle)", async () => {
    await Promise.all([setBool(KEYS.traffic, false), setBool(KEYS.trial, false)]);
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await Promise.all([runServiceNotificationScan(fakeQueue()), runServiceNotificationScan(fakeQueue())]);
    expect((await notifsFor(service.id)).filter((r) => r.type === "SERVICE_EXPIRY")).toHaveLength(1);
  });
});
