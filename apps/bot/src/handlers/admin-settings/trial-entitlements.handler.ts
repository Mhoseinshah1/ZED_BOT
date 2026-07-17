import {
  FreeTrialCampaignRecipientStatus,
  FreeTrialClaimStatus,
  FreeTrialEntitlementStatus,
  FreeTrialResetCampaignStatus,
  prisma,
  type FreeTrialResetCampaign,
} from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import type { SessionData } from "../../core/session.js";
import {
  normalizeDigits,
  parseAllowanceCount,
  TRIAL_BULK_GRANT_MAX_USERS,
  TRIAL_GRANT_MAX_PER_OPERATION,
} from "../../services/free-trial-admin.service.js";
import {
  CAMPAIGN_AUDIENCE_LABELS,
  CAMPAIGN_TYPED_CONFIRMATION,
  cancelCampaign,
  createCampaignDraft,
  getCampaignByShortId,
  listCampaigns,
  previewCampaign,
  startCampaign,
  type CampaignAudience,
} from "../../services/free-trial-campaign.service.js";
import { formatPersianDate } from "../../services/free-trial-entitlement.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { SEARCH_PROMPT_TEXT, searchCancelKeyboard } from "../admin-users/admin-users-views.js";

// =============================================================================
// Trial-entitlement phase: OWNER-only campaign builder («کمپین ریست اکانت
// تست») and quota/reset dashboard («مدیریت سهمیه‌ها و ریست‌ها»), both under
// پنل ادمین -> تنظیمات عمومی -> تنظیمات اکانت تست. The builder collects the
// draft in the session (audience -> allowance -> expiry -> notification ->
// include-with-allowance -> reason), persists it via createCampaignDraft +
// previewCampaign, and only after the exact typed confirmation ("RESET
// TRIAL") flips it to QUEUED via the CAS-guarded startCampaign - the
// in-bot loop does ALL processing; nothing here grants entitlements
// directly. The dashboard is indexed metrics only (counts / groupBy) - no
// full-table per-user scans and never credentials, tokens or URLs.
// =============================================================================

const CAMPAIGN_FLOW = "admin_trialent:campaign";

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";

/** Same OWNER gate copy as the trial-settings page (local, no RBAC yet). */
const OWNER_ONLY_TOAST = "دسترسی به این بخش فقط برای مالک مجموعه فعال است.";

// --- stable callback identifiers (namespace admin:trialent:) ---------------------------------

/** Trial-settings page entry: campaign builder start. */
export const TRIAL_ENT_CAMPAIGN_START_CB = "admin:trialent:camp:new";
/** Trial-settings page entry: quota/reset dashboard. */
export const TRIAL_ENT_DASHBOARD_CB = "admin:trialent:dash";

/** Back target: the trial-settings page owned by text-settings.handler.ts
 * (hardcoded string to keep this module dependency-free of its mounter). */
const TRIAL_SETTINGS_ROOT_CB = "admin:trial_settings";

const TE_CB = {
  dash: TRIAL_ENT_DASHBOARD_CB,
  search: "admin:trialent:search",
  expiring: (page: number): string => `admin:trialent:exp:${page}`,
  review: (page: number): string => `admin:trialent:rev:${page}`,
  camps: (page: number): string => `admin:trialent:camps:${page}`,
  campNew: TRIAL_ENT_CAMPAIGN_START_CB,
  campAudience: (kind: string): string => `admin:trialent:camp:aud:${kind}`,
  campExpiryNone: "admin:trialent:camp:exp:none",
  campExpiryDays: "admin:trialent:camp:exp:days",
  campNotify: (choice: "yes" | "no"): string => `admin:trialent:camp:notify:${choice}`,
  campInclude: (choice: "yes" | "no"): string => `admin:trialent:camp:inc:${choice}`,
  campPreview: "admin:trialent:camp:preview",
  campStartAsk: "admin:trialent:camp:startask",
  campTyped: "admin:trialent:camp:typed",
  campEdit: "admin:trialent:camp:edit",
  campAbort: "admin:trialent:camp:abort",
  campView: (sid: string): string => `admin:trialent:camp:v:${sid}`,
  campSkips: (sid: string, page: number): string => `admin:trialent:camp:sk:${sid}:${page}`,
  campFails: (sid: string, page: number): string => `admin:trialent:camp:fl:${sid}:${page}`,
  campCancelAsk: (sid: string): string => `admin:trialent:camp:cx:${sid}`,
  campCancelYes: (sid: string): string => `admin:trialent:camp:cx:${sid}:yes`,
} as const;

// --- Persian labels / prompts (module constants) ----------------------------------------------

const CAMPAIGN_STATUS_LABELS: Record<FreeTrialResetCampaignStatus, string> = {
  DRAFT: "پیش‌نویس",
  PREVIEWED: "پیش‌نمایش",
  QUEUED: "در صف اجرا",
  RUNNING: "در حال اجرا",
  COMPLETED: "تکمیل‌شده",
  FAILED: "ناموفق",
  CANCELLED: "لغوشده",
};

const CLAIM_STATUS_LABELS: Record<FreeTrialClaimStatus, string> = {
  CLAIMED: "ثبت‌شده",
  PROVISIONING: "در حال ساخت",
  ACTIVE: "فعال",
  FAILED: "ناموفق",
  EXPIRED: "منقضی‌شده",
  CANCELLED: "لغوشده",
  MANUAL_REVIEW: "بررسی دستی",
};

