import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { LogDeliveryStatus, prisma } from "@zedbot/database";
import {
  FORCE_JOIN_OPS_EVENTS,
  FORCE_JOIN_ENABLED_KEY,
  FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
  FORCE_JOIN_HEALTH_MIN_WINDOW_MS,
  recordChannelHealthFailure,
} from "@zedbot/force-join";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "force-join-durable-alerts-secret";

// =============================================================================
// D1 — the automatic Force Join configuration alert must be DURABLE and
// PROCESS-INDEPENDENT.
//
// The unhealthy-channel policy is reachable from the API as well as the bot.
// The API runs no BullMQ connection and installs no alert sink, so an alert
// emitted *after* the mutation by whoever happens to have installed one is
// exactly missing in the case that matters most: an API request quietly
// deactivating a required channel, or switching mandatory membership off for
// the entire platform.
//
// These tests import the SHARED package directly and never install a sink —
// that is precisely the API's runtime shape. Everything asserted below must
// hold with no sink, no queue and no Telegram.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const LOG_GROUP_CHAT_ID_KEY = "log_group_chat_id";

let chatSeq = 0n;
const runTag = BigInt(Date.now()) * 1000n;
function nextChatId(): bigint {
  chatSeq += 1n;
  return -(1_000_000_000_000n + runTag + chatSeq);
}

/** A channel already one failure short of retirement, with a sustained window. */
async function seedNearlyRetiredChannel(options?: {
  isPrivate?: boolean;
  joinUrl?: string;
  publicUsername?: string | null;
}): Promise<{ id: string; chatId: bigint }> {
  const chatId = nextChatId();
  const username = `fjdur${(chatSeq + 1n).toString()}`;
  const firstAt = new Date(Date.now() - (FORCE_JOIN_HEALTH_MIN_WINDOW_MS + 60_000));
  const row = await prisma.forceJoinChannel.create({
    data: {
      chatId,
      title: `Durable ${username}`,
      joinUrl: options?.joinUrl ?? `https://t.me/${username}`,
      normalizedLink: options?.joinUrl ?? `https://t.me/${username}`,
      isPrivate: options?.isPrivate ?? false,
      publicUsername: options?.publicUsername === undefined ? username : options.publicUsername,
      isActive: true,
      sortOrder: 1,
      healthFailureCount: FORCE_JOIN_HEALTH_FAILURE_THRESHOLD - 1,
      healthFailureFirstAt: firstAt,
      // Older than the write-debounce so the next failure counts immediately.
      healthFailureLastAt: new Date(Date.now() - 60_000),
    },
  });
  return { id: row.id, chatId };
}

/** Every durable event recorded for one channel, oldest first. */
function eventsForChannel(channelId: string) {
  return prisma.systemLog.findMany({
    where: { metadata: { path: ["channelId"], equals: channelId } },
    orderBy: { createdAt: "asc" },
  });
}

