import { prisma } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { isPanelSellable } from "../../services/panel-readiness.service.js";
import {
  getProductByShortId,
  productShortId,
  type ProductWithRelations,
} from "../../services/product.service.js";
import { createStarsSubscriptionNotification } from "../../services/stars-subscription-notify.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Product Stars-subscription configuration — ADMIN page (Phase 2). OWNER-only.
// Per SERVICE_PRODUCT: enable/disable monthly-Stars subscribability (behind the
// full sellability gate), set the recurring per-period Stars price, bump the
// terms VERSION (a material change that notifies every active subscriber), and
// inspect subscriptions still frozen on an older version (drift). Editing the
// PRODUCT never mutates an existing subscription's frozen contract — starsAmount,
// entitlementSnapshot and productVersion are set at enrollment and stay put; the
// price/version here only shape NEW subscriptions and durable notifications.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";
const NOT_FOUND_TEXT = "محصول یافت نشد.";
const PRICE_FLOW = "admin_starsprod:price";
const PAGE_SIZE = 8;
const MIN_PRICE = 1;
const MAX_PRICE = 10000;

/** Subscription statuses that count as a live, billable contract. */
const ACTIVE_STATUSES = [
  "ACTIVE",
  "PAST_DUE",
  "CANCEL_AT_PERIOD_END",
  "REACTIVATION_ALLOWED",
] as const;

export const starsProductConfigHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

/** Persian/Arabic-Indic digits → ASCII (admins may type either). */
function normalizeDigits(raw: string): string {
  return raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/** Frozen plan name from a subscription's entitlement snapshot ("-" when absent). */
function frozenProductName(entitlementSnapshot: unknown): string {
  if (
    typeof entitlementSnapshot === "object" &&
    entitlementSnapshot !== null &&
    !Array.isArray(entitlementSnapshot)
  ) {
    const name = (entitlementSnapshot as Record<string, unknown>).productName;
    if (typeof name === "string" && name.trim() !== "") {
      return name;
    }
  }
  return "-";
}

async function activeCounts(
  productId: string,
  currentVersion: number,
): Promise<{ active: number; drift: number }> {
  const [active, drift] = await Promise.all([
    prisma.telegramStarsServiceSubscription.count({
      where: { productId, status: { in: [...ACTIVE_STATUSES] } },
    }),
    prisma.telegramStarsServiceSubscription.count({
      where: {
        productId,
        status: { in: [...ACTIVE_STATUSES] },
        productVersion: { lt: currentVersion },
      },
    }),
  ]);
  return { active, drift };
}

// --- product list ------------------------------------------------------------

async function renderList(ctx: BotContext, page: number): Promise<void> {
  const total = await prisma.product.count({
    where: { type: "SERVICE_PRODUCT", isActive: true },
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const products = await prisma.product.findMany({
    where: { type: "SERVICE_PRODUCT", isActive: true },
    orderBy: [{ createdAt: "asc" }],
    skip: (safePage - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: { id: true, name: true, telegramStarsSubscriptionEnabled: true },
  });

  const kb = new InlineKeyboard();
  for (const p of products) {
    const badge = p.telegramStarsSubscriptionEnabled ? "فعال ✅" : "غیرفعال";
    kb.text(`${p.name} — ${badge}`, `admin:starsprod:p:${p.id.slice(0, 8)}`).row();
  }
  if (pages > 1) {
    if (safePage > 1) {
      kb.text("« قبلی", `admin:starsprod:list:${safePage - 1}`);
    }
    if (safePage < pages) {
      kb.text("بعدی »", `admin:starsprod:list:${safePage + 1}`);
    }
    kb.row();
  }
  kb.text("بازگشت", "admin:starsub:root");

  const text =
    total === 0
      ? "هیچ محصول سرویسی فعالی برای اشتراک ماهانه Stars وجود ندارد."
      : `محصولات سرویس — اشتراک ماهانه Stars ⭐\n\nصفحه ${safePage} از ${pages} (مجموع ${total})`;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, text, kb);
}

// --- config page (Part O) ----------------------------------------------------

async function renderConfigPage(ctx: BotContext, shortId: string): Promise<void> {
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeEditOrReply(
      ctx,
      NOT_FOUND_TEXT,
      new InlineKeyboard().text("بازگشت", "admin:starsprod:list"),
    );
    return;
  }
  const canonical = productShortId(product);
  const { active, drift } = await activeCounts(
    product.id,
    product.telegramStarsSubscriptionVersion,
  );
  const price = product.telegramStarsSubscriptionPrice;
  const enabled = product.telegramStarsSubscriptionEnabled;

  const text = [
    `اشتراک ماهانه Stars ⭐ — ${product.name}`,
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `قیمت هر دوره: ${price === null ? "-" : price} استار`,
    `مدت محصول: ${product.durationDays} روز`,
    `نسخه شرایط: ${product.telegramStarsSubscriptionVersion}`,
    `اشتراک فعال: ${active}`,
    `اشتراک با نسخه قدیمی: ${drift}`,
  ].join("\n");

  const kb = new InlineKeyboard()
    .text(
      enabled ? "غیرفعال کردن ⛔" : "فعال کردن ✅",
      `admin:starsprod:${enabled ? "dis" : "en"}:${canonical}`,
    )
    .row()
    .text("تنظیم قیمت استاری 💫", `admin:starsprod:price:${canonical}`)
    .row()
    .text("افزایش نسخه شرایط 🆙", `admin:starsprod:ver:${canonical}`)
    .row()
    .text("گزارش نسخه‌های قدیمی 📄", `admin:starsprod:drift:${canonical}`)
    .row()
    .text("بازگشت", "admin:starsprod:list");
  await safeEditOrReply(ctx, text, kb);
}

// --- enable gate -------------------------------------------------------------

/** Full sellability gate for enabling monthly-Stars subscribability. Returns the
 * first failing reason (Persian) or null when every check passes. */
function enableGateReason(product: ProductWithRelations): string | null {
  if (product.type !== "SERVICE_PRODUCT") {
    return "فقط محصولات سرویس قابل اشتراک هستند.";
  }
  if (!product.isActive) {
    return "محصول غیرفعال است.";
  }
  if (product.durationDays !== 30) {
    return "مدت محصول باید دقیقاً ۳۰ روز باشد.";
  }
  const price = product.telegramStarsSubscriptionPrice;
  if (price === null || !Number.isInteger(price) || price < MIN_PRICE || price > MAX_PRICE) {
    return "ابتدا قیمت استاری معتبر (۱ تا ۱۰۰۰۰) تعیین کنید.";
  }
  if (!product.category.isActive) {
    return "دسته‌بندی محصول غیرفعال است.";
  }
  if (product.panel === null) {
    return "پنلی به محصول متصل نیست.";
  }
  if (product.panel.status !== "ACTIVE") {
    return "پنل محصول فعال نیست.";
  }
  if (!isPanelSellable(product.panel)) {
    return "پنل محصول آمادهٔ ساخت سرویس نیست.";
  }
  return null;
}

// --- routes ------------------------------------------------------------------

// 1) list (+ paginated)
starsProductConfigHandler.callbackQuery(/^admin:starsprod:list(?::(\d+))?$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const m = ctx.match as RegExpMatchArray;
  const page = m[1] === undefined ? 1 : Number.parseInt(m[1], 10);
  await renderList(ctx, Number.isFinite(page) ? page : 1);
  ctx.session.lastMenu = "admin:starsprod:list";
});

// 2) config page
starsProductConfigHandler.callbackQuery(/^admin:starsprod:p:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderConfigPage(ctx, (ctx.match as RegExpMatchArray)[1]);
});

