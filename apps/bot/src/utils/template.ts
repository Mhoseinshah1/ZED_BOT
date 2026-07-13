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

/**
 * Variable names present in a template (`{name}` placeholders, trimmed).
 * Duplicates are collapsed; literal brace pairs with nested braces never
 * match (same pattern as renderTemplate).
 */
export function extractTemplateVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    names.add(match[1].trim());
  }
  return [...names];
}

/**
 * renderTemplate + clean omission of missing OPTIONAL values: a variable
 * passed as undefined/null/"" removes every LINE that references it, so an
 * absent username (or note, discount, ...) never renders as an empty
 * placeholder or a dangling label. Defined values substitute normally and
 * unknown placeholders stay verbatim (operator-owned braces).
 */
export function renderTemplateOmitMissing(
  text: string,
  variables: Record<string, string | number | null | undefined>,
): string {
  const defined: Record<string, string | number> = {};
  const missing = new Set<string>();
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined || value === null || value === "") {
      missing.add(name);
    } else {
      defined[name] = value;
    }
  }
  const kept = text.split("\n").filter((line) => {
    for (const match of line.matchAll(/\{([^{}]+)\}/g)) {
      if (missing.has(match[1].trim())) {
        return false;
      }
    }
    return true;
  });
  // Collapse the blank runs left behind by removed lines (never >1 empty).
  const collapsed: string[] = [];
  for (const line of kept) {
    if (line.trim() === "" && collapsed.at(-1)?.trim() === "") {
      continue;
    }
    collapsed.push(line);
  }
  while (collapsed.at(-1)?.trim() === "") {
    collapsed.pop();
  }
  return renderTemplate(collapsed.join("\n"), defined);
}
