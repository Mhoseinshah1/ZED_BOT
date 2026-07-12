import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { getMessageTemplate } from "../../services/text.service.js";
import {
  addUserTicketReply,
  createSupportTicket,
  getUserTicketDetail,
  listUserTickets,
  notifyAdminsAboutNewTicket,
  notifyAdminsAboutUserReply,
  TICKET_CLOSED_TEXT,
  TICKET_MESSAGE_MAX,
  TICKET_STATUS_ICON,
  TICKET_STATUS_LABEL,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
  ticketMessagePreview,
  type TicketWithMessages,
} from "../../services/support-ticket.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «پشتیبانی 🎫» (Phase 32) - the user side of the ticket system, replacing
// the old placeholder page behind CB.USER_SUPPORT: landing, new-ticket
// wizard (subject -> message), owner-scoped list/detail and replies while
// the ticket is open. Admin notifications are fault-isolated and never
// undo a ticket write. Text-only (no attachments in this phase).
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const SUBJECT_FLOW = "support:subject";
const MESSAGE_FLOW = "support:message";
const REPLY_FLOW = "support:reply";

const SUP_CB = {
  new: "user:sup:new",
  cancel: "user:sup:cancel",
  list: (page: number): string => `user:sup:list:${page}`,
  view: (sid: string): string => `user:sup:view:${sid}`,
  reply: (sid: string): string => `user:sup:reply:${sid}`,
} as const;

export const supportHandler = new Composer<BotContext>();

/** Full Phase 32 user-support state cleanup (flow + draft). */
export function clearSupportState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow === SUBJECT_FLOW ||
    ctx.session.currentFlow === MESSAGE_FLOW ||
    ctx.session.currentFlow === REPLY_FLOW
  ) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.supportDraft;
}

async function renderLanding(ctx: BotContext): Promise<void> {
  clearSupportState(ctx);
  await safeAnswerCallback(ctx);
  const notice = await getMessageTemplate("support_text");
  const kb = new InlineKeyboard()
    .text("تیکت جدید ➕", SUP_CB.new)
    .row()
    .text("تیکت‌های من 🧾", SUP_CB.list(1))
    .row()
    .text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, `پشتیبانی 🎫\n\n${notice}`, kb);
}

function ticketDetailText(ticket: TicketWithMessages): string {
  const lines = [
    `تیکت 🎫 <code>${ticket.id.slice(0, 8)}</code>`,
    "",
    `موضوع: ${escapeHtml(ticket.subject ?? "-")}`,
    `وضعیت: ${TICKET_STATUS_LABEL[ticket.status]}`,
    `ایجاد: ${ticket.createdAt.toISOString().slice(0, 10)} | به‌روزرسانی: ${ticket.updatedAt.toISOString().slice(0, 10)}`,
  ];
  if (ticket.closedAt !== null) {
    lines.push(`بسته شده: ${ticket.closedAt.toISOString().slice(0, 10)}`);
  }
  lines.push("", "پیام‌ها:");
  for (const message of ticket.messages) {
    const label =
      message.senderType === "USER" ? "👤 شما" : message.senderType === "ADMIN" ? "👨‍💼 پشتیبانی" : "⚙️ سیستم";
    lines.push(`${label}: ${escapeHtml(ticketMessagePreview(message.text))}`);
  }
  return lines.join("\n");
}

async function renderDetail(ctx: BotContext, ticket: TicketWithMessages): Promise<void> {
  const sid = ticket.id.slice(0, 8);
  const kb = new InlineKeyboard();
  if (ticket.status !== "CLOSED") {
    kb.text("پاسخ دادن ✍️", SUP_CB.reply(sid)).row();
  }
  kb.text("تیکت‌های من 🧾", SUP_CB.list(1)).row().text("بازگشت به پشتیبانی", CB.USER_SUPPORT);
  await safeEditOrReply(ctx, ticketDetailText(ticket), kb, HTML);
}

