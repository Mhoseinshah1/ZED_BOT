import { type ForceJoinChannel, prisma } from "@zedbot/database";
import { isForceJoinMembershipActive } from "@zedbot/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ForceJoinMembershipApi,
  classifyMemberCheckError,
  evaluateForceJoinMembership,
  resetForceJoinRedisForTests,
} from "../src/services/force-join/membership.service.js";

// =============================================================================
// Phase 3 — membership checker: §4.8 status rule, the gate decision (PASS /
// MISSING / TEMP_FAILURE), the failure taxonomy (§4.11: unverifiable channels
// excluded + never bricking — D4; transient failures fail closed — D2), and the
// Redis verdict cache (§4.12) including the negative-cache bypass.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

// Per-process run tag so Redis cache keys (which include the channel id + its
// updatedAt version) are UNIQUE across repeated runs — otherwise re-running
// within a verdict's TTL would hit the previous run's cached values (this also
// keeps the §8 5x flake check honest).
const RUN_TAG = Date.now();
let seq = 0;
function makeChannel(overrides: Partial<ForceJoinChannel> = {}): ForceJoinChannel {
  seq += 1;
  const now = new Date(RUN_TAG + seq);
  return {
    id: `chan-${RUN_TAG}-${seq}`,
    title: `Channel ${seq}`,
    joinUrl: `https://t.me/chan${seq}`,
    normalizedLink: `https://t.me/chan${seq}`,
    chatId: BigInt(-(1_000_000_000_000 + (RUN_TAG % 1_000_000_000) * 10 + seq)),
    publicUsername: `chan${seq}`,
    isPrivate: false,
    isActive: true,
    sortOrder: seq,
    createdByAdminId: null,
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: null,
    lastValidationErrorCode: null,
    ...overrides,
  };
}

/** Fake api driven by a per-chatId behaviour map (keyed on Number(chatId)). */
function fakeApi(
  behaviour: Map<number, { status?: string; is_member?: boolean; throw?: unknown }>,
): { api: ForceJoinMembershipApi; getChatMember: ReturnType<typeof vi.fn> } {
  const getChatMember = vi.fn(async (chatId: number | string) => {
    const b = behaviour.get(Number(chatId));
    if (b === undefined || b.throw !== undefined) {
      throw b?.throw ?? { error_code: 400, description: "Bad Request: chat not found" };
    }
    return { status: b.status ?? "member", is_member: b.is_member };
  });
  return { api: { getChatMember }, getChatMember };
}

const uniqueUser = (() => {
  let u = BigInt(RUN_TAG) * 1000n;
  return () => {
    u += 1n;
    return u;
  };
})();

beforeEach(() => {
  resetForceJoinRedisForTests();
});

afterEach(() => {
  resetForceJoinRedisForTests();
});

afterAll(async () => {
  if (hasDb) {
    await prisma.systemLog.deleteMany({ where: { eventType: "force_join.channel_unverifiable" } });
    await prisma.$disconnect();
  }
});

describe("isForceJoinMembershipActive (§4.8)", () => {
  it("treats creator/administrator/member as joined", () => {
    expect(isForceJoinMembershipActive("creator")).toBe(true);
    expect(isForceJoinMembershipActive("administrator")).toBe(true);
    expect(isForceJoinMembershipActive("member")).toBe(true);
  });

  it("treats restricted as joined ONLY when is_member === true", () => {
    expect(isForceJoinMembershipActive("restricted", true)).toBe(true);
    expect(isForceJoinMembershipActive("restricted", false)).toBe(false);
    expect(isForceJoinMembershipActive("restricted")).toBe(false);
  });

  it("treats left/kicked/unknown as not joined", () => {
    expect(isForceJoinMembershipActive("left")).toBe(false);
    expect(isForceJoinMembershipActive("kicked")).toBe(false);
    expect(isForceJoinMembershipActive("nonsense")).toBe(false);
  });
});

