import { Composer, InlineKeyboard } from "grammy";

import {
  errorMessage,
  isRepresentativeSalesChannel,
  isValidRepExperience,
  isValidRepExplanation,
  isValidRepFullName,
  isValidRepLocation,
  normalizeIranMobile,
  parseExpectedMonthlyCustomers,
  REP_EXPERIENCE_MAX,
  REP_EXPLANATION_MAX,
  REP_EXPLANATION_MIN,
  REPRESENTATIVE_SALES_CHANNELS,
  representativeShortId,
  type RepresentativeSalesChannel,
} from "@zedbot/shared";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { getProductByShortId } from "../../services/product.service.js";
import {
  areRepresentativeApplicationsEnabled,
  isRepresentativeCheckoutEnabled,
  isRepresentativeProgramEnabled,
} from "../../services/representative-settings.service.js";
import {
  listEligibleRepresentativeProducts,
  resolveEffectiveProductPrice,
} from "../../services/representative-pricing.service.js";
import {
  findOpenApplication,
  getRepresentativeByUserId,
  getRepresentativeDashboardStats,
  listRepresentativePurchases,
  submitRepresentativeApplication,
  withdrawRepresentativeApplication,
} from "../../services/representative.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { renderPreInvoice } from "../user-checkout/checkout.handler.js";

// =============================================================================
// Representative Program — user-facing handler (§9,§10,§14,§15,§16,§21,§23).
//
// The single «نمایندگی» surface: a status-aware landing that becomes either the
// application wizard, the application-status page, or the representative
// dashboard (stats + buy/tariff/purchases/terms/support). Every money path
// reuses the existing checkout/payment/wallet/provisioning stack — this handler
// only SEEDS a reseller-priced draft and renders; it never moves money itself.
// All gates are re-checked here (never trust a stale button): the program master
// switch, the applications switch and the checkout switch (§3).
// =============================================================================

const HTML = { parseMode: "HTML" as const };

/** user:rep:* callbacks — all ≤64 bytes, product ids carried as 8-char short
 * ids only (§23). */
const RC = {
  APPLY: "user:rep:apply",
  CHANNEL: "user:rep:ch:", // + REPRESENTATIVE_SALES_CHANNELS code
  EXP_SKIP: "user:rep:exp:skip",
  CONFIRM: "user:rep:confirm",
  CANCEL: "user:rep:cancel",
  STATUS: "user:rep:status",
  WITHDRAW: "user:rep:wd",
  WITHDRAW_YES: "user:rep:wd:yes",
  TARIFF: "user:rep:tariff",
  PURCHASES: "user:rep:buys",
  REP_BUY: "user:rep:buy",
  PRODUCT: "user:rep:p:", // + product short id
  TERMS: "user:rep:terms",
  REP_SUPPORT: "user:rep:support",
  MENU: "user:rep:menu",
} as const;

const PROGRAM_OFF_TEXT = "بخش نمایندگی در حال حاضر در دسترس نیست.";
const APPLICATIONS_OFF_TEXT = "ثبت درخواست نمایندگی در حال حاضر بسته است.";
const CANCELLED_TEXT = "درخواست نمایندگی لغو شد.";

function backTo(cb: string, label = "بازگشت"): InlineKeyboard {
  return new InlineKeyboard().text(label, cb);
}

function formatToman(v: number): string {
  return `${v.toLocaleString("en-US")} تومان`;
}

function channelLabel(code: string): string {
  const map: Record<RepresentativeSalesChannel, string> = {
    TELEGRAM: "تلگرام",
    INSTAGRAM: "اینستاگرام",
    WEBSITE: "وب‌سایت",
    IN_PERSON: "حضوری",
    WORD_OF_MOUTH: "معرفی دوستان",
    OTHER: "سایر",
  };
  return isRepresentativeSalesChannel(code) ? map[code] : code;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: "پیش‌نویس",
    PENDING_REVIEW: "در انتظار بررسی ⏳",
    APPROVED: "تأییدشده ✅",
    REJECTED: "ردشده ❌",
    WITHDRAWN: "لغوشده",
    ACTIVE: "فعال ✅",
    SUSPENDED: "تعلیق‌شده ⏸",
    TERMINATED: "لغو دائم ⛔",
  };
  return map[status] ?? status;
}

