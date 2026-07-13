import { type ButtonText, type MessageTemplate } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  BUTTON_TEXT_MAX,
  getButtonTextByShortId,
  getMessageTemplateByShortId,
  listButtonTexts,
  listMessageTemplates,
  NOT_EDITABLE_TEXT,
  resetButtonTextToDefault,
  resetMessageTemplateToDefault,
  TEMPLATE_CONTENT_MAX,
  updateButtonText,
  updateMessageTemplateContent,
} from "../../services/admin-text-settings.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «تنظیمات عمومی ⚙️» -> «مدیریت متن‌ها ✍️» (Phase 34) - the real general-
// settings landing (replacing the placeholder) plus editing of the DB-backed
// MessageTemplate / ButtonText rows: list, detail with escaped current/
// default previews, edit (text flow) and confirmed reset. Only isEditable
// rows can change; nothing is ever deleted; the text cache is cleared by
// the service after every mutation so edits are visible immediately.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const TEMPLATE_FLOW = "admin_texts:template";
const BUTTON_FLOW = "admin_texts:button";

const TX_CB = {
  settings: CB.ADMIN_GENERAL_SETTINGS,
  texts: "admin:texts",
  cancel: "admin:texts:cancel",
  templates: (page: number): string => `admin:texts:templates:${page}`,
  buttons: (page: number): string => `admin:texts:buttons:${page}`,
  template: (sid: string): string => `admin:texts:t:${sid}`,
  button: (sid: string): string => `admin:texts:b:${sid}`,
  editTemplate: (sid: string): string => `admin:texts:edit_t:${sid}`,
  editButton: (sid: string): string => `admin:texts:edit_b:${sid}`,
  resetTemplate: (sid: string): string => `admin:texts:reset_t:${sid}`,
  resetButton: (sid: string): string => `admin:texts:reset_b:${sid}`,
  resetYesTemplate: (sid: string): string => `admin:texts:reset_yes_t:${sid}`,
  resetYesButton: (sid: string): string => `admin:texts:reset_yes_b:${sid}`,
} as const;

export const adminTextSettingsHandler = new Composer<BotContext>();

