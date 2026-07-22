import { randomUUID } from "node:crypto";

import {
  ADMIN_SERVICE_NOTE_MAX,
  ADMIN_SERVICE_REASON_MAX,
  ADMIN_SERVICE_REASON_MIN,
  adminServiceShortId,
  isValidAdminServiceNote,
  isValidAdminServiceReason,
  parseAdminTimeDays,
  parseAdminVolumeGib,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  addAdminServiceNote,
  adminServiceEligibleMutations,
  adminServiceSnapshotFingerprint,
  buildAdminServiceSnapshot,
  countReconciliationOperations,
  countUnresolvedAdminOperations,
  executeAdminServiceOperation,
  getAdminServiceDetail,
  getAdminServiceOperationByShortId,
  getAdminServiceOperationById,
  latestAdminServiceNote,
  latestAdminServiceOperations,
  listAdminServiceOperations,
  listReconciliationOperations,
  markAdminOperationUserNotified,
  markAdminServiceOperationReviewed,
  reconcileAdminServiceOperation,
  refreshAdminServiceReadOnly,
  type AdminServiceMutationType,
} from "../../services/admin-service-operation.service.js";
import {
  areAdminServiceMutationsEnabled,
  compareAndSetAdminServiceMutationsEnabled,
} from "../../services/admin-service-settings.service.js";
import { getUserById } from "../../services/admin-user-wallet.service.js";
import { clearSettingsCache } from "../../services/settings.service.js";
import { getMessageTemplate } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import {
  ADMIN_SERVICE_ERROR_TEXT,
  adminHistoryKeyboard,
  adminHistoryText,
  adminOperationConfirmKeyboard,
  adminOperationDetailText,
  adminOperationPreviewText,
  adminReconDashboardKeyboard,
  adminReconDashboardText,
  adminRegenAskKeyboard,
  adminRegenAskText,
  adminServiceDetailKeyboard,
  adminServiceDetailText,
  adminServiceErrorText,
  adminServiceSettingsKeyboard,
  adminServiceSettingsText,
  adminTimeMenu,
  adminVolumeMenu,
  ASO_CB,
} from "./admin-service-ops-views.js";

// =============================================================================
// Admin Service Operations — the handler (feat/admin-service-operations,
// §8–§22). Mounted behind adminAuthMiddleware; every callback additionally
// requires ctx.admin and RE-validates OWNER + the mutation master switch inside
// the executor on confirm (a stale button/direct callback fails closed). The
// read-only detail + refresh work for any authenticated admin and even while
// mutations are disabled. No subscription URL / config / QR / token is ever
// shown, and the entered reason / note is never logged.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const OWNER_ONLY = "این بخش فقط برای مالک ربات در دسترس است.";
const ASO_FLOW = "admin_svc:input";

const REASON_PROMPT = `دلیل این عملیات را وارد کنید (بین ${ADMIN_SERVICE_REASON_MIN} تا ${ADMIN_SERVICE_REASON_MAX} نویسه). این دلیل فقط برای شما ثبت می‌شود و به کاربر نمایش داده نمی‌شود.`;
const VOLUME_CUSTOM_PROMPT = "مقدار حجم موردنظر را به گیگابایت وارد کنید (عدد صحیح بین ۱ تا ۱۰۰۰۰).";
const TIME_CUSTOM_PROMPT = "تعداد روز موردنظر را وارد کنید (عدد صحیح بین ۱ تا ۳۶۵۰).";
const INVALID_VOLUME = "مقدار حجم معتبر نیست. یک عدد صحیح بین ۱ تا ۱۰۰۰۰ وارد کنید.";
const INVALID_TIME = "تعداد روز معتبر نیست. یک عدد صحیح بین ۱ تا ۳۶۵۰ وارد کنید.";
const INVALID_REASON = `دلیل باید بین ${ADMIN_SERVICE_REASON_MIN} تا ${ADMIN_SERVICE_REASON_MAX} نویسه باشد.`;
const INVALID_NOTE = `یادداشت باید بین ۱ تا ${ADMIN_SERVICE_NOTE_MAX} نویسه باشد.`;
const NOTE_PROMPT_DEFAULT =
  "متن یادداشت داخلی را وارد کنید.\n⚠️ اطلاعات کانفیگ، لینک اشتراک، رمز یا توکن را در یادداشت وارد نکنید.";
