import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  prisma,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { NOTIFICATION_JOB_NAMES, type NotificationPayloadSnapshot } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "notification-delivery-tests-secret-0123456789";
process.env.BOT_TOKEN = "111222:delivery-test-token";

import { createNotificationDeliveryProcessor } from "../../worker/src/notifications/delivery.js";
import { planExpiry, type RulePanelState, type RuleServiceState } from "../../worker/src/notifications/rules.js";

// =============================================================================
// Automated-notification delivery lifecycle (real DB, fake Telegram via a fetch
// stub). Covers the completion gates: persisted-before-send, CAS at-most-once,
// preference + source re-validation (stale cancellation), quiet hours, daily
// cap, retry/dead-letter, Telegram 429 + network failure, and no-secret-leak.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const NOTIF_ENABLED_KEY = "automated_notifications_enabled";

const ACTIVE_PANEL: RulePanelState = { status: "ACTIVE", renewalEnabled: true };

interface FakeQueue {
  rateLimit: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
}

function fakeQueue(): FakeQueue {
  return { rateLimit: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), add: vi.fn(async () => undefined) };
}

interface FakeJob {
  name: string;
  data: { notificationId: string };
  opts: { attempts: number };
  attemptsMade: number;
}

function deliverJob(notificationId: string, attemptsMade = 0, attempts = 5): FakeJob {
  return { name: NOTIFICATION_JOB_NAMES.DELIVER_AUTOMATED_NOTIFICATION, data: { notificationId }, opts: { attempts }, attemptsMade };
}

/** Records every Telegram sendMessage body; scriptable response per call. */
let sentBodies: Array<Record<string, unknown>>;
let fetchMode: "ok" | "429" | "network" | "forbidden" | "server-error";

function installFetchStub(): void {
  sentBodies = [];
  fetchMode = "ok";
  global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    sentBodies.push(body);
    if (fetchMode === "network") {
      throw new Error("socket hang up");
    }
    if (fetchMode === "429") {
      return { ok: false, status: 429, json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }) } as unknown as Response;
    }
    if (fetchMode === "forbidden") {
      return { ok: false, status: 403, json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }) } as unknown as Response;
    }
    if (fetchMode === "server-error") {
      return { ok: false, status: 500, json: async () => ({ ok: false, description: "Internal Server Error" }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function setEnabled(on: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: NOTIF_ENABLED_KEY },
    create: { key: NOTIF_ENABLED_KEY, value: on ? "true" : "false", type: "BOOLEAN" },
    update: { value: on ? "true" : "false" },
  });
}

