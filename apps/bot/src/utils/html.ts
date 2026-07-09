/**
 * Escapes a dynamic value for embedding in Telegram HTML-parse-mode text.
 * Panel names, URLs and setting values may contain <, >, & or quotes that
 * would otherwise break parsing or inject formatting.
 */
export function escapeHtml(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
