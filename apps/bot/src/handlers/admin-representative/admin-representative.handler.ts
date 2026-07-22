import { randomUUID } from "node:crypto";

import {
  isValidRepReason,
  parseRepFixedToman,
  parseRepPercent,
  REP_REASON_MAX,
  REP_REASON_MIN,
  representativeShortId,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import { errorMessage } from "@zedbot/shared";
import { prisma } from "@zedbot/database";
import { isProductStructurallySellable } from "../../services/catalog.service.js";
import { listProducts } from "../../services/product.service.js";
import { pcb } from "../products/product-cb.js";
import {
  approveRepresentativeApplication,
  assignRepresentativeTier,
  countPendingApplications,
  getAdminApplicationContext,
  getApplicationByShortId,
  getRepresentativeByShortId,
  listApplicationsForAdmin,
  listRepresentativesForAdmin,
  reactivateRepresentative,
  rejectRepresentativeApplication,
  setRepresentativeCheckoutEnabled,
  suspendRepresentative,
  terminateRepresentative,
  type ApplicationFilter,
} from "../../services/representative.service.js";
import {
  createRepresentativeTier,
  getRepresentativeTierByShortId,
  listRepresentativeTiers,
  listTierProductPrices,
  setRepresentativeProductPriceActive,
  setRepresentativeTierActive,
  upsertRepresentativeProductPrice,
} from "../../services/representative-tier.service.js";
import {
  areRepresentativeApplicationsEnabled,
  compareAndSetRepresentativeApplicationsEnabled,
  compareAndSetRepresentativeCheckoutEnabled,
  compareAndSetRepresentativeProgramEnabled,
  isRepresentativeCheckoutEnabled,
  isRepresentativeProgramEnabled,
} from "../../services/representative-settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// Representative Program — admin handler (§11,§12,§13,§18,§19,§20,§23).
//
// Mounted behind adminAuthMiddleware. Every mutation re-validates the OWNER
// against the live admin role (never trusting the button) and fails closed
// otherwise. No new AdminRole is introduced. Reasons/names/prices are entered
// through a text flow; the reason bodies are stored, never logged (§24).
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const OWNER_ONLY = "این بخش فقط برای مالک ربات در دسترس است.";
const NOT_FOUND = "مورد یافت نشد.";
const REP_FLOW = "admin_rep:input";

export const adminRepresentativeHandler = new Composer<BotContext>();
export const adminRepresentativeTextHandler = new Composer<BotContext>();

// Any admin:rep:* button press means the operator navigated away from a
// half-entered text step, so a stale reject/suspend/terminate/tier/price input
// flow must be dropped BEFORE the specific handler runs — otherwise a later
// «انصراف» leaves currentFlow=admin_rep:input and the operator's next ordinary
// message is silently consumed as (e.g.) the rejection reason. The
// input-initiating handlers re-arm the flow AFTER this middleware, so they are
// unaffected. Registered first so it runs first.
adminRepresentativeHandler.callbackQuery(/^admin:rep:/, async (ctx, next) => {
  if (ctx.session.currentFlow === REP_FLOW) {
    ctx.session.currentFlow = null;
    delete ctx.session.temp.adminRepDraft;
  }
  await next();
});

const AC = {
  ROOT: "admin:rep:root",
  LIST: "admin:rep:list:", // + filter:page
  VIEW: "admin:rep:view:", // + appSid
  APPROVE: "admin:rep:appr:", // + appSid (tier picker)
  APPROVE_TIER: "admin:rep:apt:", // + appSid:tierSid (confirm)
  REJECT: "admin:rep:rej:", // + appSid (reason input)
  REPS: "admin:rep:reps:", // + page
  RVIEW: "admin:rep:rv:", // + repSid
  SUSPEND: "admin:rep:sus:", // + repSid
  REACT: "admin:rep:rea:", // + repSid
  TERM: "admin:rep:trm:", // + repSid
  TERM_YES: "admin:rep:trmy:", // + repSid (double confirm)
  SETTIER: "admin:rep:st:", // + repSid (tier picker)
  SETTIER_DO: "admin:rep:std:", // + repSid:tierSid
  TOGGLE_CHK: "admin:rep:chk:", // + repSid
  TIERS: "admin:rep:tiers",
  TIER_NEW: "admin:rep:tnew",
  TIER_VIEW: "admin:rep:tv:", // + tierSid
  TIER_ARCH: "admin:rep:tar:", // + tierSid
  TIER_REACT: "admin:rep:trc:", // + tierSid
  PRICES: "admin:rep:pr:", // + tierSid
  PRICE_FIXED: "admin:rep:pf:", // + tierSid:productSid
  PRICE_PCT: "admin:rep:pp:", // + tierSid:productSid
  PRICE_OFF: "admin:rep:po:", // + tierSid:productSid
  PRICE_ON: "admin:rep:pn:", // + tierSid:productSid
  ELIG: "admin:rep:elig:", // + page (product-eligibility management list)
  SW_PROG: "admin:rep:swp",
  SW_APP: "admin:rep:swa",
  SW_CHK: "admin:rep:swc",
} as const;

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY);
    return false;
  }
  return true;
}

