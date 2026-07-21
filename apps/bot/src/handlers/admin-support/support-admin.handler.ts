import { clampEscapedText, validateDiagnosticSnapshot } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  diagnosticCheckMessage,
  diagnosticEvidenceLabel,
  diagnosticOverallLabel,
} from "../../services/service-diagnostics.service.js";
import {
  logSupportAttachmentAccepted,
  logSupportAttachmentRejected,
} from "../../services/support-attachment-log.service.js";
import {
  addAdminTicketReply,
  closeSupportTicket,
  getAdminTicketCounts,
  getAdminTicketDetail,
  listAdminTickets,
  notifyUserAboutAdminReply,
  notifyUserTicketClosed,
  resolveAdminAttachment,
  TICKET_MESSAGE_MAX,
  TICKET_STATUS_ICON,
  TICKET_STATUS_LABEL,
  type AdminTicketFilter,
  type TicketWithMessages,
} from "../../services/support-ticket.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { statusLabel as serviceStatusLabel } from "../user-services/service-views.js";
import {
  extractSupportMessageInput,
  type InboundMessageLike,
  loadSupportInputSettings,
  renderSupportAttachmentRejection,
} from "../user-support/support-input.js";
import {
  hasAttachment,
  sendSupportAttachment,
  supportAttachmentButton,
  supportCategoryLabel,
  supportMessageLine,
  supportOriginLabel,
} from "../user-support/support-detail.js";
import { getMessageTemplate } from "../../services/text.service.js";

// =============================================================================
// «تیکت‌های پشتیبانی 🎫» (Phase 32) - the admin side: counters landing,
// filtered lists (open / waiting-admin / waiting-user / closed), full
// detail (any user), reply (-> WAITING_USER) and confirmed close (->
// CLOSED + SYSTEM message). User notifications are fault-isolated and
// never undo a ticket write. Read/write is limited to the ticket tables -
// no financial/service/stock row is touched.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const REPLY_FLOW = "admin_support:reply";

const ASUP_CB = {
  root: CB.ADMIN_SUPPORT,
  cancel: "admin:sup:cancel",
  list: (filter: AdminTicketFilter, page: number): string => `admin:sup:list:${filter}:${page}`,
  view: (sid: string): string => `admin:sup:view:${sid}`,
  reply: (sid: string): string => `admin:sup:reply:${sid}`,
  close: (sid: string): string => `admin:sup:close:${sid}`,
  closeYes: (sid: string): string => `admin:sup:close_yes:${sid}`,
} as const;

const FILTER_LABEL: Record<AdminTicketFilter, string> = {
  open: "بازها",
  waiting_admin: "در انتظار ادمین",
  waiting_user: "در انتظار کاربر",
  closed: "بسته‌شده‌ها",
};

export const adminSupportHandler = new Composer<BotContext>();

