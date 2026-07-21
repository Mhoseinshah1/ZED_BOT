import {
  clampEscapedText,
  SUPPORT_CAPTION_MAX,
  supportCategoryFromCallback,
  supportCategoryPrefersService,
  validateDiagnosticSnapshot,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logDiagnosticSnapshotAttached } from "../../services/service-diagnostics.service.js";
import {
  logSupportAttachmentAccepted,
  logSupportAttachmentRejected,
} from "../../services/support-attachment-log.service.js";
import {
  addUserTicketReply,
  createSupportTicket,
  getUserTicketDetail,
  listUserTickets,
  notifyAdminsAboutNewTicket,
  notifyAdminsAboutUserReply,
  resolveUserAttachment,
  type SupportMessageContent,
  TICKET_CLOSED_TEXT,
  TICKET_MESSAGE_MAX,
  TICKET_STATUS_ICON,
  TICKET_STATUS_LABEL,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
  type TicketWithMessages,
} from "../../services/support-ticket.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import {
  getOwnedServiceById,
  getOwnedServiceByShortId,
  listUserServices,
  serviceShortId,
} from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { statusLabel as serviceStatusLabel } from "../user-services/service-views.js";
import {
  extractSupportMessageInput,
  type InboundMessageLike,
  loadSupportInputSettings,
  renderSupportAttachmentRejection,
  type SupportInputSettings,
} from "./support-input.js";
import {
  SUPPORT_CATEGORY_BUTTON_KEY,
  supportAttachmentButton,
  supportCategoryLabel,
  supportMessageLine,
  sendSupportAttachment,
} from "./support-detail.js";

// =============================================================================
// «پشتیبانی 🎫» — the user side of the ticket system (Phase 32 + V2). Landing,
// the structured new-ticket wizard (category → optional owner-scoped Service →
// subject → text/photo/document), owner-scoped list/detail, replies with
// attachments, and safe attachment retrieval — all over the SAME ticket engine.
// Admin notifications are fault-isolated and never undo a ticket write.
// Attachments are Telegram file REFERENCES only (never bytes, never downloaded).
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const SUBJECT_AS_TEXT = "لطفاً موضوع تیکت را به صورت متن وارد کنید.";
const ATTACHMENT_SENT_FAIL = "این ضمیمه دیگر از طریق تلگرام قابل دریافت نیست.";
const HTML = { parseMode: "HTML" as const };
const SUBJECT_FLOW = "support:subject";
const MESSAGE_FLOW = "support:message";
const REPLY_FLOW = "support:reply";
/** Whole-detail budget kept safely under Telegram's 4096-char hard limit. */
const SUPPORT_DETAIL_TEXT_MAX = 3900;

const SUP_CB = {
  new: "user:sup:new",
  cancel: "user:sup:cancel",
  list: (page: number): string => `user:sup:list:${page}`,
  view: (sid: string): string => `user:sup:view:${sid}`,
  reply: (sid: string): string => `user:sup:reply:${sid}`,
  cat: (code: string): string => `user:sup:cat:${code}`,
  svcPage: (page: number): string => `user:sup:svc:${page}`,
  svcPick: (sid: string): string => `user:sup:svc:pick:${sid}`,
  svcNone: "user:sup:svc:none",
  svcLink: "user:sup:svc:link",
} as const;

export const supportHandler = new Composer<BotContext>();

/** Full user-support state cleanup (flow + draft + handoff contexts). */
export function clearSupportState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow === SUBJECT_FLOW ||
    ctx.session.currentFlow === MESSAGE_FLOW ||
    ctx.session.currentFlow === REPLY_FLOW
  ) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.supportDraft;
  // Connection-guide + service-diagnostics handoff contexts never outlive the
  // support flow.
  delete ctx.session.temp.guideSupportContext;
  delete ctx.session.temp.diagnosticSupportContext;
}

