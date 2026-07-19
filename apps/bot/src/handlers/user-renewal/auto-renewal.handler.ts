import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  cancelMandate,
  createMandate,
  getDefaultChargeLeadMinutes,
  getMandateForService,
  getOwnedMandateByShortId,
  isWalletAutoRenewalEnabled,
  listUserMandates,
  MANDATE_SYSTEM_DISABLED_TEXT,
  pauseMandateByUser,
  resumeMandateByUser,
} from "../../services/auto-renewal.service.js";
import { getProductByShortId } from "../../services/product.service.js";
import {
  getRenewableServiceByShortId,
  isRenewalPlanValid,
  renewalPlansForPanel,
} from "../../services/renewal-checkout.service.js";
import { getOwnedServiceById } from "../../services/user-services.service.js";
import { AUTO_RENEWAL_MIN_CEILING_TOMAN, AUTO_RENEWAL_MAX_CEILING_TOMAN, isValidCeiling } from "@zedbot/shared";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { prisma } from "@zedbot/database";
import {
  arnCb,
  autoRenewalCeilingKeyboard,
  autoRenewalCeilingText,
  autoRenewalConsentKeyboard,
  autoRenewalConsentText,
  autoRenewalIntroKeyboard,
  autoRenewalIntroText,
  autoRenewalListKeyboard,
  autoRenewalPlansKeyboard,
  autoRenewalPlanText,
  cancelConfirmKeyboard,
  mandateStatusKeyboard,
  mandateStatusText,
  NO_AUTO_RENEWALS_TEXT,
} from "./auto-renewal-views.js";

// =============================================================================
// Wallet auto-renewal — user flow (Phase 1). Explicit versioned consent is the
// ONLY way to create a mandate: choose plan → set a ceiling → review terms →
// confirm. The user may pause / resume / cancel any time. Every route
// re-validates ownership + eligibility from the DB; nothing here moves money
// (the worker scan + bot execute engine act later, only for an ACTIVE mandate).
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const NOT_FOUND = "مورد یافت نشد.";
const DISABLED_TEXT = MANDATE_SYSTEM_DISABLED_TEXT;
const NO_PLAN_TEXT = "پلنی برای تمدید خودکار این سرویس موجود نیست.";

export const autoRenewalHandler = new Composer<BotContext>();

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منو", CB.USER_MENU);
}

/** Per-service entry: shows the existing mandate's status, or the intro/pitch. */
async function renderServiceAutoRenewal(ctx: BotContext, shortId: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(shortId, user.id);
  if (service === null || service.expiresAt === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const mandate = await getMandateForService(user.id, service.id);
  await safeAnswerCallback(ctx);
  if (mandate !== null && mandate.status !== "CANCELLED") {
    await safeEditOrReply(ctx, mandateStatusText(mandate, service), mandateStatusKeyboard(mandate), HTML);
    return;
  }
  if (!(await isWalletAutoRenewalEnabled())) {
    await safeEditOrReply(ctx, DISABLED_TEXT, menuKeyboard());
    return;
  }
  await safeEditOrReply(ctx, autoRenewalIntroText(service), autoRenewalIntroKeyboard(service), HTML);
}

autoRenewalHandler.callbackQuery(/^user:arn:svc:([0-9a-f-]+)$/, async (ctx) => {
  await renderServiceAutoRenewal(ctx, ctx.match[1]);
});

// --- consent step 1: choose a plan -------------------------------------------

autoRenewalHandler.callbackQuery(/^user:arn:start:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  if (!(await isWalletAutoRenewalEnabled())) {
    await safeAnswerCallback(ctx, DISABLED_TEXT);
    return;
  }
  const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
  if (service === null || service.expiresAt === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const existing = await getMandateForService(user.id, service.id);
  if (existing !== null && existing.status !== "CANCELLED") {
    await safeAnswerCallback(ctx, "برای این سرویس تمدید خودکار از قبل فعال است.");
    await renderServiceAutoRenewal(ctx, ctx.match[1]);
    return;
  }
  const plans = await renewalPlansForPanel(user.group, service.panelId);
  await safeAnswerCallback(ctx);
  if (plans.length === 0) {
    await safeEditOrReply(ctx, NO_PLAN_TEXT, menuKeyboard());
    return;
  }
  ctx.session.currentFlow = null;
  ctx.session.temp.autoRenewalDraft = { serviceId: service.id, productId: "" };
  await safeEditOrReply(ctx, autoRenewalPlanText(service), autoRenewalPlansKeyboard(service, plans), HTML);
});

// --- consent step 2: plan chosen -> ceiling entry ----------------------------

autoRenewalHandler.callbackQuery(/^user:arn:plan:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getRenewableServiceByShortId(ctx.match[1], user.id);
  const product = await getProductByShortId(ctx.match[2]);
  if (
    service === null ||
    service.expiresAt === null ||
    product === null ||
    !isRenewalPlanValid(product, service, user.group)
  ) {
    await safeAnswerCallback(ctx, "این پلن در دسترس نیست.");
    return;
  }
  ctx.session.temp.autoRenewalDraft = { serviceId: service.id, productId: product.id };
  ctx.session.currentFlow = "arn:ceiling";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    autoRenewalCeilingText(service, product),
    autoRenewalCeilingKeyboard(service, product),
    HTML,
  );
});

