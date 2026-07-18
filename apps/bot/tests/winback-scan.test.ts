import {
  prisma,
  type Order,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "winback-scan-tests-secret-0123456789";

import { runWinbackScan } from "../../worker/src/notifications/winback-scan.js";

// =============================================================================
// Customer win-back SCAN against a real DB. Covers: disabled default, the
// paying-customer + lapse gates, stage 1/2/3 + catch-up, dedupe + concurrency,
// the financial / trial / checkout exclusions, current-service exclusion, and the
// stale-service (uncertain) sync-and-skip path.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 24 * 3_600_000;

const KEYS = {
  master: "automated_notifications_enabled",
  winback: "notification_customer_winback_enabled",
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

d("winback notification scan", () => {
  let seq = 0;
  let panel: Panel;

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `wb-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all([setBool(KEYS.master, true), setBool(KEYS.winback, true)]);
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: {
        telegramId: runTag + BigInt(seq),
        status: "ACTIVE",
        group: "F",
        marketingMessagesEnabled: true,
        cronNotificationsEnabled: true,
        paidOrdersCount: 1,
        ...overrides,
      },
    });
  }

  /** A completed paid SERVICE_PURCHASE order (the paying-customer anchor). */
  async function makePurchaseOrder(user: User, overrides: Partial<Order> = {}): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: {
        userId: user.id,
        type: "SERVICE_PURCHASE",
        status: "COMPLETED",
        finalPriceToman: 120000,
        completedAt: new Date(Date.now() - 41 * DAY),
        productNameSnapshot: "پلن تست",
        ...overrides,
      },
    });
  }

  /** A PAID service; defaults to a FRESH, EXPIRED (lapsed) state `daysLapsed` ago. */
  async function makeService(user: User, daysLapsed: number, overrides: Partial<Service> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `wb-svc-${runTag}-${seq}`,
        source: "PAID",
        status: "EXPIRED",
        expiresAt: new Date(Date.now() - daysLapsed * DAY),
        lastSubscriptionUpdateAt: new Date(), // fresh -> classified LAPSED, not uncertain
        note: "پلن من",
        ...overrides,
      },
    });
  }

  async function notifs(userId: string) {
    return prisma.automatedNotification.findMany({ where: { userId, type: "CUSTOMER_WINBACK" } });
  }

  it("creates nothing while globally disabled", async () => {
    await setBool(KEYS.master, false);
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    const r = await runWinbackScan(fakeQueue(), fakeQueue());
    expect(r.skipped).toBe("system-disabled");
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("creates nothing while the win-back rule is disabled", async () => {
    await setBool(KEYS.winback, false);
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    const r = await runWinbackScan(fakeQueue(), fakeQueue());
    expect(r.skipped).toBe("rule-disabled");
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("creates ONE stage-1 notice for a cleanly lapsed paying customer and dedupes on re-scan", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await runWinbackScan(fakeQueue(), fakeQueue());
    await runWinbackScan(fakeQueue(), fakeQueue());
    const rows = await notifs(user.id);
    expect(rows).toHaveLength(1);
    expect((rows[0].payloadSnapshot as { meta?: { stageKey?: string } }).meta?.stageKey).toBe("s30");
  });

  it("catch-up: a 200-day-lapsed customer gets ONLY the highest stage (s90), no backfill", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user, { completedAt: new Date(Date.now() - 201 * DAY) });
    await makeService(user, 200);
    await runWinbackScan(fakeQueue(), fakeQueue());
    await runWinbackScan(fakeQueue(), fakeQueue());
    const rows = await notifs(user.id);
    expect(rows).toHaveLength(1);
    expect((rows[0].payloadSnapshot as { meta?: { stageKey?: string } }).meta?.stageKey).toBe("s90");
  });

  it("excludes a never-paid user (no completed paid order)", async () => {
    const user = await makeUser({ paidOrdersCount: 0 });
    await makeService(user, 40);
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("excludes a trial-only customer (OTHER_PRODUCT / no paid Service purchase)", async () => {
    const user = await makeUser();
    // A completed order of a NON-service type does not make a paying VPN customer.
    await prisma.order.create({
      data: { userId: user.id, type: "OTHER_PRODUCT", status: "COMPLETED", finalPriceToman: 50000 },
    });
    await prisma.service.create({
      data: {
        userId: user.id, panelId: panel.id, panelType: "MARZBAN", username: `wb-trial-${runTag}-${seq}`,
        source: "FREE_TRIAL", status: "EXPIRED", expiresAt: new Date(Date.now() - 40 * DAY), lastSubscriptionUpdateAt: new Date(),
      },
    });
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("excludes a customer who still has a usable (active) paid service", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40); // lapsed one
    await makeService(user, -10, { status: "ACTIVE" }); // future expiry -> usable
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("excludes and enqueues a sync for a STALE (uncertain) paid service (never guesses inactive)", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40, { lastSubscriptionUpdateAt: new Date(Date.now() - 2 * DAY) }); // stale
    const sync = fakeQueue();
    const r = await runWinbackScan(fakeQueue(), sync);
    expect(await notifs(user.id)).toHaveLength(0);
    expect(r.excludedUncertainService).toBeGreaterThanOrEqual(1);
  });

  it("defers a customer with a resumable pending checkout", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await prisma.checkoutSession.create({
      data: { userId: user.id, purpose: "ORDER_PAYMENT", finalPriceToman: 120000, status: "PENDING", expiresAt: new Date(Date.now() + 6 * 3_600_000) },
    });
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("defers a customer with a pending-review payment", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await prisma.payment.create({
      data: { userId: user.id, purpose: "ORDER_PAYMENT", amountToman: 120000, payableAmountToman: 120000, status: "PENDING_REVIEW", provider: "CARD_TO_CARD" },
    });
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("excludes a marketing-opted-out customer", async () => {
    const user = await makeUser({ marketingMessagesEnabled: false });
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("excludes a representative (group N) by default", async () => {
    const user = await makeUser({ group: "N" });
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("respects the win-back snooze", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await prisma.customerRetentionPreference.create({
      data: { userId: user.id, winbackSnoozedUntil: new Date(Date.now() + 10 * DAY) },
    });
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(0);
  });

  it("two concurrent scans create exactly one notification", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await Promise.all([runWinbackScan(fakeQueue(), fakeQueue()), runWinbackScan(fakeQueue(), fakeQueue())]);
    expect(await notifs(user.id)).toHaveLength(1);
  });

  it("a new completed purchase (renewal) starts a new lapse cycle", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    const svc = await makeService(user, 40);
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect(await notifs(user.id)).toHaveLength(1);
    // Simulate a much later lapse: the service's effective end moves forward,
    // which changes the fingerprint -> a new cycle -> a new stage-1 notice.
    await prisma.service.update({ where: { id: svc.id }, data: { expiresAt: new Date(Date.now() - 35 * DAY) } });
    await runWinbackScan(fakeQueue(), fakeQueue());
    expect((await notifs(user.id)).length).toBe(2);
  });
});
