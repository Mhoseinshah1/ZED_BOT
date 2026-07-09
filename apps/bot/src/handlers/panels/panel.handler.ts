import { PanelStatus, type Panel, type Prisma } from "@zedbot/database";
import { encryptSecret, errorMessage, maskSecretEdges, SecretConfigError } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  createPanel,
  getPanelByShortId,
  listPanels,
  panelShortId,
  softDeletePanel,
  updatePanel,
} from "../../services/panel.service.js";
import { testPanelConnection } from "../../services/panel-test.service.js";
import { normalizePanelBaseUrl } from "../../utils/url.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { cb, PANEL_CB } from "./panel-cb.js";
import { findField, findToggle, validateFieldInput } from "./panel-fields.js";
import {
  panelDetailKeyboard,
  panelDetailText,
  panelListKeyboard,
  panelListText,
  panelMenuKeyboard,
  panelMenuText,
  panelPageView,
  statusMenuKeyboard,
  usernamePatternKeyboard,
  USERNAME_PATTERNS,
} from "./panel-views.js";

export const panelHandler = new Composer<BotContext>();

// --- helpers -----------------------------------------------------------------

function clearFlow(ctx: BotContext): void {
  ctx.session.currentFlow = null;
  ctx.session.temp.panelAdd = undefined;
  ctx.session.temp.editingPanelId = undefined;
  ctx.session.temp.editingField = undefined;
  ctx.session.temp.editingCredential = undefined;
}

async function resolvePanel(ctx: BotContext, sid: string): Promise<Panel | null> {
  const panel = await getPanelByShortId(sid);
  if (panel === null) {
    await safeAnswerCallback(ctx, "پنل یافت نشد.");
  }
  return panel;
}

async function showDetail(ctx: BotContext, panel: Panel): Promise<void> {
  await safeEditOrReply(ctx, panelDetailText(panel), panelDetailKeyboard(panel));
}

// --- root menu + list --------------------------------------------------------

panelHandler.callbackQuery(PANEL_CB.MENU, async (ctx) => {
  clearFlow(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, panelMenuText(), panelMenuKeyboard());
});

panelHandler.callbackQuery("admin:panels:noop", async (ctx) => {
  await safeAnswerCallback(ctx);
});

panelHandler.callbackQuery(/^admin:panels:list(?::(\d+))?$/, async (ctx) => {
  const page = Number.parseInt(ctx.match[1] ?? "1", 10);
  const { panels, page: current, pages, total } = await listPanels(page);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, panelListText(total), panelListKeyboard(panels, current, pages));
});

// --- add flow ----------------------------------------------------------------

panelHandler.callbackQuery(PANEL_CB.ADD, async (ctx) => {
  clearFlow(ctx);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("مرزبان", PANEL_CB.ADD_MARZBAN)
    .text("سنایی / 3X-UI", PANEL_CB.ADD_XUI)
    .row()
    .text("بازگشت", PANEL_CB.MENU);
  await safeEditOrReply(ctx, "نوع پنل را انتخاب کنید:", kb);
});

async function beginAdd(ctx: BotContext, type: "MARZBAN" | "XUI"): Promise<void> {
  ctx.session.currentFlow = "panel:add";
  ctx.session.temp.panelAdd = { step: "name", type };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نام پنل را وارد کنید.", cancelKeyboard());
}

panelHandler.callbackQuery(PANEL_CB.ADD_MARZBAN, (ctx) => beginAdd(ctx, "MARZBAN"));
panelHandler.callbackQuery(PANEL_CB.ADD_XUI, (ctx) => beginAdd(ctx, "XUI"));

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("لغو ❌", PANEL_CB.CANCEL);
}

panelHandler.callbackQuery(PANEL_CB.CANCEL, async (ctx) => {
  clearFlow(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  await safeEditOrReply(ctx, panelMenuText(), panelMenuKeyboard());
});

// --- test connection ---------------------------------------------------------

panelHandler.callbackQuery(/^admin:panel:test:(.+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  await safeAnswerCallback(ctx, "در حال تست اتصال ...");
  const result = await testPanelConnection(panel);
  const emoji = result.ok ? "✅" : "⚠️";
  const kb = new InlineKeyboard().text("بازگشت", cb.view(panelShortId(panel)));
  await safeEditOrReply(ctx, `تست اتصال ${emoji}\n\n${result.message}`, kb);
});

// --- detail + status + visibility + delete -----------------------------------

panelHandler.callbackQuery(/^admin:panel:view:(.+)$/, async (ctx) => {
  clearFlow(ctx);
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await showDetail(ctx, panel);
});

panelHandler.callbackQuery(/^admin:panel:st:([^:]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "وضعیت پنل را انتخاب کنید:", statusMenuKeyboard(panel));
});

