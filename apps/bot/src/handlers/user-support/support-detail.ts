import type { SupportMessage } from "@zedbot/database";
import {
  clampButtonLabel,
  isSupportAttachmentType,
  type SupportTicketCategory,
  supportCategoryLabelFa,
  supportOriginLabelFa,
} from "@zedbot/shared";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import type { ResolvedSupportAttachment } from "../../services/support-ticket.service.js";
import { ticketMessagePreview } from "../../services/support-ticket.service.js";
import { escapeHtml } from "../../utils/html.js";

// =============================================================================
// Support Tickets V2 — shared rendering helpers for BOTH the user and admin
// ticket-detail surfaces: stable (non-editable) Persian category/origin labels
// (§22 — display only; behaviour never depends on the rendered text), the
// per-message display line (with an attachment icon + SAFE file name + caption
// preview), and the per-attachment retrieval button. All dynamic user content
// is escaped for the HTML detail body / clamped for button labels.
// =============================================================================

export type SupportViewer = "user" | "admin";

/** The ButtonText key for each category's SELECTION button (editable label). */
export const SUPPORT_CATEGORY_BUTTON_KEY: Record<SupportTicketCategory, string> = {
  CONNECTION: "support_category_connection",
  PAYMENT: "support_category_payment",
  SERVICE_MANAGEMENT: "support_category_service",
  ACCOUNT: "support_category_account",
  OTHER: "support_category_other",
};

/** Stable Persian category/origin labels (§22) — display only, sourced from the
 * shared contract so the service (notifications) and the view render identically.
 * Behaviour never depends on the rendered text; the code drives routing. */
export const supportCategoryLabel = supportCategoryLabelFa;
export const supportOriginLabel = supportOriginLabelFa;

const SENDER_LABEL: Record<SupportViewer, Record<SupportMessage["senderType"], string>> = {
  user: { USER: "👤 شما", ADMIN: "👨‍💼 پشتیبانی", SYSTEM: "⚙️ سیستم" },
  admin: { USER: "👤 کاربر", ADMIN: "👨‍💼 پشتیبانی", SYSTEM: "⚙️ سیستم" },
};

/** Whether a message carries a retrievable attachment reference. */
export function hasAttachment(message: Pick<SupportMessage, "attachmentType" | "fileId">): boolean {
  return (
    message.fileId !== null &&
    message.attachmentType !== null &&
    isSupportAttachmentType(message.attachmentType)
  );
}

/**
 * One fully-escaped display line for a message in the detail body. Attachment
 * messages show an icon + type (+ SAFE file name for documents) + a bounded
 * caption preview; text messages keep the existing bounded preview.
 */
export function supportMessageLine(viewer: SupportViewer, message: SupportMessage): string {
  const label = SENDER_LABEL[viewer][message.senderType];
  if (hasAttachment(message)) {
    const isPhoto = message.attachmentType === "PHOTO";
    const icon = isPhoto ? "📷" : "📎";
    const kind = isPhoto ? "تصویر" : "فایل";
    const name =
      !isPhoto && message.fileName !== null && message.fileName !== ""
        ? `: ${escapeHtml(message.fileName)}`
        : "";
    const caption =
      message.text !== null && message.text !== ""
        ? ` — ${escapeHtml(ticketMessagePreview(message.text, 200))}`
        : "";
    return `${label}: ${icon} ${kind}${name}${caption}`;
  }
  return `${label}: ${escapeHtml(ticketMessagePreview(message.text))}`;
}

/** The retrieval button for one attachment message, or null when it has none.
 * Callback: `<user|admin>:sup:att:<ticketSid>:<messageSid>` (≤64 bytes); label
 * clamped to Telegram's 64-char limit. */
export function supportAttachmentButton(
  viewer: SupportViewer,
  ticketShortId: string,
  message: SupportMessage,
): { label: string; data: string } | null {
  if (!hasAttachment(message)) {
    return null;
  }
  const isPhoto = message.attachmentType === "PHOTO";
  const sender = message.senderType === "ADMIN" ? "پشتیبانی" : "کاربر";
  const label = clampButtonLabel(
    isPhoto
      ? `📷 تصویر ${sender} — مشاهده`
      : `📎 ${message.fileName !== null && message.fileName !== "" ? message.fileName : "فایل"} — دریافت`,
  );
  const prefix = viewer === "admin" ? "admin" : "user";
  return { label, data: `${prefix}:sup:att:${ticketShortId}:${message.id.slice(0, 8)}` };
}

/**
 * Re-sends a resolved attachment by its stored Telegram fileId — content is
 * protected, the caption is generic (no file id / Service secret), and no
 * user-provided HTML parse mode is used. Never downloads the file; never logs
 * the fileId or file name. Returns false when Telegram rejects the send (e.g. an
 * expired file id), so the caller can show a safe "unavailable" message.
 */
export async function sendSupportAttachment(
  ctx: BotContext,
  attachment: ResolvedSupportAttachment,
): Promise<boolean> {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId === undefined) {
    return false;
  }
  const caption =
    attachment.fileName === null
      ? "ضمیمه تیکت 🎫"
      : `ضمیمه تیکت 🎫 — ${attachment.fileName}`.slice(0, 200);
  try {
    if (attachment.type === "PHOTO") {
      await ctx.api.sendPhoto(chatId, attachment.fileId, { caption, protect_content: true });
    } else {
      await ctx.api.sendDocument(chatId, attachment.fileId, { caption, protect_content: true });
    }
    return true;
  } catch (err) {
    logger.debug("support attachment send failed", {
      attachmentType: attachment.type,
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}
