import { createHash } from "node:crypto";

import { prisma, type SupportMessageSenderType } from "@zedbot/database";
import {
  type SupportAttachmentRejection,
  type SupportAttachmentType,
  supportAttachmentSizeBucket,
  type SupportTicketCategory,
  type SupportTicketOrigin,
} from "@zedbot/shared";

import { writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Support Tickets V2 — privacy-safe attachment event logging (§25) + the
// aggregate counters the OWNER settings page shows (§24).
//
// The ONLY fields allowed onto a log row here are: the operation, the sender
// type, the attachment type, a coarse size BUCKET (never the exact byte count),
// the ticket category/origin CODES, a typed rejection code, a non-reversible
// correlation hash and a duration. NEVER: message text, caption, subject,
// fileId, fileUniqueId, the full filename, the Telegram-reported MIME, the
// Telegram user/chat id, the Service id, username, URL, config or token.
// writeSystemLog itself never throws and re-scrubs metadata as a last defense.
// =============================================================================

/** Stable English event markers — queries + counters bind to these, never to
 * the human-readable message. */
export const SUPPORT_ATTACHMENT_EVENTS = {
  ACCEPTED: "support.attachment_accepted",
  REJECTED: "support.attachment_rejected",
} as const;

/** Short, non-reversible correlation hash — lets an operator correlate related
 * events without ever exposing the underlying user / ticket ids. */
export function supportCorrelationHash(userId: string, ticketId: string | null): string {
  return createHash("sha256")
    .update(`support:${userId}:${ticketId ?? "new"}`)
    .digest("hex")
    .slice(0, 12);
}

export interface SupportAttachmentAcceptedLog {
  operation: "new_ticket" | "user_reply" | "admin_reply";
  senderType: SupportMessageSenderType;
  attachmentType: SupportAttachmentType;
  sizeBytes: bigint | null;
  category?: SupportTicketCategory | null;
  origin?: SupportTicketOrigin | null;
  userId: string;
  ticketId: string | null;
}

/** Records one ACCEPTED attachment (aggregate, content-free). Best effort. */
export async function logSupportAttachmentAccepted(entry: SupportAttachmentAcceptedLog): Promise<void> {
  await writeSystemLog({
    level: "INFO",
    eventType: SUPPORT_ATTACHMENT_EVENTS.ACCEPTED,
    message: "support attachment accepted",
    metadata: {
      operation: entry.operation,
      senderType: entry.senderType,
      attachmentType: entry.attachmentType,
      sizeBucket: supportAttachmentSizeBucket(entry.sizeBytes),
      category: entry.category ?? null,
      origin: entry.origin ?? null,
      correlation: supportCorrelationHash(entry.userId, entry.ticketId),
    },
  });
}

export interface SupportAttachmentRejectedLog {
  operation: "new_ticket" | "user_reply" | "admin_reply";
  senderType: SupportMessageSenderType;
  reason: SupportAttachmentRejection;
  userId: string;
  ticketId: string | null;
}

/** Records one REJECTED attachment attempt by its typed reason code. Best
 * effort — the rejection reason is a machine code, never echoed user content. */
export async function logSupportAttachmentRejected(entry: SupportAttachmentRejectedLog): Promise<void> {
  await writeSystemLog({
    level: "INFO",
    eventType: SUPPORT_ATTACHMENT_EVENTS.REJECTED,
    message: "support attachment rejected",
    metadata: {
      operation: entry.operation,
      senderType: entry.senderType,
      reason: entry.reason,
      correlation: supportCorrelationHash(entry.userId, entry.ticketId),
    },
  });
}

/** Aggregate attachment counts over a bounded recent window (§24). */
export async function supportAttachmentEventCounts(
  sinceHours: number,
): Promise<{ accepted: number; rejected: number }> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await prisma.systemLog.groupBy({
    by: ["eventType"],
    where: {
      eventType: { in: Object.values(SUPPORT_ATTACHMENT_EVENTS) },
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.eventType === SUPPORT_ATTACHMENT_EVENTS.ACCEPTED) {
      accepted = row._count._all;
    } else if (row.eventType === SUPPORT_ATTACHMENT_EVENTS.REJECTED) {
      rejected = row._count._all;
    }
  }
  return { accepted, rejected };
}