describe("evaluateForceJoinMembership — decision logic", () => {
  it("PASS when the user is joined to every active channel", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const { api } = fakeApi(
      new Map([
        [Number(a.chatId), { status: "member" }],
        [Number(b.chatId), { status: "administrator" }],
      ]),
    );
    const out = await evaluateForceJoinMembership({
      api,
      userTelegramId: uniqueUser(),
      channels: [a, b],
    });
    expect(out).toEqual({ decision: "PASS" });
  });

  it("MISSING lists only the not-joined channels", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const c = makeChannel();
    const { api } = fakeApi(
      new Map([
        [Number(a.chatId), { status: "member" }],
        [Number(b.chatId), { status: "left" }],
        [Number(c.chatId), { status: "member" }],
      ]),
    );
    const out = await evaluateForceJoinMembership({
      api,
      userTelegramId: uniqueUser(),
      channels: [a, b, c],
    });
    expect(out.decision).toBe("MISSING");
    if (out.decision === "MISSING") {
      expect(out.missing.map((m) => m.id)).toEqual([b.id]);
    }
  });

  it("restricted with is_member=false counts as missing", async () => {
    const a = makeChannel();
    const { api } = fakeApi(new Map([[Number(a.chatId), { status: "restricted", is_member: false }]]));
    const out = await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [a] });
    expect(out.decision).toBe("MISSING");
  });

  it("TEMP_FAILURE when a check hits a transient error and nothing is definitively missing (D2)", async () => {
    const a = makeChannel();
    const { api } = fakeApi(
      new Map([[Number(a.chatId), { throw: { error_code: 429, description: "Too Many Requests" } }]]),
    );
    const out = await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [a] });
    expect(out).toEqual({ decision: "TEMP_FAILURE" });
  });

  it("a genuine miss takes priority over a transient failure on another channel", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const { api } = fakeApi(
      new Map([
        [Number(a.chatId), { status: "left" }],
        [Number(b.chatId), { throw: { error_code: 500, description: "Internal" } }],
      ]),
    );
    const out = await evaluateForceJoinMembership({
      api,
      userTelegramId: uniqueUser(),
      channels: [a, b],
    });
    expect(out.decision).toBe("MISSING");
    if (out.decision === "MISSING") {
      expect(out.missing.map((m) => m.id)).toEqual([a.id]);
    }
  });

  // Only an EXPLICIT "this user is not a participant" may block a real user.
  it("an explicit user-not-participant error is a MISS", async () => {
    const a = makeChannel();
    const { api } = fakeApi(
      new Map([
        [Number(a.chatId), { throw: { error_code: 400, description: "Bad Request: USER_NOT_PARTICIPANT" } }],
      ]),
    );
    const out = await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [a] });
    expect(out.decision).toBe("MISSING");
  });

  // "user not found" is Telegram not knowing the account — NOT proof they left
  // the channel. Blocking on it would lock out a genuine member, so it must fail
  // safe (channel excluded → the user is not blocked) instead.
  it("never blocks a user on an ambiguous 'user not found' error", async () => {
    const a = makeChannel();
    const { api } = fakeApi(
      new Map([[Number(a.chatId), { throw: { error_code: 400, description: "Bad Request: user not found" } }]]),
    );
    const out = await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [a] });
    expect(out.decision).not.toBe("MISSING");
  });

  // Realistic getChatMember failures, worded as Telegram actually words them.
  // The only verdict that BLOCKS a user is NOT_JOINED, so it is the only one
  // that may never be guessed at.
  describe("classifyMemberCheckError — realistic Telegram descriptions", () => {
    const cases: Array<[string, unknown, "TEMP" | "NOT_JOINED" | "UNVERIFIABLE"]> = [
      // The bot cannot see the channel → configuration problem, not the user's.
      ["bot removed from the channel", { error_code: 403, description: "Forbidden: bot is not a member of the channel chat" }, "UNVERIFIABLE"],
      ["bot demoted (member list hidden)", { error_code: 400, description: "Bad Request: member list is inaccessible" }, "UNVERIFIABLE"],
      ["channel deleted / id stale", { error_code: 400, description: "Bad Request: chat not found" }, "UNVERIFIABLE"],
      ["bot lacks rights", { error_code: 400, description: "Bad Request: not enough rights" }, "UNVERIFIABLE"],
      ["bot kicked", { error_code: 403, description: "Forbidden: bot was kicked from the channel chat" }, "UNVERIFIABLE"],
      ["private channel not accessible", { error_code: 400, description: "Bad Request: CHANNEL_PRIVATE" }, "UNVERIFIABLE"],
      // Transient.
      ["rate limited", { error_code: 429, description: "Too Many Requests: retry after 5" }, "TEMP"],
      ["telegram 5xx", { error_code: 502, description: "Bad Gateway" }, "TEMP"],
      ["network error (no code)", new Error("socket hang up"), "TEMP"],
      ["aborted request", new Error("The user aborted a request."), "TEMP"],
      // The ONLY explicit user-absence wording.
      ["explicit not-a-participant", { error_code: 400, description: "Bad Request: USER_NOT_PARTICIPANT" }, "NOT_JOINED"],
      ["participant id invalid", { error_code: 400, description: "Bad Request: PARTICIPANT_ID_INVALID" }, "NOT_JOINED"],
      // Ambiguous → must fail safe, never block.
      ["user unknown to telegram", { error_code: 400, description: "Bad Request: user not found" }, "UNVERIFIABLE"],
      ["unknown 4xx", { error_code: 400, description: "Bad Request: something new we have never seen" }, "UNVERIFIABLE"],
    ];

    for (const [name, err, expected] of cases) {
      it(`${name} → ${expected}`, () => {
        expect(classifyMemberCheckError(err)).toBe(expected);
      });
    }

    it("never returns NOT_JOINED for any bot-access wording", () => {
      const accessErrors = cases.filter(([, , v]) => v === "UNVERIFIABLE").map(([, e]) => e);
      for (const err of accessErrors) {
        expect(classifyMemberCheckError(err)).not.toBe("NOT_JOINED");
      }
    });
  });

  it("PASSES with an empty active set", async () => {
    const { api } = fakeApi(new Map());
    const out = await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [] });
    expect(out).toEqual({ decision: "PASS" });
  });
});