const USER_NOTIFICATION_DEFAULT =
  "سرویس شما توسط پشتیبانی بروزرسانی شد ✅\nبرای مشاهده جزئیات روی دکمه زیر بزنید.";

export const adminServiceOpsHandler = new Composer<BotContext>();
export const adminServiceOpsTextHandler = new Composer<BotContext>();

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

function clearDraft(ctx: BotContext): void {
  delete ctx.session.temp.adminServiceOpDraft;
  if (ctx.session.currentFlow === ASO_FLOW) {
    ctx.session.currentFlow = null;
  }
}

// --- detail page (§8) --------------------------------------------------------

async function renderDetail(
  ctx: BotContext,
  sid: string,
  freshnessNotice: string | null,
  edit: boolean,
): Promise<void> {
  const detail = await getAdminServiceDetail(sid);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const { service, panel, owner } = detail;
  const [mutationsEnabled, unresolvedCount, latestOps, latestNote] = await Promise.all([
    areAdminServiceMutationsEnabled(),
    countUnresolvedAdminOperations(service.id),
    latestAdminServiceOperations(service.id, 3),
    latestAdminServiceNote(service.id),
  ]);
  const eligible = adminServiceEligibleMutations(service, panel);
  const text = adminServiceDetailText({
    service,
    panel,
    owner,
    unresolvedCount,
    latestOps,
    latestNote,
    freshnessNotice,
  });
  const keyboard = adminServiceDetailKeyboard(sid, {
    ownerSid: owner === null ? "-" : owner.id.slice(0, 8),
    isOwner: isOwner(ctx),
    mutationsEnabled,
    eligible,
    hasConflict: unresolvedCount > 0,
  });
  if (edit) {
    await safeEditOrReply(ctx, text, keyboard, HTML);
  } else {
    await safeReply(ctx, text, keyboard, HTML);
  }
}

adminServiceOpsHandler.callbackQuery(/^admin:svc:view:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  clearDraft(ctx);
  await renderDetail(ctx, ctx.match[1], null, true);
});

// --- read-only refresh (§9) --------------------------------------------------

adminServiceOpsHandler.callbackQuery(/^admin:svc:refresh:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const detail = await getAdminServiceDetail(ctx.match[1]);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, "در حال بروزرسانی...");
  const outcome =
    detail.owner === null
      ? { kind: "service-missing" as const }
      : await refreshAdminServiceReadOnly(detail.service.id, detail.owner.id);
  let notice: string;
  switch (outcome.kind) {
    case "refreshed":
      notice = "اطلاعات سرویس بروزرسانی شد ✅";
      break;
    case "not-found":
      notice = "این سرویس در پنل پیدا نشد.";
      break;
    case "auth-failed":
      notice = "احراز هویت پنل ناموفق بود.";
      break;
    case "unreachable":
      notice = "ارتباط با پنل برقرار نشد.";
      break;
    case "panel-inactive":
      notice = "پنل این سرویس غیرفعال است.";
      break;
    case "locked":
      notice = "عملیات دیگری روی این سرویس در حال انجام است.";
      break;
    default:
      notice = "بروزرسانی لحظه‌ای در دسترس نیست.";
  }
  await renderDetail(ctx, ctx.match[1], notice, true);
});

// --- operation history (§19) -------------------------------------------------

adminServiceOpsHandler.callbackQuery(/^admin:svc:hist:([0-9a-f-]{4,32}):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const detail = await getAdminServiceDetail(ctx.match[1]);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  const page = await listAdminServiceOperations(detail.service.id, Number.parseInt(ctx.match[2], 10));
  await safeEditOrReply(
    ctx,
    adminHistoryText(detail.service, page.operations, page.total),
    adminHistoryKeyboard(ctx.match[1], page.page, page.pages, page.operations),
    HTML,
  );
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:op:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const op = await getAdminServiceOperationByShortId(ctx.match[1]);
  if (op === null || op.serviceId === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  const back = new InlineKeyboard().text(
    "بازگشت به تاریخچه",
    ASO_CB.hist(adminServiceShortId(op.serviceId), 1),
  );
  await safeEditOrReply(ctx, adminOperationDetailText(op), back, HTML);
}); // op id short → op detail

