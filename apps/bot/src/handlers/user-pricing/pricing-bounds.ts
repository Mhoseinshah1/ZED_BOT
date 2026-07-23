// =============================================================================
// Telegram message-budget helpers for the public retail Pricing Catalog
// (fix/pricing-catalog-post-merge-safety). The generic MessageTemplate editor
// permits ~4000 characters, which is NOT the rendering limit: a Pricing page
// composes several editable templates + dynamic content into ONE Telegram
// payload, and different sinks have different limits (a normal message ≈ 4096
// characters; an answerCallbackQuery toast is far smaller). These pure helpers
// bound each editable value to a per-sink budget so no valid operator edit can
// ever push a Pricing message past its real sink limit. Operator edits stay
// stored verbatim — only their RENDERED use is bounded.
//
// Truncation is code-point safe (a surrogate pair is never split) and, for HTML
// sinks, escape-aware (an HTML entity is never cut in half): the raw template is
// bounded and escaped code point by code point, so the escaped result is valid.
// A single ellipsis is appended when truncation occurs.
// =============================================================================

import { escapeHtml } from "../../utils/html.js";

/** The real Telegram text-message limit (UTF-16 code units). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Conservative per-page budgets (room for static + dynamic content). */
export const PRICING_ROOT_SAFE_LIMIT = 3900;
export const PRICING_DETAIL_SAFE_LIMIT = 3900;
export const PRICING_EMPTY_SAFE_LIMIT = 3900;
/** answerCallbackQuery notification text is far smaller than a message. */
export const CALLBACK_TOAST_SAFE_LIMIT = 180;

const ELLIPSIS = "…";

/**
 * Bounds plain text to at most `limit` UTF-16 code units without ever splitting
 * a surrogate pair; appends one ellipsis when truncated. For sinks that are NOT
 * HTML-parsed (plain messages, toast text).
 */
export function boundPlainText(raw: string, limit: number): string {
  const text = raw.trim();
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return limit === 1 ? ELLIPSIS : "";
  }
  const target = limit - 1; // reserve one unit for the ellipsis
  let out = "";
  for (const ch of text) {
    // `for..of` iterates whole code points, so `ch` is never half a surrogate.
    if (out.length + ch.length > target) {
      break;
    }
    out += ch;
  }
  return out + ELLIPSIS;
}

/**
 * HTML-safe bounded insertion: bounds the RAW template, escapes it, and keeps the
 * ESCAPED result at most `limit` UTF-16 code units. Because it escapes code point
 * by code point it can never cut an HTML entity (`&...;`), a tag, or a surrogate
 * pair. Returns the ESCAPED string (ready to embed inside an HTML message).
 */
export function boundHtmlText(raw: string, limit: number): string {
  const text = raw.trim();
  const full = escapeHtml(text);
  if (full.length <= limit) {
    return full;
  }
  if (limit <= 1) {
    return "";
  }
  const target = limit - 1; // reserve one unit for the ellipsis
  let out = "";
  for (const ch of text) {
    const piece = escapeHtml(ch); // a whole code point escapes to a whole entity
    if (out.length + piece.length > target) {
      break;
    }
    out += piece;
  }
  return out + ELLIPSIS;
}

/**
 * Callback-query toast text (plain, small limit). An empty/blank template falls
 * back to `fallback`; the result is always within the toast limit.
 */
export function boundToast(
  raw: string,
  fallback: string,
  limit: number = CALLBACK_TOAST_SAFE_LIMIT,
): string {
  const text = raw.trim();
  return boundPlainText(text === "" ? fallback : text, limit);
}

/** Final verification that a completed payload is within a sink limit. */
export function withinTelegramLimit(text: string, limit: number = TELEGRAM_TEXT_LIMIT): boolean {
  return text.length <= limit;
}
