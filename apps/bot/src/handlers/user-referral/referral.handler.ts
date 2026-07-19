import { ReferralCommissionStatus, prisma } from "@zedbot/database";
import { referralDeepLink } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { getReferralConfig, isReferralSystemEnabled } from "../../services/referral.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Referral affiliate page (Phase 1) — the real «زیرمجموعه‌گیری» section. Shows the
// user their personal referral deep link (t.me/<bot>?start=<code>) and their LIVE
// earnings: how many users they referred, and how much commission has been paid to
// their wallet. Reachable only when the referral program is enabled (the menu
// button is gated on the same switch). No money moves here — the payout happens
// automatically when a referred user completes a purchase.
// =============================================================================

export const userReferralHandler = new Composer<BotContext>();

/** Latin → Persian digits for user-facing counts/amounts. */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/** Safe fail-closed page shown when the referral program is disabled. Reachable via
 * a stale keyboard or a direct callback; never advertises a commission percentage. */
async function renderReferralDisabled(ctx: BotContext): Promise<void> {
  const kb = new InlineKeyboard().text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(
    ctx,
    ["👥 <b>زیرمجموعه‌گیری</b>", "", "این بخش در حال حاضر غیرفعال است."].join("\n"),
    kb,
    { parseMode: "HTML" },
  );
}

export async function renderReferralPage(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  // Fail closed: re-check the master switch on EVERY render, so a hidden-menu
  // bypass — a stale inline keyboard or a direct callback/text route — can never
  // reach the live payout page while the program is disabled.
  if (!(await isReferralSystemEnabled())) {
    await renderReferralDisabled(ctx);
    return;
  }
  const code = user.referralCode ?? String(user.telegramId);
  const botUsername = ctx.me.username;
  const link = referralDeepLink(botUsername, code);

  const [referredCount, paidAgg, pendingCount, config] = await Promise.all([
    prisma.referral.count({ where: { referrerUserId: user.id } }),
    prisma.referralCommission.aggregate({
      where: { referrerUserId: user.id, status: ReferralCommissionStatus.PAID },
      _sum: { amountToman: true },
    }),
    prisma.referralCommission.count({
      where: { referrerUserId: user.id, status: ReferralCommissionStatus.PENDING },
    }),
    getReferralConfig(),
  ]);
  const paidToman = paidAgg._sum.amountToman ?? 0;

  const lines = [
    "👥 <b>زیرمجموعه‌گیری</b>",
    "",
    `با معرفی دوستان خود، از هر خرید آن‌ها <b>${faDigits(config.commissionPercent)}٪</b> پاداش به کیف پول شما اضافه می‌شود.`,
    config.firstPurchaseOnly ? "(پاداش فقط برای اولین خرید هر زیرمجموعه)" : "(پاداش برای همه خریدهای زیرمجموعه)",
    "",
    "🔗 لینک دعوت شما:",
    `<code>${link}</code>`,
    "",
    `👤 تعداد زیرمجموعه‌ها: ${faDigits(referredCount)}`,
    `💰 مجموع پاداش پرداخت‌شده: ${faDigits(paidToman.toLocaleString("en-US"))} تومان`,
  ];
  if (pendingCount > 0) {
    lines.push(`⏳ در انتظار: ${faDigits(pendingCount)}`);
  }

  const kb = new InlineKeyboard()
    .url(
      "اشتراک‌گذاری لینک 📤",
      `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("با این لینک عضو شو 👇")}`,
    )
    .row()
    .text("کیف پول من 🏦", CB.USER_WALLET)
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, { parseMode: "HTML" });
}

userReferralHandler.callbackQuery(CB.USER_REFERRAL, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderReferralPage(ctx);
  ctx.session.lastMenu = CB.USER_REFERRAL;
});
