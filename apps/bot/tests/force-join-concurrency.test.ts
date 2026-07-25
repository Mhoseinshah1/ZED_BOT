import { prisma } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "force-join-concurrency-secret";

import {
  FORCE_JOIN_ENABLED_KEY,
  FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
  FORCE_JOIN_HEALTH_MIN_WINDOW_MS,
  MAX_ACTIVE_FORCE_JOIN_CHANNELS,
  countActiveChannels,
  createOrRebindChannel,
  deleteChannel,
  disableForceJoin,
  enableForceJoin,
  listAllChannels,
  recordChannelHealthFailure,
  recordChannelHealthSuccess,
  reorderChannel,
  setChannelActive,
} from "../src/services/force-join/force-join-channel.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// Force join — REAL PostgreSQL concurrency + the bounded channel-health policy.
//
// Every configuration mutation takes one dedicated transaction-level advisory
// lock. A row lock on the active set cannot serialize these: when the active set
// is EMPTY it locks no rows at all, so two "create the first channel" or
// "enable" transactions would both observe zero and both commit. These tests
// drive genuinely parallel transactions and assert the invariants that only a
// correctly serialized configuration can hold.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

let chatSeq = 0n;
const runTag = BigInt(Date.now()) * 1000n;
function nextChatId(): bigint {
  chatSeq += 1n;
  return -(1_000_000_000_000n + runTag + chatSeq);
}

function publicInput(username: string, chatId: bigint) {
  return {
    chatId,
    title: `Channel ${username}`,
    joinUrl: `https://t.me/${username}`,
    normalizedLink: `https://t.me/${username}`,
    isPrivate: false,
    publicUsername: username,
    createdByAdminId: "admin-conc",
  };
}

