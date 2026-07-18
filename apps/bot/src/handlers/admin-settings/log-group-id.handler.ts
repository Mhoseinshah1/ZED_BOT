import {
  LogDeliveryStatus,
  LogGroupSetupStatus,
  Prisma,
  prisma,
  type LogGroupSetupAttempt,
} from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import type { BotContext } from "../../core/context.js";
import {
  attemptShortId,
  auditLogGroupConnection,
  cancelSetupAttempt,
  confirmLogGroupConnection,
  createLogGroupSetupAttempt,
  getSetupAttemptByShortId,
  prepareLogGroupConnection,
  SETUP_ALREADY_RUNNING_TEXT,
  SETUP_QUEUE_UNAVAILABLE_TEXT,
  type LogGroupProbeApi,
} from "../../services/log-group-connection.service.js";
import { maskChatId } from "../../services/log-group.service.js";
import { enqueueLogGroupSetup } from "../../services/ops-queue.service.js";
import { OPS_EVENTS } from "../../services/system-log.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { LG_CB, renderLogGroupPage } from "./log-group.handler.js";

// =============================================================================
// Direct numeric-ID log-group setup - the ADMIN UI on top of the shared
// connection service (log-group-connection.service.ts). The OWNER pastes a
// supergroup chat id; the bot validates it against the ONE shared policy
// (prepareLogGroupConnection -> evaluateLogGroupTarget), shows a masked
// confirmation preview, and on confirm enqueues a durable worker provisioning
// job (11 forum topics + a direct SYSTEM test). The active group is NEVER
// overwritten until the worker finishes, so a failed setup leaves the previous
// destination working. Every mutation callback re-validates OWNER; the chat id
// NEVER travels in callback data (only the attempt short id does) and never
// appears unmasked in any page. All Telegram failures arrive as the shared
// safe Persian messages - raw API descriptions never reach the admin.
// =============================================================================

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const ATTEMPT_NOT_FOUND_TEXT = "عملیات راه‌اندازی پیدا نشد.";

/** currentFlow sentinel for the bounded OWNER numeric-ID input flow. */
export const LOG_GROUP_ID_FLOW = "lg:chat_id";

const PROMPT_TEXT = [
  "آیدی عددی سوپرگروه لاگ را ارسال کنید.",
  "",
  "نمونه:",
  "-1001234567890",
  "",
  "قبل از ارسال آیدی، ربات را داخل گروه اضافه کنید، مدیر کنید و دسترسی مدیریت موضوعات را فعال کنید.",
].join("\n");

const PUBLIC_WARNING_TEXT = [
  "⚠️ این گروه عمومی است.",
  "",
  "لاگ‌های عملیاتی ممکن است شامل اطلاعات مدیریتی باشند. استفاده از گروه خصوصی پیشنهاد می‌شود.",
].join("\n");

const REPLACEMENT_WARNING =
  "⚠️ گروه لاگ فعلی تا پایان راه‌اندازی گروه جدید فعال باقی می‌ماند.\n\nپس از موفقیت، گروه جدید جایگزین می‌شود.\n\n";

// --- callback shapes (chat id is NEVER carried here - only the attempt sid) --

/** Start the numeric-ID input flow (both «اتصال…» and «تغییر…»). */
const CB_ID = LG_CB.id;
/** Clear the flow and return to the root page. */
const CB_ID_CANCEL = "admin:lg:id_cancel";
const pubokCb = (sid: string): string => `admin:lg:id_pubok:${sid}`;
const confirmCb = (sid: string): string => `admin:lg:id_confirm:${sid}`;
const opCb = (sid: string): string => `admin:lg:op:${sid}`;
const retryCb = (sid: string): string => `admin:lg:id_retry:${sid}`;
const cancelOpCb = (sid: string): string => `admin:lg:id_cancel_op:${sid}`;

export const logGroupIdHandler = new Composer<BotContext>();

function isOwner(ctx: BotContext): boolean {
  return ctx.admin?.role === "OWNER";
}

/** Clears the numeric-ID flow + its draft (idempotent). */
function clearFlow(ctx: BotContext): void {
  if (ctx.session.currentFlow === LOG_GROUP_ID_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminLogGroupSetupDraft;
}

/**
 * Adapts the live grammY api into the minimal probe surface the shared policy
 * needs - crucially it supplies the bot id (ctx.me), without which the probe
 * cannot read the bot's own membership/rights.
 */
function buildProbeApi(ctx: BotContext): LogGroupProbeApi {
  return {
    getChat: (chatId) => ctx.api.getChat(chatId),
    getChatMember: (chatId, userId) => ctx.api.getChatMember(chatId, userId),
    me: { id: ctx.me.id },
  };
}

function inputKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("انصراف", CB_ID_CANCEL)
    .row()
    .text("بازگشت به تنظیمات گروه لاگ", LG_CB.root);
}

function publicWarningKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("ادامه با گروه عمومی", pubokCb(sid))
    .row()
    .text("انصراف", CB_ID_CANCEL);
}

/** The masked confirmation preview (replacement warning when a group exists). */
function buildPreview(attempt: LogGroupSetupAttempt): { text: string; keyboard: InlineKeyboard } {
  const sid = attemptShortId(attempt.id);
  const body = [
    "📝 تایید اتصال گروه لاگ",
    "",
    "نام گروه:",
    attempt.safeTitle,
    "",
    "آیدی گروه:",
    maskChatId(String(attempt.chatId)),
    "",
    "نوع:",
    "سوپرگروه",
    "",
    "موضوعات:",
    "فعال ✅",
    "",
    "دسترسی ربات:",
    "کامل ✅",
    "",
    "تعداد تاپیک‌های قابل ساخت:",
    String(OPS_LOG_TOPIC_KEYS.length),
    "",
    "پس از تایید، تاپیک‌های پیش‌فرض ساخته می‌شوند و ارسال لاگ آغاز خواهد شد.",
  ].join("\n");
  // previousChatId was captured at creation from the then-active group, so a
  // non-null value means confirming here REPLACES a live binding.
  const prefix = attempt.previousChatId !== null ? REPLACEMENT_WARNING : "";
  const keyboard = new InlineKeyboard()
    .text("تایید و راه‌اندازی گروه ✅", confirmCb(sid))
    .row()
    .text("وارد کردن آیدی دیگر", CB_ID)
    .row()
    .text("انصراف", CB_ID_CANCEL);
  return { text: prefix + body, keyboard };
}

// --- progress / status page --------------------------------------------------

/** Verdict of the queued LOG_GROUP_CONNECTED delivery (end-to-end proof). */
type DeliveryState = "sent" | "pending" | "failed";

/**
 * Reads the newest queued LOG_GROUP_CONNECTED log's delivery status - the
 * normal ops-log path the worker emits right after activation, so a SENT here
 * proves the whole pipeline (persist -> delivery row -> queue -> Telegram).
 */
