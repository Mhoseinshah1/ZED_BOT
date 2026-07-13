import { PanelStatus, prisma, type Panel, type Prisma } from "@zedbot/database";
import { encryptSecret, errorMessage, maskSecretEdges, SecretConfigError } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  countPanelProducts,
  createPanel,
  getPanelByShortId,
  listPanels,
  panelShortId,
  softDeletePanel,
  updatePanel,
} from "../../services/panel.service.js";
import { testPanelConnection } from "../../services/panel-test.service.js";
import {
  READINESS_RELEVANT_COLUMNS,
  readinessResetData,
} from "../../services/panel-readiness.service.js";
import { resolveXuiAuthMode } from "../../services/panel-adapter-factory.js";
import { resolveProductInboundIds } from "../../services/panel-readiness.service.js";
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

const HTML = { parseMode: "HTML" as const };

export const panelHandler = new Composer<BotContext>();

// --- helpers -----------------------------------------------------------------

function clearFlow(ctx: BotContext): void {
  ctx.session.currentFlow = null;
  ctx.session.temp.panelAdd = undefined;
  ctx.session.temp.editingPanelId = undefined;
  ctx.session.temp.editingField = undefined;
  ctx.session.temp.editingCredential = undefined;
  ctx.session.temp.editingCredentialUsername = undefined;
}

async function resolvePanel(ctx: BotContext, sid: string): Promise<Panel | null> {
  const panel = await getPanelByShortId(sid);
  if (panel === null) {
    await safeAnswerCallback(ctx, "پنل یافت نشد.");
  }
  return panel;
}

async function showDetail(ctx: BotContext, panel: Panel): Promise<void> {
  // Fix C: linked-product count + back to the same list/filter/page.
  const count = await countPanelProducts(panel.id);
  const backList = {
    filter: ctx.session.temp.adminPanelListFilter,
    page: ctx.session.temp.adminPanelListPage ?? 1,
  };
  await safeEditOrReply(
    ctx,
    panelDetailText(panel, count),
    panelDetailKeyboard(panel, backList),
    HTML,
  );
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
  delete ctx.session.temp.adminPanelListFilter;
  ctx.session.temp.adminPanelListPage = current;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, panelListText(total), panelListKeyboard(panels, current, pages));
});

// Fix C: status-filtered lists (a = ACTIVE, i = everything else).
panelHandler.callbackQuery(/^admin:panels:ls:(a|i):(\d+)$/, async (ctx) => {
  const filter = ctx.match[1] as "a" | "i";
  const { panels, page, pages, total } = await listPanels(
    Number.parseInt(ctx.match[2], 10),
    filter,
  );
  ctx.session.temp.adminPanelListFilter = filter;
  ctx.session.temp.adminPanelListPage = page;
  await safeAnswerCallback(ctx);
  const title = filter === "a" ? `پنل‌های فعال ✅ (${total})` : `پنل‌های غیرفعال ⏸ (${total})`;
  await safeEditOrReply(
    ctx,
    total === 0 ? `${title}\n\nموردی وجود ندارد.` : title,
    panelListKeyboard(panels, page, pages, filter),
  );
});

// Fix C: read-only linked products of one panel (opens the existing product detail).
panelHandler.callbackQuery(/^admin:panel:prods:([0-9a-f-]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  const products = await prisma.product.findMany({
    where: { panelId: panel.id },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 30,
  });
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const product of products) {
    kb.text(
      `${product.isActive ? "🟢" : "⚪️"} ${product.name} | ${product.priceToman} تومان`,
      `admin:prod:view:${product.id.slice(0, 8)}`,
    ).row();
  }
  kb.text("بازگشت به پنل", cb.view(panelShortId(panel)));
  await safeEditOrReply(
    ctx,
    products.length === 0
      ? `محصولات متصل 🛍 (${panel.name})\n\nمحصولی به این پنل متصل نیست.`
      : `محصولات متصل 🛍 (${panel.name}) — ${products.length} محصول`,
    kb,
  );
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

/** XUI add-wizard auth-mode selector. */
function authModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("نام کاربری و رمز عبور", PANEL_CB.ADD_AUTH_COOKIE)
    .row()
    .text("توکن API", PANEL_CB.ADD_AUTH_TOKEN)
    .row()
    .text("لغو ❌", PANEL_CB.CANCEL);
}

// Add-wizard auth-mode selection (only meaningful in the authMode step).
async function chooseAddAuthMode(
  ctx: BotContext,
  mode: "SESSION_COOKIE" | "API_TOKEN",
): Promise<void> {
  const state = ctx.session.temp.panelAdd;
  if (ctx.session.currentFlow !== "panel:add" || state === undefined || state.step !== "authMode") {
    await safeAnswerCallback(ctx, "این مرحله فعال نیست.");
    return;
  }
  state.authMode = mode;
  await safeAnswerCallback(ctx);
  if (mode === "API_TOKEN") {
    state.step = "token";
    await safeEditOrReply(ctx, "توکن API پنل را وارد کنید.", cancelKeyboard());
    return;
  }
  state.step = "username";
  await safeEditOrReply(ctx, "نام کاربری پنل را وارد کنید.", cancelKeyboard());
}

