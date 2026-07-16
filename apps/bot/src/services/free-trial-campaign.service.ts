import {
  FreeTrialCampaignRecipientStatus,
  FreeTrialClaimStatus,
  FreeTrialResetCampaignStatus,
  Prisma,
  prisma,
  UserStatus,
  type Admin,
  type FreeTrialResetCampaign,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  computeTrialAllowance,
  LIVE_ELIGIBILITY_STATUSES,
} from "./free-trial-entitlement.service.js";
import { writeTrialAudit } from "./free-trial-admin.service.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// Trial-entitlement phase: bulk reset/grant campaigns - the
// "free-trial-entitlement-campaign" queue. The campaign row plus its
// recipient snapshot rows ARE the durable queue: startCampaign snapshots
// the audience once (stable regardless of later user changes), then the
// in-bot loop processes PENDING recipients in small batches. Idempotency is
// three-layered: @@unique([campaignId,userId]) on recipients (one snapshot
// row), @@unique([campaignId,userId]) + idempotencyKey on entitlements (one
// grant), and CAS status flips on the campaign itself. A restart resumes
// exactly where processing stopped; cancellation stops PENDING recipients
// while every already-granted entitlement is preserved. Nothing here ever
// runs synchronously inside a Telegram handler beyond the snapshot insert.
// =============================================================================

export const TRIAL_CAMPAIGN_QUEUE_NAME = "free-trial-entitlement-campaign";
export const CAMPAIGN_BATCH_SIZE = 25;
export const CAMPAIGN_SWEEP_INTERVAL_MS = 15_000;
export const CAMPAIGN_TYPED_CONFIRMATION = "RESET TRIAL";

/** One-time user notice (optional per campaign). */
export const CAMPAIGN_USER_NOTICE_TEXT =
  "امکان دریافت اکانت تست دوباره برای شما فعال شد 🎁\n\nاز منوی اصلی می‌توانید اکانت تست خود را دریافت کنید.";

// --- typed audiences ------------------------------------------------------------------------------

export type CampaignAudience =
  | { kind: "ALL_ACTIVE" }
  | { kind: "WITHOUT_ACTIVE_TRIAL" }
  | { kind: "WITH_PREVIOUS_TRIAL" }
  | { kind: "WITHOUT_SUCCESSFUL_PURCHASE" }
  | { kind: "WITH_SUCCESSFUL_PURCHASE" }
  | { kind: "REGISTERED_BEFORE"; date: string }
  | { kind: "REGISTERED_AFTER"; date: string }
  | { kind: "SELECTED_USERS"; userIds: string[] };

export const CAMPAIGN_AUDIENCE_LABELS: Record<CampaignAudience["kind"], string> = {
  ALL_ACTIVE: "همه کاربران فعال",
  WITHOUT_ACTIVE_TRIAL: "کاربران بدون تست فعال",
  WITH_PREVIOUS_TRIAL: "کاربرانی که قبلاً تست گرفته‌اند",
  WITHOUT_SUCCESSFUL_PURCHASE: "کاربران بدون خرید موفق",
  WITH_SUCCESSFUL_PURCHASE: "کاربران دارای خرید موفق",
  REGISTERED_BEFORE: "کاربران ثبت‌نام‌شده قبل از تاریخ مشخص",
  REGISTERED_AFTER: "کاربران ثبت‌نام‌شده بعد از تاریخ مشخص",
  SELECTED_USERS: "فقط کاربران انتخاب‌شده",
};

