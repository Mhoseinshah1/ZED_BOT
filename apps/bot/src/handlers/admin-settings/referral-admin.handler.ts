import { REFERRAL_SYSTEM_ENABLED_KEY } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  getReferralAdminStats,
  setReferralCommissionPercent,
  setReferralFirstPurchaseOnly,
  setReferralMinPurchaseToman,
  type ReferralAdminStats,
} from "../../services/referral.service.js";
import { clearSettingsCache, compareAndSetBooleanSetting } from "../../services/settings.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Referral affiliate commissions — ADMIN page (Phase 1). OWNER-only. The master
// switch (disabled by default) gates the PAYOUT only — referral attribution linking
// always works. The OWNER sets the commission percent, the first-purchase-only
// policy and the minimum qualifying order, and sees the paid/reversed totals.
// Nothing here moves money or creates a commission.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

export const REF_ADMIN_CB = {
  root: "admin:referral:root",
  enable: "admin:referral:enable",
  disable: "admin:referral:disable",
  first: "admin:referral:first",
  pct: (n: number): string => `admin:referral:pct:${n}`,
  min: (n: number): string => `admin:referral:min:${n}`,
} as const;

const PERCENT_PRESETS = [5, 10, 15, 20, 25];
const MIN_PRESETS = [0, 50_000, 100_000, 200_000];

export const referralAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

function overviewText(s: ReferralAdminStats): string {
  return [
    "👥 <b>زیرمجموعه‌گیری و پاداش</b>",
    "",
    `وضعیت پاداش: ${s.enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `درصد پاداش: ${faDigits(s.commissionPercent)}٪`,
    `فقط اولین خرید: ${s.firstPurchaseOnly ? "بله" : "خیر"}`,
    `حداقل مبلغ خرید: ${faDigits(s.minPurchaseToman.toLocaleString("en-US"))} تومان`,
    "",
    "<b>آمار:</b>",
    `تعداد زیرمجموعه‌ها: ${faDigits(s.totalReferrals)}`,
    `پاداش‌های پرداخت‌شده: ${faDigits(s.paidCommissionCount)} مورد — ${faDigits(s.paidCommissionToman.toLocaleString("en-US"))} تومان`,
    `بازگردانی‌شده: ${faDigits(s.reversedCommissionCount)}`,
  ].join("\n");
}

function overviewKeyboard(s: ReferralAdminStats): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (s.enabled) {
    kb.text("غیرفعال‌سازی پاداش ⛔", REF_ADMIN_CB.disable).row();
  } else {
    kb.text("فعال‌سازی پاداش ✅", REF_ADMIN_CB.enable).row();
  }
  // Commission percent presets.
  for (const p of PERCENT_PRESETS) {
    kb.text(`${p === s.commissionPercent ? "✅ " : ""}${faDigits(p)}٪`, REF_ADMIN_CB.pct(p));
  }
  kb.row();
  kb.text(`فقط اولین خرید: ${s.firstPurchaseOnly ? "✅" : "❌"}`, REF_ADMIN_CB.first).row();
  // Minimum qualifying order presets.
  for (const m of MIN_PRESETS) {
    kb.text(`${m === s.minPurchaseToman ? "✅ " : ""}${faDigits((m / 1000).toString())}k`, REF_ADMIN_CB.min(m));
  }
  kb.row();
  kb.text("بروزرسانی ♻️", REF_ADMIN_CB.root).row();
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  const stats = await getReferralAdminStats();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, overviewText(stats), overviewKeyboard(stats), { parseMode: "HTML" });
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return false;
  }
  return true;
}

referralAdminHandler.callbackQuery(REF_ADMIN_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await renderOverview(ctx);
  ctx.session.lastMenu = REF_ADMIN_CB.root;
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.enable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const flipped = await compareAndSetBooleanSetting(REFERRAL_SYSTEM_ENABLED_KEY, false, true);
  if (flipped) {
    clearSettingsCache();
    logger.info("referral system enabled", { adminId: ctx.admin?.id });
  }
  await renderOverview(ctx, flipped ? "پاداش زیرمجموعه‌گیری فعال شد ✅" : "پاداش از قبل فعال است.");
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.disable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const flipped = await compareAndSetBooleanSetting(REFERRAL_SYSTEM_ENABLED_KEY, true, false);
  if (flipped) {
    clearSettingsCache();
    logger.info("referral system disabled", { adminId: ctx.admin?.id });
  }
  await renderOverview(ctx, flipped ? "پاداش زیرمجموعه‌گیری غیرفعال شد." : "پاداش از قبل غیرفعال است.");
});

referralAdminHandler.callbackQuery(REF_ADMIN_CB.first, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const stats = await getReferralAdminStats();
  await setReferralFirstPurchaseOnly(!stats.firstPurchaseOnly);
  await renderOverview(ctx, "به‌روزرسانی شد");
});

referralAdminHandler.callbackQuery(/^admin:referral:pct:(\d{1,3})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const ok = await setReferralCommissionPercent(Number.parseInt(ctx.match[1], 10));
  await renderOverview(ctx, ok ? "درصد پاداش به‌روزرسانی شد ✅" : "مقدار نامعتبر است.");
});

referralAdminHandler.callbackQuery(/^admin:referral:min:(\d{1,9})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const ok = await setReferralMinPurchaseToman(Number.parseInt(ctx.match[1], 10));
  await renderOverview(ctx, ok ? "حداقل مبلغ به‌روزرسانی شد ✅" : "مقدار نامعتبر است.");
});