// --- landing / dashboard -----------------------------------------------------

export const representativeHandler = new Composer<BotContext>();

/** The status-aware landing. Entry point for CB.USER_REPRESENTATIVE + rep:menu. */
async function renderLanding(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    await safeEditOrReply(ctx, PROGRAM_OFF_TEXT, backTo(CB.USER_MENU));
    return;
  }
  if (!(await isRepresentativeProgramEnabled())) {
    await safeEditOrReply(ctx, PROGRAM_OFF_TEXT, backTo(CB.USER_MENU));
    return;
  }
  ctx.session.temp.repApplicationDraft = undefined;
  ctx.session.currentFlow = null;

  const rep = await getRepresentativeByUserId(user.id);
  if (rep !== null && rep.status !== "TERMINATED") {
    await renderDashboard(ctx);
    return;
  }

  const open = await findOpenApplication(user.id);
  if (open !== null) {
    await renderStatus(ctx);
    return;
  }

  // No representative record, no open application → landing with an apply CTA.
  const applicationsOpen = await areRepresentativeApplicationsEnabled();
  const body = await getMessageTemplate(
    "representative_landing",
    [
      "🤝 <b>برنامه نمایندگی</b>",
      "",
      "با عضویت در برنامه نمایندگی می‌توانید سرویس‌های واجد شرایط را با قیمت ویژهٔ نمایندگی برای حساب خودتان خریداری کنید.",
      "",
      "برای شروع، درخواست خود را ثبت کنید تا پس از بررسی، تعرفهٔ نمایندگی برای شما فعال شود.",
    ].join("\n"),
  );
  const kb = new InlineKeyboard();
  if (applicationsOpen) {
    kb.text(await getButtonText("representative_apply", "ثبت درخواست نمایندگی 🤝"), RC.APPLY).row();
  }
  kb.text(await getButtonText("representative_terms", "شرایط و قوانین 📄"), RC.TERMS).row();
  kb.text("بازگشت", CB.USER_MENU);
  await safeEditOrReply(ctx, applicationsOpen ? body : `${body}\n\n${APPLICATIONS_OFF_TEXT}`, kb, HTML);
}

async function renderDashboard(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const stats = await getRepresentativeDashboardStats(user.id);
  const rep = stats.representative;
  if (rep === null) {
    await renderLanding(ctx);
    return;
  }
  const lines = [
    "🤝 <b>نمایندگی من</b>",
    "",
    `وضعیت: ${statusLabel(rep.status)}`,
    `تعرفه: ${rep.tier !== null ? rep.tier.name : "بدون تعرفه"}`,
    `تعداد خریدهای نمایندگی: ${stats.completedPurchaseCount.toLocaleString("en-US")}`,
    `مجموع پرداختی: ${formatToman(stats.totalFinalPaidToman)}`,
    `مجموع صرفه‌جویی: ${formatToman(stats.totalSavedToman)}`,
  ];
  if (rep.status === "SUSPENDED") {
    lines.push("", "⏸ حساب نمایندگی شما موقتاً تعلیق شده است؛ خرید با قیمت نمایندگی غیرفعال است.");
  }
  const checkoutOpen = rep.status === "ACTIVE" && rep.checkoutEnabled && (await isRepresentativeCheckoutEnabled());
  const kb = new InlineKeyboard();
  if (checkoutOpen) {
    kb.text(await getButtonText("representative_buy", "خرید نمایندگی 🛒"), RC.REP_BUY).row();
  }
  kb.text(await getButtonText("representative_tariff", "تعرفه من 💠"), RC.TARIFF)
    .text(await getButtonText("representative_purchases", "خریدهای من 🧾"), RC.PURCHASES)
    .row();
  kb.text(await getButtonText("representative_terms", "شرایط 📄"), RC.TERMS)
    .text(await getButtonText("representative_support", "پشتیبانی نمایندگان 🎫"), RC.REP_SUPPORT)
    .row();
  kb.text("بازگشت", CB.USER_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

/** Entry used by both the inline callback and the reply-keyboard action. */
export async function renderRepresentativeLanding(ctx: BotContext): Promise<void> {
  ctx.session.lastMenu = CB.USER_REPRESENTATIVE;
  await renderLanding(ctx);
}

representativeHandler.callbackQuery(CB.USER_REPRESENTATIVE, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderRepresentativeLanding(ctx);
});
representativeHandler.callbackQuery(RC.MENU, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderLanding(ctx);
});

