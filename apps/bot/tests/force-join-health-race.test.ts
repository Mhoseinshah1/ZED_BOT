import { prisma } from "@zedbot/database";
import {
  FORCE_JOIN_OPS_EVENTS,
  FORCE_JOIN_ENABLED_KEY,
  FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
  FORCE_JOIN_HEALTH_MIN_WINDOW_MS,
  recordChannelHealthFailure,
  recordChannelHealthSuccess,
} from "@zedbot/force-join";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "force-join-health-race-secret";

// =============================================================================
// E2 — health SUCCESS and RETIREMENT must have one serial order.
//
// Both rewrite the same health fields, from different concurrent requests, and
// the failure mode is not "stale data" but a self-contradiction: the durable
// event says the channel was retired after five sustained failures, and the
// channel row says there was never a failure window. An operator reading the
// two together cannot tell which is true, and the retirement looks arbitrary.
//
// The success path now takes the SAME advisory lock every force-join
// configuration mutation takes, and updates only an ACTIVE row. That gives the
// pair exactly two possible outcomes, both coherent:
//
//   success first    → window cleared, retirement re-reads and declines
//   retirement first → row inactive, the stale success matches nothing
//
// These tests drive real concurrent PostgreSQL transactions rather than
// simulating the interleaving, because the property under test IS the locking.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

let chatSeq = 0n;
const runTag = BigInt(Date.now()) * 1000n;
function nextChatId(): bigint {
  chatSeq += 1n;
  return -(1_000_000_000_000n + runTag + chatSeq);
}

const created: string[] = [];

