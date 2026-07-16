import {
  FreeTrialClaimStatus,
  FreeTrialResetCampaignStatus,
  prisma,
  type Panel,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "trial-campaign-tests-secret-01";

import {
  CAMPAIGN_USER_NOTICE_TEXT,
  cancelCampaign,
  createCampaignDraft,
  campaignAudienceWhere,
  parseCampaignAudience,
  previewCampaign,
  processCampaignBatch,
  startCampaign,
  type CampaignAudience,
} from "../src/services/free-trial-campaign.service.js";
import { computeTrialAllowance } from "../src/services/free-trial-entitlement.service.js";

// =============================================================================
// Trial reset campaigns (free-trial-entitlement-campaign queue): typed
// audiences, preview-creates-nothing, stable snapshots, per-user
// idempotency, batch processing with retry/resume/cancel semantics, default
// skip rules and idempotent notifications. Pure DB suite - grants only, no
// panel calls.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

let admin = { id: "", telegramId: 0n };
let panel: Panel;

interface FakeApi {
  sent: { chatId: string; text: string }[];
  failNext: boolean;
  sendMessage(chatId: string | number, text: string): Promise<unknown>;
}
const fakeApi: FakeApi = {
  sent: [],
  failNext: false,
  async sendMessage(chatId: string | number, text: string): Promise<unknown> {
    if (fakeApi.failNext) {
      fakeApi.failNext = false;
      throw new Error("telegram send failed");
    }
    fakeApi.sent.push({ chatId: String(chatId), text });
    return {};
  },
};

async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
}

/** Runs batches until the campaign leaves QUEUED/RUNNING (bounded). */
async function drainCampaigns(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const busy = await prisma.freeTrialResetCampaign.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (busy === 0) {
      return;
    }
    await processCampaignBatch(fakeApi, 10);
  }
  throw new Error("campaigns did not drain");
}

