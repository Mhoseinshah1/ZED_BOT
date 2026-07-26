import { TermsDocumentStatus, type TermsDocument } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { GENERIC_ERROR_TEXT } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { getBooleanSetting } from "../../services/settings.service.js";
import {
  createTermsDraft,
  deleteTermsDraft,
  disableTermsRequirement,
  enableTermsRequirement,
  getDraftTerms,
  getPublishedTerms,
  getTermsAcceptanceStats,
  listTermsVersionsPage,
  publishTermsDraft,
  resolveTermsDocumentByShortId,
  TERMS_MAX_BODY_LENGTH,
  TERMS_REQUIRED_KEY,
  updateTermsDraftBody,
  type TermsBodyError,
} from "../../services/terms/terms-document.service.js";
import {
  formatTermsDate,
  TELEGRAM_MESSAGE_LIMIT,
  toPersianDigits,
} from "../../services/terms/terms-views.js";
import { getButtonText } from "../../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// The «قوانین و شرایط 📜» sub-section of general settings (§8, §9).
//
// OWNER-only: every route re-checks the LIVE admin role, because button
// visibility is never authorization — a non-OWNER who kept an old keyboard, or
// whose role was revoked mid-flow, is refused at the route.
//
// This handler owns ZERO database logic; every read and mutation goes through
// terms-document.service.ts, which serializes them on the terms advisory lock.
// Callback identities are stable ASCII under `admin:terms:`; the visible Persian
// labels are all operator-editable and NEVER drive routing.
//
// Published and archived documents cannot be deleted from this UI at all: the
// only delete route targets a DRAFT, and the service filters on status too.
// =============================================================================

export const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

/** The single session flow this handler arms. Unwound by clearTermsAdminState. */
const FLOW_DRAFT_BODY = "terms:draft_body";

const TERMS_CB = {
  root: "admin:terms:root",
  enable: "admin:terms:enable",
  disable: "admin:terms:disable",
  draftNew: "admin:terms:draft_new",
  draftEdit: "admin:terms:draft_edit",
  preview: "admin:terms:preview",
  publish: "admin:terms:publish",
  publishConfirm: (sid: string): string => `admin:terms:pub_ok:${sid}`,
  draftDelete: "admin:terms:draft_del",
  draftDeleteConfirm: (sid: string): string => `admin:terms:del_ok:${sid}`,
  history: (page: number): string => `admin:terms:history:${page}`,
  stats: "admin:terms:stats",
  cancel: "admin:terms:cancel",
} as const;

// --- exact button labels (§8, §12) -------------------------------------------
// key -> byte-for-byte exact fallback label. EXPORTED so the seeding phase
// reuses the identical strings. Several words contain ZWNJ (U+200C).
export const TERMS_ADMIN_BUTTON_FALLBACKS: Record<string, string> = {
  terms_admin_enable: "فعال‌سازی تایید قوانین ✅",
  terms_admin_disable: "غیرفعال‌سازی تایید قوانین ❌",
  terms_admin_draft_new: "ایجاد پیش‌نویس جدید ➕",
  terms_admin_draft_edit: "ویرایش پیش‌نویس ✏️",
  terms_admin_preview: "پیش‌نمایش 👁",
  terms_admin_publish: "انتشار نسخه جدید 🚀",
  terms_admin_draft_delete: "حذف پیش‌نویس 🗑",
  terms_admin_history: "تاریخچه نسخه‌ها 📚",
  terms_admin_stats: "آمار پذیرش 📊",
  terms_admin_back: "بازگشت",
  terms_admin_publish_confirm: "انتشار و الزام پذیرش مجدد 🚀",
};