// --- consent step 3a: use current price as the ceiling -----------------------

autoRenewalHandler.callbackQuery(arnCb.ceilCurrent, async (ctx) => {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.autoRenewalDraft;
  if (user === null || draft === undefined || draft.productId === "") {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (service === null || product === null || product.id !== draft.productId) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await applyCeilingAndReview(ctx, product.priceToman);
});

// --- consent step 3b: typed ceiling ------------------------------------------

export const autoRenewalTextHandler = new Composer<BotContext>();

autoRenewalTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== "arn:ceiling") {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    ctx.session.currentFlow = null;
    return next();
  }
  // Accept Persian/Arabic and ASCII digits; strip separators.
  const normalized = text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[,\s،_]/g, "");
  const value = Number.parseInt(normalized, 10);
  if (!Number.isInteger(value) || value < AUTO_RENEWAL_MIN_CEILING_TOMAN || value > AUTO_RENEWAL_MAX_CEILING_TOMAN) {
    await safeReply(
      ctx,
      `مبلغ نامعتبر است. یک عدد بین ${AUTO_RENEWAL_MIN_CEILING_TOMAN.toLocaleString("en-US")} و ${AUTO_RENEWAL_MAX_CEILING_TOMAN.toLocaleString("en-US")} تومان وارد کنید.`,
    );
    return;
  }
  await applyCeilingAndReview(ctx, value);
});

/** Validates the ceiling against the live plan and shows the consent review. */
async function applyCeilingAndReview(ctx: BotContext, ceilingToman: number): Promise<void> {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.autoRenewalDraft;
  if (user === null || draft === undefined || draft.productId === "") {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (
    service === null ||
    service.expiresAt === null ||
    product === null ||
    product.id !== draft.productId ||
    !isRenewalPlanValid(product, service, user.group)
  ) {
    ctx.session.currentFlow = null;
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, "پیش‌فاکتور در دسترس نیست؛ دوباره تلاش کنید.", menuKeyboard());
    return;
  }
  if (!isValidCeiling(ceilingToman, product.priceToman)) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, `سقف مبلغ باید حداقل برابر قیمت فعلی (${product.priceToman.toLocaleString("en-US")} تومان) باشد.`);
    return;
  }
  draft.maximumChargeToman = ceilingToman;
  ctx.session.currentFlow = null;
  const leadMinutes = await getDefaultChargeLeadMinutes();
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    autoRenewalConsentText(service, product, ceilingToman, leadMinutes),
    autoRenewalConsentKeyboard(service),
    HTML,
  );
}

// --- consent step 4: confirm -> create the mandate ---------------------------

