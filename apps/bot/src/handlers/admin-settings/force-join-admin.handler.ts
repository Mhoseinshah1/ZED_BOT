import { randomInt } from "node:crypto";

import { type ForceJoinChannel } from "@zedbot/database";
import { parseForceJoinLink } from "@zedbot/shared";
import { Composer, InlineKeyboard, Keyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  createOrRebindChannel,
  deleteChannel,
  disableForceJoin,
  disableForceJoinAndDeactivate,
  disableForceJoinAndDelete,
  enableForceJoin,
  FORCE_JOIN_ENABLED_KEY,
  getChannelById,
  listChannelsPage,
  rebindChannelIdentity,
  recordValidationError,
  recordValidationSuccess,
  reorderChannel,
  resolveChannelByShortId,
  setChannelActive,
  validateBotChannelAccess,
  type BotAccessErrorCode,
  type BotAccessTarget,
  type ForceJoinBotApi,
  type MutateResult,
} from "../../services/force-join/force-join-channel.service.js";
import { getBooleanSetting } from "../../services/settings.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import {
  safeAnswerCallback,
  safeEditOrReply,
  safeReply,
  safeReplyWithMarkup,
} from "../../utils/safe-reply.js";

// =============================================================================
// Mandatory channel membership (Force Join): OWNER admin management UI (Phase 5).
//
// The «عضویت اجباری 📢» sub-section of general settings. OWNER-only: every route
// re-checks the live admin role (button visibility is never authorization). Calls
// the Phase-2 service for every mutation — this handler owns ZERO DB logic. It
// NEVER renders or logs the internal Telegram chatId, and NEVER carries a
// chatId/username/link in callback data (D7): parametrized routes carry the
// ForceJoinChannel.id 8-char short prefix and resolve it via resolveChannelByShortId
// (a stale / ambiguous prefix resolves to null and re-renders the overview).
// =============================================================================

export const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

// Session flows this handler arms. Kept private; consumers use the exported
// clearForceJoinAdminState to unwind.
const FLOW_ADD = "force_join:add";
const FLOW_EDIT_LINK = "force_join:edit_link";
const FLOW_PRIVATE_PICK = "force_join:private_pick";
const FORCE_JOIN_FLOWS = new Set<string>([FLOW_ADD, FLOW_EDIT_LINK, FLOW_PRIVATE_PICK]);

/**
 * Callback identities under the `admin:force_join:` namespace (D7). Parametrized
 * routes carry ONLY the channel's 8-char id prefix — never a chatId/link.
 */
const FJ_CB = {
  root: "admin:force_join:root",
  enable: "admin:force_join:enable",
  disable: "admin:force_join:disable",
  add: "admin:force_join:add",
  cancel: "admin:force_join:cancel",
  page: (n: number): string => `admin:force_join:page:${n}`,
  detail: (sid: string): string => `admin:force_join:c:${sid}`,
  editLink: (sid: string): string => `admin:force_join:edit:${sid}`,
  rebind: (sid: string): string => `admin:force_join:rebind:${sid}`,
  test: (sid: string): string => `admin:force_join:test:${sid}`,
  toggle: (sid: string): string => `admin:force_join:toggle:${sid}`,
  up: (sid: string): string => `admin:force_join:up:${sid}`,
  down: (sid: string): string => `admin:force_join:down:${sid}`,
  del: (sid: string): string => `admin:force_join:del:${sid}`,
  delConfirm: (sid: string): string => `admin:force_join:delok:${sid}`,
  disableAndDeactivate: (sid: string): string => `admin:force_join:disdeact:${sid}`,
  disableAndDelete: (sid: string): string => `admin:force_join:disdel:${sid}`,
} as const;

// --- exact button labels (§4.6) ----------------------------------------------
// key -> byte-for-byte exact fallback label. EXPORTED so the Phase-6 seeding
// phase reuses the identical strings. Some words contain ZWNJ (U+200C).
export const FORCE_JOIN_ADMIN_BUTTON_FALLBACKS: Record<string, string> = {
  force_join_admin_enable: "فعال‌سازی عضویت اجباری ✅",
  force_join_admin_disable: "غیرفعال‌سازی عضویت اجباری ❌",
  force_join_admin_add: "افزودن کانال ➕",
  force_join_admin_edit_link: "ویرایش لینک 🔗",
  force_join_admin_rebind: "انتخاب مجدد کانال 📢",
  force_join_admin_test: "تست دسترسی ربات ♻️",
  force_join_admin_toggle: "فعال/غیرفعال",
  force_join_admin_up: "انتقال به بالا ⬆️",
  force_join_admin_down: "انتقال به پایین ⬇️",
  force_join_admin_delete: "حذف کانال 🗑",
  force_join_admin_back: "بازگشت",
};

// --- fixed message / toast strings -------------------------------------------
const ADD_PROMPT = "لینک کانال (عمومی یا لینک دعوت خصوصی) را ارسال کنید:";
const EDIT_PROMPT = "لینک جدید عضویت را ارسال کنید:";
// A private channel's link and identity are replaced together, so the prompt
// says up-front that a channel selection follows the link.
const PRIVATE_EDIT_PROMPT =
  "لینک دعوت جدید را ارسال کنید؛ سپس همان کانال را از لیست انتخاب کنید:";
const PRIVATE_PICK_PROMPT = "کانال خصوصی را از لیست انتخاب کنید:";
const PRIVATE_PICK_BUTTON = "انتخاب کانال 📢";
const CANCEL_LABEL = "انصراف";
const CANCELLED_TEXT = "لغو شد.";
const INVALID_LINK_FALLBACK =
  "لینک واردشده معتبر نیست. یک لینک عمومی یا لینک دعوت خصوصی تلگرام ارسال کنید.";
