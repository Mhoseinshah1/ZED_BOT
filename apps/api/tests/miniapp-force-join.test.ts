import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "@zedbot/database";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mini App Force Join gate (FJ01-FJ13b).
//
// The defect these exist for: the gate used to answer FORCE_JOIN_REQUIRED
// whenever mandatory membership was switched on and any active channel existed,
// without ever asking whether the user had joined. Nothing a user could do
// anywhere cleared it — joining and verifying in the bot changed nothing, and
// the Mini App refused them forever.
//
// So the properties under test are the ones that make the gate SATISFIABLE and
// still safe:
//   - a member of every active channel is admitted (FJ01, FJ02);
//   - a user missing one channel is refused (FJ03);
//   - joining and retrying admits them, with no other action (FJ04);
//   - the operator bypass still short-circuits everything (FJ05);
//   - uncertainty NEVER admits: a transient Telegram failure, a dead socket and
//     a missing bot token all fail closed (FJ06, FJ07, FJ12);
//   - the unhealthy-channel rule matches the bot's exactly (FJ08, FJ09);
//   - no frontend claim of membership exists or is consulted (FJ10);
//   - a disarmed gate costs no Telegram traffic (FJ11);
//   - grammY has not entered the API (FJ13, FJ13b).
//
// Membership is driven by stubbing `fetch`, so the REAL HTTP client and the
// REAL error classifier run — the same classifier the bot uses, since both now
// import it from `@zedbot/force-join`.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-force-join-test-secret-0123456789";
const BOT_TOKEN = "515151:AA-miniapp-force-join-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;

// The verdict cache is the bot's, and it is proved there. Disabling it here
// keeps every assertion below about the DECISION rather than about a TTL: with
// Redis configured, FJ04's "join, then retry" would additionally have to wait
// out the ~10s negative-verdict TTL, which is a caching property, not a gating
// one. Redis being absent is also the D8 path — the check must still work.
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;

const { evaluateMiniAppAccess } = await import("../src/miniapp/access-policy.js");
const { resetForceJoinRedisForTests } = await import("@zedbot/force-join");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const MEMBER_TELEGRAM_ID = 9_400_000_000_000n + runTag;
const OUTSIDER_TELEGRAM_ID = MEMBER_TELEGRAM_ID + 1n;
const BYPASS_TELEGRAM_ID = MEMBER_TELEGRAM_ID + 2n;

const CHANNEL_A_CHAT_ID = -1_009_400_000_000n - runTag;
const CHANNEL_B_CHAT_ID = CHANNEL_A_CHAT_ID - 1n;

let memberUserId = "";
let outsiderUserId = "";
let bypassUserId = "";
let channelAId = "";
let channelBId = "";

// --- fake Telegram ------------------------------------------------------------

/** Per-chat-id membership the stubbed Bot API reports. */
type MemberStatus = "member" | "left" | "creator";

interface TelegramScript {
  /** `${chatId}:${userId}` → status, or a failure to raise. */
  members: Map<string, MemberStatus>;
  /** `${chatId}` → an error every call for that chat returns. */
  failures: Map<string, { status: number; error_code?: number; description: string }>;
  /** `${chatId}` → throw at the socket level (no HTTP response at all). */
  networkFailures: Set<string>;
  calls: Array<{ chatId: string; userId: string }>;
}

let script: TelegramScript;

function resetScript(): void {
  script = { members: new Map(), failures: new Map(), networkFailures: new Set(), calls: [] };
}

function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      // The token belongs in the URL and nowhere else — assert it, since the
      // client's contract is that it never leaks anywhere but here.
      expect(url).toContain(`/bot${BOT_TOKEN}/getChatMember`);
      const body = JSON.parse(init.body ?? "{}") as { chat_id: number; user_id: number };
      const chatId = String(body.chat_id);
      const userId = String(body.user_id);
      script.calls.push({ chatId, userId });

      if (script.networkFailures.has(chatId)) {
        throw new TypeError("fetch failed");
      }
      const failure = script.failures.get(chatId);
      if (failure !== undefined) {
        return {
          ok: false,
          status: failure.status,
          json: async () => ({
            ok: false,
            error_code: failure.error_code ?? failure.status,
            description: failure.description,
          }),
        } as Response;
      }
      const status = script.members.get(`${chatId}:${userId}`) ?? "left";
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status, is_member: status !== "left" } }),
      } as Response;
    }),
  );
}

// --- fixtures -----------------------------------------------------------------

async function createUser(telegramId: bigint, forceJoinBypass: boolean): Promise<string> {
  const user = await prisma.user.create({
    data: { telegramId, firstName: "FJ", status: "ACTIVE", forceJoinBypass },
    select: { id: true },
  });
  return user.id;
}