function formatToman(v: number): string {
  return `${v.toLocaleString("en-US")} تومان`;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function appStatusLabel(s: string): string {
  return (
    {
      DRAFT: "پیش‌نویس",
      PENDING_REVIEW: "در انتظار بررسی ⏳",
      APPROVED: "تأییدشده ✅",
      REJECTED: "ردشده ❌",
      WITHDRAWN: "لغوشده",
    } as Record<string, string>
  )[s] ?? s;
}
function repStatusLabel(s: string): string {
  return (
    { ACTIVE: "فعال ✅", SUSPENDED: "تعلیق ⏸", TERMINATED: "لغو دائم ⛔" } as Record<string, string>
  )[s] ?? s;
}

// --- root: switches + queue + tiers (§11, §3) --------------------------------

async function renderRoot(ctx: BotContext): Promise<void> {
  const [programOn, appsOn, checkoutOn, pending] = await Promise.all([
    isRepresentativeProgramEnabled(),
    areRepresentativeApplicationsEnabled(),
    isRepresentativeCheckoutEnabled(),
    countPendingApplications(),
  ]);
  const lines = [
    "🤝 <b>مدیریت نمایندگی</b>",
    "",
    `برنامه نمایندگی: ${programOn ? "فعال ✅" : "غیرفعال ⛔"}`,
    `پذیرش درخواست: ${appsOn ? "باز ✅" : "بسته ⛔"}`,
    `خرید نمایندگی: ${checkoutOn ? "فعال ✅" : "غیرفعال ⛔"}`,
    `درخواست‌های در انتظار: ${pending.toLocaleString("en-US")}`,
  ];
  const kb = new InlineKeyboard()
    .text(programOn ? "غیرفعال‌سازی برنامه" : "فعال‌سازی برنامه", AC.SW_PROG)
    .row()
    .text(appsOn ? "بستن پذیرش درخواست" : "باز کردن پذیرش درخواست", AC.SW_APP)
    .row()
    .text(checkoutOn ? "غیرفعال‌سازی خرید نمایندگی" : "فعال‌سازی خرید نمایندگی", AC.SW_CHK)
    .row()
    .text("درخواست‌های نمایندگی 🤝", `${AC.LIST}pending:1`)
    .row()
    .text("نمایندگان", `${AC.REPS}1`)
    .text("سطح‌های نمایندگی 💠", AC.TIERS)
    .row()
    .text("محصولات نمایندگی 🛍", `${AC.ELIG}1`)
    .row()
    .text("بازگشت", "admin:general_settings");
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(AC.ROOT, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderRoot(ctx);
});

// --- master switches (§3, atomic CAS) ----------------------------------------

async function toggleSwitch(
  ctx: BotContext,
  read: () => Promise<boolean>,
  cas: (expected: boolean, next: boolean) => Promise<boolean>,
): Promise<void> {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const current = await read();
  const ok = await cas(current, !current);
  await safeAnswerCallback(ctx, ok ? "انجام شد ✅" : "وضعیت تغییر کرده بود؛ دوباره تلاش کنید.");
  await renderRoot(ctx);
}

adminRepresentativeHandler.callbackQuery(AC.SW_PROG, (ctx) =>
  toggleSwitch(ctx, isRepresentativeProgramEnabled, compareAndSetRepresentativeProgramEnabled),
);
adminRepresentativeHandler.callbackQuery(AC.SW_APP, (ctx) =>
  toggleSwitch(
    ctx,
    areRepresentativeApplicationsEnabled,
    compareAndSetRepresentativeApplicationsEnabled,
  ),
);
adminRepresentativeHandler.callbackQuery(AC.SW_CHK, (ctx) =>
  toggleSwitch(ctx, isRepresentativeCheckoutEnabled, compareAndSetRepresentativeCheckoutEnabled),
);

// --- application queue + detail (§11) ----------------------------------------

const FILTERS: ApplicationFilter[] = ["pending", "approved", "rejected", "withdrawn", "all"];
const FILTER_LABEL: Record<ApplicationFilter, string> = {
  pending: "در انتظار",
  approved: "تأییدشده",
  rejected: "ردشده",
  withdrawn: "لغوشده",
  all: "همه",
};

adminRepresentativeHandler.callbackQuery(
  new RegExp(`^${AC.LIST}(pending|approved|rejected|withdrawn|all):(\\d+)$`),
  async (ctx) => {
    if (!(await ownerGuard(ctx))) {
      return;
    }
    await safeAnswerCallback(ctx);
    const filter = ctx.match![1] as ApplicationFilter;
    const page = Math.max(1, Number.parseInt(ctx.match![2], 10) || 1);
    const { rows, total } = await listApplicationsForAdmin(filter, page);
    const lines = [`🤝 <b>درخواست‌های نمایندگی</b> — ${FILTER_LABEL[filter]} (${total})`, ""];
    const kb = new InlineKeyboard();
    if (rows.length === 0) {
      lines.push("موردی یافت نشد.");
    } else {
      for (const a of rows) {
        kb.text(
          `${appStatusLabel(a.status)} — ${esc(a.fullName)}`,
          `${AC.VIEW}${representativeShortId(a.id)}`,
        ).row();
      }
    }
    // filter row
    for (const f of FILTERS) {
      kb.text(f === filter ? `• ${FILTER_LABEL[f]}` : FILTER_LABEL[f], `${AC.LIST}${f}:1`);
    }
    kb.row();
    if (page > 1) {
      kb.text("« قبلی", `${AC.LIST}${filter}:${page - 1}`);
    }
    if (page * 8 < total) {
      kb.text("بعدی »", `${AC.LIST}${filter}:${page + 1}`);
    }
    kb.row().text("بازگشت", AC.ROOT);
    await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
  },
);

async function renderApplicationDetail(ctx: BotContext, appSid: string): Promise<void> {
  const app = await getApplicationByShortId(appSid);
  if (app === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const context = await getAdminApplicationContext(app.userId);
  const lines = [
    "🤝 <b>جزئیات درخواست نمایندگی</b>",
    "",
    `وضعیت: ${appStatusLabel(app.status)}`,
    `نام: ${esc(app.fullName)}`,
    `تلفن: ${esc(app.phone)}`,
    `استان/شهر: ${esc(app.province)} / ${esc(app.city)}`,
    `کانال فروش: ${esc(app.salesChannel)}`,
    `مشتری ماهانه (تقریبی): ${app.expectedMonthlyCustomers}`,
    `سابقه: ${app.experience ? esc(app.experience) : "—"}`,
    "",
    "توضیحات:",
    esc(app.explanation),
    "",
    "— اطلاعات حساب —",
    `سن حساب: ${context.accountAgeDays} روز`,
    `سفارش‌های پرداخت‌شده: ${context.paidOrderCount}`,
    `سرویس‌های فعال: ${context.activeServiceCount}`,
    `دارای معرف: ${context.hasReferrer ? "بله" : "خیر"}`,
  ];
  if (app.status === "REJECTED" && app.decisionReason !== null) {
    lines.push("", `دلیل رد: ${esc(app.decisionReason)}`);
  }
  const kb = new InlineKeyboard();
  if (app.status === "PENDING_REVIEW") {
    kb.text("تأیید ✅", `${AC.APPROVE}${representativeShortId(app.id)}`)
      .text("رد ❌", `${AC.REJECT}${representativeShortId(app.id)}`)
      .row();
  }
  kb.text("بازگشت", `${AC.LIST}pending:1`);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.VIEW}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderApplicationDetail(ctx, ctx.match![1]);
});

