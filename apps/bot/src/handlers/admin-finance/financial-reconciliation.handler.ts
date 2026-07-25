import { FinancialReconciliationStatus, FinancialReconciliationType } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getReconciliationCaseByShortId,
  listReconciliationCases,
  reconciliationStatusLabel,
  retryBindServiceUsernameUnboundCase,
  type ReconciliationCasePage,
} from "../../services/financial-reconciliation.service.js";
import { dispatchPaidOrderFulfillment } from "../../services/order-fulfillment.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «تطبیق مالی ⚖️» reconciliation pages under مالی 💎. The queue is TYPE-AWARE:
// two independent sections, each filtered to one FinancialReconciliationType at
// the DB query with its own count + pagination:
//   • پرداخت‌های موفق تکراری   (DUPLICATE_CHECKOUT_PAYMENT) — read-only review.
//   • مغایرت رزرو یوزرنیم سرویس (SERVICE_USERNAME_UNBOUND) — read + a single safe
//     OWNER retry-bind action that re-attempts the EXACT reservation bind and
//     resumes provisioning, never a blind "mark resolved".
// Every route is OWNER-only (the strongest existing financial role — centralized
// RBAC is a separate task); other admins get a safe toast and never see case
// data. Safe fields only: short ids, providers, amounts and status — NEVER
// callback payloads, raw usernames, notes, reservation ids, authorities, tokens
// or full UUIDs. The case `type` is the rendering source of truth.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

/** Shown (toast only, no data) to active non-OWNER admins. */
export const RECON_OWNER_ONLY_TOAST =
  "دسترسی به این بخش فقط برای مالک مجموعه فعال است.";

const RECON_LANDING_TEXT =
  "تطبیق مالی ⚖️\n\nموارد نیازمند بررسی مالی، بر اساس نوع مغایرت.";

const RECON_DUP_EMPTY_TEXT = "موردی برای بررسی وجود ندارد.";
const RECON_SVC_EMPTY_TEXT = "موردی برای بررسی وجود ندارد.";

/** Retry-bind result toasts (safe — no username / note / reservation id). */
const RETRY_OK_TOAST = "رزرو دقیق متصل شد و ادامه ساخت سرویس آغاز شد.";
const RETRY_BLOCKED_TOAST =
  "اتصال دقیق رزرو هنوز ممکن نیست؛ این مورد برای بررسی دستی مالی/فنی باز نگه داشته شد.";

/**
 * Callback builders — the longest emitted value (`admin:fin:recon:dup:` +
 * a page number, or `admin:fin:recon:v:` + an 8-char short id) stays far under
 * the 64-byte Telegram limit.
 */
export const RECON_CB = {
  root: "admin:fin:recon",
  dup: (page: number): string => `admin:fin:recon:dup:${page}`,
  svc: (page: number): string => `admin:fin:recon:svc:${page}`,
  view: (sid: string): string => `admin:fin:recon:v:${sid}`,
  retry: (sid: string): string => `admin:fin:recon:rb:${sid}`,
} as const;