const cancelKeyboard = (): InlineKeyboard => new InlineKeyboard().text("انصراف", SUP_CB.cancel);

// --- landing + list ---------------------------------------------------------------------------

export async function buildSupportLandingKeyboard(): Promise<InlineKeyboard> {
  const [newTicket, myTickets] = await Promise.all([
    getButtonText("new_ticket"),
    getButtonText("my_tickets"),
  ]);
  return new InlineKeyboard()
    .text(newTicket, SUP_CB.new)
    .row()
    .text(myTickets, SUP_CB.list(1))
    .row()
    .text("بازگشت به منوی اصلی", CB.USER_MENU);
}

export async function renderSupportLanding(ctx: BotContext): Promise<void> {
  clearSupportState(ctx);
  delete ctx.session.temp.userTicketListPage;
  await safeAnswerCallback(ctx);
  const notice = await getMessageTemplate("support_landing_text");
  await safeEditOrReply(ctx, `پشتیبانی 🎫\n\n${notice}`, await buildSupportLandingKeyboard());
}

function ticketListPage(ctx: BotContext): number {
  const page = ctx.session.temp.userTicketListPage;
  return typeof page === "number" && page >= 1 ? page : 1;
}

async function renderList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  clearSupportState(ctx);
  const pageData = await listUserTickets(user.id, page);
  ctx.session.temp.userTicketListPage = pageData.page;
  await safeAnswerCallback(ctx);
  const backSupport = await getButtonText("back_to_support");
  if (pageData.total === 0) {
    const kb = new InlineKeyboard()
      .text(await getButtonText("new_ticket"), SUP_CB.new)
      .row()
      .text(backSupport, CB.USER_SUPPORT);
    await safeEditOrReply(
      ctx,
      `تیکت‌های من 📋\n\n${await getMessageTemplate("support_empty_tickets_text")}`,
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
      kb.text(await getButtonText("previous"), SUP_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, SUP_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text(await getButtonText("next"), SUP_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text(backSupport, CB.USER_SUPPORT);
  await safeEditOrReply(ctx, `تیکت‌های من 📋 — ${pageData.total} تیکت`, kb);
}

// --- ticket detail ----------------------------------------------------------------------------

/** The full, escaped + clamped user ticket-detail text. `missingServiceText` is
 * pre-fetched so this stays pure/testable. */
export function buildUserTicketDetailText(
  ticket: TicketWithMessages,
  missingServiceText: string,
): string {
  const header = [`تیکت 🎫 <code>${ticket.id.slice(0, 8)}</code>`, ""];
  header.push(`موضوع: ${escapeHtml(ticket.subject ?? "-")}`);
  const category = supportCategoryLabel(ticket.category);
  if (category !== null) {
    header.push(`دسته: ${category}`);
  }
  header.push(`وضعیت: ${TICKET_STATUS_LABEL[ticket.status]}`);
  header.push(
    `ایجاد: ${ticket.createdAt.toISOString().slice(0, 10)} | به‌روزرسانی: ${ticket.updatedAt.toISOString().slice(0, 10)}`,
  );
  if (ticket.closedAt !== null) {
    header.push(`بسته شده: ${ticket.closedAt.toISOString().slice(0, 10)}`);
  }
  if (ticket.serviceId !== null) {
    if (ticket.service !== null && ticket.service !== undefined) {
      header.push(
        `سرویس مرتبط: ${escapeHtml(ticket.service.username)} | وضعیت: ${serviceStatusLabel(ticket.service.status)}`,
      );
    } else {
      header.push(escapeHtml(missingServiceText));
    }
  }
  const body = ["", "پیام‌ها:"];
  for (const message of ticket.messages) {
    body.push(supportMessageLine("user", message));
  }
  const headerText = header.join("\n");
  const bodyBudget = Math.max(0, SUPPORT_DETAIL_TEXT_MAX - headerText.length - 1);
  return `${headerText}\n${clampEscapedText(body.join("\n"), bodyBudget)}`;
}

export async function buildTicketDetailKeyboard(
  ticket: TicketWithMessages,
  listPage: number,
): Promise<InlineKeyboard> {
  const sid = ticket.id.slice(0, 8);
  const [replyLabel, refreshLabel, myTickets, backSupport] = await Promise.all([
    getButtonText("reply_ticket"),
    getButtonText("refresh"),
    getButtonText("my_tickets"),
    getButtonText("back_to_support"),
  ]);
  const kb = new InlineKeyboard();
  if (ticket.status !== "CLOSED") {
    kb.text(replyLabel, SUP_CB.reply(sid)).row();
  }
  // One retrieval button per visible attachment (≤10 previews, so ≤10 buttons).
  let attachmentButtons = 0;
  for (const message of ticket.messages ?? []) {
    if (attachmentButtons >= 10) {
      break;
    }
    const button = supportAttachmentButton("user", sid, message);
    if (button !== null) {
      kb.text(button.label, button.data).row();
      attachmentButtons += 1;
    }
  }
  // Linked-Service jump (only when the relation is still resolvable).
  if (ticket.serviceId !== null && ticket.service !== null && ticket.service !== undefined) {
    kb.text(await getButtonText("support_view_service"), `user:svc:view:${serviceShortId(ticket.service)}`).row();
  }
  kb.text(refreshLabel, SUP_CB.view(sid)).row();
  kb.text(myTickets, SUP_CB.list(listPage)).row().text(backSupport, CB.USER_SUPPORT);
  return kb;
}

async function renderDetail(ctx: BotContext, ticket: TicketWithMessages): Promise<void> {
  const missing = await getMessageTemplate("support_linked_service_missing");
  await safeEditOrReply(
    ctx,
    buildUserTicketDetailText(ticket, missing),
    await buildTicketDetailKeyboard(ticket, ticketListPage(ctx)),
    HTML,
  );
}

// --- new-ticket wizard: category → optional service → subject → message -----------------------

async function renderCategorySelection(ctx: BotContext): Promise<void> {
  const [connection, payment, service, account, other] = await Promise.all([
    getButtonText(SUPPORT_CATEGORY_BUTTON_KEY.CONNECTION),
    getButtonText(SUPPORT_CATEGORY_BUTTON_KEY.PAYMENT),
    getButtonText(SUPPORT_CATEGORY_BUTTON_KEY.SERVICE_MANAGEMENT),
    getButtonText(SUPPORT_CATEGORY_BUTTON_KEY.ACCOUNT),
    getButtonText(SUPPORT_CATEGORY_BUTTON_KEY.OTHER),
  ]);
  const kb = new InlineKeyboard()
    .text(connection, SUP_CB.cat("c"))
    .row()
    .text(payment, SUP_CB.cat("p"))
    .row()
    .text(service, SUP_CB.cat("s"))
    .row()
    .text(account, SUP_CB.cat("a"))
    .row()
    .text(other, SUP_CB.cat("o"))
    .row()
    .text("انصراف", SUP_CB.cancel);
  await safeEditOrReply(
    ctx,
    `ایجاد تیکت جدید ➕\n\n${await getMessageTemplate("support_choose_category")}`,
    kb,
  );
}

async function promptServiceSelection(
  ctx: BotContext,
  userId: string,
  page: number,
): Promise<void> {
  const draft = ctx.session.temp.supportDraft;
  if (draft === undefined) {
    await renderSupportLanding(ctx);
    return;
  }
  const pageData = await listUserServices(userId, page);
  if (pageData.total === 0) {
    // No visible Services — skip straight to the subject step.
    await promptSubject(ctx);
    return;
  }
  draft.servicePage = pageData.page;
  const kb = new InlineKeyboard();
  for (const svc of pageData.services) {
    const label = svc.username.length > 40 ? `${svc.username.slice(0, 40)}…` : svc.username;
    kb.text(`🛍 ${label}`, SUP_CB.svcPick(serviceShortId(svc))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text(await getButtonText("previous"), SUP_CB.svcPage(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, SUP_CB.svcPage(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text(await getButtonText("next"), SUP_CB.svcPage(pageData.page + 1));
    }
    kb.row();
  }
  kb.text(await getButtonText("support_without_service"), SUP_CB.svcNone).row();
  kb.text("انصراف", SUP_CB.cancel);
  await safeEditOrReply(ctx, await getMessageTemplate("support_choose_service"), kb);
}

/** Renders (via edit) the subject prompt; offers an optional Service link for
 * categories that do not prompt for a Service up front. */
async function promptSubject(ctx: BotContext): Promise<void> {
  ctx.session.currentFlow = SUBJECT_FLOW;
  const draft = ctx.session.temp.supportDraft;
  const kb = new InlineKeyboard();
  if (
    draft?.category !== undefined &&
    !supportCategoryPrefersService(draft.category) &&
    draft.serviceId === undefined
  ) {
    kb.text(await getButtonText("support_link_service"), SUP_CB.svcLink).row();
  }
  kb.text("انصراف", SUP_CB.cancel);
  const prompt = await getMessageTemplate("support_subject_prompt", undefined, {
    min: TICKET_SUBJECT_MIN,
    max: TICKET_SUBJECT_MAX,
  });
  await safeEditOrReply(ctx, `ایجاد تیکت جدید ➕\n\n${prompt}`, kb);
}

/** Renders (via reply, after a text step) the message/attachment prompt. */
async function promptMessage(ctx: BotContext): Promise<void> {
  ctx.session.currentFlow = MESSAGE_FLOW;
  const prompt = await getMessageTemplate("support_message_or_attachment_prompt", undefined, {
    max: TICKET_MESSAGE_MAX,
    caption: SUPPORT_CAPTION_MAX,
  });
  await safeReply(ctx, prompt, cancelKeyboard());
}

supportHandler.callbackQuery(CB.USER_SUPPORT, async (ctx) => {
  await renderSupportLanding(ctx);
  ctx.session.lastMenu = CB.USER_SUPPORT;
});

supportHandler.callbackQuery(SUP_CB.cancel, async (ctx) => {
  await renderSupportLanding(ctx);
});

supportHandler.callbackQuery(SUP_CB.new, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  ctx.session.currentFlow = null;
  ctx.session.temp.supportDraft = {};
  await safeAnswerCallback(ctx);
  await renderCategorySelection(ctx);
});

// Direct Service → Support entry (from a Service detail page). Seeds a fresh
// wizard bound to the EXACT owner-scoped Service, then asks for the category.
supportHandler.callbackQuery(/^user:svc:support:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  // The handoff-cancel middleware already dropped any stale guide/diag handoff.
  ctx.session.currentFlow = null;
  ctx.session.temp.supportDraft = { serviceId: service.id, origin: "SERVICE_DETAIL" };
  await renderCategorySelection(ctx);
});

supportHandler.callbackQuery(/^user:sup:cat:([a-z])$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const category = supportCategoryFromCallback(ctx.match[1]);
  const draft = ctx.session.temp.supportDraft;
  if (category === null || draft === undefined) {
    await safeAnswerCallback(ctx);
    await renderCategorySelection(ctx);
    return;
  }
  draft.category = category;
  draft.origin = draft.origin ?? "GENERAL";
  await safeAnswerCallback(ctx);
  if (draft.serviceId !== undefined) {
    // A Service is already bound (direct-entry) — go straight to the subject.
    await promptSubject(ctx);
    return;
  }
  if (supportCategoryPrefersService(category)) {
    await promptServiceSelection(ctx, user.id, 1);
    return;
  }
  await promptSubject(ctx);
});

/**
 * The active NEW-TICKET wizard draft, or undefined. A reply draft carries a
 * `ticketId`; a service-picker button is only valid inside the new-ticket
 * wizard, so a stale picker button tapped during an in-progress REPLY (or with
 * no draft at all) must NOT open the picker or call promptSubject — that would
 * silently convert the reply into a new-ticket flow.
 */
function activeWizardDraft(ctx: BotContext): NonNullable<typeof ctx.session.temp.supportDraft> | undefined {
  const draft = ctx.session.temp.supportDraft;
  return draft !== undefined && draft.ticketId === undefined ? draft : undefined;
}

supportHandler.callbackQuery(/^user:sup:svc:pick:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  const draft = activeWizardDraft(ctx);
  if (user === null || draft === undefined) {
    await safeAnswerCallback(ctx);
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  await safeAnswerCallback(ctx);
  if (service === null) {
    // Stale/foreign pick — re-render the picker.
    await promptServiceSelection(ctx, user.id, draft.servicePage ?? 1);
    return;
  }
  draft.serviceId = service.id;
  await promptSubject(ctx);
});

supportHandler.callbackQuery(SUP_CB.svcNone, async (ctx) => {
  const draft = activeWizardDraft(ctx);
  await safeAnswerCallback(ctx);
  if (draft === undefined) {
    // No active wizard (a stale button during a reply / after expiry): never
    // hijack the current flow — just acknowledge the tap.
    return;
  }
  delete draft.serviceId;
  await promptSubject(ctx);
});

supportHandler.callbackQuery(SUP_CB.svcLink, async (ctx) => {
  const user = ctx.dbUser;
  await safeAnswerCallback(ctx);
  if (user === null || activeWizardDraft(ctx) === undefined) {
    return;
  }
  await promptServiceSelection(ctx, user.id, 1);
});

supportHandler.callbackQuery(/^user:sup:svc:(\d+)$/, async (ctx) => {
  const user = ctx.dbUser;
  await safeAnswerCallback(ctx);
  if (user === null || activeWizardDraft(ctx) === undefined) {
    return;
  }
  await promptServiceSelection(ctx, user.id, Number.parseInt(ctx.match[1], 10));
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
    await getMessageTemplate("support_message_or_attachment_prompt", undefined, {
      max: TICKET_MESSAGE_MAX,
      caption: SUPPORT_CAPTION_MAX,
    }),
    new InlineKeyboard().text("انصراف", SUP_CB.view(ticket.id.slice(0, 8))),
  );
});

// --- attachment retrieval ---------------------------------------------------------------------

supportHandler.callbackQuery(/^user:sup:att:([0-9a-f-]+):([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const attachment = await resolveUserAttachment(user.id, ctx.match[1], ctx.match[2]);
  if (attachment === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  const sent = await sendSupportAttachment(ctx, attachment);
  if (!sent) {
    await safeReply(ctx, ATTACHMENT_SENT_FAIL);
  }
});

// --- unified message input (text / photo / document) ------------------------------------------

export const supportInputHandler = new Composer<BotContext>();

supportInputHandler.on("message", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  const user = ctx.dbUser;
  if (
    user === null ||
    (flow !== SUBJECT_FLOW && flow !== MESSAGE_FLOW && flow !== REPLY_FLOW)
  ) {
    return next();
  }
  const message = ctx.message;
  if (message === undefined) {
    return next();
  }
  const settings = await loadSupportInputSettings();
  const input = extractSupportMessageInput(message as InboundMessageLike, settings);
  if (input.kind === "command") {
    clearSupportState(ctx);
    return next();
  }
  const draft = ctx.session.temp.supportDraft;
  if (draft === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  if (flow === SUBJECT_FLOW) {
    await handleSubjectInput(ctx, input);
    return;
  }
  if (flow === MESSAGE_FLOW) {
    await handleMessageInput(ctx, user.id, input, settings);
    return;
  }
  await handleReplyInput(ctx, user.id, input, settings);
});

type SupportInput = ReturnType<typeof extractSupportMessageInput>;

async function handleSubjectInput(ctx: BotContext, input: SupportInput): Promise<void> {
  const draft = ctx.session.temp.supportDraft;
  if (draft === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  if (input.kind !== "text") {
    await safeReply(ctx, SUBJECT_AS_TEXT, cancelKeyboard());
    return;
  }
  const subject = input.text.trim();
  if (subject.length < TICKET_SUBJECT_MIN || subject.length > TICKET_SUBJECT_MAX) {
    await safeReply(
      ctx,
      `موضوع تیکت باید بین ${TICKET_SUBJECT_MIN} تا ${TICKET_SUBJECT_MAX} کاراکتر باشد.`,
      cancelKeyboard(),
    );
    return;
  }
  draft.subject = subject;
  await promptMessage(ctx);
}

/** Turns a validated input into the message content (with the inbound update_id
 * as the idempotency key), or null for a non-content input (handled by caller). */
function contentFromInput(ctx: BotContext, input: SupportInput): SupportMessageContent | null {
  const sourceUpdateId = BigInt(ctx.update.update_id);
  const sourceMessageId = ctx.message?.message_id;
  if (input.kind === "text") {
    return { text: input.text, sourceUpdateId, sourceMessageId };
  }
  if (input.kind === "attachment") {
    return { text: input.caption, attachment: input.attachment, sourceUpdateId, sourceMessageId };
  }
  return null;
}

async function replyToNonContentInput(
  ctx: BotContext,
  input: SupportInput,
  settings: SupportInputSettings,
  operation: "new_ticket" | "user_reply",
  userId: string,
  ticketId: string | null,
): Promise<void> {
  if (input.kind === "rejected") {
    // §25 privacy-safe: record the typed rejection CODE only (never content).
    void logSupportAttachmentRejected({
      operation,
      senderType: "USER",
      reason: input.reason,
      userId,
      ticketId,
    });
    await safeReply(ctx, await renderSupportAttachmentRejection(input.reason, settings.maxBytes), cancelKeyboard());
    return;
  }
  // unsupported (sticker / voice / video / empty): re-prompt.
  await safeReply(
    ctx,
    await getMessageTemplate("support_message_or_attachment_prompt", undefined, {
      max: TICKET_MESSAGE_MAX,
      caption: SUPPORT_CAPTION_MAX,
    }),
    cancelKeyboard(),
  );
}

async function handleMessageInput(
  ctx: BotContext,
  userId: string,
  input: SupportInput,
  settings: SupportInputSettings,
): Promise<void> {
  const content = contentFromInput(ctx, input);
  if (content === null) {
    await replyToNonContentInput(ctx, input, settings, "new_ticket", userId, null);
    return;
  }
  const draft = ctx.session.temp.supportDraft;
  if (draft?.subject === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  // CLAIM the whole handoff synchronously (flow + draft + diagnostic context)
  // BEFORE any await, so a repeated/concurrent submission can never create a
  // second ticket. Restored only on creation failure.
  const claimedSubject = draft.subject;
  const claimedCategory = draft.category ?? null;
  const claimedOrigin = draft.origin ?? "GENERAL";
  const draftServiceId = draft.serviceId ?? null;
  const diagContext = ctx.session.temp.diagnosticSupportContext;
  ctx.session.currentFlow = null;
  delete ctx.session.temp.supportDraft;
  delete ctx.session.temp.diagnosticSupportContext;
  delete ctx.session.temp.guideSupportContext;
  const restoreClaim = (): void => {
    ctx.session.currentFlow = MESSAGE_FLOW;
    ctx.session.temp.supportDraft = draft;
    if (diagContext !== undefined) {
      ctx.session.temp.diagnosticSupportContext = diagContext;
    }
  };

  let attachedDiagServiceId: string | null = null;
  let outcome: Awaited<ReturnType<typeof createSupportTicket>>;
  try {
    let serviceId: string | null = null;
    let diagnosticSnapshot: unknown;
    if (diagContext !== undefined) {
      // Diagnostics handoff: re-resolve owner + re-validate the STRICT snapshot.
      // The attachment metadata never enters the snapshot.
      const owned = await getOwnedServiceById(diagContext.serviceId, userId);
      const safeSnapshot = validateDiagnosticSnapshot(diagContext.snapshot);
      if (owned !== null && safeSnapshot !== null && owned.id === diagContext.serviceId) {
        serviceId = owned.id;
        diagnosticSnapshot = safeSnapshot;
        attachedDiagServiceId = owned.id;
      }
    } else if (draftServiceId !== null) {
      // Wizard / direct-entry / guide handoff: re-resolve the linked Service
      // owner-scoped; a stale/foreign id silently drops the link.
      const owned = await getOwnedServiceById(draftServiceId, userId);
      if (owned !== null) {
        serviceId = owned.id;
      }
    }
    outcome = await createSupportTicket({
      userId,
      subject: claimedSubject,
      content,
      category: claimedCategory,
      origin: claimedOrigin,
      serviceId,
      diagnosticSnapshot,
    });
  } catch (err) {
    restoreClaim();
    throw err;
  }
  if (!outcome.ok) {
    restoreClaim();
    await safeReply(ctx, outcome.safeMessage, cancelKeyboard());
    return;
  }
  clearSupportState(ctx);
  if (attachedDiagServiceId !== null && outcome.created !== false) {
    void logDiagnosticSnapshotAttached(userId, attachedDiagServiceId);
  }
  if (input.kind === "attachment" && outcome.created !== false) {
    // §25 privacy-safe: aggregate accepted-attachment event (bucketed size only).
    void logSupportAttachmentAccepted({
      operation: "new_ticket",
      senderType: "USER",
      attachmentType: input.attachment.type,
      sizeBytes: input.attachment.sizeBytes,
      category: claimedCategory,
      origin: claimedOrigin,
      userId,
      ticketId: outcome.ticket.id,
    });
  }
  if (outcome.created !== false) {
    await notifyAdminsAboutNewTicket(ctx.api, outcome.ticket.id);
  }
  await safeReply(ctx, await getMessageTemplate("support_ticket_created_text"));
  const ticket = await getUserTicketDetail(userId, outcome.ticket.id.slice(0, 8));
  if (ticket !== null) {
    await renderDetail(ctx, ticket);
  }
}

async function handleReplyInput(
  ctx: BotContext,
  userId: string,
  input: SupportInput,
  settings: SupportInputSettings,
): Promise<void> {
  const draftForReject = ctx.session.temp.supportDraft;
  const content = contentFromInput(ctx, input);
  if (content === null) {
    await replyToNonContentInput(
      ctx,
      input,
      settings,
      "user_reply",
      userId,
      draftForReject?.ticketId ?? null,
    );
    return;
  }
  const draft = ctx.session.temp.supportDraft;
  const ticketId = draft?.ticketId;
  if (ticketId === undefined) {
    clearSupportState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await addUserTicketReply(userId, { ticketId, content });
  if (!outcome.ok) {
    clearSupportState(ctx);
    await safeReply(ctx, outcome.safeMessage);
    return;
  }
  clearSupportState(ctx);
  if (input.kind === "attachment" && outcome.created !== false) {
    void logSupportAttachmentAccepted({
      operation: "user_reply",
      senderType: "USER",
      attachmentType: input.attachment.type,
      sizeBytes: input.attachment.sizeBytes,
      userId,
      ticketId,
    });
  }
  if (outcome.created !== false) {
    await notifyAdminsAboutUserReply(ctx.api, ticketId);
  }
  await safeReply(ctx, "پاسخ شما ثبت شد ✅");
  const ticket = await getUserTicketDetail(userId, ticketId.slice(0, 8));
  if (ticket !== null) {
    await renderDetail(ctx, ticket);
  }
}