async function createChannel(chatId: bigint, title: string, sortOrder: number): Promise<string> {
  const link = `https://t.me/fj_${sortOrder}_${runTag}`;
  const channel = await prisma.forceJoinChannel.create({
    data: {
      chatId,
      title,
      joinUrl: link,
      normalizedLink: link,
      publicUsername: `fj_${sortOrder}_${runTag}`,
      isPrivate: false,
      isActive: true,
      sortOrder,
    },
    select: { id: true },
  });
  return channel.id;
}

async function setForceJoinEnabled(value: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "force_join_enabled" },
    update: { value: String(value), type: "BOOLEAN" },
    create: { key: "force_join_enabled", value: String(value), type: "BOOLEAN" },
  });
}

async function setChannelActive(id: string, isActive: boolean): Promise<void> {
  await prisma.forceJoinChannel.update({ where: { id }, data: { isActive } });
}

async function resetChannelHealth(id: string): Promise<void> {
  await prisma.forceJoinChannel.update({
    where: { id },
    data: {
      isActive: true,
      healthFailureCount: 0,
      healthFailureFirstAt: null,
      healthFailureLastAt: null,
      unhealthyAt: null,
      lastValidationErrorCode: null,
    },
  });
}

/** Marks the user a member of every listed chat. */
function joinAll(telegramId: bigint, chatIds: bigint[]): void {
  for (const chatId of chatIds) {
    script.members.set(`${chatId}:${telegramId}`, "member");
  }
}

const describeDb = hasDb ? describe : describe.skip;

