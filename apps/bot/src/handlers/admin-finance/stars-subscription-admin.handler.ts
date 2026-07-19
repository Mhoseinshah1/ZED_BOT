import {
  TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY,
  errorMessage,
} from "@zedbot/shared";
import { prisma } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { readWorkerHeartbeat } from "../../services/ops-queue.service.js";
import { compareAndSetBooleanSetting, clearSettingsCache } from "../../services/settings.service.js";
import {
  isStarsSubscriptionsEnabled,
  isTelegramStarsGatewayEnabled,
} from "../../services/stars-subscription.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Telegram Stars subscriptions — ADMIN page (Phase 2). OWNER-only. The master
// switch is the ONLY thing an admin toggles; there is NO admin path that creates
// user consent, activates a subscription, re-enables billing without user action
// or fabricates a charge. Enabling passes an activation gate (both Stars switches,
// a live worker, an eligible subscription-enabled 30-day Product).
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";
const ACTIVATION_FAIL_TEXT =
  "امکان فعال‌سازی اشتراک Stars وجود ندارد. ابتدا تنظیمات Stars، Worker، محصولات ۳۰ روزه و پشتیبانی پرداخت را بررسی کنید.";

export const STARSUB_ADMIN_CB = {
  root: "admin:starsub:root",
  enable: "admin:starsub:enable",
  disable: "admin:starsub:disable",
} as const;

export const starsSubscriptionAdminHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

interface StarsSubAdminStats {
  enabled: boolean;
  gatewayEnabled: boolean;
  workerAlive: boolean;
  eligibleProducts: number;
  active: number;
  pending: number;
  cancelAtPeriodEnd: number;
  pastDue: number;
  requiresAction: number;
  refundPending: number;
}

async function gatherStats(): Promise<StarsSubAdminStats> {
  const [
    enabled,
    gatewayEnabled,
    heartbeat,
    eligibleProducts,
    active,
    pending,
    cancelAtPeriodEnd,
    pastDue,
    requiresAction,
    refundPending,
  ] = await Promise.all([
    isStarsSubscriptionsEnabled(),
    isTelegramStarsGatewayEnabled(),
    readWorkerHeartbeat(),
    prisma.product.count({
      where: { type: "SERVICE_PRODUCT", isActive: true, telegramStarsSubscriptionEnabled: true, durationDays: 30 },
    }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "ACTIVE" } }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "PENDING_PAYMENT" } }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "CANCEL_AT_PERIOD_END" } }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "PAST_DUE" } }),
    prisma.telegramStarsServiceSubscription.count({ where: { status: "REQUIRES_ACTION" } }),
    prisma.telegramStarsSubscriptionCharge.count({ where: { status: "REFUND_PENDING" } }),
  ]);
  return {
    enabled,
    gatewayEnabled,
    workerAlive: heartbeat !== null,
    eligibleProducts,
    active,
    pending,
    cancelAtPeriodEnd,
    pastDue,
    requiresAction,
    refundPending,
  };
}

function overviewText(s: StarsSubAdminStats): string {
  return [
    "⭐ <b>اشتراک‌های ماهانه Stars</b>",
    "",
    `وضعیت سراسری: ${s.enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `درگاه Stars یک‌باره: ${s.gatewayEnabled ? "فعال ✅" : "غیرفعال ⚠️"}`,
    `ضربان کارگر: ${s.workerAlive ? "دریافت می‌شود ✅" : "دریافت نمی‌شود ⚠️"}`,
    `محصولات قابل اشتراک: ${s.eligibleProducts}`,
    "",
    `اشتراک فعال: ${s.active}`,
    `در انتظار پرداخت اول: ${s.pending}`,
    `لغو در پایان دوره: ${s.cancelAtPeriodEnd}`,
    `پرداخت عقب‌افتاده: ${s.pastDue}`,
    `نیازمند بررسی: ${s.requiresAction}`,
    `بازپرداخت در انتظار: ${s.refundPending}`,
  ].join("\n");
}

function overviewKeyboard(s: StarsSubAdminStats): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(s.enabled ? "غیرفعال کردن سیستم ⛔" : "فعال کردن سیستم ✅", s.enabled ? STARSUB_ADMIN_CB.disable : STARSUB_ADMIN_CB.enable).row();
  kb.text("بروزرسانی ♻️", STARSUB_ADMIN_CB.root).row();
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  const stats = await gatherStats();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, overviewText(stats), overviewKeyboard(stats), { parseMode: "HTML" });
}

starsSubscriptionAdminHandler.callbackQuery(STARSUB_ADMIN_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await renderOverview(ctx);
  ctx.session.lastMenu = STARSUB_ADMIN_CB.root;
});

/** Enable gate: both switches, a live worker, an eligible product (Part: gate). */
async function activationGateFails(stats: StarsSubAdminStats): Promise<string | null> {
  if (!stats.gatewayEnabled) {
    return "درگاه Telegram Stars یک‌باره فعال نیست.";
  }
  if (!stats.workerAlive) {
    return "ضربان کارگر دریافت نمی‌شود.";
  }
  if (stats.eligibleProducts === 0) {
    return "هیچ محصول ۳۰ روزهٔ قابل اشتراک وجود ندارد.";
  }
  return null;
}

starsSubscriptionAdminHandler.callbackQuery(STARSUB_ADMIN_CB.enable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const stats = await gatherStats();
  const gateFail = await activationGateFails(stats);
  if (gateFail !== null) {
    logger.info("stars subscription enable refused by gate", { adminId: admin.id, reason: gateFail });
    await renderOverview(ctx, ACTIVATION_FAIL_TEXT);
    return;
  }
  if (!(await compareAndSetBooleanSetting(TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY, false, true))) {
    await renderOverview(ctx, "سیستم از قبل فعال است.");
    return;
  }
  clearSettingsCache();
  logger.info("stars subscriptions enabled", { adminId: admin.id });
  await renderOverview(ctx, "اشتراک‌های Stars فعال شد ✅");
});

starsSubscriptionAdminHandler.callbackQuery(STARSUB_ADMIN_CB.disable, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  try {
    const flipped = await compareAndSetBooleanSetting(TELEGRAM_STARS_SUBSCRIPTIONS_ENABLED_KEY, true, false);
    if (flipped) {
      clearSettingsCache();
      logger.info("stars subscriptions disabled", { adminId: admin.id });
    }
    await renderOverview(ctx, flipped ? "اشتراک‌های Stars غیرفعال شد." : "سیستم از قبل غیرفعال است.");
  } catch (err) {
    logger.error("stars subscription disable failed", { error: errorMessage(err) });
    await renderOverview(ctx, "خطا در تغییر وضعیت.");
  }
});