panelHandler.callbackQuery(/^admin:panel:st:([^:]+):([A-Z]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const status = ctx.match[2];
  if (!(status in PanelStatus)) {
    await safeAnswerCallback(ctx, "وضعیت نامعتبر.");
    return;
  }
  const updated = await updatePanel(panel.id, { status: status as PanelStatus });
  await safeAnswerCallback(ctx, "وضعیت بروزرسانی شد ✅");
  await showDetail(ctx, updated);
});

panelHandler.callbackQuery(/^admin:panel:vis:(.+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const updated = await updatePanel(panel.id, { isVisible: !panel.isVisible });
  await safeAnswerCallback(ctx, updated.isVisible ? "نمایش داده می‌شود 👁" : "مخفی شد 🙈");
  await showDetail(ctx, updated);
});

panelHandler.callbackQuery(/^admin:panel:del:([^:]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = panelShortId(panel);
  const kb = new InlineKeyboard()
    .text("بله، غیرفعال و مخفی کن", cb.deleteConfirm(sid))
    .row()
    .text("انصراف", cb.view(sid));
  await safeEditOrReply(
    ctx,
    "حذف فیزیکی پنل انجام نمی‌شود (تاریخچه حفظ می‌ماند). پنل غیرفعال و مخفی خواهد شد. ادامه؟",
    kb,
  );
});

panelHandler.callbackQuery(/^admin:panel:del:([^:]+):yes$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const updated = await softDeletePanel(panel.id);
  await safeAnswerCallback(ctx, "انجام شد.");
  const kb = new InlineKeyboard().text("بازگشت به لیست", cb.list(1));
  await safeEditOrReply(ctx, `پنل «${updated.name}» غیرفعال و مخفی شد.`, kb);
});

// --- feature / pricing / test / cfg pages ------------------------------------

const PAGE_ROUTES: Array<{ pattern: RegExp; page: "features" | "pricing" | "test" | "cfg" }> = [
  { pattern: /^admin:panel:feat:(.+)$/, page: "features" },
  { pattern: /^admin:panel:price:(.+)$/, page: "pricing" },
  { pattern: /^admin:panel:ts:(.+)$/, page: "test" },
  { pattern: /^admin:panel:cfg:(.+)$/, page: "cfg" },
];

for (const route of PAGE_ROUTES) {
  panelHandler.callbackQuery(route.pattern, async (ctx) => {
    const panel = await resolvePanel(ctx, ctx.match[1]);
    if (panel === null) {
      return;
    }
    await safeAnswerCallback(ctx);
    const view = panelPageView(panel, route.page);
    await safeEditOrReply(ctx, view.text, view.keyboard);
  });
}

