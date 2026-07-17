import { randomUUID } from "node:crypto";

import {
  prisma,
  type FreeTrialClaimStatus,
  type User,
} from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import type { SessionData } from "../../core/session.js";
import {
  getAdminTargetUserByShortId,
  getUserById,
} from "../../services/admin-user-wallet.service.js";
import {
  clearTrialCooldown,
  FORCE_RESOLVABLE_STATUSES,
  forceClaimCreated,
  forceClaimNotCreated,
  grantTrialAllowance,
  listTrialHistory,
  normalizeDigits,
  parseAllowanceCount,
  resetTrialAccess,
  revokeTrialAccess,
  setEffectiveRemaining,
  setTrialCooldown,
  setTrialTemporaryDenial,
  TRIAL_FORCE_WARNING_TEXT,
  TRIAL_GRANT_MAX_PER_OPERATION,
  trialManagementSummary,
  type TrialManagementSummary,
} from "../../services/free-trial-admin.service.js";
import { formatPersianDate } from "../../services/free-trial-entitlement.service.js";
import {
  reconcileTrialClaim,
  type TrialReconcileOutcome,
} from "../../services/free-trial.service.js";
import { getPanelById, getPanelByShortId, listPanels, panelShortId } from "../../services/panel.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { statusLabel as serviceStatusLabel } from "../user-services/service-views.js";
import { AU_CB, userShortId, usersLandingKeyboard } from "./admin-users-views.js";

// =============================================================================
// «مدیریت اکانت تست 🎁» (trial-entitlement phase) - per-user admin trial
// management under پنل ادمین → مدیریت کاربران → جزئیات کاربر. Every mutation
// goes through free-trial-admin.service (which validates, applies and writes
// the audit row); this handler only renders, collects input and confirms.
// Drafts live in session.temp.adminTrialActionDraft with a one-shot nonce as
// idempotency key; the draft is CONSUMED before the mutation so a
// double-clicked confirmation can never apply twice. No subscription URLs,
// tokens or remote client ids are ever rendered here.
// =============================================================================

type TrialDraft = NonNullable<SessionData["temp"]["adminTrialActionDraft"]>;

const HTML = { parseMode: "HTML" as const };
const T = "admin:users:trial";
const TRIAL_FLOW_PREFIX = "admin_trial:";

// Text flows (routed from adminUsersTextHandler via trialManagementTextHandler).
const FLOW_GRANT_COUNT = "admin_trial:grant:count";
const FLOW_GRANT_DAYS = "admin_trial:grant:days";
const FLOW_GRANT_REASON = "admin_trial:grant:reason";
const FLOW_SETREM_COUNT = "admin_trial:setrem:count";
const FLOW_SETREM_REASON = "admin_trial:setrem:reason";
const FLOW_RESET_REASON = "admin_trial:reset:reason";
const FLOW_REVOKE_REASON = "admin_trial:revoke:reason";
const FLOW_COOLDOWN_DAYS = "admin_trial:cooldown:days";
const FLOW_COOLDOWN_REASON = "admin_trial:cooldown:reason";
const FLOW_DENIAL_DAYS = "admin_trial:denial:days";
const FLOW_DENIAL_REASON = "admin_trial:denial:reason";
const FLOW_FORCE_REASON = "admin_trial:force:reason";

// --- module texts (repo convention: hardcoded Persian constants) --------------------

const MAIN_TITLE = "🎁 مدیریت اکانت تست کاربر";
const NOT_FOUND_TEXT = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const CANCELLED_TEXT = "لغو شد.";
const OWNER_ONLY_TEXT = "فقط مالک ربات به این بخش دسترسی دارد.";
const UNLIMITED_TEXT = "نامحدود";
const EMPTY_VALUE_TEXT = "-";

const MAX_BARRIER_DAYS = 365;
const DAY_MS = 86_400_000;
const TRIAL_SERVICES_PAGE_SIZE = 5;

const INVALID_COUNT_TEXT = `تعداد باید عددی بین 1 تا ${TRIAL_GRANT_MAX_PER_OPERATION} باشد.`;
const INVALID_REMAINING_TEXT = `تعداد باید عددی بین 0 تا ${TRIAL_GRANT_MAX_PER_OPERATION} باشد.`;
const INVALID_DAYS_TEXT = `تعداد روز باید عددی بین 1 تا ${MAX_BARRIER_DAYS} باشد.`;
const INVALID_REASON_TEXT = "دلیل باید بین 3 تا 500 کاراکتر باشد.";

const GRANT_SCOPE_PROMPT = "سهمیه تست برای کدام محدوده اضافه شود؟";
const GRANT_SCOPE_ALL_LABEL = "همه پنل‌ها";
const GRANT_SCOPE_PANEL_LABEL = "پنل مشخص";
const GRANT_PANEL_PICK_PROMPT = "پنل موردنظر را انتخاب کنید:";
const NO_ACTIVE_PANEL_TEXT = "پنل فعالی یافت نشد.";
const GRANT_COUNT_PROMPT = "تعداد تست اضافه را وارد کنید.";
const GRANT_EXPIRY_PROMPT = "اعتبار سهمیه را مشخص کنید.";
const GRANT_EXPIRY_NONE_LABEL = "بدون تاریخ انقضا";
const GRANT_EXPIRY_DAYS_LABEL = "اعتبار برای چند روز";
const GRANT_DAYS_PROMPT = "سهمیه برای چند روز معتبر باشد؟ (عدد روز را وارد کنید)";
const GRANT_REASON_PROMPT = "دلیل افزودن سهمیه تست را وارد کنید.";