// --- approval (§12): pick an active tier, then create the representative ------

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.APPROVE}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const appSid = ctx.match![1];
  const tiers = (await listRepresentativeTiers(false)).filter((t) => t.isActive);
  const kb = new InlineKeyboard();
  if (tiers.length === 0) {
    await safeEditOrReply(
      ctx,
      "برای تأیید ابتدا یک سطح نمایندگی فعال بسازید.",
      kb.text("سطح‌های نمایندگی 💠", AC.TIERS).row().text("بازگشت", `${AC.VIEW}${appSid}`),
    );
    return;
  }
  for (const t of tiers) {
    kb.text(t.name, `${AC.APPROVE_TIER}${appSid}:${representativeShortId(t.id)}`).row();
  }
  kb.text("بازگشت", `${AC.VIEW}${appSid}`);
  await safeEditOrReply(ctx, "سطح نمایندگی را انتخاب کنید:", kb);
});

adminRepresentativeHandler.callbackQuery(
  new RegExp(`^${AC.APPROVE_TIER}([a-f0-9]{8}):([a-f0-9]{8})$`),
  async (ctx) => {
    if (!(await ownerGuard(ctx))) {
      return;
    }
    const [, appSid, tierSid] = ctx.match!;
    const app = await getApplicationByShortId(appSid);
    const tier = await getRepresentativeTierByShortId(tierSid);
    if (app === null || tier === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const result = await approveRepresentativeApplication({
      applicationId: app.id,
      adminId: ctx.admin!.id,
      tierId: tier.id,
    });
    if (!result.ok) {
      await safeAnswerCallback(ctx, approveErr(result.code));
      await renderApplicationDetail(ctx, appSid);
      return;
    }
    await safeAnswerCallback(ctx, "تأیید شد ✅");
    // Fail-soft user notification (§12): generic congrats + tier name only.
    await notifyApproved(ctx, result.representative.userId, tier.name);
    await renderApplicationDetail(ctx, appSid);
  },
);

function approveErr(code: string): string {
  switch (code) {
    case "ALREADY_REPRESENTATIVE":
      return "این کاربر از قبل نماینده است.";
    case "TERMINATED":
      return "نمایندگی این کاربر لغو دائم شده است.";
    case "INELIGIBLE_STATUS":
      return "درخواست دیگر در وضعیت بررسی نیست.";
    case "TIER_INACTIVE":
      return "سطح انتخابی فعال نیست.";
    default:
      return "تأیید ممکن نشد.";
  }
}

async function notifyApproved(ctx: BotContext, userId: string, tierName: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    if (user === null) {
      return;
    }
    const body = await getMessageTemplate(
      "representative_application_approved",
      "تبریک! 🎉 درخواست نمایندگی شما تأیید شد.\nتعرفهٔ شما: {tier}",
      { tier: tierName },
    );
    await ctx.api.sendMessage(user.telegramId.toString(), body, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("نمایندگی من 🤝", "user:representative_request"),
    });
  } catch (err) {
    logger.warn("representative approval notify skipped", { error: errorMessage(err) });
  }
}