/** Safe Persian label per recipient skip marker (raw marker as fallback). */
const SKIP_REASON_LABELS: Record<string, string> = {
  "user-not-active": "کاربر فعال نیست",
  "claim-in-progress": "درخواست تست در حال پردازش دارد",
  "active-trial": "تست فعال دارد",
  "has-allowance": "سهمیه استفاده‌نشده دارد",
};

const AUDIENCE_PAGE_TEXT = "کمپین ریست اکانت تست 🎁\n\nمخاطبان کمپین را انتخاب کنید:";
const DATE_PROMPT_TEXT =
  "تاریخ را با ساختار YYYY-MM-DD ارسال کنید. (نمونه: 2024-01-01)";
const DATE_INVALID_TEXT =
  "تاریخ نامعتبر است. تاریخ را با ساختار YYYY-MM-DD ارسال کنید. (نمونه: 2024-01-01)";
const USERS_PROMPT_TEXT =
  `آیدی عددی تلگرام کاربران را ارسال کنید؛ هر آیدی در یک سطر جدا.\n(حداکثر ${TRIAL_BULK_GRANT_MAX_USERS} سطر)`;
const USERS_TOO_MANY_TEXT =
  `تعداد سطرها بیش از حد مجاز است؛ حداکثر ${TRIAL_BULK_GRANT_MAX_USERS} شناسه در هر کمپین قابل ارسال است.`;
const USERS_NONE_FOUND_TEXT = "هیچ کاربری با این شناسه‌ها یافت نشد. دوباره تلاش کنید.";
const ALLOWANCE_PROMPT_TEXT =
  `تعداد تست جدید برای هر کاربر را وارد کنید. (عددی بین 1 تا ${TRIAL_GRANT_MAX_PER_OPERATION})`;
const ALLOWANCE_INVALID_TEXT =
  `تعداد باید عددی بین 1 تا ${TRIAL_GRANT_MAX_PER_OPERATION} باشد.`;
const EXPIRY_CHOICE_TEXT = "تاریخ انقضای سهمیه را مشخص کنید:";
const DAYS_PROMPT_TEXT = "تعداد روز اعتبار سهمیه را وارد کنید. (نمونه: 30)";
const DAYS_INVALID_TEXT = "تعداد روز باید عددی بین 1 تا 3650 باشد.";
const EXPIRY_MAX_DAYS = 3650;
const NOTIFY_CHOICE_TEXT = "ارسال پیام اطلاع‌رسانی به کاربران را مشخص کنید:";
const INCLUDE_CHOICE_TEXT =
  "رفتار کمپین با کاربران دارای سهمیه استفاده‌نشده را مشخص کنید:";
const REASON_PROMPT_TEXT = "دلیل این کمپین را وارد کنید. (الزامی - در تاریخچه ثبت می‌شود)";
const REASON_REQUIRED_TEXT = "دلیل الزامی است. دلیل این کمپین را وارد کنید.";
const FINAL_CONFIRM_TEXT =
  "این عملیات برای تعداد زیادی کاربر سهمیه تست ایجاد می‌کند و قابل حذف از تاریخچه نیست.\n\nآیا ادامه می‌دهید؟";
const TYPED_PROMPT_TEXT = "برای تایید، عبارت RESET TRIAL را ارسال کنید.";
const TYPED_MISMATCH_TEXT =
  "عبارت ارسال‌شده صحیح نیست.\n\nبرای تایید، عبارت RESET TRIAL را ارسال کنید.";
const CAMPAIGN_ABORTED_TOAST = "فرآیند کمپین لغو شد.";
const CAMPAIGN_CANCELLED_TOAST = "کمپین لغو شد.";
const CAMPAIGN_NOT_CANCELLABLE_TOAST = "این کمپین قابل لغو نیست.";
const CANCEL_CONFIRM_TEXT =
  "آیا از لغو این کمپین مطمئن هستید؟\n\nسهمیه‌های اعطاشده تاکنون حذف نمی‌شوند.";
const LIST_EMPTY_TEXT = "موردی ثبت نشده است.";

// --- session helpers -----------------------------------------------------------------------------

type CampaignDraft = NonNullable<SessionData["temp"]["adminTrialCampaignDraft"]>;

/** Clears this module's flow + campaign draft (never other drafts). */
function clearTrialEntitlementsState(ctx: BotContext): void {
  if (ctx.session.currentFlow?.startsWith("admin_trialent:") === true) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminTrialCampaignDraft;
}

/**
 * OWNER gate - same local idiom as the trial-settings page (centralized
 * RBAC is a documented separate task). Any active non-OWNER admin gets only
 * the safe toast and never any campaign/quota data.
 */
async function requireOwner(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (ctx.admin.role === "OWNER") {
    return true;
  }
  await safeAnswerCallback(ctx, OWNER_ONLY_TOAST);
  return false;
}

// --- shared render helpers -------------------------------------------------------------------------

const LIST_PAGE_SIZE = 10;
const EXPIRING_WINDOW_MS = 7 * 86_400_000;
const REVIEW_MIN_AGE_MS = 15 * 60_000;

/** Date-only Persian display for compact list rows. */
function formatPersianDateOnly(date: Date): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Appends the standard «« قبلی | p/pages | بعدی »» row when needed. */
function appendPager(
  kb: InlineKeyboard,
  page: number,
  pages: number,
  cb: (page: number) => string,
): void {
  if (pages <= 1) {
    return;
  }
  if (page > 1) {
    kb.text("« قبلی", cb(page - 1));
  }
  kb.text(`${page}/${pages}`, cb(page));
  if (page < pages) {
    kb.text("بعدی »", cb(page + 1));
  }
  kb.row();
}

function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, page), pages);
}

/** «انصراف» keyboard for every builder text prompt. */
function wizardCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("انصراف", TE_CB.campAbort);
}