const SETREM_REASON_PROMPT = "دلیل تغییر تعداد تست باقی‌مانده را وارد کنید.";
const SETREM_SUCCESS_TEXT = "تعداد تست باقی‌مانده کاربر بروزرسانی شد ✅";

const RESET_REASON_PROMPT = "دلیل ریست دسترسی تست را وارد کنید.";
const RESET_CONFIRM_TEXT =
  "با ریست دسترسی، تاریخچه قبلی حذف نمی‌شود و کاربر دوباره امکان دریافت تست خواهد داشت.\n\nادامه می‌دهید؟";
const RESET_SUCCESS_TEXT = "دسترسی اکانت تست کاربر با موفقیت ریست شد ✅";

const REVOKE_REASON_PROMPT = "دلیل لغو دسترسی تست را وارد کنید.";
const REVOKE_CONFIRM_TEXT = "آیا دسترسی این کاربر به دریافت اکانت تست لغو شود؟";
const REVOKE_SUCCESS_TEXT = "دسترسی کاربر به اکانت تست لغو شد.";

const CLEAR_COOLDOWN_CONFIRM_TEXT = "محدودیت زمانی دریافت تست این کاربر برداشته شود؟";
const CLEAR_COOLDOWN_SUCCESS_TEXT = "محدودیت زمانی دریافت تست برای کاربر برداشته شد ✅";

const COOLDOWN_DAYS_PROMPT =
  "دریافت تست بعدی تا چند روز آینده محدود شود؟ (عدد روز را وارد کنید)";
const COOLDOWN_REASON_PROMPT = "دلیل تنظیم محدودیت زمانی را وارد کنید.";
const COOLDOWN_SUCCESS_TEXT = "محدودیت زمانی دریافت تست برای کاربر تنظیم شد ✅";

const DENIAL_DAYS_PROMPT =
  "دسترسی تست کاربر تا چند روز آینده مسدود شود؟ (عدد روز را وارد کنید)";
const DENIAL_REASON_PROMPT = "دلیل مسدودسازی موقت تست را وارد کنید.";
const DENIAL_SUCCESS_TEXT = "مسدودسازی موقت تست برای کاربر تنظیم شد ✅";

const FORCE_REASON_PROMPT = "دلیل این اقدام را وارد کنید.";
const FORCE_NOT_RESOLVABLE_TEXT = "این درخواست قابل تعیین وضعیت نیست.";
const FORCE_NOT_CREATED_SUCCESS_TEXT = "درخواست لغو شد و سهمیه آزاد شد ✅";

const CONVERTED_MARKER_TEXT = "تبدیل‌شده به سرویس فعال";

const RECONCILE_OUTCOME_TEXTS: Record<TrialReconcileOutcome, string> = {
  APPLIED: "اکانت روی پنل تایید شد و سرویس ثبت شد ✅",
  NOT_APPLIED: "اکانت روی پنل یافت نشد؛ درخواست ناموفق شد و سهمیه آزاد شد.",
  UNKNOWN: "نتیجه هنوز نامشخص است. بعداً دوباره تلاش کنید.",
};

const CLAIM_STATUS_LABELS: Record<FreeTrialClaimStatus, string> = {
  CLAIMED: "ثبت‌شده",
  PROVISIONING: "در حال ساخت",
  ACTIVE: "فعال",
  FAILED: "ناموفق",
  EXPIRED: "منقضی",
  CANCELLED: "لغوشده",
  MANUAL_REVIEW: "در انتظار بررسی دستی",
};

/** entitlementId null = default policy allowance; otherwise by grant source. */
function quotaSourceLabel(source: string | null): string {
  if (source === null || source === "DEFAULT_POLICY") {
    return "پیش‌فرض";
  }
  if (source === "CAMPAIGN_RESET") {
    return "کمپین";
  }
  if (source === "COMPENSATION") {
    return "جبران";
  }
  // ADMIN_GRANT / ADMIN_RESET (and MIGRATION as admin-originated).
  return "ادمین";
}

// --- shared helpers ------------------------------------------------------------------

export const trialManagementHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

/**
 * Clears the trial flow + draft (never touches other admin-user state).
 * Exported so clearAdminUsersState drops stale trial drafts when the admin
 * leaves the user pages mid-flow.
 */
export function clearTrialManagementState(ctx: BotContext): void {
  clearTrialFlowState(ctx);
}

function clearTrialFlowState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow !== null &&
    ctx.session.currentFlow.startsWith(TRIAL_FLOW_PREFIX)
  ) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminTrialActionDraft;
}

/**
 * Consumes the draft BEFORE the mutation runs: a double-clicked confirmation
 * finds no draft and cannot apply twice (the nonce-keyed idempotencyKey is
 * the second guard for retried deliveries).
 */
function takeDraft(ctx: BotContext): TrialDraft | undefined {
  const draft = ctx.session.temp.adminTrialActionDraft;
  clearTrialFlowState(ctx);
  return draft;
}

function cancelKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard().text("انصراف", `${T}:cxl:${sid}`);
}

function confirmKeyboard(confirmCallback: string, sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید ✅", confirmCallback)
    .row()
    .text("انصراف", `${T}:cxl:${sid}`);
}

function dateOrDash(date: Date | null | undefined): string {
  return date === null || date === undefined ? EMPTY_VALUE_TEXT : formatPersianDate(date);
}