const BOT_ADMIN_REQUIRED_TEXT = "ابتدا ربات را در کانال ادمین کنید و دوباره تلاش کنید.";
const TEMP_FAILURE_TEXT = "بررسی موقتاً ممکن نیست. چند لحظه دیگر دوباره تلاش کنید.";
const PRIVATE_NOT_A_CHANNEL_TEXT = "کانال انتخابی معتبر نیست.";
const ALREADY_ADDED_TOAST = "این کانال قبلاً اضافه شده است.";
const DUPLICATE_CHANNEL_TOAST = "این کانال قبلاً ثبت شده است.";
const LIMIT_ADDED_TEXT =
  "کانال بدون فعال‌سازی افزوده شد (به سقف ۱۰ کانال فعال رسیده‌اید).";
const ACTIVE_LIMIT_TOAST = "حداکثر ۱۰ کانال فعال مجاز است.";
const NO_MOVE_TOAST = "امکان جابجایی بیشتر نیست.";
const NO_ACTIVE_TOAST = "ابتدا حداقل یک کانال معتبر و فعال اضافه کنید.";
const TEST_OK_TOAST = "دسترسی ربات تایید شد ✅";
const EXPIRED_TEXT = "درخواست منقضی شده است. دوباره تلاش کنید.";
const KIND_MISMATCH_TEXT =
  "نوع لینک باید با نوع کانال فعلی یکسان باشد (عمومی یا خصوصی).";
const EDIT_DIFFERENT_CHANNEL_TEXT =
  "این لینک به کانال دیگری اشاره دارد. برای افزودن کانال جدید از «افزودن کانال» استفاده کنید.";
const EXISTING_INACTIVE_TEXT =
  "این کانال قبلاً ثبت شده و غیرفعال است. برای فعال‌سازی، آن را از فهرست باز کنید.";
const PRIVATE_CHAT_REQUIRED_TEXT =
  "افزودن یا انتخاب کانال خصوصی فقط در چت خصوصی با ربات ممکن است. لطفاً در چت خصوصی ربات دوباره تلاش کنید.";
const STALE_TOAST = "کانال یافت نشد یا حذف شده است.";
const TOGGLED_TOAST = "به‌روزرسانی شد ✅";
const REBOUND_TOAST = "کانال به‌روزرسانی شد ✅";
const LAST_ACTIVE_TEXT = "این تنها کانال فعال است و عضویت اجباری روشن است.";
const DISABLE_AND_DEACTIVATE_LABEL = "غیرفعال‌سازی عضویت اجباری و این کانال";
const DISABLE_AND_DELETE_LABEL = "غیرفعال‌سازی عضویت اجباری و حذف کانال";
const DISABLED_DEACTIVATED_TOAST = "عضویت اجباری و این کانال غیرفعال شد.";
const DISABLED_DELETED_TOAST = "عضویت اجباری غیرفعال و کانال حذف شد.";
const DELETE_CONFIRM_LABEL = "تایید حذف 🗑";

const OVERVIEW_BACK_LABEL = "بازگشت به تنظیمات عمومی";
const MAX_BUTTON_TITLE_CHARS = 40;
// The overview lists every channel (only the ACTIVE set is capped at 10, so
// inactive rows can accumulate). Paginate so the rendered text can never cross
// Telegram's 4096-char message limit or the inline-keyboard button ceiling — a
// silently-failed edit would otherwise make the whole section unusable (§4.4).
const OVERVIEW_PAGE_SIZE = 8;
const OVERVIEW_PREV_LABEL = "◀️ قبلی";
const OVERVIEW_NEXT_LABEL = "بعدی ▶️";

interface OverviewPage {
  pageCount: number;
  page: number;
  start: number;
  end: number;
}

/** Clamps a requested page to the valid range for `total` rows. */
function overviewPageBounds(total: number, requested: number): OverviewPage {
  const pageCount = Math.max(1, Math.ceil(total / OVERVIEW_PAGE_SIZE));
  const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), pageCount - 1);
  const start = page * OVERVIEW_PAGE_SIZE;
  return { pageCount, page, start, end: Math.min(start + OVERVIEW_PAGE_SIZE, total) };
}

export const forceJoinAdminHandler = new Composer<BotContext>();
export const forceJoinAdminTextHandler = new Composer<BotContext>();
export const forceJoinChatSharedHandler = new Composer<BotContext>();
// Runs BEFORE the command composers (start / ping / paysupport / …) in app.ts so
// a command sent mid-flow unwinds the force-join flow (and removes any lingering
// request_chat picker keyboard) before that command's own handler consumes the
// update. The flow-dispatcher text handler above is registered AFTER those
// command composers, so it can never see a command during a flow (Codex P2).
export const forceJoinCommandEscapeHandler = new Composer<BotContext>();

// --- helpers -----------------------------------------------------------------

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

async function ownerGuard(ctx: BotContext): Promise<boolean> {
  if (ctx.admin === null) {
    return false;
  }
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return false;
  }
  return true;
}

/** The narrow Telegram adapter the service validation needs (over ctx.api). */
function makeApi(ctx: BotContext): ForceJoinBotApi {
  return {
    getMe: () => ctx.api.getMe(),
    getChat: (chatId: number | string) => ctx.api.getChat(chatId),
    getChatMember: (chatId: number | string, userId: number) =>
      ctx.api.getChatMember(chatId, userId),
  };
}