// --- campaign builder pages ------------------------------------------------------------------------

const AUDIENCE_KINDS: CampaignAudience["kind"][] = [
  "ALL_ACTIVE",
  "WITHOUT_ACTIVE_TRIAL",
  "WITH_PREVIOUS_TRIAL",
  "WITHOUT_SUCCESSFUL_PURCHASE",
  "WITH_SUCCESSFUL_PURCHASE",
  "REGISTERED_BEFORE",
  "REGISTERED_AFTER",
  "SELECTED_USERS",
];

function isAudienceKind(value: string): value is CampaignAudience["kind"] {
  return (AUDIENCE_KINDS as string[]).includes(value);
}

function audiencePageKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const kind of AUDIENCE_KINDS) {
    kb.text(CAMPAIGN_AUDIENCE_LABELS[kind], TE_CB.campAudience(kind)).row();
  }
  kb.text("انصراف", TE_CB.campAbort);
  return kb;
}

/** Rebuilds the typed audience from the session draft (null = expired). */
function buildAudienceFromDraft(draft: CampaignDraft): CampaignAudience | null {
  const kind = draft.audienceKind;
  if (kind === undefined || !isAudienceKind(kind)) {
    return null;
  }
  switch (kind) {
    case "REGISTERED_BEFORE":
    case "REGISTERED_AFTER":
      return draft.audienceDate === undefined ? null : { kind, date: draft.audienceDate };
    case "SELECTED_USERS":
      return draft.selectedUserIds === undefined || draft.selectedUserIds.length === 0
        ? null
        : { kind, userIds: draft.selectedUserIds };
    default:
      return { kind };
  }
}

function expiryChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("بدون تاریخ انقضا", TE_CB.campExpiryNone)
    .row()
    .text("اعتبار برای چند روز", TE_CB.campExpiryDays)
    .row()
    .text("انصراف", TE_CB.campAbort);
}

function notifyChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("بدون ارسال پیام", TE_CB.campNotify("no"))
    .row()
    .text("ارسال پیام به کاربر", TE_CB.campNotify("yes"))
    .row()
    .text("انصراف", TE_CB.campAbort);
}

function includeChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("رد شدن کاربران دارای سهمیه", TE_CB.campInclude("no"))
    .row()
    .text("شامل شدن کاربران دارای سهمیه", TE_CB.campInclude("yes"))
    .row()
    .text("انصراف", TE_CB.campAbort);
}

/** Preview page (task-mandated lines verbatim + the allowance-rule line). */
function campaignPreviewText(campaign: FreeTrialResetCampaign, estimated: number): string {
  return [
    "🎁 پیش‌نمایش کمپین ریست تست",
    "",
    "مخاطبان تخمینی:",
    String(estimated),
    "",
    "تعداد تست جدید برای هر کاربر:",
    String(campaign.allowance),
    "",
    "کاربران دارای تست فعال:",
    "رد می‌شوند",
    "",
    "کاربران دارای سهمیه استفاده‌نشده:",
    campaign.includeUsersWithAllowance ? "شامل می‌شوند" : "رد می‌شوند",
    "",
    "کاربران مسدود:",
    "رد می‌شوند",
    "",
    "تاریخ انقضای سهمیه:",
    campaign.expiresAt === null ? "بدون تاریخ انقضا" : formatPersianDate(campaign.expiresAt),
    "",
    "دلیل:",
    campaign.reason,
  ].join("\n");
}

function campaignPreviewKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("شروع کمپین ✅", TE_CB.campStartAsk)
    .row()
    .text("ویرایش تنظیمات", TE_CB.campEdit)
    .row()
    .text("لغو", TE_CB.campAbort)
    .row()
    .text("بازگشت", TRIAL_SETTINGS_ROOT_CB);
}

// --- campaign detail / result page -------------------------------------------------------------------

const CANCELLABLE_STATUSES: FreeTrialResetCampaignStatus[] = [
  FreeTrialResetCampaignStatus.DRAFT,
  FreeTrialResetCampaignStatus.PREVIEWED,
  FreeTrialResetCampaignStatus.QUEUED,
  FreeTrialResetCampaignStatus.RUNNING,
];

function campaignDetailText(campaign: FreeTrialResetCampaign): string {
  return [
    "کمپین ریست اکانت تست",
    "",
    "وضعیت:",
    CAMPAIGN_STATUS_LABELS[campaign.status],
    "",
    "کل مخاطبان:",
    String(campaign.totalUsers ?? campaign.estimatedUsers ?? 0),
    "",
    "سهمیه اضافه‌شده:",
    String(campaign.grantedUsers),
    "",
    "ردشده:",
    String(campaign.skippedUsers),
    "",
    "ناموفق:",
    String(campaign.failedUsers),
    "",
    "پردازش‌شده:",
    String(campaign.processedUsers),
  ].join("\n");
}

function campaignDetailKeyboard(campaign: FreeTrialResetCampaign): InlineKeyboard {
  const sid = campaign.id.slice(0, 8);
  const kb = new InlineKeyboard()
    .text("بروزرسانی ♻️", TE_CB.campView(sid))
    .row()
    .text("مشاهده موارد ردشده", TE_CB.campSkips(sid, 1))
    .row()
    .text("مشاهده خطاها", TE_CB.campFails(sid, 1))
    .row();
  if (CANCELLABLE_STATUSES.includes(campaign.status)) {
    kb.text("لغو کمپین", TE_CB.campCancelAsk(sid)).row();
  }
  return kb.text("کمپین‌ها", TE_CB.camps(1)).row().text("بازگشت", TE_CB.dash);
}