/** Safe display identity: telegram id + @username or name. Never secrets. */
function userDisplay(user: User): string {
  const name =
    user.username !== null && user.username !== ""
      ? `@${escapeHtml(user.username)}`
      : escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" "));
  return `<code>${user.telegramId}</code>${name === "" ? "" : ` | ${name}`}`;
}

/** Positive day count (Persian/Arabic digits ok), 1..365. */
function parseDayCount(raw: string): number | null {
  const normalized = normalizeDigits(raw.trim());
  if (!/^\d{1,3}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 10);
  return value >= 1 && value <= MAX_BARRIER_DAYS ? value : null;
}

/** Desired remaining (OWNER set-remaining): 0..100, Persian digits ok. */
function parseRemainingCount(raw: string): number | null {
  const normalized = normalizeDigits(raw.trim());
  if (!/^\d{1,4}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 10);
  return value >= 0 && value <= TRIAL_GRANT_MAX_PER_OPERATION ? value : null;
}

/** Reason is mandatory: trimmed free text, 3..500 characters. */
function normalizeReason(raw: string): string | null {
  const reason = raw.trim();
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
}

/** Claim lookup scoped to the target user; ambiguity returns null. */
async function findClaimByShortId(
  userId: string,
  shortId: string,
): Promise<{ id: string; status: FreeTrialClaimStatus } | null> {
  const matches = await prisma.freeTrialClaim.findMany({
    where: { userId, id: { startsWith: shortId } },
    take: 2,
    select: { id: true, status: true },
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- main page -----------------------------------------------------------------------

function trialMainText(user: User, summary: TrialManagementSummary): string {
  const totalClaims = Object.values(summary.claimCounts).reduce((sum, n) => sum + n, 0);
  const successfulClaims =
    (summary.claimCounts.ACTIVE ?? 0) + (summary.claimCounts.EXPIRED ?? 0);
  return [
    MAIN_TITLE,
    "",
    "کاربر:",
    userDisplay(user),
    "",
    "تعداد تست‌های استفاده‌شده:",
    String(summary.usedCount),
    "",
    "تعداد تست‌های باقی‌مانده:",
    summary.remaining === null ? UNLIMITED_TEXT : String(summary.remaining),
    "",
    "تست فعال:",
    summary.activeTrialExists ? "دارد" : "ندارد",
    "",
    "در حال ساخت:",
    summary.provisioningExists ? "بله" : "خیر",
    "",
    "آخرین تست:",
    dateOrDash(summary.lastTrialAt),
    "",
    "پایان محدودیت زمانی:",
    dateOrDash(summary.cooldownEndsAt),
    "",
    "وضعیت دسترسی:",
    summary.accessRevoked ? "غیرمجاز" : "مجاز",
    "",
    `کل درخواست‌ها: ${totalClaims}`,
    `موفق: ${successfulClaims} | ناموفق: ${summary.claimCounts.FAILED ?? 0} | لغوشده: ${summary.claimCounts.CANCELLED ?? 0}`,
    `در انتظار بررسی دستی: ${summary.claimCounts.MANUAL_REVIEW ?? 0}`,
    `سرویس‌های تست تبدیل‌شده: ${summary.convertedServiceCount}`,
    `سهمیه‌ها: فعال ${summary.activeGrantCount} | منقضی ${summary.expiredGrantCount} | لغوشده ${summary.revokedGrantCount}`,
  ].join("\n");
}

function trialMainKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("افزودن سهمیه تست", `${T}:g:${sid}`)
    .text("تنظیم تعداد تست باقی‌مانده", `${T}:sr:${sid}`)
    .row()
    .text("ریست دسترسی تست", `${T}:rs:${sid}`)
    .text("لغو دسترسی تست", `${T}:rv:${sid}`)
    .row()
    .text("رفع محدودیت زمانی", `${T}:cc:${sid}`)
    .text("تنظیم محدودیت زمانی", `${T}:sc:${sid}`)
    .row()
    .text("مسدودسازی موقت تست", `${T}:dn:${sid}`)
    .row()
    .text("مشاهده تاریخچه تست‌ها", `${T}:hist:${sid}:1`)
    .text("مشاهده سرویس‌های تست", `${T}:svc:${sid}:1`)
    .row()
    .text("بازگشت به جزئیات کاربر", AU_CB.view(sid));
}

async function renderTrialMain(ctx: BotContext, user: User): Promise<void> {
  const summary = await trialManagementSummary(user.id);
  await safeEditOrReply(
    ctx,
    trialMainText(user, summary),
    trialMainKeyboard(userShortId(user)),
    HTML,
  );
}

trialManagementHandler.callbackQuery(/^admin:users:trial:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearTrialFlowState(ctx);
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderTrialMain(ctx, user);
});

// «انصراف» - drops the trial flow/draft and returns to the trial main page.
trialManagementHandler.callbackQuery(/^admin:users:trial:cxl:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearTrialFlowState(ctx);
  await safeAnswerCallback(ctx, CANCELLED_TEXT);
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeEditOrReply(ctx, NOT_FOUND_TEXT, usersLandingKeyboard());
    return;
  }
  await renderTrialMain(ctx, user);
});

// --- «افزودن سهمیه تست» ----------------------------------------------------------------