describe.runIf(hasDb)("evaluateForceJoinMembership — unverifiable channels (§4.11, D4)", () => {
  const createdIds: string[] = [];

  async function realChannel(overrides: Partial<ForceJoinChannel> = {}): Promise<ForceJoinChannel> {
    const template = makeChannel(overrides);
    const row = await prisma.forceJoinChannel.create({
      data: {
        title: template.title,
        joinUrl: template.joinUrl,
        normalizedLink: template.normalizedLink,
        chatId: template.chatId,
        publicUsername: template.publicUsername,
        isPrivate: template.isPrivate,
        isActive: template.isActive,
        sortOrder: template.sortOrder,
      },
    });
    createdIds.push(row.id);
    return row;
  }

  afterAll(async () => {
    await prisma.systemLog.deleteMany({ where: { eventType: "force_join.channel_unverifiable" } });
    await prisma.forceJoinChannel.deleteMany({ where: { id: { in: createdIds } } });
  });

  it("excludes an unverifiable channel and PASSES the user when the rest are joined (D4)", async () => {
    const good = await realChannel();
    const broken = await realChannel();
    const { api } = fakeApi(
      new Map([
        [Number(good.chatId), { status: "member" }],
        [Number(broken.chatId), { throw: { error_code: 403, description: "Forbidden: bot was kicked" } }],
      ]),
    );
    const out = await evaluateForceJoinMembership({
      api,
      userTelegramId: uniqueUser(),
      channels: [good, broken],
    });
    expect(out).toEqual({ decision: "PASS" });

    // A durable, privacy-safe alert was recorded (no chatId / invite link).
    const logs = await prisma.systemLog.findMany({
      where: { eventType: "force_join.channel_unverifiable" },
    });
    const forBroken = logs.filter((l) => (l.metadata as { channelId?: string })?.channelId === broken.id);
    expect(forBroken.length).toBe(1);
    expect(JSON.stringify(forBroken[0].metadata)).not.toContain(broken.chatId.toString());
    const refreshed = await prisma.forceJoinChannel.findUnique({ where: { id: broken.id } });
    expect(refreshed?.lastValidationErrorCode).toBe("UNVERIFIABLE");
  });

  it("PASSES when EVERY active channel is unverifiable (never bricks — D4)", async () => {
    const a = await realChannel();
    const b = await realChannel();
    const { api } = fakeApi(
      new Map([
        [Number(a.chatId), { throw: { error_code: 400, description: "Bad Request: chat not found" } }],
        [Number(b.chatId), { throw: { error_code: 403, description: "Forbidden: bot is not a member" } }],
      ]),
    );
    const out = await evaluateForceJoinMembership({
      api,
      userTelegramId: uniqueUser(),
      channels: [a, b],
    });
    expect(out).toEqual({ decision: "PASS" });
  });

  it("deduplicates the alert per channel within the window (one row across repeated checks)", async () => {
    const broken = await realChannel();
    const { api } = fakeApi(
      new Map([[Number(broken.chatId), { throw: { error_code: 403, description: "Forbidden: bot was kicked" } }]]),
    );
    for (let i = 0; i < 3; i += 1) {
      await evaluateForceJoinMembership({ api, userTelegramId: uniqueUser(), channels: [broken] });
    }
    const logs = await prisma.systemLog.findMany({
      where: { eventType: "force_join.channel_unverifiable" },
    });
    const forBroken = logs.filter((l) => (l.metadata as { channelId?: string })?.channelId === broken.id);
    expect(forBroken.length).toBe(1); // deduped
  });
});