function fjButton(key: string): Promise<string> {
  return getButtonText(key, FORCE_JOIN_ADMIN_BUTTON_FALLBACKS[key]);
}

/**
 * A fresh, cryptographically random positive 32-bit `request_id` for EVERY new
 * picker operation (T3).
 *
 * It must never be derived from the sender id: a value anyone can compute lets a
 * `chat_shared` payload be crafted or replayed to satisfy a picker the OWNER did
 * not arm, and a per-user-constant value means an old response still matches a
 * newly armed flow. A random id per operation makes the armed draft the only
 * thing that can answer it — combined with the admin binding, the expiry, and
 * clearing the draft on success/failure/cancel, every response is single-use.
 */
function newPickRequestId(): number {
  return randomInt(1, 2_147_483_647);
}

/**
 * request_chat / chat_shared keyboards are ONLY permitted by Telegram in private
 * chats. Arming the private picker in a group/(super)group silently fails the
 * reply-keyboard send while leaving the session in the private_pick flow, so the
 * add/rebind flows guard on this before switching state.
 */
function isPrivateChat(ctx: BotContext): boolean {
  return ctx.chat?.type === "private";
}

/**
 * The success toast after an add / private-pick, distinguishing the three
 * outcomes of createOrRebindChannel so the operator is never told the 10-active
 * cap was hit when they merely re-added an already-registered inactive channel:
 *  - activated → the channel is active now (created or rebound),
 *  - created but not activated → a genuinely new row parked inactive at the cap,
 *  - existing inactive rebind → the row was already configured and inactive.
 */
async function addedChannelToast(upsert: { created: boolean; activated: boolean }): Promise<string> {
  if (upsert.activated) {
    return getMessageTemplate("force_join_channel_added", "کانال اضافه شد ✅");
  }
  if (upsert.created) {
    return LIMIT_ADDED_TEXT;
  }
  return EXISTING_INACTIVE_TEXT;
}

/** Makes a channel title safe for an inline button label (plain-text screen). */
function safeButtonLabel(title: string): string {
  let cleaned = "";
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return "کانال";
  }
  return cleaned.length > MAX_BUTTON_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_BUTTON_TITLE_CHARS - 1)}…`
    : cleaned;
}

/** Maps a normalized bot-access failure to its operator message (public/private). */
async function accessErrorText(code: BotAccessErrorCode, isPrivate: boolean): Promise<string> {
  switch (code) {
    case "BOT_NOT_ADMIN":
    case "CHANNEL_NOT_FOUND":
      return BOT_ADMIN_REQUIRED_TEXT;
    case "TEMP_FAILURE":
      return TEMP_FAILURE_TEXT;
    case "NOT_A_CHANNEL":
      return isPrivate
        ? PRIVATE_NOT_A_CHANNEL_TEXT
        : await getMessageTemplate("force_join_invalid_link", INVALID_LINK_FALLBACK);
  }
}

/**
 * Full force-join admin state cleanup (T1). Clears the current force-join flow +
 * draft and, when unwinding the private picker, sends `{ remove_keyboard: true }`
 * so the temporary request_chat reply keyboard never lingers. `removalText`
 * accompanies that removal message (Telegram needs a non-empty body) — it
 * defaults to the cancel notice but is overridden with the success / error
 * outcome on the private-pick completion paths so the removal message never
 * reads "cancelled" after a successful add.
 */
export async function clearForceJoinAdminState(
  ctx: BotContext,
  removalText: string = CANCELLED_TEXT,
): Promise<void> {
  const flow = ctx.session.currentFlow;
  const wasPrivatePick = flow === FLOW_PRIVATE_PICK;
  if (flow !== null && FORCE_JOIN_FLOWS.has(flow)) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.forceJoin;
  if (wasPrivatePick) {
    await safeReplyWithMarkup(ctx, removalText, { remove_keyboard: true });
  }
}

// --- overview + detail rendering ---------------------------------------------

function overviewText(
  pageChannels: ForceJoinChannel[],
  totalChannels: number,
  activeCount: number,
  enabled: boolean,
  view: OverviewPage,
): string {
  const lines = [
    "📢 عضویت اجباری",
    "",
    `وضعیت: ${enabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    `کانال‌های فعال: ${activeCount}`,
    "",
    "ربات باید در هر کانال ادمین باشد تا بتواند عضویت کاربران را بررسی کند.",
    "",
    "کانال‌ها:",
  ];
  if (totalChannels === 0) {
    lines.push("هنوز کانالی اضافه نشده است.");
  } else {
    pageChannels.forEach((c, i) => {
      lines.push(`${view.start + i + 1}. ${c.title} — ${c.isActive ? "فعال ✅" : "غیرفعال ⛔"}`);
    });
    if (view.pageCount > 1) {
      lines.push("", `صفحه ${view.page + 1} از ${view.pageCount}`);
    }
  }
  return lines.join("\n");
}