// --- dashboard (indexed metrics only) ----------------------------------------------------------------

interface TrialDashboardMetrics {
  activeGrantCount: number;
  activeGrantUserCount: number;
  expiringSoonCount: number;
  claimCounts: { status: FreeTrialClaimStatus; count: number }[];
  convertedServiceCount: number;
  runningCampaignCount: number;
  completedCampaignCount: number;
  failedRecipientCount: number;
}

function expiringSoonWhere(now: Date): {
  status: FreeTrialEntitlementStatus;
  expiresAt: { gt: Date; lt: Date };
} {
  return {
    status: FreeTrialEntitlementStatus.ACTIVE,
    expiresAt: { gt: now, lt: new Date(now.getTime() + EXPIRING_WINDOW_MS) },
  };
}

const CLAIM_STATUS_ORDER: FreeTrialClaimStatus[] = [
  FreeTrialClaimStatus.CLAIMED,
  FreeTrialClaimStatus.PROVISIONING,
  FreeTrialClaimStatus.ACTIVE,
  FreeTrialClaimStatus.MANUAL_REVIEW,
  FreeTrialClaimStatus.EXPIRED,
  FreeTrialClaimStatus.FAILED,
  FreeTrialClaimStatus.CANCELLED,
];

/** Aggregate/groupBy counts only - never a per-user table scan. */
async function collectDashboardMetrics(): Promise<TrialDashboardMetrics> {
  const now = new Date();
  const [
    activeGrantCount,
    activeGrantUsers,
    expiringSoonCount,
    claimsByStatus,
    convertedServiceCount,
    campaignsByStatus,
    failedRecipientCount,
  ] = await Promise.all([
    prisma.freeTrialEntitlement.count({
      where: { status: FreeTrialEntitlementStatus.ACTIVE },
    }),
    prisma.freeTrialEntitlement.groupBy({
      by: ["userId"],
      where: { status: FreeTrialEntitlementStatus.ACTIVE },
      _count: { _all: true },
    }),
    prisma.freeTrialEntitlement.count({ where: expiringSoonWhere(now) }),
    prisma.freeTrialClaim.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.service.count({
      where: { source: "FREE_TRIAL", convertedToPaidAt: { not: null } },
    }),
    prisma.freeTrialResetCampaign.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.freeTrialCampaignRecipient.count({
      where: { status: FreeTrialCampaignRecipientStatus.FAILED },
    }),
  ]);
  const claimCount = (status: FreeTrialClaimStatus): number =>
    claimsByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const campaignCount = (status: FreeTrialResetCampaignStatus): number =>
    campaignsByStatus.find((row) => row.status === status)?._count._all ?? 0;
  return {
    activeGrantCount,
    activeGrantUserCount: activeGrantUsers.length,
    expiringSoonCount,
    claimCounts: CLAIM_STATUS_ORDER.map((status) => ({ status, count: claimCount(status) })),
    convertedServiceCount,
    runningCampaignCount:
      campaignCount(FreeTrialResetCampaignStatus.QUEUED) +
      campaignCount(FreeTrialResetCampaignStatus.RUNNING),
    completedCampaignCount: campaignCount(FreeTrialResetCampaignStatus.COMPLETED),
    failedRecipientCount,
  };
}

function dashboardText(metrics: TrialDashboardMetrics): string {
  const lines = [
    "مدیریت سهمیه‌ها و ریست‌ها 🎁",
    "",
    "سهمیه‌های فعال:",
    String(metrics.activeGrantCount),
    "",
    "کاربران دارای سهمیه فعال:",
    String(metrics.activeGrantUserCount),
    "",
    "سهمیه‌های در حال انقضا (۷ روز آینده):",
    String(metrics.expiringSoonCount),
    "",
    "درخواست‌های تست به تفکیک وضعیت:",
    ...metrics.claimCounts.map(
      (row) => `${CLAIM_STATUS_LABELS[row.status]}: ${String(row.count)}`,
    ),
    "",
    "سرویس‌های تست تبدیل‌شده به خرید:",
    String(metrics.convertedServiceCount),
    "",
    "کمپین‌های در حال اجرا:",
    String(metrics.runningCampaignCount),
    "",
    "کمپین‌های تکمیل‌شده:",
    String(metrics.completedCampaignCount),
    "",
    "دریافت‌کنندگان ناموفق کمپین‌ها:",
    String(metrics.failedRecipientCount),
  ];
  return lines.join("\n");
}

function dashboardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("جستجوی کاربر", TE_CB.search)
    .row()
    .text("کمپین ریست تست", TE_CB.campNew)
    .row()
    .text("کمپین‌ها", TE_CB.camps(1))
    .row()
    .text("سهمیه‌های در حال انقضا", TE_CB.expiring(1))
    .row()
    .text("موارد نیازمند بررسی", TE_CB.review(1))
    .row()
    .text("بروزرسانی ♻️", TE_CB.dash)
    .row()
    .text("بازگشت", TRIAL_SETTINGS_ROOT_CB);
}

async function renderDashboard(ctx: BotContext, toast?: string): Promise<void> {
  clearTrialEntitlementsState(ctx);
  const metrics = await collectDashboardMetrics();
  await safeAnswerCallback(ctx, toast);
  await safeEditOrReply(ctx, dashboardText(metrics), dashboardKeyboard());
}

// --- composers ---------------------------------------------------------------------------------------

export const trialEntitlementsHandler = new Composer<BotContext>();
export const trialEntitlementsTextHandler = new Composer<BotContext>();

// --- dashboard routes ----------------------------------------------------------------------------------