/** Validates the stored JSON back into a typed audience (never raw SQL). */
export function parseCampaignAudience(raw: unknown): CampaignAudience | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case "ALL_ACTIVE":
    case "WITHOUT_ACTIVE_TRIAL":
    case "WITH_PREVIOUS_TRIAL":
    case "WITHOUT_SUCCESSFUL_PURCHASE":
    case "WITH_SUCCESSFUL_PURCHASE":
      return { kind: value.kind };
    case "REGISTERED_BEFORE":
    case "REGISTERED_AFTER": {
      const date = typeof value.date === "string" ? value.date : "";
      return Number.isNaN(Date.parse(date)) ? null : { kind: value.kind, date };
    }
    case "SELECTED_USERS": {
      if (!Array.isArray(value.userIds)) {
        return null;
      }
      const userIds = value.userIds.filter((id): id is string => typeof id === "string");
      return userIds.length === 0 ? null : { kind: "SELECTED_USERS", userIds };
    }
    default:
      return null;
  }
}

/** Typed, validated audience -> Prisma where (ACTIVE users only, always). */
export function campaignAudienceWhere(audience: CampaignAudience): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { status: UserStatus.ACTIVE };
  switch (audience.kind) {
    case "ALL_ACTIVE":
      return base;
    case "WITHOUT_ACTIVE_TRIAL":
      return {
        ...base,
        freeTrialClaims: { none: { status: FreeTrialClaimStatus.ACTIVE } },
      };
    case "WITH_PREVIOUS_TRIAL":
      return { ...base, freeTrialClaims: { some: {} } };
    case "WITHOUT_SUCCESSFUL_PURCHASE":
      return { ...base, paidOrdersCount: 0 };
    case "WITH_SUCCESSFUL_PURCHASE":
      return { ...base, paidOrdersCount: { gt: 0 } };
    case "REGISTERED_BEFORE":
      return { ...base, createdAt: { lt: new Date(audience.date) } };
    case "REGISTERED_AFTER":
      return { ...base, createdAt: { gt: new Date(audience.date) } };
    case "SELECTED_USERS":
      return { ...base, id: { in: audience.userIds } };
  }
}

// --- draft / preview -------------------------------------------------------------------------------

export interface CreateCampaignInput {
  admin: Pick<Admin, "id" | "telegramId">;
  allowance: number;
  audience: CampaignAudience;
  reason: string;
  expiresAt?: Date | null;
  notifyUsers: boolean;
  includeUsersWithAllowance: boolean;
}

export async function createCampaignDraft(
  input: CreateCampaignInput,
): Promise<FreeTrialResetCampaign> {
  const campaign = await prisma.freeTrialResetCampaign.create({
    data: {
      status: FreeTrialResetCampaignStatus.DRAFT,
      allowance: input.allowance,
      audience: input.audience as unknown as Prisma.InputJsonValue,
      reason: input.reason.trim().slice(0, 500),
      expiresAt: input.expiresAt ?? null,
      notifyUsers: input.notifyUsers,
      includeUsersWithAllowance: input.includeUsersWithAllowance,
      createdByAdminId: input.admin.id,
    },
  });
  await writeTrialAudit(input.admin, "trial.campaign.created", {
    type: "FreeTrialResetCampaign",
    id: campaign.id,
  }, {
    allowance: input.allowance,
    audience: input.audience.kind,
    notifyUsers: input.notifyUsers,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    reason: campaign.reason,
  });
  return campaign;
}

/** Counts the audience and stamps PREVIEWED + estimatedUsers. */
export async function previewCampaign(
  campaignId: string,
  admin: Pick<Admin, "id" | "telegramId">,
): Promise<{ campaign: FreeTrialResetCampaign; estimated: number } | null> {
  const campaign = await prisma.freeTrialResetCampaign.findUnique({ where: { id: campaignId } });
  if (campaign === null) {
    return null;
  }
  const audience = parseCampaignAudience(campaign.audience);
  if (audience === null) {
    return null;
  }
  const estimated = await prisma.user.count({ where: campaignAudienceWhere(audience) });
  const updated = await prisma.freeTrialResetCampaign.update({
    where: { id: campaignId },
    data: {
      estimatedUsers: estimated,
      status:
        campaign.status === FreeTrialResetCampaignStatus.DRAFT
          ? FreeTrialResetCampaignStatus.PREVIEWED
          : campaign.status,
    },
  });
  await writeTrialAudit(admin, "trial.campaign.previewed", {
    type: "FreeTrialResetCampaign",
    id: campaignId,
  }, { estimated });
  return { campaign: updated, estimated };
}