async function overviewKeyboard(
  pageChannels: ForceJoinChannel[],
  enabled: boolean,
  view: OverviewPage,
): Promise<InlineKeyboard> {
  const [enableLabel, disableLabel, addLabel] = await Promise.all([
    fjButton("force_join_admin_enable"),
    fjButton("force_join_admin_disable"),
    fjButton("force_join_admin_add"),
  ]);
  const kb = new InlineKeyboard();
  if (enabled) {
    kb.text(disableLabel, FJ_CB.disable).row();
  } else {
    kb.text(enableLabel, FJ_CB.enable).row();
  }
  kb.text(addLabel, FJ_CB.add).row();
  pageChannels.forEach((c, i) => {
    kb.text(`${view.start + i + 1}. ${safeButtonLabel(c.title)}`, FJ_CB.detail(c.id.slice(0, 8))).row();
  });
  if (view.pageCount > 1) {
    let hasNav = false;
    if (view.page > 0) {
      kb.text(OVERVIEW_PREV_LABEL, FJ_CB.page(view.page - 1));
      hasNav = true;
    }
    if (view.page < view.pageCount - 1) {
      kb.text(OVERVIEW_NEXT_LABEL, FJ_CB.page(view.page + 1));
      hasNav = true;
    }
    if (hasNav) {
      kb.row();
    }
  }
  kb.text(OVERVIEW_BACK_LABEL, CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

/**
 * Renders the overview at `page` (default 0 — every mutation resets to the first
 * page; only the page-nav callback advances it). `toast` shows as a callback
 * answer in a callback context and is prepended to the body in a message context
 * (where there is no callback to answer, e.g. the add / chat_shared paths) so the
 * outcome is always visible. Paginated (§4.4) so a long inactive list can never
 * overflow the Telegram message / keyboard limits.
 */
async function renderOverview(ctx: BotContext, toast?: string, page = 0): Promise<void> {
  const requested = Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0;
  // Paginated in the DATABASE: only this page's rows are ever loaded, so an
  // unbounded inactive tail costs nothing to render.
  const [firstPass, enabled] = await Promise.all([
    listChannelsPage(requested * OVERVIEW_PAGE_SIZE, OVERVIEW_PAGE_SIZE),
    getBooleanSetting(FORCE_JOIN_ENABLED_KEY, false),
  ]);
  let view = overviewPageBounds(firstPass.total, requested);
  let pageData = firstPass;
  // The requested page can be past the end (rows deleted since the keyboard was
  // drawn); re-fetch the clamped page rather than rendering an empty list.
  if (view.page !== requested) {
    pageData = await listChannelsPage(view.start, OVERVIEW_PAGE_SIZE);
    view = overviewPageBounds(pageData.total, view.page);
  }
  await safeAnswerCallback(ctx, toast);
  const prefix = toast !== undefined && ctx.callbackQuery === undefined ? `${toast}\n\n` : "";
  await safeEditOrReply(
    ctx,
    prefix + overviewText(pageData.rows, pageData.total, pageData.activeCount, enabled, view),
    await overviewKeyboard(pageData.rows, enabled, view),
  );
  ctx.session.lastMenu = FJ_CB.root;
}

function detailText(channel: ForceJoinChannel): string {
  const lines = [
    `📢 ${channel.title}`,
    "",
    `نوع: ${channel.isPrivate ? "خصوصی" : "عمومی"}`,
    `وضعیت: ${channel.isActive ? "فعال ✅" : "غیرفعال ⛔"}`,
    `لینک: ${channel.isPrivate ? channel.joinUrl : channel.normalizedLink}`,
  ];
  if (channel.lastValidatedAt !== null) {
    lines.push(`آخرین بررسی: ${channel.lastValidatedAt.toISOString().slice(0, 19).replace("T", " ")}`);
  }
  if (channel.lastValidationErrorCode !== null) {
    lines.push(`کد خطای بررسی: ${channel.lastValidationErrorCode}`);
  }
  return lines.join("\n");
}

async function detailKeyboard(channel: ForceJoinChannel): Promise<InlineKeyboard> {
  const sid = channel.id.slice(0, 8);
  const [editLabel, rebindLabel, testLabel, toggleLabel, upLabel, downLabel, delLabel, backLabel] =
    await Promise.all([
      fjButton("force_join_admin_edit_link"),
      fjButton("force_join_admin_rebind"),
      fjButton("force_join_admin_test"),
      fjButton("force_join_admin_toggle"),
      fjButton("force_join_admin_up"),
      fjButton("force_join_admin_down"),
      fjButton("force_join_admin_delete"),
      fjButton("force_join_admin_back"),
    ]);
  const kb = new InlineKeyboard();
  kb.text(editLabel, FJ_CB.editLink(sid));
  // Rebinding re-picks a PRIVATE channel identity (request_chat), so it is only
  // offered for private rows — it never converts a public channel to private.
  if (channel.isPrivate) {
    kb.text(rebindLabel, FJ_CB.rebind(sid));
  }
  kb.row();
  kb.text(testLabel, FJ_CB.test(sid)).text(toggleLabel, FJ_CB.toggle(sid)).row();
  kb.text(upLabel, FJ_CB.up(sid)).text(downLabel, FJ_CB.down(sid)).row();
  kb.text(delLabel, FJ_CB.del(sid)).row();
  kb.text(backLabel, FJ_CB.root);
  return kb;
}

async function renderDetail(ctx: BotContext, channel: ForceJoinChannel, toast?: string): Promise<void> {
  await safeAnswerCallback(ctx, toast);
  const prefix = toast !== undefined && ctx.callbackQuery === undefined ? `${toast}\n\n` : "";
  await safeEditOrReply(ctx, prefix + detailText(channel), await detailKeyboard(channel));
}

/**
 * Resolves the short id carried in callback data. On a stale / ambiguous prefix
 * (§4.13) re-renders the overview with a "not found" toast and returns null.
 */
async function resolveOrStale(ctx: BotContext, sid: string): Promise<ForceJoinChannel | null> {
  const channel = await resolveChannelByShortId(sid);
  if (channel === null) {
    await renderOverview(ctx, STALE_TOAST);
    return null;
  }
  return channel;
}

// --- overview + navigation routes --------------------------------------------

forceJoinAdminHandler.callbackQuery(FJ_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await clearForceJoinAdminState(ctx);
  await renderOverview(ctx);
});

forceJoinAdminHandler.callbackQuery(FJ_CB.cancel, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await clearForceJoinAdminState(ctx);
  await renderOverview(ctx);
});

