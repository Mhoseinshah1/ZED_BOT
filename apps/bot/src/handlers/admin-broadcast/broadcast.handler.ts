import { type Broadcast } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  AUDIENCE_LABEL,
  audienceLabel,
  BROADCAST_TEXT_MAX,
  broadcastAudience,
  createBroadcastDraft,
  estimateAudienceCount,
  getBroadcastByShortId,
  getBroadcastProgress,
  INVALID_BROADCAST_TEXT,
  listBroadcasts,
  parseBroadcastAudience,
  sendBroadcastTest,
  startBroadcast,
  type BroadcastAudience,
} from "../../services/broadcast.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «پیام همگانی 📣» (Phase 33) - admin-only TEXT broadcast UI: text -> pick an
// audience (with live estimates) -> preview -> test send to the admin ->
// confirmed final start (status-guarded in the service, so double clicks
// never double-send) -> progress/result view. Outgoing broadcasts are plain
// text; only the PREVIEW is HTML-escaped for display.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const TEXT_FLOW = "admin_broadcast:text";

const BC_CB = {
  root: CB.ADMIN_BROADCAST,
  new: "admin:bc:new",
  cancel: "admin:bc:cancel",
  list: (page: number): string => `admin:bc:list:${page}`,
  view: (sid: string): string => `admin:bc:view:${sid}`,
  audience: (audience: BroadcastAudience): string => `admin:bc:aud:${audience}`,
  test: (sid: string): string => `admin:bc:test:${sid}`,
  start: (sid: string): string => `admin:bc:start:${sid}`,
  startYes: (sid: string): string => `admin:bc:start_yes:${sid}`,
  refresh: (sid: string): string => `admin:bc:refresh:${sid}`,
} as const;

const STATUS_LABEL: Record<Broadcast["status"], string> = {
  DRAFT: "پیش‌نویس 📝",
  CONFIRMING: "در انتظار تایید 📝",
  RUNNING: "در حال ارسال ⏳",
  CANCELLED: "لغو شد ❌",
  COMPLETED: "تکمیل شد ✅",
  FAILED: "ناموفق ❌",
};

const STATUS_ICON: Record<Broadcast["status"], string> = {
  DRAFT: "📝",
  CONFIRMING: "📝",
  RUNNING: "⏳",
  CANCELLED: "❌",
  COMPLETED: "✅",
  FAILED: "❌",
};

export const adminBroadcastHandler = new Composer<BotContext>();

