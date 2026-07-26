import type { TermsDocument } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { getButtonText, getMessageTemplate } from "../text.service.js";
import { termsAcceptCallback } from "./terms-callbacks.js";

// =============================================================================
// Versioned mandatory terms: the USER-FACING screen (§5).
//
// The screen always renders the exact PUBLISHED body together with its version,
// and its accept button always carries THAT document's identity — the two are
// built from a single document object here, so a screen showing version N with
// a button for version M is unrepresentable.
//
// The body is rendered as PLAIN TEXT (no parse_mode). Operator copy therefore
// cannot inject entities, links or formatting, and no escaping step can be
// forgotten later.
// =============================================================================

export const TERMS_TITLE_FALLBACK = "📜 قوانین و شرایط استفاده";
export const TERMS_ACCEPT_BUTTON_FALLBACK = "قوانین را می‌پذیرم ✅";
export const TERMS_ACCEPTED_TOAST_FALLBACK = "قوانین تایید شد ✅";
export const TERMS_STALE_TEXT_FALLBACK =
  "نسخه جدیدی از قوانین منتشر شده است. لطفاً نسخه جدید را مطالعه و تایید کنید.";
export const TERMS_UNAVAILABLE_TEXT_FALLBACK =
  "متن قوانین در دسترس نیست. لطفاً بعداً دوباره تلاش کنید.";

/** Persian-digit rendering of a version number, e.g. 3 -> "۳". */
export function toPersianDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/** Persian short date; falls back to the ISO date slice if Intl data is absent. */
export function formatTermsDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Telegram's hard cap on a text message. The BODY is capped at 3,500, but the
 * title is an operator-editable template with its own (much larger) limit, and
 * an upgraded install can carry a legacy body right up to the template limit —
 * so the composed screen must be bounded here rather than assumed safe.
 *
 * Exceeding it is not a cosmetic bug: sendMessage returns 400, safeReply
 * swallows it, and the gate still blocks — leaving the user unable to proceed
 * AND unable to see why, on every update, forever.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Hard bound on the operator-editable title, so the DECORATION can never crowd
 * out the thing being accepted. 4096 − 3500 (the body limit) leaves 596 for the
 * title, the version line, the date line and the separators; 400 keeps a
 * comfortable margin, which is why a conforming body always renders in full.
 *
 * The title is clamped rather than the body because the title is presentation
 * an operator chose, while the body is the legal text acceptance is recorded
 * against — see the invariant below.
 */
export const TERMS_TITLE_MAX_LENGTH = 400;

export interface TermsScreen {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Builds the terms screen for ONE document: title, version line, optional
 * publication date, the full body, and the accept button bound to this exact
 * document.
 */
export async function buildTermsScreen(document: TermsDocument): Promise<TermsScreen> {
  const [rawTitle, acceptLabel] = await Promise.all([
    getMessageTemplate("terms_page_title", TERMS_TITLE_FALLBACK),
    getButtonText("terms_accept", TERMS_ACCEPT_BUTTON_FALLBACK),
  ]);

  // Clamp the DECORATION, never the text being accepted (see below).
  const title = rawTitle.slice(0, TERMS_TITLE_MAX_LENGTH);
  const lines = [title, ""];
  if (document.version !== null) {
    lines.push(`نسخه: ${toPersianDigits(document.version)}`);
  }
  if (document.publishedAt !== null) {
    lines.push(`تاریخ انتشار: ${formatTermsDate(document.publishedAt)}`);
  }
  const header = lines.join("\n");

  // THE invariant (§4): a user may accept only the exact body that was rendered
  // with the button. Truncating the body for display while still offering the
  // accept button would record acceptance of clauses the user never saw, so an
  // over-long body loses the BUTTON rather than losing its text. Clamping the
  // title above means a conforming body (≤ 3,500) always fits, so this only
  // triggers for a legacy body that migration 20260727130000 repairs.
  if (header.length + 2 + document.body.length > TELEGRAM_MESSAGE_LIMIT) {
    return {
      text: await getMessageTemplate("terms_unavailable_text", TERMS_UNAVAILABLE_TEXT_FALLBACK),
      keyboard: new InlineKeyboard(),
    };
  }

  return {
    text: `${header}\n\n${document.body}`,
    keyboard: new InlineKeyboard().text(acceptLabel, termsAcceptCallback(document.id)),
  };
}