// --- rejection (§13): mandatory reason via text flow -------------------------

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.REJECT}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const appSid = ctx.match![1];
  const app = await getApplicationByShortId(appSid);
  if (app === null || app.status !== "PENDING_REVIEW") {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminRepDraft = { kind: "reject", applicationId: app.id, nonce: randomUUID() };
  ctx.session.currentFlow = REP_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `دلیل رد درخواست را وارد کنید (بین ${REP_REASON_MIN} تا ${REP_REASON_MAX} نویسه). این دلیل به کاربر نمایش داده می‌شود.`,
    new InlineKeyboard().text("انصراف", `${AC.VIEW}${appSid}`),
  );
});

// --- representative list + detail + lifecycle (§20) ---------------------------

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.REPS}(\\d+)$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const page = Math.max(1, Number.parseInt(ctx.match![1], 10) || 1);
  const { rows, total } = await listRepresentativesForAdmin(page);
  const kb = new InlineKeyboard();
  const lines = [`👥 <b>نمایندگان</b> (${total})`, ""];
  if (rows.length === 0) {
    lines.push("موردی یافت نشد.");
  } else {
    for (const r of rows) {
      kb.text(
        `${repStatusLabel(r.status)} — ${r.tier?.name ?? "بدون تعرفه"}`,
        `${AC.RVIEW}${representativeShortId(r.id)}`,
      ).row();
    }
  }
  if (page > 1) {
    kb.text("« قبلی", `${AC.REPS}${page - 1}`);
  }
  if (page * 8 < total) {
    kb.text("بعدی »", `${AC.REPS}${page + 1}`);
  }
  kb.row().text("بازگشت", AC.ROOT);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
});

async function renderRepDetail(ctx: BotContext, repSid: string): Promise<void> {
  const rep = await getRepresentativeByShortId(repSid);
  if (rep === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const lines = [
    "🤝 <b>جزئیات نماینده</b>",
    "",
    `وضعیت: ${repStatusLabel(rep.status)}`,
    `تعرفه: ${rep.tier?.name ?? "بدون تعرفه"}`,
    `خرید نمایندگی: ${rep.checkoutEnabled ? "مجاز ✅" : "غیرمجاز ⛔"}`,
  ];
  const kb = new InlineKeyboard();
  if (rep.status === "ACTIVE") {
    kb.text("تعلیق ⏸", `${AC.SUSPEND}${repSid}`).row();
  } else if (rep.status === "SUSPENDED") {
    kb.text("رفع تعلیق ▶️", `${AC.REACT}${repSid}`).row();
  }
  if (rep.status !== "TERMINATED") {
    kb.text("تغییر تعرفه 💠", `${AC.SETTIER}${repSid}`)
      .text(rep.checkoutEnabled ? "بستن خرید" : "باز کردن خرید", `${AC.TOGGLE_CHK}${repSid}`)
      .row();
    kb.text("لغو دائم ⛔", `${AC.TERM}${repSid}`).row();
  }
  kb.text("بازگشت", `${AC.REPS}1`);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.RVIEW}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderRepDetail(ctx, ctx.match![1]);
});

async function lifecycleAction(
  ctx: BotContext,
  repSid: string,
  run: (repId: string, adminId: string) => Promise<{ ok: boolean; code?: string }>,
): Promise<void> {
  const rep = await getRepresentativeByShortId(repSid);
  if (rep === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const result = await run(rep.id, ctx.admin!.id);
  await safeAnswerCallback(ctx, result.ok ? "انجام شد ✅" : "عملیات ممکن نشد.");
  await renderRepDetail(ctx, repSid);
}

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.REACT}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await lifecycleAction(ctx, ctx.match![1], (representativeId, adminId) =>
    reactivateRepresentative({ representativeId, adminId }),
  );
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TOGGLE_CHK}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const rep = await getRepresentativeByShortId(ctx.match![1]);
  if (rep === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await lifecycleAction(ctx, ctx.match![1], (representativeId, adminId) =>
    setRepresentativeCheckoutEnabled({ representativeId, adminId, enabled: !rep.checkoutEnabled }),
  );
});