describe.runIf(hasDb)("force join — concurrent configuration mutations", () => {
  beforeEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await disableForceJoin();
    clearSettingsCache();
  });

  afterAll(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("gives concurrent first-channel creations a consistent, unique ordering", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createOrRebindChannel(publicInput(`conc_first_${i}`, nextChatId())),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await listAllChannels();
    expect(rows.length).toBe(8);
    // Unserialized, several transactions read the same MAX(sortOrder) and every
    // new row lands on the same position.
    const orders = rows.map((r) => r.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("never exceeds the 10-active cap under concurrent activation", async () => {
    const created = await Promise.all(
      Array.from({ length: MAX_ACTIVE_FORCE_JOIN_CHANNELS + 4 }, (_, i) =>
        createOrRebindChannel(publicInput(`conc_cap_${i}`, nextChatId())),
      ),
    );
    const ids = created.flatMap((r) => (r.ok ? [r.channel.id] : []));
    expect(ids.length).toBe(MAX_ACTIVE_FORCE_JOIN_CHANNELS + 4);

    // Start from all-inactive, then race every activation at once.
    await Promise.all(ids.map((id) => setChannelActive(id, false)));
    expect(await countActiveChannels()).toBe(0);

    const activations = await Promise.all(ids.map((id) => setChannelActive(id, true)));
    const accepted = activations.filter((r) => r.ok).length;
    const rejected = activations.filter((r) => !r.ok && r.code === "ACTIVE_LIMIT").length;

    expect(await countActiveChannels()).toBe(MAX_ACTIVE_FORCE_JOIN_CHANNELS);
    expect(accepted).toBe(MAX_ACTIVE_FORCE_JOIN_CHANNELS);
    expect(rejected).toBe(4);
  });

  it("never leaves force join enabled with zero active channels when enable races a deactivation", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await prisma.forceJoinChannel.deleteMany({});
      await disableForceJoin();
      clearSettingsCache();
      const only = await createOrRebindChannel(publicInput(`conc_race_${attempt}`, nextChatId()));
      if (!only.ok) throw new Error("setup");

      const [enabled] = await Promise.all([
        enableForceJoin(),
        setChannelActive(only.channel.id, false),
      ]);

      clearSettingsCache();
      const setting = await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } });
      const isOn = setting?.value === "true";
      const active = await countActiveChannels();
      // The forbidden state is "switched on with nothing to enforce".
      expect(isOn && active === 0).toBe(false);
      // And the two operations agree: enable only succeeded if a channel survived.
      if (enabled.ok) {
        expect(active).toBeGreaterThan(0);
      }
    }
  });

  it("never leaves force join enabled with zero active channels when enable races a deletion", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await prisma.forceJoinChannel.deleteMany({});
      await disableForceJoin();
      clearSettingsCache();
      const only = await createOrRebindChannel(publicInput(`conc_del_${attempt}`, nextChatId()));
      if (!only.ok) throw new Error("setup");

      await Promise.all([enableForceJoin(), deleteChannel(only.channel.id)]);

      clearSettingsCache();
      const setting = await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } });
      const isOn = setting?.value === "true";
      expect(isOn && (await countActiveChannels()) === 0).toBe(false);
    }
  });

  it("resolves a concurrent duplicate chat identity to exactly one row", async () => {
    const sharedChatId = nextChatId();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createOrRebindChannel(publicInput(`dupchat_${i}`, sharedChatId))),
    );
    // Every attempt targets the same chatId: the first inserts, the rest rebind
    // that same row or lose on the unique constraint. Either way — one row.
    expect(await prisma.forceJoinChannel.count({ where: { chatId: sharedChatId } })).toBe(1);
    expect(attempts.some((r) => r.ok)).toBe(true);
  });

  it("resolves concurrent duplicate links to one winner", async () => {
    const link = `https://t.me/duplink${Date.now()}`;
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        createOrRebindChannel({
          chatId: nextChatId(),
          title: "Dup",
          joinUrl: link,
          normalizedLink: link,
          isPrivate: false,
          publicUsername: `duplink${Date.now()}`,
          createdByAdminId: null,
        }),
      ),
    );
    expect(attempts.filter((r) => r.ok).length).toBe(1);
    expect(await prisma.forceJoinChannel.count({ where: { normalizedLink: link } })).toBe(1);
  });

  it("leaves a deterministic contiguous ordering after concurrent reorders", async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createOrRebindChannel(publicInput(`conc_ord_${i}`, nextChatId()))),
    );
    const ids = created.flatMap((r) => (r.ok ? [r.channel.id] : []));
    expect(ids.length).toBe(6);

    await Promise.all([
      reorderChannel(ids[0], "down"),
      reorderChannel(ids[5], "up"),
      reorderChannel(ids[2], "up"),
      reorderChannel(ids[3], "down"),
      reorderChannel(ids[1], "down"),
    ]);

    const rows = await listAllChannels();
    const orders = rows.map((r) => r.sortOrder);
    // Whatever interleaving happened, positions stay distinct and contiguous.
    expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
  });
});

// =============================================================================
// Bounded unhealthy-channel lifecycle (§4.11).
// =============================================================================