// 3) enable (full gate)
starsProductConfigHandler.callbackQuery(/^admin:starsprod:en:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const shortId = (ctx.match as RegExpMatchArray)[1];
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const reason = enableGateReason(product);
  if (reason !== null) {
    logger.info("stars subscription product enable refused by gate", {
      productId: product.id.slice(0, 8),
      reason,
      by: admin.id,
    });
    await safeAnswerCallback(ctx, reason);
    await renderConfigPage(ctx, shortId);
    return;
  }
  await prisma.product.update({
    where: { id: product.id },
    data: { telegramStarsSubscriptionEnabled: true },
  });
  logger.info("stars subscription product enabled", { productId: product.id.slice(0, 8), by: admin.id });
  await safeAnswerCallback(ctx, "اشتراک این محصول فعال شد ✅");
  await renderConfigPage(ctx, shortId);
});

// 4) disable — NEVER refunds or cancels existing active subscriptions; it only
//    stops NEW enrollments. Live subscriptions keep billing on their frozen
//    contract until the user cancels or they expire.
starsProductConfigHandler.callbackQuery(/^admin:starsprod:dis:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const shortId = (ctx.match as RegExpMatchArray)[1];
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  await prisma.product.update({
    where: { id: product.id },
    data: { telegramStarsSubscriptionEnabled: false },
  });
  logger.info("stars subscription product disabled", { productId: product.id.slice(0, 8), by: admin.id });
  await safeAnswerCallback(ctx, "اشتراک این محصول غیرفعال شد.");
  await renderConfigPage(ctx, shortId);
});

