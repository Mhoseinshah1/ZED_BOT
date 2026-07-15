import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getReconciliationCaseByShortId,
  listReconciliationCases,
  reconciliationStatusLabel,
  type ReconciliationCasePage,
} from "../../services/financial-reconciliation.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «تطبیق مالی ⚖️» (P0 settlement phase) - READ-ONLY reconciliation pages
// under مالی 💎: the duplicate-successful-payment review queue filed by
// recordDuplicateSuccess. Every route is OWNER-only (the strongest existing
// financial role - centralized RBAC is a separate task); other admins get a
// safe toast and never see case data. No resolve/refund actions exist here
// because no audited refund workflow exists yet. Safe fields only: short ids,
// providers, amounts and status - NEVER callback payloads, authorities,
// tokens or full UUIDs.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

/** Shown (toast only, no data) to active non-OWNER admins. */
export const RECON_OWNER_ONLY_TOAST =
  "دسترسی به این بخش فقط برای مالک مجموعه فعال است.";

const RECON_LANDING_TEXT =
  "تطبیق مالی ⚖️\n\nموارد نیازمند بررسی مالی. این بخش فقط برای مشاهده است.";

const RECON_EMPTY_TEXT = "موردی برای بررسی وجود ندارد.";

/** Callback builders - the longest emitted value stays far under 64 bytes. */
export const RECON_CB = {
  root: "admin:fin:recon",
  dup: (page: number): string => `admin:fin:recon:dup:${page}`,
  view: (sid: string): string => `admin:fin:recon:v:${sid}`,
} as const;

type EnrichedReconciliationCase = ReconciliationCasePage["cases"][number];

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/**
 * Exported for tests: the HTML detail page for one duplicate-success case.
 * Renders 8-char short ids only - never full UUIDs, payloads or authorities.
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
    `زمان ثبت: ${reconciliationCase.createdAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
  ].join("\n");
}

/** Exported for tests: one button per case + pagination + back row. */
export function reconciliationListKeyboard(pageData: ReconciliationCasePage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of pageData.cases) {
    kb.text(
      `⚠️ ${shortId(item.id)} | ${item.duplicateProvider} | ${formatToman(item.expectedAmountToman)}`,
      RECON_CB.view(shortId(item.id)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", RECON_CB.dup(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, RECON_CB.dup(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", RECON_CB.dup(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", RECON_CB.root);
  return kb;
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
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
  await safeEditOrReply(ctx, RECON_LANDING_TEXT, kb);
});

financialReconciliationHandler.callbackQuery(/^admin:fin:recon:dup:(\d+)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) {
    return;
  }
  const pageData = await listReconciliationCases(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const title =
    pageData.total === 0
      ? `پرداخت‌های موفق تکراری ⚠️\n\n${RECON_EMPTY_TEXT}`
      : `پرداخت‌های موفق تکراری ⚠️ — ${pageData.total} مورد`;
  await safeEditOrReply(ctx, title, reconciliationListKeyboard(pageData));
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
  const kb = new InlineKeyboard()
    .text("بازگشت به لیست", RECON_CB.dup(1))
    .row()
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
  await safeEditOrReply(ctx, buildReconciliationDetailText(found), kb, HTML);
});