trialEntitlementsHandler.callbackQuery(TE_CB.dash, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  logger.info("trial quota dashboard viewed", {
    adminId: admin.id,
    action: "trial-entitlement-dashboard-view",
  });
  await renderDashboard(ctx);
});

// «جستجوی کاربر» - reuses the existing admin-users search flow verbatim.
trialEntitlementsHandler.callbackQuery(TE_CB.search, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  ctx.session.currentFlow = "admin_users:search";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, SEARCH_PROMPT_TEXT, searchCancelKeyboard());
});

// «سهمیه‌های در حال انقضا» - ACTIVE grants expiring inside the 7-day window.
trialEntitlementsHandler.callbackQuery(/^admin:trialent:exp:(\d+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  const where = expiringSoonWhere(new Date());
  const total = await prisma.freeTrialEntitlement.count({ where });
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = clampPage(Number.parseInt(ctx.match[1], 10), pages);
  const rows = await prisma.freeTrialEntitlement.findMany({
    where,
    orderBy: { expiresAt: "asc" },
    skip: (page - 1) * LIST_PAGE_SIZE,
    take: LIST_PAGE_SIZE,
    include: { user: { select: { telegramId: true } } },
  });
  const blocks = [`سهمیه‌های در حال انقضا (۷ روز آینده) — ${total} مورد`];
  if (rows.length === 0) {
    blocks.push("", LIST_EMPTY_TEXT);
  }
  for (const row of rows) {
    blocks.push(
      "",
      [
        `کاربر ${row.user.telegramId.toString()}`,
        `باقی‌مانده: ${String(Math.max(0, row.allowance - row.consumed))}`,
        `انقضا: ${row.expiresAt === null ? "-" : formatPersianDate(row.expiresAt)}`,
      ].join("\n"),
    );
  }
  const kb = new InlineKeyboard();
  appendPager(kb, page, pages, TE_CB.expiring);
  kb.text("بازگشت", TE_CB.dash);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, blocks.join("\n"), kb);
});

// «موارد نیازمند بررسی» - MANUAL_REVIEW + PROVISIONING claims older than 15m.
trialEntitlementsHandler.callbackQuery(/^admin:trialent:rev:(\d+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  const where = {
    status: {
      in: [FreeTrialClaimStatus.MANUAL_REVIEW, FreeTrialClaimStatus.PROVISIONING],
    },
    createdAt: { lt: new Date(Date.now() - REVIEW_MIN_AGE_MS) },
  };
  const total = await prisma.freeTrialClaim.count({ where });
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = clampPage(Number.parseInt(ctx.match[1], 10), pages);
  const rows = await prisma.freeTrialClaim.findMany({
    where,
    orderBy: { createdAt: "asc" },
    skip: (page - 1) * LIST_PAGE_SIZE,
    take: LIST_PAGE_SIZE,
    include: {
      panel: { select: { name: true } },
      user: { select: { telegramId: true } },
    },
  });
  const blocks = [`موارد نیازمند بررسی 🔎 — ${total} مورد`];
  if (rows.length === 0) {
    blocks.push("", LIST_EMPTY_TEXT);
  }
  for (const claim of rows) {
    blocks.push(
      "",
      [
        `درخواست ${claim.id.slice(0, 8)}`,
        `پنل: ${claim.panel.name}`,
        `کاربر ${claim.user.telegramId.toString()}`,
        `وضعیت: ${CLAIM_STATUS_LABELS[claim.status]}`,
      ].join("\n"),
    );
  }
  const kb = new InlineKeyboard();
  appendPager(kb, page, pages, TE_CB.review);
  kb.text("بازگشت", TE_CB.dash);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, blocks.join("\n"), kb);
});

// --- campaigns list / detail -----------------------------------------------------------------------------

trialEntitlementsHandler.callbackQuery(/^admin:trialent:camps:(\d+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  const data = await listCampaigns(Number.parseInt(ctx.match[1], 10));
  const kb = new InlineKeyboard();
  for (const campaign of data.campaigns) {
    kb.text(
      `${campaign.id.slice(0, 8)} | ${CAMPAIGN_STATUS_LABELS[campaign.status]} | ${formatPersianDateOnly(campaign.createdAt)}`,
      TE_CB.campView(campaign.id.slice(0, 8)),
    ).row();
  }
  appendPager(kb, data.page, data.pages, TE_CB.camps);
  kb.text("بازگشت", TE_CB.dash);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    data.total === 0 ? "کمپین‌ها 🎁\n\nکمپینی ثبت نشده است." : `کمپین‌ها 🎁 — ${data.total} مورد`,
    kb,
  );
});

trialEntitlementsHandler.callbackQuery(/^admin:trialent:camp:v:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  const campaign = await getCampaignByShortId(ctx.match[1]);
  if (campaign === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, campaignDetailText(campaign), campaignDetailKeyboard(campaign));
});

