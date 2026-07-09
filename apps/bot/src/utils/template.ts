/**
 * Replaces `{variable}` placeholders. Unknown variables are left unchanged so
 * literal braces in operator-edited texts never break rendering.
 */
export function renderTemplate(
  text: string,
  variables: Record<string, string | number> = {},
): string {
  return text.replace(/\{([^{}]+)\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return String(variables[name]);
    }
    return match;
  });
}
