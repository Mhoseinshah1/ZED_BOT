import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  addAdminTicketReply,
  closeSupportTicket,
  getAdminTicketCounts,
  getAdminTicketDetail,
  listAdminTickets,
  notifyUserAboutAdminReply,
  notifyUserTicketClosed,
  TICKET_MESSAGE_MAX,
  TICKET_STATUS_ICON,
  TICKET_STATUS_LABEL,
  ticketMessagePreview,
  type AdminTicketFilter,
  type TicketWithMessages,
} from "../../services/support-ticket.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

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

function detailText(ticket: TicketWithMessages): string {
  const lines = [
    `تیکت 🎫 <code>${ticket.id.slice(0, 8)}</code>`,
    "",
    `کاربر: <code>${ticket.user.telegramId}</code>${
      ticket.user.username === null || ticket.user.username === ""
        ? ""
        : ` (@${escapeHtml(ticket.user.username)})`
    }`,
    `موضوع: ${escapeHtml(ticket.subject ?? "-")}`,
    `وضعیت: ${TICKET_STATUS_LABEL[ticket.status]}`,
    `ایجاد: ${ticket.createdAt.toISOString().slice(0, 10)} | به‌روزرسانی: ${ticket.updatedAt.toISOString().slice(0, 10)}`,
  ];
  if (ticket.closedAt !== null) {
    lines.push(
      `بسته شده: ${ticket.closedAt.toISOString().slice(0, 10)}${
        ticket.closedByAdminId === null ? "" : ` | ادمین: ${ticket.closedByAdminId.slice(0, 8)}`
      }`,
    );
  }
  lines.push("", "پیام‌ها:");
  for (const message of ticket.messages) {
    const label =
      message.senderType === "USER" ? "👤 کاربر" : message.senderType === "ADMIN" ? "👨‍💼 پشتیبانی" : "⚙️ سیستم";
    lines.push(`${label}: ${escapeHtml(ticketMessagePreview(message.text))}`);
  }
  return lines.join("\n");
}

async function renderDetail(ctx: BotContext, ticket: TicketWithMessages): Promise<void> {
  const sid = ticket.id.slice(0, 8);
  const kb = new InlineKeyboard();
  if (ticket.status !== "CLOSED") {
    kb.text("پاسخ دادن ✍️", ASUP_CB.reply(sid)).text("بستن تیکت ✅", ASUP_CB.close(sid)).row();
  }
  kb.text("در انتظار ادمین ⏳", ASUP_CB.list("waiting_admin", 1))
    .row()
    .text("بازگشت به تیکت‌ها", ASUP_CB.root);
  await safeEditOrReply(ctx, detailText(ticket), kb, HTML);
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
    `پاسخ پشتیبانی (حداکثر ${TICKET_MESSAGE_MAX} کاراکتر):`,
    new InlineKeyboard().text("انصراف", ASUP_CB.view(ticket.id.slice(0, 8))),
  );
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

// --- admin reply text input --------------------------------------------------------------------

export const adminSupportTextHandler = new Composer<BotContext>();

adminSupportTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== REPLY_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearAdminSupportState(ctx);
    return next();
  }
  const ticketId = ctx.session.temp.adminSupportReplyTicketId;
  if (ticketId === undefined) {
    clearAdminSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await addAdminTicketReply(admin.id, ticketId, text);
  if (!outcome.ok) {
    clearAdminSupportState(ctx);
    await safeReply(ctx, outcome.safeMessage);
    return;
  }
  clearAdminSupportState(ctx);
  await notifyUserAboutAdminReply(ctx.api, ticketId);
  await safeReply(ctx, "پاسخ ثبت و برای کاربر ارسال شد ✅");
  const fresh = await getAdminTicketDetail(ticketId.slice(0, 8));
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});