trialManagementHandler.callbackQuery(/^admin:users:trial:g:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind: "grant",
    step: "scope",
    nonce: randomUUID(),
  };
  await safeAnswerCallback(ctx);
  const sid = userShortId(user);
  await safeEditOrReply(
    ctx,
    GRANT_SCOPE_PROMPT,
    new InlineKeyboard()
      .text(GRANT_SCOPE_ALL_LABEL, `${T}:gall`)
      .text(GRANT_SCOPE_PANEL_LABEL, `${T}:gp:${sid}:1`)
      .row()
      .text("انصراف", `${T}:cxl:${sid}`),
  );
});

// ACTIVE panels by name; the selection callback carries the panel short id.
trialManagementHandler.callbackQuery(
  /^admin:users:trial:gp:([0-9a-f-]+):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const draft = ctx.session.temp.adminTrialActionDraft;
    if (draft === undefined || draft.kind !== "grant") {
      await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
      return;
    }
    const sid = ctx.match[1];
    const pageData = await listPanels(Number.parseInt(ctx.match[2], 10), "a");
    await safeAnswerCallback(ctx);
    const kb = new InlineKeyboard();
    for (const panel of pageData.panels) {
      kb.text(panel.name, `${T}:gpanel:${panelShortId(panel)}`).row();
    }
    if (pageData.pages > 1) {
      if (pageData.page > 1) {
        kb.text("« قبلی", `${T}:gp:${sid}:${pageData.page - 1}`);
      }
      kb.text(`${pageData.page}/${pageData.pages}`, `${T}:gp:${sid}:${pageData.page}`);
      if (pageData.page < pageData.pages) {
        kb.text("بعدی »", `${T}:gp:${sid}:${pageData.page + 1}`);
      }
      kb.row();
    }
    kb.text("انصراف", `${T}:cxl:${sid}`);
    await safeEditOrReply(
      ctx,
      pageData.total === 0 ? NO_ACTIVE_PANEL_TEXT : GRANT_PANEL_PICK_PROMPT,
      kb,
    );
  },
);

/** Scope chosen - store the optional panel and ask for the count. */
async function startGrantCount(ctx: BotContext, panelId?: string): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminTrialActionDraft;
  if (draft === undefined || draft.kind !== "grant") {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  if (panelId !== undefined) {
    draft.panelId = panelId;
  }
  draft.step = "count";
  ctx.session.currentFlow = FLOW_GRANT_COUNT;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, GRANT_COUNT_PROMPT, cancelKeyboard(draft.userId.slice(0, 8)));
}

trialManagementHandler.callbackQuery(`${T}:gall`, async (ctx) => {
  await startGrantCount(ctx);
});

trialManagementHandler.callbackQuery(/^admin:users:trial:gpanel:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const panel = await getPanelByShortId(ctx.match[1]);
  if (panel === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  await startGrantCount(ctx, panel.id);
});

/** Expiry choice - «بدون تاریخ انقضا» keeps expiresAt unset. */
trialManagementHandler.callbackQuery(`${T}:gexp:none`, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminTrialActionDraft;
  if (draft === undefined || draft.kind !== "grant" || draft.count === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.step = "reason";
  ctx.session.currentFlow = FLOW_GRANT_REASON;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, GRANT_REASON_PROMPT, cancelKeyboard(draft.userId.slice(0, 8)));
});

trialManagementHandler.callbackQuery(`${T}:gexp:days`, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminTrialActionDraft;
  if (draft === undefined || draft.kind !== "grant" || draft.count === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.step = "days";
  ctx.session.currentFlow = FLOW_GRANT_DAYS;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, GRANT_DAYS_PROMPT, cancelKeyboard(draft.userId.slice(0, 8)));
});

/** Grant confirmation - rendered after the reason text arrives. */
async function renderGrantConfirm(
  ctx: BotContext,
  draft: TrialDraft,
  sid: string,
): Promise<void> {
  let scopeLabel = GRANT_SCOPE_ALL_LABEL;
  if (draft.panelId !== undefined) {
    const panel = await getPanelById(draft.panelId);
    scopeLabel = panel === null ? GRANT_SCOPE_PANEL_LABEL : panel.name;
  }
  const expiryLabel =
    draft.expiresAt === undefined
      ? GRANT_EXPIRY_NONE_LABEL
      : `تا ${formatPersianDate(new Date(draft.expiresAt))}`;
  await safeReply(
    ctx,
    [
      `آیا ${draft.count} سهمیه تست به این کاربر اضافه شود؟`,
      "",
      `محدوده: ${scopeLabel}`,
      `اعتبار: ${expiryLabel}`,
      `دلیل: ${draft.reason}`,
    ].join("\n"),
    confirmKeyboard(`${T}:gok`, sid),
  );
}

trialManagementHandler.callbackQuery(`${T}:gok`, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = takeDraft(ctx);
  if (
    draft === undefined ||
    draft.kind !== "grant" ||
    draft.count === undefined ||
    draft.reason === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const outcome = await grantTrialAllowance({
    admin,
    userId: user.id,
    count: draft.count,
    reason: draft.reason,
    panelId: draft.panelId,
    expiresAt: draft.expiresAt === undefined ? null : new Date(draft.expiresAt),
    idempotencyKey: `trial-grant:${draft.nonce}`,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.error);
    await renderTrialMain(ctx, user);
    return;
  }
  await safeAnswerCallback(ctx, `${draft.count} سهمیه تست برای کاربر اضافه شد ✅`);
  await renderTrialMain(ctx, user);
});

