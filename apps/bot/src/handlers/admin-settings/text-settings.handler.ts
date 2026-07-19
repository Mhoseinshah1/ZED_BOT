import { type ButtonText, type MessageTemplate, type Panel } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
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
import {
  compareAndSetFreeTrialEnabled,
  isFreeTrialEnabled,
} from "../../services/free-trial-settings.service.js";
import {
  formatTrialDuration,
  formatTrialTraffic,
  getFreeTrialMenuAvailability,
  listTrialIncompletePanels,
  listTrialReadyPanels,
  trialPanelProblemLabel,
  type FreeTrialMenuAvailability,
  type FreeTrialMenuReason,
  type TrialPanelDiagnostic,
} from "../../services/free-trial.service.js";
import {
  getAdminMenuMode,
  getUserMenuMode,
  MENU_MODE_LABELS,
  setAdminMenuMode,
  setUserMenuMode,
  type MenuMode,
} from "../../services/menu-mode.service.js";
import { clearSettingsCache } from "../../services/settings.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { cb as panelCb } from "../panels/panel-cb.js";
import { LG_CB, logGroupHandler } from "./log-group.handler.js";
import { NTF_ADMIN_CB } from "./notifications.handler.js";
import {
  TRIAL_ENT_CAMPAIGN_START_CB,
  TRIAL_ENT_DASHBOARD_CB,
  trialEntitlementsHandler,
  trialEntitlementsTextHandler,
} from "./trial-entitlements.handler.js";

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
  // Menu-keyboard-mode phase: user main-menu keyboard mode page. Stable
  // identifiers - behavior never derives from the visible Persian labels.
  menuMode: "admin:menu_mode",
  menuModeScope: (scope: "user" | "admin"): string => `admin:menu_mode:${scope}`,
  menuModeAsk: (scope: "user" | "admin", mode: "inline" | "reply"): string =>
    `admin:menu_mode:ask:${scope}:${mode}`,
  menuModeSet: (scope: "user" | "admin", mode: "inline" | "reply"): string =>
    `admin:menu_mode:set:${scope}:${mode}`,
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

export async function renderSettingsLanding(ctx: BotContext): Promise<void> {
  clearAdminTextSettingsState(ctx);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("مدیریت متن‌ها ✍️", TX_CB.texts)
    .row()
    .text("نوع نمایش منوها", TX_CB.menuMode)
    .row()
    .text("تنظیمات اکانت تست 🎁", TRIAL_SETTINGS_CB.root)
    .row()
    .text("اعلان‌ها و یادآوری‌ها 🔔", NTF_ADMIN_CB.root)
    .row()
    // Wallet auto-renewal (Phase 1). OWNER-only page (the handler re-checks);
    // literal callback avoids importing the admin handler into this module.
    .text("تمدید خودکار 🔁", "admin:war:root")
    .row()
    .text("تنظیمات گروه لاگ 📝", LG_CB.root)
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(ctx, "تنظیمات عمومی ⚙️\n\nیک بخش را انتخاب کنید:", kb);
}

// --- main-menu keyboard modes (menu-keyboard-mode phases) ----------------------------------
// One combined page manages BOTH independent settings (user menu + admin
// menu). Every step stays on this fully Inline surface regardless of the
// modes being configured; scope/mode always come from the stable callback
// data, never from visible labels.

type MenuModeScope = "user" | "admin";

/** Persian display name of each configurable menu (page titles/texts). */
const MENU_SCOPE_TITLES: Record<MenuModeScope, string> = {
  user: "منوی کاربر",
  admin: "منوی ادمین",
};

const MENU_MODE_CONFIRM_TEXTS: Record<MenuModeScope, Record<MenuMode, string>> = {
  user: {
    INLINE: "آیا منوی کاربر به حالت دکمه‌های شیشه‌ای داخل پیام تغییر کند؟",
    REPLY: "آیا منوی کاربر به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟",
  },
  admin: {
    INLINE: "آیا منوی ادمین به حالت دکمه‌های شیشه‌ای داخل پیام تغییر کند؟",
    REPLY: "آیا منوی ادمین به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟",
  },
};
const MENU_MODE_CHANGED_OK_TEXTS: Record<MenuModeScope, string> = {
  user: "نوع نمایش منوی کاربر با موفقیت تغییر کرد ✅",
  admin: "نوع نمایش منوی ادمین با موفقیت تغییر کرد ✅",
};
const MENU_MODE_ALREADY_TEXT = "این نوع نمایش از قبل فعال است.";