/** Full Phase 33 broadcast state cleanup (text flow + draft). */
export function clearAdminBroadcastState(ctx: BotContext): void {
  if (ctx.session.currentFlow === TEXT_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminBroadcastDraft;
}

async function renderLanding(ctx: BotContext): Promise<void> {
  clearAdminBroadcastState(ctx);
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("ساخت پیام جدید ➕", BC_CB.new)
    .row()
    .text("لیست ارسال‌ها 🧾", BC_CB.list(1))
    .row()
    .text("بازگشت به منوی ادمین", CB.ADMIN_MENU);
  await safeEditOrReply(
    ctx,
    "پیام همگانی 📣\n\nارسال متن اعلان به گروهی از کاربران. قبل از ارسال نهایی می‌توانید پیام را برای خودتان تست کنید.",
    kb,
  );
}

async function renderDetail(ctx: BotContext, broadcast: Broadcast): Promise<void> {
  const sid = broadcast.id.slice(0, 8);
  const audience = broadcastAudience(broadcast);
  const progress = await getBroadcastProgress(broadcast.id);
  const lines = [
    `پیام همگانی 📣 <code>${sid}</code>`,
    "",
    `وضعیت: ${STATUS_LABEL[broadcast.status]}`,
    `مخاطب: ${audience === null ? "-" : audienceLabel(audience)}`,
  ];
  if (broadcast.status === "CONFIRMING" || broadcast.status === "DRAFT") {
    const estimate = audience === null ? 0 : await estimateAudienceCount(audience);
    lines.push(`تخمین گیرندگان: ${estimate}`);
  } else if (progress !== null) {
    lines.push(
      `گیرندگان: ${broadcast.totalTargets} | ارسال‌شده: ${progress.sent} | ناموفق: ${progress.failed}${
        progress.pending > 0 ? ` | در صف: ${progress.pending}` : ""
      }${progress.skipped > 0 ? ` | ردشده: ${progress.skipped}` : ""}`,
    );
  }
  lines.push(`ایجاد: ${broadcast.createdAt.toISOString().slice(0, 10)}`);
  if (broadcast.startedAt !== null) {
    lines.push(`شروع: ${broadcast.startedAt.toISOString().replace("T", " ").slice(0, 16)}`);
  }
  if (broadcast.completedAt !== null) {
    lines.push(`پایان: ${broadcast.completedAt.toISOString().replace("T", " ").slice(0, 16)}`);
  }
  const text = broadcast.messageText ?? "";
  const preview = text.length > 800 ? `${text.slice(0, 800)}…` : text;
  lines.push("", "متن پیام:", escapeHtml(preview));

  const kb = new InlineKeyboard();
  if (broadcast.status === "DRAFT" || broadcast.status === "CONFIRMING") {
    kb.text("ارسال تستی به من 🧪", BC_CB.test(sid)).row();
    if (audience !== "test_only") {
      kb.text("شروع ارسال نهایی 🚀", BC_CB.start(sid)).row();
    }
  }
  if (broadcast.status === "RUNNING") {
    kb.text("به‌روزرسانی وضعیت 🔄", BC_CB.refresh(sid)).row();
  }
  kb.text("لیست ارسال‌ها 🧾", BC_CB.list(1)).row().text("بازگشت", BC_CB.root);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

adminBroadcastHandler.callbackQuery(BC_CB.root, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
});

adminBroadcastHandler.callbackQuery(BC_CB.cancel, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderLanding(ctx);
});

adminBroadcastHandler.callbackQuery(BC_CB.new, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  ctx.session.temp.adminBroadcastDraft = {};
  ctx.session.currentFlow = TEXT_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `پیام جدید ➕\n\nمتن پیام همگانی را بنویسید. (حداکثر ${BROADCAST_TEXT_MAX} کاراکتر)\nپیام دقیقاً به همین شکل و بدون قالب‌بندی برای کاربران ارسال می‌شود.`,
    new InlineKeyboard().text("انصراف", BC_CB.cancel),
  );
});

