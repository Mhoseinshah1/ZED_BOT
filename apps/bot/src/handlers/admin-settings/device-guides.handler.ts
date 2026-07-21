import {
  GUIDE_DISPLAY_NAME_MAX,
  GUIDE_DISPLAY_NAME_MIN,
  GUIDE_ICON_EMOJI_MAX,
  GUIDE_INSTRUCTIONS_MAX,
  GUIDE_INSTRUCTIONS_MIN,
  GUIDE_PLATFORM_CODE,
  GUIDE_SORT_ORDER_MAX,
  GUIDE_SORT_ORDER_MIN,
  GUIDE_TROUBLESHOOTING_MAX,
  guidePlatformFromCode,
  isGuidePlatform,
  validateHttpsDownloadUrl,
  type GuidePlatform,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import {
  archiveGuideApp,
  createGuideApp,
  disableConnectionGuides,
  enableConnectionGuides,
  evaluateGuideReadiness,
  getGuideAppByShortIdAdmin,
  guideAdminPlatformCounts,
  guideAppInvalidReasons,
  listGuideAppsForPlatformAdmin,
  moveGuideApp,
  setGuideAppActive,
  updateGuideAppFields,
  validateGuideAppInput,
} from "../../services/connection-guide.service.js";
import { writeSystemLog } from "../../services/system-log.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  DEV_GUIDE_CB,
  DEV_GUIDE_HTML,
  devGuideAppEditorKeyboard,
  devGuideAppEditorText,
  devGuideConfirmKeyboard,
  devGuideLandingKeyboard,
  devGuideLandingText,
  devGuidePlatformKeyboard,
  devGuidePlatformText,
  devGuidePreviewKeyboard,
  devGuidePreviewText,
  devGuideReadinessReport,
  GUIDE_ADMIN_PAGE_SIZE,
  GUIDE_EDIT_FIELDS,
  GUIDE_FIELD_PROMPT,
  GUIDE_METHOD_CODES,
  type GuideEditField,
} from "./device-guides-views.js";

// =============================================================================
// Device connection guides — OWNER admin (feat/device-connection-guides).
// Landing + per-platform CRUD (add/edit/reorder/enable-disable/archive/preview)
// + the enable readiness gate. Every mutation: OWNER only (re-resolved per
// update, never session-trusted), allowlisted fields, bounded input, cache
// invalidated by the service, and a SAFE audit event (action/platform/short id
// only — never the URL, instructions or a Service secret).
// =============================================================================

const OWNER_ONLY_TOAST = "این بخش فقط برای مالک ربات در دسترس است.";
const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED = "این فرایند منقضی شده است؛ دوباره تلاش کنید.";

const CREATE_NAME_FLOW = "admin_devguide:create_name";
const CREATE_URL_FLOW = "admin_devguide:create_url";
const CREATE_INSTR_FLOW = "admin_devguide:create_instr";
const EDIT_FLOW = "admin_devguide:edit";
const ALL_FLOWS = [CREATE_NAME_FLOW, CREATE_URL_FLOW, CREATE_INSTR_FLOW, EDIT_FLOW];

export const deviceGuidesHandler = new Composer<BotContext>();
export const deviceGuidesTextHandler = new Composer<BotContext>();

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

function clearDeviceGuideState(ctx: BotContext): void {
  if (ctx.session.currentFlow !== null && ALL_FLOWS.includes(ctx.session.currentFlow)) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminDeviceGuideDraft;
}

/** Safe audit — action/platform/short id only; never URL/instructions/secret. */
function auditGuide(
  ctx: BotContext,
  action: string,
  meta: Record<string, string | number> = {},
): void {
  void writeSystemLog({
    level: "INFO",
    eventType: "CONNECTION_GUIDE_CHANGED",
    message: `connection guide ${action}`,
    topicKey: "SECURITY",
    adminId: ctx.admin?.id,
    metadata: { action, ...meta },
  });
}

// --- landing -----------------------------------------------------------------
export async function renderDeviceGuideLanding(ctx: BotContext): Promise<void> {
  clearDeviceGuideState(ctx);
  await safeAnswerCallback(ctx);
  const [readiness, counts] = await Promise.all([
    evaluateGuideReadiness(),
    guideAdminPlatformCounts(),
  ]);
  await safeEditOrReply(
    ctx,
    devGuideLandingText(readiness, counts),
    devGuideLandingKeyboard(readiness),
  );
}

deviceGuidesHandler.callbackQuery(DEV_GUIDE_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await renderDeviceGuideLanding(ctx);
});