/** Shared renderer for the SKIPPED / FAILED recipient pages. */
async function renderRecipientsPage(
  ctx: BotContext,
  campaign: FreeTrialResetCampaign,
  kind: "skipped" | "failed",
  rawPage: number,
): Promise<void> {
  const sid = campaign.id.slice(0, 8);
  const status =
    kind === "skipped"
      ? FreeTrialCampaignRecipientStatus.SKIPPED
      : FreeTrialCampaignRecipientStatus.FAILED;
  const where = { campaignId: campaign.id, status };
  const total = await prisma.freeTrialCampaignRecipient.count({ where });
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = clampPage(rawPage, pages);
  const rows = await prisma.freeTrialCampaignRecipient.findMany({
    where,
    orderBy: { createdAt: "asc" },
    skip: (page - 1) * LIST_PAGE_SIZE,
    take: LIST_PAGE_SIZE,
    include: { user: { select: { telegramId: true } } },
  });
  const title =
    kind === "skipped"
      ? `موارد ردشده کمپین ${sid} — ${total} مورد`
      : `خطاهای کمپین ${sid} — ${total} مورد`;
  const blocks = [title];
  if (rows.length === 0) {
    blocks.push("", LIST_EMPTY_TEXT);
  }
  for (const recipient of rows) {
    const detail =
      kind === "skipped"
        ? (SKIP_REASON_LABELS[recipient.skipReason ?? ""] ?? recipient.skipReason ?? "-")
        : (recipient.errorMessage ?? "-").slice(0, 150);
    blocks.push("", `کاربر ${recipient.user.telegramId.toString()}\n${detail}`);
  }
  const pageCb =
    kind === "skipped"
      ? (p: number): string => TE_CB.campSkips(sid, p)
      : (p: number): string => TE_CB.campFails(sid, p);
  const kb = new InlineKeyboard();
  appendPager(kb, page, pages, pageCb);
  kb.text("بازگشت", TE_CB.campView(sid));
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, blocks.join("\n"), kb);
}

trialEntitlementsHandler.callbackQuery(
  /^admin:trialent:camp:sk:([0-9a-f-]+):(\d+)$/,
  async (ctx) => {
    const admin = ctx.admin;
    if (admin === null || !(await requireOwner(ctx))) {
      return;
    }
    const campaign = await getCampaignByShortId(ctx.match[1]);
    if (campaign === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    await renderRecipientsPage(ctx, campaign, "skipped", Number.parseInt(ctx.match[2], 10));
  },
);

trialEntitlementsHandler.callbackQuery(
  /^admin:trialent:camp:fl:([0-9a-f-]+):(\d+)$/,
  async (ctx) => {
    const admin = ctx.admin;
    if (admin === null || !(await requireOwner(ctx))) {
      return;
    }
    const campaign = await getCampaignByShortId(ctx.match[1]);
    if (campaign === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    await renderRecipientsPage(ctx, campaign, "failed", Number.parseInt(ctx.match[2], 10));
  },
);

// «لغو کمپین» - explicit confirmation, then the CAS-guarded cancelCampaign.
trialEntitlementsHandler.callbackQuery(
  /^admin:trialent:camp:cx:([0-9a-f-]+)$/,
  async (ctx) => {
    const admin = ctx.admin;
    if (admin === null || !(await requireOwner(ctx))) {
      return;
    }
    const campaign = await getCampaignByShortId(ctx.match[1]);
    if (campaign === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const sid = campaign.id.slice(0, 8);
    if (!CANCELLABLE_STATUSES.includes(campaign.status)) {
      await safeAnswerCallback(ctx, CAMPAIGN_NOT_CANCELLABLE_TOAST);
      await safeEditOrReply(ctx, campaignDetailText(campaign), campaignDetailKeyboard(campaign));
      return;
    }
    await safeAnswerCallback(ctx);
    await safeEditOrReply(
      ctx,
      CANCEL_CONFIRM_TEXT,
      new InlineKeyboard()
        .text("بله، لغو کمپین", TE_CB.campCancelYes(sid))
        .row()
        .text("انصراف", TE_CB.campView(sid)),
    );
  },
);

trialEntitlementsHandler.callbackQuery(
  /^admin:trialent:camp:cx:([0-9a-f-]+):yes$/,
  async (ctx) => {
    const admin = ctx.admin;
    if (admin === null || !(await requireOwner(ctx))) {
      return;
    }
    const campaign = await getCampaignByShortId(ctx.match[1]);
    if (campaign === null) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const cancelled = await cancelCampaign(campaign.id, admin);
    logger.info("trial campaign cancel requested", {
      adminId: admin.id,
      campaignId: campaign.id,
      result: cancelled ? "cancelled" : "not-cancellable",
    });
    const fresh = (await getCampaignByShortId(ctx.match[1])) ?? campaign;
    await safeAnswerCallback(
      ctx,
      cancelled ? CAMPAIGN_CANCELLED_TOAST : CAMPAIGN_NOT_CANCELLABLE_TOAST,
    );
    await safeEditOrReply(ctx, campaignDetailText(fresh), campaignDetailKeyboard(fresh));
  },
);

// --- campaign builder routes -------------------------------------------------------------------------

// Step 1 entry: «کمپین ریست اکانت تست» - fresh draft + audience selection.
trialEntitlementsHandler.callbackQuery(TE_CB.campNew, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  clearTrialEntitlementsState(ctx);
  ctx.session.temp.adminTrialCampaignDraft = { step: "audience" };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, AUDIENCE_PAGE_TEXT, audiencePageKeyboard());
});

trialEntitlementsHandler.callbackQuery(/^admin:trialent:camp:aud:([A-Z_]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const kind = ctx.match[1];
  if (!isAudienceKind(kind)) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  if (kind === "REGISTERED_BEFORE" || kind === "REGISTERED_AFTER") {
    ctx.session.temp.adminTrialCampaignDraft = { step: "audience_date", audienceKind: kind };
    ctx.session.currentFlow = CAMPAIGN_FLOW;
    await safeEditOrReply(ctx, DATE_PROMPT_TEXT, wizardCancelKeyboard());
    return;
  }
  if (kind === "SELECTED_USERS") {
    ctx.session.temp.adminTrialCampaignDraft = { step: "audience_users", audienceKind: kind };
    ctx.session.currentFlow = CAMPAIGN_FLOW;
    await safeEditOrReply(ctx, USERS_PROMPT_TEXT, wizardCancelKeyboard());
    return;
  }
  ctx.session.temp.adminTrialCampaignDraft = { step: "allowance", audienceKind: kind };
  ctx.session.currentFlow = CAMPAIGN_FLOW;
  await safeEditOrReply(ctx, ALLOWANCE_PROMPT_TEXT, wizardCancelKeyboard());
});

// Step 3: expiry choice.
trialEntitlementsHandler.callbackQuery(TE_CB.campExpiryNone, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft === undefined || draft.allowance === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  delete draft.expiresAt;
  draft.step = "notify";
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, NOTIFY_CHOICE_TEXT, notifyChoiceKeyboard());
});