describeDb("mini app force join gate", () => {
  beforeAll(async () => {
    memberUserId = await createUser(MEMBER_TELEGRAM_ID, false);
    outsiderUserId = await createUser(OUTSIDER_TELEGRAM_ID, false);
    bypassUserId = await createUser(BYPASS_TELEGRAM_ID, true);
    channelAId = await createChannel(CHANNEL_A_CHAT_ID, "Channel A", 1);
    channelBId = await createChannel(CHANNEL_B_CHAT_ID, "Channel B", 2);
    await setForceJoinEnabled(true);
    // Terms and maintenance must not interfere with what this suite measures.
    await prisma.setting.upsert({
      where: { key: "terms_required" },
      update: { value: "false", type: "BOOLEAN" },
      create: { key: "terms_required", value: "false", type: "BOOLEAN" },
    });
    await prisma.setting.upsert({
      where: { key: "maintenance_mode" },
      update: { value: "false", type: "BOOLEAN" },
      create: { key: "maintenance_mode", value: "false", type: "BOOLEAN" },
    });
  });

  afterAll(async () => {
    resetForceJoinRedisForTests();
    await prisma.forceJoinChannel.deleteMany({
      where: { id: { in: [channelAId, channelBId].filter((id) => id !== "") } },
    });
    await prisma.user.deleteMany({
      where: { telegramId: { in: [MEMBER_TELEGRAM_ID, OUTSIDER_TELEGRAM_ID, BYPASS_TELEGRAM_ID] } },
    });
    await setForceJoinEnabled(false);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetChannelHealth(channelAId);
    await resetChannelHealth(channelBId);
    await setForceJoinEnabled(true);
  });

  it("FJ01 admits a user who is a member of every active channel", async () => {
    resetScript();
    joinAll(MEMBER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID, CHANNEL_B_CHAT_ID]);
    installFetchStub();

    const result = await evaluateMiniAppAccess(memberUserId);
    expect(result.ok).toBe(true);
    // Both channels were actually asked about — not one, and not zero.
    expect(new Set(script.calls.map((c) => c.chatId))).toEqual(
      new Set([String(CHANNEL_A_CHAT_ID), String(CHANNEL_B_CHAT_ID)]),
    );
  });

  it("FJ02 accepts every joined status the bot accepts, and only those", async () => {
    resetScript();
    // `creator` is a membership status too — an owner of the channel is
    // obviously a member, and the bot's shared classifier says so.
    script.members.set(`${CHANNEL_A_CHAT_ID}:${MEMBER_TELEGRAM_ID}`, "creator");
    script.members.set(`${CHANNEL_B_CHAT_ID}:${MEMBER_TELEGRAM_ID}`, "member");
    installFetchStub();
    expect((await evaluateMiniAppAccess(memberUserId)).ok).toBe(true);
  });

  it("FJ03 refuses a user missing exactly one active channel", async () => {
    resetScript();
    joinAll(OUTSIDER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID]); // B deliberately left
    installFetchStub();

    const result = await evaluateMiniAppAccess(outsiderUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FORCE_JOIN_REQUIRED");
      expect(result.status).toBe(403);
      // The user is told the bot can help — the channel list lives there.
      expect(result.requiresBot).toBe(true);
    }
  });

  it("FJ04 admits the same user once they join, with no other action", async () => {
    resetScript();
    joinAll(OUTSIDER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID]);
    installFetchStub();
    expect((await evaluateMiniAppAccess(outsiderUserId)).ok).toBe(false);

    // The ONLY thing that changes is the fact on Telegram's side. No cookie is
    // reissued, no flag is written, nothing is sent from the frontend.
    joinAll(OUTSIDER_TELEGRAM_ID, [CHANNEL_B_CHAT_ID]);
    expect((await evaluateMiniAppAccess(outsiderUserId)).ok).toBe(true);

    // ...and leaving again refuses again: the verdict tracks the live fact.
    script.members.set(`${CHANNEL_B_CHAT_ID}:${OUTSIDER_TELEGRAM_ID}`, "left");
    expect((await evaluateMiniAppAccess(outsiderUserId)).ok).toBe(false);
  });

  it("FJ05 short-circuits for a user with the operator bypass", async () => {
    resetScript();
    // A member of nothing.
    installFetchStub();
    const result = await evaluateMiniAppAccess(bypassUserId);
    expect(result.ok).toBe(true);
    // The bypass is checked BEFORE any Telegram traffic, so an operator's own
    // access does not depend on the Bot API being reachable.
    expect(script.calls).toHaveLength(0);
  });

  it("FJ06 fails closed on a transient Telegram failure", async () => {
    resetScript();
    joinAll(MEMBER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID]);
    // 429 and 5xx are the classifier's TEMP cases.
    script.failures.set(String(CHANNEL_B_CHAT_ID), {
      status: 429,
      description: "Too Many Requests: retry after 3",
    });
    installFetchStub();

    const result = await evaluateMiniAppAccess(memberUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // NOT "you are not a member" — the server does not know, and says so with
      // a retryable code rather than an accusation.
      expect(result.code).toBe("ACCESS_CHECK_UNAVAILABLE");
      expect(result.status).toBe(503);
    }
  });

  it("FJ07 fails closed when the socket dies with no HTTP response at all", async () => {
    resetScript();
    joinAll(MEMBER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID]);
    script.networkFailures.add(String(CHANNEL_B_CHAT_ID));
    installFetchStub();

    const result = await evaluateMiniAppAccess(memberUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ACCESS_CHECK_UNAVAILABLE");
    }
  });

  it("FJ08 excludes an unverifiable channel from gating, exactly as the bot does", async () => {
    resetScript();
    joinAll(MEMBER_TELEGRAM_ID, [CHANNEL_A_CHAT_ID]);
    // The BOT lost access to channel B. That is a configuration fault, and D4
    // says it must never brick users — the channel drops out of the decision.
    script.failures.set(String(CHANNEL_B_CHAT_ID), {
      status: 400,
      description: "Bad Request: member list is inaccessible",
    });
    installFetchStub();

    expect((await evaluateMiniAppAccess(memberUserId)).ok).toBe(true);

    // ...and the fault is recorded durably, so the operator eventually learns.
    const row = await prisma.forceJoinChannel.findUnique({ where: { id: channelBId } });
    expect(row?.lastValidationErrorCode).toBe("UNVERIFIABLE");
    expect(row?.healthFailureCount).toBeGreaterThan(0);
  });

  it("FJ09 still refuses when a verifiable channel is missing, unverifiable siblings aside", async () => {
    resetScript();
    // Channel A is verifiable and the user is NOT in it; channel B is broken.
    // An excluded channel must not launder a genuine miss into a pass.
    script.failures.set(String(CHANNEL_B_CHAT_ID), {
      status: 400,
      description: "Bad Request: chat not found",
    });
    installFetchStub();

    const result = await evaluateMiniAppAccess(outsiderUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FORCE_JOIN_REQUIRED");
    }
  });

  it("FJ10 never treats an unverified claim, cookie or stored flag as membership", async () => {
    // There is nowhere for a membership claim to enter: `evaluateMiniAppAccess`
    // takes one argument, a database user id. No initData, no request, no
    // header, no body reaches this function — so a frontend cannot assert
    // membership even in principle.
    expect(evaluateMiniAppAccess.length).toBe(1);

    resetScript();
    installFetchStub();
    const denied = await evaluateMiniAppAccess(outsiderUserId);
    expect(denied.ok).toBe(false);

    // The user row carries no "verified" column the gate could be satisfied by:
    // the only per-user escape is the operator-set bypass, and the only other
    // input is live Telegram state.
    const row = await prisma.user.findUnique({ where: { id: outsiderUserId } });
    expect(row?.forceJoinBypass).toBe(false);
    expect(script.calls.length).toBeGreaterThan(0);
  });

  it("FJ11 passes when the switch is off, and when it is on with no active channel", async () => {
    resetScript();
    installFetchStub();

    await setForceJoinEnabled(false);
    expect((await evaluateMiniAppAccess(outsiderUserId)).ok).toBe(true);
    expect(script.calls).toHaveLength(0); // no Telegram traffic when disabled

    // Enabled with zero active channels enforces nothing (D4) — the same
    // conclusion the bot's `resolveForceJoinGate` reaches.
    await setForceJoinEnabled(true);
    await setChannelActive(channelAId, false);
    await setChannelActive(channelBId, false);
    expect((await evaluateMiniAppAccess(outsiderUserId)).ok).toBe(true);
    expect(script.calls).toHaveLength(0);
  });

  it("FJ12 refuses when no bot token is configured, rather than admitting everyone", async () => {
    resetScript();
    installFetchStub();
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BOT_TOKEN;
    try {
      const result = await evaluateMiniAppAccess(outsiderUserId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Membership is UNKNOWABLE without a token. That is uncertainty, not
        // satisfaction — and definitely not a reason to open the gate.
        expect(result.code).toBe("ACCESS_CHECK_UNAVAILABLE");
      }
      expect(script.calls).toHaveLength(0);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });
});