// --- platform page (paginated so an unbounded app count can't overflow) ------
async function renderPlatformPage(
  ctx: BotContext,
  platform: GuidePlatform,
  page = 0,
): Promise<void> {
  const apps = await listGuideAppsForPlatformAdmin(platform);
  const pageCount = Math.max(1, Math.ceil(apps.length / GUIDE_ADMIN_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageApps = apps.slice(safePage * GUIDE_ADMIN_PAGE_SIZE, (safePage + 1) * GUIDE_ADMIN_PAGE_SIZE);
  await safeEditOrReply(
    ctx,
    devGuidePlatformText(platform, pageApps, safePage, pageCount, apps.length),
    devGuidePlatformKeyboard(platform, pageApps, safePage, pageCount),
  );
}

deviceGuidesHandler.callbackQuery(/^admin:devguide:p:([a-z0-9]+)(?::(\d+))?$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const platform = guidePlatformFromCode(ctx.match[1]);
  if (platform === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const page = ctx.match[2] === undefined ? 0 : Number.parseInt(ctx.match[2], 10);
  clearDeviceGuideState(ctx);
  await safeAnswerCallback(ctx);
  await renderPlatformPage(ctx, platform, page);
});

// --- app editor --------------------------------------------------------------
async function renderAppEditor(ctx: BotContext, shortId: string): Promise<void> {
  const app = await getGuideAppByShortIdAdmin(shortId);
  if (app === null) {
    await safeEditOrReply(
      ctx,
      NOT_FOUND,
      new InlineKeyboard().text("بازگشت به راهنمای اتصال", DEV_GUIDE_CB.root),
    );
    return;
  }
  await safeEditOrReply(ctx, devGuideAppEditorText(app), devGuideAppEditorKeyboard(app), DEV_GUIDE_HTML);
}

deviceGuidesHandler.callbackQuery(/^admin:devguide:app:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  clearDeviceGuideState(ctx);
  await safeAnswerCallback(ctx);
  await renderAppEditor(ctx, ctx.match[1]);
});

// --- create wizard (add -> name -> primary url -> instructions -> create) ----
deviceGuidesHandler.callbackQuery(/^admin:devguide:add:([a-z0-9]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const platform = guidePlatformFromCode(ctx.match[1]);
  if (platform === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminDeviceGuideDraft = { mode: "create", platform };
  ctx.session.currentFlow = CREATE_NAME_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    GUIDE_FIELD_PROMPT.name,
    new InlineKeyboard().text("انصراف", DEV_GUIDE_CB.platform(GUIDE_PLATFORM_CODE[platform])),
  );
});

// --- edit a single field -----------------------------------------------------
const EDIT_FIELD_BY_CODE: Record<string, GuideEditField> = Object.fromEntries(
  Object.values(GUIDE_EDIT_FIELDS).map((f) => [f, f]),
);

deviceGuidesHandler.callbackQuery(/^admin:devguide:edit:([0-9a-f-]+):([a-z_]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const field = EDIT_FIELD_BY_CODE[ctx.match[2]];
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null || field === undefined) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminDeviceGuideDraft = { mode: "edit", appId: app.id, field };
  ctx.session.currentFlow = EDIT_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    GUIDE_FIELD_PROMPT[field],
    new InlineKeyboard().text("انصراف", DEV_GUIDE_CB.app(app.id.slice(0, 8))),
  );
});