trialEntitlementsHandler.callbackQuery(TE_CB.campExpiryDays, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft === undefined || draft.allowance === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.step = "expiry_days";
  ctx.session.currentFlow = CAMPAIGN_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, DAYS_PROMPT_TEXT, wizardCancelKeyboard());
});

// Step 4: notification choice.
trialEntitlementsHandler.callbackQuery(/^admin:trialent:camp:notify:(yes|no)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft === undefined || draft.allowance === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.notifyUsers = ctx.match[1] === "yes";
  draft.step = "include";
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, INCLUDE_CHOICE_TEXT, includeChoiceKeyboard());
});

// Step 5: include-users-with-allowance choice (OWNER decision), then reason.
trialEntitlementsHandler.callbackQuery(/^admin:trialent:camp:inc:(yes|no)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft === undefined || draft.allowance === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.includeUsersWithAllowance = ctx.match[1] === "yes";
  draft.step = "reason";
  ctx.session.currentFlow = CAMPAIGN_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, REASON_PROMPT_TEXT, wizardCancelKeyboard());
});

/** Re-renders the preview from the persisted campaign (recounts audience). */
async function renderPreviewFromDraft(ctx: BotContext): Promise<void> {
  const admin = ctx.admin;
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (admin === null || draft?.campaignId === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const previewed = await previewCampaign(draft.campaignId, admin);
  if (previewed === null) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.step = "preview";
  ctx.session.currentFlow = null;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    campaignPreviewText(previewed.campaign, previewed.estimated),
    campaignPreviewKeyboard(),
  );
}

trialEntitlementsHandler.callbackQuery(TE_CB.campPreview, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  await renderPreviewFromDraft(ctx);
});

// «شروع کمپین ✅» -> the mandated final warning, then the typed confirmation.
trialEntitlementsHandler.callbackQuery(TE_CB.campStartAsk, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft?.campaignId === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    FINAL_CONFIRM_TEXT,
    new InlineKeyboard()
      .text("ادامه ✅", TE_CB.campTyped)
      .row()
      .text("انصراف", TE_CB.campPreview),
  );
});

trialEntitlementsHandler.callbackQuery(TE_CB.campTyped, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft?.campaignId === undefined) {
    await renderDashboard(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.step = "confirm";
  ctx.session.currentFlow = CAMPAIGN_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    TYPED_PROMPT_TEXT,
    new InlineKeyboard().text("انصراف", TE_CB.campPreview),
  );
});

// «ویرایش تنظیمات» - cancel the persisted draft row and restart the wizard.
trialEntitlementsHandler.callbackQuery(TE_CB.campEdit, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft?.campaignId !== undefined) {
    // The old DRAFT/PREVIEWED row must not linger - cancel is CAS-guarded.
    await cancelCampaign(draft.campaignId, admin);
  }
  clearTrialEntitlementsState(ctx);
  ctx.session.temp.adminTrialCampaignDraft = { step: "audience" };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, AUDIENCE_PAGE_TEXT, audiencePageKeyboard());
});

// «لغو» / «انصراف» - abort the wizard (cancels the persisted draft, if any).
trialEntitlementsHandler.callbackQuery(TE_CB.campAbort, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null || !(await requireOwner(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft?.campaignId !== undefined) {
    await cancelCampaign(draft.campaignId, admin);
  }
  await renderDashboard(ctx, CAMPAIGN_ABORTED_TOAST);
});

// --- builder text flows ---------------------------------------------------------------------------------

/** Moves the wizard to the allowance prompt (after the audience step). */
async function askAllowance(ctx: BotContext, draft: CampaignDraft, notice?: string): Promise<void> {
  draft.step = "allowance";
  const text = notice === undefined ? ALLOWANCE_PROMPT_TEXT : `${notice}\n\n${ALLOWANCE_PROMPT_TEXT}`;
  await safeReply(ctx, text, wizardCancelKeyboard());
}

/** SELECTED_USERS input: trim/dedupe/validate, resolve by telegramId. */
async function handleSelectedUsersInput(
  ctx: BotContext,
  draft: CampaignDraft,
  text: string,
): Promise<void> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    await safeReply(ctx, USERS_PROMPT_TEXT, wizardCancelKeyboard());
    return;
  }
  if (lines.length > TRIAL_BULK_GRANT_MAX_USERS) {
    await safeReply(ctx, USERS_TOO_MANY_TEXT, wizardCancelKeyboard());
    return;
  }
  const ids = new Set<string>();
  let invalidCount = 0;
  for (const line of lines) {
    const normalized = normalizeDigits(line);
    if (/^\d{1,15}$/.test(normalized)) {
      ids.add(normalized);
    } else {
      invalidCount += 1;
    }
  }
  if (invalidCount > 0) {
    await safeReply(
      ctx,
      `${String(invalidCount)} سطر نامعتبر است. فقط آیدی عددی تلگرام، هر کدام در یک سطر جدا.`,
      wizardCancelKeyboard(),
    );
    return;
  }
  const users = await prisma.user.findMany({
    where: { telegramId: { in: [...ids].map((value) => BigInt(value)) } },
    select: { id: true, telegramId: true },
  });
  if (users.length === 0) {
    await safeReply(ctx, USERS_NONE_FOUND_TEXT, wizardCancelKeyboard());
    return;
  }
  const matched = new Set(users.map((user) => user.telegramId.toString()));
  const unmatched = [...ids].filter((value) => !matched.has(value));
  draft.selectedUserIds = users.map((user) => user.id);
  let notice = `${String(users.length)} کاربر شناسایی شد.`;
  if (unmatched.length > 0) {
    const sample = unmatched.slice(0, 5).join("، ");
    notice += `\n${String(unmatched.length)} شناسه یافت نشد (نمونه: ${sample}${unmatched.length > 5 ? "، ..." : ""})`;
  }
  await askAllowance(ctx, draft, notice);
}

