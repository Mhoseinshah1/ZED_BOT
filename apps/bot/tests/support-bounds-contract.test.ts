import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  TICKET_MESSAGE_MAX,
  TICKET_MESSAGE_MIN,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
} from "@zedbot/support-tickets";
import { describe, expect, it } from "vitest";

import * as botService from "../src/services/support-ticket.service.js";

// =============================================================================
// S2 — one set of ticket bounds, for every surface.
//
// A user who typed a 3000-character message in the bot must be able to type one
// in the Mini App. That is only true while exactly ONE place decides what 3000
// is; the moment a second surface writes the number down, the two agree until
// someone edits one of them, and nothing fails when they stop agreeing.
//
// So this asserts the shape of the codebase, not just the values: the domain
// package is the only file allowed to DECLARE a bound, and every other surface
// must import it. That check binds surfaces that do not exist yet — whoever
// builds the Mini App composer has to source the numbers rather than retype
// them, because retyping them fails here.
// =============================================================================

const REPO = join(import.meta.dirname, "..", "..", "..");
const CONTRACT = join(REPO, "packages", "support-tickets", "src", "contract.ts");

const BOUND_NAMES = [
  "TICKET_SUBJECT_MIN",
  "TICKET_SUBJECT_MAX",
  "TICKET_MESSAGE_MIN",
  "TICKET_MESSAGE_MAX",
] as const;

/** Every source file under `dir`, excluding build output and dependencies. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === "build") {
        continue;
      }
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe("support bounds — one declaration, every surface", () => {
  // S2-1 ----------------------------------------------------------------------
  it("S2-1: the bot re-exports the domain's bounds rather than its own", () => {
    // Identity, not equality: two constants that happen to both be 100 today
    // are exactly the drift this exists to catch.
    expect(botService.TICKET_SUBJECT_MIN).toBe(TICKET_SUBJECT_MIN);
    expect(botService.TICKET_SUBJECT_MAX).toBe(TICKET_SUBJECT_MAX);
    expect(botService.TICKET_MESSAGE_MIN).toBe(TICKET_MESSAGE_MIN);
    expect(botService.TICKET_MESSAGE_MAX).toBe(TICKET_MESSAGE_MAX);

    const source = readFileSync(
      join(REPO, "apps", "bot", "src", "services", "support-ticket.service.ts"),
      "utf8",
    );
    expect(source, "the bot's constants come from the package").toMatch(
      /export\s*\{[^}]*TICKET_SUBJECT_MIN[^}]*\}\s*from\s*"@zedbot\/support-tickets"/s,
    );
  });

  // S2-2 ----------------------------------------------------------------------
  it("S2-2: exactly one file in the repository DECLARES a bound", () => {
    const roots = [
      join(REPO, "apps", "bot", "src"),
      join(REPO, "apps", "api", "src"),
      join(REPO, "apps", "miniapp", "src"),
      join(REPO, "apps", "worker", "src"),
      join(REPO, "packages"),
    ];
    // `const NAME = <number>` / `NAME: <number> =` — a declaration, as opposed
    // to an import, a re-export or a use.
    const declaration = new RegExp(
      `(?:const|let|var)\\s+(${BOUND_NAMES.join("|")})\\b[^\\n=]*=\\s*-?\\d`,
    );

    const declarers = roots
      .flatMap(sources)
      .filter((file) => declaration.test(readFileSync(file, "utf8")));

    expect(declarers, "only the domain contract may declare bounds").toEqual([CONTRACT]);
  });

  // S2-3 ----------------------------------------------------------------------
  it("S2-3: the bounds are the values both surfaces were built against", () => {
    // Pinned deliberately. Widening a bound is a product decision that changes
    // what the database accepts and what every composer must allow, so it
    // should require editing a test that says so — not just one number.
    expect(TICKET_SUBJECT_MIN).toBe(3);
    expect(TICKET_SUBJECT_MAX).toBe(100);
    expect(TICKET_MESSAGE_MIN).toBe(1);
    expect(TICKET_MESSAGE_MAX).toBe(3000);
  });

  // S2-4 ----------------------------------------------------------------------
  it("S2-4: the bounds are coherent — a min below its max, both positive", () => {
    expect(TICKET_SUBJECT_MIN).toBeGreaterThan(0);
    expect(TICKET_MESSAGE_MIN).toBeGreaterThan(0);
    expect(TICKET_SUBJECT_MIN).toBeLessThan(TICKET_SUBJECT_MAX);
    expect(TICKET_MESSAGE_MIN).toBeLessThan(TICKET_MESSAGE_MAX);
  });
});