autoRenewalHandler.callbackQuery(arnCb.confirm, async (ctx) => {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.autoRenewalDraft;
  if (user === null || draft === undefined || draft.productId === "" || draft.maximumChargeToman === undefined) {
    await safeAnswerCallback(ctx, "اطلاعات ناقص است؛ دوباره تلاش کنید.");
    return;
  }
  const service = await getRenewableServiceByShortId(draft.serviceId.slice(0, 8), user.id);
  const product = await getProductByShortId(draft.productId.slice(0, 8));
  if (service === null || product === null || product.id !== draft.productId) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  try {
    const result = await createMandate(user, {
      service,
      product,
      maximumChargeToman: draft.maximumChargeToman,
    });
    ctx.session.temp.autoRenewalDraft = undefined;
    if (!result.ok) {
      await safeAnswerCallback(ctx, result.error);
      await renderServiceAutoRenewal(ctx, draft.serviceId.slice(0, 8));
      return;
    }
    await safeAnswerCallback(ctx, "تمدید خودکار فعال شد ✅");
    await safeEditOrReply(
      ctx,
      mandateStatusText(result.mandate, service),
      mandateStatusKeyboard(result.mandate),
      HTML,
    );
    logger.info("auto-renewal mandate confirmed by user", {
      mandateId: result.mandate.id,
      userId: user.id,
    });
  } catch (err) {
    logger.error("auto-renewal mandate creation failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// --- my auto-renewals list + detail ------------------------------------------

autoRenewalHandler.callbackQuery(arnCb.list, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandates = await listUserMandates(user.id);
  await safeAnswerCallback(ctx);
  if (mandates.length === 0) {
    await safeEditOrReply(ctx, NO_AUTO_RENEWALS_TEXT, menuKeyboard());
    return;
  }
  const services = await prisma.service.findMany({
    where: { id: { in: mandates.map((m) => m.serviceId) } },
    select: { id: true, username: true },
  });
  const nameById = new Map(services.map((s) => [s.id, s.username]));
  const rows = mandates.map((mandate) => ({
    mandate,
    username: nameById.get(mandate.serviceId) ?? "-",
  }));
  await safeEditOrReply(ctx, "🔁 تمدیدهای خودکار شما", autoRenewalListKeyboard(rows));
});

async function renderMandateDetail(ctx: BotContext, mandateShort: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandate = await getOwnedMandateByShortId(mandateShort, user.id);
  if (mandate === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const service = await getOwnedServiceById(mandate.serviceId, user.id);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, mandateStatusText(mandate, service), mandateStatusKeyboard(mandate), HTML);
}

autoRenewalHandler.callbackQuery(/^user:arn:m:([0-9a-f-]+)$/, async (ctx) => {
  await renderMandateDetail(ctx, ctx.match[1]);
});

// --- pause / resume / cancel -------------------------------------------------

autoRenewalHandler.callbackQuery(/^user:arn:pause:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandate = await getOwnedMandateByShortId(ctx.match[1], user.id);
  if (mandate === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await pauseMandateByUser(mandate.id, user.id);
  await safeAnswerCallback(ctx, "تمدید خودکار متوقف شد ⏸");
  await renderMandateDetail(ctx, ctx.match[1]);
});

autoRenewalHandler.callbackQuery(/^user:arn:resume:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandate = await getOwnedMandateByShortId(ctx.match[1], user.id);
  if (mandate === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const result = await resumeMandateByUser(mandate.id, user);
  await safeAnswerCallback(ctx, result.ok ? "تمدید خودکار دوباره فعال شد ▶️" : result.error);
  await renderMandateDetail(ctx, ctx.match[1]);
});

autoRenewalHandler.callbackQuery(/^user:arn:cancel:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandate = await getOwnedMandateByShortId(ctx.match[1], user.id);
  if (mandate === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "آیا از لغو تمدید خودکار این سرویس مطمئن هستید؟",
    cancelConfirmKeyboard(mandate),
  );
});

autoRenewalHandler.callbackQuery(/^user:arn:cancel:([0-9a-f-]+):yes$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const mandate = await getOwnedMandateByShortId(ctx.match[1], user.id);
  if (mandate === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await cancelMandate(mandate.id, user.id);
  await safeAnswerCallback(ctx, "تمدید خودکار لغو شد ❌");
  await renderMandateDetail(ctx, ctx.match[1]);
});
