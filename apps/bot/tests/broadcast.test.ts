import { prisma, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase33-test-secret-phase33-test-secret";

import {
  BROADCAST_ALREADY_STARTED_TEXT,
  BROADCAST_TEXT_MAX,
  broadcastAudience,
  createBroadcastDraft,
  estimateAudienceCount,
  getBroadcastByShortId,
  getBroadcastProgress,
  INVALID_BROADCAST_TEXT,
  listBroadcasts,
  parseBroadcastAudience,
  sendBroadcastTest,
  startBroadcast,
  TEST_ONLY_NO_START_TEXT,
} from "../src/services/broadcast.service.js";

// =============================================================================
// Phase 33 broadcast: audience estimates (delta-based - the shared DB holds
// other suites' users), draft validation, test send, the full send loop
// with per-recipient results, duplicate-start protection and pagination.
// Skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

describe.runIf(hasDb)("admin text broadcast (Phase 33)", () => {
  let adminId: string;
  let adminTid: bigint;
  let seq = 0n;

  function recorder(failChatIds: string[] = []) {
    const calls: Array<{ chatId: string; text: string }> = [];
    return {
      calls,
      api: {
        sendMessage: async (chatId: string, text: string): Promise<unknown> => {
          if (failChatIds.includes(chatId)) {
            throw new Error("Forbidden: bot was blocked by the user");
          }
          calls.push({ chatId, text });
          return {};
        },
      },
    };
  }

  async function createUser(status: "ACTIVE" | "BLOCKED" = "ACTIVE"): Promise<User> {
    seq += 1n;
    return prisma.user.create({ data: { telegramId: runTag + 950n + seq, status } });
  }

  beforeAll(async () => {
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 944n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
    adminTid = admin.telegramId;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("parses audiences and rejects unknown keys", () => {
    expect(parseBroadcastAudience("buyers")).toBe("buyers");
    expect(parseBroadcastAudience("everyone")).toBeNull();
    expect(parseBroadcastAudience("")).toBeNull();
  });

  it("estimates: active counted, blocked excluded, buyers vs no_purchase split", async () => {
    const before = {
      allActive: await estimateAudienceCount("all_active"),
      buyers: await estimateAudienceCount("buyers"),
      noPurchase: await estimateAudienceCount("no_purchase"),
    };
    const buyer = await createUser();
    await prisma.order.create({
      data: {
        userId: buyer.id,
        type: "SERVICE_PURCHASE",
        status: "COMPLETED",
        finalPriceToman: 100_000,
        paidAt: new Date(),
        completedAt: new Date(),
      },
    });
    await createUser(); // active, no purchase
    await createUser("BLOCKED"); // never counted anywhere

    expect(await estimateAudienceCount("all_active")).toBe(before.allActive + 2);
    expect(await estimateAudienceCount("buyers")).toBe(before.buyers + 1);
    expect(await estimateAudienceCount("no_purchase")).toBe(before.noPurchase + 1);
    expect(await estimateAudienceCount("test_only")).toBe(0);
  });

  it("active_services counts ACTIVE/LIMITED services only", async () => {
    const before = await estimateAudienceCount("active_services");
    const panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `p33-panel-${runTag}`, baseUrl: "https://example.test" },
    });
    const withActive = await createUser();
    await prisma.service.create({
      data: {
        userId: withActive.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `p33-act-${runTag}`,
        status: "ACTIVE",
      },
    });
    const withExpired = await createUser();
    await prisma.service.create({
      data: {
        userId: withExpired.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `p33-exp-${runTag}`,
        status: "EXPIRED",
      },
    });
    expect(await estimateAudienceCount("active_services")).toBe(before + 1);
  });

  it("validates draft text and stores audience/text on the CONFIRMING row", async () => {
    expect(await createBroadcastDraft(adminId, "   ", "buyers")).toEqual({
      ok: false,
      safeMessage: INVALID_BROADCAST_TEXT,
    });
    expect(
      await createBroadcastDraft(adminId, "x".repeat(BROADCAST_TEXT_MAX + 1), "buyers"),
    ).toEqual({ ok: false, safeMessage: INVALID_BROADCAST_TEXT });

    const outcome = await createBroadcastDraft(adminId, `سلام ${runTag}`, "all_active");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.broadcast.status).toBe("CONFIRMING");
    expect(outcome.broadcast.messageText).toBe(`سلام ${runTag}`);
    expect(outcome.broadcast.createdByAdminId).toBe(adminId);
    expect(broadcastAudience(outcome.broadcast)).toBe("all_active");
  });

  it("test send reaches the admin only and creates no recipients", async () => {
    const text = `پیام تستی ${runTag}`;
    const draft = await createBroadcastDraft(adminId, text, "buyers");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const { api, calls } = recorder();
    const outcome = await sendBroadcastTest(api, draft.broadcast.id, adminTid);
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe(adminTid.toString());
    expect(calls[0].text).toBe(text);
    expect(
      await prisma.broadcastRecipient.count({ where: { broadcastId: draft.broadcast.id } }),
    ).toBe(0);
    expect(
      (await prisma.broadcast.findUniqueOrThrow({ where: { id: draft.broadcast.id } })).status,
    ).toBe("CONFIRMING");
  });

  it("startBroadcast: snapshot, one send per target, FAILED marking, COMPLETED", async () => {
    const targetA = await createUser();
    const targetB = await createUser(); // this one blocks the bot
    for (const user of [targetA, targetB]) {
      await prisma.order.create({
        data: {
          userId: user.id,
          type: "SERVICE_PURCHASE",
          status: "PAID",
          finalPriceToman: 50_000,
          paidAt: new Date(),
        },
      });
    }
    const text = `اعلان خریداران ${runTag}`;
    const draft = await createBroadcastDraft(adminId, text, "buyers");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const broadcastId = draft.broadcast.id;

    const { api, calls } = recorder([targetB.telegramId.toString()]);
    const result = await startBroadcast(api, broadcastId);
    expect(result.ok).toBe(true);

    const recipients = await prisma.broadcastRecipient.findMany({ where: { broadcastId } });
    expect(result.total).toBe(recipients.length);
    expect((result.sent ?? 0) + (result.failed ?? 0)).toBe(recipients.length);
    // Exactly ONE send per reachable target; the blocked one is FAILED.
    expect(calls.filter((c) => c.chatId === targetA.telegramId.toString())).toHaveLength(1);
    expect(calls.every((c) => c.text === text)).toBe(true);
    const rowA = recipients.find((r) => r.userId === targetA.id);
    const rowB = recipients.find((r) => r.userId === targetB.id);
    expect(rowA?.status).toBe("SENT");
    expect(rowA?.sentAt).not.toBeNull();
    expect(rowB?.status).toBe("FAILED");
    expect(rowB?.errorMessage).toContain("blocked");
    expect(rowB?.errorMessage).not.toContain(text);

    const after = await prisma.broadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
    expect(after.totalTargets).toBe(recipients.length);
    expect(after.sentCount).toBe(result.sent);
    expect(after.failedCount).toBe(result.failed);

    const progress = await getBroadcastProgress(broadcastId);
    expect(progress?.status).toBe("COMPLETED");
    expect(progress?.total).toBe(recipients.length);
    expect(progress?.pending).toBe(0);
    expect((progress?.failed ?? 0)).toBeGreaterThanOrEqual(1);

    // Double start: refused, and NOTHING more is sent.
    const callsBefore = calls.length;
    const again = await startBroadcast(api, broadcastId);
    expect(again).toEqual({ ok: false, safeMessage: BROADCAST_ALREADY_STARTED_TEXT });
    expect(calls.length).toBe(callsBefore);
  });

  it("test_only broadcasts refuse the final start and create nothing", async () => {
    const draft = await createBroadcastDraft(adminId, `فقط تست ${runTag}`, "test_only");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const { api, calls } = recorder();
    const result = await startBroadcast(api, draft.broadcast.id);
    expect(result).toEqual({ ok: false, safeMessage: TEST_ONLY_NO_START_TEXT });
    expect(calls).toHaveLength(0);
    expect(
      await prisma.broadcastRecipient.count({ where: { broadcastId: draft.broadcast.id } }),
    ).toBe(0);
    expect(
      (await prisma.broadcast.findUniqueOrThrow({ where: { id: draft.broadcast.id } })).status,
    ).toBe("CONFIRMING");
  });

  it("lists newest first with pagination bounds; short ids resolve safely", async () => {
    const newest = await prisma.broadcast.create({
      data: {
        type: "SEND",
        status: "CONFIRMING",
        targetFilter: { audience: "buyers" },
        messageText: "newest",
        createdByAdminId: adminId,
        createdAt: new Date(Date.now() + 120_000),
      },
    });
    const page = await listBroadcasts(1);
    expect(page.broadcasts.length).toBeLessThanOrEqual(10);
    expect(page.broadcasts[0].id).toBe(newest.id);
    expect((await listBroadcasts(9999)).page).toBeGreaterThanOrEqual(1);

    expect(await getBroadcastByShortId(newest.id.slice(0, 8))).not.toBeNull();
    expect(await getBroadcastByShortId("zzzz")).toBeNull();
    expect(await getBroadcastByShortId("")).toBeNull();
  });
});

describe.skipIf(hasDb)("admin text broadcast (skipped)", () => {
  it("broadcast tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