forceJoinAdminHandler.callbackQuery(/^admin:force_join:page:(\d{1,4})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await renderOverview(ctx, undefined, Number(ctx.match[1]));
});

forceJoinAdminHandler.callbackQuery(/^admin:force_join:c:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await clearForceJoinAdminState(ctx);
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  await renderDetail(ctx, channel);
});

// --- master switch -----------------------------------------------------------

forceJoinAdminHandler.callbackQuery(FJ_CB.enable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const result = await enableForceJoin();
  if (!result.ok) {
    await renderOverview(ctx, NO_ACTIVE_TOAST);
    return;
  }
  logger.info("force join enabled");
  await renderOverview(ctx, await getMessageTemplate("force_join_enabled_ok", "عضویت اجباری فعال شد ✅"));
});

forceJoinAdminHandler.callbackQuery(FJ_CB.disable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await disableForceJoin();
  logger.info("force join disabled");
  await renderOverview(
    ctx,
    await getMessageTemplate("force_join_disabled_ok", "عضویت اجباری غیرفعال شد ❌"),
  );
});

// --- add channel (starts the add-link text flow) -----------------------------

forceJoinAdminHandler.callbackQuery(FJ_CB.add, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  ctx.session.temp.forceJoin = {};
  ctx.session.currentFlow = FLOW_ADD;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, ADD_PROMPT, new InlineKeyboard().text(CANCEL_LABEL, FJ_CB.cancel));
});

// --- edit link (arms the edit-link text flow) --------------------------------

/**
 * Arms the link-entry step. For a PUBLIC channel the new link is resolved and
 * applied directly; for a PRIVATE channel it is only the FIRST half of the
 * combined operation — the text step stores the validated link and then opens a
 * fresh channel picker, and nothing is persisted until both halves are known.
 */
async function startEditLinkFlow(ctx: BotContext, channel: ForceJoinChannel): Promise<void> {
  // A private edit ends in a request_chat picker, which Telegram only allows in
  // a private chat. Refuse up-front instead of stranding the flow later.
  if (channel.isPrivate && !isPrivateChat(ctx)) {
    await safeAnswerCallback(ctx, PRIVATE_CHAT_REQUIRED_TEXT);
    return;
  }
  ctx.session.temp.forceJoin = { editChannelId: channel.id };
  ctx.session.currentFlow = FLOW_EDIT_LINK;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    channel.isPrivate ? PRIVATE_EDIT_PROMPT : EDIT_PROMPT,
    new InlineKeyboard().text(CANCEL_LABEL, FJ_CB.detail(channel.id.slice(0, 8))),
  );
}

forceJoinAdminHandler.callbackQuery(/^admin:force_join:edit:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  await startEditLinkFlow(ctx, channel);
});

// --- rebind (private re-pick) ------------------------------------------------

/**
 * «انتخاب مجدد کانال» for a PRIVATE channel. It does NOT jump straight to the
 * picker: re-picking the channel while keeping the stored invite link would
 * leave the row advertising the OLD link for a NEW channel. Instead it starts
 * the same combined flow as «ویرایش لینک» — a fresh invite link first, then the
 * picker — so identity and link are always replaced together (§4.2).
 */
forceJoinAdminHandler.callbackQuery(/^admin:force_join:rebind:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  await startEditLinkFlow(ctx, channel);
});

// --- test bot access (§4.3) --------------------------------------------------

forceJoinAdminHandler.callbackQuery(/^admin:force_join:test:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  const target: BotAccessTarget =
    channel.publicUsername !== null
      ? { kind: "PUBLIC", username: channel.publicUsername }
      : { kind: "PRIVATE", chatId: channel.chatId };
  const result = await validateBotChannelAccess(makeApi(ctx), target);
  if (result.ok) {
    // Persist the fresh success so a previously-recorded error class does not
    // linger next to the success toast and lastValidatedAt reflects this test.
    await recordValidationSuccess(channel.id);
    const refreshed = (await getChannelById(channel.id)) ?? channel;
    await renderDetail(ctx, refreshed, TEST_OK_TOAST);
    return;
  }
  await recordValidationError(channel.id, result.code);
  const refreshed = (await getChannelById(channel.id)) ?? channel;
  await renderDetail(ctx, refreshed, await accessErrorText(result.code, channel.isPrivate));
});

// --- toggle active -----------------------------------------------------------

async function renderDisableDeactivateBlock(ctx: BotContext, channel: ForceJoinChannel): Promise<void> {
  const sid = channel.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    LAST_ACTIVE_TEXT,
    new InlineKeyboard()
      .text(DISABLE_AND_DEACTIVATE_LABEL, FJ_CB.disableAndDeactivate(sid))
      .row()
      .text(await fjButton("force_join_admin_back"), FJ_CB.detail(sid)),
  );
}

