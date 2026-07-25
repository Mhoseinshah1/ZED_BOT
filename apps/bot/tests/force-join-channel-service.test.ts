import { prisma } from "@zedbot/database";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ACTIVE_FORCE_JOIN_CHANNELS,
  classifyTelegramFailure,
  countActiveChannels,
  createOrRebindChannel,
  deleteChannel,
  disableForceJoin,
  disableForceJoinAndDelete,
  enableForceJoin,
  type ForceJoinBotApi,
  listActiveChannels,
  listAllChannels,
  rebindChannelIdentity,
  reorderChannel,
  resolveChannelByShortId,
  setChannelActive,
  updateChannelJoinUrl,
  validateBotChannelAccess,
} from "../src/services/force-join/force-join-channel.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// Phase 2 — ForceJoinChannel service: bot-access validation (D1/T9, pure) and
// the transaction-safe CRUD + guard layer (10-active cap §4.4, D3 last-active
// fail-safe, D5 rebind-by-chatId, D6 public-link uniqueness, T7 ordering).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

// Unique chatId generator so parallel/repeat runs never collide.
let chatSeq = 0n;
const runTag = BigInt(Date.now()) * 1000n;
function nextChatId(): bigint {
  chatSeq += 1n;
  return -(1000000000000n + runTag + chatSeq);
}

function publicInput(username: string, chatId: bigint) {
  return {
    chatId,
    title: `Channel ${username}`,
    joinUrl: `https://t.me/${username}`,
    normalizedLink: `https://t.me/${username}`,
    isPrivate: false,
    publicUsername: username,
    createdByAdminId: "admin-test",
  };
}

function privateInput(hash: string, chatId: bigint) {
  return {
    chatId,
    title: `Private ${hash}`,
    joinUrl: `https://t.me/+${hash}`,
    normalizedLink: `https://t.me/+${hash}`,
    isPrivate: true,
    publicUsername: null,
    createdByAdminId: "admin-test",
  };
}

// --- pure bot-access validation (no DB) --------------------------------------

describe("classifyTelegramFailure", () => {
  it("classifies rate limits and 5xx as temporary", () => {
    expect(classifyTelegramFailure({ error_code: 429, description: "Too Many Requests" })).toBe("TEMP");
    expect(classifyTelegramFailure({ error_code: 500, description: "Internal" })).toBe("TEMP");
  });

  it("classifies not-found / rights errors as permanent", () => {
    expect(classifyTelegramFailure({ error_code: 400, description: "Bad Request: chat not found" })).toBe("PERMANENT");
    expect(classifyTelegramFailure({ error_code: 400, description: "USERNAME_NOT_OCCUPIED" })).toBe("PERMANENT");
    expect(classifyTelegramFailure({ error_code: 403, description: "not enough rights" })).toBe("PERMANENT");
  });

  it("fails closed to temporary on unknown / network errors", () => {
    expect(classifyTelegramFailure(new Error("socket hang up"))).toBe("TEMP");
    expect(classifyTelegramFailure(null)).toBe("TEMP");
  });
});