type EnrichedReconciliationCase = ReconciliationCasePage["cases"][number];

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function formatStamp(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

/**
 * Exported for tests: the HTML detail page for one DUPLICATE_CHECKOUT_PAYMENT
 * case (unchanged). Renders 8-char short ids only — never full UUIDs, payloads
 * or authorities.
 */
export function buildReconciliationDetailText(
  reconciliationCase: EnrichedReconciliationCase,
): string {
  const primarySid =
    reconciliationCase.primaryPaymentId === null
      ? "-"
      : shortId(reconciliationCase.primaryPaymentId);
  return [
    "⚠️ پرداخت موفق تکراری",
    "",
    `کاربر: <code>${escapeHtml(reconciliationCase.userTelegramId)}</code>`,
    `پیش‌فاکتور: <code>${escapeHtml(shortId(reconciliationCase.checkoutSessionId))}</code>`,
    `پرداخت اصلی: ${escapeHtml(reconciliationCase.primaryProvider)} (<code>${escapeHtml(primarySid)}</code>)`,
    `پرداخت تکراری: ${escapeHtml(reconciliationCase.duplicateProvider)} (<code>${escapeHtml(shortId(reconciliationCase.duplicatePaymentId))}</code>)`,
    `مبلغ: ${formatToman(reconciliationCase.expectedAmountToman)}`,
    `وضعیت: ${reconciliationStatusLabel(reconciliationCase.status)}`,
    `زمان ثبت: ${formatStamp(reconciliationCase.createdAt)}`,
  ].join("\n");
}

/**
 * Exported for tests: the HTML detail page for one SERVICE_USERNAME_UNBOUND
 * case (§2). DELIBERATELY carries NO duplicate-payment title, no «پرداخت اصلی» /
 * «پرداخت تکراری», no raw username, note, reservation id, callback payload,
 * provider secret or full UUID — only the settling payment's provider
 * + short id, an optional short order id, the amount, the status and the
 * timestamp. The case `type` (not any field heuristic) selects this renderer.
 */
export function buildServiceUnboundDetailText(
  reconciliationCase: EnrichedReconciliationCase,
): string {
  const lines = [
    "⚠️ مغایرت رزرو یوزرنیم سرویس",
    "",
    `کاربر: <code>${escapeHtml(reconciliationCase.userTelegramId)}</code>`,
    `پیش‌فاکتور: <code>${escapeHtml(shortId(reconciliationCase.checkoutSessionId))}</code>`,
    `پرداخت: ${escapeHtml(reconciliationCase.duplicateProvider)} (<code>${escapeHtml(shortId(reconciliationCase.duplicatePaymentId))}</code>)`,
  ];
  if (reconciliationCase.settlementOrderShortId !== null) {
    lines.push(
      `سفارش: <code>${escapeHtml(reconciliationCase.settlementOrderShortId)}</code>`,
    );
  }
  lines.push(
    `مبلغ: ${formatToman(reconciliationCase.expectedAmountToman)}`,
    `وضعیت: ${reconciliationStatusLabel(reconciliationCase.status)}`,
    `زمان ثبت: ${formatStamp(reconciliationCase.createdAt)}`,
  );
  return lines.join("\n");
}

/** Exported for tests: one button per case + type-correct pagination + back. */
export function reconciliationListKeyboard(
  pageData: ReconciliationCasePage,
  variant: "dup" | "svc",
): InlineKeyboard {
  const pageCb = variant === "dup" ? RECON_CB.dup : RECON_CB.svc;
  const kb = new InlineKeyboard();
  for (const item of pageData.cases) {
    kb.text(
      `⚠️ ${shortId(item.id)} | ${item.duplicateProvider} | ${formatToman(item.expectedAmountToman)}`,
      RECON_CB.view(shortId(item.id)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", pageCb(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, pageCb(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", pageCb(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", RECON_CB.root);
  return kb;
}

/** Detail keyboard, type-routed: the service-username case adds a retry-bind
 * action when it is still actionable (OPEN / IN_REVIEW). */
function reconciliationDetailKeyboard(
  reconciliationCase: EnrichedReconciliationCase,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const isServiceUnbound =
    reconciliationCase.type === FinancialReconciliationType.SERVICE_USERNAME_UNBOUND;
  const isActionable =
    reconciliationCase.status === FinancialReconciliationStatus.OPEN ||
    reconciliationCase.status === FinancialReconciliationStatus.IN_REVIEW;
  if (isServiceUnbound && isActionable) {
    kb.text("بررسی مجدد رزرو و ادامه ساخت 🔄", RECON_CB.retry(shortId(reconciliationCase.id))).row();
  }
  kb.text("بازگشت به لیست", isServiceUnbound ? RECON_CB.svc(1) : RECON_CB.dup(1)).row();
  kb.text("بازگشت به مالی", CB.ADMIN_FINANCE);
  return kb;
}

/** Type-routed detail text (the case `type` decides which renderer runs). */
function buildDetailText(reconciliationCase: EnrichedReconciliationCase): string {
  return reconciliationCase.type === FinancialReconciliationType.SERVICE_USERNAME_UNBOUND
    ? buildServiceUnboundDetailText(reconciliationCase)
    : buildReconciliationDetailText(reconciliationCase);
}

export const financialReconciliationHandler = new Composer<BotContext>();

/**
 * OWNER-only gate for EVERY reconciliation route. Non-admins are already
 * stopped by adminAuthMiddleware; an active non-OWNER admin gets the safe
 * toast and no data at all.
 */
async function requireOwner(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (ctx.admin.role === "OWNER") {
    return true;
  }
  await safeAnswerCallback(ctx, RECON_OWNER_ONLY_TOAST);
  return false;
}

financialReconciliationHandler.callbackQuery(RECON_CB.root, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("پرداخت‌های موفق تکراری", RECON_CB.dup(1))
    .row()
    .text("مغایرت رزرو یوزرنیم سرویس", RECON_CB.svc(1))
    .row()
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
  await safeEditOrReply(ctx, RECON_LANDING_TEXT, kb);
});

financialReconciliationHandler.callbackQuery(/^admin:fin:recon:dup:(\d+)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  const pageData = await listReconciliationCases(
    FinancialReconciliationType.DUPLICATE_CHECKOUT_PAYMENT,
    Number.parseInt(ctx.match[1], 10),
  );
  await safeAnswerCallback(ctx);
  const title =
    pageData.total === 0
      ? `پرداخت‌های موفق تکراری ⚠️\n\n${RECON_DUP_EMPTY_TEXT}`
      : `پرداخت‌های موفق تکراری ⚠️ — ${pageData.total} مورد`;
  await safeEditOrReply(ctx, title, reconciliationListKeyboard(pageData, "dup"));
});

financialReconciliationHandler.callbackQuery(/^admin:fin:recon:svc:(\d+)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  const pageData = await listReconciliationCases(
    FinancialReconciliationType.SERVICE_USERNAME_UNBOUND,
    Number.parseInt(ctx.match[1], 10),
  );
  await safeAnswerCallback(ctx);
  const title =
    pageData.total === 0
      ? `مغایرت رزرو یوزرنیم سرویس ⚠️\n\n${RECON_SVC_EMPTY_TEXT}`
      : `مغایرت رزرو یوزرنیم سرویس ⚠️ — ${pageData.total} مورد`;
  await safeEditOrReply(ctx, title, reconciliationListKeyboard(pageData, "svc"));
});

financialReconciliationHandler.callbackQuery(/^admin:fin:recon:v:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  const found = await getReconciliationCaseByShortId(ctx.match[1]);
  if (found === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, buildDetailText(found), reconciliationDetailKeyboard(found), HTML);
});

// The single safe SERVICE_USERNAME_UNBOUND action (§4): re-attempt the EXACT
// reservation bind (never a blind resolve), then resume provisioning once. The
// service performs the whole bind→resolve in ONE locked transaction; only a real
// successful bind resolves the case. Duplicate presses are idempotent (the case
// row is locked, provisioning is CAS/lock-guarded), so no duplicate service.
financialReconciliationHandler.callbackQuery(/^admin:fin:recon:rb:([0-9a-f-]+)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  if (ctx.admin === null) {
    return;
  }
  const found = await getReconciliationCaseByShortId(ctx.match[1]);
  if (found === null || found.type !== FinancialReconciliationType.SERVICE_USERNAME_UNBOUND) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const result = await retryBindServiceUsernameUnboundCase(found.id, ctx.admin.id);
  if (result.ok) {
    // Resume provisioning EXACTLY once (idempotent): the case is now RESOLVED,
    // so the provisioning gate no longer blocks; the immutable username
    // snapshot is used and an existing Service wins over a re-dispatch.
    await dispatchPaidOrderFulfillment(ctx.api, result.orderId, { source: "GATEWAY" });
    await safeAnswerCallback(ctx, RETRY_OK_TOAST);
  } else {
    // Still impossible — the case stays OPEN/IN_REVIEW; no provisioning, no
    // resolve, no username regeneration. Ask for manual review.
    await safeAnswerCallback(ctx, RETRY_BLOCKED_TOAST);
  }
  // Re-render the (possibly resolved) detail so the OWNER sees the new state.
  const refreshed = await getReconciliationCaseByShortId(ctx.match[1]);
  if (refreshed !== null) {
    await safeEditOrReply(
      ctx,
      buildDetailText(refreshed),
      reconciliationDetailKeyboard(refreshed),
      HTML,
    );
  }
});
