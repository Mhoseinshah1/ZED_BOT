import type { MiniAppCommerceSwitchKey } from "@zedbot/shared";
import { MINIAPP_COMMERCE_SWITCH_KEYS } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  compareAndSetMiniAppSwitch,
  readAllMiniAppSwitches,
} from "../../services/miniapp-commerce-settings.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Mini App commerce rollout — OWNER settings page (miniapp-commerce-parity).
// Nine independent switches, all seeded FALSE. Each toggle is an atomic CAS
// (a concurrent double-tap loses cleanly and the screen re-renders the truth).
// Disabling a switch only blocks NEW Mini App work at the API's fresh
// fail-closed mutation guards — it never touches settled payments, paid
// orders, provisioned services or delivered content.
// =============================================================================

const OWNER_ONLY_TOAST = "این بخش فقط برای مالک ربات در دسترس است.";

export const MAPP_ADMIN_CB = {
  root: "admin:mapp:root",
  toggle: (index: number): string => `admin:mapp:t:${index}`,
} as const;

const SWITCH_LABELS: Record<MiniAppCommerceSwitchKey, string> = {
  miniapp_commerce_enabled: "خرید از مینی‌اپ (سوییچ اصلی)",
  miniapp_wallet_topup_enabled: "شارژ کیف پول از مینی‌اپ",
  miniapp_card_to_card_enabled: "کارت‌به‌کارت و آپلود رسید",
  miniapp_online_payments_enabled: "درگاه‌های آنلاین",
  miniapp_service_delivery_enabled: "نمایش لینک/کانفیگ/QR سرویس",
  miniapp_service_renewal_enabled: "تمدید سرویس از مینی‌اپ",
  miniapp_extra_volume_enabled: "خرید حجم اضافه از مینی‌اپ",
  miniapp_extra_time_enabled: "خرید زمان اضافه از مینی‌اپ",
  miniapp_other_products_enabled: "محصولات دیگر در مینی‌اپ",
};

export const miniAppCommerceAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

async function renderRoot(ctx: BotContext): Promise<void> {
  const switches = await readAllMiniAppSwitches();
  const lines = [
    "<b>فروش در مینی‌اپ 🛍</b>",
    "",
    "هر سوییچ مستقل است و پیش‌فرض همه خاموش است. خاموش‌کردن فقط جلوی عملیات جدید در مینی‌اپ را می‌گیرد؛ پرداخت‌های تسویه‌شده و سرویس‌های تحویل‌شده دست‌نخورده می‌مانند.",
    "",
    "ترتیب پیشنهادی فعال‌سازی: ابتدا سوییچ اصلی، سپس پرداخت کیف پول، بعد کارت‌به‌کارت، بعد درگاه‌ها، و در انتها تمدید/حجم/زمان و محصولات دیگر.",
  ];
  const kb = new InlineKeyboard();
  switches.forEach((row, index) => {
    kb.text(
      `${row.enabled ? "✅" : "❌"} ${SWITCH_LABELS[row.key]}`,
      MAPP_ADMIN_CB.toggle(index),
    ).row();
  });
  kb.text("بازگشت ◀️", CB.ADMIN_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, { parseMode: "HTML" });
  ctx.session.lastMenu = CB.ADMIN_MINI_APP_SETTINGS;
}

miniAppCommerceAdminHandler.callbackQuery(
  [MAPP_ADMIN_CB.root, CB.ADMIN_MINI_APP_SETTINGS],
  async (ctx) => {
    if (!isOwner(ctx)) {
      await safeAnswerCallback(ctx, OWNER_ONLY_TOAST);
      return;
    }
    await safeAnswerCallback(ctx);
    await renderRoot(ctx);
  },
);

miniAppCommerceAdminHandler.callbackQuery(/^admin:mapp:t:(\d)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TOAST);
    return;
  }
  const index = Number(ctx.match[1]);
  const key = MINIAPP_COMMERCE_SWITCH_KEYS[index];
  if (key === undefined) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  const switches = await readAllMiniAppSwitches();
  const current = switches.find((row) => row.key === key)?.enabled ?? false;
  const changed = await compareAndSetMiniAppSwitch(key, current);
  await safeAnswerCallback(
    ctx,
    changed
      ? current
        ? "غیرفعال شد."
        : "فعال شد."
      : "وضعیت هم‌زمان تغییر کرده بود؛ صفحه به‌روزرسانی شد.",
  );
  await renderRoot(ctx);
});