/** Reason received: persist the draft row and show the mandated preview. */
async function handleReasonInput(
  ctx: BotContext,
  draft: CampaignDraft,
  text: string,
): Promise<void> {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const reason = text.trim();
  if (reason === "") {
    await safeReply(ctx, REASON_REQUIRED_TEXT, wizardCancelKeyboard());
    return;
  }
  const audience = buildAudienceFromDraft(draft);
  if (audience === null || draft.allowance === undefined) {
    clearTrialEntitlementsState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.reason = reason.slice(0, 500);
  const campaign = await createCampaignDraft({
    admin,
    allowance: draft.allowance,
    audience,
    reason: draft.reason,
    expiresAt: draft.expiresAt === undefined ? null : new Date(draft.expiresAt),
    notifyUsers: draft.notifyUsers ?? false,
    includeUsersWithAllowance: draft.includeUsersWithAllowance ?? false,
  });
  const previewed = await previewCampaign(campaign.id, admin);
  if (previewed === null) {
    clearTrialEntitlementsState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  draft.campaignId = campaign.id;
  draft.step = "preview";
  ctx.session.currentFlow = null;
  await safeReply(
    ctx,
    campaignPreviewText(previewed.campaign, previewed.estimated),
    campaignPreviewKeyboard(),
  );
}

/** Typed confirmation received: exact-match, then the CAS-guarded start. */
async function handleTypedConfirmation(ctx: BotContext, text: string): Promise<void> {
  const admin = ctx.admin;
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (admin === null || draft?.campaignId === undefined) {
    clearTrialEntitlementsState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  if (text.trim() !== CAMPAIGN_TYPED_CONFIRMATION) {
    await safeReply(
      ctx,
      TYPED_MISMATCH_TEXT,
      new InlineKeyboard().text("انصراف", TE_CB.campPreview),
    );
    return;
  }
  const campaignId = draft.campaignId;
  // Consume the draft BEFORE starting - a replayed confirmation can only hit
  // the CAS inside startCampaign, which makes the double confirm a no-op.
  clearTrialEntitlementsState(ctx);
  const started = await startCampaign(campaignId, admin);
  logger.info("trial campaign start confirmed", {
    adminId: admin.id,
    campaignId,
    result: started.ok ? "queued" : "not-startable",
    totalUsers: started.total,
  });
  const campaign = await prisma.freeTrialResetCampaign.findUnique({
    where: { id: campaignId },
  });
  if (campaign === null) {
    await safeReply(ctx, NOT_FOUND);
    return;
  }
  await safeReply(ctx, campaignDetailText(campaign), campaignDetailKeyboard(campaign));
}

trialEntitlementsTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== CAMPAIGN_FLOW) {
    return next();
  }
  // OWNER-only, same policy as every callback route in this module.
  if (admin.role !== "OWNER") {
    clearTrialEntitlementsState(ctx);
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearTrialEntitlementsState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminTrialCampaignDraft;
  if (draft === undefined) {
    clearTrialEntitlementsState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }

  switch (draft.step) {
    case "audience_date": {
      const normalized = normalizeDigits(text.trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(normalized))) {
        await safeReply(ctx, DATE_INVALID_TEXT, wizardCancelKeyboard());
        return;
      }
      draft.audienceDate = normalized;
      await askAllowance(ctx, draft);
      return;
    }
    case "audience_users":
      await handleSelectedUsersInput(ctx, draft, text);
      return;
    case "allowance": {
      const count = parseAllowanceCount(text);
      if (count === null) {
        await safeReply(ctx, ALLOWANCE_INVALID_TEXT, wizardCancelKeyboard());
        return;
      }
      draft.allowance = count;
      draft.step = "expiry";
      ctx.session.currentFlow = null;
      await safeReply(ctx, EXPIRY_CHOICE_TEXT, expiryChoiceKeyboard());
      return;
    }
    case "expiry_days": {
      const normalized = normalizeDigits(text.trim());
      const days = /^\d{1,4}$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
      if (!Number.isInteger(days) || days < 1 || days > EXPIRY_MAX_DAYS) {
        await safeReply(ctx, DAYS_INVALID_TEXT, wizardCancelKeyboard());
        return;
      }
      draft.expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      draft.step = "notify";
      ctx.session.currentFlow = null;
      await safeReply(ctx, NOTIFY_CHOICE_TEXT, notifyChoiceKeyboard());
      return;
    }
    case "reason":
      await handleReasonInput(ctx, draft, text);
      return;
    case "confirm":
      await handleTypedConfirmation(ctx, text);
      return;
    default:
      clearTrialEntitlementsState(ctx);
      await safeReply(ctx, DRAFT_EXPIRED_TEXT);
  }
});