// --- fixed message / toast strings -------------------------------------------
const OVERVIEW_TITLE = "📜 قوانین و شرایط";
/** §7: the EXACT text required when enabling without a published version. */
const NO_PUBLISHED_TEXT = "ابتدا یک نسخه معتبر از قوانین را منتشر کنید.";
const DRAFT_PROMPT = "متن کامل قوانین را ارسال کنید:";
const CANCEL_LABEL = "انصراف";
const CANCELLED_TEXT = "لغو شد.";
const BODY_EMPTY_TEXT = "متن قوانین نمی‌تواند خالی باشد.";
const NO_DRAFT_TOAST = "پیش‌نویسی وجود ندارد.";
const DRAFT_EXISTS_TOAST = "پیش‌نویس باز وجود دارد.";
const STALE_TOAST = "درخواست منقضی شده است. دوباره تلاش کنید.";
const ENABLED_TOAST = "تایید قوانین فعال شد ✅";
const DISABLED_TOAST = "تایید قوانین غیرفعال شد ❌";
const DRAFT_SAVED_TOAST = "پیش‌نویس ذخیره شد ✅";
const DRAFT_DELETED_TOAST = "پیش‌نویس حذف شد 🗑";
const DELETE_CONFIRM_LABEL = "تایید حذف 🗑";
const PUBLISH_WARNING =
  "⚠️ با انتشار این نسخه، همه کاربران باید قوانین را دوباره تایید کنند.";
const PREVIEW_TITLE = "👁 پیش‌نمایش";
const HISTORY_TITLE = "📚 تاریخچه نسخه‌ها";
const STATS_TITLE = "📊 آمار پذیرش";

/** Characters of a document body shown in the overview / list previews. */
const PREVIEW_CHARS = 500;
const HISTORY_PAGE_SIZE = 8;
/** Fixed chrome around the two preview sections (titles, separators, newlines). */
const PREVIEW_OVERHEAD = 200;

export const termsAdminHandler = new Composer<BotContext>();
export const termsAdminTextHandler = new Composer<BotContext>();
/**
 * Runs BEFORE the command composers in app.ts so a command sent mid-flow
 * unwinds the draft flow before that command's own handler consumes the update.
 */
export const termsCommandEscapeHandler = new Composer<BotContext>();

// --- helpers -----------------------------------------------------------------

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

/**
 * Fails CLOSED. A non-admin gets no answer at all (the callback was not meant
 * for them); an admin who is not the OWNER is told plainly. Either way the route
 * body never runs — this is checked on EVERY route, including the text flow, so
 * a role revoked mid-flow stops the very next step.
 */
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

function termsButton(key: string): Promise<string> {
  return getButtonText(key, TERMS_ADMIN_BUTTON_FALLBACKS[key]);
}

/** Full terms-admin state cleanup: the flow plus its draft pointer. */
export function clearTermsAdminState(ctx: BotContext): void {
  if (ctx.session.currentFlow === FLOW_DRAFT_BODY) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.termsDraft;
}

/**
 * A bounded, control-character-free excerpt for admin screens. Operator copy is
 * rendered as PLAIN text everywhere in this section (no parse_mode), so a body
 * containing HTML or Markdown is shown literally and can never inject markup or
 * break the message.
 */
function preview(body: string, max = PREVIEW_CHARS): string {
  let cleaned = "";
  for (const ch of body) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += (code < 0x20 && ch !== "\n") || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) {
    return "—";
  }
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function shortId(document: TermsDocument): string {
  return document.id.slice(0, 8);
}

async function bodyErrorText(code: TermsBodyError): Promise<string> {
  return code === "EMPTY"
    ? BODY_EMPTY_TEXT
    : `متن قوانین طولانی‌تر از حد مجاز است (حداکثر ${toPersianDigits(TERMS_MAX_BODY_LENGTH)} نویسه).`;
}

// --- overview (§8) ------------------------------------------------------------

/**
 * Builds the overview text: enforcement state, current published version and
 * its publication date, draft state, the acceptance counts and a safe preview.
 *
 * The counts are AGGREGATES ONLY — no user id, telegram id or name appears
 * anywhere on this page, so it cannot leak who has or has not accepted.
 */