/** Full Phase 34 text-settings state cleanup (flows + draft). */
export function clearAdminTextSettingsState(ctx: BotContext): void {
  if (ctx.session.currentFlow === TEMPLATE_FLOW || ctx.session.currentFlow === BUTTON_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminTextEditDraft;
}

function preview(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function renderSettingsLanding(ctx: BotContext): Promise<void> {
  clearAdminTextSettingsState(ctx);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("مدیریت متن‌ها ✍️", TX_CB.texts)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(ctx, "تنظیمات عمومی ⚙️\n\nیک بخش را انتخاب کنید:", kb);
}

async function renderTextsLanding(ctx: BotContext): Promise<void> {
  clearAdminTextSettingsState(ctx);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("پیام‌ها / قالب‌ها 📝", TX_CB.templates(1))
    .row()
    .text("متن دکمه‌ها 🔘", TX_CB.buttons(1))
    .row()
    .text("بازگشت", TX_CB.settings);
  await safeEditOrReply(
    ctx,
    "مدیریت متن‌ها ✍️\n\nمتن پیام‌ها و دکمه‌های ربات را ویرایش کنید. تغییرات بلافاصله اعمال می‌شوند.",
    kb,
  );
}

async function renderTemplateDetail(ctx: BotContext, template: MessageTemplate): Promise<void> {
  const sid = template.id.slice(0, 8);
  const variables =
    Array.isArray(template.allowedVariables) && template.allowedVariables.length > 0
      ? template.allowedVariables.map(String).join(", ")
      : null;
  const lines = [
    `قالب پیام 📝 <code>${escapeHtml(template.key)}</code>`,
    "",
    `عنوان: ${escapeHtml(template.title)}`,
    ...(template.category === null ? [] : [`دسته: ${escapeHtml(template.category)}`]),
    `قابل ویرایش: ${template.isEditable ? "بله ✏️" : "خیر 🔒"}`,
    ...(variables === null ? [] : [`متغیرهای مجاز: ${escapeHtml(variables)}`]),
    "",
    "متن فعلی:",
    escapeHtml(preview(template.currentContent)),
    "",
    "متن پیش‌فرض:",
    escapeHtml(preview(template.defaultContent, 300)),
  ];
  const kb = new InlineKeyboard();
  if (template.isEditable) {
    kb.text("ویرایش ✏️", TX_CB.editTemplate(sid))
      .text("بازنشانی به پیش‌فرض ♻️", TX_CB.resetTemplate(sid))
      .row();
  }
  kb.text("پیام‌ها / قالب‌ها 📝", TX_CB.templates(1)).row().text("بازگشت", TX_CB.texts);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

async function renderButtonDetail(ctx: BotContext, button: ButtonText): Promise<void> {
  const sid = button.id.slice(0, 8);
  const lines = [
    `متن دکمه 🔘 <code>${escapeHtml(button.key)}</code>`,
    "",
    `عنوان: ${escapeHtml(button.title)}`,
    `قابل ویرایش: ${button.isEditable ? "بله ✏️" : "خیر 🔒"}`,
    "",
    `متن فعلی: ${escapeHtml(button.currentText)}`,
    `متن پیش‌فرض: ${escapeHtml(button.defaultText)}`,
  ];
  const kb = new InlineKeyboard();
  if (button.isEditable) {
    kb.text("ویرایش ✏️", TX_CB.editButton(sid))
      .text("بازنشانی به پیش‌فرض ♻️", TX_CB.resetButton(sid))
      .row();
  }
  kb.text("متن دکمه‌ها 🔘", TX_CB.buttons(1)).row().text("بازگشت", TX_CB.texts);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminTextSettingsHandler.callbackQuery(TX_CB.settings, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderSettingsLanding(ctx);
  ctx.session.lastMenu = TX_CB.settings;
});

adminTextSettingsHandler.callbackQuery(TX_CB.texts, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderTextsLanding(ctx);
});

adminTextSettingsHandler.callbackQuery(TX_CB.cancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderTextsLanding(ctx);
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:templates:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminTextSettingsState(ctx);
  const pageData = await listMessageTemplates(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const template of pageData.templates) {
    kb.text(
      `${template.isEditable ? "📝" : "🔒"} ${template.key} | ${template.title}`,
      TX_CB.template(template.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", TX_CB.templates(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, TX_CB.templates(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", TX_CB.templates(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", TX_CB.texts);
  await safeEditOrReply(
    ctx,
    pageData.total === 0
      ? "پیام‌ها / قالب‌ها 📝\n\nقالبی ثبت نشده است."
      : `پیام‌ها / قالب‌ها 📝 — ${pageData.total} مورد`,
    kb,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:buttons:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminTextSettingsState(ctx);
  const pageData = await listButtonTexts(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const button of pageData.buttons) {
    kb.text(
      `${button.isEditable ? "🔘" : "🔒"} ${button.key} | ${button.currentText}`,
      TX_CB.button(button.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", TX_CB.buttons(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, TX_CB.buttons(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", TX_CB.buttons(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", TX_CB.texts);
  await safeEditOrReply(
    ctx,
    pageData.total === 0
      ? "متن دکمه‌ها 🔘\n\nدکمه‌ای ثبت نشده است."
      : `متن دکمه‌ها 🔘 — ${pageData.total} مورد`,
    kb,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:t:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminTextSettingsState(ctx);
  const template = await getMessageTemplateByShortId(ctx.match[1]);
  if (template === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderTemplateDetail(ctx, template);
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:b:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminTextSettingsState(ctx);
  const button = await getButtonTextByShortId(ctx.match[1]);
  if (button === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderButtonDetail(ctx, button);
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:edit_t:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const template = await getMessageTemplateByShortId(ctx.match[1]);
  if (template === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (!template.isEditable) {
    await safeAnswerCallback(ctx, NOT_EDITABLE_TEXT);
    return;
  }
  ctx.session.temp.adminTextEditDraft = { kind: "template", id: template.id };
  ctx.session.currentFlow = TEMPLATE_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `ویرایش قالب «${escapeHtml(template.key)}» ✏️\n\nمتن جدید را بفرستید. (حداکثر ${TEMPLATE_CONTENT_MAX} کاراکتر - چندخطی مجاز است)`,
    new InlineKeyboard().text("انصراف", TX_CB.template(template.id.slice(0, 8))),
    HTML,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:edit_b:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const button = await getButtonTextByShortId(ctx.match[1]);
  if (button === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (!button.isEditable) {
    await safeAnswerCallback(ctx, NOT_EDITABLE_TEXT);
    return;
  }
  ctx.session.temp.adminTextEditDraft = { kind: "button", id: button.id };
  ctx.session.currentFlow = BUTTON_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `ویرایش دکمه «${escapeHtml(button.key)}» ✏️\n\nمتن جدید را بفرستید. (حداکثر ${BUTTON_TEXT_MAX} کاراکتر)`,
    new InlineKeyboard().text("انصراف", TX_CB.button(button.id.slice(0, 8))),
    HTML,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:reset_t:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const template = await getMessageTemplateByShortId(ctx.match[1]);
  if (template === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (!template.isEditable) {
    await safeAnswerCallback(ctx, NOT_EDITABLE_TEXT);
    return;
  }
  const sid = template.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `بازنشانی قالب «${escapeHtml(template.key)}» ♻️\n\nمتن فعلی با متن پیش‌فرض جایگزین می‌شود. ادامه می‌دهید؟`,
    new InlineKeyboard()
      .text("بله، بازنشانی ♻️", TX_CB.resetYesTemplate(sid))
      .row()
      .text("انصراف", TX_CB.template(sid)),
    HTML,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:reset_b:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const button = await getButtonTextByShortId(ctx.match[1]);
  if (button === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (!button.isEditable) {
    await safeAnswerCallback(ctx, NOT_EDITABLE_TEXT);
    return;
  }
  const sid = button.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `بازنشانی دکمه «${escapeHtml(button.key)}» ♻️\n\nمتن فعلی با متن پیش‌فرض جایگزین می‌شود. ادامه می‌دهید؟`,
    new InlineKeyboard()
      .text("بله، بازنشانی ♻️", TX_CB.resetYesButton(sid))
      .row()
      .text("انصراف", TX_CB.button(sid)),
    HTML,
  );
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:reset_yes_t:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const template = await getMessageTemplateByShortId(ctx.match[1]);
  if (template === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await resetMessageTemplateToDefault(template.id, admin.id);
  await safeAnswerCallback(ctx, outcome.ok ? "متن به مقدار پیش‌فرض بازنشانی شد ✅" : outcome.safeMessage);
  await renderTemplateDetail(ctx, outcome.ok ? outcome.template : template);
});

adminTextSettingsHandler.callbackQuery(/^admin:texts:reset_yes_b:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const button = await getButtonTextByShortId(ctx.match[1]);
  if (button === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await resetButtonTextToDefault(button.id, admin.id);
  await safeAnswerCallback(ctx, outcome.ok ? "متن به مقدار پیش‌فرض بازنشانی شد ✅" : outcome.safeMessage);
  await renderButtonDetail(ctx, outcome.ok ? outcome.button : button);
});

// --- edit text inputs ---------------------------------------------------------------------------

export const adminTextSettingsTextHandler = new Composer<BotContext>();

adminTextSettingsTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  const flow = ctx.session.currentFlow;
  if (admin === null || (flow !== TEMPLATE_FLOW && flow !== BUTTON_FLOW)) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearAdminTextSettingsState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminTextEditDraft;
  if (draft === undefined) {
    clearAdminTextSettingsState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }

  if (flow === TEMPLATE_FLOW && draft.kind === "template") {
    const outcome = await updateMessageTemplateContent(draft.id, text, admin.id);
    if (!outcome.ok) {
      await safeReply(
        ctx,
        outcome.safeMessage,
        new InlineKeyboard().text("انصراف", TX_CB.template(draft.id.slice(0, 8))),
      );
      return;
    }
    clearAdminTextSettingsState(ctx);
    await safeReply(ctx, "متن با موفقیت بروزرسانی شد ✅");
    await renderTemplateDetail(ctx, outcome.template);
    return;
  }

  if (flow === BUTTON_FLOW && draft.kind === "button") {
    const outcome = await updateButtonText(draft.id, text, admin.id);
    if (!outcome.ok) {
      await safeReply(
        ctx,
        outcome.safeMessage,
        new InlineKeyboard().text("انصراف", TX_CB.button(draft.id.slice(0, 8))),
      );
      return;
    }
    clearAdminTextSettingsState(ctx);
    await safeReply(ctx, "متن با موفقیت بروزرسانی شد ✅");
    await renderButtonDetail(ctx, outcome.button);
    return;
  }

  clearAdminTextSettingsState(ctx);
  await safeReply(ctx, DRAFT_EXPIRED_TEXT);
});