// --- start / cancel --------------------------------------------------------------------------------

/**
 * Confirms the campaign: snapshots the audience as PENDING recipient rows
 * (stable - later user changes never add recipients) and flips the status
 * to QUEUED for the loop. CAS start guard: only PREVIEWED campaigns start,
 * a double confirmation is a no-op.
 */
export async function startCampaign(
  campaignId: string,
  admin: Pick<Admin, "id" | "telegramId">,
): Promise<{ ok: boolean; total: number }> {
  const claimed = await prisma.freeTrialResetCampaign.updateMany({
    where: { id: campaignId, status: FreeTrialResetCampaignStatus.PREVIEWED },
    data: { status: FreeTrialResetCampaignStatus.QUEUED },
  });
  if (claimed.count !== 1) {
    return { ok: false, total: 0 };
  }
  const campaign = await prisma.freeTrialResetCampaign.findUniqueOrThrow({
    where: { id: campaignId },
  });
  const audience = parseCampaignAudience(campaign.audience);
  if (audience === null) {
    await prisma.freeTrialResetCampaign.update({
      where: { id: campaignId },
      data: { status: FreeTrialResetCampaignStatus.FAILED },
    });
    return { ok: false, total: 0 };
  }
  // Snapshot in id-ordered pages; skipDuplicates + the unique index make a
  // crashed/re-run snapshot converge on exactly one row per user.
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const users = await prisma.user.findMany({
      where: campaignAudienceWhere(audience),
      select: { id: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (users.length === 0) {
      break;
    }
    cursor = users[users.length - 1].id;
    const inserted = await prisma.freeTrialCampaignRecipient.createMany({
      data: users.map((user) => ({ campaignId, userId: user.id })),
      skipDuplicates: true,
    });
    total += inserted.count;
  }
  const snapshotTotal = await prisma.freeTrialCampaignRecipient.count({ where: { campaignId } });
  await prisma.freeTrialResetCampaign.update({
    where: { id: campaignId },
    data: { totalUsers: snapshotTotal },
  });
  await writeTrialAudit(admin, "trial.campaign.started", {
    type: "FreeTrialResetCampaign",
    id: campaignId,
  }, { totalUsers: snapshotTotal });
  logger.info("trial campaign queued", { campaignId, totalUsers: snapshotTotal, inserted: total });
  return { ok: true, total: snapshotTotal };
}

/** Stops FUTURE grants; everything already granted is preserved. */
export async function cancelCampaign(
  campaignId: string,
  admin: Pick<Admin, "id" | "telegramId">,
): Promise<boolean> {
  const cancelled = await prisma.freeTrialResetCampaign.updateMany({
    where: {
      id: campaignId,
      status: {
        in: [
          FreeTrialResetCampaignStatus.DRAFT,
          FreeTrialResetCampaignStatus.PREVIEWED,
          FreeTrialResetCampaignStatus.QUEUED,
          FreeTrialResetCampaignStatus.RUNNING,
        ],
      },
    },
    data: { status: FreeTrialResetCampaignStatus.CANCELLED, cancelledAt: new Date() },
  });
  if (cancelled.count === 1) {
    await writeTrialAudit(admin, "trial.campaign.cancelled", {
      type: "FreeTrialResetCampaign",
      id: campaignId,
    }, {});
  }
  return cancelled.count === 1;
}

// --- processing loop -------------------------------------------------------------------------------

/** Default skip rules, evaluated per recipient AT PROCESSING TIME. */
async function classifyRecipient(
  campaign: FreeTrialResetCampaign,
  userId: string,
): Promise<{ skip: false } | { skip: true; reason: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null || user.status !== UserStatus.ACTIVE) {
    return { skip: true, reason: "user-not-active" };
  }
  const live = await prisma.freeTrialClaim.findFirst({
    where: { userId, status: { in: LIVE_ELIGIBILITY_STATUSES } },
    select: { id: true },
  });
  if (live !== null) {
    return { skip: true, reason: "claim-in-progress" };
  }
  const activeTrial = await prisma.freeTrialClaim.findFirst({
    where: { userId, status: FreeTrialClaimStatus.ACTIVE },
    select: { id: true },
  });
  if (activeTrial !== null) {
    return { skip: true, reason: "active-trial" };
  }
  if (!campaign.includeUsersWithAllowance) {
    const allowance = await computeTrialAllowance(user);
    if (allowance.totalRemaining === null || allowance.totalRemaining >= campaign.allowance) {
      return { skip: true, reason: "has-allowance" };
    }
  }
  return { skip: false };
}

/**
 * Processes ONE batch of PENDING recipients for one QUEUED/RUNNING
 * campaign. Returns true when any work was done. Grant idempotency is the
 * DB unique pair (campaignId,userId) plus the explicit idempotency key -
 * a retried batch can never double-grant; notification idempotency is the
 * notifiedAt CAS, and a failed send never rolls the grant back.
 */
export async function processCampaignBatch(
  api: DeliverySendApi,
  batchSize: number = CAMPAIGN_BATCH_SIZE,
): Promise<boolean> {
  const campaign = await prisma.freeTrialResetCampaign.findFirst({
    where: {
      status: {
        in: [FreeTrialResetCampaignStatus.QUEUED, FreeTrialResetCampaignStatus.RUNNING],
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (campaign === null) {
    return false;
  }
  if (campaign.status === FreeTrialResetCampaignStatus.QUEUED) {
    await prisma.freeTrialResetCampaign.updateMany({
      where: { id: campaign.id, status: FreeTrialResetCampaignStatus.QUEUED },
      data: { status: FreeTrialResetCampaignStatus.RUNNING, startedAt: new Date() },
    });
  }
  const pending = await prisma.freeTrialCampaignRecipient.findMany({
    where: { campaignId: campaign.id, status: FreeTrialCampaignRecipientStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    include: { user: { select: { telegramId: true } } },
  });
  if (pending.length === 0) {
    const done = await prisma.freeTrialResetCampaign.updateMany({
      where: { id: campaign.id, status: FreeTrialResetCampaignStatus.RUNNING },
      data: { status: FreeTrialResetCampaignStatus.COMPLETED, completedAt: new Date() },
    });
    if (done.count === 1) {
      logger.info("trial campaign completed", { campaignId: campaign.id });
    }
    return true;
  }
  let granted = 0;
  let skipped = 0;
  let failed = 0;
  for (const recipient of pending) {
    // Cancellation check per recipient: stop before the NEXT grant.
    const fresh = await prisma.freeTrialResetCampaign.findUnique({
      where: { id: campaign.id },
      select: { status: true },
    });
    if (fresh?.status !== FreeTrialResetCampaignStatus.RUNNING) {
      break;
    }
    try {
      const verdict = await classifyRecipient(campaign, recipient.userId);
      if (verdict.skip) {
        await prisma.freeTrialCampaignRecipient.updateMany({
          where: { id: recipient.id, status: FreeTrialCampaignRecipientStatus.PENDING },
          data: {
            status: FreeTrialCampaignRecipientStatus.SKIPPED,
            skipReason: verdict.reason,
            processedAt: new Date(),
          },
        });
        skipped += 1;
        continue;
      }
      let entitlementId: string;
      try {
        const entitlement = await prisma.freeTrialEntitlement.create({
          data: {
            userId: recipient.userId,
            allowance: campaign.allowance,
            scope: "GLOBAL",
            source: "CAMPAIGN_RESET",
            expiresAt: campaign.expiresAt,
            reason: campaign.reason,
            createdByAdminId: campaign.createdByAdminId,
            campaignId: campaign.id,
            idempotencyKey: `trial-campaign:${campaign.id}:${recipient.userId}`,
          },
        });
        entitlementId = entitlement.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // A previous attempt already granted - converge, never duplicate.
          const existing = await prisma.freeTrialEntitlement.findFirstOrThrow({
            where: { campaignId: campaign.id, userId: recipient.userId },
            select: { id: true },
          });
          entitlementId = existing.id;
        } else {
          throw err;
        }
      }
      await prisma.freeTrialCampaignRecipient.updateMany({
        where: { id: recipient.id, status: FreeTrialCampaignRecipientStatus.PENDING },
        data: {
          status: FreeTrialCampaignRecipientStatus.GRANTED,
          entitlementId,
          processedAt: new Date(),
        },
      });
      granted += 1;
      if (campaign.notifyUsers) {
        // Notification is idempotent (notifiedAt CAS) and never rolls the
        // grant back on failure.
        const stamped = await prisma.freeTrialCampaignRecipient.updateMany({
          where: { id: recipient.id, notifiedAt: null },
          data: { notifiedAt: new Date() },
        });
        if (stamped.count === 1) {
          try {
            await api.sendMessage(recipient.user.telegramId.toString(), CAMPAIGN_USER_NOTICE_TEXT);
          } catch (err) {
            logger.warn("trial campaign notification failed", {
              campaignId: campaign.id,
              error: errorMessage(err),
            });
          }
        }
      }
    } catch (err) {
      failed += 1;
      await prisma.freeTrialCampaignRecipient.updateMany({
        where: { id: recipient.id, status: FreeTrialCampaignRecipientStatus.PENDING },
        data: {
          status: FreeTrialCampaignRecipientStatus.FAILED,
          errorMessage: errorMessage(err).slice(0, 200),
          processedAt: new Date(),
        },
      });
      logger.error("trial campaign recipient failed", {
        campaignId: campaign.id,
        recipientId: recipient.id,
        error: errorMessage(err),
      });
    }
  }
  const processedNow = granted + skipped + failed;
  if (processedNow > 0) {
    await prisma.freeTrialResetCampaign.update({
      where: { id: campaign.id },
      data: {
        processedUsers: { increment: processedNow },
        grantedUsers: { increment: granted },
        skippedUsers: { increment: skipped },
        failedUsers: { increment: failed },
      },
    });
  }
  return true;
}

/**
 * The free-trial-entitlement-campaign loop: the same in-bot, never-throws,
 * self-rescheduling pattern as the settlement and trial sweeps (the worker
 * app is a placeholder with no bot API - the campaign/recipient rows are
 * the durable queue, so restarts resume automatically).
 */
export function startFreeTrialCampaignLoop(api: DeliverySendApi): void {
  const tick = (): void => {
    void processCampaignBatch(api)
      .catch((err: unknown) => {
        logger.error("trial campaign sweep rejected", { error: errorMessage(err) });
      })
      .finally(() => {
        setTimeout(tick, CAMPAIGN_SWEEP_INTERVAL_MS).unref();
      });
  };
  setTimeout(tick, CAMPAIGN_SWEEP_INTERVAL_MS).unref();
}

// --- listing / detail -------------------------------------------------------------------------------

export const CAMPAIGN_PAGE_SIZE = 5;

export interface CampaignPage {
  campaigns: FreeTrialResetCampaign[];
  page: number;
  pages: number;
  total: number;
}

export async function listCampaigns(page: number): Promise<CampaignPage> {
  const total = await prisma.freeTrialResetCampaign.count();
  const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const campaigns = await prisma.freeTrialResetCampaign.findMany({
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * CAMPAIGN_PAGE_SIZE,
    take: CAMPAIGN_PAGE_SIZE,
  });
  return { campaigns, page: safePage, pages, total };
}

export async function getCampaignByShortId(
  shortId: string,
): Promise<FreeTrialResetCampaign | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.freeTrialResetCampaign.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}
