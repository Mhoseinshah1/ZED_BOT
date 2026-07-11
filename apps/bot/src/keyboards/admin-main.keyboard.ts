import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";

/**
 * Admin main menu. Labels are hardcoded for now - admin buttons are not part
 * of the operator-editable ButtonText baseline yet (documented in
 * docs/ui-ux-alignment-phase39.md).
 *
 * UI alignment (Phase 39): only IMPLEMENTED sections are visible. The
 * unfinished placeholders (panel features, bot update, tutorials, mini-app
 * settings, custom service price) are HIDDEN until their real flows land -
 * their callbacks stay registered in admin-placeholders.handler.ts so
 * buttons on old Telegram messages keep answering.
 */
export function buildAdminMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("مالی 💎", CB.ADMIN_FINANCE)
    .text("رسیدهای تایید نشده 💵", CB.ADMIN_RECEIPTS)
    .row()
    .text("مدیریت کاربران 👤", CB.ADMIN_USERS)
    .text("تنظیمات عمومی ⚙️", CB.ADMIN_GENERAL_SETTINGS)
    .row()
    .text("مدیریت محصولات/پلن‌ها", CB.ADMIN_PRODUCTS)
    .text("مدیریت پنل‌ها", CB.ADMIN_PANELS)
    .row()
    .text("محصولات دیگر / سفارش‌های محصولات دیگر", CB.ADMIN_OTHER_PRODUCTS)
    .row()
    .text("تیکت‌های پشتیبانی 🎫", CB.ADMIN_SUPPORT)
    .text("پیام همگانی 📣", CB.ADMIN_BROADCAST)
    .row()
    .text("گزارشات / بکاپ", CB.ADMIN_REPORTS_BACKUP);
}
