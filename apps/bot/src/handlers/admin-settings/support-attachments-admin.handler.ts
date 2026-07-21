import type { SupportMessage } from "@zedbot/database";
import {
  clampEscapedText,
  SUPPORT_ATTACHMENT_SIZE_PRESETS_BYTES,
  SUPPORT_DOCUMENT_EXTENSION_ALLOWLIST,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { supportAttachmentEventCounts } from "../../services/support-attachment-log.service.js";
import {
  compareAndSetSupportAttachmentsEnabled,
  isSupportAttachmentsEnabled,
  resetSupportAttachmentMaxBytes,
  setSupportAttachmentMaxBytes,
  supportAttachmentMaxBytes,
} from "../../services/support-attachment-settings.service.js";
import { clearSettingsCache } from "../../services/settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import { supportMessageLine } from "../user-support/support-detail.js";

// =============================================================================
// Support Tickets V2 — OWNER attachment-settings page (§24). Master switch
// (atomic CAS), byte-ceiling presets (5/10/15/20 MiB) + reset-to-default, the
// allowed-format list, a 24h accepted/rejected counter, the safe warning copy,
// and a SYNTHETIC preview (no real ticket / file / panel touched). Every
// mutation re-checks OWNER and revalidates atomically; nothing here downloads a
// file, moves money, or mutates a Service.
// =============================================================================

const OWNER_ONLY_TOAST = "این بخش فقط برای مالک ربات در دسترس است.";
const EVENT_WINDOW_HOURS = 24;
const ATT_HTML = { parseMode: "HTML" as const };

const SUPATT_CB = {
  root: "admin:supatt:root",
  toggle: "admin:supatt:toggle",
  size: (bytes: number): string => `admin:supatt:size:${bytes}`,
  reset: "admin:supatt:reset",
  preview: "admin:supatt:preview",
} as const;

export const supportAttachmentsAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TOAST);
    return false;
  }
  return true;
}

function toMiB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function renderLanding(ctx: BotContext): Promise<void> {
  const [enabled, maxBytes, counts, warning] = await Promise.all([
    isSupportAttachmentsEnabled(),
    supportAttachmentMaxBytes(),
    supportAttachmentEventCounts(EVENT_WINDOW_HOURS),
    getMessageTemplate("support_attachment_settings_warning"),
  ]);

  const lines = [
    "تنظیمات ضمیمه‌ها 📎",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `حداکثر حجم هر فایل: ${toMiB(maxBytes)} مگابایت`,
    `قالب‌های مجاز: ${SUPPORT_DOCUMENT_EXTENSION_ALLOWLIST.join(" ")}`,
    "",
    `آمار ${EVENT_WINDOW_HOURS} ساعت اخیر:`,
    `• ضمیمه‌های پذیرفته‌شده: ${counts.accepted}`,
    `• ضمیمه‌های ردشده: ${counts.rejected}`,
    "",
    // Raw here — the whole assembled string is escaped ONCE below.
    warning,
  ];
  const text = clampEscapedText(escapeHtml(lines.join("\n")));

  const kb = new InlineKeyboard()
    .text(enabled ? "غیرفعال کردن ⛔" : "فعال کردن ✅", SUPATT_CB.toggle)
    .row();
  // Size presets (MiB): the current ceiling is marked «•».
  for (const preset of SUPPORT_ATTACHMENT_SIZE_PRESETS_BYTES) {
    kb.text(`${toMiB(preset)}م${preset === maxBytes ? " •" : ""}`, SUPATT_CB.size(preset));
  }
  kb.row().text("بازگردانی حجم به پیش‌فرض ♻️", SUPATT_CB.reset).row();
  kb.text("پیش‌نمایش نمایش ضمیمه 👁", SUPATT_CB.preview).row();
  kb.text("بازگشت به تنظیمات عمومی", "admin:general_settings");
  await safeEditOrReply(ctx, text, kb, ATT_HTML);
}

supportAttachmentsAdminHandler.callbackQuery(SUPATT_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

// Atomic master-switch toggle — the CAS revalidates the stored state so a stale
// button (two racing owners) can never double-apply. Deletes no metadata; moves
// no money; mutates no Service.
supportAttachmentsAdminHandler.callbackQuery(SUPATT_CB.toggle, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const current = await isSupportAttachmentsEnabled();
  await compareAndSetSupportAttachmentsEnabled(current, !current);
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

supportAttachmentsAdminHandler.callbackQuery(/^admin:supatt:size:(\d+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await setSupportAttachmentMaxBytes(Number.parseInt(ctx.match[1], 10));
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

supportAttachmentsAdminHandler.callbackQuery(SUPATT_CB.reset, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await resetSupportAttachmentMaxBytes();
  clearSettingsCache();
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

// SYNTHETIC preview: renders exactly how an attachment message line looks in a
// ticket detail — from FABRICATED data. No real ticket, message, file or panel
// is read or written; nothing is sent to any user.
supportAttachmentsAdminHandler.callbackQuery(SUPATT_CB.preview, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const samplePhoto = {
    senderType: "USER",
    attachmentType: "PHOTO",
    fileId: "SYNTHETIC",
    fileName: null,
    text: "نمونهٔ توضیح تصویر",
  } as unknown as SupportMessage;
  const sampleDoc = {
    senderType: "USER",
    attachmentType: "DOCUMENT",
    fileId: "SYNTHETIC",
    fileName: "report.pdf",
    text: null,
  } as unknown as SupportMessage;
  const [tooLarge, typeRejected, untrusted] = await Promise.all([
    getMessageTemplate("support_attachment_too_large", undefined, { max: "15" }),
    getMessageTemplate("support_attachment_type_rejected"),
    getMessageTemplate("support_untrusted_attachment_notice"),
  ]);
  const lines = [
    "پیش‌نمایش نمایش ضمیمه (نمونه) 👁",
    "",
    "نمونهٔ خطوط تیکت:",
    supportMessageLine("admin", samplePhoto),
    supportMessageLine("admin", sampleDoc),
    "",
    "نمونهٔ پیام‌های رد:",
    escapeHtml(tooLarge),
    escapeHtml(typeRejected),
    "",
    escapeHtml(untrusted),
  ];
  const text = clampEscapedText(lines.join("\n"));
  const kb = new InlineKeyboard().text("بازگشت به تنظیمات ضمیمه‌ها", SUPATT_CB.root);
  await safeEditOrReply(ctx, text, kb, ATT_HTML);
});
