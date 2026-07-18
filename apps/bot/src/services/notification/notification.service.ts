import {
  AutomatedNotificationStatus,
  Prisma,
  prisma,
  type AutomatedNotification,
  type NotificationInteractionType,
} from "@zedbot/database";

// =============================================================================
// Bot-side notification read/interaction service (Phase 1). Creation + dedupe
// live in the WORKER scan; the bot only resolves a notification for a callback
// (owner-scoped, short-id), records the click idempotently, and reads status
// counts for the admin page. No secret ever leaves via these paths - the
// payloadSnapshot is safe-by-construction and callbacks reload the Service
// fresh rather than trusting the snapshot.
// =============================================================================

/** Short id used in callback data (never the full uuid). */
export function notificationShortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Resolves a notification from a callback short id, scoped to the owner. Returns
 * null on ambiguity (two rows share the prefix) or a foreign/absent id - a
 * missing/foreign notification is indistinguishable to the caller (safe).
 */
export async function getOwnedNotificationByShortId(
  shortId: string,
  userId: string,
): Promise<AutomatedNotification | null> {
  if (!/^[0-9a-f]{4,12}$/i.test(shortId)) {
    return null;
  }
  const rows = await prisma.automatedNotification.findMany({
    where: { id: { startsWith: shortId }, userId },
    take: 2,
  });
  return rows.length === 1 ? rows[0] : null;
}

export interface RecordInteractionResult {
  /** True when this click was recorded for the first time (metrics-safe). */
  firstTime: boolean;
}

/**
 * Records a button click exactly once per (notification, type). A callback
 * retry (same notification + action) never inflates metrics - the unique
 * constraint makes the second write a no-op.
 */
export async function recordNotificationInteraction(
  notificationId: string,
  userId: string,
  type: NotificationInteractionType,
): Promise<RecordInteractionResult> {
  try {
    await prisma.notificationInteraction.create({
      data: { notificationId, userId, type },
    });
    return { firstTime: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { firstTime: false };
    }
    throw err;
  }
}

export interface NotificationStatusCounts {
  scheduled: number;
  ready: number;
  sending: number;
  sent: number;
  failed: number;
  deadLetter: number;
}

/** Aggregate counts for the admin status page (single grouped query). */
export async function getNotificationStatusCounts(): Promise<NotificationStatusCounts> {
  const rows = await prisma.automatedNotification.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const counts: NotificationStatusCounts = {
    scheduled: 0,
    ready: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    deadLetter: 0,
  };
  for (const row of rows) {
    const n = row._count._all;
    switch (row.status) {
      case AutomatedNotificationStatus.SCHEDULED:
        counts.scheduled = n;
        break;
      case AutomatedNotificationStatus.READY:
        counts.ready = n;
        break;
      case AutomatedNotificationStatus.SENDING:
        counts.sending = n;
        break;
      case AutomatedNotificationStatus.SENT:
        counts.sent = n;
        break;
      case AutomatedNotificationStatus.FAILED:
        counts.failed = n;
        break;
      case AutomatedNotificationStatus.DEAD_LETTER:
        counts.deadLetter = n;
        break;
      default:
        break;
    }
  }
  return counts;
}

/** The newest FAILED/DEAD_LETTER rows for the admin "needs review" list (safe fields only). */
export async function listFailedNotifications(limit = 10): Promise<
  Array<Pick<AutomatedNotification, "id" | "type" | "status" | "attempts" | "safeErrorCode" | "failedAt" | "userId">>
> {
  return prisma.automatedNotification.findMany({
    where: {
      status: {
        in: [AutomatedNotificationStatus.FAILED, AutomatedNotificationStatus.DEAD_LETTER],
      },
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      safeErrorCode: true,
      failedAt: true,
      userId: true,
    },
  });
}
