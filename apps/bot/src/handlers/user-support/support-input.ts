import {
  type SupportAttachmentInput,
  type SupportAttachmentRejection,
  SUPPORT_CAPTION_MAX,
  validateSupportAttachment,
} from "@zedbot/shared";

import { getMessageTemplate } from "../../services/text.service.js";
import {
  isSupportAttachmentsEnabled,
  supportAttachmentMaxBytes,
} from "../../services/support-attachment-settings.service.js";

// =============================================================================
// Support Tickets V2 — the single, unified support-message input surface. ONE
// extractor turns an inbound Telegram message (text / photo / document) into a
// typed accepted input or a typed safe rejection. It NEVER logs message text,
// captions, file ids or file names; NEVER downloads the file; rejects media
// groups (albums); and enforces the master switch + type + size contract from
// @zedbot/shared. Commands (/…) always cancel the active flow.
// =============================================================================

/** The structural subset of a Telegram Message this surface reads. */
export interface InboundMessageLike {
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; file_size?: number }>;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

export type SupportInputResult =
  | { kind: "command" }
  | { kind: "text"; text: string }
  | { kind: "attachment"; caption: string | null; attachment: SupportAttachmentInput }
  | { kind: "unsupported" }
  | { kind: "rejected"; reason: SupportAttachmentRejection };

export interface SupportInputSettings {
  attachmentsEnabled: boolean;
  maxBytes: number;
}

/** Loads the attachment master switch + size ceiling for one extraction. */
export async function loadSupportInputSettings(): Promise<SupportInputSettings> {
  const [attachmentsEnabled, maxBytes] = await Promise.all([
    isSupportAttachmentsEnabled(),
    supportAttachmentMaxBytes(),
  ]);
  return { attachmentsEnabled, maxBytes };
}

function toBigIntOrUndefined(value: number | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

/**
 * Classifies an inbound message for a support flow. Pure + synchronous (the
 * caller supplies the settings), so it is trivially testable and never touches
 * the network. A caption over the limit is a typed rejection; a media group is
 * rejected as an album; a photo/document while disabled is rejected; a
 * voice/video/sticker (or a genuinely empty message) is "unsupported".
 */
export function extractSupportMessageInput(
  message: InboundMessageLike,
  settings: SupportInputSettings,
): SupportInputResult {
  // Commands cancel the flow (pure text commands only — a caption is not one).
  if (typeof message.text === "string" && message.text.startsWith("/")) {
    return { kind: "command" };
  }
  // One message may carry at most one attachment; an album is rejected wholesale
  // so we never partially create a ticket from a single album item.
  if (typeof message.media_group_id === "string" && message.media_group_id !== "") {
    return { kind: "rejected", reason: "ALBUM" };
  }

  const caption = typeof message.caption === "string" ? message.caption : "";

  // PHOTO — pick the LARGEST reported size (Telegram sorts ascending).
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    if (!settings.attachmentsEnabled) {
      return { kind: "rejected", reason: "DISABLED" };
    }
    if (caption.length > SUPPORT_CAPTION_MAX) {
      return { kind: "rejected", reason: "CAPTION_TOO_LONG" };
    }
    const largest = message.photo[message.photo.length - 1];
    const validated = validateSupportAttachment(
      {
        type: "PHOTO",
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
        sizeBytes: toBigIntOrUndefined(largest.file_size),
      },
      { maxBytes: settings.maxBytes },
    );
    if (!validated.ok) {
      return { kind: "rejected", reason: validated.reason };
    }
    return { kind: "attachment", caption: caption === "" ? null : caption, attachment: validated.attachment };
  }

  // DOCUMENT.
  if (message.document !== undefined) {
    if (!settings.attachmentsEnabled) {
      return { kind: "rejected", reason: "DISABLED" };
    }
    if (caption.length > SUPPORT_CAPTION_MAX) {
      return { kind: "rejected", reason: "CAPTION_TOO_LONG" };
    }
    const document = message.document;
    const validated = validateSupportAttachment(
      {
        type: "DOCUMENT",
        fileId: document.file_id,
        fileUniqueId: document.file_unique_id,
        fileName: document.file_name,
        mimeType: document.mime_type,
        sizeBytes: toBigIntOrUndefined(document.file_size),
      },
      { maxBytes: settings.maxBytes },
    );
    if (!validated.ok) {
      return { kind: "rejected", reason: validated.reason };
    }
    return { kind: "attachment", caption: caption === "" ? null : caption, attachment: validated.attachment };
  }

  // Plain text.
  if (typeof message.text === "string" && message.text.trim() !== "") {
    return { kind: "text", text: message.text };
  }

  // Voice / video / sticker / animation / empty — not a valid support message.
  return { kind: "unsupported" };
}

/** Maps a typed rejection to its safe Persian message (never echoes content). */
export async function renderSupportAttachmentRejection(
  reason: SupportAttachmentRejection,
  maxBytes: number,
): Promise<string> {
  switch (reason) {
    case "DISABLED":
      return getMessageTemplate("support_attachment_disabled");
    case "ALBUM":
      return getMessageTemplate("support_attachment_album_rejected");
    case "TOO_LARGE": {
      const mb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
      return getMessageTemplate("support_attachment_too_large", undefined, { max: mb });
    }
    case "CAPTION_TOO_LONG":
      return getMessageTemplate("support_attachment_caption_too_long", undefined, {
        max: SUPPORT_CAPTION_MAX,
      });
    case "METADATA_INVALID":
      return getMessageTemplate("support_attachment_metadata_invalid");
    case "ZERO_BYTE":
    case "TYPE_REJECTED":
    case "EMPTY":
      return getMessageTemplate("support_attachment_type_rejected");
  }
}