function parseScopeParam(raw: string): MenuModeScope {
  return raw === "admin" ? "admin" : "user";
}

function parseModeParam(raw: string): MenuMode {
  return raw === "reply" ? "REPLY" : "INLINE";
}

async function getModeForScope(scope: MenuModeScope): Promise<MenuMode> {
  return scope === "admin" ? getAdminMenuMode() : getUserMenuMode();
}

async function setModeForScope(scope: MenuModeScope, mode: MenuMode): Promise<void> {
  if (scope === "admin") {
    await setAdminMenuMode(mode);
  } else {
    await setUserMenuMode(mode);
  }
}

/** The combined overview: current mode of BOTH menus + per-menu entries. */
async function renderMenuModesOverview(ctx: BotContext): Promise<void> {
  await safeAnswerCallback(ctx);
  const [userMode, adminMode] = await Promise.all([getUserMenuMode(), getAdminMenuMode()]);
  const kb = new InlineKeyboard()
    .text("تنظیم منوی کاربران", TX_CB.menuModeScope("user"))
    .row()
    .text("تنظیم منوی ادمین", TX_CB.menuModeScope("admin"))
    .row()
    .text("بازگشت به تنظیمات عمومی", TX_CB.settings);
  await safeEditOrReply(
    ctx,
    "نوع نمایش منوها\n\n" +
      `منوی کاربر:\n${MENU_MODE_LABELS[userMode]}\n\n` +
      `منوی ادمین:\n${MENU_MODE_LABELS[adminMode]}`,
    kb,
  );
}

/** One menu's page: its current mode + the two mode choices. */
async function renderMenuModeScopePage(ctx: BotContext, scope: MenuModeScope): Promise<void> {
  await safeAnswerCallback(ctx);
  const mode = await getModeForScope(scope);
  const kb = new InlineKeyboard()
    .text("دکمه شیشه‌ای", TX_CB.menuModeAsk(scope, "inline"))
    .text("دکمه معمولی", TX_CB.menuModeAsk(scope, "reply"))
    .row()
    .text("بازگشت", TX_CB.menuMode);
  await safeEditOrReply(
    ctx,
    `نوع نمایش ${MENU_SCOPE_TITLES[scope]}\n\nنوع فعلی:\n${MENU_MODE_LABELS[mode]}`,
    kb,
  );
}

adminTextSettingsHandler.callbackQuery(TX_CB.menuMode, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderMenuModesOverview(ctx);
});

adminTextSettingsHandler.callbackQuery(/^admin:menu_mode:(user|admin)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderMenuModeScopePage(ctx, parseScopeParam(ctx.match[1]));
});

adminTextSettingsHandler.callbackQuery(
  /^admin:menu_mode:ask:(user|admin):(inline|reply)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const scope = parseScopeParam(ctx.match[1]);
    const target = parseModeParam(ctx.match[2]);
    if ((await getModeForScope(scope)) === target) {
      await safeAnswerCallback(ctx, MENU_MODE_ALREADY_TEXT);
      return;
    }
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      MENU_MODE_CONFIRM_TEXTS[scope][target],
      new InlineKeyboard()
        .text("تایید ✅", TX_CB.menuModeSet(scope, ctx.match[2] as "inline" | "reply"))
        .row()
        .text("انصراف", TX_CB.menuModeScope(scope)),
    );
  },
);

adminTextSettingsHandler.callbackQuery(
  /^admin:menu_mode:set:(user|admin):(inline|reply)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const scope = parseScopeParam(ctx.match[1]);
    const target = parseModeParam(ctx.match[2]);
    if ((await getModeForScope(scope)) === target) {
      await safeAnswerCallback(ctx, MENU_MODE_ALREADY_TEXT);
      await renderMenuModeScopePage(ctx, scope);
      return;
    }
    await setModeForScope(scope, target);
    logger.info("main menu keyboard mode changed", {
      adminId: ctx.admin.id,
      scope,
      mode: target,
    });
    await safeAnswerCallback(ctx, MENU_MODE_CHANGED_OK_TEXTS[scope]);
    await renderMenuModeScopePage(ctx, scope);
  },
);

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