describe.runIf(hasDb)("trial reset campaigns", () => {
  beforeAll(async () => {
    const adminRow = await prisma.admin.create({
      data: { telegramId: runTag + 910_000_000n, role: "OWNER", isActive: true },
    });
    admin = { id: adminRow.id, telegramId: adminRow.telegramId };
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `tc-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        username: "admin",
        passwordEncrypted: encryptSecret("x"),
        status: "ACTIVE",
      },
    });
  });

  afterAll(async () => {
    // Never leave a QUEUED/RUNNING campaign behind for other suites.
    await prisma.freeTrialResetCampaign.updateMany({
      where: { status: { in: ["DRAFT", "PREVIEWED", "QUEUED", "RUNNING"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await prisma.$disconnect();
  });

  it("1-3. audiences are typed and validated; arbitrary payloads are rejected (never SQL)", async () => {
    expect(parseCampaignAudience({ kind: "ALL_ACTIVE" })).toEqual({ kind: "ALL_ACTIVE" });
    expect(parseCampaignAudience({ kind: "REGISTERED_BEFORE", date: "2026-01-01" })).toEqual({
      kind: "REGISTERED_BEFORE",
      date: "2026-01-01",
    });
    expect(parseCampaignAudience({ kind: "REGISTERED_BEFORE", date: "DROP TABLE" })).toBeNull();
    expect(parseCampaignAudience({ kind: "SELECTED_USERS", userIds: [] })).toBeNull();
    expect(parseCampaignAudience({ kind: "EVIL; DELETE" })).toBeNull();
    expect(parseCampaignAudience("raw sql")).toBeNull();
    // Audience filters always pin ACTIVE users.
    const where = campaignAudienceWhere({ kind: "WITHOUT_SUCCESSFUL_PURCHASE" });
    expect(where.status).toBe("ACTIVE");
    expect(where.paidOrdersCount).toBe(0);
  });

  it("4-9. preview creates nothing; start snapshots once; batches grant exactly once per user", async () => {
    const users = await Promise.all([createUser(), createUser(), createUser()]);
    const audience: CampaignAudience = {
      kind: "SELECTED_USERS",
      userIds: users.map((u) => u.id),
    };
    const campaign = await createCampaignDraft({
      admin,
      allowance: 2,
      audience,
      reason: "spring reset",
      notifyUsers: true,
      includeUsersWithAllowance: true,
    });
    // Preview: estimate only - zero recipients, zero entitlements (test 79).
    const preview = await previewCampaign(campaign.id, admin);
    expect(preview?.estimated).toBe(3);
    expect(await prisma.freeTrialCampaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(0);

    // Start requires the PREVIEWED status (test 80) and is CAS-idempotent.
    const started = await startCampaign(campaign.id, admin);
    expect(started.ok).toBe(true);
    expect(started.total).toBe(3);
    const doubleStart = await startCampaign(campaign.id, admin);
    expect(doubleStart.ok).toBe(false);

    // Snapshot is stable: a user created AFTER start never joins (test 81).
    await createUser();
    expect(await prisma.freeTrialCampaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(3);

    fakeApi.sent.length = 0;
    await drainCampaigns();
    const done = await prisma.freeTrialResetCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
    });
    expect(done.status).toBe(FreeTrialResetCampaignStatus.COMPLETED);
    expect(done.grantedUsers).toBe(3);
    expect(done.processedUsers).toBe(3);
    expect(done.failedUsers).toBe(0);

    // Exactly one entitlement per campaign/user (test 82); reprocessing
    // changes nothing (test 83).
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(3);
    await processCampaignBatch(fakeApi, 10);
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(3);

    // Users actually gained allowance.
    const summary = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: users[0].id } }),
    );
    expect(summary.entitlementRemaining).toBe(2);

    // Notification sent once per user (test 89) with the mandated text.
    expect(fakeApi.sent).toHaveLength(3);
    expect(fakeApi.sent[0].text).toBe(CAMPAIGN_USER_NOTICE_TEXT);
  });

  it("10-13. default skip rules: blocked users and active/uncertain claims are skipped", async () => {
    const ok = await createUser();
    const blocked = await createUser({ status: "BLOCKED" });
    const withActive = await createUser();
    await prisma.freeTrialClaim.create({
      data: { userId: withActive.id, panelId: panel.id, status: FreeTrialClaimStatus.ACTIVE },
    });
    const withManual = await createUser();
    await prisma.freeTrialClaim.create({
      data: { userId: withManual.id, panelId: panel.id, status: FreeTrialClaimStatus.MANUAL_REVIEW },
    });
    const campaign = await createCampaignDraft({
      admin,
      allowance: 1,
      audience: {
        kind: "SELECTED_USERS",
        userIds: [ok.id, blocked.id, withActive.id, withManual.id],
      },
      reason: "skip rules",
      notifyUsers: false,
      includeUsersWithAllowance: true,
    });
    await previewCampaign(campaign.id, admin);
    await startCampaign(campaign.id, admin);
    // The snapshot filters ACTIVE users, so the blocked user never enters.
    expect(await prisma.freeTrialCampaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(3);
    await drainCampaigns();
    const rows = await prisma.freeTrialCampaignRecipient.findMany({
      where: { campaignId: campaign.id },
    });
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(ok.id)?.status).toBe("GRANTED");
    expect(byUser.get(withActive.id)?.status).toBe("SKIPPED");
    expect(byUser.get(withActive.id)?.skipReason).toBe("active-trial");
    expect(byUser.get(withManual.id)?.status).toBe("SKIPPED");
    expect(byUser.get(withManual.id)?.skipReason).toBe("claim-in-progress");
    // Blocked users are never notified/granted (test 87).
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it("14-15. users with sufficient unused allowance are skipped unless the OWNER opted in (test 88)", async () => {
    const rich = await createUser();
    // Default allowance (1) is already >= campaign allowance (1) -> skip.
    const campaign = await createCampaignDraft({
      admin,
      allowance: 1,
      audience: { kind: "SELECTED_USERS", userIds: [rich.id] },
      reason: "no double dip",
      notifyUsers: false,
      includeUsersWithAllowance: false,
    });
    await previewCampaign(campaign.id, admin);
    await startCampaign(campaign.id, admin);
    await drainCampaigns();
    const row = await prisma.freeTrialCampaignRecipient.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(row.status).toBe("SKIPPED");
    expect(row.skipReason).toBe("has-allowance");
  });

  it("16-18. cancellation stops future grants and preserves completed ones (tests 85/86)", async () => {
    const users = await Promise.all(
      Array.from({ length: 6 }, () => createUser({ freeTrialDefaultAllowanceOverride: 0 })),
    );
    const campaign = await createCampaignDraft({
      admin,
      allowance: 1,
      audience: { kind: "SELECTED_USERS", userIds: users.map((u) => u.id) },
      reason: "cancel mid-flight",
      notifyUsers: false,
      includeUsersWithAllowance: false,
    });
    await previewCampaign(campaign.id, admin);
    await startCampaign(campaign.id, admin);
    // Process a partial batch, then cancel.
    await processCampaignBatch(fakeApi, 2);
    const grantedBefore = await prisma.freeTrialEntitlement.count({
      where: { campaignId: campaign.id },
    });
    expect(grantedBefore).toBeGreaterThan(0);
    expect(await cancelCampaign(campaign.id, admin)).toBe(true);
    await processCampaignBatch(fakeApi, 10); // must not touch this campaign anymore
    const grantedAfter = await prisma.freeTrialEntitlement.count({
      where: { campaignId: campaign.id },
    });
    expect(grantedAfter).toBe(grantedBefore);
    const fresh = await prisma.freeTrialResetCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
    });
    expect(fresh.status).toBe(FreeTrialResetCampaignStatus.CANCELLED);
    // Cancel is not retro-active: existing grants remain rows forever.
    expect(await prisma.freeTrialCampaignRecipient.count({
      where: { campaignId: campaign.id, status: "PENDING" },
    })).toBeGreaterThan(0);
  });

  it("19-20. processing resumes after a 'restart'; notification failure never removes the grant (tests 84/90)", async () => {
    const users = await Promise.all(
      Array.from({ length: 3 }, () => createUser({ freeTrialDefaultAllowanceOverride: 0 })),
    );
    const campaign = await createCampaignDraft({
      admin,
      allowance: 1,
      audience: { kind: "SELECTED_USERS", userIds: users.map((u) => u.id) },
      reason: "resume + notify failure",
      notifyUsers: true,
      includeUsersWithAllowance: false,
    });
    await previewCampaign(campaign.id, admin);
    await startCampaign(campaign.id, admin);
    fakeApi.sent.length = 0;
    fakeApi.failNext = true; // first notification send throws
    await processCampaignBatch(fakeApi, 1); // one recipient processed, send failed
    // The grant survived the failed notification.
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(1);
    // "Restart": a fresh loop instance simply continues off the rows.
    await drainCampaigns();
    const done = await prisma.freeTrialResetCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
    });
    expect(done.status).toBe(FreeTrialResetCampaignStatus.COMPLETED);
    expect(done.grantedUsers).toBe(3);
    // Exactly one entitlement per user regardless of retries (counter test 91).
    expect(await prisma.freeTrialEntitlement.count({ where: { campaignId: campaign.id } })).toBe(3);
    // Two successful notifications (the failed one was already stamped -
    // notification is at-most-once by design, never duplicated).
    expect(fakeApi.sent.length).toBe(2);
  });
});

describe.skipIf(hasDb)("trial reset campaigns (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
