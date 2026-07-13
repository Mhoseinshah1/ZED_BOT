import {
  prisma,
  type Broadcast,
  type BroadcastRecipientStatus,
  type BroadcastStatus,
  type Prisma,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// «پیام همگانی 📣» (Phase 33) - controlled TEXT-ONLY broadcast over the
// pre-existing Broadcast/BroadcastRecipient models (no migration; the
// audience key is stored in Broadcast.targetFilter as {audience}, counts in
// totalTargets/sentCount/failedCount/skippedCount). Flow: draft (CONFIRMING)
// -> optional test send to the admin (no recipient rows) -> status-guarded
// start (DRAFT/CONFIRMING -> RUNNING, so a double click can never send
// twice) -> recipient snapshot (createMany skipDuplicates + the
// [broadcastId,userId] unique = at most one send per user) -> sequential
// batched plain-text sends with per-recipient SENT/FAILED rows -> COMPLETED.
// The send is synchronous (documented); batches are small for rate safety.
// Broadcast text is sent as PLAIN TEXT (no parse mode - nothing to inject).
// Failure logs carry ids and short error strings only, never the text. No
// payment/order/service/support row is touched.
// =============================================================================

export const BROADCAST_TEXT_MIN = 1;
export const BROADCAST_TEXT_MAX = 3500;
export const BROADCAST_PAGE_SIZE = 10;
export const BROADCAST_SEND_BATCH_SIZE = 25;

export const INVALID_BROADCAST_TEXT = `متن پیام باید بین ${BROADCAST_TEXT_MIN} تا ${BROADCAST_TEXT_MAX} کاراکتر باشد.`;
export const INVALID_AUDIENCE_TEXT = "مخاطب انتخاب‌شده معتبر نیست.";
export const BROADCAST_ALREADY_STARTED_TEXT = "این ارسال قبلاً شروع شده است.";
export const TEST_ONLY_NO_START_TEXT =
  "این پیام فقط برای تست ساخته شده و ارسال نهایی ندارد.";
export const BROADCAST_NOT_READY_TEXT = "این پیام قابل ارسال نیست.";

export type BroadcastAudience =
  | "all_active"
  | "active_services"
  | "buyers"
  | "no_purchase"
  | "test_only";

const AUDIENCES: BroadcastAudience[] = [
  "all_active",
  "active_services",
  "buyers",
  "no_purchase",
  "test_only",
];

export const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  all_active: "همه کاربران فعال",
  active_services: "کاربران دارای سرویس فعال",
  buyers: "خریداران",
  no_purchase: "کاربران بدون خرید موفق",
  test_only: "فقط تست (بدون ارسال نهایی)",
};

export function parseBroadcastAudience(raw: string): BroadcastAudience | null {
  return (AUDIENCES as string[]).includes(raw) ? (raw as BroadcastAudience) : null;
}

export function audienceLabel(audience: BroadcastAudience): string {
  return AUDIENCE_LABEL[audience];
}

/**
 * Audience -> User filter. EVERY audience is limited to ACTIVE users -
 * blocked/disabled/deleted accounts never receive broadcasts. null =
 * test_only (no final recipients exist).
 */
function audienceWhere(audience: BroadcastAudience): Prisma.UserWhereInput | null {
  const paidOrder: Prisma.OrderWhereInput = { status: { in: ["PAID", "COMPLETED"] } };
  switch (audience) {
    case "all_active":
      return { status: "ACTIVE" };
    case "active_services":
      return { status: "ACTIVE", services: { some: { status: { in: ["ACTIVE", "LIMITED"] } } } };
    case "buyers":
      return { status: "ACTIVE", orders: { some: paidOrder } };
    case "no_purchase":
      return { status: "ACTIVE", orders: { none: paidOrder } };
    case "test_only":
      return null;
  }
}

export async function estimateAudienceCount(audience: BroadcastAudience): Promise<number> {
  const where = audienceWhere(audience);
  if (where === null) {
    return 0;
  }
  return prisma.user.count({ where });
}