describe("validateBotChannelAccess (D1/T9)", () => {
  function api(overrides: Partial<ForceJoinBotApi>): ForceJoinBotApi {
    return {
      getMe: vi.fn(async () => ({ id: 999 })),
      getChat: vi.fn(async () => ({ id: -1001, type: "channel", title: "T", username: "zedproxy" })),
      getChatMember: vi.fn(async () => ({ status: "administrator" })),
      ...overrides,
    };
  }

  it("accepts a channel where the bot is administrator and returns authoritative identity", async () => {
    const res = await validateBotChannelAccess(
      api({ getChat: vi.fn(async () => ({ id: -1009, type: "channel", title: "ZED", username: "ZedProxy" })) }),
      { kind: "PUBLIC", username: "zedproxy" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.chatId).toBe(-1009n);
      expect(res.title).toBe("ZED");
      expect(res.username).toBe("ZedProxy");
    }
  });

  it("accepts a supergroup where the bot is creator", async () => {
    const res = await validateBotChannelAccess(
      api({
        getChat: vi.fn(async () => ({ id: -100777, type: "supergroup", title: "SG", username: "sg" })),
        getChatMember: vi.fn(async () => ({ status: "creator" })),
      }),
      { kind: "PUBLIC", username: "sg" },
    );
    expect(res.ok).toBe(true);
  });

  it("rejects when the bot is only a member (not admin) as BOT_NOT_ADMIN", async () => {
    const res = await validateBotChannelAccess(
      api({ getChatMember: vi.fn(async () => ({ status: "member" })) }),
      { kind: "PRIVATE", chatId: -1002n },
    );
    expect(res).toEqual({ ok: false, code: "BOT_NOT_ADMIN" });
  });

  it("rejects a non-channel target as NOT_A_CHANNEL", async () => {
    const res = await validateBotChannelAccess(
      api({ getChat: vi.fn(async () => ({ id: 5, type: "private", title: "U" })) }),
      { kind: "PRIVATE", chatId: -1003n },
    );
    expect(res).toEqual({ ok: false, code: "NOT_A_CHANNEL" });
  });

  it("rejects a public target with no username as NOT_A_CHANNEL", async () => {
    const res = await validateBotChannelAccess(
      api({ getChat: vi.fn(async () => ({ id: -1004, type: "channel", title: "no-username" })) }),
      { kind: "PUBLIC", username: "ghost" },
    );
    expect(res).toEqual({ ok: false, code: "NOT_A_CHANNEL" });
  });

  it("maps a permanent getChat error to CHANNEL_NOT_FOUND", async () => {
    const res = await validateBotChannelAccess(
      api({ getChat: vi.fn(async () => { throw { error_code: 400, description: "Bad Request: chat not found" }; }) }),
      { kind: "PUBLIC", username: "gone" },
    );
    expect(res).toEqual({ ok: false, code: "CHANNEL_NOT_FOUND" });
  });

  it("maps a rate-limited getChat to TEMP_FAILURE (D2: never lie)", async () => {
    const res = await validateBotChannelAccess(
      api({ getChat: vi.fn(async () => { throw { error_code: 429, description: "Too Many Requests" }; }) }),
      { kind: "PUBLIC", username: "busy" },
    );
    expect(res).toEqual({ ok: false, code: "TEMP_FAILURE" });
  });

  it("maps a failing getMe to TEMP_FAILURE", async () => {
    const res = await validateBotChannelAccess(
      api({ getMe: vi.fn(async () => { throw new Error("network"); }) }),
      { kind: "PUBLIC", username: "x" },
    );
    expect(res).toEqual({ ok: false, code: "TEMP_FAILURE" });
  });
});

// --- DB-backed CRUD + guards --------------------------------------------------

