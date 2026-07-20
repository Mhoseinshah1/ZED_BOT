import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// §5 — an AUTOMATED log-source scan. Referral code must never pass a raw entity id
// (user / order / referral / commission / telegram id or a full referral code) into
// a structured log. Non-reversible correlation tokens (`corr`), counts and statuses
// are allowed. This scans the referral sources' logger/log call sites directly.
// =============================================================================

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Files that ONLY log referral activity — every log call is scanned. */
const REFERRAL_FILES = [
  "apps/bot/src/services/referral.service.ts",
  "apps/bot/src/services/referral-commission.service.ts",
  "apps/bot/src/services/referral-execute-consumer.ts",
  "apps/bot/src/services/referral-activation.service.ts",
  "apps/bot/src/handlers/admin-settings/referral-admin.handler.ts",
  "apps/bot/src/handlers/user-referral/referral.handler.ts",
  "apps/worker/src/referral/scan.ts",
  "apps/worker/src/referral/engine.ts",
  "apps/worker/src/referral/settings.ts",
];

/** Shared files where only the referral-message log calls are scanned. */
const MIXED_FILES = [
  "apps/bot/src/services/ops-queue.service.ts",
  "apps/bot/src/services/order-fulfillment.service.ts",
  "apps/bot/src/services/provisioning.service.ts",
];

/** Forbidden key names inside a log-call argument object (raw entity ids). */
const FORBIDDEN_KEY = [
  /\buserId\s*:/,
  /\borderId\s*:/,
  /\breferrerId\s*:/,
  /\breferredUserId\s*:/,
  /\breferrerUserId\s*:/,
  /\btelegramId\s*:/,
  /\bcommissionId\s*:/,
  /\badminId\s*:/,
  /\breferralId\s*:/,
  /\breferralCode\s*:/,
  /[{,]\s*id\s*:/, // a bare `id:` object key
];

/** Extracts each logger/log.<level>(...) call's full source text (balanced parens). */
function extractLogCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /\b(?:logger|log)\.(?:info|warn|error|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the opening paren
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(m.index, i + 1));
  }
  return calls;
}

describe("referral log redaction (§5)", () => {
  let totalCalls = 0;

  for (const rel of REFERRAL_FILES) {
    it(`no raw entity ids in log calls: ${rel}`, () => {
      const src = readFileSync(`${ROOT}${rel}`, "utf8");
      const calls = extractLogCalls(src);
      totalCalls += calls.length;
      for (const call of calls) {
        for (const pat of FORBIDDEN_KEY) {
          expect(pat.test(call), `forbidden id key in ${rel}: ${call.slice(0, 120)}`).toBe(false);
        }
        expect(/\.slice\(/.test(call), `partial-id slice in a log in ${rel}: ${call.slice(0, 120)}`).toBe(false);
      }
    });
  }

  for (const rel of MIXED_FILES) {
    it(`no raw entity ids in referral log calls: ${rel}`, () => {
      const src = readFileSync(`${ROOT}${rel}`, "utf8");
      const calls = extractLogCalls(src).filter((c) => /referral/i.test(c));
      for (const call of calls) {
        for (const pat of FORBIDDEN_KEY) {
          expect(pat.test(call), `forbidden id key in ${rel}: ${call.slice(0, 120)}`).toBe(false);
        }
        expect(/\.slice\(/.test(call), `partial-id slice in a referral log in ${rel}: ${call.slice(0, 120)}`).toBe(false);
      }
    });
  }

  it("the scanner actually found log calls (not vacuously passing)", () => {
    expect(totalCalls).toBeGreaterThan(5);
  });
});