async function cleanupChannel(channelId: string): Promise<void> {
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

describe.runIf(hasDb)("force join — durable cross-process configuration alerts", () => {
  const created: string[] = [];

  beforeEach(async () => {
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
  });

  afterAll(async () => {
    for (const id of created) {
      await cleanupChannel(id);
    }
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    await prisma.$disconnect();
  });

  // D1-1 -----------------------------------------------------------------
  it("D1-1: an API-shaped retirement (no sink, no queue) still records exactly one durable retirement event", async () => {
    const channel = await seedNearlyRetiredChannel();
    created.push(channel.id);

    const outcome = await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "RETIRED", forceJoinDisabled: false });

    const events = await eventsForChannel(channel.id);
    const retirements = events.filter(
      (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
    expect(retirements).toHaveLength(1);
    expect(retirements[0].level).toBe("ERROR");
    // The mutation and its record are inseparable: the row really is retired.
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channel.id } });
    expect(row?.isActive).toBe(false);
  });

  // D1-2 -----------------------------------------------------------------
  it("D1-2: retiring the last active channel records a SECOND event for the master-switch disablement", async () => {
    await prisma.setting.upsert({
      where: { key: FORCE_JOIN_ENABLED_KEY },
      update: { value: "true", type: "BOOLEAN" },
      create: { key: FORCE_JOIN_ENABLED_KEY, value: "true", type: "BOOLEAN" },
    });
    const channel = await seedNearlyRetiredChannel();
    created.push(channel.id);

    const outcome = await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "RETIRED", forceJoinDisabled: true });

    const events = await eventsForChannel(channel.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain(FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED);
    expect(types).toContain(FORCE_JOIN_OPS_EVENTS.AUTO_DISABLED);
    expect(
      types.filter((t) => t === FORCE_JOIN_OPS_EVENTS.AUTO_DISABLED),
    ).toHaveLength(1);

    // The switch really is off, in the same transaction that recorded it.
    const setting = await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    expect(setting?.value).toBe("false");
  });

  // D1-3 -----------------------------------------------------------------
  it("D1-3: repeated failures after retirement produce no duplicate alerts", async () => {
    const channel = await seedNearlyRetiredChannel();
    created.push(channel.id);

    await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");
    for (let i = 0; i < 4; i += 1) {
      const again = await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");
      // Already inactive: the branch that writes the event is never reached.
      expect(again).toEqual({ action: "NOOP" });
    }

    const events = await eventsForChannel(channel.id);
    expect(
      events.filter((e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED),
    ).toHaveLength(1);
  });

  // D1-4 -----------------------------------------------------------------
  it("D1-4: the event and its PENDING delivery are committed with the mutation, so a crash right after commit loses nothing", async () => {
    const topic = await prisma.logTopic.upsert({
      where: { key: "SYSTEM" },
      update: { isEnabled: true },
      create: { key: "SYSTEM", title: "System", isEnabled: true },
    });
    await prisma.setting.upsert({
      where: { key: LOG_GROUP_CHAT_ID_KEY },
      update: { value: "-1001234567890" },
      create: { key: LOG_GROUP_CHAT_ID_KEY, value: "-1001234567890", type: "STRING" },
    });
    const channel = await seedNearlyRetiredChannel();
    created.push(channel.id);

    // No queue is reachable from here at all — the process that ran the
    // mutation could disappear now and the record would still be owed.
    await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");

    const events = await eventsForChannel(channel.id);
    const retirement = events.find(
      (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
    expect(retirement).toBeDefined();
    const delivery = await prisma.systemLogDelivery.findUnique({
      where: {
        systemLogId_logTopicId: { systemLogId: retirement!.id, logTopicId: topic.id },
      },
    });
    expect(delivery).not.toBeNull();
    expect(delivery?.status).toBe(LogDeliveryStatus.PENDING);
  });

  // D1-5 -----------------------------------------------------------------
  it("D1-5: no chat id, invite link or user identity appears anywhere in the durable event", async () => {
    const secretUsername = "fjsecretchannel";
    const channel = await seedNearlyRetiredChannel({
      isPrivate: true,
      joinUrl: `https://t.me/+${secretUsername}INVITEHASH`,
      publicUsername: null,
    });
    created.push(channel.id);

    await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");

    const events = await eventsForChannel(channel.id);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const blob = `${event.message} ${JSON.stringify(event.metadata)}`;
      expect(blob).not.toContain(channel.chatId.toString());
      // The absolute value too — a chat id without its sign is still the id.
      expect(blob).not.toContain((-channel.chatId).toString());
      expect(blob).not.toContain("t.me");
      expect(blob).not.toContain(secretUsername);
      expect(blob).not.toContain("INVITEHASH");
      // No user identity is carried on the row either.
      expect(event.userId).toBeNull();
      expect(event.adminId).toBeNull();
    }
    // What it DOES carry is operational and safe.
    const retirement = events.find(
      (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
    expect(retirement?.metadata).toMatchObject({
      channelId: channel.id,
      isPrivate: true,
      errorClass: "UNVERIFIABLE",
    });
  });

  // D1-6 -----------------------------------------------------------------
  it("D1-6: with no delivery target configured the decision still commits and the event is still durable", async () => {
    await prisma.setting.deleteMany({ where: { key: LOG_GROUP_CHAT_ID_KEY } });
    const channel = await seedNearlyRetiredChannel();
    created.push(channel.id);

    const outcome = await recordChannelHealthFailure(channel.id, "UNVERIFIABLE");
    expect(outcome.action).toBe("RETIRED");

    const events = await eventsForChannel(channel.id);
    const retirement = events.find(
      (e) => e.eventType === FORCE_JOIN_OPS_EVENTS.CHANNEL_RETIRED,
    );
    // The durable record exists regardless — only its Telegram fan-out is off.
    expect(retirement).toBeDefined();
    const deliveries = await prisma.systemLogDelivery.findMany({
      where: { systemLogId: retirement!.id },
    });
    expect(deliveries).toHaveLength(0);
    // And the membership decision was NOT rolled back by the absent target.
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channel.id } });
    expect(row?.isActive).toBe(false);
  });

  // D1-7 -----------------------------------------------------------------
  it("D1-7: the process-local alert sink no longer owns retirement, so logging output is supplemental only", async () => {
    const membershipSrc = await readFile(
      fileURLToPath(new URL("../../../packages/force-join/src/membership.ts", import.meta.url)),
      "utf8",
    );
    // The sink contract carries the pre-retirement warning ONLY.
    expect(membershipSrc).toContain("channelUnverifiable");
    expect(membershipSrc).not.toMatch(/channelRetired/);

    const botSink = await readFile(
      fileURLToPath(new URL("../src/services/force-join/membership.service.ts", import.meta.url)),
      "utf8",
    );
    expect(botSink).not.toMatch(/channelRetired/);

    // And the authoritative writer is the transaction-scoped outbox.
    const policySrc = await readFile(
      fileURLToPath(new URL("../../../packages/force-join/src/channel-policy.ts", import.meta.url)),
      "utf8",
    );
    expect(policySrc).toMatch(/writeForceJoinOpsEvent\(tx,/);
  });
});