// --- method toggles ----------------------------------------------------------
deviceGuidesHandler.callbackQuery(/^admin:devguide:m:([0-9a-f-]+):([a-z]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const code = ctx.match[2];
  const fields =
    code === GUIDE_METHOD_CODES.subscription
      ? { supportsSubscription: !app.supportsSubscription }
      : code === GUIDE_METHOD_CODES.qr
        ? { supportsQr: !app.supportsQr }
        : code === GUIDE_METHOD_CODES.configs
          ? { supportsIndividualConfigs: !app.supportsIndividualConfigs }
          : null;
  if (fields === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // An ACTIVE app must never be left with zero connection methods: that would keep
  // it selectable by users while offering no subscription/config/QR action (the
  // NO_METHOD invalid state the readiness gate rejects). Block the toggle and ask
  // the OWNER to deactivate first; an INACTIVE app may freely reach zero methods.
  const next = {
    supportsSubscription: app.supportsSubscription,
    supportsQr: app.supportsQr,
    supportsIndividualConfigs: app.supportsIndividualConfigs,
    ...fields,
  };
  if (
    app.isActive &&
    !next.supportsSubscription &&
    !next.supportsQr &&
    !next.supportsIndividualConfigs
  ) {
    await safeAnswerCallback(
      ctx,
      "برای حذف آخرین روش اتصال، ابتدا برنامه را غیرفعال کنید.",
    );
    return;
  }
  await updateGuideAppFields(app.id, fields, ctx.admin?.id ?? "");
  auditGuide(ctx, "method_toggle", { platform: app.platform, appShortId: app.id.slice(0, 8), method: code });
  await safeAnswerCallback(ctx);
  await renderAppEditor(ctx, ctx.match[1]);
});

// --- reorder -----------------------------------------------------------------
async function handleMove(ctx: BotContext, shortId: string, direction: "up" | "down"): Promise<void> {
  const app = await getGuideAppByShortIdAdmin(shortId);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const moved = await moveGuideApp(app.id, direction, ctx.admin?.id ?? "");
  if (moved) {
    auditGuide(ctx, "reorder", { platform: app.platform, appShortId: shortId, direction });
  }
  await safeAnswerCallback(ctx);
  await renderAppEditor(ctx, shortId);
}

deviceGuidesHandler.callbackQuery(/^admin:devguide:up:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await handleMove(ctx, ctx.match[1], "up");
});
deviceGuidesHandler.callbackQuery(/^admin:devguide:down:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await handleMove(ctx, ctx.match[1], "down");
});

// --- preview -----------------------------------------------------------------
deviceGuidesHandler.callbackQuery(/^admin:devguide:prev:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, devGuidePreviewText(app), devGuidePreviewKeyboard(app), DEV_GUIDE_HTML);
});

// --- activate / deactivate (confirm, direction baked in) ---------------------
deviceGuidesHandler.callbackQuery(/^admin:devguide:tg:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const target = !app.isActive;
  if (target && guideAppInvalidReasons(app).length > 0) {
    await safeAnswerCallback(ctx, "برنامه ناقص است؛ ابتدا فیلدها را کامل کنید.");
    await renderAppEditor(ctx, ctx.match[1]);
    return;
  }
  await safeAnswerCallback(ctx);
  const label = target ? "بله، فعال کن ✅" : "بله، غیرفعال کن ⏸";
  await safeEditOrReply(
    ctx,
    target ? "این برنامه فعال شود؟" : "این برنامه غیرفعال شود؟",
    devGuideConfirmKeyboard(
      DEV_GUIDE_CB.toggleConfirm(app.id.slice(0, 8), target),
      DEV_GUIDE_CB.app(app.id.slice(0, 8)),
      label,
    ),
  );
});

deviceGuidesHandler.callbackQuery(/^admin:devguide:tg:([0-9a-f-]+):(on|off)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const target = ctx.match[2] === "on";
  // Stale-confirmation defense: re-validate at confirm time.
  if (target && guideAppInvalidReasons(app).length > 0) {
    await safeAnswerCallback(ctx, "برنامه ناقص است؛ ابتدا فیلدها را کامل کنید.");
    await renderAppEditor(ctx, ctx.match[1]);
    return;
  }
  await setGuideAppActive(app.id, target, ctx.admin?.id ?? "");
  auditGuide(ctx, target ? "activate" : "deactivate", {
    platform: app.platform,
    appShortId: app.id.slice(0, 8),
  });
  await safeAnswerCallback(ctx);
  await renderAppEditor(ctx, ctx.match[1]);
});

// --- archive (confirm) -------------------------------------------------------
deviceGuidesHandler.callbackQuery(/^admin:devguide:arch:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "این برنامه آرشیو شود؟ (از فهرست حذف اما برای سوابق نگه داشته می‌شود)",
    devGuideConfirmKeyboard(
      DEV_GUIDE_CB.archiveYes(app.id.slice(0, 8)),
      DEV_GUIDE_CB.app(app.id.slice(0, 8)),
      "بله، آرشیو کن 🗄",
    ),
  );
});

deviceGuidesHandler.callbackQuery(/^admin:devguide:arch:([0-9a-f-]+):yes$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const app = await getGuideAppByShortIdAdmin(ctx.match[1]);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const platform = app.platform;
  await archiveGuideApp(app.id, ctx.admin?.id ?? "");
  auditGuide(ctx, "archive", { platform, appShortId: app.id.slice(0, 8) });
  await safeAnswerCallback(ctx);
  if (isGuidePlatform(platform)) {
    await renderPlatformPage(ctx, platform);
  } else {
    await renderDeviceGuideLanding(ctx);
  }
});