// =============================================================================
// «تنظیمات اکانت تست 🎁» - the GLOBAL free-trial admin page (OWNER-only,
// fix/free-trial-button-visibility). One shared availability policy
// (getFreeTrialMenuAvailability / listTrialReadyPanels /
// listTrialIncompletePanels) drives the user menu button, the user panel
// list AND this diagnostics page - the page can therefore explain exactly
// why the user button is hidden. Config/counters only: never panel URLs,
// credentials or raw provider errors.
// =============================================================================

export const TRIAL_SETTINGS_CB = {
  root: "admin:trial_settings",
  enable: "admin:trial_settings:en",
  enableYes: "admin:trial_settings:en:yes",
  disable: "admin:trial_settings:dis",
  disableYes: "admin:trial_settings:dis:yes",
  ready: "admin:trial_settings:ready",
  incomplete: "admin:trial_settings:inc",
} as const;

/** Same OWNER gate copy pattern as financial reconciliation (RBAC gap). */
export const TRIAL_SETTINGS_OWNER_ONLY_TOAST =
  "دسترسی به این بخش فقط برای مالک مجموعه فعال است.";
export const TRIAL_SETTINGS_ALREADY_ENABLED_TEXT = "اکانت تست رایگان از قبل فعال است.";
export const TRIAL_SETTINGS_ALREADY_DISABLED_TEXT = "اکانت تست رایگان از قبل غیرفعال است.";
export const TRIAL_SETTINGS_NO_READY_PANEL_TEXT =
  "امکان فعال‌سازی وجود ندارد؛ ابتدا تنظیمات اکانت تست حداقل یک پنل را کامل کنید.";
export const TRIAL_SETTINGS_ENABLE_ASK_TEXT =
  "آیا از فعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟";
export const TRIAL_SETTINGS_DISABLE_ASK_TEXT =
  "آیا از غیرفعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟";
export const TRIAL_SETTINGS_ENABLED_TOAST = "اکانت تست رایگان برای کاربران فعال شد ✅";
export const TRIAL_SETTINGS_DISABLED_TOAST = "اکانت تست رایگان برای کاربران غیرفعال شد.";
export const TRIAL_READY_EMPTY_TEXT = "هیچ پنل آماده‌ای وجود ندارد.";
export const TRIAL_INCOMPLETE_EMPTY_TEXT = "پنل ناقصی وجود ندارد.";

/** Why the user button is hidden, per shared availability reason. */
export const TRIAL_HIDDEN_REASON_TEXT: Record<
  Exclude<FreeTrialMenuReason, "AVAILABLE">,
  string
> = {
  GLOBAL_DISABLED: "تست رایگان به‌صورت سراسری غیرفعال است.",
  NO_READY_PANEL: "هیچ پنل آماده‌ای برای ساخت اکانت تست وجود ندارد.",
  PANEL_CONFIG_INCOMPLETE: "تنظیمات پنل‌های تست کامل نیست.",
  NO_VALID_XUI_INBOUND: "هیچ اینباند معتبری برای تست XUI انتخاب نشده است.",
};

/** The diagnostics page text (pure - exact layout locked by tests). */
export function trialSettingsPageText(availability: FreeTrialMenuAvailability): string {
  const lines = [
    "🎁 تنظیمات اکانت تست رایگان",
    "",
    "وضعیت سراسری:",
    availability.globallyEnabled ? "فعال ✅" : "غیرفعال ❌",
    "",
    "پنل‌های آماده تست:",
    String(availability.readyPanelCount),
    "",
    "پنل‌های فعال ولی ناقص:",
    String(availability.incompletePanelCount),
    "",
    "وضعیت نمایش دکمه کاربر:",
    availability.visible ? "نمایش داده می‌شود ✅" : "مخفی است ❌",
  ];
  if (!availability.visible && availability.reason !== "AVAILABLE") {
    lines.push("", "علت مخفی بودن دکمه:", TRIAL_HIDDEN_REASON_TEXT[availability.reason]);
  }
  return lines.join("\n");
}