// --- «تنظیم تعداد تست باقی‌مانده» (OWNER) ------------------------------------------------

trialManagementHandler.callbackQuery(/^admin:users:trial:sr:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  const summary = await trialManagementSummary(user.id);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind: "set_remaining",
    step: "count",
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = FLOW_SETREM_COUNT;
  await safeAnswerCallback(ctx);
  const current = summary.remaining === null ? UNLIMITED_TEXT : String(summary.remaining);
  await safeEditOrReply(
    ctx,
    `تعداد فعلی تست باقی‌مانده: ${current}\n\nتعداد جدید تست باقی‌مانده را وارد کنید. (بین 0 تا ${TRIAL_GRANT_MAX_PER_OPERATION})`,
    cancelKeyboard(userShortId(user)),
  );
});

trialManagementHandler.callbackQuery(`${T}:srok`, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const draft = takeDraft(ctx);
  if (
    draft === undefined ||
    draft.kind !== "set_remaining" ||
    draft.desired === undefined ||
    draft.reason === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const outcome = await setEffectiveRemaining({
    admin,
    userId: user.id,
    desired: draft.desired,
    reason: draft.reason,
    idempotencyKey: `trial-setrem:${draft.nonce}`,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.error);
    await renderTrialMain(ctx, user);
    return;
  }
  await safeAnswerCallback(ctx, SETREM_SUCCESS_TEXT);
  await renderTrialMain(ctx, user);
});

// --- «ریست دسترسی تست» ------------------------------------------------------------------

trialManagementHandler.callbackQuery(/^admin:users:trial:rs:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind: "reset",
    step: "reason",
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = FLOW_RESET_REASON;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, RESET_REASON_PROMPT, cancelKeyboard(userShortId(user)));
});

trialManagementHandler.callbackQuery(`${T}:rsok`, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = takeDraft(ctx);
  if (draft === undefined || draft.kind !== "reset" || draft.reason === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const outcome = await resetTrialAccess({
    admin,
    userId: user.id,
    reason: draft.reason,
    idempotencyKey: `trial-reset:${draft.nonce}`,
  });
  if (!outcome.ok) {
    // TRIAL_RESET_BLOCKED_TEXT while a live/manual-review claim exists.
    await safeAnswerCallback(ctx, outcome.error);
    await renderTrialMain(ctx, user);
    return;
  }
  await safeAnswerCallback(ctx, RESET_SUCCESS_TEXT);
  await renderTrialMain(ctx, user);
});

// --- «لغو دسترسی تست» -------------------------------------------------------------------

trialManagementHandler.callbackQuery(/^admin:users:trial:rv:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind: "revoke",
    step: "reason",
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = FLOW_REVOKE_REASON;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, REVOKE_REASON_PROMPT, cancelKeyboard(userShortId(user)));
});

trialManagementHandler.callbackQuery(`${T}:rvok`, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = takeDraft(ctx);
  if (draft === undefined || draft.kind !== "revoke" || draft.reason === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const outcome = await revokeTrialAccess({ admin, userId: user.id, reason: draft.reason });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.error);
    await renderTrialMain(ctx, user);
    return;
  }
  await safeAnswerCallback(ctx, REVOKE_SUCCESS_TEXT);
  await renderTrialMain(ctx, user);
});

// --- «رفع محدودیت زمانی» ----------------------------------------------------------------
// Confirmation only - no draft/text input; clearing twice is harmless.

trialManagementHandler.callbackQuery(/^admin:users:trial:cc:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = userShortId(user);
  await safeEditOrReply(
    ctx,
    CLEAR_COOLDOWN_CONFIRM_TEXT,
    confirmKeyboard(`${T}:ccok:${sid}`, sid),
  );
});

trialManagementHandler.callbackQuery(/^admin:users:trial:ccok:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(ctx.match[1]);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const outcome = await clearTrialCooldown({ admin, userId: user.id });
  await safeAnswerCallback(ctx, outcome.ok ? CLEAR_COOLDOWN_SUCCESS_TEXT : outcome.error);
  await renderTrialMain(ctx, user);
});

// --- «تنظیم محدودیت زمانی» / «مسدودسازی موقت تست» -----------------------------------------
// Same input pattern: days from now (1..365, Persian digits ok) + reason + confirm.

async function startBarrierFlow(
  ctx: BotContext,
  shortId: string,
  kind: "cooldown_set" | "denial_set",
): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  const user = await getAdminTargetUserByShortId(shortId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind,
    step: "days",
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = kind === "cooldown_set" ? FLOW_COOLDOWN_DAYS : FLOW_DENIAL_DAYS;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    kind === "cooldown_set" ? COOLDOWN_DAYS_PROMPT : DENIAL_DAYS_PROMPT,
    cancelKeyboard(userShortId(user)),
  );
}

trialManagementHandler.callbackQuery(/^admin:users:trial:sc:([0-9a-f-]+)$/, async (ctx) => {
  await startBarrierFlow(ctx, ctx.match[1], "cooldown_set");
});

trialManagementHandler.callbackQuery(/^admin:users:trial:dn:([0-9a-f-]+)$/, async (ctx) => {
  await startBarrierFlow(ctx, ctx.match[1], "denial_set");
});