panelHandler.callbackQuery(PANEL_CB.ADD_AUTH_COOKIE, (ctx) => chooseAddAuthMode(ctx, "SESSION_COOKIE"));
panelHandler.callbackQuery(PANEL_CB.ADD_AUTH_TOKEN, (ctx) => chooseAddAuthMode(ctx, "API_TOKEN"));

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
  const report = await testPanelConnection(panel);
  const emoji = report.ready ? "✅" : "⚠️";
  const kb = new InlineKeyboard().text("بازگشت", cb.view(panelShortId(panel)));
  const lines = [
    `تست پنل ${emoji}`,
    "",
    `وضعیت: ${report.statusText}`,
    ...(report.diagnosticText === null ? [] : [report.diagnosticText]),
    "",
    "مراحل بررسی:",
    ...report.checkLines,
    "",
    "قابلیت‌های پنل:",
    ...report.capabilityLines,
  ];
  await safeEditOrReply(ctx, lines.join("\n"), kb);
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
    await safeEditOrReply(ctx, view.text, view.keyboard, HTML);
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
  await safeEditOrReply(ctx, view.text, view.keyboard, HTML);
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
  await safeEditOrReply(ctx, view.text, view.keyboard, HTML);
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
  await safeEditOrReply(ctx, view.text, view.keyboard, HTML);
});

// --- XUI auth-mode switch ------------------------------------------------------

panelHandler.callbackQuery(/^admin:panel:am:([^:]+)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  if (panel.type !== "XUI") {
    await safeAnswerCallback(ctx, "فقط برای پنل‌های XUI.");
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = panelShortId(panel);
  const current = resolveXuiAuthMode(panel);
  const kb = new InlineKeyboard()
    .text(
      `${current === "SESSION_COOKIE" ? "✅ " : ""}نام کاربری و رمز عبور`,
      cb.authModeSet(sid, "c"),
    )
    .row()
    .text(`${current === "API_TOKEN" ? "✅ " : ""}توکن API`, cb.authModeSet(sid, "t"))
    .row()
    .text("بازگشت", cb.view(sid));
  await safeEditOrReply(ctx, "روش احراز هویت پنل را انتخاب کنید:", kb);
});

