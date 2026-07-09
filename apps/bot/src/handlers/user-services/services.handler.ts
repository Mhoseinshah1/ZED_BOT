import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
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
} from "./service-views.js";

// =============================================================================
// "سرویس‌های من 🛍" (Phase 10) - strictly read-only over stored Service rows.
// No panel API calls, no Service mutations, no renewal/actions (later
// phases). Every route re-validates ownership; subscription links and
// configs are shown only to their owner and never logged.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const MAX_CONFIGS_SHOWN = 10;
const HTML = { parseMode: "HTML" as const };

export const servicesHandler = new Composer<BotContext>();

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
  await safeEditOrReply(ctx, serviceDetailText(service), serviceDetailKeyboard(service), HTML);
});

// Phase 10: refresh re-reads from the DATABASE only - panel sync is a later phase.
servicesHandler.callbackQuery(/^user:svc:refresh:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, "اطلاعات از دیتابیس بروزرسانی شد.");
  await safeEditOrReply(ctx, serviceDetailText(service), serviceDetailKeyboard(service), HTML);
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