async function readConnectedDeliveryState(): Promise<DeliveryState> {
  try {
    const log = await prisma.systemLog.findFirst({
      where: { eventType: OPS_EVENTS.LOG_GROUP_CONNECTED },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (log === null) {
      return "pending";
    }
    const delivery = await prisma.systemLogDelivery.findFirst({
      where: { systemLogId: log.id },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    if (delivery === null) {
      return "pending";
    }
    if (delivery.status === LogDeliveryStatus.SENT) {
      return "sent";
    }
    if (
      delivery.status === LogDeliveryStatus.FAILED ||
      delivery.status === LogDeliveryStatus.DEAD_LETTER
    ) {
      return "failed";
    }
    return "pending"; // PENDING / SENDING / SKIPPED
  } catch {
    return "pending";
  }
}

function deliveryLine(state: DeliveryState): string {
  switch (state) {
    case "sent":
      return "ارسال از صف لاگ: موفق ✅";
    case "failed":
      return "ارسال از صف لاگ: خطا";
    case "pending":
      return "ارسال از صف لاگ: در انتظار";
  }
}

/** Non-terminal status line for the in-progress page. */
function nonTerminalStatusLine(status: LogGroupSetupStatus): string {
  switch (status) {
    case LogGroupSetupStatus.PROVISIONING:
      return "وضعیت: در حال ساخت تاپیک‌ها…";
    case LogGroupSetupStatus.TESTING:
      return "وضعیت: در حال ارسال پیام آزمایشی…";
    default:
      // VALIDATED / QUEUED (and any unexpected non-terminal) queue up.
      return "وضعیت: در صف…";
  }
}

/**
 * Safe failure category from the worker's safeErrorCode - never a raw
 * Telegram description. Codes come from apps/worker/src/telegram.ts and the
 * confirm rollback ("redis-unavailable").
 */
function failureCategory(code: string | null): string {
  switch (code) {
    case "chat-not-found":
      return "گروه در دسترس نیست";
    case "forbidden":
    case "bad-request":
      return "دسترسی مدیریت موضوعات ناقص است";
    case "topic-missing":
      return "ساخت تاپیک ناموفق بود";
    case "rate-limited":
      return "ارسال آزمایشی ناموفق بود";
    case "bot-token-missing":
    case "network-error":
    case "bad-response":
      return "Worker در دسترس نیست";
    case "redis-unavailable":
      return "Redis در دسترس نیست";
    default:
      if (code !== null && code.startsWith("telegram-")) {
        return "گروه در دسترس نیست";
      }
      return "خطای پایگاه داده";
  }
}

async function buildProgressView(
  attempt: LogGroupSetupAttempt,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const sid = attemptShortId(attempt.id);
  const total = OPS_LOG_TOPIC_KEYS.length;
  const createdLine = `تاپیک‌های ساخته‌شده: ${attempt.createdTopicCount} از ${total}`;

  if (attempt.status === LogGroupSetupStatus.ACTIVE) {
    const delivery = await readConnectedDeliveryState();
    const lines = [
      "گروه لاگ با موفقیت راه‌اندازی شد ✅",
      "",
      `${attempt.createdTopicCount} تاپیک پیش‌فرض ساخته یا بازیابی شد و ارسال لاگ فعال است.`,
      "",
      deliveryLine(delivery),
    ];
    if (delivery !== "sent") {
      lines.push("", "گروه متصل شد، اما ارسال آزمایشی از صف هنوز تایید نشده است ⚠️");
    }
    const keyboard = new InlineKeyboard()
      .text("ارسال پیام آزمایشی", LG_CB.test)
      .row()
      .text("مدیریت موضوعات", LG_CB.topics)
      .row()
      .text("بازگشت به تنظیمات گروه لاگ", LG_CB.root);
    return { text: lines.join("\n"), keyboard };
  }

  if (attempt.status === LogGroupSetupStatus.FAILED) {
    const lines = [
      "راه‌اندازی گروه لاگ کامل نشد ❌",
      "",
      "اتصال قبلی تغییری نکرده است.",
      "",
      `علت: ${failureCategory(attempt.safeErrorCode)}`,
    ];
    const keyboard = new InlineKeyboard()
      .text("تلاش مجدد", retryCb(sid))
      .row()
      .text("وارد کردن آیدی دیگر", CB_ID)
      .row()
      .text("مشاهده وضعیت", opCb(sid))
      .row()
      .text("انصراف", CB_ID_CANCEL);
    return { text: lines.join("\n"), keyboard };
  }

  if (attempt.status === LogGroupSetupStatus.CANCELLED) {
    const keyboard = new InlineKeyboard()
      .text("وارد کردن آیدی دیگر", CB_ID)
      .row()
      .text("بازگشت به تنظیمات گروه لاگ", LG_CB.root);
    return {
      text: "عملیات راه‌اندازی گروه لاگ لغو شد.\n\nاتصال قبلی تغییری نکرده است.",
      keyboard,
    };
  }

  // Non-terminal: keep refreshing.
  const lines = [
    "راه‌اندازی گروه لاگ آغاز شد ⏳",
    "",
    "در حال بررسی دسترسی‌ها و ساخت تاپیک‌های پیش‌فرض هستیم.",
    "",
    nonTerminalStatusLine(attempt.status),
    createdLine,
  ];
  const keyboard = new InlineKeyboard()
    .text("بررسی وضعیت ♻️", opCb(sid))
    .row()
    .text("لغو عملیات", cancelOpCb(sid))
    .row()
    .text("بازگشت", LG_CB.root);
  return { text: lines.join("\n"), keyboard };
}

/**
 * Re-enqueues a FAILED attempt (retry). Reuses the same durable row and its
 * already-staged topicBindings (the worker resumes, never recreating). Guards
 * the single active-setup slot: a P2002 on activeSlot means another setup is
 * running. Mirrors confirmLogGroupConnection's claim/enqueue/rollback so the
 * DB stays authoritative.
 */
async function requeueFailedAttempt(
  attemptId: string,
): Promise<{ ok: boolean; safeMessage?: string; attempt?: LogGroupSetupAttempt }> {
  const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
  if (attempt === null) {
    return { ok: false, safeMessage: ATTEMPT_NOT_FOUND_TEXT };
  }
  // Only a FAILED attempt is re-enqueueable; a running/active one converges to
  // its own live state (idempotent).
  if (attempt.status !== LogGroupSetupStatus.FAILED) {
    return { ok: true, attempt };
  }
  let claimed: LogGroupSetupAttempt;
  try {
    const updated = await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.FAILED },
      data: {
        status: LogGroupSetupStatus.QUEUED,
        activeSlot: 1,
        safeErrorCode: null,
        failedAt: null,
      },
    });
    if (updated.count === 0) {
      const fresh = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
      return fresh === null
        ? { ok: false, safeMessage: ATTEMPT_NOT_FOUND_TEXT }
        : { ok: true, attempt: fresh };
    }
    claimed = (await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } }))!;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, safeMessage: SETUP_ALREADY_RUNNING_TEXT };
    }
    throw err;
  }
  const enqueued = await enqueueLogGroupSetup(attemptId);
  if (!enqueued) {
    // Free the slot so a later retry is not blocked once Redis is back.
    await prisma.logGroupSetupAttempt.updateMany({
      where: { id: attemptId, status: LogGroupSetupStatus.QUEUED },
      data: {
        status: LogGroupSetupStatus.FAILED,
        activeSlot: null,
        safeErrorCode: "redis-unavailable",
        failedAt: new Date(),
      },
    });
    return { ok: false, safeMessage: SETUP_QUEUE_UNAVAILABLE_TEXT };
  }
  return { ok: true, attempt: claimed };
}

