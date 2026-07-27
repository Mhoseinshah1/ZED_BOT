import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { LogDeliveryStatus, prisma } from "@zedbot/database";
import { LOG_DELIVERY_JOB_NAME } from "@zedbot/shared";
import type { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-delivery-sweep-tests-secret";

import {
  LOG_DELIVERY_SENDING_STALE_MS,
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
  /**
   * How long ago the row was last written — the CLAIM time for a SENDING row.
   * Defaults to the row's own age, which is what an untouched row looks like.
   */
  claimedAgoMs?: number;
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
      updatedAt: new Date(Date.now() - (input.claimedAgoMs ?? input.ageMs)),
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

  // --- E1: abandoned SENDING claims ---------------------------------------
  //
  // SENDING is a CLAIM, not a resting state. The processor sets it, calls
  // Telegram once (hard-bounded by an AbortController at <= 60s) and writes a
  // terminal status. A row that sits in SENDING for ten minutes was abandoned
  // — the worker died, or Redis lost the job — and the database still says the
  // alert is owed while nothing is left to deliver it.

  // E1-1 -----------------------------------------------------------------
  it("E1-1: a RECENTLY claimed SENDING row is left alone", async () => {
    // Old row, claimed a second ago: exactly the delivery being processed
    // right now, which must not be handed to a second worker.
    const inFlight = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: 1_000,
    });
    // Just inside the threshold is still "recent".
    const nearlyStale = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS - 60_000,
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    expect(ids).not.toContain(inFlight);
    expect(ids).not.toContain(nearlyStale);
  });

  // E1-2 -----------------------------------------------------------------
  it("E1-2: a STALE SENDING row is re-enqueued, keyed on updatedAt not createdAt", async () => {
    const abandoned = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS + 60_000,
    });
    // A row CREATED long ago but claimed just now must still be spared — the
    // decision is about the claim, not the row's age.
    const freshlyClaimed = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: 5_000,
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    expect(ids).toContain(abandoned);
    expect(ids).not.toContain(freshlyClaimed);
  });

  // E1-3 -----------------------------------------------------------------
  it("E1-3: recovery uses the same deterministic job id, so it cannot double-queue", async () => {
    const abandoned = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS + 60_000,
    });
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const job = jobs.find((j) => (j.data as { deliveryId: string }).deliveryId === abandoned);
    expect(job?.opts.jobId).toBe(`logdel-${abandoned}`);
    expect(job?.name).toBe(LOG_DELIVERY_JOB_NAME);
  });

  // E1-4 -----------------------------------------------------------------
  it("E1-4: a terminal row is never swept, however long ago it was written", async () => {
    const seeded = await Promise.all(
      [LogDeliveryStatus.SENT, LogDeliveryStatus.DEAD_LETTER, LogDeliveryStatus.SKIPPED].map(
        (status) =>
          seedDelivery({
            status,
            ageMs: ANCIENT_MS,
            claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS * 100,
          }),
      ),
    );
    const { queue, jobs } = fakeQueue();

    await sweepOrphanedLogDeliveries(queue);

    const ids = sweptIds(jobs);
    for (const id of seeded) {
      expect(ids).not.toContain(id);
    }
  });

  // E1-5 / E1-6 ----------------------------------------------------------
  it("E1-5/6: a Redis failure leaves a stale SENDING row owed, and the next pass recovers it", async () => {
    const abandoned = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS + 60_000,
    });
    const broken = {
      add() {
        return Promise.reject(new Error("redis unavailable"));
      },
    } as unknown as Queue;

    // The pass runs on a timer; it must not throw.
    await expect(sweepOrphanedLogDeliveries(broken)).resolves.toBe(0);

    // The sweep never mutates the row — only the processor owns status.
    const row = await prisma.systemLogDelivery.findUnique({ where: { id: abandoned } });
    expect(row?.status).toBe(LogDeliveryStatus.SENDING);

    const { queue, jobs } = fakeQueue();
    await sweepOrphanedLogDeliveries(queue);
    expect(sweptIds(jobs)).toContain(abandoned);
  });

  // E1-7 -----------------------------------------------------------------
  it("E1-7: the sweep never talks to Telegram — recovery goes through the processor's claim", async () => {
    const abandoned = await seedDelivery({
      status: LogDeliveryStatus.SENDING,
      ageMs: ANCIENT_MS,
      claimedAgoMs: LOG_DELIVERY_SENDING_STALE_MS + 60_000,
    });
    let telegramCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      telegramCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const { queue, jobs } = fakeQueue();
      await sweepOrphanedLogDeliveries(queue);
      expect(sweptIds(jobs)).toContain(abandoned);
      // Recovery is "hand the id back to the queue" and nothing else.
      expect(telegramCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }

    // And the processor — not the sweep — is what claims work: its CAS accepts
    // SENDING precisely so an abandoned claim can be retried.
    const processorSource = await readFile(
      fileURLToPath(new URL("../../worker/src/log-delivery.ts", import.meta.url)),
      "utf8",
    );
    expect(processorSource).toMatch(/idempotency CAS/);
    expect(processorSource).toMatch(/LogDeliveryStatus\.SENDING,?\s*\]/);
    // The sweep itself contains no send path at all.
    const sweepSource = await readFile(
      fileURLToPath(new URL("../../worker/src/log-delivery-sweep.ts", import.meta.url)),
      "utf8",
    );
    expect(sweepSource).not.toMatch(/sendTelegramMessage|api\.telegram\.org/);
  });

  // E1-8 -----------------------------------------------------------------
  it("E1-8: the delivery guarantee is documented as at-least-once, never exactly-once", async () => {
    const sources = await Promise.all(
      [
        "../../worker/src/log-delivery-sweep.ts",
        "../../../docs/mandatory-channel-membership.md",
      ].map((rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8")),
    );
    for (const text of sources) {
      // Claiming exactly-once over a network we cannot transact with would be
      // false, and an operator debugging a duplicate alert would be misled.
      expect(text.toLowerCase()).not.toMatch(/exactly[- ]once/);
    }
    const [sweep, doc] = sources;
    expect(sweep).toMatch(/AT-LEAST-ONCE/);
    expect(doc.toLowerCase()).toMatch(/at-least-once/);
    // And the ambiguous window is named, not glossed over. Comment prefixes
    // and wrapping are stripped so the assertion is about the STATEMENT rather
    // than about where the line happens to break.
    const prose = (text: string): string =>
      text
        .replace(/^\s*(\/\/|\*)\s?/gm, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
    for (const text of [prose(sweep), prose(doc)]) {
      expect(text).toMatch(/before the `sent` status commits/);
    }
    // Both say plainly that one message per alert is not promised.
    expect(prose(sweep)).toMatch(/a single delivery per alert is not promised/);
    expect(prose(doc)).toMatch(/a single telegram message per alert is not promised/);
  });
});