// --- starting a mutation: gates then draft + reason flow (§8) ----------------

/** Loads the service + revalidates the OWNER/switch/eligibility gates before
 * a mutation flow starts (defence in depth; the executor re-checks on confirm). */
async function guardMutationStart(
  ctx: BotContext,
  sid: string,
  type: AdminServiceMutationType,
): Promise<{ serviceId: string; fingerprint: string } | null> {
  if (!(await ownerGuard(ctx))) {
    return null;
  }
  if (!(await areAdminServiceMutationsEnabled())) {
    await safeAnswerCallback(ctx, ADMIN_SERVICE_ERROR_TEXT.MUTATIONS_DISABLED);
    return null;
  }
  const detail = await getAdminServiceDetail(sid);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return null;
  }
  if (!adminServiceEligibleMutations(detail.service, detail.panel).includes(type)) {
    await safeAnswerCallback(ctx, ADMIN_SERVICE_ERROR_TEXT.INELIGIBLE_STATUS);
    return null;
  }
  const conflict = await countUnresolvedAdminOperations(detail.service.id);
  if (conflict > 0) {
    await safeAnswerCallback(ctx, ADMIN_SERVICE_ERROR_TEXT.CONFLICTING_OPERATION);
    return null;
  }
  const fingerprint = adminServiceSnapshotFingerprint(
    buildAdminServiceSnapshot(detail.service, detail.panel),
  );
  return { serviceId: detail.service.id, fingerprint };
}

async function beginReasonStep(
  ctx: BotContext,
  serviceId: string,
  type: AdminServiceMutationType,
  fingerprint: string,
  requestedCount: number | undefined,
): Promise<void> {
  ctx.session.temp.adminServiceOpDraft = {
    serviceId,
    type,
    step: "reason",
    nonce: randomUUID(),
    expectedFingerprint: fingerprint,
    requestedCount,
  };
  ctx.session.currentFlow = ASO_FLOW;
  const kb = new InlineKeyboard().text("انصراف", ASO_CB.view(adminServiceShortId(serviceId)));
  await safeEditOrReply(ctx, REASON_PROMPT, kb, HTML);
}

// ENABLE / DISABLE
adminServiceOpsHandler.callbackQuery(/^admin:svc:tg:([0-9a-f-]{4,32}):([ed])$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const type: AdminServiceMutationType = ctx.match[2] === "e" ? "ENABLE" : "DISABLE";
  const guard = await guardMutationStart(ctx, ctx.match[1], type);
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await beginReasonStep(ctx, guard.serviceId, type, guard.fingerprint, undefined);
});

// ADD_VOLUME preset menu
adminServiceOpsHandler.callbackQuery(/^admin:svc:vol:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_VOLUME");
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const menu = adminVolumeMenu(ctx.match[1]);
  await safeEditOrReply(ctx, menu.text, menu.keyboard, HTML);
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:volp:([0-9a-f-]{4,32}):(\d{1,6})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const gib = parseAdminVolumeGib(ctx.match[2]);
  if (gib === null) {
    await safeAnswerCallback(ctx, INVALID_VOLUME);
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_VOLUME");
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await beginReasonStep(ctx, guard.serviceId, "ADD_VOLUME", guard.fingerprint, gib);
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:volc:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_VOLUME");
  if (guard === null) {
    return;
  }
  ctx.session.temp.adminServiceOpDraft = {
    serviceId: guard.serviceId,
    type: "ADD_VOLUME",
    step: "custom_volume",
    nonce: randomUUID(),
    expectedFingerprint: guard.fingerprint,
  };
  ctx.session.currentFlow = ASO_FLOW;
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard().text("انصراف", ASO_CB.view(ctx.match[1]));
  await safeEditOrReply(ctx, VOLUME_CUSTOM_PROMPT, kb, HTML);
});

