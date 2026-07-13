import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";

/**
 * Admin main menu. Labels are hardcoded for now - admin buttons are not part
 * of the operator-editable ButtonText baseline yet.
 *
 * Corrective Fix A: «رسیدهای تایید نشده 💵» moved off the root into the
 * finance landing (financeLandingKeyboard) - CB.ADMIN_RECEIPTS and its
 * handler stay fully active for old Telegram keyboards. The unfinished
 * placeholder sections (panel features, bot update, tutorials, mini-app,
 * custom service price) are not rendered here either; their callbacks keep
 * answering via admin-placeholders.handler.
 */
export function buildAdminMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("مالی 💎", CB.ADMIN_FINANCE)
    .text("مدیریت کاربران 👤", CB.ADMIN_USERS)
    .row()
    .text("مدیریت محصولات/پلن‌ها 📦", CB.ADMIN_PRODUCTS)
    .text("مدیریت پنل‌ها 🖥", CB.ADMIN_PANELS)
    .row()
    .text("محصولات دیگر / سفارش‌های محصولات دیگر", CB.ADMIN_OTHER_PRODUCTS)
    .row()
    .text("تیکت‌های پشتیبانی 🎫", CB.ADMIN_SUPPORT)
    .text("پیام همگانی 📣", CB.ADMIN_BROADCAST)
    .row()
    .text("تنظیمات عمومی ⚙️", CB.ADMIN_GENERAL_SETTINGS)
    .text("گزارشات / بکاپ 📊", CB.ADMIN_REPORTS_BACKUP);
}