d("automated notification delivery", () => {
  let seq = 0;
  let panel: Panel;
  const processor = createNotificationDeliveryProcessor({ deliveryQueue: fakeQueue() as never });

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `ntf-del-panel-${runTag}`, baseUrl: "https://panel.test", renewalEnabled: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    installFetchStub();
    await setEnabled(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), ...overrides },
    });
  }

  async function makeService(user: User, overrides: Partial<Service> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `ntf-del-svc-${runTag}-${seq}`,
        status: "ACTIVE",
        volumeBytes: 100n,
        usedBytes: 0n,
        ...overrides,
      },
    });
  }

  function ruleService(service: Service): RuleServiceState {
    return {
      id: service.id,
      username: service.username,
      note: service.note,
      productNameSnapshot: service.productNameSnapshot,
      status: service.status,
      volumeBytes: service.volumeBytes,
      usedBytes: service.usedBytes,
      expiresAt: service.expiresAt,
    };
  }

  /** Persists a SCHEDULED expiry notification from the real rule plan. */
  async function scheduleExpiry(user: User, service: Service, now = new Date()): Promise<string> {
    const plan = planExpiry(ruleService(service), ACTIVE_PANEL, [{ key: "3h", minutesBefore: 180 }, { key: "expired", minutesBefore: null }], now, false);
    if (plan === null) {
      throw new Error("expected a plan");
    }
    const row = await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY",
        category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: user.id,
        serviceId: service.id,
        dedupeKey: `${plan.dedupeKey}:${seq}`,
        scheduledFor: now,
        availableUntil: plan.availableUntil,
        payloadSnapshot: plan.payload as unknown as object,
      },
      select: { id: true },
    });
    return row.id;
  }

  it("sends a scheduled notification and marks it SENT exactly once", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);

    const r1 = await processor(deliverJob(id) as never);
    expect(r1).toMatchObject({ sent: true });
    expect(sentBodies).toHaveLength(1);
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.SENT);
    expect(row.telegramMessageId).toBe(4242);

    // Idempotent: a duplicate delivery job never re-sends.
    const r2 = await processor(deliverJob(id) as never);
    expect(r2).toMatchObject({ skipped: "already-terminal" });
    expect(sentBodies).toHaveLength(1);
  });

  it("is globally disabled by default: a scheduled notice is CANCELLED, never sent", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    await setEnabled(false);
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ cancelled: "system-disabled" });
    expect(sentBodies).toHaveLength(0);
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.CANCELLED);
  });

  it("cancels when the user opted out of the category", async () => {
    const user = await makeUser({ serviceNotificationsEnabled: false });
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ cancelled: "user-opted-out" });
    expect(sentBodies).toHaveLength(0);
  });

  it("cancels a stale expiry notice after the service was renewed (cycle changed)", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    // Renew: push expiry far out -> the expiry cycle fingerprint no longer matches.
    await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 40 * 24 * 3600_000) } });
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ cancelled: "source-stale" });
    expect(sentBodies).toHaveLength(0);
  });

  it("cancels when the per-service preference disabled expiry notices", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    await prisma.serviceNotificationPreference.create({ data: { serviceId: service.id, expiryEnabled: false } });
    const id = await scheduleExpiry(user, service);
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ cancelled: "service-opted-out" });
    expect(sentBodies).toHaveLength(0);
  });

  it("defers inside the user's quiet hours (no send, rescheduled)", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    // A window that covers ~all day so 'now' is inside it regardless of tz.
    await prisma.notificationPreference.create({
      data: { userId: user.id, quietHoursEnabled: true, quietHoursStartMinutes: 0, quietHoursEndMinutes: 1439 },
    });
    const id = await scheduleExpiry(user, service);
    // A long availability window so the notice OUTLASTS the quiet window and
    // is deferred (not suppressed as unusable).
    await prisma.automatedNotification.update({ where: { id }, data: { availableUntil: new Date(Date.now() + 3 * 24 * 3600_000) } });
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ deferred: "quiet-hours" });
    expect(sentBodies).toHaveLength(0);
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.SCHEDULED);
    expect(row.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });

  it("defers once the daily cap is reached", async () => {
    const user = await makeUser();
    await prisma.notificationPreference.create({ data: { userId: user.id, dailyAutomatedLimit: 1 } });
    // one already SENT today
    const svc1 = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const first = await scheduleExpiry(user, svc1);
    expect(await processor(deliverJob(first) as never)).toMatchObject({ sent: true });

    const svc2 = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const second = await scheduleExpiry(user, svc2);
    // A long window so the capped notice waits for tomorrow (deferred, not dropped).
    await prisma.automatedNotification.update({ where: { id: second }, data: { availableUntil: new Date(Date.now() + 3 * 24 * 3600_000) } });
    const r = await processor(deliverJob(second) as never);
    expect(r).toMatchObject({ deferred: "daily-limit" });
    expect(sentBodies).toHaveLength(1); // only the first went out
  });

  it("handles Telegram 429 by rate-limiting the queue and not consuming an attempt", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    const queue = fakeQueue();
    const proc = createNotificationDeliveryProcessor({ deliveryQueue: queue as never });
    fetchMode = "429";
    await expect(proc(deliverJob(id) as never)).rejects.toThrow();
    expect(queue.rateLimit).toHaveBeenCalledOnce();
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.SCHEDULED); // rolled back for retry
  });

  it("marks FAILED then re-throws on a transient network failure (BullMQ retries)", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    fetchMode = "network";
    await expect(processor(deliverJob(id, 0, 5) as never)).rejects.toThrow();
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.FAILED);
    expect(row.safeErrorCode).toBe("network-error");
    expect(row.attempts).toBe(1);
  });

  it("dead-letters on the final attempt", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    fetchMode = "server-error";
    const r = await processor(deliverJob(id, 4, 5) as never); // final attempt
    expect(r).toMatchObject({ deadLetter: expect.anything() });
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.DEAD_LETTER);
  });

  it("dead-letters immediately on a permanent rejection (forbidden)", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    fetchMode = "forbidden";
    const r = await processor(deliverJob(id, 0, 5) as never);
    expect(r).toMatchObject({ deadLetter: "forbidden" });
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(AutomatedNotificationStatus.DEAD_LETTER);
  });

  it("never leaks a subscription token/url into the message or the stored snapshot", async () => {
    const secretToken = "SEC-TOKEN-abcdef0123456789";
    const secretUrl = "https://panel.test/sub/abcdef0123456789";
    const user = await makeUser();
    const service = await makeService(user, {
      expiresAt: new Date(Date.now() + 2 * 3600_000),
      subscriptionToken: secretToken,
      subscriptionUrl: secretUrl,
      note: "پلن من",
    });
    const id = await scheduleExpiry(user, service);
    await processor(deliverJob(id) as never);
    const sentText = JSON.stringify(sentBodies[0]);
    expect(sentText).not.toContain(secretToken);
    expect(sentText).not.toContain(secretUrl);
    const row = await prisma.automatedNotification.findUniqueOrThrow({ where: { id } });
    const snap = JSON.stringify(row.payloadSnapshot as NotificationPayloadSnapshot);
    expect(snap).not.toContain(secretToken);
    expect(snap).not.toContain(secretUrl);
  });

  it("expires a notification whose availability window has passed", async () => {
    const user = await makeUser();
    const service = await makeService(user, { expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const id = await scheduleExpiry(user, service);
    await prisma.automatedNotification.update({ where: { id }, data: { availableUntil: new Date(Date.now() - 1000) } });
    const r = await processor(deliverJob(id) as never);
    expect(r).toMatchObject({ expired: true });
    expect(sentBodies).toHaveLength(0);
  });
});
