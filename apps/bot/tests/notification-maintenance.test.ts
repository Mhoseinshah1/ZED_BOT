import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  prisma,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "notification-maintenance-tests-secret-0123456789";

import {
  runNotificationCleanup,
  runNotificationReconcile,
} from "../../worker/src/notifications/maintenance.js";

// =============================================================================
// Notification maintenance: reconcile re-arms due SCHEDULED rows and rescues
// crash-orphaned SENDING rows (the worker-restart durability net), and cleanup
// prunes terminal history past retention while never touching in-flight rows.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

function fakeQueue() {
  return { add: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
}

d("notification maintenance", () => {
  let seq = 0;
  let user: User;

  beforeAll(async () => {
    user = await prisma.user.create({ data: { telegramId: runTag } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeNotification(
    status: AutomatedNotificationStatus,
    fields: { scheduledFor?: Date; claimedAt?: Date; updatedAt?: Date } = {},
  ): Promise<string> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY",
        category: AutomatedNotificationCategory.SERVICE,
        status,
        userId: user.id,
        dedupeKey: `maint-${runTag}-${seq}`,
        scheduledFor: fields.scheduledFor ?? new Date(),
        claimedAt: fields.claimedAt,
        payloadSnapshot: { templateKey: "notif_service_expiry", variables: {}, buttons: [] },
      },
      select: { id: true },
    });
    if (fields.updatedAt !== undefined) {
      // updatedAt is @updatedAt; force it via raw SQL for the cleanup window test.
      await prisma.$executeRaw`UPDATE "AutomatedNotification" SET "updatedAt" = ${fields.updatedAt} WHERE id = ${row.id}`;
    }
    return row.id;
  }

  it("reconcile re-enqueues a due SCHEDULED notification", async () => {
    const id = await makeNotification(AutomatedNotificationStatus.SCHEDULED, {
      scheduledFor: new Date(Date.now() - 60_000),
    });
    const queue = fakeQueue();
    const r = await runNotificationReconcile(queue as never);
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect(queue.add).toHaveBeenCalled();
    // still SCHEDULED (delivery will claim it)
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id } })).status).toBe(
      AutomatedNotificationStatus.SCHEDULED,
    );
  });

  it("does NOT re-enqueue a not-yet-due SCHEDULED notification", async () => {
    const id = await makeNotification(AutomatedNotificationStatus.SCHEDULED, {
      scheduledFor: new Date(Date.now() + 60 * 60_000),
    });
    const queue = fakeQueue();
    await runNotificationReconcile(queue as never);
    const calls = (queue.add.mock.calls as unknown[][]).flat();
    expect(JSON.stringify(calls)).not.toContain(id.slice(0, 8));
  });

  it("reconcile rescues a crash-orphaned SENDING row (claimed long ago)", async () => {
    const id = await makeNotification(AutomatedNotificationStatus.SENDING, {
      claimedAt: new Date(Date.now() - 30 * 60_000), // 30m ago -> orphan
    });
    const r = await runNotificationReconcile(fakeQueue() as never);
    expect(r.orphansRecovered).toBeGreaterThanOrEqual(1);
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id } })).status).toBe(
      AutomatedNotificationStatus.SCHEDULED,
    );
  });

  it("reconcile leaves a freshly-claimed SENDING row alone", async () => {
    const id = await makeNotification(AutomatedNotificationStatus.SENDING, {
      claimedAt: new Date(), // just now
    });
    await runNotificationReconcile(fakeQueue() as never);
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id } })).status).toBe(
      AutomatedNotificationStatus.SENDING,
    );
  });

  it("cleanup prunes old terminal rows but never in-flight ones", async () => {
    const oldSent = await makeNotification(AutomatedNotificationStatus.SENT, {
      updatedAt: new Date(Date.now() - 200 * 24 * 3600_000), // 200d old
    });
    const recentSent = await makeNotification(AutomatedNotificationStatus.SENT, {
      updatedAt: new Date(),
    });
    const scheduled = await makeNotification(AutomatedNotificationStatus.SCHEDULED, {
      updatedAt: new Date(Date.now() - 200 * 24 * 3600_000),
    });
    await runNotificationCleanup();
    expect(await prisma.automatedNotification.findUnique({ where: { id: oldSent } })).toBeNull();
    expect(await prisma.automatedNotification.findUnique({ where: { id: recentSent } })).not.toBeNull();
    // A SCHEDULED row is in-flight and must survive regardless of age.
    expect(await prisma.automatedNotification.findUnique({ where: { id: scheduled } })).not.toBeNull();
  });
});