// ADD_TIME preset menu
adminServiceOpsHandler.callbackQuery(/^admin:svc:tm:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_TIME");
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const menu = adminTimeMenu(ctx.match[1]);
  await safeEditOrReply(ctx, menu.text, menu.keyboard, HTML);
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:tmp:([0-9a-f-]{4,32}):(\d{1,5})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const days = parseAdminTimeDays(ctx.match[2]);
  if (days === null) {
    await safeAnswerCallback(ctx, INVALID_TIME);
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_TIME");
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await beginReasonStep(ctx, guard.serviceId, "ADD_TIME", guard.fingerprint, days);
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:tmc:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "ADD_TIME");
  if (guard === null) {
    return;
  }
  ctx.session.temp.adminServiceOpDraft = {
    serviceId: guard.serviceId,
    type: "ADD_TIME",
    step: "custom_time",
    nonce: randomUUID(),
    expectedFingerprint: guard.fingerprint,
  };
  ctx.session.currentFlow = ASO_FLOW;
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard().text("انصراف", ASO_CB.view(ctx.match[1]));
  await safeEditOrReply(ctx, TIME_CUSTOM_PROMPT, kb, HTML);
});

// REGENERATE_LINK — double confirm (§16)
adminServiceOpsHandler.callbackQuery(/^admin:svc:rg:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "REGENERATE_LINK");
  if (guard === null) {
    return;
  }
  const detail = await getAdminServiceDetail(ctx.match[1]);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    adminRegenAskText(detail.service),
    adminRegenAskKeyboard(ctx.match[1]),
    HTML,
  );
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:rg2:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const guard = await guardMutationStart(ctx, ctx.match[1], "REGENERATE_LINK");
  if (guard === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await beginReasonStep(ctx, guard.serviceId, "REGENERATE_LINK", guard.fingerprint, undefined);
});

// ADD_NOTE (§17) — OWNER only, no switch, no panel call
adminServiceOpsHandler.callbackQuery(/^admin:svc:note:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const detail = await getAdminServiceDetail(ctx.match[1]);
  if (detail === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminServiceOpDraft = {
    serviceId: detail.service.id,
    type: "ADD_NOTE",
    step: "note",
    nonce: randomUUID(),
  };
  ctx.session.currentFlow = ASO_FLOW;
  await safeAnswerCallback(ctx);
  const prompt = await getMessageTemplate("admin_service_note_warning", NOTE_PROMPT_DEFAULT);
  const kb = new InlineKeyboard().text("انصراف", ASO_CB.view(ctx.match[1]));
  await safeEditOrReply(ctx, prompt, kb, HTML);
});

// --- cancel + confirm --------------------------------------------------------

adminServiceOpsHandler.callbackQuery(/^admin:svc:cancel:([0-9a-f-]{4,32})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearDraft(ctx);
  await safeAnswerCallback(ctx, "لغو شد");
  await renderDetail(ctx, ctx.match[1], null, true);
});

adminServiceOpsHandler.callbackQuery(ASO_CB.confirm, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const draft = ctx.session.temp.adminServiceOpDraft;
  if (
    draft === undefined ||
    draft.step !== "ready" ||
    draft.type === "ADD_NOTE" ||
    draft.reason === undefined ||
    draft.expectedFingerprint === undefined
  ) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED);
    return;
  }
  // Consume the one-shot draft BEFORE executing so a double confirm can never
  // re-run (the idempotencyKey is the DB-level backstop).
  const consumed = { ...draft };
  clearDraft(ctx);
  await safeAnswerCallback(ctx, "در حال انجام...");

  const sid = adminServiceShortId(consumed.serviceId);
  const result = await executeAdminServiceOperation({
    type: consumed.type as AdminServiceMutationType,
    serviceId: consumed.serviceId,
    adminId: ctx.admin.id,
    reason: consumed.reason ?? "",
    requestedCount: consumed.requestedCount ?? null,
    expectedFingerprint: consumed.expectedFingerprint ?? "",
    nonce: consumed.nonce,
    sourceUpdateId: BigInt(ctx.update.update_id),
    notifyUser: true,
  });

  let notice: string;
  if (result.outcome === "succeeded") {
    notice = "عملیات با موفقیت انجام شد ✅";
    if (result.notifyUser && result.ownerUserId !== null) {
      await notifyUserOfOperation(ctx, result.ownerUserId, sid, result.operationId);
    }
  } else if (result.outcome === "uncertain") {
    notice = adminServiceErrorText(result.errorCode);
  } else {
    notice = adminServiceErrorText(result.errorCode);
  }
  await renderDetail(ctx, sid, notice, true);
});