/** Full Phase 32 admin-support state cleanup (reply flow + target). */
export function clearAdminSupportState(ctx: BotContext): void {
  if (ctx.session.currentFlow === REPLY_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminSupportReplyTicketId;
}

export async function renderLanding(ctx: BotContext): Promise<void> {
  clearAdminSupportState(ctx);
  const counts = await getAdminTicketCounts();
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("بازها", ASUP_CB.list("open", 1))
    .text("در انتظار ادمین ⏳", ASUP_CB.list("waiting_admin", 1))
    .row()
    .text("در انتظار کاربر 💬", ASUP_CB.list("waiting_user", 1))
    .text("بسته‌شده‌ها ✅", ASUP_CB.list("closed", 1))
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(
    ctx,
    [
      "تیکت‌های پشتیبانی 🎫",
      "",
      `باز: ${counts.open}`,
      `در انتظار ادمین: ${counts.waitingAdmin}`,
      `در انتظار کاربر: ${counts.waitingUser}`,
      `بسته‌شده: ${counts.closed}`,
    ].join("\n"),
    kb,
  );
}

const DIAG_STATUS_ICON: Record<string, string> = {
  PASS: "✅",
  INFO: "ℹ️",
  WARNING: "⚠️",
  FAIL: "❌",
  UNKNOWN: "❔",
};

/**
 * The SAFE diagnostic-summary section for a ticket opened from a diagnostic run
 * (§16). Renders the linked Service label + status, the report time, the
 * evidence source and every stable check CODE translated to Persian — and NEVER
 * a subscription URL, config, token, credential or raw panel body. Returns [] for
 * an ordinary ticket or a snapshot that fails the strict validator.
 */
function diagnosticSummaryLines(ticket: TicketWithMessages): string[] {
  if (ticket.diagnosticSnapshot === null || ticket.diagnosticSnapshot === undefined) {
    return [];
  }
  const snapshot = validateDiagnosticSnapshot(ticket.diagnosticSnapshot);
  if (snapshot === null) {
    return [];
  }
  const lines = ["", "گزارش عیب‌یابی 🛠"];
  if (ticket.service !== null && ticket.service !== undefined) {
    lines.push(
      `سرویس: ${escapeHtml(ticket.service.username)} | وضعیت: ${serviceStatusLabel(ticket.service.status)}`,
    );
  }
  lines.push(
    `نتیجه: ${diagnosticOverallLabel(snapshot.overall)}`,
    `منبع: ${diagnosticEvidenceLabel(snapshot.evidenceSource)}`,
    `زمان بررسی: ${escapeHtml(snapshot.checkedAt.slice(0, 16).replace("T", " "))} UTC`,
    "بررسی‌ها:",
  );
  for (const check of snapshot.checks) {
    const icon = DIAG_STATUS_ICON[check.status] ?? "•";
    lines.push(`${icon} ${escapeHtml(diagnosticCheckMessage(check.code))}`);
  }
  return lines;
}

/** Whole-message budget kept safely under Telegram's 4096-char hard limit —
 * exceeding it makes BOTH safeEditOrReply's edit AND its reply fallback fail, so
 * the admin cannot open the ticket at all. */
const SUPPORT_DETAIL_TEXT_MAX = 3900;

/** Stable Persian category/origin lines (display only; code-driven behaviour). */
function categoryOriginLines(ticket: TicketWithMessages): string[] {
  const lines: string[] = [];
  const category = supportCategoryLabel(ticket.category);
  const origin = supportOriginLabel(ticket.origin);
  if (category !== null) {
    lines.push(`دسته: ${category}`);
  }
  if (origin !== null) {
    lines.push(`منشأ: ${origin}`);
  }
  return lines;
}

function serviceGib(bytes: bigint): string {
  return (Number(bytes) / (1024 * 1024 * 1024)).toFixed(1);
}

/**
 * The admin linked-Service block (§20). Shows the account label, status, safe
 * quota / expiry / last-sync — and NEVER a subscription URL, config, token or
 * panel credential. A null relation is surfaced without breaking the ticket.
 */
function adminServiceLines(ticket: TicketWithMessages): string[] {
  if (ticket.serviceId === null || ticket.serviceId === undefined) {
    return [];
  }
  if (ticket.service === null || ticket.service === undefined) {
    return ["", "سرویس مرتبط دیگر در دسترس نیست."];
  }
  const s = ticket.service;
  const quota = s.volumeBytes === 0n ? "نامحدود" : `${serviceGib(s.remainingBytes)}/${serviceGib(s.volumeBytes)} GB`;
  const lines = [
    "",
    `سرویس مرتبط: ${escapeHtml(s.username)} | وضعیت: ${serviceStatusLabel(s.status)}`,
    `حجم باقی‌مانده: ${quota}`,
    `انقضا: ${s.expiresAt === null ? "بدون انقضا" : s.expiresAt.toISOString().slice(0, 10)}`,
  ];
  if (s.lastSubscriptionUpdateAt !== null) {
    lines.push(`آخرین بروزرسانی: ${s.lastSubscriptionUpdateAt.toISOString().slice(0, 10)}`);
  }
  return lines;
}

/** True when the ticket carries at least one USER-supplied attachment — the
 * admin must be warned that its MIME/filename are untrusted and the file was
 * never inspected (§6). Admin-uploaded attachments are trusted and excluded. */
function ticketHasUntrustedAttachment(ticket: TicketWithMessages): boolean {
  return ticket.messages.some((m) => m.senderType === "USER" && hasAttachment(m));
}

export function detailText(ticket: TicketWithMessages, untrustedNotice?: string): string {
  // Header — the ONLY part with live <code> tags (bounded: an 8-char id, the
  // numeric telegram id, a Telegram-bounded username, a ≤100-char subject). It
  // is never truncated, so a live tag can never be split. The untrusted-file
  // warning lives HERE (not in the clampable body) so it can never be truncated
  // away when a ticket has many message previews.
  const header = [
    `تیکت 🎫 <code>${ticket.id.slice(0, 8)}</code>`,
    "",
    `کاربر: <code>${ticket.user.telegramId}</code>${
      ticket.user.username === null || ticket.user.username === ""
        ? ""
        : ` (@${escapeHtml(ticket.user.username)})`
    }`,
    `موضوع: ${escapeHtml(ticket.subject ?? "-")}`,
    ...categoryOriginLines(ticket),
    `وضعیت: ${TICKET_STATUS_LABEL[ticket.status]}`,
    `ایجاد: ${ticket.createdAt.toISOString().slice(0, 10)} | به‌روزرسانی: ${ticket.updatedAt.toISOString().slice(0, 10)}`,
  ];
  if (ticket.closedAt !== null) {
    header.push(
      `بسته شده: ${ticket.closedAt.toISOString().slice(0, 10)}${
        ticket.closedByAdminId === null ? "" : ` | ادمین: ${ticket.closedByAdminId.slice(0, 8)}`
      }`,
    );
  }
  if (
    untrustedNotice !== undefined &&
    untrustedNotice !== "" &&
    ticketHasUntrustedAttachment(ticket)
  ) {
    header.push("", escapeHtml(untrustedNotice));
  }
  // Body — the potentially unbounded part (the diagnostic summary + up to ten
  // 300-char message previews + a long linked service username). It is FULLY
  // escaped plain text (no live tags), so it can be safely clamped without
  // breaking parse_mode: HTML — the header is reserved first.
  const body = [...adminServiceLines(ticket), ...diagnosticSummaryLines(ticket), "", "پیام‌ها:"];
  for (const message of ticket.messages) {
    body.push(supportMessageLine("admin", message));
  }
  const headerText = header.join("\n");
  const bodyBudget = Math.max(0, SUPPORT_DETAIL_TEXT_MAX - headerText.length - 1);
  return `${headerText}\n${clampEscapedText(body.join("\n"), bodyBudget)}`;
}

async function renderDetail(ctx: BotContext, ticket: TicketWithMessages): Promise<void> {
  const sid = ticket.id.slice(0, 8);
  const kb = new InlineKeyboard();
  if (ticket.status !== "CLOSED") {
    kb.text("پاسخ دادن ✍️", ASUP_CB.reply(sid)).text("بستن تیکت ✅", ASUP_CB.close(sid)).row();
  }
  // One retrieval button per visible attachment (≤10 previews → ≤10 buttons).
  let attachmentButtons = 0;
  for (const message of ticket.messages) {
    if (attachmentButtons >= 10) {
      break;
    }
    const button = supportAttachmentButton("admin", sid, message);
    if (button !== null) {
      kb.text(button.label, button.data).row();
      attachmentButtons += 1;
    }
  }
  // Owner-scoped jump to the user's existing services list (surfaces the linked
  // service). Reuses the existing admin surface — no Service admin is duplicated.
  if (ticket.serviceId !== null && ticket.serviceId !== undefined) {
    kb.text("سرویس‌های کاربر 🛍", `admin:users:svc:${ticket.userId.slice(0, 8)}:1`).row();
  }
  kb.text("در انتظار ادمین ⏳", ASUP_CB.list("waiting_admin", 1))
    .row()
    .text("بازگشت به تیکت‌ها", ASUP_CB.root);
  // Fetch the operator-editable untrusted-file warning only when the ticket
  // actually carries a user attachment (§6 admin-facing notice).
  const untrustedNotice = ticketHasUntrustedAttachment(ticket)
    ? await getMessageTemplate("support_untrusted_attachment_notice")
    : undefined;
  await safeEditOrReply(ctx, detailText(ticket, untrustedNotice), kb, HTML);
}

async function renderList(
  ctx: BotContext,
  filter: AdminTicketFilter,
  page: number,
): Promise<void> {
  clearAdminSupportState(ctx);
  const pageData = await listAdminTickets(filter, page);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const ticket of pageData.tickets) {
    const subject = ticket.subject ?? "-";
    const short = subject.length > 22 ? `${subject.slice(0, 22)}…` : subject;
    const who =
      ticket.user.username === null || ticket.user.username === ""
        ? ticket.user.telegramId.toString()
        : `@${ticket.user.username}`;
    kb.text(
      `${TICKET_STATUS_ICON[ticket.status]} ${short} | ${who} | ${ticket.updatedAt.toISOString().slice(5, 10)}`,
      ASUP_CB.view(ticket.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", ASUP_CB.list(filter, pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, ASUP_CB.list(filter, pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", ASUP_CB.list(filter, pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به تیکت‌ها", ASUP_CB.root);
  await safeEditOrReply(
    ctx,
    pageData.total === 0
      ? `تیکت‌ها (${FILTER_LABEL[filter]}) 🎫\n\nتیکتی وجود ندارد.`
      : `تیکت‌ها (${FILTER_LABEL[filter]}) 🎫 — ${pageData.total} مورد`,
    kb,
  );
}

adminSupportHandler.callbackQuery(ASUP_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
});

adminSupportHandler.callbackQuery(ASUP_CB.cancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
});

adminSupportHandler.callbackQuery(
  /^admin:sup:list:(open|waiting_admin|waiting_user|closed):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    await renderList(ctx, ctx.match[1] as AdminTicketFilter, Number.parseInt(ctx.match[2], 10));
  },
);

adminSupportHandler.callbackQuery(/^admin:sup:view:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminSupportState(ctx);
  const ticket = await getAdminTicketDetail(ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, ticket);
});