// suspend + terminate need a reason (text flow); terminate double-confirms first.
adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.SUSPEND}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const rep = await getRepresentativeByShortId(ctx.match![1]);
  if (rep === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminRepDraft = {
    kind: "suspend",
    representativeId: rep.id,
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = REP_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `دلیل تعلیق را وارد کنید (بین ${REP_REASON_MIN} تا ${REP_REASON_MAX} نویسه).`,
    new InlineKeyboard().text("انصراف", `${AC.RVIEW}${ctx.match![1]}`),
  );
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TERM}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const repSid = ctx.match![1];
  await safeEditOrReply(
    ctx,
    "⚠️ لغو دائم نمایندگی غیرقابل بازگشت است. تاریخچه حفظ می‌شود اما خرید نمایندگی برای همیشه بسته می‌شود.\nآیا مطمئن هستید؟",
    new InlineKeyboard()
      .text("بله، لغو دائم شود", `${AC.TERM_YES}${repSid}`)
      .row()
      .text("خیر", `${AC.RVIEW}${repSid}`),
  );
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TERM_YES}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const rep = await getRepresentativeByShortId(ctx.match![1]);
  if (rep === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminRepDraft = {
    kind: "terminate",
    representativeId: rep.id,
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = REP_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `دلیل لغو دائم را وارد کنید (بین ${REP_REASON_MIN} تا ${REP_REASON_MAX} نویسه).`,
    new InlineKeyboard().text("انصراف", `${AC.RVIEW}${ctx.match![1]}`),
  );
});

// set tier (§20 reactivate/assign)
adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.SETTIER}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const repSid = ctx.match![1];
  const tiers = (await listRepresentativeTiers(false)).filter((t) => t.isActive);
  const kb = new InlineKeyboard();
  for (const t of tiers) {
    kb.text(t.name, `${AC.SETTIER_DO}${repSid}:${representativeShortId(t.id)}`).row();
  }
  kb.text("بازگشت", `${AC.RVIEW}${repSid}`);
  await safeEditOrReply(ctx, "سطح نمایندگی جدید را انتخاب کنید:", kb);
});

adminRepresentativeHandler.callbackQuery(
  new RegExp(`^${AC.SETTIER_DO}([a-f0-9]{8}):([a-f0-9]{8})$`),
  async (ctx) => {
    if (!(await ownerGuard(ctx))) {
      return;
    }
    const [, repSid, tierSid] = ctx.match!;
    const rep = await getRepresentativeByShortId(repSid);
    const tier = await getRepresentativeTierByShortId(tierSid);
    if (rep === null || tier === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const result = await assignRepresentativeTier({
      representativeId: rep.id,
      adminId: ctx.admin!.id,
      tierId: tier.id,
    });
    await safeAnswerCallback(ctx, result.ok ? "تعرفه تغییر کرد ✅" : "ممکن نشد.");
    await renderRepDetail(ctx, repSid);
  },
);

// --- tier management (§18) ----------------------------------------------------

async function renderTiers(ctx: BotContext): Promise<void> {
  const tiers = await listRepresentativeTiers(true);
  const kb = new InlineKeyboard();
  const lines = ["💠 <b>سطح‌های نمایندگی</b>", ""];
  if (tiers.length === 0) {
    lines.push("هنوز سطحی ساخته نشده است.");
  } else {
    for (const t of tiers) {
      kb.text(
        `${t.isActive ? "✅" : "🗄"} ${t.name}`,
        `${AC.TIER_VIEW}${representativeShortId(t.id)}`,
      ).row();
    }
  }
  kb.text("ساخت سطح جدید ➕", AC.TIER_NEW).row().text("بازگشت", AC.ROOT);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(AC.TIERS, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderTiers(ctx);
});

adminRepresentativeHandler.callbackQuery(AC.TIER_NEW, async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  ctx.session.temp.adminRepDraft = { kind: "tier_name", nonce: randomUUID() };
  ctx.session.currentFlow = REP_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "نام سطح نمایندگی جدید را وارد کنید:",
    new InlineKeyboard().text("انصراف", AC.TIERS),
  );
});