/** The stored audience of a broadcast (targetFilter JSON), null if unknown. */
export function broadcastAudience(broadcast: Pick<Broadcast, "targetFilter">): BroadcastAudience | null {
  const filter = broadcast.targetFilter;
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    return null;
  }
  const raw = (filter as Record<string, unknown>).audience;
  return typeof raw === "string" ? parseBroadcastAudience(raw) : null;
}

export type BroadcastDraftOutcome =
  | { ok: true; broadcast: Broadcast }
  | { ok: false; safeMessage: string };

/** New CONFIRMING text broadcast; nothing is sent yet. */
export async function createBroadcastDraft(
  adminId: string,
  text: string,
  audience: BroadcastAudience,
): Promise<BroadcastDraftOutcome> {
  const cleanText = text.trim();
  if (cleanText.length < BROADCAST_TEXT_MIN || cleanText.length > BROADCAST_TEXT_MAX) {
    return { ok: false, safeMessage: INVALID_BROADCAST_TEXT };
  }
  if (!AUDIENCES.includes(audience)) {
    return { ok: false, safeMessage: INVALID_AUDIENCE_TEXT };
  }
  const broadcast = await prisma.broadcast.create({
    data: {
      type: "SEND",
      status: "CONFIRMING",
      targetFilter: { audience },
      messageText: cleanText,
      createdByAdminId: adminId,
    },
  });
  logger.info("broadcast draft created", { broadcastId: broadcast.id, audience });
  return { ok: true, broadcast };
}

/** Broadcast lookup by short id (admin context; ambiguity fails). */
export async function getBroadcastByShortId(shortId: string): Promise<Broadcast | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.broadcast.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export interface BroadcastsPage {
  broadcasts: Broadcast[];
  page: number;
  pages: number;
  total: number;
}

export async function listBroadcasts(page: number): Promise<BroadcastsPage> {
  const total = await prisma.broadcast.count();
  const pages = Math.max(1, Math.ceil(total / BROADCAST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const broadcasts = await prisma.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * BROADCAST_PAGE_SIZE,
    take: BROADCAST_PAGE_SIZE,
  });
  return { broadcasts, page: safePage, pages, total };
}

export type BroadcastActionOutcome =
  | { ok: true }
  | { ok: false; safeMessage: string };

/** Sends the exact text to the ADMIN only - no recipient rows, no status change. */
export async function sendBroadcastTest(
  api: DeliverySendApi,
  broadcastId: string,
  adminTelegramId: bigint,
): Promise<BroadcastActionOutcome> {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (broadcast === null || broadcast.messageText === null) {
    return { ok: false, safeMessage: BROADCAST_NOT_READY_TEXT };
  }
  if (broadcast.status !== "DRAFT" && broadcast.status !== "CONFIRMING") {
    return { ok: false, safeMessage: BROADCAST_NOT_READY_TEXT };
  }
  try {
    await api.sendMessage(adminTelegramId.toString(), broadcast.messageText);
    return { ok: true };
  } catch (err) {
    logger.warn("broadcast test send failed", { broadcastId, error: errorMessage(err) });
    return { ok: false, safeMessage: "ارسال تستی ناموفق بود." };
  }
}

export interface BroadcastStartResult {
  ok: boolean;
  safeMessage?: string;
  total?: number;
  sent?: number;
  failed?: number;
}

/**
 * Final send: status-guarded start (double click refused), recipient
 * snapshot, sequential batched plain-text sends, per-recipient results,
 * COMPLETED at the end. Synchronous - acceptable at this bot's scale
 * (documented); a catastrophic error marks the broadcast FAILED and is
 * never retried automatically.
 */
