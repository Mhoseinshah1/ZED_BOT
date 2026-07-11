import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildBackToAdminMenuKeyboard } from "../keyboards/common.keyboard.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";
import { PLACEHOLDER_TEXT } from "./user-placeholders.handler.js";

const ADMIN_SECTIONS: Array<{ callback: string; title: string }> = [
  // admin:finance is handled by the real finance flow (admin-finance.handler).
  { callback: CB.ADMIN_PANEL_FEATURES, title: "قابلیت‌های پنل 🛠" },
  { callback: CB.ADMIN_UPDATE_BOT, title: "آپدیت ربات 🆕" },
  // admin:receipts is handled by the real receipts list (receipts.handler).
  { callback: CB.ADMIN_TUTORIALS, title: "بخش آموزش 📚" },
  // admin:general_settings is handled by the real text-settings flow (Phase 34).
  { callback: CB.ADMIN_MINI_APP_SETTINGS, title: "تنظیمات مینی اپ ⚙️" },
  // admin:users is handled by the real user management flow (admin-users.handler).
  // admin:products is handled by the real product management flow (product.handler).
  // admin:panels is handled by the real panel management flow (panel.handler).
  { callback: CB.ADMIN_CUSTOM_SERVICE_PRICE, title: "قیمت سرویس دلخواه 🛰" },
  // admin:other_products is handled by the real manual-orders flow (manual-orders.handler).
  // admin:reports_backup is handled by the real backup/health flow (Phase 35).
];

/** Every admin menu button opens a placeholder page in this phase. */
export const adminPlaceholdersHandler = new Composer<BotContext>();

for (const section of ADMIN_SECTIONS) {
  adminPlaceholdersHandler.callbackQuery(section.callback, async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      `${section.title}\n\n${PLACEHOLDER_TEXT}`,
      buildBackToAdminMenuKeyboard(),
    );
    ctx.session.lastMenu = section.callback;
  });
}