async function buildOverviewText(): Promise<string> {
  const [enabled, published, draft] = await Promise.all([
    getBooleanSetting(TERMS_REQUIRED_KEY, false),
    getPublishedTerms(),
    getDraftTerms(),
  ]);
  const stats = await getTermsAcceptanceStats(published?.id ?? null);

  const lines = [OVERVIEW_TITLE, ""];
  lines.push(`وضعیت الزام: ${enabled ? "فعال ✅" : "غیرفعال ❌"}`);

  if (published === null) {
    lines.push("نسخه منتشرشده: ندارد");
  } else {
    lines.push(`نسخه منتشرشده: ${toPersianDigits(published.version ?? 0)}`);
    if (published.publishedAt !== null) {
      lines.push(`تاریخ انتشار: ${formatTermsDate(published.publishedAt)}`);
    }
  }

  lines.push(draft === null ? "پیش‌نویس: ندارد" : "پیش‌نویس: دارد ✏️");
  lines.push("");
  lines.push(`پذیرفته‌اند: ${toPersianDigits(stats.accepted)} کاربر`);
  lines.push(`در انتظار پذیرش: ${toPersianDigits(stats.pending)} کاربر`);

  if (published !== null) {
    lines.push("", "متن فعلی:", preview(published.body));
  }
  if (draft !== null) {
    lines.push("", "متن پیش‌نویس:", preview(draft.body));
  }
  return lines.join("\n");
}

async function buildOverviewKeyboard(): Promise<InlineKeyboard> {
  const [enabled, published, draft] = await Promise.all([
    getBooleanSetting(TERMS_REQUIRED_KEY, false),
    getPublishedTerms(),
    getDraftTerms(),
  ]);
  const kb = new InlineKeyboard();

  // The master switch offers only the transition that makes sense right now.
  if (enabled) {
    kb.text(await termsButton("terms_admin_disable"), TERMS_CB.disable).row();
  } else {
    kb.text(await termsButton("terms_admin_enable"), TERMS_CB.enable).row();
  }

  if (draft === null) {
    kb.text(await termsButton("terms_admin_draft_new"), TERMS_CB.draftNew).row();
  } else {
    kb.text(await termsButton("terms_admin_draft_edit"), TERMS_CB.draftEdit).row();
    kb.text(await termsButton("terms_admin_publish"), TERMS_CB.publish).row();
    kb.text(await termsButton("terms_admin_draft_delete"), TERMS_CB.draftDelete).row();
  }

  if (published !== null || draft !== null) {
    kb.text(await termsButton("terms_admin_preview"), TERMS_CB.preview).row();
  }
  kb.text(await termsButton("terms_admin_history"), TERMS_CB.history(0)).row();
  kb.text(await termsButton("terms_admin_stats"), TERMS_CB.stats).row();
  kb.text(await termsButton("terms_admin_back"), CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

/**
 * Renders the overview. Called after EVERY mutation, so the screen an operator
 * sees is always rebuilt from live state rather than from the state the previous
 * keyboard was built with.
 */
async function renderOverview(ctx: BotContext, toast?: string): Promise<void> {
  clearTermsAdminState(ctx);
  await safeAnswerCallback(ctx, toast);
  const [text, keyboard] = await Promise.all([buildOverviewText(), buildOverviewKeyboard()]);
  await safeEditOrReply(ctx, text, keyboard);
}

termsAdminHandler.callbackQuery(TERMS_CB.root, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await renderOverview(ctx);
});

termsAdminHandler.callbackQuery(TERMS_CB.cancel, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  await renderOverview(ctx, CANCELLED_TEXT);
});

// --- master switch (§7) -------------------------------------------------------

termsAdminHandler.callbackQuery(TERMS_CB.enable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const result = await enableTermsRequirement();
  if (!result.ok) {
    // Exactly the required refusal text — enabling with nothing published would
    // gate every user behind a screen that cannot be satisfied.
    await safeAnswerCallback(ctx);
    await safeReply(ctx, NO_PUBLISHED_TEXT);
    await renderOverview(ctx);
    return;
  }
  await renderOverview(ctx, ENABLED_TOAST);
});