// --- callbacks ---------------------------------------------------------------

// «اتصال با آیدی عددی گروه 🔢» / «تغییر گروه با آیدی عددی 🔄» / «وارد کردن آیدی
// دیگر»: start (or restart) the bounded OWNER input flow.
logGroupIdHandler.callbackQuery(CB_ID, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  ctx.session.currentFlow = LOG_GROUP_ID_FLOW;
  ctx.session.temp.adminLogGroupSetupDraft = {};
  await safeAnswerCallback(ctx);
  await auditLogGroupConnection("log_group.id_flow_started", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
  });
  await safeEditOrReply(ctx, PROMPT_TEXT, inputKeyboard());
});

logGroupIdHandler.callbackQuery(CB_ID_CANCEL, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearFlow(ctx);
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await renderLogGroupPage(ctx, "لغو شد.");
});

// «ادامه با گروه عمومی»: acknowledged the public-group warning -> normal preview.
logGroupIdHandler.callbackQuery(/^admin:lg:id_pubok:([0-9a-f]{4,12})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const attempt = await getSetupAttemptByShortId(ctx.match[1]);
  if (attempt === null) {
    await safeAnswerCallback(ctx, ATTEMPT_NOT_FOUND_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await auditLogGroupConnection("log_group.confirm_requested", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
    attemptId: attempt.id,
    chatId: attempt.chatId,
  });
  const view = buildPreview(attempt);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// «تایید و راه‌اندازی گروه ✅»: revalidate (in confirmLogGroupConnection),
// claim the single slot, enqueue, then show the live progress page.
logGroupIdHandler.callbackQuery(/^admin:lg:id_confirm:([0-9a-f]{4,12})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const attempt = await getSetupAttemptByShortId(ctx.match[1]);
  if (attempt === null) {
    await safeAnswerCallback(ctx, ATTEMPT_NOT_FOUND_TEXT);
    return;
  }
  const result = await confirmLogGroupConnection(
    buildProbeApi(ctx),
    attempt.id,
    Number(admin.telegramId),
  );
  if (!result.ok || result.attempt === undefined) {
    const msg = result.safeMessage ?? ATTEMPT_NOT_FOUND_TEXT;
    await safeAnswerCallback(ctx, msg);
    const sid = attemptShortId(attempt.id);
    await safeEditOrReply(
      ctx,
      `راه‌اندازی گروه لاگ\n\n${msg}`,
      new InlineKeyboard()
        .text("مشاهده وضعیت", opCb(sid))
        .row()
        .text("وارد کردن آیدی دیگر", CB_ID)
        .row()
        .text("انصراف", CB_ID_CANCEL),
    );
    return;
  }
  // Answer immediately - provisioning happens in the worker, nothing blocks.
  await safeAnswerCallback(ctx, "راه‌اندازی گروه لاگ آغاز شد ⏳");
  await auditLogGroupConnection("log_group.setup_queued", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
    attemptId: result.attempt.id,
    chatId: result.attempt.chatId,
  });
  const view = await buildProgressView(result.attempt);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// «بررسی وضعیت ♻️» / «مشاهده وضعیت»: the live progress/status page.
logGroupIdHandler.callbackQuery(/^admin:lg:op:([0-9a-f]{4,12})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const attempt = await getSetupAttemptByShortId(ctx.match[1]);
  if (attempt === null) {
    await safeAnswerCallback(ctx, ATTEMPT_NOT_FOUND_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const view = await buildProgressView(attempt);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// «تلاش مجدد»: re-enqueue the SAME failed attempt (resume-safe).
logGroupIdHandler.callbackQuery(/^admin:lg:id_retry:([0-9a-f]{4,12})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const attempt = await getSetupAttemptByShortId(ctx.match[1]);
  if (attempt === null) {
    await safeAnswerCallback(ctx, ATTEMPT_NOT_FOUND_TEXT);
    return;
  }
  const result = await requeueFailedAttempt(attempt.id);
  if (!result.ok || result.attempt === undefined) {
    await safeAnswerCallback(ctx, result.safeMessage ?? ATTEMPT_NOT_FOUND_TEXT);
    // Re-render the (still-failed) op page so the reason stays visible.
    const fresh = await getSetupAttemptByShortId(ctx.match[1]);
    if (fresh !== null) {
      const view = await buildProgressView(fresh);
      await safeEditOrReply(ctx, view.text, view.keyboard);
    }
    return;
  }
  await safeAnswerCallback(ctx, "راه‌اندازی گروه لاگ دوباره در صف قرار گرفت ⏳");
  await auditLogGroupConnection("log_group.setup_queued", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
    attemptId: result.attempt.id,
    chatId: result.attempt.chatId,
    extra: { retry: true },
  });
  const view = await buildProgressView(result.attempt);
  await safeEditOrReply(ctx, view.text, view.keyboard);
});

// «لغو عملیات»: cancel the in-flight setup; the ACTIVE group is preserved.
logGroupIdHandler.callbackQuery(/^admin:lg:id_cancel_op:([0-9a-f]{4,12})$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  const attempt = await getSetupAttemptByShortId(ctx.match[1]);
  if (attempt === null) {
    await safeAnswerCallback(ctx, ATTEMPT_NOT_FOUND_TEXT);
    return;
  }
  const cancelled = await cancelSetupAttempt(attempt.id);
  if (cancelled) {
    await auditLogGroupConnection("log_group.cancelled", {
      adminId: admin.id,
      adminTelegramId: admin.telegramId,
      attemptId: attempt.id,
      chatId: attempt.chatId,
    });
  }
  clearFlow(ctx);
  await renderLogGroupPage(
    ctx,
    cancelled ? "عملیات راه‌اندازی لغو شد." : "این عملیات دیگر قابل لغو نیست.",
  );
});

// --- numeric-ID text input flow ("lg:chat_id") -------------------------------

export const logGroupIdTextHandler = new Composer<BotContext>();

logGroupIdTextHandler.on("message:text", async (ctx, next) => {
  const admin = ctx.admin;
  if (admin === null || ctx.session.currentFlow !== LOG_GROUP_ID_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  // A command aborts the flow and falls through to normal command handling.
  if (text.startsWith("/")) {
    clearFlow(ctx);
    return next();
  }
  if (admin.role !== "OWNER") {
    clearFlow(ctx);
    await safeReply(ctx, OWNER_ONLY_TEXT);
    return;
  }

  const prepared = await prepareLogGroupConnection(
    buildProbeApi(ctx),
    text,
    Number(admin.telegramId),
  );
  if (!prepared.ok) {
    // Keep the flow active so the OWNER can correct the id and resend.
    await safeReply(ctx, prepared.safeMessage, inputKeyboard());
    return;
  }

  // Validated - the rest of the flow is button-driven, so stop consuming text.
  clearFlow(ctx);
  const created = await createLogGroupSetupAttempt({
    chatId: prepared.chatId,
    title: prepared.title,
    adminId: admin.id,
    previous: prepared.previous,
  });
  if (!created.ok) {
    const sid = attemptShortId(created.activeAttempt.id);
    await safeReply(
      ctx,
      SETUP_ALREADY_RUNNING_TEXT,
      new InlineKeyboard()
        .text("مشاهده وضعیت راه‌اندازی", opCb(sid))
        .row()
        .text("بازگشت به تنظیمات گروه لاگ", LG_CB.root),
    );
    return;
  }

  const attempt = created.attempt;
  ctx.session.temp.adminLogGroupSetupDraft = { attemptId: attempt.id };
  await auditLogGroupConnection("log_group.validated", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
    attemptId: attempt.id,
    chatId: attempt.chatId,
    extra: { isPublic: prepared.isPublic },
  });

  // A public group needs an extra explicit acknowledgement before the preview.
  if (prepared.isPublic) {
    await safeReply(ctx, PUBLIC_WARNING_TEXT, publicWarningKeyboard(attemptShortId(attempt.id)));
    return;
  }

  await auditLogGroupConnection("log_group.confirm_requested", {
    adminId: admin.id,
    adminTelegramId: admin.telegramId,
    attemptId: attempt.id,
    chatId: attempt.chatId,
  });
  const view = buildPreview(attempt);
  await safeReply(ctx, view.text, view.keyboard);
});