// --- application wizard (§9, §10) --------------------------------------------

const WIZARD_FLOW = "rep:apply";

representativeHandler.callbackQuery(RC.APPLY, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx, PROGRAM_OFF_TEXT);
    return;
  }
  if (!(await isRepresentativeProgramEnabled()) || !(await areRepresentativeApplicationsEnabled())) {
    await safeAnswerCallback(ctx, APPLICATIONS_OFF_TEXT);
    await renderLanding(ctx);
    return;
  }
  // Block a second open application / an existing representative up-front.
  if ((await getRepresentativeByUserId(user.id)) !== null) {
    await safeAnswerCallback(ctx, "شما در حال حاضر نماینده هستید.");
    await renderLanding(ctx);
    return;
  }
  if ((await findOpenApplication(user.id)) !== null) {
    await safeAnswerCallback(ctx, "شما یک درخواست باز دارید.");
    await renderStatus(ctx);
    return;
  }
  ctx.session.temp.repApplicationDraft = { step: "fullName" };
  ctx.session.currentFlow = WIZARD_FLOW;
  await safeAnswerCallback(ctx);
  await promptStep(ctx);
});

representativeHandler.callbackQuery(RC.CANCEL, async (ctx) => {
  ctx.session.temp.repApplicationDraft = undefined;
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx, CANCELLED_TEXT);
  await renderLanding(ctx);
});

/** Sales-channel choice (the only button-driven wizard step). */
for (const code of REPRESENTATIVE_SALES_CHANNELS) {
  representativeHandler.callbackQuery(`${RC.CHANNEL}${code}`, async (ctx) => {
    const draft = ctx.session.temp.repApplicationDraft;
    if (draft === undefined || draft.step !== "salesChannel") {
      await safeAnswerCallback(ctx);
      return;
    }
    draft.salesChannel = code;
    draft.step = "expected";
    await safeAnswerCallback(ctx);
    await promptStep(ctx);
  });
}

representativeHandler.callbackQuery(RC.EXP_SKIP, async (ctx) => {
  const draft = ctx.session.temp.repApplicationDraft;
  if (draft === undefined || draft.step !== "experience") {
    await safeAnswerCallback(ctx);
    return;
  }
  draft.experience = null;
  draft.step = "explanation";
  await safeAnswerCallback(ctx);
  await promptStep(ctx);
});