describe.runIf(hasRedis)("evaluateForceJoinMembership — Redis verdict cache (§4.12)", () => {
  it("caches a positive verdict so the second check does not hit Telegram", async () => {
    const a = makeChannel();
    const user = uniqueUser();
    const { api, getChatMember } = fakeApi(new Map([[Number(a.chatId), { status: "member" }]]));

    const first = await evaluateForceJoinMembership({ api, userTelegramId: user, channels: [a] });
    expect(first).toEqual({ decision: "PASS" });
    const second = await evaluateForceJoinMembership({ api, userTelegramId: user, channels: [a] });
    expect(second).toEqual({ decision: "PASS" });

    expect(getChatMember).toHaveBeenCalledTimes(1); // second served from cache
  });

  it("the explicit re-check bypasses the NEGATIVE cache (a user who just joined is seen immediately)", async () => {
    const a = makeChannel();
    const user = uniqueUser();
    // First: not joined -> cached negative.
    const behaviour = new Map([[Number(a.chatId), { status: "left" as string }]]);
    const getChatMember = vi.fn(async (chatId: number | string) => ({
      status: behaviour.get(Number(chatId))!.status,
    }));
    const api: ForceJoinMembershipApi = { getChatMember };

    const miss = await evaluateForceJoinMembership({ api, userTelegramId: user, channels: [a] });
    expect(miss.decision).toBe("MISSING");

    // The user joins; a normal check would still see the cached negative...
    behaviour.set(Number(a.chatId), { status: "member" });
    const cachedStill = await evaluateForceJoinMembership({ api, userTelegramId: user, channels: [a] });
    expect(cachedStill.decision).toBe("MISSING"); // negative cache still warm

    // ...but the explicit re-check bypasses the negative cache and re-queries.
    const rechecked = await evaluateForceJoinMembership({
      api,
      userTelegramId: user,
      channels: [a],
      bypassNegativeCache: true,
    });
    expect(rechecked).toEqual({ decision: "PASS" });
  });
});
