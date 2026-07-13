import { extractTemplateVariables } from "../utils/template.js";

// =============================================================================
// Template variable registry + validation (TEXT-007). Every MessageTemplate
// row carries its explicit allowed-variable list (allowedVariables JSON,
// asserted by the seed); admin edits are validated against it so an edited
// template can never introduce unknown placeholders - and secret-shaped
// names are rejected even if a row's list were somehow corrupted to allow
// them. Rendering stays graceful (unknown placeholders render verbatim);
// validation is the EDIT-time gate.
// =============================================================================

/** Persian admin text: the edited template references an unknown variable. */
export const INVALID_TEMPLATE_VARIABLE_TEXT = "متغیر استفاده‌شده در این قالب معتبر نیست.";

/**
 * Names that must NEVER be renderable through any template, whatever a
 * row's allowed list says: credentials, session material, connection
 * strings, raw stock content and Telegram file ids.
 */
const FORBIDDEN_VARIABLE_PATTERN =
  /token|password|passwd|cookie|secret|credential|database_url|db_url|file_id|stock_content|api_key/i;

/** Parses a row's allowedVariables JSON into a validated string list. */
export function parseAllowedVariables(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

export type VariableValidation =
  | { ok: true }
  | { ok: false; invalidNames: string[]; safeMessage: string };

/**
 * Validates the `{variable}` names of an edited template content against
 * the row's explicit allowed list. Variables already present in the row's
 * defaultContent stay allowed (legacy rows seeded before the registry keep
 * working), but forbidden secret-shaped names are rejected regardless.
 */
export function validateTemplateContentVariables(
  allowedVariablesRaw: unknown,
  defaultContent: string,
  content: string,
): VariableValidation {
  const allowed = new Set([
    ...parseAllowedVariables(allowedVariablesRaw),
    ...extractTemplateVariables(defaultContent),
  ]);
  const invalidNames = extractTemplateVariables(content).filter(
    (name) => !allowed.has(name) || FORBIDDEN_VARIABLE_PATTERN.test(name),
  );
  if (invalidNames.length > 0) {
    return { ok: false, invalidNames, safeMessage: INVALID_TEMPLATE_VARIABLE_TEXT };
  }
  return { ok: true };
}