// --- system enable / disable (readiness gate) --------------------------------
deviceGuidesHandler.callbackQuery(DEV_GUIDE_CB.enable, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const readiness = await evaluateGuideReadiness();
  await safeAnswerCallback(ctx);
  if (!readiness.ready) {
    await safeEditOrReply(
      ctx,
      devGuideReadinessReport(readiness),
      new InlineKeyboard().text("بازگشت", DEV_GUIDE_CB.root),
    );
    return;
  }
  await safeEditOrReply(
    ctx,
    `${devGuideReadinessReport(readiness)}\n\nسیستم راهنمای اتصال فعال شود؟`,
    devGuideConfirmKeyboard(DEV_GUIDE_CB.enableYes, DEV_GUIDE_CB.root, "بله، فعال کن ✅"),
  );
});

deviceGuidesHandler.callbackQuery(DEV_GUIDE_CB.enableYes, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const outcome = await enableConnectionGuides();
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, "هنوز آماده فعال‌سازی نیست.");
    await safeEditOrReply(
      ctx,
      devGuideReadinessReport(outcome.readiness),
      new InlineKeyboard().text("بازگشت", DEV_GUIDE_CB.root),
    );
    return;
  }
  auditGuide(ctx, "system_enabled");
  await safeAnswerCallback(ctx, "فعال شد ✅");
  await renderDeviceGuideLanding(ctx);
});

deviceGuidesHandler.callbackQuery(DEV_GUIDE_CB.disable, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "سیستم راهنمای اتصال غیرفعال شود؟ (تنظیمات حذف نمی‌شود)",
    devGuideConfirmKeyboard(DEV_GUIDE_CB.disableYes, DEV_GUIDE_CB.root, "بله، غیرفعال کن ⛔️"),
  );
});

deviceGuidesHandler.callbackQuery(DEV_GUIDE_CB.disableYes, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await disableConnectionGuides();
  auditGuide(ctx, "system_disabled");
  await safeAnswerCallback(ctx, "غیرفعال شد ⛔️");
  await renderDeviceGuideLanding(ctx);
});

// --- text-input flows --------------------------------------------------------
deviceGuidesTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow === null || !ALL_FLOWS.includes(flow)) {
    return next();
  }
  if (!isOwner(ctx)) {
    clearDeviceGuideState(ctx);
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearDeviceGuideState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminDeviceGuideDraft;
  if (draft === undefined) {
    clearDeviceGuideState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED);
    return;
  }

  if (flow === CREATE_NAME_FLOW) {
    const name = text.trim();
    if (name.length < GUIDE_DISPLAY_NAME_MIN || name.length > GUIDE_DISPLAY_NAME_MAX) {
      await safeReply(ctx, `نام نامعتبر است (۲ تا ${GUIDE_DISPLAY_NAME_MAX} کاراکتر).`);
      return;
    }
    draft.displayName = name;
    ctx.session.currentFlow = CREATE_URL_FLOW;
    await safeReply(ctx, GUIDE_FIELD_PROMPT.primary);
    return;
  }

  if (flow === CREATE_URL_FLOW) {
    const url = validateHttpsDownloadUrl(text);
    if (!url.ok) {
      await safeReply(ctx, "لینک نامعتبر است؛ فقط HTTPS و بدون نام‌کاربری/رمز مجاز است.");
      return;
    }
    draft.primaryDownloadUrl = url.url;
    ctx.session.currentFlow = CREATE_INSTR_FLOW;
    await safeReply(ctx, GUIDE_FIELD_PROMPT.instr);
    return;
  }

  if (flow === CREATE_INSTR_FLOW) {
    const instructions = text.trim();
    if (instructions.length < GUIDE_INSTRUCTIONS_MIN || instructions.length > GUIDE_INSTRUCTIONS_MAX) {
      await safeReply(ctx, `متن آموزش نامعتبر است (۵ تا ${GUIDE_INSTRUCTIONS_MAX} کاراکتر).`);
      return;
    }
    const validated = validateGuideAppInput({
      platform: draft.platform ?? "",
      displayName: draft.displayName ?? "",
      iconEmoji: "📱",
      primaryDownloadUrl: draft.primaryDownloadUrl ?? "",
      alternateDownloadUrl: null,
      supportsSubscription: true,
      supportsQr: true,
      supportsIndividualConfigs: true,
      instructions,
      troubleshooting: "",
      sortOrder: 0,
    });
    if (!validated.ok) {
      clearDeviceGuideState(ctx);
      await safeReply(ctx, "ساخت برنامه ناموفق بود؛ لطفاً دوباره تلاش کنید.");
      return;
    }
    const app = await createGuideApp(validated.value, ctx.admin?.id ?? "");
    auditGuide(ctx, "create", { platform: app.platform, appShortId: app.id.slice(0, 8) });
    clearDeviceGuideState(ctx);
    await safeReply(
      ctx,
      "برنامه ساخته شد (غیرفعال). فیلدها را کامل و سپس آن را فعال کنید.",
      devGuideAppEditorKeyboard(app),
      DEV_GUIDE_HTML,
    );
    return;
  }

  // EDIT_FLOW — single field update.
  const app = draft.appId === undefined ? null : await getGuideAppByShortIdAdmin(draft.appId.slice(0, 8));
  const field = draft.field as GuideEditField | undefined;
  if (app === null || field === undefined) {
    clearDeviceGuideState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED);
    return;
  }
  const outcome = await applyFieldEdit(app.id, field, text, ctx.admin?.id ?? "");
  if (!outcome.ok) {
    await safeReply(ctx, outcome.message);
    return;
  }
  auditGuide(ctx, "edit_field", { platform: app.platform, appShortId: app.id.slice(0, 8), field });
  clearDeviceGuideState(ctx);
  const updated = await getGuideAppByShortIdAdmin(app.id.slice(0, 8));
  if (updated !== null) {
    await safeReply(
      ctx,
      devGuideAppEditorText(updated),
      devGuideAppEditorKeyboard(updated),
      DEV_GUIDE_HTML,
    );
  }
});

