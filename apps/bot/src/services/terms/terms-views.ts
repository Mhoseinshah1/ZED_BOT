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
  const [title, acceptLabel] = await Promise.all([
    getMessageTemplate("terms_page_title", TERMS_TITLE_FALLBACK),
    getButtonText("terms_accept", TERMS_ACCEPT_BUTTON_FALLBACK),
  ]);

  const lines = [title, ""];
  if (document.version !== null) {
    lines.push(`نسخه: ${toPersianDigits(document.version)}`);
  }
  if (document.publishedAt !== null) {
    lines.push(`تاریخ انتشار: ${formatTermsDate(document.publishedAt)}`);
  }
  lines.push("", document.body);

  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text(acceptLabel, termsAcceptCallback(document.id)),
  };
}