/** A channel one failure short of retirement, with a sustained window. */
async function seedNearlyRetired(): Promise<string> {
  const chatId = nextChatId();
  const username = `fjrace${(chatSeq + 1n).toString()}`;
  const row = await prisma.forceJoinChannel.create({
    data: {
      chatId,
      title: `Race ${username}`,
      joinUrl: `https://t.me/${username}`,
      normalizedLink: `https://t.me/${username}`,
      isPrivate: false,
      publicUsername: username,
      isActive: true,
      sortOrder: 1,
      healthFailureCount: FORCE_JOIN_HEALTH_FAILURE_THRESHOLD - 1,
      healthFailureFirstAt: new Date(Date.now() - (FORCE_JOIN_HEALTH_MIN_WINDOW_MS + 60_000)),
      // Older than the write-debounce so the next failure counts immediately.
      healthFailureLastAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  created.push(row.id);
  return row.id;
}

function eventsForChannel(channelId: string) {
  return prisma.systemLog.findMany({
    where: { metadata: { path: ["channelId"], equals: channelId } },
    orderBy: { createdAt: "asc" },
  });
}

async function cleanup(channelId: string): Promise<void> {
  const logs = await prisma.systemLog.findMany({
    where: { metadata: { path: ["channelId"], equals: channelId } },
    select: { id: true },
  });
  const ids = logs.map((l) => l.id);
  if (ids.length > 0) {
    await prisma.systemLogDelivery.deleteMany({ where: { systemLogId: { in: ids } } });
    await prisma.systemLog.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.forceJoinChannel.deleteMany({ where: { id: channelId } });
}

describe.runIf(hasDb)("force join — health success vs retirement", () => {
  beforeEach(async () => {
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
  });

  afterAll(async () => {
    for (const id of created) {
      await cleanup(id);
    }
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    await prisma.$disconnect();
  });

  // E2-1 -----------------------------------------------------------------
  it("E2-1: success first — the cleared window makes the retirement decline", async () => {
    const channelId = await seedNearlyRetired();

    // The success commits FIRST, then the failure runs. Because retirement
    // takes the lock before reading, it sees the cleared counters.
    await recordChannelHealthSuccess(channelId);
    const outcome = await recordChannelHealthFailure(channelId, "UNVERIFIABLE");

    // A channel that just answered correctly is not retired for old failures.
    expect(outcome).toEqual({ action: "COUNTED", count: 1 });
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
    expect(row?.isActive).toBe(true);
    expect(row?.unhealthyAt).toBeNull();
    // …and no retirement was announced.
    const events = await eventsForChannel(channelId);
    expect(events.map((e) => e.eventType)).not.toContain(
      FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
  });

  // E2-2 / E2-3 ----------------------------------------------------------
  it("E2-2/3: retirement first — a stale success cannot erase the retirement metadata", async () => {
    const channelId = await seedNearlyRetired();

    const outcome = await recordChannelHealthFailure(channelId, "UNVERIFIABLE");
    expect(outcome.action).toBe("RETIRED");
    const retired = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
    expect(retired?.isActive).toBe(false);
    expect(retired?.unhealthyAt).not.toBeNull();

    // The success was already in flight when the retirement committed; it
    // resumes now and must find nothing to update.
    await recordChannelHealthSuccess(channelId);

    const after = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
    expect(after?.isActive).toBe(false);
    expect(after?.unhealthyAt).toEqual(retired?.unhealthyAt);
    expect(after?.healthFailureCount).toBe(retired?.healthFailureCount);
    expect(after?.healthFailureCount).toBeGreaterThanOrEqual(
      FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
    );
    expect(after?.healthFailureFirstAt).toEqual(retired?.healthFailureFirstAt);
    expect(after?.healthFailureLastAt).toEqual(retired?.healthFailureLastAt);
  });

  // E2-4 -----------------------------------------------------------------
  it("E2-4: the durable event stays consistent with the channel row", async () => {
    const channelId = await seedNearlyRetired();
    await recordChannelHealthFailure(channelId, "UNVERIFIABLE");
    await recordChannelHealthSuccess(channelId);

    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
    const retirement = (await eventsForChannel(channelId)).find(
      (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
    expect(retirement).toBeDefined();

    // The event says "retired after a sustained failure window". The row must
    // still corroborate that, which is exactly what the stale success would
    // have destroyed.
    const metadata = retirement?.metadata as { thresholdFailures: number } | null;
    expect(row?.isActive).toBe(false);
    expect(row?.healthFailureCount).toBeGreaterThanOrEqual(metadata?.thresholdFailures ?? 0);
    expect(row?.healthFailureFirstAt).not.toBeNull();
    expect(row?.unhealthyAt).not.toBeNull();
  });

  // E2-5 -----------------------------------------------------------------
  it("E2-5: a retired channel produces no second retirement event and is never reactivated", async () => {
    const channelId = await seedNearlyRetired();
    await recordChannelHealthFailure(channelId, "UNVERIFIABLE");

    // Whatever order these arrive in, the channel is already inactive.
    for (let i = 0; i < 3; i += 1) {
      await recordChannelHealthSuccess(channelId);
      expect(await recordChannelHealthFailure(channelId, "UNVERIFIABLE")).toEqual({
        action: "NOOP",
      });
    }

    const events = await eventsForChannel(channelId);
    expect(
      events.filter((e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED),
    ).toHaveLength(1);
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
    // Recovery is an OPERATOR action, never a side effect of a health check.
    expect(row?.isActive).toBe(false);
  });

  // E2-6 -----------------------------------------------------------------
  it("E2-6: genuinely concurrent success and retirement land on one of the two coherent outcomes", async () => {
    // Both orderings are legitimate; what must never happen is the third
    // outcome — retired row, cleared window. Fired together so the advisory
    // lock, not the test, picks the winner.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const channelId = await seedNearlyRetired();
      const [, outcome] = await Promise.all([
        recordChannelHealthSuccess(channelId),
        recordChannelHealthFailure(channelId, "UNVERIFIABLE"),
      ]);

      const row = await prisma.forceJoinChannel.findUnique({ where: { id: channelId } });
      const retirements = (await eventsForChannel(channelId)).filter(
        (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
      );

      if (outcome.action === "RETIRED") {
        // Retirement won: its metadata must be intact and announced once.
        expect(row?.isActive, `attempt ${attempt}`).toBe(false);
        expect(row?.unhealthyAt, `attempt ${attempt}`).not.toBeNull();
        expect(row?.healthFailureCount, `attempt ${attempt}`).toBeGreaterThanOrEqual(
          FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
        );
        expect(retirements, `attempt ${attempt}`).toHaveLength(1);
      } else {
        // Success won: the channel stays active and nothing was announced.
        expect(row?.isActive, `attempt ${attempt}`).toBe(true);
        expect(row?.unhealthyAt, `attempt ${attempt}`).toBeNull();
        expect(retirements, `attempt ${attempt}`).toHaveLength(0);
      }
    }
  });
});