termsAdminHandler.callbackQuery(TERMS_CB.disable, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  // Never destructive: documents and acceptance history survive, so re-enabling
  // the same published version asks nobody to accept again.
  await disableTermsRequirement();
  await renderOverview(ctx, DISABLED_TOAST);
});

// --- draft lifecycle (§9) -----------------------------------------------------

/** Arms the body-input flow for one specific draft. */
async function startDraftFlow(ctx: BotContext, draft: TermsDocument): Promise<void> {
  ctx.session.currentFlow = FLOW_DRAFT_BODY;
  ctx.session.temp.termsDraft = { documentId: draft.id };
  await safeAnswerCallback(ctx);
  const lines = [
    DRAFT_PROMPT,
    `حداکثر ${toPersianDigits(TERMS_MAX_BODY_LENGTH)} نویسه.`,
  ];
  if (draft.body.length > 0) {
    lines.push("", "متن فعلی پیش‌نویس:", preview(draft.body));
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text(CANCEL_LABEL, TERMS_CB.cancel),
  );
}

termsAdminHandler.callbackQuery(TERMS_CB.draftNew, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  // Seeded from the current published body so the OWNER edits the real terms
  // rather than starting from an empty page.
  const result = await createTermsDraft(ctx.admin?.id ?? null);
  if (!result.ok) {
    // DRAFT_EXISTS: a concurrent tab already created one. Re-render rather than
    // creating a second competing draft.
    await renderOverview(ctx, DRAFT_EXISTS_TOAST);
    return;
  }
  await startDraftFlow(ctx, result.draft);
});

termsAdminHandler.callbackQuery(TERMS_CB.draftEdit, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const draft = await getDraftTerms();
  if (draft === null) {
    // The draft was published or deleted since this keyboard was drawn.
    await renderOverview(ctx, NO_DRAFT_TOAST);
    return;
  }
  await startDraftFlow(ctx, draft);
});

termsAdminHandler.callbackQuery(TERMS_CB.draftDelete, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const draft = await getDraftTerms();
  if (draft === null) {
    await renderOverview(ctx, NO_DRAFT_TOAST);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    ["حذف پیش‌نویس؟", "", preview(draft.body)].join("\n"),
    new InlineKeyboard()
      .text(DELETE_CONFIRM_LABEL, TERMS_CB.draftDeleteConfirm(shortId(draft)))
      .row()
      .text(CANCEL_LABEL, TERMS_CB.cancel),
  );
});

termsAdminHandler.callbackQuery(/^admin:terms:del_ok:([0-9a-f-]{4,36})$/i, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const document = await resolveTermsDocumentByShortId(ctx.match[1]);
  if (document === null) {
    await renderOverview(ctx, STALE_TOAST);
    return;
  }
  // The service filters on status: this route can NEVER delete a published or
  // archived document, even if the short id names one.
  const result = await deleteTermsDraft(document.id);
  await renderOverview(ctx, result.ok ? DRAFT_DELETED_TOAST : NO_DRAFT_TOAST);
});

// --- preview (§8) -------------------------------------------------------------

termsAdminHandler.callbackQuery(TERMS_CB.preview, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const [published, draft] = await Promise.all([getPublishedTerms(), getDraftTerms()]);
  // A new draft is SEEDED from the published body, so both are usually about the
  // same size — rendering 3,500 characters of each would break the message for
  // any document over ~2,000. Split the remaining budget between the sections
  // that are actually present.
  const sections = (published === null ? 0 : 1) + (draft === null ? 0 : 1);
  const perSection =
    sections === 0 ? 0 : Math.floor((TELEGRAM_MESSAGE_LIMIT - PREVIEW_OVERHEAD) / sections);

  const lines = [PREVIEW_TITLE];
  if (published !== null) {
    lines.push(
      "",
      `— نسخه منتشرشده ${toPersianDigits(published.version ?? 0)} —`,
      preview(published.body, perSection),
    );
  }
  if (draft !== null) {
    lines.push("", "— پیش‌نویس —", preview(draft.body, perSection));
  }
  if (published === null && draft === null) {
    lines.push("", "هیچ نسخه‌ای برای نمایش وجود ندارد.");
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text(await termsButton("terms_admin_back"), TERMS_CB.root),
  );
});

