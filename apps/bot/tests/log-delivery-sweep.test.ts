import { LogDeliveryStatus, prisma } from "@zedbot/database";
import type { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-delivery-sweep-tests-secret";

import {
  LOG_DELIVERY_SWEEP_MIN_AGE_MS,
  sweepOrphanedLogDeliveries,
} from "../../worker/src/log-delivery-sweep.js";

// =============================================================================
// D1 (delivery half) — an operational alert is owed by the DATABASE ROW, not by
// the BullMQ job.
//
// A durable outbox row is only half a guarantee: something has to notice rows
// whose job was never created. That happens whenever the writer holds no queue
// (the API's force-join outbox), whenever a process dies between COMMIT and
// enqueue, and whenever Redis loses a delayed retry. The sweep closes all
// three, and the delivery id is the job id, so re-enqueuing something already
// queued is a no-op rather than a double send.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

/**
 * Fixtures are dated a decade back on purpose.
 *
 * The sweep is oldest-first and bounded per pass, which is the right production
 * behaviour — a backlog drains steadily instead of in one burst. It also means
 * a row's position in a pass depends on what else is owed, and the shared test
 * database accumulates PENDING rows from every other suite. Anchoring these
 * fixtures far in the past makes them the oldest rows in the table, so a pass
 * reaches them regardless of the neighbours.
 */
const ANCIENT_MS = 10 * 365 * 24 * 60 * 60 * 1000;

interface FakeJob {
  name: string;
  data: unknown;
  opts: { jobId?: string };
}

function fakeQueue(): { queue: Queue; jobs: FakeJob[] } {
  const jobs: FakeJob[] = [];
  const queue = {
    add(name: string, data: unknown, opts: { jobId?: string } = {}) {
      jobs.push({ name, data, opts });
      return Promise.resolve({ id: opts.jobId });
    },
  } as unknown as Queue;
  return { queue, jobs };
}

const createdLogIds: string[] = [];

/** One SystemLog + one delivery row in an arbitrary state and age. */
async function seedDelivery(input: {
  status: LogDeliveryStatus;
  ageMs: number;
  nextAttemptAt?: Date | null;
}): Promise<string> {
  const log = await prisma.systemLog.create({
    data: {
      level: "ERROR",
      eventType: `sweep-test.${runTag}`,
      message: "sweep fixture",
    },
    select: { id: true },
  });
  createdLogIds.push(log.id);
  const topic = await prisma.logTopic.upsert({
    where: { key: "SYSTEM" },
    update: {},
    create: { key: "SYSTEM", title: "System", isEnabled: true },
  });
  const delivery = await prisma.systemLogDelivery.create({
    data: {
      systemLogId: log.id,
      logTopicId: topic.id,
      status: input.status,
      nextAttemptAt: input.nextAttemptAt ?? null,
      createdAt: new Date(Date.now() - input.ageMs),
    },
    select: { id: true },
  });
  return delivery.id;
}

/** Only the ids this test seeded — the table is shared with everything else. */
function sweptIds(jobs: FakeJob[]): string[] {
  return jobs.map((j) => (j.data as { deliveryId: string }).deliveryId);
}

describe.runIf(hasDb)("orphaned log-delivery sweep", () => {
  beforeEach(async () => {
    await prisma.systemLogDelivery.deleteMany({
      where: { systemLog: { eventType: `sweep-test.${runTag}` } },
    });
  });

  afterAll(async () => {
    await prisma.systemLogDelivery.deleteMany({
      where: { systemLog: { eventType: `sweep-test.${runTag}` } },
    });
    await prisma.systemLog.deleteMany({ where: { eventType: `sweep-test.${runTag}` } });
    await prisma.$disconnect();
  });

  // D1-8 -----------------------------------------------------------------
  it("D1-8: re-enqueues a PENDING row whose job was never created, with the delivery id as the job id", async () => {
    const deliveryId = await seedDelivery({
      status: LogDeliveryStatus.PENDING,
      ageMs: ANCIENT_MS,
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    expect(sweptIds(jobs)).toContain(deliveryId);
    const job = jobs.find((j) => (j.data as { deliveryId: string }).deliveryId === deliveryId);
    // Deterministic job id — an already-queued delivery is deduped by BullMQ,
    // which is what makes running this next to the normal path safe.
    expect(job?.opts.jobId).toBe(`logdel-${deliveryId}`);
  });

  // D1-9 -----------------------------------------------------------------
  it("D1-9: leaves a freshly written PENDING row to its own writer", async () => {
    // Inside the grace window: the writer that just committed it is almost
    // certainly enqueuing it right now.
    const fresh = await seedDelivery({
      status: LogDeliveryStatus.PENDING,
      ageMs: Math.floor(LOG_DELIVERY_SWEEP_MIN_AGE_MS / 2),
    });
    // A positive control in the same pass, so "not swept" cannot be confused
    // with "the pass never got that far".
    const owed = await seedDelivery({ status: LogDeliveryStatus.PENDING, ageMs: ANCIENT_MS });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    expect(ids).toContain(owed);
    expect(ids).not.toContain(fresh);
  });

  // D1-10 ----------------------------------------------------------------
  it("D1-10: re-enqueues a FAILED row whose retry is due but not one still backing off", async () => {
    const due = await seedDelivery({
      status: LogDeliveryStatus.FAILED,
      ageMs: ANCIENT_MS,
      nextAttemptAt: new Date(Date.now() - 60_000),
    });
    const notDue = await seedDelivery({
      status: LogDeliveryStatus.FAILED,
      ageMs: ANCIENT_MS,
      nextAttemptAt: new Date(Date.now() + 10 * 60_000),
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    expect(ids).toContain(due);
    expect(ids).not.toContain(notDue);
  });

  // D1-11 ----------------------------------------------------------------
  it("D1-11: never re-enqueues a terminal delivery", async () => {
    const sent = await seedDelivery({
      status: LogDeliveryStatus.SENT,
      ageMs: ANCIENT_MS,
    });
    const dead = await seedDelivery({
      status: LogDeliveryStatus.DEAD_LETTER,
      ageMs: ANCIENT_MS,
    });
    const skipped = await seedDelivery({
      status: LogDeliveryStatus.SKIPPED,
      ageMs: ANCIENT_MS,
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    expect(ids).not.toContain(sent);
    expect(ids).not.toContain(dead);
    expect(ids).not.toContain(skipped);
  });

  // D1-12 ----------------------------------------------------------------
  it("D1-12: a Redis failure leaves the row owed instead of dropping the alert", async () => {
    const deliveryId = await seedDelivery({
      status: LogDeliveryStatus.PENDING,
      ageMs: ANCIENT_MS,
    });
    const broken = {
      add() {
        return Promise.reject(new Error("redis unavailable"));
      },
    } as unknown as Queue;

    // The pass itself must not throw — it runs on a timer.
    await expect(sweepOrphanedLogDeliveries(broken)).resolves.toBe(0);

    // Still PENDING, so the next pass picks it up again.
    const row = await prisma.systemLogDelivery.findUnique({ where: { id: deliveryId } });
    expect(row?.status).toBe(LogDeliveryStatus.PENDING);

    const { queue, jobs } = fakeQueue();
    await sweepOrphanedLogDeliveries(queue);
    expect(sweptIds(jobs)).toContain(deliveryId);
  });
});