describe.runIf(hasDb)("force join — bounded channel-health policy", () => {
  beforeEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await disableForceJoin();
    clearSettingsCache();
  });

  afterAll(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    clearSettingsCache();
    await prisma.$disconnect();
  });

  /** Puts the row one failure away from retirement, past the sustained window. */
  async function armAtThreshold(id: string): Promise<void> {
    const now = Date.now();
    await prisma.forceJoinChannel.update({
      where: { id },
      data: {
        healthFailureCount: FORCE_JOIN_HEALTH_FAILURE_THRESHOLD - 1,
        healthFailureFirstAt: new Date(now - FORCE_JOIN_HEALTH_MIN_WINDOW_MS - 60_000),
        healthFailureLastAt: new Date(now - 30_000),
      },
    });
  }

  it("counts a permanent failure without touching the configuration", async () => {
    const c = await createOrRebindChannel(publicInput("health_count", nextChatId()));
    if (!c.ok) throw new Error("setup");

    const outcome = await recordChannelHealthFailure(c.channel.id, "UNVERIFIABLE");
    expect(outcome.action).toBe("COUNTED");

    const row = await prisma.forceJoinChannel.findUnique({ where: { id: c.channel.id } });
    expect(row?.isActive).toBe(true); // still required — never silently dropped
    expect(row?.healthFailureCount).toBe(1);
    expect(row?.healthFailureFirstAt).not.toBeNull();
    expect(row?.unhealthyAt).toBeNull();
  });

  it("does not retire a channel on the threshold alone before the window elapses", async () => {
    const c = await createOrRebindChannel(publicInput("health_window", nextChatId()));
    if (!c.ok) throw new Error("setup");
    // Threshold reached, but the failures only just started.
    await prisma.forceJoinChannel.update({
      where: { id: c.channel.id },
      data: {
        healthFailureCount: FORCE_JOIN_HEALTH_FAILURE_THRESHOLD,
        healthFailureFirstAt: new Date(),
        healthFailureLastAt: new Date(Date.now() - 30_000),
      },
    });

    const outcome = await recordChannelHealthFailure(c.channel.id, "UNVERIFIABLE");
    expect(outcome.action).toBe("COUNTED");
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: c.channel.id } });
    expect(row?.isActive).toBe(true);
  });

  it("retires the channel once failures are both numerous and sustained", async () => {
    const keep = await createOrRebindChannel(publicInput("health_keep", nextChatId()));
    const broken = await createOrRebindChannel(publicInput("health_broken", nextChatId()));
    if (!(keep.ok && broken.ok)) throw new Error("setup");
    await enableForceJoin();
    clearSettingsCache();
    await armAtThreshold(broken.channel.id);

    const outcome = await recordChannelHealthFailure(broken.channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "RETIRED", forceJoinDisabled: false });

    const row = await prisma.forceJoinChannel.findUnique({ where: { id: broken.channel.id } });
    expect(row?.isActive).toBe(false);
    expect(row?.unhealthyAt).not.toBeNull();
    // Another channel still enforces membership, so the switch stays on.
    clearSettingsCache();
    const setting = await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    expect(setting?.value).toBe("true");
  });

  it("disables force join in the same transaction when the retired channel was the last active one", async () => {
    const only = await createOrRebindChannel(publicInput("health_last", nextChatId()));
    if (!only.ok) throw new Error("setup");
    await enableForceJoin();
    clearSettingsCache();
    await armAtThreshold(only.channel.id);

    const outcome = await recordChannelHealthFailure(only.channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "RETIRED", forceJoinDisabled: true });

    expect(await countActiveChannels()).toBe(0);
    clearSettingsCache();
    const setting = await prisma.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    // Never enabled with nothing enforceable — and users are never locked out.
    expect(setting?.value).toBe("false");
  });

  it("debounces repeated failures so a broken channel cannot be counted once per request", async () => {
    const c = await createOrRebindChannel(publicInput("health_debounce", nextChatId()));
    if (!c.ok) throw new Error("setup");

    for (let i = 0; i < 5; i += 1) {
      await recordChannelHealthFailure(c.channel.id, "UNVERIFIABLE");
    }
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: c.channel.id } });
    expect(row?.healthFailureCount).toBe(1);
  });

  it("clears the failure window as soon as the channel verifies again", async () => {
    const c = await createOrRebindChannel(publicInput("health_reset", nextChatId()));
    if (!c.ok) throw new Error("setup");
    await armAtThreshold(c.channel.id);

    await recordChannelHealthSuccess(c.channel.id);

    const row = await prisma.forceJoinChannel.findUnique({ where: { id: c.channel.id } });
    expect(row?.healthFailureCount).toBe(0);
    expect(row?.healthFailureFirstAt).toBeNull();
    expect(row?.unhealthyAt).toBeNull();

    // A single fresh failure now starts a NEW window instead of retiring it.
    const outcome = await recordChannelHealthFailure(c.channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "COUNTED", count: 1 });
    expect((await prisma.forceJoinChannel.findUnique({ where: { id: c.channel.id } }))?.isActive).toBe(
      true,
    );
  });

  it("ignores health failures for an already-inactive channel", async () => {
    const c = await createOrRebindChannel(publicInput("health_inactive", nextChatId()));
    if (!c.ok) throw new Error("setup");
    await setChannelActive(c.channel.id, false);

    const outcome = await recordChannelHealthFailure(c.channel.id, "UNVERIFIABLE");
    expect(outcome).toEqual({ action: "NOOP" });
  });
});