// Username settings page + pattern selector.
panelHandler.callbackQuery(/^admin:panel:us:(.+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const view = panelPageView(panel, "username");
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

panelHandler.callbackQuery(/^admin:panel:up:([^:]+):(-?\d+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const index = Number.parseInt(ctx.match[2], 10);
  if (index < 0) {
    // Open the selector.
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, "روش ساخت username را انتخاب کنید:", usernamePatternKeyboard(panel));
    return;
  }
  const pattern = USERNAME_PATTERNS[index];
  if (pattern === undefined) {
    await safeAnswerCallback(ctx, "گزینه نامعتبر.");
    return;
  }
  const updated = await updatePanel(panel.id, { usernamePatternType: pattern });
  await safeAnswerCallback(ctx, "روش ساخت username بروزرسانی شد ✅");
  const view = panelPageView(updated, "username");
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// --- toggles -----------------------------------------------------------------

panelHandler.callbackQuery(/^admin:panel:tg:([^:]+):([a-z0-9]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const toggle = findToggle(ctx.match[2]);
  if (toggle === undefined) {
    await safeAnswerCallback(ctx, "گزینه نامعتبر.");
    return;
  }
  const current = panel[toggle.column] === true;
  const updated = await updatePanel(panel.id, {
    [toggle.column]: !current,
  } as Prisma.PanelUpdateInput);
  await safeAnswerCallback(ctx, !current ? "فعال شد ✅" : "غیرفعال شد ❌");
  const view = panelPageView(updated, toggle.page === "test" ? "test" : "features");
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// --- field edit entry points -------------------------------------------------

// Basic edits from the detail page use fixed keys: nm / url / cred.
panelHandler.callbackQuery(/^admin:panel:fe:([^:]+):(.+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const fieldKey = ctx.match[2];
  await safeAnswerCallback(ctx);
  ctx.session.temp.editingPanelId = panel.id;

  if (fieldKey === "url") {
    ctx.session.currentFlow = "panel:edit:url";
    await safeEditOrReply(ctx, "آدرس جدید پنل را وارد کنید.", cancelKeyboard());
    return;
  }
  if (fieldKey === "cred") {
    ctx.session.currentFlow = "panel:edit:credential";
    ctx.session.temp.editingCredential = panel.type === "MARZBAN" ? "password" : "token";
    const prompt =
      panel.type === "MARZBAN" ? "رمز عبور جدید را وارد کنید." : "توکن جدید را وارد کنید.";
    await safeEditOrReply(ctx, prompt, cancelKeyboard());
    return;
  }

  const field = findField(fieldKey);
  if (field === undefined) {
    await safeReply(ctx, "فیلد نامعتبر است.");
    return;
  }
  ctx.session.currentFlow = "panel:edit:field";
  ctx.session.temp.editingField = fieldKey;
  const hint = field.nullable ? "\n(برای خالی کردن مقدار «-» بفرستید.)" : "";
  await safeEditOrReply(ctx, `مقدار جدید «${field.label}» را وارد کنید.${hint}`, cancelKeyboard());
});

// --- text input for active panel flows ---------------------------------------
// Registered on the admin composer in app.ts (admin-auth already applied).

export const panelTextHandler = new Composer<BotContext>();

panelTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow === null || !flow.startsWith("panel:")) {
    return next();
  }
  const text = ctx.message.text;
  // Ignore commands so /start, /menu etc. still work mid-flow.
  if (text.startsWith("/")) {
    clearFlow(ctx);
    return next();
  }

  try {
    if (flow === "panel:add") {
      await handleAddStep(ctx, text);
      return;
    }
    if (flow === "panel:edit:url") {
      await handleEditUrl(ctx, text);
      return;
    }
    if (flow === "panel:edit:credential") {
      await handleEditCredential(ctx, text);
      return;
    }
    if (flow === "panel:edit:field") {
      await handleEditField(ctx, text);
      return;
    }
  } catch (err) {
    if (err instanceof SecretConfigError) {
      clearFlow(ctx);
      await safeReply(ctx, "خطای پیکربندی: APP_SECRET تنظیم نشده است. ابتدا آن را در .env تنظیم کنید.");
      return;
    }
    logger.error("panel flow step failed", { flow, error: errorMessage(err) });
    clearFlow(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

async function handleAddStep(ctx: BotContext, text: string): Promise<void> {
  const state = ctx.session.temp.panelAdd;
  if (state === undefined) {
    clearFlow(ctx);
    return;
  }
  const value = text.trim();

  if (state.step === "name") {
    if (value.length === 0 || value.length > 100) {
      await safeReply(ctx, "نام باید بین ۱ تا ۱۰۰ کاراکتر باشد. دوباره وارد کنید.");
      return;
    }
    state.name = value;
    state.step = "baseUrl";
    await safeReply(ctx, "آدرس پنل را وارد کنید. (مثال: https://panel.example.com:2087)", cancelKeyboard());
    return;
  }

  if (state.step === "baseUrl") {
    const result = normalizePanelBaseUrl(value);
    if (!result.ok) {
      await safeReply(ctx, `${result.error}\nدوباره وارد کنید.`);
      return;
    }
    state.baseUrl = result.value;
    if (state.type === "MARZBAN") {
      state.step = "username";
      await safeReply(ctx, "نام کاربری مرزبان را وارد کنید.", cancelKeyboard());
    } else {
      state.step = "token";
      await safeReply(ctx, "توکن پنل را وارد کنید.", cancelKeyboard());
    }
    return;
  }

  if (state.step === "username") {
    if (value.length === 0) {
      await safeReply(ctx, "نام کاربری نمی‌تواند خالی باشد. دوباره وارد کنید.");
      return;
    }
    state.username = value;
    state.step = "password";
    await safeReply(ctx, "رمز عبور مرزبان را وارد کنید.", cancelKeyboard());
    return;
  }

  if (state.step === "password" || state.step === "token") {
    if (value.length === 0) {
      await safeReply(ctx, "مقدار نمی‌تواند خالی باشد. دوباره وارد کنید.");
      return;
    }
    const encrypted = encryptSecret(value); // may throw SecretConfigError
    const panel = await createPanel({
      type: state.type,
      name: state.name ?? "پنل",
      baseUrl: state.baseUrl ?? "",
      username: state.type === "MARZBAN" ? (state.username ?? null) : null,
      passwordEncrypted: state.type === "MARZBAN" ? encrypted : null,
      tokenEncrypted: state.type === "XUI" ? encrypted : null,
    });
    clearFlow(ctx);
    await safeReply(ctx, "پنل با موفقیت ذخیره شد ✅");
    const warning =
      panel.type === "MARZBAN"
        ? "بعداً باید تنظیمات پروتکل/اینباند/اکانت نمونه/دامنه ساب را از مدیریت پنل تکمیل کنید."
        : "بعداً باید inbound/domain/protocol settings را از مدیریت پنل تکمیل کنید.";
    await safeReply(ctx, warning);
    await safeReply(ctx, panelDetailText(panel), panelDetailKeyboard(panel));
  }
}

async function handleEditUrl(ctx: BotContext, text: string): Promise<void> {
  const panelId = ctx.session.temp.editingPanelId;
  if (panelId === undefined) {
    clearFlow(ctx);
    return;
  }
  const result = normalizePanelBaseUrl(text);
  if (!result.ok) {
    await safeReply(ctx, `${result.error}\nدوباره وارد کنید.`);
    return;
  }
  const updated = await updatePanel(panelId, { baseUrl: result.value });
  clearFlow(ctx);
  await safeReply(ctx, "آدرس بروزرسانی شد ✅");
  await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated));
}

async function handleEditCredential(ctx: BotContext, text: string): Promise<void> {
  const panelId = ctx.session.temp.editingPanelId;
  const kind = ctx.session.temp.editingCredential;
  if (panelId === undefined || kind === undefined) {
    clearFlow(ctx);
    return;
  }
  const value = text.trim();
  if (value.length === 0) {
    await safeReply(ctx, "مقدار نمی‌تواند خالی باشد. دوباره وارد کنید.");
    return;
  }
  const encrypted = encryptSecret(value); // may throw SecretConfigError
  const data: Prisma.PanelUpdateInput =
    kind === "password" ? { passwordEncrypted: encrypted } : { tokenEncrypted: encrypted };
  const updated = await updatePanel(panelId, data);
  clearFlow(ctx);
  await safeReply(ctx, `${kind === "password" ? "رمز" : "توکن"} بروزرسانی شد ✅ (${maskSecretEdges(value)})`);
  await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated));
}

async function handleEditField(ctx: BotContext, text: string): Promise<void> {
  const panelId = ctx.session.temp.editingPanelId;
  const fieldKey = ctx.session.temp.editingField;
  if (panelId === undefined || fieldKey === undefined) {
    clearFlow(ctx);
    return;
  }
  const field = findField(fieldKey);
  if (field === undefined) {
    clearFlow(ctx);
    return;
  }
  const validation = validateFieldInput(field, text);
  if (!validation.ok) {
    await safeReply(ctx, `${validation.error}\nدوباره وارد کنید.`);
    return;
  }
  const updated = await updatePanel(panelId, {
    [field.column]: validation.value,
  } as Prisma.PanelUpdateInput);
  clearFlow(ctx);
  await safeReply(ctx, `«${field.label}» بروزرسانی شد ✅`);
  // The name field belongs to the detail view; group fields return to their page.
  if (field.page === "detail") {
    await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated));
    return;
  }
  const view = panelPageView(updated, field.page);
  await safeReply(ctx, view.text, view.keyboard);
}