// --- publishing (§9, §10) -----------------------------------------------------

termsAdminHandler.callbackQuery(TERMS_CB.publish, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const draft = await getDraftTerms();
  if (draft === null) {
    await renderOverview(ctx, NO_DRAFT_TOAST);
    return;
  }
  const published = await getPublishedTerms();
  const currentVersion = published?.version ?? null;
  const proposed = (currentVersion ?? 0) + 1;

  const lines = [
    "انتشار نسخه جدید قوانین",
    "",
    `نسخه فعلی: ${currentVersion === null ? "ندارد" : toPersianDigits(currentVersion)}`,
    `نسخه جدید: ${toPersianDigits(proposed)}`,
    "",
    PUBLISH_WARNING,
    "",
    "متن:",
    preview(draft.body),
  ];
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard()
      // The confirmation carries the DRAFT's identity, so a stale confirmation
      // cannot publish whatever draft happens to exist when it is pressed.
      .text(await termsButton("terms_admin_publish_confirm"), TERMS_CB.publishConfirm(shortId(draft)))
      .row()
      .text(CANCEL_LABEL, TERMS_CB.cancel),
  );
});

termsAdminHandler.callbackQuery(/^admin:terms:pub_ok:([0-9a-f-]{4,36})$/i, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const document = await resolveTermsDocumentByShortId(ctx.match[1]);
  if (document === null || document.status !== TermsDocumentStatus.DRAFT) {
    // The named draft was deleted, or already published by another tab. Publish
    // NOTHING: re-render instead of falling back to "the current draft".
    await renderOverview(ctx, STALE_TOAST);
    return;
  }
  const result = await publishTermsDraft(document.id, ctx.admin?.id ?? null);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      await renderOverview(ctx, STALE_TOAST);
      return;
    }
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await bodyErrorText(result.code));
    await renderOverview(ctx);
    return;
  }
  await renderOverview(
    ctx,
    `نسخه ${toPersianDigits(result.document.version ?? 0)} منتشر شد 🚀`,
  );
});

// --- history (§8) -------------------------------------------------------------

termsAdminHandler.callbackQuery(/^admin:terms:history:(\d+)$/, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const requested = Number.parseInt(ctx.match[1], 10);
  const asked = Number.isFinite(requested) && requested > 0 ? requested : 0;
  // Clamp to the real page count BEFORE it reaches Prisma's `skip`: the callback
  // regex accepts any digit run, and an absurd page would otherwise become an
  // out-of-range offset (and render "page 100000000 of 1").
  const totalCount = (await listTermsVersionsPage(0, 1)).total;
  const lastPage = Math.max(0, Math.ceil(totalCount / HISTORY_PAGE_SIZE) - 1);
  const page = Math.min(asked, lastPage);
  // Paginated in the DATABASE: an install with hundreds of versions never loads
  // them all, and the rendered message stays inside Telegram's size limit.
  const { rows, total } = await listTermsVersionsPage(page * HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE);

  const lines = [HISTORY_TITLE, ""];
  if (total === 0) {
    lines.push("هنوز نسخه‌ای منتشر نشده است.");
  } else {
    for (const row of rows) {
      const state = row.status === TermsDocumentStatus.PUBLISHED ? "فعال ✅" : "بایگانی 📦";
      const when = row.publishedAt === null ? "—" : formatTermsDate(row.publishedAt);
      lines.push(`نسخه ${toPersianDigits(row.version ?? 0)} — ${state} — ${when}`);
    }
    const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    lines.push("", `صفحه ${toPersianDigits(page + 1)} از ${toPersianDigits(pages)}`);
  }

  const kb = new InlineKeyboard();
  const hasPrev = page > 0;
  const hasNext = (page + 1) * HISTORY_PAGE_SIZE < total;
  if (hasPrev) kb.text("صفحه قبل ⬅️", TERMS_CB.history(page - 1));
  if (hasNext) kb.text("صفحه بعد ➡️", TERMS_CB.history(page + 1));
  if (hasPrev || hasNext) kb.row();
  kb.text(await termsButton("terms_admin_back"), TERMS_CB.root);

  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
});