async function applyFieldEdit(
  id: string,
  field: GuideEditField,
  raw: string,
  adminId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const text = raw.trim();
  switch (field) {
    case GUIDE_EDIT_FIELDS.name: {
      if (text.length < GUIDE_DISPLAY_NAME_MIN || text.length > GUIDE_DISPLAY_NAME_MAX) {
        return { ok: false, message: `نام نامعتبر است (۲ تا ${GUIDE_DISPLAY_NAME_MAX} کاراکتر).` };
      }
      await updateGuideAppFields(id, { displayName: text }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.icon: {
      if (text.length === 0 || text.length > GUIDE_ICON_EMOJI_MAX) {
        return { ok: false, message: "آیکون نامعتبر است." };
      }
      await updateGuideAppFields(id, { iconEmoji: text }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.primary: {
      const url = validateHttpsDownloadUrl(raw);
      if (!url.ok) {
        return { ok: false, message: "لینک نامعتبر است؛ فقط HTTPS و بدون نام‌کاربری/رمز مجاز است." };
      }
      await updateGuideAppFields(id, { primaryDownloadUrl: url.url }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.alternate: {
      if (text === "-") {
        await updateGuideAppFields(id, { alternateDownloadUrl: null }, adminId);
        return { ok: true };
      }
      const url = validateHttpsDownloadUrl(raw);
      if (!url.ok) {
        return { ok: false, message: "لینک نامعتبر است؛ فقط HTTPS مجاز است." };
      }
      await updateGuideAppFields(id, { alternateDownloadUrl: url.url }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.instructions: {
      if (text.length < GUIDE_INSTRUCTIONS_MIN || text.length > GUIDE_INSTRUCTIONS_MAX) {
        return { ok: false, message: `متن آموزش نامعتبر است (۵ تا ${GUIDE_INSTRUCTIONS_MAX} کاراکتر).` };
      }
      await updateGuideAppFields(id, { instructions: text }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.troubleshooting: {
      const value = text === "-" ? "" : text;
      if (value.length > GUIDE_TROUBLESHOOTING_MAX) {
        return { ok: false, message: `متن رفع اشکال طولانی است (حداکثر ${GUIDE_TROUBLESHOOTING_MAX}).` };
      }
      await updateGuideAppFields(id, { troubleshooting: value }, adminId);
      return { ok: true };
    }
    case GUIDE_EDIT_FIELDS.sort: {
      // Require an all-digits string: `Number.parseInt` would otherwise accept
      // "12abc" as 12 and silently persist a partially-parsed sort order.
      const raw = text.trim();
      if (!/^\d+$/.test(raw)) {
        return { ok: false, message: `عدد ترتیب نامعتبر است (۰ تا ${GUIDE_SORT_ORDER_MAX}).` };
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < GUIDE_SORT_ORDER_MIN || n > GUIDE_SORT_ORDER_MAX) {
        return { ok: false, message: `عدد ترتیب نامعتبر است (۰ تا ${GUIDE_SORT_ORDER_MAX}).` };
      }
      await updateGuideAppFields(id, { sortOrder: n }, adminId);
      return { ok: true };
    }
    default:
      return { ok: false, message: NOT_FOUND };
  }
}
