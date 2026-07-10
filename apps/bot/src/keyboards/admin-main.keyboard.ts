import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";

/**
 * Admin main menu. Labels are hardcoded for now - admin buttons are not part
 * of the operator-editable ButtonText baseline yet.
 */
export function buildAdminMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("مالی 💎", CB.ADMIN_FINANCE)
    .text("قابلیت‌های پنل 🛠", CB.ADMIN_PANEL_FEATURES)
    .row()
    .text("آپدیت ربات 🆕", CB.ADMIN_UPDATE_BOT)
    .text("رسیدهای تایید نشده 💵", CB.ADMIN_RECEIPTS)
    .row()
    .text("بخش آموزش 📚", CB.ADMIN_TUTORIALS)
    .text("تنظیمات عمومی ⚙️", CB.ADMIN_GENERAL_SETTINGS)
    .row()
    .text("تنظیمات مینی اپ ⚙️", CB.ADMIN_MINI_APP_SETTINGS)
    .text("مدیریت کاربران 👤", CB.ADMIN_USERS)
    .row()
    .text("مدیریت محصولات/پلن‌ها", CB.ADMIN_PRODUCTS)
    .text("مدیریت پنل‌ها", CB.ADMIN_PANELS)
    .row()
    .text("قیمت سرویس دلخواه 🛰", CB.ADMIN_CUSTOM_SERVICE_PRICE)
    .row()
    .text("محصولات دیگر / سفارش‌های محصولات دیگر", CB.ADMIN_OTHER_PRODUCTS)
    .row()
    // Phase 32: support tickets.
    .text("تیکت‌های پشتیبانی 🎫", CB.ADMIN_SUPPORT)
    .row()
    .text("گزارشات / بکاپ", CB.ADMIN_REPORTS_BACKUP);
}