forceJoinAdminHandler.callbackQuery(/^admin:force_join:toggle:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  // Activating (inactive→active) MUST re-validate bot access first: an
  // inaccessible active channel is later excluded from gating as "unverifiable",
  // so the UI would claim a required channel that users are not actually forced
  // to join. Deactivating is always allowed (never blocked on a broken channel).
  if (!channel.isActive) {
    const target: BotAccessTarget =
      channel.publicUsername !== null
        ? { kind: "PUBLIC", username: channel.publicUsername }
        : { kind: "PRIVATE", chatId: channel.chatId };
    const access = await validateBotChannelAccess(makeApi(ctx), target);
    if (!access.ok) {
      await recordValidationError(channel.id, access.code);
      const refreshed = (await getChannelById(channel.id)) ?? channel;
      await renderDetail(ctx, refreshed, await accessErrorText(access.code, channel.isPrivate));
      return;
    }
    await recordValidationSuccess(channel.id);
  }
  const result = await setChannelActive(channel.id, !channel.isActive);
  if (!result.ok) {
    if (result.code === "ACTIVE_LIMIT") {
      await renderDetail(ctx, channel, ACTIVE_LIMIT_TOAST);
      return;
    }
    if (result.code === "LAST_ACTIVE_WHILE_ENABLED") {
      await renderDisableDeactivateBlock(ctx, channel);
      return;
    }
    await renderOverview(ctx, STALE_TOAST);
    return;
  }
  await renderDetail(ctx, result.channel, TOGGLED_TOAST);
});

// --- reorder -----------------------------------------------------------------

async function handleReorder(ctx: BotContext, sid: string, direction: "up" | "down"): Promise<void> {
  const channel = await resolveOrStale(ctx, sid);
  if (channel === null) return;
  const result = await reorderChannel(channel.id, direction);
  if (!result.ok) {
    await renderOverview(ctx, result.code === "NO_MOVE" ? NO_MOVE_TOAST : STALE_TOAST);
    return;
  }
  await renderOverview(ctx);
}

forceJoinAdminHandler.callbackQuery(/^admin:force_join:up:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await handleReorder(ctx, ctx.match[1], "up");
});

forceJoinAdminHandler.callbackQuery(/^admin:force_join:down:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await handleReorder(ctx, ctx.match[1], "down");
});

// --- delete ------------------------------------------------------------------

forceJoinAdminHandler.callbackQuery(/^admin:force_join:del:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  const sid = channel.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `حذف کانال «${channel.title}»؟`,
    new InlineKeyboard()
      .text(DELETE_CONFIRM_LABEL, FJ_CB.delConfirm(sid))
      .row()
      .text(await fjButton("force_join_admin_back"), FJ_CB.detail(sid)),
  );
});

async function renderDisableDeleteBlock(ctx: BotContext, channel: ForceJoinChannel): Promise<void> {
  const sid = channel.id.slice(0, 8);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    LAST_ACTIVE_TEXT,
    new InlineKeyboard()
      .text(DISABLE_AND_DELETE_LABEL, FJ_CB.disableAndDelete(sid))
      .row()
      .text(await fjButton("force_join_admin_back"), FJ_CB.detail(sid)),
  );
}

forceJoinAdminHandler.callbackQuery(/^admin:force_join:delok:([0-9a-f-]{4,36})$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const channel = await resolveOrStale(ctx, ctx.match[1]);
  if (channel === null) return;
  const result = await deleteChannel(channel.id);
  if (!result.ok) {
    if (result.code === "LAST_ACTIVE_WHILE_ENABLED") {
      await renderDisableDeleteBlock(ctx, channel);
      return;
    }
    await renderOverview(ctx, STALE_TOAST);
    return;
  }
  await renderOverview(ctx, await getMessageTemplate("force_join_channel_deleted", "کانال حذف شد ✅"));
});

// --- D3 combined atomic actions ----------------------------------------------

forceJoinAdminHandler.callbackQuery(
  /^admin:force_join:disdeact:([0-9a-f-]{4,36})$/,
  async (ctx) => {
    if (!(await ownerGuard(ctx))) return;
    const channel = await resolveOrStale(ctx, ctx.match[1]);
    if (channel === null) return;
    const result = await disableForceJoinAndDeactivate(channel.id);
    await renderOverview(ctx, result.ok ? DISABLED_DEACTIVATED_TOAST : STALE_TOAST);
  },
);

forceJoinAdminHandler.callbackQuery(
  /^admin:force_join:disdel:([0-9a-f-]{4,36})$/,
  async (ctx) => {
    if (!(await ownerGuard(ctx))) return;
    const channel = await resolveOrStale(ctx, ctx.match[1]);
    if (channel === null) return;
    const result = await disableForceJoinAndDelete(channel.id);
    await renderOverview(ctx, result.ok ? DISABLED_DELETED_TOAST : STALE_TOAST);
  },
);

// --- text-input consumer (add / edit-link flows) -----------------------------