async function renderList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearSupportState(ctx);
  const pageData = await listUserTickets(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const kb = new InlineKeyboard()
      .text("تیکت جدید ➕", SUP_CB.new)
      .row()
      .text("بازگشت به پشتیبانی", CB.USER_SUPPORT);
    await safeEditOrReply(
      ctx,
      `تیکت‌های من 🧾\n\n${await getMessageTemplate("no_tickets_text")}`,
      kb,
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const ticket of pageData.tickets) {
    const subject = ticket.subject ?? "-";
    const short = subject.length > 28 ? `${subject.slice(0, 28)}…` : subject;
    const tail =
      ticket.status === "CLOSED" ? "بسته" : ticket.updatedAt.toISOString().slice(5, 10);
    kb.text(
      `${TICKET_STATUS_ICON[ticket.status]} ${short} | ${tail}`,
      SUP_CB.view(ticket.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", SUP_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, SUP_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", SUP_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به پشتیبانی", CB.USER_SUPPORT);
  await safeEditOrReply(ctx, `تیکت‌های من 🧾 — ${pageData.total} تیکت`, kb);
}

supportHandler.callbackQuery(CB.USER_SUPPORT, async (ctx) => {
  await renderLanding(ctx);
  ctx.session.lastMenu = CB.USER_SUPPORT;
});

supportHandler.callbackQuery(SUP_CB.cancel, async (ctx) => {
  await renderLanding(ctx);
});

supportHandler.callbackQuery(SUP_CB.new, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  ctx.session.temp.supportDraft = {};
  ctx.session.currentFlow = SUBJECT_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `تیکت جدید ➕\n\nموضوع تیکت را وارد کنید. (${TICKET_SUBJECT_MIN} تا ${TICKET_SUBJECT_MAX} کاراکتر)`,
    new InlineKeyboard().text("انصراف", SUP_CB.cancel),
  );
});

supportHandler.callbackQuery(/^user:sup:list:(\d+)$/, async (ctx) => {
  await renderList(ctx, Number.parseInt(ctx.match[1], 10));
});

supportHandler.callbackQuery(/^user:sup:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearSupportState(ctx);
  const ticket = await getUserTicketDetail(user.id, ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, ticket);
});

supportHandler.callbackQuery(/^user:sup:reply:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const ticket = await getUserTicketDetail(user.id, ctx.match[1]);
  if (ticket === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (ticket.status === "CLOSED") {
    await safeAnswerCallback(ctx, TICKET_CLOSED_TEXT);
    return;
  }
  ctx.session.temp.supportDraft = { ticketId: ticket.id };
  ctx.session.currentFlow = REPLY_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `پاسخ شما (حداکثر ${TICKET_MESSAGE_MAX} کاراکتر):`,
    new InlineKeyboard().text("انصراف", SUP_CB.view(ticket.id.slice(0, 8))),
  );
});

// --- text inputs (subject / first message / reply) --------------------------------------------

export const supportTextHandler = new Composer<BotContext>();

supportTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (
    ctx.dbUser === null ||
    (flow !== SUBJECT_FLOW && flow !== MESSAGE_FLOW && flow !== REPLY_FLOW)
  ) {
    return next();
  }
  const user = ctx.dbUser;
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearSupportState(ctx);
    return next();
  }
  const draft = ctx.session.temp.supportDraft;
  if (draft === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const cancelKb = new InlineKeyboard().text("انصراف", SUP_CB.cancel);

  if (flow === SUBJECT_FLOW) {
    const subject = text.trim();
    if (subject.length < TICKET_SUBJECT_MIN || subject.length > TICKET_SUBJECT_MAX) {
      await safeReply(
        ctx,
        `موضوع تیکت باید بین ${TICKET_SUBJECT_MIN} تا ${TICKET_SUBJECT_MAX} کاراکتر باشد.`,
        cancelKb,
      );
      return;
    }
    draft.subject = subject;
    ctx.session.currentFlow = MESSAGE_FLOW;
    await safeReply(ctx, `متن پیام را بنویسید. (حداکثر ${TICKET_MESSAGE_MAX} کاراکتر)`, cancelKb);
    return;
  }

  if (flow === MESSAGE_FLOW) {
    if (draft.subject === undefined) {
      clearSupportState(ctx);
      await safeReply(ctx, DRAFT_EXPIRED_TEXT);
      return;
    }
    const outcome = await createSupportTicket(user.id, draft.subject, text);
    if (!outcome.ok) {
      await safeReply(ctx, outcome.safeMessage, cancelKb);
      return;
    }
    clearSupportState(ctx);
    await notifyAdminsAboutNewTicket(ctx.api, outcome.ticket.id);
    await safeReply(ctx, "تیکت شما ثبت شد ✅");
    const ticket = await getUserTicketDetail(user.id, outcome.ticket.id.slice(0, 8));
    if (ticket !== null) {
      await renderDetail(ctx, ticket);
    }
    return;
  }

  // REPLY_FLOW
  const ticketId = draft.ticketId;
  if (ticketId === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await addUserTicketReply(user.id, ticketId, text);
  if (!outcome.ok) {
    // Closed/invalid: leave the flow so the user is not stuck.
    clearSupportState(ctx);
    await safeReply(ctx, outcome.safeMessage);
    return;
  }
  clearSupportState(ctx);
  await notifyAdminsAboutUserReply(ctx.api, ticketId);
  await safeReply(ctx, "پاسخ شما ثبت شد ✅");
  const ticket = await getUserTicketDetail(user.id, ticketId.slice(0, 8));
  if (ticket !== null) {
    await renderDetail(ctx, ticket);
  }
});