// --- acceptance stats (§13) ---------------------------------------------------

termsAdminHandler.callbackQuery(TERMS_CB.stats, async (ctx) => {
  if (!(await ownerGuard(ctx))) return;
  const published = await getPublishedTerms();
  const stats = await getTermsAcceptanceStats(published?.id ?? null);
  const lines = [STATS_TITLE, ""];
  lines.push(
    published === null
      ? "نسخه منتشرشده: ندارد"
      : `نسخه منتشرشده: ${toPersianDigits(published.version ?? 0)}`,
  );
  // AGGREGATES ONLY: never a user list, a telegram id or an acceptance time.
  lines.push("", `پذیرفته‌اند: ${toPersianDigits(stats.accepted)} کاربر`);
  lines.push(`در انتظار پذیرش: ${toPersianDigits(stats.pending)} کاربر`);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text(await termsButton("terms_admin_back"), TERMS_CB.root),
  );
});

// --- draft body text flow (§9) ------------------------------------------------

async function handleDraftBody(ctx: BotContext, text: string): Promise<void> {
  const draftId = ctx.session.temp.termsDraft?.documentId;
  if (draftId === undefined) {
    clearTermsAdminState(ctx);
    await safeReply(ctx, STALE_TOAST);
    return;
  }
  // The service re-checks that this row still exists AND is still a DRAFT, so a
  // body typed after the draft was published or deleted changes nothing.
  const result = await updateTermsDraftBody(draftId, text);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      clearTermsAdminState(ctx);
      await safeReply(ctx, STALE_TOAST);
      const [overviewText, keyboard] = await Promise.all([
        buildOverviewText(),
        buildOverviewKeyboard(),
      ]);
      await safeReply(ctx, overviewText, keyboard);
      return;
    }
    // Validation failure keeps the flow armed so the OWNER can simply retype.
    await safeReply(
      ctx,
      await bodyErrorText(result.code),
      new InlineKeyboard().text(CANCEL_LABEL, TERMS_CB.cancel),
    );
    return;
  }

  clearTermsAdminState(ctx);
  await safeReply(ctx, DRAFT_SAVED_TOAST);
  const [overviewText, keyboard] = await Promise.all([
    buildOverviewText(),
    buildOverviewKeyboard(),
  ]);
  await safeReply(ctx, overviewText, keyboard);
}

termsAdminTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== FLOW_DRAFT_BODY) {
    return next();
  }
  const admin = ctx.admin;
  if (admin === null || admin.role !== "OWNER") {
    // Role revoked (or never held) since the flow was armed: unwind and let the
    // message continue as an ordinary one. Nothing is written.
    clearTermsAdminState(ctx);
    return next();
  }
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    // A command mid-flow unwinds cleanly so /start, /admin, … still run.
    clearTermsAdminState(ctx);
    return next();
  }
  try {
    await handleDraftBody(ctx, text);
  } catch (err) {
    logger.error("terms draft body update failed", { error: errorMessage(err) });
    clearTermsAdminState(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
  }
});

// A command sent while the draft flow is armed unwinds that flow first, then
// falls through to the command's own handler. Registered ahead of the command
// composers in app.ts so this cleanup wins the race for the update; harmlessly
// passes through for every non-command message and every other flow.
termsCommandEscapeHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow === FLOW_DRAFT_BODY && ctx.message.text.startsWith("/")) {
    clearTermsAdminState(ctx);
  }
  return next();
});