adminSupportHandler.callbackQuery(/^admin:sup:reply:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const ticket = await getAdminTicketDetail(ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (ticket.status === "CLOSED") {
    await safeAnswerCallback(ctx, "این تیکت بسته شده است.");
    return;
  }
  ctx.session.temp.adminSupportReplyTicketId = ticket.id;
  ctx.session.currentFlow = REPLY_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `پاسخ پشتیبانی (متن حداکثر ${TICKET_MESSAGE_MAX} کاراکتر، یا یک تصویر / فایل):`,
    new InlineKeyboard().text("انصراف", ASUP_CB.view(ticket.id.slice(0, 8))),
  );
});

// Admin attachment retrieval — resolves the ticket + the exact message and
// re-sends the stored attachment (protected, generic caption, no file id).
adminSupportHandler.callbackQuery(/^admin:sup:att:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const attachment = await resolveAdminAttachment(ctx.match[1], ctx.match[2]);
  if (attachment === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  const sent = await sendSupportAttachment(ctx, attachment);
  if (!sent) {
    await safeReply(ctx, "این ضمیمه دیگر از طریق تلگرام قابل دریافت نیست.");
  }
});

adminSupportHandler.callbackQuery(/^admin:sup:close:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const ticket = await getAdminTicketDetail(ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (ticket.status === "CLOSED") {
    await safeAnswerCallback(ctx, "این تیکت قبلاً بسته شده است.");
    await renderDetail(ctx, ticket);
    return;
  }
  const sid = ticket.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `بستن تیکت <code>${sid}</code>\n\nموضوع: ${escapeHtml(ticket.subject ?? "-")}\n\nآیا مطمئن هستید؟`,
    new InlineKeyboard().text("بله، بستن تیکت ✅", ASUP_CB.closeYes(sid)).row().text("انصراف", ASUP_CB.view(sid)),
    HTML,
  );
});