async function confirmBarrier(
  ctx: BotContext,
  kind: "cooldown_set" | "denial_set",
): Promise<void> {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = takeDraft(ctx);
  if (
    draft === undefined ||
    draft.kind !== kind ||
    draft.untilIso === undefined ||
    draft.reason === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const input = {
    admin,
    userId: user.id,
    until: new Date(draft.untilIso),
    reason: draft.reason,
  };
  const outcome =
    kind === "cooldown_set"
      ? await setTrialCooldown(input)
      : await setTrialTemporaryDenial(input);
  await safeAnswerCallback(
    ctx,
    outcome.ok
      ? kind === "cooldown_set"
        ? COOLDOWN_SUCCESS_TEXT
        : DENIAL_SUCCESS_TEXT
      : outcome.error,
  );
  await renderTrialMain(ctx, user);
}

trialManagementHandler.callbackQuery(`${T}:scok`, async (ctx) => {
  await confirmBarrier(ctx, "cooldown_set");
});

trialManagementHandler.callbackQuery(`${T}:dnok`, async (ctx) => {
  await confirmBarrier(ctx, "denial_set");
});

// --- «مشاهده تاریخچه تست‌ها» --------------------------------------------------------------

async function renderHistory(ctx: BotContext, user: User, page: number): Promise<void> {
  const sid = userShortId(user);
  const pageData = await listTrialHistory(user.id, page);
  // Resolve the funding source of linked claims (null = default policy).
  const entitlementIds = [
    ...new Set(
      pageData.claims
        .map((claim) => claim.entitlementId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const entitlements =
    entitlementIds.length === 0
      ? []
      : await prisma.freeTrialEntitlement.findMany({
          where: { id: { in: entitlementIds } },
          select: { id: true, source: true },
        });
  const sourceById = new Map(entitlements.map((row) => [row.id, row.source as string]));

  const blocks = pageData.claims.map((claim) =>
    [
      "شناسه:",
      `<code>${claim.id.slice(0, 8)}</code>`,
      "",
      "پنل:",
      escapeHtml(claim.panel.name),
      "",
      "وضعیت:",
      CLAIM_STATUS_LABELS[claim.status] ?? claim.status,
      "",
      "نام اکانت:",
      claim.usernameSnapshot === null || claim.usernameSnapshot === ""
        ? EMPTY_VALUE_TEXT
        : escapeHtml(claim.usernameSnapshot),
      "",
      "تاریخ درخواست:",
      formatPersianDate(claim.createdAt),
      "",
      "تاریخ ساخت:",
      dateOrDash(claim.provisionedAt),
      "",
      "تاریخ انقضا:",
      dateOrDash(claim.expiresAt),
      "",
      "منبع سهمیه:",
      claim.entitlementId === null
        ? quotaSourceLabel(null)
        : quotaSourceLabel(sourceById.get(claim.entitlementId) ?? null),
    ].join("\n"),
  );
  const header = `تاریخچه تست‌های کاربر (${pageData.total})`;
  const text =
    pageData.total === 0
      ? `${header}\n\nموردی ثبت نشده است.`
      : `${header}\n\n${blocks.join("\n\n➖➖➖➖➖\n\n")}`;

  const kb = new InlineKeyboard();
  // Force-resolution buttons: OWNER only, and only for undecided claims.
  if (isOwner(ctx)) {
    for (const claim of pageData.claims) {
      if (!FORCE_RESOLVABLE_STATUSES.includes(claim.status)) {
        continue;
      }
      const cid = claim.id.slice(0, 8);
      kb.text(`${cid} | تطبیق مجدد با پنل`, `${T}:rec:${sid}:${cid}`).row();
      kb.text(`${cid} | تایید ساخته‌شدن تست`, `${T}:fc:${sid}:${cid}`).row();
      kb.text(`${cid} | تایید ساخته‌نشدن تست`, `${T}:fn:${sid}:${cid}`).row();
      kb.text(`${cid} | لغو و آزادسازی سهمیه`, `${T}:fn:${sid}:${cid}`).row();
    }
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", `${T}:hist:${sid}:${pageData.page - 1}`);
    }
    kb.text(`${pageData.page}/${pageData.pages}`, `${T}:hist:${sid}:${pageData.page}`);
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", `${T}:hist:${sid}:${pageData.page + 1}`);
    }
    kb.row();
  }
  kb.text("بازگشت", `${T}:${sid}`);
  await safeEditOrReply(ctx, text, kb, HTML);
}

trialManagementHandler.callbackQuery(
  /^admin:users:trial:hist:([0-9a-f-]+):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const user = await getAdminTargetUserByShortId(ctx.match[1]);
    if (user === null) {
      await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
      return;
    }
    await safeAnswerCallback(ctx);
    await renderHistory(ctx, user, Number.parseInt(ctx.match[2], 10));
  },
);

// «تطبیق مجدد با پنل» - runs the reconciler and toasts the outcome (OWNER).
trialManagementHandler.callbackQuery(
  /^admin:users:trial:rec:([0-9a-f-]+):([0-9a-f-]+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    if (!isOwner(ctx)) {
      await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
      return;
    }
    const user = await getAdminTargetUserByShortId(ctx.match[1]);
    if (user === null) {
      await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
      return;
    }
    const claim = await findClaimByShortId(user.id, ctx.match[2]);
    if (claim === null || !FORCE_RESOLVABLE_STATUSES.includes(claim.status)) {
      await safeAnswerCallback(ctx, FORCE_NOT_RESOLVABLE_TEXT);
      return;
    }
    const outcome = await reconcileTrialClaim(claim.id);
    await safeAnswerCallback(ctx, RECONCILE_OUTCOME_TEXTS[outcome]);
    await renderHistory(ctx, user, 1);
  },
);

// «تایید ساخته‌شدن تست» / «تایید ساخته‌نشدن تست» / «لغو و آزادسازی سهمیه» (OWNER):
// warning + mandatory reason + confirmation before anything is forced.
async function startForceFlow(
  ctx: BotContext,
  shortId: string,
  claimShortId: string,
  kind: "force_created" | "force_not_created",
): Promise<void> {
  if (ctx.admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const user = await getAdminTargetUserByShortId(shortId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  const claim = await findClaimByShortId(user.id, claimShortId);
  if (claim === null || !FORCE_RESOLVABLE_STATUSES.includes(claim.status)) {
    await safeAnswerCallback(ctx, FORCE_NOT_RESOLVABLE_TEXT);
    return;
  }
  clearTrialFlowState(ctx);
  ctx.session.temp.adminTrialActionDraft = {
    userId: user.id,
    kind,
    step: "reason",
    nonce: randomUUID(),
    claimId: claim.id,
  };
  ctx.session.currentFlow = FLOW_FORCE_REASON;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `${TRIAL_FORCE_WARNING_TEXT}\n\n${FORCE_REASON_PROMPT}`,
    cancelKeyboard(userShortId(user)),
  );
}

trialManagementHandler.callbackQuery(
  /^admin:users:trial:fc:([0-9a-f-]+):([0-9a-f-]+)$/,
  async (ctx) => {
    await startForceFlow(ctx, ctx.match[1], ctx.match[2], "force_created");
  },
);

trialManagementHandler.callbackQuery(
  /^admin:users:trial:fn:([0-9a-f-]+):([0-9a-f-]+)$/,
  async (ctx) => {
    await startForceFlow(ctx, ctx.match[1], ctx.match[2], "force_not_created");
  },
);

trialManagementHandler.callbackQuery(`${T}:fok`, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const draft = takeDraft(ctx);
  if (
    draft === undefined ||
    (draft.kind !== "force_created" && draft.kind !== "force_not_created") ||
    draft.claimId === undefined ||
    draft.reason === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const user = await getUserById(draft.userId);
  if (user === null) {
    await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
    return;
  }
  if (draft.kind === "force_created") {
    const outcome = await forceClaimCreated({
      admin,
      claimId: draft.claimId,
      reason: draft.reason,
    });
    await safeAnswerCallback(
      ctx,
      outcome.ok ? RECONCILE_OUTCOME_TEXTS[outcome.value] : outcome.error,
    );
  } else {
    const outcome = await forceClaimNotCreated({
      admin,
      claimId: draft.claimId,
      reason: draft.reason,
    });
    await safeAnswerCallback(ctx, outcome.ok ? FORCE_NOT_CREATED_SUCCESS_TEXT : outcome.error);
  }
  await renderHistory(ctx, user, 1);
});

// --- «مشاهده سرویس‌های تست» ----------------------------------------------------------------
// Read-only FREE_TRIAL services: username, status, converted marker, expiry.
// No subscription URLs, tokens or remote ids.

trialManagementHandler.callbackQuery(
  /^admin:users:trial:svc:([0-9a-f-]+):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const user = await getAdminTargetUserByShortId(ctx.match[1]);
    if (user === null) {
      await safeAnswerCallback(ctx, NOT_FOUND_TEXT);
      return;
    }
    const sid = userShortId(user);
    const where = { userId: user.id, source: "FREE_TRIAL" as const };
    const total = await prisma.service.count({ where });
    const pages = Math.max(1, Math.ceil(total / TRIAL_SERVICES_PAGE_SIZE));
    const page = Math.min(Math.max(1, Number.parseInt(ctx.match[2], 10)), pages);
    const services = await prisma.service.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * TRIAL_SERVICES_PAGE_SIZE,
      take: TRIAL_SERVICES_PAGE_SIZE,
      select: {
        username: true,
        status: true,
        convertedToPaidAt: true,
        expiresAt: true,
      },
    });
    await safeAnswerCallback(ctx);
    const lines = [`سرویس‌های تست کاربر (${total})`, ""];
    for (const service of services) {
      const expiry =
        service.expiresAt === null ? UNLIMITED_TEXT : formatPersianDate(service.expiresAt);
      lines.push(
        `• ${escapeHtml(service.username)} | ${serviceStatusLabel(service.status)} | انقضا: ${expiry}${
          service.convertedToPaidAt === null ? "" : ` | ${CONVERTED_MARKER_TEXT}`
        }`,
      );
    }
    if (services.length === 0) {
      lines.push("سرویس تستی ثبت نشده است.");
    }
    const kb = new InlineKeyboard();
    if (pages > 1) {
      if (page > 1) {
        kb.text("« قبلی", `${T}:svc:${sid}:${page - 1}`);
      }
      kb.text(`${page}/${pages}`, `${T}:svc:${sid}:${page}`);
      if (page < pages) {
        kb.text("بعدی »", `${T}:svc:${sid}:${page + 1}`);
      }
      kb.row();
    }
    kb.text("بازگشت", `${T}:${sid}`);
    await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
  },
);