/** §19 — notifies the service owner ONCE, after success, with no secrets, no
 * reason and no admin identity, plus a button to their own service detail. */
async function notifyUserOfOperation(
  ctx: BotContext,
  ownerUserId: string,
  sid: string,
  operationId: string,
): Promise<void> {
  const user = await getUserById(ownerUserId);
  if (user === null) {
    return;
  }
  const body = await getMessageTemplate("admin_service_user_notification", USER_NOTIFICATION_DEFAULT);
  const kb = new InlineKeyboard().text("مشاهده سرویس 🔎", `user:svc:view:${sid}`);
  try {
    await ctx.api.sendMessage(Number(user.telegramId), body, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch (err) {
    // The user may have blocked the bot, or Telegram may be transiently down.
    // Do NOT mark the operation notified on failure, so a later attempt can
    // still deliver it — never let a notification failure break the admin flow.
    logger.warn("admin service user notification failed", {
      operationId,
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return;
  }
  // Record the notification ONLY after Telegram accepted it (CAS ensures once).
  await markAdminOperationUserNotified(operationId);
}

// --- OWNER reconciliation dashboard (§18) ------------------------------------

adminServiceOpsHandler.callbackQuery(/^admin:svc:recon:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const page = await listReconciliationOperations(Number.parseInt(ctx.match[1], 10));
  await safeEditOrReply(
    ctx,
    adminReconDashboardText(page.operations, page.total),
    adminReconDashboardKeyboard(page.page, page.pages, page.operations),
    HTML,
  );
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:recrun:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const op = await getAdminServiceOperationByShortId(ctx.match[1]);
  if (op === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, "در حال بررسی...");
  const outcome = await reconcileAdminServiceOperation(op.id, ctx.admin.id);
  let notice: string;
  switch (outcome.kind) {
    case "reconciled":
      notice = outcome.newStatus === "RECONCILED" ? "عملیات بررسی و تایید شد ✅" : "عملیات ناموفق ثبت شد ❌";
      break;
    case "still-uncertain":
      notice = "هنوز قابل تشخیص نیست؛ بعداً دوباره بررسی کنید.";
      break;
    case "not-reconcilable":
      notice = "این عملیات نیازی به بررسی ندارد.";
      break;
    default:
      notice = NOT_FOUND;
  }
  const refreshed = await getAdminServiceOperationById(op.id);
  const detailText =
    refreshed === null ? notice : `${notice}\n\n${adminOperationDetailText(refreshed)}`;
  const kb = new InlineKeyboard();
  // If the op is still blocking (e.g. an unverifiable regeneration that stays
  // inconclusive), offer the OWNER a terminal manual resolution so the service
  // is never permanently blocked.
  if (
    refreshed !== null &&
    (refreshed.status === "UNCERTAIN" || refreshed.status === "RECONCILIATION_REQUIRED")
  ) {
    kb.text("علامت‌گذاری به‌عنوان بررسی‌شده ✅", ASO_CB.reconReview(ctx.match[1])).row();
  }
  kb.text("بازگشت به لیست بررسی", ASO_CB.recon(1));
  await safeEditOrReply(ctx, detailText, kb, HTML);
});

adminServiceOpsHandler.callbackQuery(/^admin:svc:recrev:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const op = await getAdminServiceOperationByShortId(ctx.match[1]);
  if (op === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await markAdminServiceOperationReviewed(op.id, ctx.admin.id);
  await safeAnswerCallback(
    ctx,
    outcome.kind === "resolved" ? "به‌عنوان بررسی‌شده ثبت شد ✅" : "این عملیات قابل بررسی نیست.",
  );
  const page = await listReconciliationOperations(1);
  await safeEditOrReply(
    ctx,
    adminReconDashboardText(page.operations, page.total),
    adminReconDashboardKeyboard(page.page, page.pages, page.operations),
    HTML,
  );
});

// --- OWNER settings: the mutation master switch (§3) -------------------------

async function renderSettings(ctx: BotContext): Promise<void> {
  const [enabled, reconcileCount] = await Promise.all([
    areAdminServiceMutationsEnabled(),
    countReconciliationOperations(),
  ]);
  await safeEditOrReply(
    ctx,
    adminServiceSettingsText(enabled, reconcileCount),
    adminServiceSettingsKeyboard(enabled),
    HTML,
  );
}

adminServiceOpsHandler.callbackQuery(ASO_CB.settings, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  await renderSettings(ctx);
});

adminServiceOpsHandler.callbackQuery(ASO_CB.settingsToggle, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  if (!(await ownerGuard(ctx))) {
    return;
  }
  const current = await areAdminServiceMutationsEnabled();
  // Stale-state-safe CAS: two concurrent OWNER taps never both flip.
  const changed = await compareAndSetAdminServiceMutationsEnabled(current, !current);
  clearSettingsCache();
  await safeAnswerCallback(ctx, changed ? "انجام شد ✅" : "وضعیت تغییر کرده بود؛ دوباره تلاش کنید.");
  await renderSettings(ctx);
});

// --- text input flows: custom volume/time, reason, note ----------------------

adminServiceOpsTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== ASO_FLOW) {
    return next();
  }
  const draft = ctx.session.temp.adminServiceOpDraft;
  if (draft === undefined) {
    ctx.session.currentFlow = null;
    return;
  }
  if (ctx.admin === null || ctx.admin.role !== "OWNER") {
    clearDraft(ctx);
    await safeReply(ctx, OWNER_ONLY, undefined, HTML);
    return;
  }
  const raw = ctx.message.text.trim();
  const sid = adminServiceShortId(draft.serviceId);

  if (draft.step === "custom_volume") {
    const gib = parseAdminVolumeGib(raw);
    if (gib === null) {
      await safeReply(ctx, INVALID_VOLUME, undefined, HTML);
      return;
    }
    draft.requestedCount = gib;
    draft.step = "reason";
    await safeReply(
      ctx,
      REASON_PROMPT,
      new InlineKeyboard().text("انصراف", ASO_CB.view(sid)),
      HTML,
    );
    return;
  }
  if (draft.step === "custom_time") {
    const days = parseAdminTimeDays(raw);
    if (days === null) {
      await safeReply(ctx, INVALID_TIME, undefined, HTML);
      return;
    }
    draft.requestedCount = days;
    draft.step = "reason";
    await safeReply(
      ctx,
      REASON_PROMPT,
      new InlineKeyboard().text("انصراف", ASO_CB.view(sid)),
      HTML,
    );
    return;
  }
  if (draft.step === "note") {
    if (!isValidAdminServiceNote(raw)) {
      await safeReply(ctx, INVALID_NOTE, undefined, HTML);
      return;
    }
    const result = await addAdminServiceNote({
      serviceId: draft.serviceId,
      adminId: ctx.admin.id,
      note: raw,
      nonce: draft.nonce,
      sourceUpdateId: BigInt(ctx.update.update_id),
    });
    clearDraft(ctx);
    if (!result.ok) {
      await safeReply(ctx, adminServiceErrorText(result.errorCode), undefined, HTML);
      return;
    }
    await safeReply(
      ctx,
      "یادداشت ثبت شد ✅",
      new InlineKeyboard().text("بازگشت به سرویس", ASO_CB.view(sid)),
      HTML,
    );
    return;
  }
  if (draft.step === "reason") {
    if (!isValidAdminServiceReason(raw)) {
      await safeReply(ctx, INVALID_REASON, undefined, HTML);
      return;
    }
    draft.reason = raw;
    draft.step = "ready";
    ctx.session.currentFlow = null;
    const detail = await getAdminServiceDetail(sid);
    if (detail === null) {
      clearDraft(ctx);
      await safeReply(ctx, NOT_FOUND, undefined, HTML);
      return;
    }
    await safeReply(
      ctx,
      adminOperationPreviewText(
        draft.type as AdminServiceMutationType,
        detail.service,
        draft.requestedCount ?? null,
        raw,
      ),
      adminOperationConfirmKeyboard(sid),
      HTML,
    );
    return;
  }
  // Unknown step — reset defensively.
  clearDraft(ctx);
});
