import {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  prisma,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { renderTemplate, renderTemplateOmitMissing } from "../utils/template.js";

// Persian fallbacks derive from the seed registry (packages/database
// seed-data.ts) - the single source of truth for default copy - and are
// used when the database is unavailable or a key is missing. The bot must
// never crash over a text.
const TEMPLATE_FALLBACKS: Record<string, string> = Object.fromEntries(
  INITIAL_MESSAGE_TEMPLATES.map((t) => [t.key, t.defaultContent]),
);

const BUTTON_FALLBACKS: Record<string, string> = Object.fromEntries(
  INITIAL_BUTTON_TEXTS.map((b) => [b.key, b.text]),
);

const CACHE_TTL_MS = 30_000;
const templateCache = new Map<string, { value: string | null; at: number }>();
const buttonCache = new Map<string, { value: string | null; at: number }>();

/** Test hook / admin-edit hook: drops the text caches. */
export function clearTextCache(): void {
  templateCache.clear();
  buttonCache.clear();
}

/** Shared content loader: DB currentContent, then fallback. Never throws. */
async function loadTemplateContent(key: string, fallback?: string): Promise<string> {
  const safeFallback = fallback ?? TEMPLATE_FALLBACKS[key] ?? key;
  const cached = templateCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? safeFallback;
  }
  try {
    const row = await prisma.messageTemplate.findUnique({ where: { key } });
    templateCache.set(key, { value: row?.currentContent ?? null, at: Date.now() });
    return row?.currentContent ?? safeFallback;
  } catch (err) {
    logger.warn("message template lookup failed, using fallback", {
      key,
      error: errorMessage(err),
    });
    return safeFallback;
  }
}

/**
 * Loads a MessageTemplate's currentContent and renders `{variable}`
 * placeholders. Falls back to the given fallback, then to the registry
 * Persian defaults. Never throws.
 */
export async function getMessageTemplate(
  key: string,
  fallback?: string,
  variables?: Record<string, string | number>,
): Promise<string> {
  const content = await loadTemplateContent(key, fallback);
  return renderTemplate(content, variables ?? {});
}

/**
 * Like getMessageTemplate, but variables passed as undefined/null/"" cleanly
 * REMOVE the lines that reference them (e.g. a missing telegram username
 * never renders an empty placeholder). Used by templates with optional
 * variables such as start_text.
 */
export async function getMessageTemplateOmitMissing(
  key: string,
  variables: Record<string, string | number | null | undefined>,
  fallback?: string,
): Promise<string> {
  const content = await loadTemplateContent(key, fallback);
  return renderTemplateOmitMissing(content, variables);
}

/**
 * Loads a ButtonText's currentText. Button texts are used verbatim (no
 * variable rendering - literal braces like "{تست}" stay intact). Never
 * throws.
 */
export async function getButtonText(key: string, fallback?: string): Promise<string> {
  const safeFallback = fallback ?? BUTTON_FALLBACKS[key] ?? key;
  const cached = buttonCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? safeFallback;
  }
  try {
    const row = await prisma.buttonText.findUnique({ where: { key } });
    buttonCache.set(key, { value: row?.currentText ?? null, at: Date.now() });
    return row?.currentText ?? safeFallback;
  } catch (err) {
    logger.warn("button text lookup failed, using fallback", { key, error: errorMessage(err) });
    return safeFallback;
  }
}