/** Handles the add-channel link text (§4.1/§4.2). */
async function handleAddLink(ctx: BotContext, text: string, adminId: string): Promise<void> {
  const parsed = parseForceJoinLink(text);
  if (!parsed.ok) {
    await safeReply(
      ctx,
      await getMessageTemplate("force_join_invalid_link", INVALID_LINK_FALLBACK),
      new InlineKeyboard().text(CANCEL_LABEL, FJ_CB.cancel),
    );
    return; // keep the flow armed so they can retry
  }

  if (parsed.value.kind === "PUBLIC") {
    const username = parsed.value.publicUsername ?? "";
    const result = await validateBotChannelAccess(makeApi(ctx), { kind: "PUBLIC", username });
    if (!result.ok) {
      await safeReply(
        ctx,
        await accessErrorText(result.code, false),
        new InlineKeyboard().text(CANCEL_LABEL, FJ_CB.cancel),
      );
      return; // keep armed
    }
    const lowerUser = (result.username ?? username).toLowerCase();
    const normalizedLink = `https://t.me/${lowerUser}`;
    const upsert = await createOrRebindChannel({
      chatId: result.chatId,
      title: result.title || username || "کانال",
      joinUrl: normalizedLink,
      normalizedLink,
      isPrivate: false,
      publicUsername: lowerUser,
      createdByAdminId: adminId,
    });
    if (!upsert.ok) {
      await clearForceJoinAdminState(ctx);
      await renderOverview(ctx, ALREADY_ADDED_TOAST);
      return;
    }
    logger.info("force join channel added", { channelId: upsert.channel.id, isPrivate: false });
    await clearForceJoinAdminState(ctx);
    await renderOverview(ctx, await addedChannelToast(upsert));
    return;
  }

  // PRIVATE: arm the request_chat picker; the shared chat is re-validated on
  // chat_shared (T4) — the typed link is NOT trusted for identity.
  const from = ctx.from;
  if (from === undefined) {
    await clearForceJoinAdminState(ctx);
    return;
  }
  // request_chat keyboards are private-chat-only; arming one in a group would
  // silently fail the send and strand the session in the picker flow (§4.2).
  if (!isPrivateChat(ctx)) {
    await clearForceJoinAdminState(ctx);
    await safeReply(ctx, PRIVATE_CHAT_REQUIRED_TEXT);
    return;
  }
  const requestId = newPickRequestId();
  ctx.session.temp.forceJoin = {
    privatePick: {
      requestId,
      joinUrl: parsed.value.joinUrl,
      normalizedLink: parsed.value.normalizedLink,
      inviteHash: parsed.value.inviteHash ?? "",
      adminId,
      expiresAtMs: Date.now() + 5 * 60_000,
    },
  };
  ctx.session.currentFlow = FLOW_PRIVATE_PICK;
  await safeReplyWithMarkup(
    ctx,
    PRIVATE_PICK_PROMPT,
    new Keyboard()
      .requestChat(PRIVATE_PICK_BUTTON, requestId, { chat_is_channel: true, bot_is_member: true })
      .resized()
      .oneTime(),
  );
}

/**
 * Handles the edit-link text. The new link must be the same KIND as the row.
 * Public: re-validated and applied together with the authoritative identity.
 * Private: held in the session and paired with a freshly picked channel.
 */
async function handleEditLink(ctx: BotContext, text: string, adminId: string): Promise<void> {
  const channelId = ctx.session.temp.forceJoin?.editChannelId;
  if (channelId === undefined) {
    await clearForceJoinAdminState(ctx);
    await safeReply(ctx, EXPIRED_TEXT);
    return;
  }
  const channel = await getChannelById(channelId);
  if (channel === null) {
    await clearForceJoinAdminState(ctx);
    await safeReply(ctx, STALE_TOAST);
    return;
  }
  const cancelKb = new InlineKeyboard().text(CANCEL_LABEL, FJ_CB.detail(channel.id.slice(0, 8)));
  const parsed = parseForceJoinLink(text);
  if (!parsed.ok) {
    await safeReply(
      ctx,
      await getMessageTemplate("force_join_invalid_link", INVALID_LINK_FALLBACK),
      cancelKb,
    );
    return; // keep armed
  }
  const parsedIsPrivate = parsed.value.kind === "PRIVATE";
  if (parsedIsPrivate !== channel.isPrivate) {
    await safeReply(ctx, KIND_MISMATCH_TEXT, cancelKb);
    return; // keep armed
  }

  if (channel.isPrivate) {
    // A private invite link carries NO verifiable identity: nothing in it proves
    // which channel it opens. Writing it alone would let the row advertise
    // channel B while the gate keeps verifying channel A. So the link is only
    // held in the session, and the OWNER must now select the matching channel —
    // both halves are then written together on chat_shared (§4.2).
    const from = ctx.from;
    if (from === undefined) {
      await clearForceJoinAdminState(ctx);
      return;
    }
    if (!isPrivateChat(ctx)) {
      await clearForceJoinAdminState(ctx);
      await safeReply(ctx, PRIVATE_CHAT_REQUIRED_TEXT);
      return;
    }
    const requestId = newPickRequestId();
    ctx.session.temp.forceJoin = {
      rebindChannelId: channel.id,
      privatePick: {
        requestId,
        joinUrl: parsed.value.joinUrl,
        normalizedLink: parsed.value.normalizedLink,
        inviteHash: parsed.value.inviteHash ?? "",
        adminId: adminId,
        expiresAtMs: Date.now() + 5 * 60_000,
      },
    };
    ctx.session.currentFlow = FLOW_PRIVATE_PICK;
    await safeReplyWithMarkup(
      ctx,
      PRIVATE_PICK_PROMPT,
      new Keyboard()
        .requestChat(PRIVATE_PICK_BUTTON, requestId, { chat_is_channel: true, bot_is_member: true })
        .resized()
        .oneTime(),
    );
    return;
  }

  let updated: MutateResult;
  {
    // Public: re-validate bot-admin access and adopt the AUTHORITATIVE identity —
    // but ONLY when the link resolves to the SAME channel. A link resolving to a
    // different chatId is a different channel; updating only the URL while keeping
    // this row's chatId/title would point users at one channel while the gate
    // checks membership of another (Codex P1). Reject it instead and adopt the
    // fresh title/username when the channel matches (handles a renamed channel).
    const username = parsed.value.publicUsername ?? "";
    const result = await validateBotChannelAccess(makeApi(ctx), { kind: "PUBLIC", username });
    if (!result.ok) {
      await safeReply(ctx, await accessErrorText(result.code, false), cancelKb);
      return; // keep armed
    }
    if (result.chatId !== channel.chatId) {
      await safeReply(ctx, EDIT_DIFFERENT_CHANNEL_TEXT, cancelKb);
      return; // keep armed
    }
    const lowerUser = (result.username ?? username).toLowerCase();
    const normalizedLink = `https://t.me/${lowerUser}`;
    updated = await rebindChannelIdentity(channel.id, {
      chatId: result.chatId,
      title: result.title || channel.title,
      isPrivate: false,
      publicUsername: lowerUser,
      joinUrl: normalizedLink,
      normalizedLink,
    });
  }
  if (!updated.ok) {
    if (updated.code === "LINK_CONFLICT" || updated.code === "DUPLICATE_CHANNEL") {
      await clearForceJoinAdminState(ctx);
      await renderOverview(ctx, ALREADY_ADDED_TOAST);
      return;
    }
    await clearForceJoinAdminState(ctx);
    await renderOverview(ctx, STALE_TOAST);
    return;
  }
  await clearForceJoinAdminState(ctx);
  await renderDetail(
    ctx,
    updated.channel,
    await getMessageTemplate("force_join_channel_updated", "لینک به‌روزرسانی شد ✅"),
  );
}

forceJoinAdminTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow !== FLOW_ADD && flow !== FLOW_EDIT_LINK) {
    return next();
  }
  const admin = ctx.admin;
  if (admin === null || admin.role !== "OWNER") {
    await clearForceJoinAdminState(ctx);
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    // A command mid-flow unwinds cleanly so /start, /admin, ... still run.
    await clearForceJoinAdminState(ctx);
    return next();
  }
  if (flow === FLOW_ADD) {
    await handleAddLink(ctx, text, admin.id);
    return;
  }
  await handleEditLink(ctx, text, admin.id);
});

// A command (`/start`, `/ping`, `/paysupport`, `/admin`, …) sent while a
// force-join flow is armed unwinds that flow first, then falls through to the
// command's own handler. Registered ahead of the command composers in app.ts so
// the cleanup wins the race for the update; harmlessly passes through for every
// non-command message and every non-force-join flow.
forceJoinCommandEscapeHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow !== null && FORCE_JOIN_FLOWS.has(flow) && ctx.message.text.startsWith("/")) {
    await clearForceJoinAdminState(ctx);
  }
  return next();
});

// --- private picker response (chat_shared) — T3/T4/D1 ------------------------

forceJoinChatSharedHandler.on("message:chat_shared", async (ctx, next) => {
  const admin = ctx.admin;
  const draft = ctx.session.temp.forceJoin?.privatePick;
  if (
    ctx.session.currentFlow !== FLOW_PRIVATE_PICK ||
    admin === null ||
    admin.role !== "OWNER" ||
    draft === undefined
  ) {
    return next();
  }

  const shared = ctx.message.chat_shared;
  // T3: the shared chat is only trusted when it answers THIS armed request from
  // THIS admin, and the picker has not expired.
  if (
    shared.request_id !== draft.requestId ||
    draft.adminId !== admin.id ||
    Date.now() > draft.expiresAtMs
  ) {
    // The keyboard-removal message itself carries the outcome (T1) so the picker
    // never lingers and the user never sees a stray "cancelled".
    await clearForceJoinAdminState(ctx, EXPIRED_TEXT);
    await renderOverview(ctx);
    return;
  }

  // T4: chat_shared title/username are NOT authoritative — re-validate identity
  // + bot-admin access from the chatId before trusting it.
  const result = await validateBotChannelAccess(makeApi(ctx), {
    kind: "PRIVATE",
    chatId: BigInt(shared.chat_id),
  });
  if (!result.ok) {
    await clearForceJoinAdminState(ctx, await accessErrorText(result.code, true));
    await renderOverview(ctx);
    return;
  }

  const rebindChannelId = ctx.session.temp.forceJoin?.rebindChannelId;
  if (rebindChannelId !== undefined) {
    // Identity AND link in one write: the link comes from the draft the OWNER
    // just submitted in THIS session-bound operation, the identity from the
    // channel they just picked and the bot just re-validated. There is no path
    // that keeps the old link with a new channel, or vice versa (§4.2).
    const rebind = await rebindChannelIdentity(rebindChannelId, {
      chatId: result.chatId,
      title: result.title || "کانال خصوصی",
      isPrivate: true,
      publicUsername: null,
      joinUrl: draft.joinUrl,
      normalizedLink: draft.normalizedLink,
    });
    if (!rebind.ok) {
      await clearForceJoinAdminState(
        ctx,
        rebind.code === "DUPLICATE_CHANNEL"
          ? DUPLICATE_CHANNEL_TOAST
          : rebind.code === "LINK_CONFLICT"
            ? ALREADY_ADDED_TOAST
            : STALE_TOAST,
      );
      await renderOverview(ctx);
      return;
    }
    logger.info("force join channel rebound", { channelId: rebind.channel.id });
    await clearForceJoinAdminState(ctx, REBOUND_TOAST);
    await renderOverview(ctx);
    return;
  }

  const upsert = await createOrRebindChannel({
    chatId: result.chatId,
    title: result.title || "کانال خصوصی",
    joinUrl: draft.joinUrl,
    normalizedLink: draft.normalizedLink,
    isPrivate: true,
    publicUsername: null,
    createdByAdminId: admin.id,
  });
  if (!upsert.ok) {
    await clearForceJoinAdminState(ctx, ALREADY_ADDED_TOAST);
    await renderOverview(ctx);
    return;
  }
  logger.info("force join channel added", { channelId: upsert.channel.id, isPrivate: true });
  await clearForceJoinAdminState(ctx, await addedChannelToast(upsert));
  await renderOverview(ctx);
});