adminBroadcastHandler.callbackQuery(/^admin:bc:aud:([a-z_]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const audience = parseBroadcastAudience(ctx.match[1]);
  if (audience === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const draft = ctx.session.temp.adminBroadcastDraft;
  // Consumed BEFORE creating: a double-clicked audience button cannot
  // create two drafts.
  clearAdminBroadcastState(ctx);
  if (draft?.text === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await createBroadcastDraft(admin.id, draft.text, audience);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, outcome.broadcast);
});

adminBroadcastHandler.callbackQuery(/^admin:bc:list:(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminBroadcastState(ctx);
  const pageData = await listBroadcasts(Number.parseInt(ctx.match[1], 10));
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const broadcast of pageData.broadcasts) {
    const audience = broadcastAudience(broadcast);
    const tail =
      broadcast.status === "RUNNING"
        ? "در حال ارسال"
        : broadcast.createdAt.toISOString().slice(5, 10);
    kb.text(
      `${STATUS_ICON[broadcast.status]} ${audience === null ? "-" : audienceLabel(audience)} | ${broadcast.sentCount}/${broadcast.totalTargets} | ${tail}`,
      BC_CB.view(broadcast.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", BC_CB.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, BC_CB.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", BC_CB.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", BC_CB.root);
  await safeEditOrReply(
    ctx,
    pageData.total === 0
      ? "لیست ارسال‌ها 🧾\n\nهنوز پیامی ساخته نشده است."
      : `لیست ارسال‌ها 🧾 — ${pageData.total} مورد`,
    kb,
  );
});

adminBroadcastHandler.callbackQuery(/^admin:bc:(?:view|refresh):([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const broadcast = await getBroadcastByShortId(ctx.match[1]);
  if (broadcast === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderDetail(ctx, broadcast);
});

adminBroadcastHandler.callbackQuery(/^admin:bc:test:([0-9a-f-]+)$/, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const broadcast = await getBroadcastByShortId(ctx.match[1]);
  if (broadcast === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await sendBroadcastTest(ctx.api, broadcast.id, admin.telegramId);
  await safeAnswerCallback(ctx, outcome.ok ? "پیام تستی ارسال شد 🧪" : outcome.safeMessage);
});

adminBroadcastHandler.callbackQuery(/^admin:bc:start:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const broadcast = await getBroadcastByShortId(ctx.match[1]);
  if (broadcast === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const audience = broadcastAudience(broadcast);
  const estimate = audience === null || audience === "test_only" ? 0 : await estimateAudienceCount(audience);
  const sid = broadcast.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      `شروع ارسال نهایی 🚀 <code>${sid}</code>`,
      "",
      `مخاطب: ${audience === null ? "-" : audienceLabel(audience)}`,
      `تخمین گیرندگان: ${estimate}`,
      "",
      "پیام برای همه گیرندگان ارسال می‌شود و قابل بازگشت نیست. ادامه می‌دهید؟",
    ].join("\n"),
    new InlineKeyboard()
      .text("بله، شروع ارسال 🚀", BC_CB.startYes(sid))
      .row()
      .text("انصراف", BC_CB.view(sid)),
    HTML,
  );
});

adminBroadcastHandler.callbackQuery(/^admin:bc:start_yes:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const broadcast = await getBroadcastByShortId(ctx.match[1]);
  if (broadcast === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // Answer the callback FIRST - the synchronous send loop may take a while.
  await safeAnswerCallback(ctx, "ارسال شروع شد ⏳");
  const result = await startBroadcast(ctx.api, broadcast.id);
  if (!result.ok) {
    await safeReply(ctx, result.safeMessage ?? "ارسال ناموفق بود.");
  }
  const fresh = await getBroadcastByShortId(ctx.match[1]);
  if (fresh !== null) {
    await renderDetail(ctx, fresh);
  }
});

// --- broadcast text input ----------------------------------------------------------------------

export const adminBroadcastTextHandler = new Composer<BotContext>();

adminBroadcastTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.admin === null || ctx.session.currentFlow !== TEXT_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    clearAdminBroadcastState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminBroadcastDraft;
  if (draft === undefined) {
    clearAdminBroadcastState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const clean = text.trim();
  if (clean.length === 0 || clean.length > BROADCAST_TEXT_MAX) {
    await safeReply(ctx, INVALID_BROADCAST_TEXT, new InlineKeyboard().text("انصراف", BC_CB.cancel));
    return;
  }
  draft.text = clean;
  ctx.session.currentFlow = null;
  // Audience selection with live estimates.
  const audiences: BroadcastAudience[] = [
    "all_active",
    "active_services",
    "buyers",
    "no_purchase",
    "test_only",
  ];
  const estimates = await Promise.all(
    audiences.map(async (audience) => estimateAudienceCount(audience)),
  );
  const kb = new InlineKeyboard();
  audiences.forEach((audience, index) => {
    const count = audience === "test_only" ? "" : ` (${estimates[index]})`;
    kb.text(`${AUDIENCE_LABEL[audience]}${count}`, BC_CB.audience(audience)).row();
  });
  kb.text("انصراف", BC_CB.cancel);
  await safeReply(ctx, "مخاطب پیام را انتخاب کنید:", kb);
});