// 5) bump terms version (material change): transactional increment, then a
//    durable PRICE_VERSION_CHANGED notification per active subscription (deduped
//    to one per version per subscription). Existing frozen contracts are UNTOUCHED.
starsProductConfigHandler.callbackQuery(/^admin:starsprod:ver:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const shortId = (ctx.match as RegExpMatchArray)[1];
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const newVersion = product.telegramStarsSubscriptionVersion + 1;
  await prisma.$transaction([
    prisma.product.update({
      where: { id: product.id },
      data: { telegramStarsSubscriptionVersion: { increment: 1 } },
    }),
  ]);

  // After commit: one durable notification per active subscription. Uses the
  // subscription's FROZEN snapshot name / starsAmount / period end — the product
  // edit does not alter those. cycleKey = version:<n> dedupes to one per version.
  const subs = await prisma.telegramStarsServiceSubscription.findMany({
    where: { productId: product.id, status: { in: [...ACTIVE_STATUSES] } },
    select: {
      id: true,
      userId: true,
      starsAmount: true,
      currentPeriodEndsAt: true,
      entitlementSnapshot: true,
    },
  });
  for (const sub of subs) {
    const snapName = frozenProductName(sub.entitlementSnapshot);
    await createStarsSubscriptionNotification({
      subscriptionId: sub.id,
      userId: sub.userId,
      type: "STARS_SUBSCRIPTION_PRICE_VERSION_CHANGED",
      cycleKey: `version:${newVersion}`,
      serviceName: snapName === "-" ? product.name : snapName,
      starsAmount: sub.starsAmount,
      currentPeriodEnd:
        sub.currentPeriodEndsAt === null ? "-" : sub.currentPeriodEndsAt.toISOString().slice(0, 10),
    }).catch(() => undefined);
  }
  logger.info("stars subscription product version bumped", {
    productId: product.id.slice(0, 8),
    newVersion,
    notified: subs.length,
    by: admin.id,
  });
  await safeAnswerCallback(ctx, "نسخه شرایط افزایش یافت ✅");
  await renderConfigPage(ctx, shortId);
});

// 6) drift report — masked sub id + frozen version + status only (no PII).
starsProductConfigHandler.callbackQuery(/^admin:starsprod:drift:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const shortId = (ctx.match as RegExpMatchArray)[1];
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const canonical = productShortId(product);
  const subs = await prisma.telegramStarsServiceSubscription.findMany({
    where: {
      productId: product.id,
      status: { in: [...ACTIVE_STATUSES] },
      productVersion: { lt: product.telegramStarsSubscriptionVersion },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, productVersion: true, status: true },
  });
  const lines = [
    `نسخه‌های قدیمی — ${product.name}`,
    `نسخه فعلی شرایط: ${product.telegramStarsSubscriptionVersion}`,
    "",
  ];
  if (subs.length === 0) {
    lines.push("هیچ اشتراک فعالی با نسخه قدیمی وجود ندارد.");
  } else {
    for (const s of subs) {
      lines.push(`• ${s.id.slice(0, 6)} — نسخه ${s.productVersion} — ${s.status}`);
    }
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text("بازگشت", `admin:starsprod:p:${canonical}`),
  );
});

// 7) price setting — text flow "admin_starsprod:price". Setting the price is NOT
//    a version bump: it is the recurring contract for NEW subscriptions only.
starsProductConfigHandler.callbackQuery(/^admin:starsprod:price:([0-9a-f-]{4,32})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const shortId = (ctx.match as RegExpMatchArray)[1];
  const product = await getProductByShortId(shortId);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const canonical = productShortId(product);
  ctx.session.currentFlow = PRICE_FLOW;
  // Target product short id kept in the generic session temp slot (index
  // signature); the flow string itself stays a fixed constant.
  ctx.session.temp.starsPriceProductShort = canonical;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "مبلغ استاری هر دوره را وارد کنید (۱ تا ۱۰۰۰۰):",
    new InlineKeyboard().text("انصراف", `admin:starsprod:p:${canonical}`),
  );
});

// --- price text flow (self-gates on currentFlow) -----------------------------

export const starsProductPriceTextHandler = new Composer<BotContext>();

starsProductPriceTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== PRICE_FLOW) {
    return next();
  }
  if (!isOwner(ctx)) {
    ctx.session.currentFlow = null;
    ctx.session.temp.starsPriceProductShort = undefined;
    await safeReply(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const stored = ctx.session.temp.starsPriceProductShort;
  const shortId = typeof stored === "string" ? stored : null;
  if (shortId === null) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, "جلسه منقضی شده است. دوباره تلاش کنید.");
    return;
  }
  const normalized = normalizeDigits(ctx.message.text.trim());
  const value = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isInteger(value) || value < MIN_PRICE || value > MAX_PRICE) {
    // Keep the flow + target open so the admin can retry immediately.
    await safeReply(ctx, "مبلغ نامعتبر است. یک عدد صحیح بین ۱ تا ۱۰۰۰۰ وارد کنید.");
    return;
  }
  const product = await getProductByShortId(shortId);
  ctx.session.currentFlow = null;
  ctx.session.temp.starsPriceProductShort = undefined;
  if (product === null) {
    await safeReply(ctx, NOT_FOUND_TEXT);
    return;
  }
  await prisma.product.update({
    where: { id: product.id },
    data: { telegramStarsSubscriptionPrice: value },
  });
  logger.info("stars subscription product price set", {
    productId: product.id.slice(0, 8),
    by: admin.id,
  });
  await safeReply(ctx, `قیمت هر دوره روی ${value} استار تنظیم شد ✅`);
  await renderConfigPage(ctx, productShortId(product));
});