/** The diagnostics page keyboard (pure). */
export function trialSettingsPageKeyboard(
  availability: FreeTrialMenuAvailability,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (availability.globallyEnabled) {
    kb.text("غیرفعال کردن تست رایگان", TRIAL_SETTINGS_CB.disable).row();
  } else {
    kb.text("فعال کردن تست رایگان", TRIAL_SETTINGS_CB.enable).row();
  }
  return kb
    .text("مشاهده پنل‌های آماده", TRIAL_SETTINGS_CB.ready)
    .row()
    .text("مشاهده پنل‌های ناقص", TRIAL_SETTINGS_CB.incomplete)
    .row()
    .text("کمپین ریست اکانت تست", TRIAL_ENT_CAMPAIGN_START_CB)
    .row()
    .text("مدیریت سهمیه‌ها و ریست‌ها", TRIAL_ENT_DASHBOARD_CB)
    .row()
    .text("بروزرسانی وضعیت ♻️", TRIAL_SETTINGS_CB.root)
    .row()
    .text("بازگشت به تنظیمات عمومی", TX_CB.settings);
}

/** Safe panel-type label - never the base URL or credentials. */
function trialPanelTypeLabel(panel: Panel): string {
  return panel.type === "MARZBAN" ? "Marzban" : "XUI";
}

/** «مشاهده پنل‌های آماده» page (pure): name/type/quota only + panel links. */
export function trialReadyListView(panels: Panel[]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const blocks = ["پنل‌های آماده تست ✅"];
  const kb = new InlineKeyboard();
  if (panels.length === 0) {
    blocks.push("", TRIAL_READY_EMPTY_TEXT);
  }
  for (const panel of panels) {
    blocks.push(
      "",
      [
        `✅ ${panel.name}`,
        `نوع: ${trialPanelTypeLabel(panel)}`,
        `مدت تست: ${formatTrialDuration(panel.testDurationMinutes ?? 0)}`,
        `حجم تست: ${formatTrialTraffic(panel.testVolumeMb ?? 0)}`,
      ].join("\n"),
    );
    kb.text("تنظیمات پنل 🎁", panelCb.trial(panel.id.slice(0, 8))).row();
  }
  kb.text("بازگشت", TRIAL_SETTINGS_CB.root);
  return { text: blocks.join("\n"), keyboard: kb };
}

/** «مشاهده پنل‌های ناقص» page (pure): name + safe problem label only. */
export function trialIncompleteListView(entries: TrialPanelDiagnostic[]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const blocks = ["پنل‌های فعال ولی ناقص ❌"];
  const kb = new InlineKeyboard();
  if (entries.length === 0) {
    blocks.push("", TRIAL_INCOMPLETE_EMPTY_TEXT);
  }
  for (const { panel, reasons } of entries) {
    blocks.push(
      "",
      [
        `❌ ${panel.name}`,
        `مشکل: ${trialPanelProblemLabel(reasons[0] ?? "panel-config-incomplete")}`,
      ].join("\n"),
    );
    kb.text("تنظیمات پنل 🎁", panelCb.trial(panel.id.slice(0, 8))).row();
  }
  kb.text("بازگشت", TRIAL_SETTINGS_CB.root);
  return { text: blocks.join("\n"), keyboard: kb };
}

/**
 * OWNER gate (local copy of the financial-reconciliation gate - centralized
 * RBAC is a documented separate task). Any active non-OWNER admin gets only
 * the safe toast and never any trial data.
 */
async function requireOwner(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (ctx.admin.role === "OWNER") {
    return true;
  }
  await safeAnswerCallback(ctx, TRIAL_SETTINGS_OWNER_ONLY_TOAST);
  return false;
}