panelHandler.callbackQuery(/^admin:panel:am:([^:]+):(c|t)$/, async (ctx) => {
  const panel = await resolvePanel(ctx, ctx.match[1]);
  if (panel === null) {
    return;
  }
  if (panel.type !== "XUI") {
    await safeAnswerCallback(ctx, "فقط برای پنل‌های XUI.");
    return;
  }
  const mode = ctx.match[2] === "t" ? "API_TOKEN" : "SESSION_COOKIE";
  // Switching the mode stales the readiness result; the admin is prompted
  // for the new mode's credential right away.
  await updatePanel(panel.id, { authMode: mode, ...readinessResetData() });
  await safeAnswerCallback(ctx, "روش احراز هویت بروزرسانی شد ✅");
  ctx.session.currentFlow = "panel:edit:credential";
  ctx.session.temp.editingPanelId = panel.id;
  if (mode === "API_TOKEN") {
    ctx.session.temp.editingCredential = "token";
    await safeEditOrReply(ctx, "توکن API پنل را وارد کنید.", cancelKeyboard());
    return;
  }
  ctx.session.temp.editingCredential = "cred-username";
  await safeEditOrReply(ctx, "نام کاربری پنل را وارد کنید.", cancelKeyboard());
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
    if (panel.type === "XUI" && resolveXuiAuthMode(panel) === "API_TOKEN") {
      ctx.session.temp.editingCredential = "token";
      await safeEditOrReply(ctx, "توکن API جدید پنل را وارد کنید.", cancelKeyboard());
      return;
    }
    ctx.session.temp.editingCredential = "cred-username";
    await safeEditOrReply(ctx, "نام کاربری پنل را وارد کنید.", cancelKeyboard());
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
    if (state.type === "XUI") {
      // XUI supports two explicit auth modes - the admin picks one.
      state.step = "authMode";
      await safeReply(ctx, "روش احراز هویت پنل را انتخاب کنید:", authModeKeyboard());
      return;
    }
    state.step = "username";
    await safeReply(ctx, "نام کاربری پنل را وارد کنید.", cancelKeyboard());
    return;
  }

  if (state.step === "authMode") {
    // Mode is chosen via the inline keyboard, not text.
    await safeReply(ctx, "لطفاً روش احراز هویت را با دکمه‌ها انتخاب کنید.", authModeKeyboard());
    return;
  }

  if (state.step === "token") {
    if (value.length === 0) {
      await safeReply(ctx, "مقدار نمی‌تواند خالی باشد. دوباره وارد کنید.");
      return;
    }
    const encrypted = encryptSecret(value); // may throw SecretConfigError
    const panel = await createPanel({
      type: state.type,
      name: state.name ?? "پنل",
      baseUrl: state.baseUrl ?? "",
      username: null,
      passwordEncrypted: null,
      tokenEncrypted: encrypted,
      authMode: "API_TOKEN",
    });
    clearFlow(ctx);
    await safeReply(ctx, "پنل با موفقیت ذخیره شد ✅");
    await safeReply(
      ctx,
      "بعداً باید شناسه‌های inbound و دامنه ساب را از مدیریت پنل تکمیل کنید و «تست اتصال» را اجرا کنید.",
    );
    await safeReply(ctx, panelDetailText(panel), panelDetailKeyboard(panel), HTML);
    return;
  }

  if (state.step === "username") {
    if (value.length === 0) {
      await safeReply(ctx, "نام کاربری نمی‌تواند خالی باشد. دوباره وارد کنید.");
      return;
    }
    state.username = value;
    state.step = "password";
    await safeReply(ctx, "رمز عبور پنل را وارد کنید.", cancelKeyboard());
    return;
  }

  if (state.step === "password") {
    if (value.length === 0) {
      await safeReply(ctx, "مقدار نمی‌تواند خالی باشد. دوباره وارد کنید.");
      return;
    }
    const encrypted = encryptSecret(value); // may throw SecretConfigError
    const panel = await createPanel({
      type: state.type,
      name: state.name ?? "پنل",
      baseUrl: state.baseUrl ?? "",
      username: state.username ?? null,
      passwordEncrypted: encrypted,
      tokenEncrypted: null,
      authMode: state.type === "XUI" ? "SESSION_COOKIE" : null,
    });
    clearFlow(ctx);
    await safeReply(ctx, "پنل با موفقیت ذخیره شد ✅");
    const warning =
      panel.type === "MARZBAN"
        ? "بعداً باید اکانت نمونه (یا تنظیمات پروتکل) و دامنه ساب را از مدیریت پنل تکمیل کنید و «تست اتصال» را اجرا کنید."
        : "بعداً باید شناسه‌های inbound و دامنه ساب را از مدیریت پنل تکمیل کنید و «تست اتصال» را اجرا کنید.";
    await safeReply(ctx, warning);
    await safeReply(ctx, panelDetailText(panel), panelDetailKeyboard(panel), HTML);
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
  const updated = await updatePanel(panelId, { baseUrl: result.value, ...readinessResetData() });
  clearFlow(ctx);
  await safeReply(ctx, "آدرس بروزرسانی شد ✅");
  await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated), HTML);
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
  if (kind === "token") {
    const encrypted = encryptSecret(value); // may throw SecretConfigError
    // A credential change invalidates the persisted readiness result.
    const updated = await updatePanel(panelId, {
      tokenEncrypted: encrypted,
      ...readinessResetData(),
    });
    clearFlow(ctx);
    await safeReply(ctx, `توکن API بروزرسانی شد ✅ (${maskSecretEdges(value)})`);
    await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated), HTML);
    return;
  }
  if (kind === "cred-username") {
    ctx.session.temp.editingCredentialUsername = value;
    ctx.session.temp.editingCredential = "cred-password";
    await safeReply(ctx, "رمز عبور پنل را وارد کنید.", cancelKeyboard());
    return;
  }
  const username = ctx.session.temp.editingCredentialUsername ?? null;
  const encrypted = encryptSecret(value); // may throw SecretConfigError
  // A credential change invalidates the persisted readiness result.
  const updated = await updatePanel(panelId, {
    ...(username !== null ? { username } : {}),
    passwordEncrypted: encrypted,
    ...readinessResetData(),
  });
  clearFlow(ctx);
  await safeReply(ctx, `اطلاعات ورود بروزرسانی شد ✅ (${maskSecretEdges(value)})`);
  await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated), HTML);
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
    ...(READINESS_RELEVANT_COLUMNS.has(field.column) ? readinessResetData() : {}),
  } as Prisma.PanelUpdateInput);
  clearFlow(ctx);
  await safeReply(ctx, `«${field.label}» بروزرسانی شد ✅`);
  // Shrinking the XUI inbound allowlist can strand products whose selection
  // now falls outside it - they become unsellable until fixed. Warn loudly.
  if (field.column === "inboundIds" && updated.type === "XUI") {
    const products = await prisma.product.findMany({
      where: { panelId: updated.id, type: "SERVICE_PRODUCT" },
      select: { name: true, inboundIds: true },
    });
    const violating = products.filter(
      (product) => !resolveProductInboundIds(updated, product.inboundIds).ok,
    );
    if (violating.length > 0) {
      const names = violating
        .slice(0, 5)
        .map((product) => `• ${product.name}`)
        .join("\n");
      await safeReply(
        ctx,
        `⚠️ ${violating.length} محصول این پنل اینباندهایی خارج از لیست مجاز جدید دارند و تا اصلاح، قابل فروش نیستند:\n${names}${violating.length > 5 ? "\n..." : ""}`,
      );
    }
  }
  // The name field belongs to the detail view; group fields return to their page.
  if (field.page === "detail") {
    await safeReply(ctx, panelDetailText(updated), panelDetailKeyboard(updated), HTML);
    return;
  }
  const view = panelPageView(updated, field.page);
  await safeReply(ctx, view.text, view.keyboard, HTML);
}
