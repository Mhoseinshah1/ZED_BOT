import type { Service } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { syncServiceFromPanel } from "../../services/service-sync.service.js";
import {
  buildTogglePreview,
  getToggleableServiceByShortId,
  resolveToggleAction,
  toggleEligibility,
  toggleServiceStatus,
  TOGGLE_ALREADY_DONE_TEXT,
  TOGGLE_DISABLED_OK_TEXT,
  TOGGLE_ENABLED_OK_TEXT,
  type ToggleAction,
} from "../../services/service-toggle.service.js";
import { getButtonText } from "../../services/text.service.js";
import {
  getOwnedServiceByShortId,
  listUserServices,
} from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  serviceConfigLinks,
  serviceDetailKeyboard,
  serviceDetailText,
  serviceListKeyboard,
  toggleConfirmKeyboard,
} from "./service-views.js";

// =============================================================================
// "سرویس‌های من 🛍" (Phase 10) - read-only over stored Service rows, plus the
// Phase 18 enable/disable toggle (the ONLY user-driven mutation here: an
// eligible service can be switched off/on after an explicit confirmation).
// Every route re-validates ownership; subscription links and configs are
// shown only to their owner and never logged.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const MAX_CONFIGS_SHOWN = 10;
const HTML = { parseMode: "HTML" as const };

export const servicesHandler = new Composer<BotContext>();

/** Detail view; the toggle button appears only when the state allows it. */
async function renderDetail(ctx: BotContext, service: Service): Promise<void> {
  const toggleAction = await resolveToggleAction(service);
  await safeEditOrReply(
    ctx,
    serviceDetailText(service),
    serviceDetailKeyboard(service, toggleAction),
    HTML,
  );
}

async function renderList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserServices(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const buy = await getButtonText("buy_subscription");
    const kb = new InlineKeyboard().text(buy, CB.USER_BUY).row().text("بازگشت به منو", CB.USER_MENU);
    await safeEditOrReply(ctx, "شما هنوز سرویسی ندارید.", kb);
    return;
  }
  await safeEditOrReply(ctx, "سرویس‌های من 🛍", serviceListKeyboard(pageData));
}

servicesHandler.callbackQuery(CB.USER_SERVICES, async (ctx) => {
  await renderList(ctx, 1);
  ctx.session.lastMenu = CB.USER_SERVICES;
});

servicesHandler.callbackQuery(/^user:svc:list:(\d+)$/, async (ctx) => {
  await renderList(ctx, Number.parseInt(ctx.match[1], 10));
});

servicesHandler.callbackQuery(/^user:svc:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, service);
});

// Phase 11: refresh now syncs from the PANEL (read-only). A failed sync
// keeps the stored values on screen; adapter errors never reach the user.
servicesHandler.callbackQuery(/^user:svc:refresh:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const owned = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (owned === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sync = await syncServiceFromPanel(owned.id, user.id);
  if (sync.ok) {
    await safeAnswerCallback(ctx, "اطلاعات از پنل بروزرسانی شد.");
    await renderDetail(ctx, sync.service);
    return;
  }
  if (sync.service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, sync.safeUserMessage);
  await renderDetail(ctx, sync.service);
});

// --- Phase 18: enable/disable toggle ----------------------------------------
// Ask -> explicit confirmation -> panel update -> DB update. The panel is
// NEVER called before the «yes» step, and every step re-validates ownership
// and eligibility (stale buttons answer with a safe toast, nothing changes).

async function askToggle(ctx: BotContext, shortId: string, action: ToggleAction): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getToggleableServiceByShortId(shortId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const eligibility = toggleEligibility(service, service.panel.status, action);
  if (!eligibility.eligible) {
    await safeAnswerCallback(ctx, eligibility.safeUserMessage);
    await renderDetail(ctx, service);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    buildTogglePreview(service, action),
    toggleConfirmKeyboard(shortId, action),
    HTML,
  );
}

async function confirmToggle(
  ctx: BotContext,
  shortId: string,
  action: ToggleAction,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getToggleableServiceByShortId(shortId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await toggleServiceStatus(user.id, service.id, action);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeUserMessage);
    const current = await getOwnedServiceByShortId(shortId, user.id);
    if (current !== null) {
      await renderDetail(ctx, current);
    }
    return;
  }
  const notice = outcome.alreadyDone
    ? TOGGLE_ALREADY_DONE_TEXT
    : action === "DISABLE"
      ? TOGGLE_DISABLED_OK_TEXT
      : TOGGLE_ENABLED_OK_TEXT;
  await safeAnswerCallback(ctx, notice);
  await renderDetail(ctx, outcome.service);
}

servicesHandler.callbackQuery(/^user:svc:disable:([0-9a-f-]+)$/, async (ctx) => {
  await askToggle(ctx, ctx.match[1], "DISABLE");
});

servicesHandler.callbackQuery(/^user:svc:disable:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmToggle(ctx, ctx.match[1], "DISABLE");
});

servicesHandler.callbackQuery(/^user:svc:enable:([0-9a-f-]+)$/, async (ctx) => {
  await askToggle(ctx, ctx.match[1], "ENABLE");
});

servicesHandler.callbackQuery(/^user:svc:enable:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmToggle(ctx, ctx.match[1], "ENABLE");
});

servicesHandler.callbackQuery(/^user:svc:link:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (service.subscriptionUrl === null || service.subscriptionUrl === "") {
    await safeAnswerCallback(ctx, "لینک اشتراک برای این سرویس ثبت نشده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  // <code> is tap-to-copy in official Telegram clients.
  await safeReply(
    ctx,
    `لینک اشتراک شما 🔗\n\n<code>${escapeHtml(service.subscriptionUrl)}</code>`,
    undefined,
    HTML,
  );
});

servicesHandler.callbackQuery(/^user:svc:configs:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const links = serviceConfigLinks(service);
  if (links.length === 0) {
    await safeAnswerCallback(ctx, "کانفیگی برای این سرویس ثبت نشده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  const lines = ["کانفیگ‌های سرویس شما 📄", ""];
  for (const link of links.slice(0, MAX_CONFIGS_SHOWN)) {
    lines.push(`<code>${escapeHtml(link)}</code>`, "");
  }
  if (links.length > MAX_CONFIGS_SHOWN) {
    lines.push(`+${links.length - MAX_CONFIGS_SHOWN} کانفیگ دیگر نمایش داده نشد.`);
  }
  await safeReply(ctx, lines.join("\n").trimEnd(), undefined, HTML);
});