adminSupportHandler.callbackQuery(/^admin:sup:close_yes:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const ticket = await getAdminTicketDetail(ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await closeSupportTicket(admin.id, ticket.id);
  await safeAnswerCallback(ctx, outcome.ok ? "تیکت بسته شد ✅" : outcome.safeMessage);
  if (outcome.ok) {
    await notifyUserTicketClosed(ctx.api, ticket.id);
  }
  const fresh = await getAdminTicketDetail(ctx.match[1]);
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});

// --- admin reply input (text / photo / document) ------------------------------------------------

export const adminSupportInputHandler = new Composer<BotContext>();

adminSupportInputHandler.on("message", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== REPLY_FLOW) {
    return next();
  }
  const message = ctx.message;
  if (message === undefined) {
    return next();
  }
  const settings = await loadSupportInputSettings();
  const input = extractSupportMessageInput(message as InboundMessageLike, settings);
  if (input.kind === "command") {
    clearAdminSupportState(ctx);
    return next();
  }
  const ticketId = ctx.session.temp.adminSupportReplyTicketId;
  if (ticketId === undefined) {
    clearAdminSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const cancelKb = new InlineKeyboard().text("انصراف", ASUP_CB.view(ticketId.slice(0, 8)));
  if (input.kind === "rejected") {
    void logSupportAttachmentRejected({
      operation: "admin_reply",
      senderType: "ADMIN",
      reason: input.reason,
      userId: admin.id,
      ticketId,
    });
    await safeReply(ctx, await renderSupportAttachmentRejection(input.reason, settings.maxBytes), cancelKb);
    return;
  }
  if (input.kind === "unsupported") {
    await safeReply(
      ctx,
      `پاسخ پشتیبانی (متن حداکثر ${TICKET_MESSAGE_MAX} کاراکتر، یا یک تصویر / فایل):`,
      cancelKb,
    );
    return;
  }
  const content =
    input.kind === "attachment"
      ? {
          text: input.caption,
          attachment: input.attachment,
          sourceUpdateId: BigInt(ctx.update.update_id),
          sourceMessageId: message.message_id,
        }
      : {
          text: input.text,
          sourceUpdateId: BigInt(ctx.update.update_id),
          sourceMessageId: message.message_id,
        };
  const outcome = await addAdminTicketReply(admin.id, { ticketId, content });
  if (!outcome.ok) {
    clearAdminSupportState(ctx);
    await safeReply(ctx, outcome.safeMessage);
    return;
  }
  clearAdminSupportState(ctx);
  if (input.kind === "attachment" && outcome.created !== false) {
    void logSupportAttachmentAccepted({
      operation: "admin_reply",
      senderType: "ADMIN",
      attachmentType: input.attachment.type,
      sizeBytes: input.attachment.sizeBytes,
      userId: admin.id,
      ticketId,
    });
  }
  if (outcome.created !== false) {
    await notifyUserAboutAdminReply(ctx.api, ticketId);
  }
  await safeReply(ctx, "پاسخ ثبت و برای کاربر ارسال شد ✅");
  const fresh = await getAdminTicketDetail(ticketId.slice(0, 8));
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});