async function renderTierDetail(ctx: BotContext, tierSid: string): Promise<void> {
  const tier = await getRepresentativeTierByShortId(tierSid);
  if (tier === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const lines = [
    `💠 <b>${esc(tier.name)}</b>`,
    tier.description ? esc(tier.description) : "",
    "",
    `وضعیت: ${tier.isActive ? "فعال ✅" : "آرشیو 🗄"}`,
  ];
  const kb = new InlineKeyboard()
    .text("قیمت محصولات 💵", `${AC.PRICES}${tierSid}`)
    .row();
  if (tier.isActive) {
    kb.text("آرشیو 🗄", `${AC.TIER_ARCH}${tierSid}`).row();
  } else {
    kb.text("فعال‌سازی مجدد ▶️", `${AC.TIER_REACT}${tierSid}`).row();
  }
  kb.text("بازگشت", AC.TIERS);
  await safeEditOrReply(ctx, lines.filter((l) => l !== "").join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TIER_VIEW}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderTierDetail(ctx, ctx.match![1]);
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TIER_ARCH}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const tier = await getRepresentativeTierByShortId(ctx.match![1]);
  if (tier === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const result = await setRepresentativeTierActive({
    tierId: tier.id,
    adminId: ctx.admin!.id,
    active: false,
  });
  await safeAnswerCallback(
    ctx,
    result.ok ? "آرشیو شد ✅" : "این سطح توسط نمایندگان فعال استفاده می‌شود.",
  );
  await renderTierDetail(ctx, ctx.match![1]);
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.TIER_REACT}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const tier = await getRepresentativeTierByShortId(ctx.match![1]);
  if (tier === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await setRepresentativeTierActive({ tierId: tier.id, adminId: ctx.admin!.id, active: true });
  await safeAnswerCallback(ctx, "فعال شد ✅");
  await renderTierDetail(ctx, ctx.match![1]);
});

// --- per-tier product prices (§19) -------------------------------------------

async function renderPrices(ctx: BotContext, tierSid: string): Promise<void> {
  const tier = await getRepresentativeTierByShortId(tierSid);
  if (tier === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const rows = await listTierProductPrices(tier.id);
  const kb = new InlineKeyboard();
  const lines = [`💵 <b>قیمت‌های ${esc(tier.name)}</b>`, ""];
  if (rows.length === 0) {
    lines.push(
      "هیچ محصولی برای فروش نمایندگی فعال نشده است.",
      "ابتدا از «محصولات نمایندگی 🛍» یک محصول سرویس را «قابل نمایندگی» کنید.",
    );
  } else {
    for (const row of rows) {
      const psid = representativeShortId(row.product.id);
      const hasActivePrice = row.price !== null && row.price.isActive;
      // Stable machine state → Persian label (never compare Persian strings, §11):
      //   UNSELLABLE       → opted-in but product/panel readiness fails.
      //   NO_ACTIVE_PRICE  → opted-in & sellable but no active tier price yet.
      //   HAS_PRICE        → opted-in & sellable with an active tier price.
      const state: "UNSELLABLE" | "NO_ACTIVE_PRICE" | "HAS_PRICE" =
        !row.product.isActive || !row.sellable
          ? "UNSELLABLE"
          : hasActivePrice
            ? "HAS_PRICE"
            : "NO_ACTIVE_PRICE";
      const priceLabel =
        row.price === null || !row.price.isActive
          ? "بدون قیمت"
          : row.price.priceMode === "FIXED_TOMAN"
            ? formatToman(row.price.fixedPriceToman ?? 0)
            : `${row.price.percentValue ?? 0}٪`;
      const stateLabel =
        state === "UNSELLABLE"
          ? "⚠️ فعلاً غیرقابل‌فروش"
          : state === "NO_ACTIVE_PRICE"
            ? "بدون قیمت فعال"
            : "دارای قیمت فعال ✅";
      lines.push(
        `• ${esc(row.product.name)} — عادی ${formatToman(row.product.priceToman)} — ${priceLabel} — ${stateLabel}`,
      );
      kb.text(`مبلغ ثابت: ${esc(row.product.name)}`, `${AC.PRICE_FIXED}${tierSid}:${psid}`)
        .text("درصد", `${AC.PRICE_PCT}${tierSid}:${psid}`)
        .row();
      if (row.price !== null) {
        kb.text(
          row.price.isActive ? `غیرفعال: ${esc(row.product.name)}` : `فعال: ${esc(row.product.name)}`,
          row.price.isActive ? `${AC.PRICE_OFF}${tierSid}:${psid}` : `${AC.PRICE_ON}${tierSid}:${psid}`,
        ).row();
      }
    }
  }
  kb.text("محصولات نمایندگی 🛍", `${AC.ELIG}1`)
    .row()
    .text("بازگشت", `${AC.TIER_VIEW}${tierSid}`);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

/**
 * OWNER product-eligibility management list (§12). Shows EVERY SERVICE_PRODUCT —
 * opted-in and not — in a bounded, paginated list with its current
 * representative-eligibility + structural-sellability state, so a product never
 * disappears from the config surface merely because it is not yet opted in. Each
 * row deep-links to the existing product detail page, where the OWNER opts it in
 * / out through the ONE authoritative product mutation (no second writer here).
 */
async function renderEligibility(ctx: BotContext, page: number): Promise<void> {
  const result = await listProducts("S", page);
  const lines = [
    "🛍 <b>محصولات نمایندگی</b>",
    "",
    "وضعیت «فروش نمایندگی» همهٔ محصولات سرویس. برای فعال/غیرفعال‌کردن، وارد جزئیات محصول شوید.",
    "",
  ];
  const kb = new InlineKeyboard();
  if (result.products.length === 0) {
    lines.push("هیچ محصول سرویسی تعریف نشده است.");
  } else {
    for (const product of result.products) {
      const psid = representativeShortId(product.id);
      // Stable machine state (never Persian-string comparison, §11):
      //   NOT_ELIGIBLE / ELIGIBLE_SELLABLE / ELIGIBLE_UNSELLABLE.
      const state: "NOT_ELIGIBLE" | "ELIGIBLE_SELLABLE" | "ELIGIBLE_UNSELLABLE" =
        !product.representativeEligible
          ? "NOT_ELIGIBLE"
          : isProductStructurallySellable(product)
            ? "ELIGIBLE_SELLABLE"
            : "ELIGIBLE_UNSELLABLE";
      const stateLabel =
        state === "NOT_ELIGIBLE"
          ? "خارج از نمایندگی ❌"
          : state === "ELIGIBLE_SELLABLE"
            ? "نمایندگی فعال ✅"
            : "نمایندگی فعال، غیرقابل‌فروش ⚠️";
      lines.push(`• ${esc(product.name)} — عادی ${formatToman(product.priceToman)} — ${stateLabel}`);
      kb.text(`تنظیم: ${esc(product.name)}`, pcb.view(psid)).row();
    }
  }
  if (result.pages > 1) {
    if (result.page > 1) {
      kb.text("« قبلی", `${AC.ELIG}${result.page - 1}`);
    }
    if (result.page < result.pages) {
      kb.text("بعدی »", `${AC.ELIG}${result.page + 1}`);
    }
    kb.row();
    lines.push("", `صفحهٔ ${result.page} از ${result.pages}`);
  }
  kb.text("بازگشت", AC.ROOT);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.ELIG}(\\d+)$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const page = Math.max(1, Number.parseInt(ctx.match![1], 10) || 1);
  await renderEligibility(ctx, page);
});

