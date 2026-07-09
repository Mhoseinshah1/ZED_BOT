import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildBackToAdminMenuKeyboard } from "../keyboards/common.keyboard.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";
import { PLACEHOLDER_TEXT } from "./user-placeholders.handler.js";

const ADMIN_SECTIONS: Array<{ callback: string; title: string }> = [
  { callback: CB.ADMIN_FINANCE, title: "مالی 💎" },
  { callback: CB.ADMIN_PANEL_FEATURES, title: "قابلیت‌های پنل 🛠" },
  { callback: CB.ADMIN_UPDATE_BOT, title: "آپدیت ربات 🆕" },
  { callback: CB.ADMIN_RECEIPTS, title: "رسیدهای تایید نشده 💵" },
  { callback: CB.ADMIN_TUTORIALS, title: "بخش آموزش 📚" },
  { callback: CB.ADMIN_GENERAL_SETTINGS, title: "تنظیمات عمومی ⚙️" },
  { callback: CB.ADMIN_MINI_APP_SETTINGS, title: "تنظیمات مینی اپ ⚙️" },
  { callback: CB.ADMIN_USERS, title: "مدیریت کاربران 👤" },
  { callback: CB.ADMIN_PRODUCTS, title: "مدیریت محصولات/پلن‌ها" },
  { callback: CB.ADMIN_PANELS, title: "مدیریت پنل‌ها" },
  { callback: CB.ADMIN_CUSTOM_SERVICE_PRICE, title: "قیمت سرویس دلخواه 🛰" },
  { callback: CB.ADMIN_OTHER_PRODUCTS, title: "محصولات دیگر / سفارش‌های محصولات دیگر" },
  { callback: CB.ADMIN_REPORTS_BACKUP, title: "گزارشات / بکاپ" },
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