representativeHandler.callbackQuery(RC.CONFIRM, async (ctx) => {
  const user = ctx.dbUser;
  const draft = ctx.session.temp.repApplicationDraft;
  if (user === null || draft === undefined || draft.step !== "preview") {
    await safeAnswerCallback(ctx);
    return;
  }
  if (
    draft.fullName === undefined ||
    draft.phone === undefined ||
    draft.province === undefined ||
    draft.city === undefined ||
    draft.salesChannel === undefined ||
    draft.expectedMonthlyCustomers === undefined ||
    draft.explanation === undefined
  ) {
    await safeAnswerCallback(ctx, "اطلاعات ناقص است.");
    return;
  }
  const sourceUpdateId =
    ctx.update.update_id !== undefined ? BigInt(ctx.update.update_id) : null;
  try {
    const result = await submitRepresentativeApplication({
      userId: user.id,
      sourceUpdateId,
      input: {
        fullName: draft.fullName,
        phone: draft.phone,
        province: draft.province,
        city: draft.city,
        salesChannel: draft.salesChannel,
        expectedMonthlyCustomers: draft.expectedMonthlyCustomers,
        experience: draft.experience ?? null,
        explanation: draft.explanation,
      },
    });
    ctx.session.temp.repApplicationDraft = undefined;
    ctx.session.currentFlow = null;
    if (!result.ok) {
      await safeAnswerCallback(ctx, submitErrorText(result.code));
      await renderLanding(ctx);
      return;
    }
    await safeAnswerCallback(ctx, "درخواست شما ثبت شد ✅");
    const body = await getMessageTemplate(
      "representative_application_received",
      "درخواست نمایندگی شما با موفقیت ثبت شد و در انتظار بررسی است. نتیجه از همین ربات به شما اطلاع داده می‌شود. 🙏",
    );
    await safeEditOrReply(ctx, body, backTo(CB.USER_REPRESENTATIVE, "نمایندگی من"), HTML);
  } catch (err) {
    logger.error("representative application submit failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

function submitErrorText(code: string): string {
  switch (code) {
    case "ALREADY_REPRESENTATIVE":
      return "شما در حال حاضر نماینده هستید.";
    case "ALREADY_APPLIED":
      return "شما یک درخواست باز دارید.";
    case "TERMINATED":
      return "امکان ثبت درخواست جدید برای شما وجود ندارد.";
    case "VALIDATION":
      return "اطلاعات واردشده معتبر نیست.";
    default:
      return "ثبت درخواست ممکن نشد.";
  }
}

/** Renders the prompt for the current wizard step. */
async function promptStep(ctx: BotContext): Promise<void> {
  const draft = ctx.session.temp.repApplicationDraft;
  if (draft === undefined) {
    await renderLanding(ctx);
    return;
  }
  const cancelKb = new InlineKeyboard().text("انصراف", RC.CANCEL);
  switch (draft.step) {
    case "fullName":
      await safeEditOrReply(ctx, "نام و نام خانوادگی خود را وارد کنید:", cancelKb);
      return;
    case "phone":
      await safeEditOrReply(ctx, "شمارهٔ تماس خود را وارد کنید (مثال: 09123456789):", cancelKb);
      return;
    case "province":
      await safeEditOrReply(ctx, "استان خود را وارد کنید:", cancelKb);
      return;
    case "city":
      await safeEditOrReply(ctx, "شهر خود را وارد کنید:", cancelKb);
      return;
    case "salesChannel": {
      const kb = new InlineKeyboard();
      const codes = [...REPRESENTATIVE_SALES_CHANNELS];
      for (let i = 0; i < codes.length; i += 2) {
        kb.text(channelLabel(codes[i]), `${RC.CHANNEL}${codes[i]}`);
        if (codes[i + 1] !== undefined) {
          kb.text(channelLabel(codes[i + 1]), `${RC.CHANNEL}${codes[i + 1]}`);
        }
        kb.row();
      }
      kb.text("انصراف", RC.CANCEL);
      await safeEditOrReply(ctx, "کانال فروش اصلی شما کدام است؟", kb);
      return;
    }
    case "expected":
      await safeEditOrReply(
        ctx,
        "تعداد مشتری تقریبی که ماهانه انتظار دارید را وارد کنید (یک عدد):",
        cancelKb,
      );
      return;
    case "experience":
      await safeEditOrReply(
        ctx,
        `سابقهٔ فعالیت خود را کوتاه بنویسید (اختیاری، حداکثر ${REP_EXPERIENCE_MAX} کاراکتر):`,
        new InlineKeyboard().text("رد کردن ➡️", RC.EXP_SKIP).row().text("انصراف", RC.CANCEL),
      );
      return;
    case "explanation":
      await safeEditOrReply(
        ctx,
        `توضیح دهید چرا می‌خواهید نماینده شوید (${REP_EXPLANATION_MIN} تا ${REP_EXPLANATION_MAX} کاراکتر):`,
        cancelKb,
      );
      return;
    case "preview":
      await renderPreview(ctx);
      return;
  }
}

async function renderPreview(ctx: BotContext): Promise<void> {
  const draft = ctx.session.temp.repApplicationDraft;
  if (draft === undefined) {
    return;
  }
  const lines = [
    "🔎 <b>پیش‌نمایش درخواست نمایندگی</b>",
    "",
    `نام: ${escape(draft.fullName)}`,
    `تلفن: ${escape(draft.phone)}`,
    `استان: ${escape(draft.province)}`,
    `شهر: ${escape(draft.city)}`,
    `کانال فروش: ${channelLabel(draft.salesChannel ?? "")}`,
    `مشتری ماهانه (تقریبی): ${draft.expectedMonthlyCustomers ?? "-"}`,
    `سابقه: ${draft.experience ? escape(draft.experience) : "—"}`,
    "",
    "توضیحات:",
    escape(draft.explanation ?? ""),
    "",
    "در صورت تأیید، درخواست برای بررسی ارسال می‌شود.",
  ];
  const kb = new InlineKeyboard()
    .text("تأیید و ارسال ✅", RC.CONFIRM)
    .row()
    .text("انصراف", RC.CANCEL);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

function escape(s: string | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Wizard text input — one flow, step tracked in the draft. */
export const representativeInputHandler = new Composer<BotContext>();

representativeInputHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== WIZARD_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    ctx.session.temp.repApplicationDraft = undefined;
    ctx.session.currentFlow = null;
    return next();
  }
  const draft = ctx.session.temp.repApplicationDraft;
  if (draft === undefined) {
    ctx.session.currentFlow = null;
    await safeReply(ctx, PROGRAM_OFF_TEXT, backTo(CB.USER_MENU));
    return;
  }
  const value = text.trim();
  switch (draft.step) {
    case "fullName":
      if (!isValidRepFullName(value)) {
        await safeReply(ctx, "نام واردشده معتبر نیست. دوباره وارد کنید:");
        return;
      }
      draft.fullName = value;
      draft.step = "phone";
      break;
    case "phone": {
      const normalized = normalizeIranMobile(value);
      if (normalized === null) {
        await safeReply(ctx, "شمارهٔ موبایل معتبر نیست (مثال: 09123456789). دوباره وارد کنید:");
        return;
      }
      draft.phone = normalized;
      draft.step = "province";
      break;
    }
    case "province":
      if (!isValidRepLocation(value)) {
        await safeReply(ctx, "استان معتبر نیست. دوباره وارد کنید:");
        return;
      }
      draft.province = value;
      draft.step = "city";
      break;
    case "city":
      if (!isValidRepLocation(value)) {
        await safeReply(ctx, "شهر معتبر نیست. دوباره وارد کنید:");
        return;
      }
      draft.city = value;
      draft.step = "salesChannel";
      break;
    case "expected": {
      const parsed = parseExpectedMonthlyCustomers(value);
      if (parsed === null) {
        await safeReply(ctx, "یک عدد معتبر وارد کنید:");
        return;
      }
      draft.expectedMonthlyCustomers = parsed;
      draft.step = "experience";
      break;
    }
    case "experience":
      if (!isValidRepExperience(value)) {
        await safeReply(ctx, `سابقه طولانی است (حداکثر ${REP_EXPERIENCE_MAX} کاراکتر). دوباره وارد کنید:`);
        return;
      }
      draft.experience = value === "" ? null : value;
      draft.step = "explanation";
      break;
    case "explanation":
      if (!isValidRepExplanation(value)) {
        await safeReply(
          ctx,
          `توضیحات باید بین ${REP_EXPLANATION_MIN} تا ${REP_EXPLANATION_MAX} کاراکتر باشد. دوباره وارد کنید:`,
        );
        return;
      }
      draft.explanation = value;
      draft.step = "preview";
      break;
    default:
      return;
  }
  await promptStep(ctx);
});

// --- application status + withdraw (§9) --------------------------------------

async function renderStatus(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const open = await findOpenApplication(user.id);
  if (open === null) {
    await renderLanding(ctx);
    return;
  }
  const lines = [
    "🤝 <b>وضعیت درخواست نمایندگی</b>",
    "",
    `وضعیت: ${statusLabel(open.status)}`,
    `تاریخ ثبت: ${open.submittedAt ? new Date(open.submittedAt).toLocaleDateString("fa-IR") : "-"}`,
    "",
    "درخواست شما در حال بررسی است. نتیجه از همین ربات اعلام می‌شود.",
  ];
  const kb = new InlineKeyboard()
    .text("انصراف از درخواست ❌", RC.WITHDRAW)
    .row()
    .text("بازگشت", CB.USER_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

representativeHandler.callbackQuery(RC.STATUS, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderStatus(ctx);
});

representativeHandler.callbackQuery(RC.WITHDRAW, async (ctx) => {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("بله، انصراف بده", RC.WITHDRAW_YES)
    .row()
    .text("خیر", RC.STATUS);
  await safeEditOrReply(ctx, "آیا از انصراف درخواست نمایندگی مطمئن هستید؟", kb);
});

representativeHandler.callbackQuery(RC.WITHDRAW_YES, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  const open = await findOpenApplication(user.id);
  if (open === null) {
    await safeAnswerCallback(ctx);
    await renderLanding(ctx);
    return;
  }
  const result = await withdrawRepresentativeApplication({ userId: user.id, applicationId: open.id });
  await safeAnswerCallback(ctx, result.ok ? "درخواست لغو شد." : "امکان لغو وجود ندارد.");
  await renderLanding(ctx);
});

// --- tariff / purchases / terms / support ------------------------------------

representativeHandler.callbackQuery(RC.TARIFF, async (ctx) => {
  await safeAnswerCallback(ctx);
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const rep = await getRepresentativeByUserId(user.id);
  if (rep === null || rep.status === "TERMINATED") {
    await renderLanding(ctx);
    return;
  }
  const lines = ["💠 <b>تعرفهٔ نمایندگی من</b>", ""];
  if (rep.tier === null) {
    lines.push("هنوز تعرفه‌ای برای شما تعیین نشده است.");
  } else {
    lines.push(`تعرفه: ${escape(rep.tier.name)}`);
    if (rep.tier.description !== null && rep.tier.description !== "") {
      lines.push(escape(rep.tier.description));
    }
    lines.push("", "قیمت‌های نمایندگی برای محصولات واجد شرایط:");
    const eligible = await listEligibleRepresentativeProducts(user);
    if (eligible.length === 0) {
      lines.push("— در حال حاضر محصولی با قیمت نمایندگی موجود نیست.");
    } else {
      for (const p of eligible) {
        lines.push(
          `• ${escape(p.name)}: ${formatToman(p.finalPriceToman)} (به‌جای ${formatToman(p.retailPriceToman)})`,
        );
      }
    }
  }
  await safeEditOrReply(ctx, lines.join("\n"), backTo(CB.USER_REPRESENTATIVE, "بازگشت"), HTML);
});

representativeHandler.callbackQuery(RC.PURCHASES, async (ctx) => {
  await safeAnswerCallback(ctx);
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const rows = await listRepresentativePurchases(user.id, 10);
  const lines = ["🧾 <b>خریدهای نمایندگی من</b>", ""];
  if (rows.length === 0) {
    lines.push("هنوز خریدی ثبت نشده است.");
  } else {
    for (const r of rows) {
      const saved = Math.max(0, r.retailPriceToman - r.finalPriceToman);
      lines.push(
        `• ${statusLabel(r.status)} — ${formatToman(r.finalPriceToman)} (صرفه‌جویی ${formatToman(saved)})`,
      );
    }
  }
  await safeEditOrReply(ctx, lines.join("\n"), backTo(CB.USER_REPRESENTATIVE, "بازگشت"), HTML);
});

representativeHandler.callbackQuery(RC.TERMS, async (ctx) => {
  await safeAnswerCallback(ctx);
  const body = await getMessageTemplate(
    "representative_terms",
    [
      "📄 <b>شرایط برنامهٔ نمایندگی</b>",
      "",
      "• قیمت نمایندگی فقط برای خرید سرویس‌های واجد شرایط برای حساب خودتان است.",
      "• فروش به شخص ثالث یا انتقال سرویس در این برنامه پشتیبانی نمی‌شود.",
      "• قیمت‌ها و تعرفه‌ها ممکن است توسط مدیریت تغییر کند.",
      "• رعایت قوانین استفاده الزامی است؛ در صورت تخلف، نمایندگی تعلیق یا لغو می‌شود.",
    ].join("\n"),
  );
  await safeEditOrReply(ctx, body, backTo(CB.USER_REPRESENTATIVE, "بازگشت"), HTML);
});

representativeHandler.callbackQuery(RC.REP_SUPPORT, async (ctx) => {
  // §21: reuse Support Tickets V2 — route the user into the existing support
  // section (the ticket system owns CB.USER_SUPPORT).
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("باز کردن پشتیبانی 🎫", CB.USER_SUPPORT)
    .row()
    .text("بازگشت", CB.USER_REPRESENTATIVE);
  await safeEditOrReply(
    ctx,
    "برای ارتباط با پشتیبانی نمایندگان، از بخش پشتیبانی یک تیکت ثبت کنید.",
    kb,
  );
});

// --- buy flow (§15, §16) -----------------------------------------------------

representativeHandler.callbackQuery(RC.REP_BUY, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  await safeAnswerCallback(ctx);
  // Re-check all gates (never trust the button).
  const rep = await getRepresentativeByUserId(user.id);
  if (
    rep === null ||
    rep.status !== "ACTIVE" ||
    !rep.checkoutEnabled ||
    !(await isRepresentativeProgramEnabled()) ||
    !(await isRepresentativeCheckoutEnabled())
  ) {
    await safeEditOrReply(ctx, "خرید با قیمت نمایندگی در دسترس نیست.", backTo(CB.USER_REPRESENTATIVE));
    return;
  }
  const eligible = await listEligibleRepresentativeProducts(user);
  if (eligible.length === 0) {
    await safeEditOrReply(
      ctx,
      "در حال حاضر محصولی برای خرید با قیمت نمایندگی موجود نیست.",
      backTo(CB.USER_REPRESENTATIVE),
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const p of eligible) {
    kb.text(
      `${p.name} — ${formatToman(p.finalPriceToman)}`,
      `${RC.PRODUCT}${representativeShortId(p.productId)}`,
    ).row();
  }
  kb.text("بازگشت", CB.USER_REPRESENTATIVE);
  await safeEditOrReply(ctx, "محصول موردنظر را انتخاب کنید:", kb);
});

representativeHandler.callbackQuery(new RegExp(`^${RC.PRODUCT}([a-f0-9]{8})$`), async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  const shortId = ctx.match![1];
  const product = await getProductByShortId(shortId);
  if (product === null || product.type !== "SERVICE_PRODUCT") {
    await safeAnswerCallback(ctx, "محصول یافت نشد.");
    return;
  }
  // Resolve the reseller price fresh (PREVIEW); reject if not eligible now.
  const effective = await resolveEffectiveProductPrice({
    user,
    product,
    checkoutPurpose: "PURCHASE",
    mode: "PREVIEW",
  });
  if (effective.pricingMode !== "REPRESENTATIVE") {
    await safeAnswerCallback(ctx, "این محصول با قیمت نمایندگی در دسترس نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  // Seed the shared checkout draft with the FROZEN reseller-pricing agreement.
  ctx.session.currentFlow = null;
  ctx.session.temp.repApplicationDraft = undefined;
  ctx.session.temp.checkoutDraft = {
    productId: product.id,
    categoryId: product.categoryId,
    panelId: product.panelId ?? undefined,
    flowType: product.type,
    originalPriceToman: effective.basePriceToman,
    discountAmountToman: effective.discountAmountToman,
    finalPriceToman: effective.finalPriceToman,
    draftNonce: cryptoRandom(),
    representative: {
      representativeId: effective.representativeId,
      tierId: effective.tierId,
      tierSlug: effective.tierSlug,
      priceMode: effective.priceMode,
      retailPriceToman: effective.retailPriceToman,
      basePriceToman: effective.basePriceToman,
      tierFingerprint: effective.tierFingerprint,
      priceFingerprint: effective.priceFingerprint,
    },
  };
  await renderPreInvoice(ctx, true);
});

function cryptoRandom(): string {
  // Kept local to avoid importing node:crypto at module top for one call.
  return globalThis.crypto.randomUUID();
}
