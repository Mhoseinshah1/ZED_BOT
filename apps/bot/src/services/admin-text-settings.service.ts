import { prisma, type ButtonText, type MessageTemplate } from "@zedbot/database";

import { logger } from "../core/logger.js";
import { MAIN_MENU_BUTTON_KEYS } from "../keyboards/user-menu-definition.js";
import { validateTemplateContentVariables } from "./template-variables.js";
import { clearTextCache } from "./text.service.js";

// =============================================================================
// «مدیریت متن‌ها ✍️» (Phase 34) - admin editing of the operator-editable
// MessageTemplate / ButtonText rows that text.service.ts already reads.
// Only isEditable rows can be updated or reset; rows are never deleted;
// every successful mutation stamps updatedByAdminId and clears the text
// cache so the change is visible immediately. Content is stored EXACTLY as
// the admin sent it (no HTML validation in this phase - previews are
// escaped at render time; variables are never evaluated here).
// No payment/order/service/support/broadcast row is touched.
// =============================================================================

export const TEXT_SETTINGS_PAGE_SIZE = 10;
export const TEMPLATE_CONTENT_MIN = 1;
export const TEMPLATE_CONTENT_MAX = 4000;
export const BUTTON_TEXT_MIN = 1;
export const BUTTON_TEXT_MAX = 64;

export const INVALID_TEMPLATE_CONTENT_TEXT = `متن قالب باید بین ${TEMPLATE_CONTENT_MIN} تا ${TEMPLATE_CONTENT_MAX} کاراکتر باشد.`;
export const INVALID_BUTTON_TEXT_TEXT = `متن دکمه باید بین ${BUTTON_TEXT_MIN} تا ${BUTTON_TEXT_MAX} کاراکتر باشد.`;
export const NOT_EDITABLE_TEXT = "این متن قابل ویرایش نیست. 🔒";
export const TEXT_NOT_FOUND = "مورد یافت نشد.";

const SHORT_ID = /^[0-9a-f-]{4,32}$/i;

export interface TemplatesPage {
  templates: MessageTemplate[];
  page: number;
  pages: number;
  total: number;
}

export interface ButtonTextsPage {
  buttons: ButtonText[];
  page: number;
  pages: number;
  total: number;
}

export type TemplateOutcome =
  | { ok: true; template: MessageTemplate }
  | { ok: false; safeMessage: string };

export type ButtonTextOutcome =
  | { ok: true; button: ButtonText }
  | { ok: false; safeMessage: string };

// --- message templates -------------------------------------------------------------------------