async function renderTrialSettingsPage(ctx: BotContext, toast?: string): Promise<void> {
  const availability = await getFreeTrialMenuAvailability();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(
    ctx,
    trialSettingsPageText(availability),
    trialSettingsPageKeyboard(availability),
  );
}

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.root, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const availability = await getFreeTrialMenuAvailability();
  logger.info("trial diagnostics viewed", {
    adminId: admin.id,
    action: "free-trial-diagnostics-view",
    readyPanelCount: availability.readyPanelCount,
    result: availability.reason,
  });
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    trialSettingsPageText(availability),
    trialSettingsPageKeyboard(availability),
  );
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.enable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  if (await isFreeTrialEnabled()) {
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_ENABLED_TEXT);
    return;
  }
  const availability = await getFreeTrialMenuAvailability();
  if (availability.readyPanelCount === 0) {
    await safeAnswerCallback(ctx, TRIAL_SETTINGS_NO_READY_PANEL_TEXT);
    await safeEditOrReply(
      ctx,
      `${trialSettingsPageText(availability)}\n\n${TRIAL_SETTINGS_NO_READY_PANEL_TEXT}`,
      trialSettingsPageKeyboard(availability),
    );
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    TRIAL_SETTINGS_ENABLE_ASK_TEXT,
    new InlineKeyboard()
      .text("تایید ✅", TRIAL_SETTINGS_CB.enableYes)
      .row()
      .text("انصراف", TRIAL_SETTINGS_CB.root),
  );
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.enableYes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  // The confirmation may be stale - re-check EVERYTHING before flipping.
  if (await isFreeTrialEnabled()) {
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_ENABLED_TEXT);
    return;
  }
  const availability = await getFreeTrialMenuAvailability();
  if (availability.readyPanelCount === 0) {
    await safeAnswerCallback(ctx, TRIAL_SETTINGS_NO_READY_PANEL_TEXT);
    await safeEditOrReply(
      ctx,
      `${trialSettingsPageText(availability)}\n\n${TRIAL_SETTINGS_NO_READY_PANEL_TEXT}`,
      trialSettingsPageKeyboard(availability),
    );
    return;
  }
  // Compare-and-set: a stale confirmation (or a racing admin) loses the
  // transition and gets the idempotent "already enabled" answer instead.
  if (!(await compareAndSetFreeTrialEnabled(false, true))) {
    logger.info("free trial global enable lost the race", {
      adminId: admin.id,
      action: "free-trial-global-enable",
      result: "already-enabled",
    });
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_ENABLED_TEXT);
    return;
  }
  clearSettingsCache();
  logger.info("free trial globally enabled", {
    adminId: admin.id,
    action: "free-trial-global-enable",
    readyPanelCount: availability.readyPanelCount,
    result: "enabled",
  });
  await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ENABLED_TOAST);
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.disable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  if (!(await isFreeTrialEnabled())) {
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_DISABLED_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    TRIAL_SETTINGS_DISABLE_ASK_TEXT,
    new InlineKeyboard()
      .text("تایید ✅", TRIAL_SETTINGS_CB.disableYes)
      .row()
      .text("انصراف", TRIAL_SETTINGS_CB.root),
  );
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.disableYes, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  if (!(await isFreeTrialEnabled())) {
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_DISABLED_TEXT);
    return;
  }
  // The Setting flip ONLY (compare-and-set): panels, claims and provisioned
  // accounts stay untouched - disabling stops NEW claims; expiry stays with
  // the sweep.
  if (!(await compareAndSetFreeTrialEnabled(true, false))) {
    logger.info("free trial global disable lost the race", {
      adminId: admin.id,
      action: "free-trial-global-disable",
      result: "already-disabled",
    });
    await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_ALREADY_DISABLED_TEXT);
    return;
  }
  clearSettingsCache();
  logger.info("free trial globally disabled", {
    adminId: admin.id,
    action: "free-trial-global-disable",
    result: "disabled",
  });
  await renderTrialSettingsPage(ctx, TRIAL_SETTINGS_DISABLED_TOAST);
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.ready, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const view = trialReadyListView(await listTrialReadyPanels());
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.incomplete, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const view = trialIncompleteListView(await listTrialIncompletePanels());
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// Trial-entitlement phase: OWNER-only campaign builder («کمپین ریست اکانت
// تست») and quota/reset dashboard («مدیریت سهمیه‌ها و ریست‌ها») live behind
// this trial-settings page; their composers mount here so the admin area
// picks them up without app.ts changes.
adminTextSettingsHandler.use(trialEntitlementsHandler);
adminTextSettingsTextHandler.use(trialEntitlementsTextHandler);

// Ops-logging phase: «تنظیمات گروه لاگ 📝» pages mount here so the admin
// area picks them up without app.ts changes (same pattern as the trial
// entitlement pages above). The /setloggroup COMMAND itself is registered
// at bot level in app.ts because it must work inside the group chat.
adminTextSettingsHandler.use(logGroupHandler);
