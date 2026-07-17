import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// Final production audit locks - whole-bot static analysis so the navigation
// tree can never silently rot:
//   1. every callback a keyboard can emit has a registered handler
//      (no dead buttons anywhere, user or admin);
//   2. every registered exact-string route is emitted somewhere
//      (no orphan routes);
//   3. every rendered page passes a keyboard (no dead-end pages);
//   4. every callback stays under Telegram's 64-byte limit (worst case);
//   5. every admin route runs behind adminAuthMiddleware.
// No database, no Telegram - pure source analysis.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const srcRoot = path.join(repoRoot, "apps/bot/src");

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith(".ts")) {
        files.push(p);
      }
    }
  };
  walk(srcRoot);
  return files;
}

const NS = "(?:user|admin|common|terms|force_join|cinput)";

/** IDENT: "literal" callback-constant map defined in one file. */
function literalConsts(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(`([A-Za-z0-9_]+):\\s*"(${NS}:[a-z0-9_:.]+)"`, "g");
  for (const match of src.matchAll(re)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function regexLiteralPrefix(source: string): string {
  const stripped = source.replace(/^\^/, "");
  const cut = stripped.search(/[([\\$?+*]/);
  return cut === -1 ? stripped : stripped.slice(0, cut);
}

describe("navigation integrity (production audit)", () => {
  const files = sourceFiles();
  const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  const cbConsts = literalConsts(sources.get(path.join(srcRoot, "core/callbacks.ts")) ?? "");

  // Emitted callback shapes: template-literal prefixes and string literals.
  const emitted = new Map<string, string>();
  for (const [file, src] of sources) {
    const templateRe = new RegExp("`(" + NS + ":[a-z0-9_:.]*?)\\$\\{", "g");
    for (const match of src.matchAll(templateRe)) {
      emitted.set(match[1], file);
    }
    const literalRe = new RegExp('"(' + NS + ":[a-z0-9_:.]+)\"", "g");
    for (const match of src.matchAll(literalRe)) {
      emitted.set(match[1], file);
    }
  }

  // Registered handlers: regex routes, string routes, constant references
  // resolved via the same-file callback map or the core CB map.
  const regexes: string[] = [];
  const strings = new Set<string>();
  for (const [, src] of sources) {
    for (const match of src.matchAll(/callbackQuery\(\s*\/(.+?)\/[,)]/g)) {
      regexes.push(match[1]);
    }
    for (const match of src.matchAll(/callbackQuery\(\s*"([^"]+)"/g)) {
      strings.add(match[1]);
    }
    const local = literalConsts(src);
    for (const match of src.matchAll(
      /callbackQuery\(\s*(\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)/g,
    )) {
      for (const part of match[1].replace(/[[\]\s]/g, "").split(",")) {
        if (part.startsWith('"')) {
          strings.add(part.replaceAll('"', ""));
          continue;
        }
        if (part.startsWith("/")) {
          continue;
        }
        const prop = part.split(".")[1];
        const value = part.startsWith("CB.")
          ? cbConsts.get(prop)
          : (local.get(prop) ?? cbConsts.get(prop));
        if (value !== undefined) {
          strings.add(value);
        }
      }
    }
  }
  const regexPrefixes = regexes.map(regexLiteralPrefix);

  it("every emitted button callback has a registered handler (no dead buttons)", () => {
    expect(emitted.size).toBeGreaterThan(250); // the tree really was scanned
    expect(regexes.length).toBeGreaterThan(150);
    const dead: string[] = [];
    for (const [prefix, file] of emitted) {
      const matched =
        strings.has(prefix) ||
        regexPrefixes.some((rp) => rp.startsWith(prefix) || prefix.startsWith(rp));
      if (!matched) {
        dead.push(`${prefix} (${path.relative(srcRoot, file)})`);
      }
    }
    expect(dead, `dead buttons:\n${dead.join("\n")}`).toEqual([]);
  });

  it("every registered string route is reachable from some keyboard (no orphans)", () => {
    const emittedKeys = [...emitted.keys()];
    const orphans = [...strings].filter(
      (s) => !emittedKeys.some((e) => e === s || e.startsWith(s) || s.startsWith(e)),
    );
    expect(orphans, `orphan routes:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("every rendered page carries a keyboard (no dead-end pages)", () => {
    const argCount = (call: string): number => {
      let depth = 0;
      let args = 1;
      for (const ch of call) {
        if ("([{".includes(ch)) depth += 1;
        else if (")]}".includes(ch)) depth -= 1;
        else if (ch === "," && depth === 1) args += 1;
      }
      return args;
    };
    const bad: string[] = [];
    for (const [file, src] of sources) {
      for (const match of src.matchAll(/safeEditOrReply\(/g)) {
        const start = (match.index ?? 0) + match[0].length - 1;
        let depth = 0;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "(") depth += 1;
          else if (src[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              if (argCount(src.slice(start, i + 1)) < 3) {
                const line = src.slice(0, match.index).split("\n").length;
                bad.push(`${path.relative(srcRoot, file)}:${line}`);
              }
              break;
            }
          }
        }
      }
    }
    expect(bad, `keyboard-less pages:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every emitted callback stays under Telegram's 64-byte limit (worst case)", () => {
    // Template prefixes get a pessimistic suffix: 8-char short id + ":x:9999".
    const over = [...emitted.keys()].filter((p) => {
      const worst = p.endsWith(":") ? p.length + 8 + 7 : p.length;
      return worst >= 64;
    });
    expect(over, `over-length callbacks:\n${over.join("\n")}`).toEqual([]);
  });

  it("all admin routes run behind adminAuthMiddleware", () => {
    const app = sources.get(path.join(srcRoot, "app.ts")) ?? "";
    expect(app).toContain("adminArea.use(adminAuthMiddleware())");
    expect(app).toMatch(/callbackQuery\(\/\^admin:\/, adminArea\.middleware\(\)\)/);
    // Every admin handler composer is mounted INSIDE the gated area (between
    // the middleware registration and the /admin command binding).
    const gated = app.slice(
      app.indexOf("adminArea.use(adminAuthMiddleware())"),
      app.indexOf('bot.command("admin"'),
    );
    for (const composer of [
      "adminHandler",
      "panelHandler",
      "productHandler",
      "receiptsHandler",
      "adminUsersHandler",
      "adminFinanceHandler",
      "financialReportsHandler",
      "manualOrdersHandler",
      "stockHandler",
      "adminSupportHandler",
      "adminBroadcastHandler",
      "adminTextSettingsHandler",
      "reportsBackupHandler",
      "adminPlaceholdersHandler",
    ]) {
      expect(gated, `${composer} must be admin-gated`).toContain(`adminArea.use(${composer})`);
    }
  });
});
