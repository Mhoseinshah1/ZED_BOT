import {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  prisma,
} from "@zedbot/database";
import {
  NTF_ACTION_BUTTON_KEY,
  notificationCallbackData,
  renderTemplate,
  type NotificationButtonSpec,
  type NotificationPayloadSnapshot,
} from "@zedbot/shared";

import type { InlineKeyboardMarkup } from "../telegram.js";

// =============================================================================
// Delivery-side rendering (feat/notification-retention-engine, Phase 1). Turns
// the SAFE payload snapshot produced by the scan (a MessageTemplate key +
// allowlisted display variables + eligible button specs) into the exact text +
// inline keyboard the worker sends. The snapshot never carries a secret, so the
// rendered message can never leak one. Template/button content is read live
// from the DB (operator edits apply without a redeploy) with the seed registry
// as the offline fallback - the SAME renderTemplate the bot uses, so a
// worker-sent message is byte-identical to the bot rendering the same key.
// =============================================================================

const TEMPLATE_FALLBACKS: Record<string, string> = Object.fromEntries(
  INITIAL_MESSAGE_TEMPLATES.map((t) => [t.key, t.defaultContent]),
);
const BUTTON_FALLBACKS: Record<string, string> = Object.fromEntries(
  INITIAL_BUTTON_TEXTS.map((b) => [b.key, b.text]),
);

const CACHE_TTL_MS = 30_000;
const templateCache = new Map<string, { value: string | null; at: number }>();
const buttonCache = new Map<string, { value: string | null; at: number }>();

/** Test hook: drops the render caches. */
export function clearRenderCache(): void {
  templateCache.clear();
  buttonCache.clear();
}

async function loadTemplateContent(key: string): Promise<string> {
  const fallback = TEMPLATE_FALLBACKS[key] ?? key;
  const cached = templateCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? fallback;
  }
  const row = await prisma.messageTemplate.findUnique({ where: { key } });
  templateCache.set(key, { value: row?.currentContent ?? null, at: Date.now() });
  return row?.currentContent ?? fallback;
}

async function loadButtonText(key: string): Promise<string> {
  const fallback = BUTTON_FALLBACKS[key] ?? key;
  const cached = buttonCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? fallback;
  }
  const row = await prisma.buttonText.findUnique({ where: { key } });
  buttonCache.set(key, { value: row?.currentText ?? null, at: Date.now() });
  return row?.currentText ?? fallback;
}

export interface RenderedNotification {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/** Builds the inline keyboard for a notification's button specs (one per row,
 * so long Persian labels never crowd). callback_data = ntf:<shortId>:<action>. */
async function buildKeyboard(
  shortId: string,
  buttons: NotificationButtonSpec[],
): Promise<InlineKeyboardMarkup | undefined> {
  if (buttons.length === 0) {
    return undefined;
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const spec of buttons) {
    // The button label comes from the spec's own key when present, else the
    // canonical key for its action code (defense against a stale snapshot).
    const key = spec.buttonTextKey || NTF_ACTION_BUTTON_KEY[spec.action] || "";
    const label = key === "" ? "" : await loadButtonText(key);
    if (label.trim() === "") {
      continue;
    }
    rows.push([{ text: label, callback_data: notificationCallbackData(shortId, spec.action) }]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/**
 * Renders a notification's snapshot into the message text + inline keyboard.
 * `shortId` (the notification id prefix) is baked into every button's callback
 * data - the bot re-resolves it owner-scoped and re-validates capability on
 * click, so a snapshot never grants an action the user is not entitled to.
 */
export async function renderNotification(
  snapshot: NotificationPayloadSnapshot,
  shortId: string,
): Promise<RenderedNotification> {
  const content = await loadTemplateContent(snapshot.templateKey);
  const text = renderTemplate(content, snapshot.variables);
  const replyMarkup = await buildKeyboard(shortId, snapshot.buttons);
  return { text, replyMarkup };
}