export async function listMessageTemplates(page: number): Promise<TemplatesPage> {
  const total = await prisma.messageTemplate.count();
  const pages = Math.max(1, Math.ceil(total / TEXT_SETTINGS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const templates = await prisma.messageTemplate.findMany({
    orderBy: { key: "asc" },
    skip: (safePage - 1) * TEXT_SETTINGS_PAGE_SIZE,
    take: TEXT_SETTINGS_PAGE_SIZE,
  });
  return { templates, page: safePage, pages, total };
}

export async function getMessageTemplateByShortId(
  shortId: string,
): Promise<MessageTemplate | null> {
  if (!SHORT_ID.test(shortId)) {
    return null;
  }
  const matches = await prisma.messageTemplate.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** New currentContent for an EDITABLE template; clears the text cache. */
export async function updateMessageTemplateContent(
  id: string,
  content: string,
  adminId: string,
): Promise<TemplateOutcome> {
  const clean = content.trim();
  if (clean.length < TEMPLATE_CONTENT_MIN || clean.length > TEMPLATE_CONTENT_MAX) {
    return { ok: false, safeMessage: INVALID_TEMPLATE_CONTENT_TEXT };
  }
  // Variable registry gate (TEXT-007): the edit may only use the row's
  // explicit allowed variables; secret-shaped names never pass.
  const existing = await prisma.messageTemplate.findUnique({ where: { id } });
  if (existing === null) {
    return { ok: false, safeMessage: TEXT_NOT_FOUND };
  }
  const variables = validateTemplateContentVariables(
    existing.allowedVariables,
    existing.defaultContent,
    clean,
  );
  if (!variables.ok) {
    return { ok: false, safeMessage: variables.safeMessage };
  }
  const updated = await prisma.messageTemplate.updateMany({
    where: { id, isEditable: true },
    data: { currentContent: clean, updatedByAdminId: adminId },
  });
  if (updated.count !== 1) {
    return { ok: false, safeMessage: NOT_EDITABLE_TEXT };
  }
  clearTextCache();
  const template = await prisma.messageTemplate.findUniqueOrThrow({ where: { id } });
  logger.info("message template updated", { templateId: id, key: template.key, adminId });
  return { ok: true, template };
}

/** currentContent = defaultContent for an EDITABLE template; clears cache. */
export async function resetMessageTemplateToDefault(
  id: string,
  adminId: string,
): Promise<TemplateOutcome> {
  const existing = await prisma.messageTemplate.findUnique({ where: { id } });
  if (existing === null) {
    return { ok: false, safeMessage: TEXT_NOT_FOUND };
  }
  const updated = await prisma.messageTemplate.updateMany({
    where: { id, isEditable: true },
    data: { currentContent: existing.defaultContent, updatedByAdminId: adminId },
  });
  if (updated.count !== 1) {
    return { ok: false, safeMessage: NOT_EDITABLE_TEXT };
  }
  clearTextCache();
  const template = await prisma.messageTemplate.findUniqueOrThrow({ where: { id } });
  logger.info("message template reset", { templateId: id, key: template.key, adminId });
  return { ok: true, template };
}

// --- button texts ------------------------------------------------------------------------------

export async function listButtonTexts(page: number): Promise<ButtonTextsPage> {
  const total = await prisma.buttonText.count();
  const pages = Math.max(1, Math.ceil(total / TEXT_SETTINGS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const buttons = await prisma.buttonText.findMany({
    orderBy: { key: "asc" },
    skip: (safePage - 1) * TEXT_SETTINGS_PAGE_SIZE,
    take: TEXT_SETTINGS_PAGE_SIZE,
  });
  return { buttons, page: safePage, pages, total };
}

export async function getButtonTextByShortId(shortId: string): Promise<ButtonText | null> {
  if (!SHORT_ID.test(shortId)) {
    return null;
  }
  const matches = await prisma.buttonText.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Reply-keyboard routing safety: two main-menu labels must never collide. */
export const DUPLICATE_MAIN_MENU_LABEL_TEXT =
  "این متن دکمه با یکی دیگر از دکمه‌های منوی اصلی یکسان است.";

/** New currentText for an EDITABLE button; clears the text cache. */
export async function updateButtonText(
  id: string,
  text: string,
  adminId: string,
): Promise<ButtonTextOutcome> {
  const clean = text.trim();
  if (clean.length < BUTTON_TEXT_MIN || clean.length > BUTTON_TEXT_MAX) {
    return { ok: false, safeMessage: INVALID_BUTTON_TEXT_TEXT };
  }
  // Menu-keyboard-mode phase: reply-keyboard routing resolves incoming text
  // against the CURRENT main-menu labels, so a main-menu label may never
  // equal another main-menu button's label (ambiguous navigation).
  const editing = await prisma.buttonText.findUnique({ where: { id } });
  if (editing !== null && MAIN_MENU_BUTTON_KEYS.includes(editing.key)) {
    const clash = await prisma.buttonText.findFirst({
      where: {
        key: { in: MAIN_MENU_BUTTON_KEYS.filter((key) => key !== editing.key) },
        currentText: clean,
      },
      select: { id: true },
    });
    if (clash !== null) {
      return { ok: false, safeMessage: DUPLICATE_MAIN_MENU_LABEL_TEXT };
    }
  }
  const updated = await prisma.buttonText.updateMany({
    where: { id, isEditable: true },
    data: { currentText: clean, updatedByAdminId: adminId },
  });
  if (updated.count !== 1) {
    return { ok: false, safeMessage: NOT_EDITABLE_TEXT };
  }
  clearTextCache();
  const button = await prisma.buttonText.findUniqueOrThrow({ where: { id } });
  logger.info("button text updated", { buttonId: id, key: button.key, adminId });
  return { ok: true, button };
}

/** currentText = defaultText for an EDITABLE button; clears the cache. */
export async function resetButtonTextToDefault(
  id: string,
  adminId: string,
): Promise<ButtonTextOutcome> {
  const existing = await prisma.buttonText.findUnique({ where: { id } });
  if (existing === null) {
    return { ok: false, safeMessage: TEXT_NOT_FOUND };
  }
  const updated = await prisma.buttonText.updateMany({
    where: { id, isEditable: true },
    data: { currentText: existing.defaultText, updatedByAdminId: adminId },
  });
  if (updated.count !== 1) {
    return { ok: false, safeMessage: NOT_EDITABLE_TEXT };
  }
  clearTextCache();
  const button = await prisma.buttonText.findUniqueOrThrow({ where: { id } });
  logger.info("button text reset", { buttonId: id, key: button.key, adminId });
  return { ok: true, button };
}