export async function startBroadcast(
  api: DeliverySendApi,
  broadcastId: string,
): Promise<BroadcastStartResult> {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (broadcast === null || broadcast.messageText === null) {
    return { ok: false, safeMessage: BROADCAST_NOT_READY_TEXT };
  }
  const audience = broadcastAudience(broadcast);
  if (audience === null) {
    return { ok: false, safeMessage: INVALID_AUDIENCE_TEXT };
  }
  if (audience === "test_only") {
    return { ok: false, safeMessage: TEST_ONLY_NO_START_TEXT };
  }
  // Duplicate-click guard: only the first click flips to RUNNING.
  const claimed = await prisma.broadcast.updateMany({
    where: { id: broadcastId, status: { in: ["DRAFT", "CONFIRMING"] } },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return { ok: false, safeMessage: BROADCAST_ALREADY_STARTED_TEXT };
  }

  const text = broadcast.messageText;
  try {
    // Recipient snapshot: unique [broadcastId,userId] + skipDuplicates =
    // at most ONE row (and so one send) per user, even on a re-run.
    const where = audienceWhere(audience);
    const users = await prisma.user.findMany({
      where: where ?? undefined,
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.broadcastRecipient.createMany({
        data: users.map((user) => ({ broadcastId, userId: user.id })),
        skipDuplicates: true,
      });
    }
    const total = await prisma.broadcastRecipient.count({ where: { broadcastId } });
    await prisma.broadcast.update({ where: { id: broadcastId }, data: { totalTargets: total } });

    let sent = 0;
    let failed = 0;
    for (;;) {
      const batch = await prisma.broadcastRecipient.findMany({
        where: { broadcastId, status: "PENDING" },
        include: { user: { select: { telegramId: true } } },
        orderBy: { createdAt: "asc" },
        take: BROADCAST_SEND_BATCH_SIZE,
      });
      if (batch.length === 0) {
        break;
      }
      for (const recipient of batch) {
        try {
          // Plain text on purpose - no parse mode, nothing to inject.
          await api.sendMessage(recipient.user.telegramId.toString(), text);
          await prisma.broadcastRecipient.update({
            where: { id: recipient.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          sent += 1;
        } catch (err) {
          // Ids + a short error only - NEVER the broadcast text.
          const safeError = errorMessage(err).slice(0, 200);
          logger.warn("broadcast recipient send failed", {
            broadcastId,
            userId: recipient.userId,
            error: safeError,
          });
          await prisma.broadcastRecipient.update({
            where: { id: recipient.id },
            data: { status: "FAILED", errorMessage: safeError },
          });
          failed += 1;
        }
      }
      // Progress counters move per batch so the refresh view stays live.
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: { sentCount: sent, failedCount: failed },
      });
    }

    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: "COMPLETED", completedAt: new Date(), sentCount: sent, failedCount: failed },
    });
    logger.info("broadcast completed", { broadcastId, total, sent, failed });
    return { ok: true, total, sent, failed };
  } catch (err) {
    logger.error("broadcast failed", { broadcastId, error: errorMessage(err) });
    await prisma.broadcast
      .updateMany({ where: { id: broadcastId, status: "RUNNING" }, data: { status: "FAILED" } })
      .catch(() => undefined);
    return { ok: false, safeMessage: "ارسال همگانی ناموفق شد." };
  }
}

export interface BroadcastProgress {
  status: BroadcastStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

/** Live counters straight from the recipient rows. */
export async function getBroadcastProgress(
  broadcastId: string,
): Promise<BroadcastProgress | null> {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (broadcast === null) {
    return null;
  }
  const groups = await prisma.broadcastRecipient.groupBy({
    by: ["status"],
    where: { broadcastId },
    _count: { _all: true },
  });
  const byStatus = new Map<BroadcastRecipientStatus, number>(
    groups.map((group) => [group.status, group._count._all]),
  );
  const sent = byStatus.get("SENT") ?? 0;
  const failed = byStatus.get("FAILED") ?? 0;
  const skipped = byStatus.get("SKIPPED") ?? 0;
  const pending = byStatus.get("PENDING") ?? 0;
  return {
    status: broadcast.status,
    total: sent + failed + skipped + pending,
    sent,
    failed,
    skipped,
    pending,
  };
}