// --- text inputs (all "admin_trial:*" flows) -----------------------------------------------

export const trialManagementTextHandler = new Composer<BotContext>();

trialManagementTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (ctx.admin === null || flow === null || !flow.startsWith(TRIAL_FLOW_PREFIX)) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearTrialFlowState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminTrialActionDraft;
  if (draft === undefined) {
    clearTrialFlowState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
    return;
  }
  const sid = draft.userId.slice(0, 8);
  const cancel = cancelKeyboard(sid);

  switch (flow) {
    case FLOW_GRANT_COUNT: {
      const count = parseAllowanceCount(text);
      if (count === null) {
        await safeReply(ctx, INVALID_COUNT_TEXT, cancel);
        return;
      }
      draft.count = count;
      draft.step = "expiry";
      ctx.session.currentFlow = null;
      await safeReply(
        ctx,
        GRANT_EXPIRY_PROMPT,
        new InlineKeyboard()
          .text(GRANT_EXPIRY_NONE_LABEL, `${T}:gexp:none`)
          .text(GRANT_EXPIRY_DAYS_LABEL, `${T}:gexp:days`)
          .row()
          .text("انصراف", `${T}:cxl:${sid}`),
      );
      return;
    }
    case FLOW_GRANT_DAYS: {
      const days = parseDayCount(text);
      if (days === null) {
        await safeReply(ctx, INVALID_DAYS_TEXT, cancel);
        return;
      }
      draft.expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
      draft.step = "reason";
      ctx.session.currentFlow = FLOW_GRANT_REASON;
      await safeReply(ctx, GRANT_REASON_PROMPT, cancel);
      return;
    }
    case FLOW_GRANT_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      ctx.session.currentFlow = null;
      await renderGrantConfirm(ctx, draft, sid);
      return;
    }
    case FLOW_SETREM_COUNT: {
      const desired = parseRemainingCount(text);
      if (desired === null) {
        await safeReply(ctx, INVALID_REMAINING_TEXT, cancel);
        return;
      }
      draft.desired = desired;
      draft.step = "reason";
      ctx.session.currentFlow = FLOW_SETREM_REASON;
      await safeReply(ctx, SETREM_REASON_PROMPT, cancel);
      return;
    }
    case FLOW_SETREM_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      ctx.session.currentFlow = null;
      const summary = await trialManagementSummary(draft.userId);
      const before = summary.remaining === null ? UNLIMITED_TEXT : String(summary.remaining);
      await safeReply(
        ctx,
        `تعداد تست باقی‌مانده کاربر از ${before} به ${draft.desired} تغییر کند؟`,
        confirmKeyboard(`${T}:srok`, sid),
      );
      return;
    }
    case FLOW_RESET_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      ctx.session.currentFlow = null;
      await safeReply(ctx, RESET_CONFIRM_TEXT, confirmKeyboard(`${T}:rsok`, sid));
      return;
    }
    case FLOW_REVOKE_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      ctx.session.currentFlow = null;
      await safeReply(ctx, REVOKE_CONFIRM_TEXT, confirmKeyboard(`${T}:rvok`, sid));
      return;
    }
    case FLOW_COOLDOWN_DAYS:
    case FLOW_DENIAL_DAYS: {
      const days = parseDayCount(text);
      if (days === null) {
        await safeReply(ctx, INVALID_DAYS_TEXT, cancel);
        return;
      }
      draft.untilIso = new Date(Date.now() + days * DAY_MS).toISOString();
      draft.step = "reason";
      const cooldown = flow === FLOW_COOLDOWN_DAYS;
      ctx.session.currentFlow = cooldown ? FLOW_COOLDOWN_REASON : FLOW_DENIAL_REASON;
      await safeReply(ctx, cooldown ? COOLDOWN_REASON_PROMPT : DENIAL_REASON_PROMPT, cancel);
      return;
    }
    case FLOW_COOLDOWN_REASON:
    case FLOW_DENIAL_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      if (draft.untilIso === undefined) {
        clearTrialFlowState(ctx);
        await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      const cooldown = flow === FLOW_COOLDOWN_REASON;
      ctx.session.currentFlow = null;
      const untilLabel = formatPersianDate(new Date(draft.untilIso));
      await safeReply(
        ctx,
        cooldown
          ? `دریافت تست کاربر تا تاریخ ${untilLabel} محدود شود؟`
          : `دسترسی تست کاربر تا تاریخ ${untilLabel} مسدود شود؟`,
        confirmKeyboard(cooldown ? `${T}:scok` : `${T}:dnok`, sid),
      );
      return;
    }
    case FLOW_FORCE_REASON: {
      const reason = normalizeReason(text);
      if (reason === null) {
        await safeReply(ctx, INVALID_REASON_TEXT, cancel);
        return;
      }
      if (
        (draft.kind !== "force_created" && draft.kind !== "force_not_created") ||
        draft.claimId === undefined
      ) {
        clearTrialFlowState(ctx);
        await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
        return;
      }
      draft.reason = reason;
      draft.step = "confirm";
      ctx.session.currentFlow = null;
      const title =
        draft.kind === "force_created"
          ? "تایید ساخته‌شدن تست"
          : "تایید ساخته‌نشدن تست و آزادسازی سهمیه";
      await safeReply(
        ctx,
        `${TRIAL_FORCE_WARNING_TEXT}\n\n${title} برای درخواست ${draft.claimId.slice(0, 8)} انجام شود؟`,
        confirmKeyboard(`${T}:fok`, sid),
      );
      return;
    }
    default: {
      // Unknown admin_trial flow value - drop the stale state.
      clearTrialFlowState(ctx);
      await safeReply(ctx, DRAFT_EXPIRED_TEXT, usersLandingKeyboard());
      return;
    }
  }
});