adminRepresentativeHandler.callbackQuery(new RegExp(`^${AC.PRICES}([a-f0-9]{8})$`), async (ctx) => {
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderPrices(ctx, ctx.match![1]);
});

// price entry via text flow (fixed | percent)
for (const [cb, kind] of [
  [AC.PRICE_FIXED, "price_fixed"],
  [AC.PRICE_PCT, "price_percent"],
] as const) {
  adminRepresentativeHandler.callbackQuery(
    new RegExp(`^${cb}([a-f0-9]{8}):([a-f0-9]{8})$`),
    async (ctx) => {
      if (!(await ownerGuard(ctx))) {
        return;
      }
      const [, tierSid, psid] = ctx.match!;
      const tier = await getRepresentativeTierByShortId(tierSid);
      const product = await prisma.product.findFirst({
        where: { id: { startsWith: psid } },
        select: { id: true },
      });
      if (tier === null || product === null) {
        await safeAnswerCallback(ctx, NOT_FOUND);
        return;
      }
      ctx.session.temp.adminRepDraft = {
        kind,
        tierId: tier.id,
        productId: product.id,
        nonce: randomUUID(),
      };
      ctx.session.currentFlow = REP_FLOW;
      await safeAnswerCallback(ctx);
      await safeEditOrReply(
        ctx,
        kind === "price_fixed"
          ? "مبلغ ثابت نمایندگی (تومان) را وارد کنید. باید کمتر یا مساوی قیمت عادی باشد."
          : "درصد تخفیف نمایندگی (بین ۱ تا ۹۵) را وارد کنید.",
        new InlineKeyboard().text("انصراف", `${AC.PRICES}${tierSid}`),
      );
    },
  );
}

for (const [cb, active] of [
  [AC.PRICE_OFF, false],
  [AC.PRICE_ON, true],
] as const) {
  adminRepresentativeHandler.callbackQuery(
    new RegExp(`^${cb}([a-f0-9]{8}):([a-f0-9]{8})$`),
    async (ctx) => {
      if (!(await ownerGuard(ctx))) {
        return;
      }
      const [, tierSid, psid] = ctx.match!;
      const tier = await getRepresentativeTierByShortId(tierSid);
      const product = await prisma.product.findFirst({
        where: { id: { startsWith: psid } },
        select: { id: true },
      });
      if (tier === null || product === null) {
        await safeAnswerCallback(ctx, NOT_FOUND);
        return;
      }
      await setRepresentativeProductPriceActive({
        tierId: tier.id,
        productId: product.id,
        adminId: ctx.admin!.id,
        active,
      });
      await safeAnswerCallback(ctx, "انجام شد ✅");
      await renderPrices(ctx, tierSid);
    },
  );
}

// --- text input flow (reason / tier name / price value) ----------------------

adminRepresentativeTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== REP_FLOW) {
    return next();
  }
  if (!isOwner(ctx)) {
    ctx.session.currentFlow = null;
    return next();
  }
  const draft = ctx.session.temp.adminRepDraft;
  const text = ctx.message.text.trim();
  if (draft === undefined || text.startsWith("/")) {
    ctx.session.currentFlow = null;
    delete ctx.session.temp.adminRepDraft;
    return next();
  }
  const adminId = ctx.admin!.id;
  try {
    switch (draft.kind) {
      case "reject": {
        if (!isValidRepReason(text)) {
          await safeReply(ctx, `دلیل باید بین ${REP_REASON_MIN} تا ${REP_REASON_MAX} نویسه باشد.`);
          return;
        }
        const r = await rejectRepresentativeApplication({
          applicationId: draft.applicationId!,
          adminId,
          reason: text,
        });
        finish(ctx);
        await safeReply(ctx, r.ok ? "درخواست رد شد ✅" : "رد ممکن نشد.");
        if (r.ok) {
          await notifyRejected(ctx, draft.applicationId!, text);
        }
        await renderRoot(ctx);
        return;
      }
      case "suspend":
      case "terminate": {
        if (!isValidRepReason(text)) {
          await safeReply(ctx, `دلیل باید بین ${REP_REASON_MIN} تا ${REP_REASON_MAX} نویسه باشد.`);
          return;
        }
        const run =
          draft.kind === "suspend"
            ? suspendRepresentative({ representativeId: draft.representativeId!, adminId, reason: text })
            : terminateRepresentative({
                representativeId: draft.representativeId!,
                adminId,
                reason: text,
              });
        const r = await run;
        finish(ctx);
        await safeReply(ctx, r.ok ? "انجام شد ✅" : "عملیات ممکن نشد.");
        await renderRepDetail(ctx, representativeShortId(draft.representativeId!));
        return;
      }
      case "tier_name": {
        const r = await createRepresentativeTier({ name: text, description: null, adminId });
        finish(ctx);
        await safeReply(ctx, r.ok ? "سطح ساخته شد ✅" : "نام معتبر نیست.");
        await renderTiers(ctx);
        return;
      }
      case "price_fixed": {
        const value = parseRepFixedToman(text);
        if (value === null) {
          await safeReply(ctx, "یک عدد صحیح معتبر وارد کنید.");
          return;
        }
        const r = await upsertRepresentativeProductPrice({
          tierId: draft.tierId!,
          productId: draft.productId!,
          adminId,
          mode: "FIXED_TOMAN",
          fixedPriceToman: value,
          percentValue: null,
        });
        finish(ctx);
        await safeReply(ctx, r.ok ? "قیمت ثبت شد ✅" : priceErr(r.code));
        await renderPrices(ctx, representativeShortId(draft.tierId!));
        return;
      }
      case "price_percent": {
        const value = parseRepPercent(text);
        if (value === null) {
          await safeReply(ctx, "یک درصد بین ۱ تا ۹۵ وارد کنید.");
          return;
        }
        const r = await upsertRepresentativeProductPrice({
          tierId: draft.tierId!,
          productId: draft.productId!,
          adminId,
          mode: "PERCENT_DISCOUNT",
          fixedPriceToman: null,
          percentValue: value,
        });
        finish(ctx);
        await safeReply(ctx, r.ok ? "قیمت ثبت شد ✅" : priceErr(r.code));
        await renderPrices(ctx, representativeShortId(draft.tierId!));
        return;
      }
      default:
        finish(ctx);
        return;
    }
  } catch (err) {
    finish(ctx);
    logger.error("admin representative input failed", { error: errorMessage(err) });
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

function finish(ctx: BotContext): void {
  ctx.session.currentFlow = null;
  delete ctx.session.temp.adminRepDraft;
}

function priceErr(code: string): string {
  switch (code) {
    case "PRICE_ABOVE_RETAIL":
      return "قیمت ثابت نباید بیشتر از قیمت عادی باشد.";
    case "PRODUCT_INELIGIBLE":
      return "این محصول واجد شرایط نمایندگی نیست.";
    default:
      return "ثبت قیمت ممکن نشد.";
  }
}

async function notifyRejected(ctx: BotContext, applicationId: string, reason: string): Promise<void> {
  try {
    const app = await prisma.representativeApplication.findUnique({
      where: { id: applicationId },
      select: { user: { select: { telegramId: true } } },
    });
    if (app === null) {
      return;
    }
    const body = await getMessageTemplate(
      "representative_application_rejected",
      "متأسفانه درخواست نمایندگی شما تأیید نشد.\nدلیل: {reason}",
      { reason },
    );
    await ctx.api.sendMessage(app.user.telegramId.toString(), body, { parse_mode: "HTML" });
  } catch (err) {
    logger.warn("representative rejection notify skipped", { error: errorMessage(err) });
  }
}