// =============================================================================
// FJ13: grammY must not enter the API.
//
// The whole reason the checker was extracted into `@zedbot/force-join` is that
// the API cannot import the bot. A comment saying so is worth nothing — one
// `import { Api } from "grammy"` would pull the bot runtime into the HTTP
// process, and nothing else in the suite would notice. This walks the real
// dependency closure from `apps/api`'s manifest and reads the real sources.
// =============================================================================

describe("api dependency isolation", () => {
  const repoRoot = new URL("../../../", import.meta.url);

  async function manifest(pkgDir: string): Promise<{
    name?: string;
    dependencies?: Record<string, string>;
  }> {
    const raw = await readFile(new URL(`${pkgDir}/package.json`, repoRoot), "utf8");
    return JSON.parse(raw) as { name?: string; dependencies?: Record<string, string> };
  }

  /** Workspace package name → directory, for every app and package. */
  async function workspaceDirs(): Promise<Map<string, string>> {
    const dirs = new Map<string, string>();
    for (const group of ["apps", "packages"]) {
      const entries = await readdir(new URL(`${group}/`, repoRoot), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const pkg = await manifest(`${group}/${entry.name}`);
          if (typeof pkg.name === "string") {
            dirs.set(pkg.name, `${group}/${entry.name}`);
          }
        } catch {
          // Not a workspace package.
        }
      }
    }
    return dirs;
  }

  it("FJ13 grammy stays out of the API's own manifest closure (the one sanctioned edge is @zedbot/bot)", async () => {
    const dirs = await workspaceDirs();
    // miniapp-commerce-parity: @zedbot/api now declares @zedbot/bot ON PURPOSE
    // — the two transports share one commerce authority (§4), and the bot's
    // service layer is that authority. The manifest closure therefore contains
    // grammy THROUGH @zedbot/bot, and manifests stop being a usable proxy for
    // "grammY entered the API". The load-bearing guarantee moved to
    // miniapp-import-graph.test.ts, which walks the RUNTIME import graph of
    // apps/api/src (through the bot's sources) and fails on any grammy value
    // import, bot handler, keyboard or *-views module. What this test still
    // pins: the api itself and every OTHER workspace package it uses must not
    // declare grammy — only the sanctioned @zedbot/bot edge may carry it.
    const seen = new Set<string>();
    const queue = ["@zedbot/api"];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const dir = dirs.get(name);
      if (dir === undefined) {
        continue;
      }
      if (name !== "@zedbot/bot") {
        const deps = Object.keys((await manifest(dir)).dependencies ?? {});
        expect(deps.filter((d) => d.includes("grammy")), name).toEqual([]);
        for (const dep of deps) {
          queue.push(dep);
        }
      }
    }
    expect(seen.has("@zedbot/force-join")).toBe(true); // the extraction is real
    expect(seen.has("@zedbot/bot")).toBe(true); // the shared authority is real
  });

  it("FJ13b has no grammy import anywhere in the API or the shared force-join package", async () => {
    for (const dir of ["apps/api/src", "packages/force-join/src"]) {
      const root = fileURLToPath(new URL(`${dir}/`, repoRoot));
      const names = await readdir(root, { recursive: true });
      let checked = 0;
      for (const name of names) {
        if (!name.endsWith(".ts")) continue;
        checked += 1;
        const source = await readFile(join(root, name), "utf8");
        expect(source, `${dir}/${name}`).not.toMatch(/from\s+["']grammy/);
        expect(source, `${dir}/${name}`).not.toMatch(/require\(["']grammy/);
      }
      expect(checked, dir).toBeGreaterThan(0);
    }
  });
});
