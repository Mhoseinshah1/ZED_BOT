import { optionalEnv } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../utils/safe-reply.js";

// =============================================================================
// The Mini App entry point: /app and the `user:miniapp` callback.
//
// A DELIBERATELY separate surface from the main menu. That menu is rendered
// from one shared definition consumed by both an inline and a reply-keyboard
// renderer, and its layout is under an OWNER setting with a documented
// invariant. A `web_app` button cannot exist in a reply keyboard's text-only
// action wiring, so putting one there would mean reshaping the definition and
// both renderers - a large change to a contract this feature has no business
// touching.
//
// The entry is GATED on configuration, not on a database flag. Telegram refuses
// a `web_app` button whose URL is not https, and a button that opens a 404 is
// worse than no button, so when `MINIAPP_PUBLIC_URL` is missing or is not an
// https URL the command answers with a short explanation instead of rendering
// something broken.
// =============================================================================

export const MINIAPP_UNAVAILABLE_TEXT =
  "پنل کاربری تحت وب هنوز فعال نشده است. از منوی ربات استفاده کنید.";

export const MINIAPP_INTRO_TEXT =
  "پنل کاربری تحت وب\n\n" +
  "مشاهدهٔ موجودی کیف پول، سرویس‌ها و تراکنش‌ها در یک صفحهٔ واحد.\n" +
  "این صفحه فقط برای مشاهده است؛ خرید، پرداخت و تغییر سرویس‌ها در همین ربات انجام می‌شود.";

export const MINIAPP_BUTTON_TEXT = "باز کردن پنل کاربری 🌐";

/**
 * The configured public URL, or `null` when the Mini App is not deployed.
 *
 * Telegram requires https for a `web_app` button and rejects the whole
 * keyboard otherwise - which would turn a misconfiguration into a menu that
 * fails to render at all. Validating here means the worst case is a missing
 * button.
 */
export function miniAppUrl(): string | null {
  const raw = optionalEnv("MINIAPP_PUBLIC_URL", "").trim();
  if (raw === "") {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const miniAppHandler = new Composer<BotContext>();

async function showMiniAppEntry(ctx: BotContext): Promise<void> {
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
