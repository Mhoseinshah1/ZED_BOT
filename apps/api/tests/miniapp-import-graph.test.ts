// =============================================================================
// §4 of miniapp-commerce-parity, enforced mechanically (IG-1..IG-4).
//
// The API and the bot share ONE commerce authority: the API imports the bot's
// transport-independent service modules. What keeps that from quietly turning
// the API into a second Telegram process is this test — it walks the RUNTIME
// import graph of apps/api/src (through @zedbot/bot subpath imports, into the
// bot's sources) and fails if anything Telegram-shaped appears:
//
//   IG-1  no `grammy` value-import anywhere in the reachable graph;
//   IG-2  no module under apps/bot/src/handlers/ or /keyboards/, and no
//         *-views.ts module (Telegram message rendering);
//   IG-3  no import of the @zedbot/bot package root (whose index boots the
//         whole bot);
//   IG-4  the graph reaches the shared money core (checkout + discount +
//         pricing) — so this test cannot silently pass by the commerce
//         surface having been unplugged.
//
// Type-only imports are ignored: with `isolatedModules` (and no
// `verbatimModuleSyntax`) TypeScript elides them from the emitted JS, so they
// are not runtime edges.
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, "../src");
const BOT_SRC = path.resolve(HERE, "../../bot/src");

interface Edge {
  from: string;
  specifier: string;
}

/** Value-import specifiers of one TypeScript module (type-only elided). */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // import ... from "x" | export ... from "x" | import "x" | import("x")
  const pattern =
    /(?:^|\n)\s*(import|export)\s+([^;]*?)from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[2];
    const specifier = match[3] ?? match[4] ?? match[5];
    if (specifier === undefined) {
      continue;
    }
    if (clause !== undefined) {
      const trimmed = clause.trim();
      if (trimmed.startsWith("type ") || trimmed.startsWith("type{")) {
        continue; // `import type { X } from` — fully elided
      }
      const braces = trimmed.match(/\{([^}]*)\}/);
      if (braces !== null) {
        const bindings = braces[1]
          .split(",")
          .map((b) => b.trim())
          .filter((b) => b !== "");
        const hasDefaultOrNamespace = /^[^{]*\w/.test(trimmed.split("{")[0] ?? "");
        if (
          !hasDefaultOrNamespace &&
          bindings.length > 0 &&
          bindings.every((b) => b.startsWith("type "))
        ) {
          continue; // `import { type X, type Y } from` — fully elided too
        }
      }
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function resolveBotSubpath(specifier: string): string | null {
  const subpath = specifier.replace(/^@zedbot\/bot\//, "").replace(/\.js$/, "");
  const candidate = path.join(BOT_SRC, `${subpath}.ts`);
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface GraphWalk {
  visited: Set<string>;
  grammyEdges: Edge[];
  botRootEdges: Edge[];
  telegramModuleEdges: Edge[];
}

function walkGraph(): GraphWalk {
  const roots = listFiles(API_SRC);
  const visited = new Set<string>();
  const queue = [...roots];
  const walk: GraphWalk = {
    visited,
    grammyEdges: [],
    botRootEdges: [],
    telegramModuleEdges: [],
  };
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of valueImportSpecifiers(source)) {
      if (specifier === "grammy" || specifier.startsWith("grammy/")) {
        walk.grammyEdges.push({ from: file, specifier });
        continue;
      }
      if (specifier === "@zedbot/bot" || specifier === "@zedbot/bot/index") {
        walk.botRootEdges.push({ from: file, specifier });
        continue;
      }
      let resolved: string | null = null;
      if (specifier.startsWith(".")) {
        resolved = resolveRelative(file, specifier);
      } else if (specifier.startsWith("@zedbot/bot/")) {
        resolved = resolveBotSubpath(specifier);
        expect(resolved, `unresolvable bot subpath ${specifier} from ${file}`).not.toBeNull();
      }
      if (resolved === null) {
        continue; // external package — grammy is the only forbidden one
      }
      const normalized = resolved.split(path.sep).join("/");
      if (
        normalized.includes("/apps/bot/src/handlers/") ||
        normalized.includes("/apps/bot/src/keyboards/") ||
        /-views\.ts$/.test(normalized)
      ) {
        walk.telegramModuleEdges.push({ from: file, specifier });
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return walk;
}

describe("miniapp API runtime import graph (§4, IG-1..IG-4)", () => {
  const walk = walkGraph();

  it("IG-1 never value-imports grammy anywhere in the reachable graph", () => {
    expect(
      walk.grammyEdges.map((e) => `${path.relative(process.cwd(), e.from)} -> ${e.specifier}`),
    ).toEqual([]);
  });

  it("IG-2 never reaches a bot handler, keyboard or *-views module", () => {
    expect(
      walk.telegramModuleEdges.map(
        (e) => `${path.relative(process.cwd(), e.from)} -> ${e.specifier}`,
      ),
    ).toEqual([]);
  });

  it("IG-3 never imports the @zedbot/bot package root", () => {
    expect(
      walk.botRootEdges.map((e) => `${path.relative(process.cwd(), e.from)} -> ${e.specifier}`),
    ).toEqual([]);
  });

  it("IG-4 actually reaches the shared money core (the test has teeth)", () => {
    const reached = [...walk.visited].map((f) => f.split(path.sep).join("/"));
    for (const expected of [
      "/apps/bot/src/services/checkout.service.ts",
      "/apps/bot/src/services/discount.service.ts",
      "/apps/bot/src/services/representative-pricing.service.ts",
      "/apps/bot/src/services/service-username-selection.service.ts",
    ]) {
      expect(
        reached.some((f) => f.endsWith(expected)),
        `expected the API graph to reach ${expected}`,
      ).toBe(true);
    }
  });
});