describe.runIf(hasDb)("ForceJoinChannel service (DB)", () => {
  const createdIds: string[] = [];

  async function trackAll(): Promise<void> {
    const rows = await prisma.forceJoinChannel.findMany({ select: { id: true } });
    for (const r of rows) {
      if (!createdIds.includes(r.id)) createdIds.push(r.id);
    }
  }

  beforeEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await disableForceJoin();
    clearSettingsCache();
  });

  afterEach(async () => {
    await trackAll();
  });

  afterAll(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await prisma.setting.deleteMany({ where: { key: "force_join_enabled" } });
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("creates a channel active under the cap, with incrementing sortOrder", async () => {
    const a = await createOrRebindChannel(publicInput("chan_a", nextChatId()));
    const b = await createOrRebindChannel(publicInput("chan_b", nextChatId()));
    expect(a.ok && a.created && a.activated).toBe(true);
    expect(b.ok && b.created && b.activated).toBe(true);
    if (a.ok && b.ok) {
      expect(b.channel.sortOrder).toBeGreaterThan(a.channel.sortOrder);
    }
    expect(await countActiveChannels()).toBe(2);
  });

  it("rebinds by chatId (D5): re-adding the same chatId updates the row, no duplicate", async () => {
    const chatId = nextChatId();
    const first = await createOrRebindChannel(publicInput("orig_name", chatId));
    expect(first.ok && first.created).toBe(true);
    const second = await createOrRebindChannel({
      ...publicInput("new_name", chatId),
      title: "Renamed",
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.created).toBe(false);
      expect(second.channel.title).toBe("Renamed");
      expect(second.channel.publicUsername).toBe("new_name");
    }
    expect(await prisma.forceJoinChannel.count()).toBe(1);
  });

  it("rejects a duplicate normalized PUBLIC link (D6) as LINK_CONFLICT", async () => {
    await createOrRebindChannel(publicInput("dup_pub", nextChatId()));
    const again = await createOrRebindChannel({
      ...publicInput("dup_pub", nextChatId()), // same normalizedLink, different chatId
    });
    expect(again).toEqual({ ok: false, code: "LINK_CONFLICT" });
  });

  it("allows two PRIVATE channels sharing a normalizedLink (D6 excludes private)", async () => {
    const a = await createOrRebindChannel(privateInput("samehash", nextChatId()));
    const b = await createOrRebindChannel(privateInput("samehash", nextChatId()));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await prisma.forceJoinChannel.count()).toBe(2);
  });

  it("caps active channels at 10 — the 11th is created INACTIVE, never over the cap (§4.4)", async () => {
    for (let i = 0; i < MAX_ACTIVE_FORCE_JOIN_CHANNELS; i += 1) {
      const r = await createOrRebindChannel(publicInput(`cap_${i}`, nextChatId()));
      expect(r.ok && r.activated).toBe(true);
    }
    expect(await countActiveChannels()).toBe(MAX_ACTIVE_FORCE_JOIN_CHANNELS);
    const overflow = await createOrRebindChannel(publicInput("cap_overflow", nextChatId()));
    expect(overflow.ok).toBe(true);
    if (overflow.ok) {
      expect(overflow.created).toBe(true);
      expect(overflow.activated).toBe(false);
    }
    expect(await countActiveChannels()).toBe(MAX_ACTIVE_FORCE_JOIN_CHANNELS);
  });

  it("rejects activating an 11th channel at the cap (ACTIVE_LIMIT)", async () => {
    let overflowId = "";
    for (let i = 0; i <= MAX_ACTIVE_FORCE_JOIN_CHANNELS; i += 1) {
      const r = await createOrRebindChannel(publicInput(`lim_${i}`, nextChatId()));
      if (r.ok && !r.activated) overflowId = r.channel.id;
    }
    const res = await setChannelActive(overflowId, true);
    expect(res).toEqual({ ok: false, code: "ACTIVE_LIMIT" });
  });

  it("blocks deactivating the last active channel while enabled (D3), allows when disabled", async () => {
    const only = await createOrRebindChannel(publicInput("only_one", nextChatId()));
    expect(only.ok).toBe(true);
    const enabled = await enableForceJoin();
    expect(enabled).toEqual({ ok: true });

    if (only.ok) {
      const blocked = await setChannelActive(only.channel.id, false);
      expect(blocked).toEqual({ ok: false, code: "LAST_ACTIVE_WHILE_ENABLED" });

      await disableForceJoin();
      const allowed = await setChannelActive(only.channel.id, false);
      expect(allowed.ok).toBe(true);
    }
  });

  it("blocks deleting the last active channel while enabled, but the combined action succeeds (D3)", async () => {
    const only = await createOrRebindChannel(publicInput("last_del", nextChatId()));
    await enableForceJoin();
    if (only.ok) {
      const blocked = await deleteChannel(only.channel.id);
      expect(blocked).toEqual({ ok: false, code: "LAST_ACTIVE_WHILE_ENABLED" });

      const combined = await disableForceJoinAndDelete(only.channel.id);
      expect(combined).toEqual({ ok: true });
    }
    expect(await prisma.forceJoinChannel.count()).toBe(0);
    const setting = await prisma.setting.findUnique({ where: { key: "force_join_enabled" } });
    expect(setting?.value).toBe("false");
  });

  it("rejects enabling with zero active channels (§4.10), succeeds with one", async () => {
    const noneYet = await enableForceJoin();
    expect(noneYet).toEqual({ ok: false, code: "NO_ACTIVE" });

    await createOrRebindChannel(publicInput("enabler", nextChatId()));
    const ok = await enableForceJoin();
    expect(ok).toEqual({ ok: true });
    const setting = await prisma.setting.findUnique({ where: { key: "force_join_enabled" } });
    expect(setting?.value).toBe("true");
  });

  it("does not count an inactive channel toward the enable guard", async () => {
    // Fill the cap then add an overflow (inactive), deactivate all active,
    // leaving only the inactive one -> enabling must be rejected.
    const first = await createOrRebindChannel(publicInput("solo_active", nextChatId()));
    if (first.ok) await setChannelActive(first.channel.id, false);
    const guard = await enableForceJoin();
    expect(guard).toEqual({ ok: false, code: "NO_ACTIVE" });
  });

  it("reorders channels up/down deterministically and renumbers contiguously (T7)", async () => {
    const a = await createOrRebindChannel(publicInput("ord_a", nextChatId()));
    const b = await createOrRebindChannel(publicInput("ord_b", nextChatId()));
    const c = await createOrRebindChannel(publicInput("ord_c", nextChatId()));
    if (!(a.ok && b.ok && c.ok)) throw new Error("setup");

    const idsInOrder = (await listAllChannels()).map((r) => r.id);
    expect(idsInOrder).toEqual([a.channel.id, b.channel.id, c.channel.id]);

    // Move c up -> a, c, b
    expect(await reorderChannel(c.channel.id, "up")).toEqual({ ok: true });
    expect((await listAllChannels()).map((r) => r.id)).toEqual([a.channel.id, c.channel.id, b.channel.id]);

    // Move a down -> c, a, b
    expect(await reorderChannel(a.channel.id, "down")).toEqual({ ok: true });
    expect((await listAllChannels()).map((r) => r.id)).toEqual([c.channel.id, a.channel.id, b.channel.id]);

    // Edge: top item cannot move up
    expect(await reorderChannel(c.channel.id, "up")).toEqual({ ok: false, code: "NO_MOVE" });

    // sortOrder is contiguous 0..n-1
    const sorts = (await listAllChannels()).map((r) => r.sortOrder);
    expect(sorts).toEqual([0, 1, 2]);
  });

  it("resolves a channel by unique short id prefix, returns null on ambiguity/miss (D7)", async () => {
    const a = await createOrRebindChannel(publicInput("shortid_a", nextChatId()));
    if (!a.ok) throw new Error("setup");
    const full = a.channel.id;
    const resolved = await resolveChannelByShortId(full.slice(0, 8));
    expect(resolved?.id).toBe(full);
    expect(await resolveChannelByShortId("ffffffff-0000-0000-0000-000000000000")).toBeNull();
    expect(await resolveChannelByShortId("!!bad!!")).toBeNull();
  });

  it("rebinds a row's identity and rejects a rebind onto another row's chatId (DUPLICATE_CHANNEL)", async () => {
    const a = await createOrRebindChannel(privateInput("reb_a", nextChatId()));
    const b = await createOrRebindChannel(privateInput("reb_b", nextChatId()));
    if (!(a.ok && b.ok)) throw new Error("setup");

    const newChatId = nextChatId();
    const rebound = await rebindChannelIdentity(a.channel.id, {
      chatId: newChatId,
      title: "Rebound",
      isPrivate: true,
      publicUsername: null,
    });
    expect(rebound.ok).toBe(true);
    if (rebound.ok) expect(rebound.channel.chatId).toBe(newChatId);

    const collide = await rebindChannelIdentity(a.channel.id, {
      chatId: b.channel.chatId,
      title: "collide",
      isPrivate: true,
      publicUsername: null,
    });
    expect(collide).toEqual({ ok: false, code: "DUPLICATE_CHANNEL" });
  });

  it("updates only the join url", async () => {
    const a = await createOrRebindChannel(privateInput("upd_hash", nextChatId()));
    if (!a.ok) throw new Error("setup");
    const res = await updateChannelJoinUrl(a.channel.id, "https://t.me/+newhash", "https://t.me/+newhash");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.channel.joinUrl).toBe("https://t.me/+newhash");
  });

  it("listActiveChannels returns only active rows in deterministic order", async () => {
    const a = await createOrRebindChannel(publicInput("act_a", nextChatId()));
    const b = await createOrRebindChannel(publicInput("act_b", nextChatId()));
    if (!(a.ok && b.ok)) throw new Error("setup");
    await setChannelActive(a.channel.id, false);
    const active = await listActiveChannels();
    expect(active.map((r) => r.id)).toEqual([b.channel.id]);
  });
});
