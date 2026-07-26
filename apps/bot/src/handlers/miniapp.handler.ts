import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { miniAppUrl } from "../services/miniapp.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../utils/safe-reply.js";

// =============================================================================
// The Mini App entry SCREEN: /app, the `user:miniapp` callback, and the one
// place a `web_app` button exists.
//
// The main menu reaches this page through an ordinary callback rather than
// carrying a `web_app` button itself. That is not a workaround — it is what
// lets ONE menu definition serve both renderers. A reply keyboard's buttons are
// text only, so a `web_app` entry in the shared definition could not exist in
// REPLY mode at all, and the two modes would silently offer different features.
// A normal action works identically in both, and this page then presents the
// real `web_app` button (plus the short explanation of what the panel is and
// what it deliberately cannot do).
//
// The entry is GATED on configuration, not on a database flag. Telegram refuses
// a `web_app` button whose URL is not https, and a button that opens a 404 is
// worse than no button, so when `MINIAPP_PUBLIC_URL` is missing or is not an
// https URL this answers with a short explanation instead of rendering
// something broken. The menu hides the row in that case; this screen still
// refuses safely, because a stale reply keyboard can outlive the setting.
// =============================================================================

export const MINIAPP_UNAVAILABLE_TEXT =
  "پنل کاربری تحت وب هنوز فعال نشده است. از منوی ربات استفاده کنید.";

export const MINIAPP_INTRO_TEXT =
  "پنل کاربری تحت وب\n\n" +
  "مشاهدهٔ موجودی کیف پول، سرویس‌ها و تراکنش‌ها در یک صفحهٔ واحد.\n" +
  "این صفحه فقط برای مشاهده است؛ خرید، پرداخت و تغییر سرویس‌ها در همین ربات انجام می‌شود.";

export const MINIAPP_BUTTON_TEXT = "باز کردن پنل کاربری 🌐";

// Re-exported so existing importers keep one path to it; the resolution itself
// lives in the service the menu definition also consults.
export { miniAppUrl };

export const miniAppHandler = new Composer<BotContext>();

export async function showMiniAppEntry(ctx: BotContext): Promise<void> {
  const url = miniAppUrl();
  if (ctx.callbackQuery !== undefined) {
    await safeAnswerCallback(ctx);
  }
  if (url === null) {
    await safeReply(ctx, MINIAPP_UNAVAILABLE_TEXT);
    return;
  }
  const keyboard = new InlineKeyboard()
    .webApp(MINIAPP_BUTTON_TEXT, url)
    .row()
    .text("بازگشت", CB.USER_MENU);
  if (ctx.callbackQuery !== undefined) {
    await safeEditOrReply(ctx, MINIAPP_INTRO_TEXT, keyboard);
  } else {
    await safeReply(ctx, MINIAPP_INTRO_TEXT, keyboard);
  }
}

miniAppHandler.command("app", showMiniAppEntry);
miniAppHandler.callbackQuery(CB.USER_MINIAPP, showMiniAppEntry);
