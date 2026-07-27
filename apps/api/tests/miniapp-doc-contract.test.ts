import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// =============================================================================
// F1 — the documentation is part of the contract.
//
// Design documents rot in a specific, dangerous way: the code changes, the
// prose does not, and the prose is what the next person reads before they touch
// anything. This branch produced a live example. The Mini App gained a real
// Force Join membership check, five recent services instead of three, service
// counts on /me and a set of bot-return actions — and the design document went
// on saying the API "must not talk to the Bot API", that an armed gate simply
// returns FORCE_JOIN_REQUIRED, that /me returns only a profile and that the
// dashboard carries three services. A reader trusting it would have "fixed"
// working code to match.
//
// So the claims below are asserted the same way any other contract is. Each one
// either names a fact the document MUST state, or a stale claim it must NOT.
// Where the fact also lives in code, the test reads BOTH and compares, so the
// document cannot drift away from the implementation silently.
//
// Deliberately NOT tested: prose style, section ordering, or the presence of
// any particular sentence. A test that pins wording makes a document
// unmaintainable and gets deleted; these pin MEANING.
// =============================================================================

const REPO = join(process.cwd(), "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO, relative), "utf8");
}

/**
 * One comparable view of a document or a comment block.
 *
 * Three things would otherwise make a true statement look absent:
 *
 *   - LINE WRAPPING. A claim split across two lines matches no phrase regex.
 *   - COMMENT PREFIXES. `//`, `#`, and jsdoc's ` * ` continuation. The `*` rule
 *     is deliberately narrow: `**bold**` at the start of a Markdown line also
 *     begins with `*`, and eating one of them turned "Both are **database**
 *     freshness" into something no plain-prose regex could find.
 *   - MARKUP. Emphasis and code ticks are formatting choices. A test that pins
 *     `**` or a backtick breaks the moment someone reflows a sentence, and
 *     meaning is the contract here — typography is not.
 */
function flatten(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/|#|\*(?!\*))\s?/, ""))
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ");
}

const DESIGN = flatten(read("docs/telegram-miniapp-foundation.md"));
const FORCE_JOIN = flatten(read("docs/mandatory-channel-membership.md"));

const ACCESS_POLICY = read("apps/api/src/miniapp/access-policy.ts");
const ROUTES = read("apps/api/src/miniapp/routes.ts");
const SWEEP = read("apps/worker/src/log-delivery-sweep.ts");
const SCREENS = read("apps/miniapp/src/screens.tsx");
const COMPONENTS = read("apps/miniapp/src/components.tsx");

describe("documentation contract", () => {
  // F1-1 --------------------------------------------------------------------
  it("F1-1: the document never claims the API cannot check membership", () => {
    // The exact class of sentence that was wrong. Any of these would send a
    // reader to delete `httpForceJoinMembershipApi` as a mistake.
    const forbidden = [
      /API must not talk to the Bot API/i,
      /API (?:must not|cannot|can ?not|does not|never)(?: ever)? (?:talk|call|reach|contact)[^.]{0,40}(?:Bot API|Telegram)/i,
      /(?:cannot|can ?not|unable to) establish (?:current )?(?:channel )?membership/i,
      /no way (?:for the API )?to (?:verify|check|establish) membership/i,
    ];
    for (const pattern of forbidden) {
      expect(DESIGN, `stale claim still present: ${pattern}`).not.toMatch(pattern);
    }

    // The positive fact too: silence would satisfy the assertions above.
    expect(DESIGN).toMatch(/live getChatMember/i);
  });

  // F1-2 --------------------------------------------------------------------
  it("F1-2: the documented Force Join decision matrix matches the code", () => {
    // Every outcome the gate can actually reach must appear in the document.
    const documented = {
      allowed: /member of every active required channel \| allowed/i,
      denied: /not a member of some active required channel \| FORCE_JOIN_REQUIRED/i,
      bypass: /bypass[^|]*\| allowed/i,
      unavailable: /\| ACCESS_CHECK_UNAVAILABLE/i,
      unverifiable: /every active channel permanently unverifiable \| allowed/i,
      zeroChannels: /zero active channels \| allowed/i,
    };
    for (const [name, pattern] of Object.entries(documented)) {
      expect(DESIGN, `undocumented Force Join outcome: ${name}`).toMatch(pattern);
    }

    // Cross-checked against the implementation rather than trusted from prose.
    expect(ACCESS_POLICY).toMatch(/evaluateForceJoinMembership/);
    expect(ACCESS_POLICY).toMatch(/ACCESS_CHECK_UNAVAILABLE/);
    expect(ACCESS_POLICY).toMatch(/FORCE_JOIN_REQUIRED/);

    // And the old unconditional-denial description must be gone.
    expect(DESIGN).not.toMatch(/an armed gate returns FORCE_JOIN_REQUIRED/i);
    expect(DESIGN).not.toMatch(/force.?join is the one gate the API cannot clear/i);

    // What is shared vs. injected — the reason two processes can agree at all.
    expect(DESIGN).toMatch(/@zedbot\/force-join/);
    expect(DESIGN).toMatch(/injected per process/i);
    expect(DESIGN).toMatch(/ctx\.api in the bot/i);

    // Redis is a cache, not the authority; the frontend is never believed.
    expect(DESIGN).toMatch(/Redis is a bounded cache, not the authority/i);
    expect(DESIGN).toMatch(/Nothing the frontend says is consulted/i);
  });

  // F1-3 --------------------------------------------------------------------
  it("F1-3: /me is documented as the profile PLUS service counts", () => {
    expect(DESIGN).toMatch(/GET \/me[^|]*\|[^|]*services: \{ active, total \}/i);
    // The endpoint table must not still describe a profile-only response.
    expect(DESIGN).not.toMatch(/\| GET \| \/me \| The signed-in user's profile\. \|/);

    // The route really returns both counts.
    expect(ROUTES).toMatch(/services: \{ active, total \}/);
  });

  // F1-4 --------------------------------------------------------------------
  it("F1-4: the dashboard is documented as five recent services, and the code agrees", () => {
    expect(DESIGN).not.toMatch(/3 recent services/i);
    expect(DESIGN).not.toMatch(/three recent services/i);

    // Read the real limit out of the source and require the document to state
    // that number, so bumping the constant fails here rather than in review.
    const limit = /DASHBOARD_SERVICE_COUNT\s*=\s*(\d+)/.exec(ROUTES);
    expect(limit, "DASHBOARD_SERVICE_COUNT not found").not.toBeNull();
    expect(limit?.[1]).toBe("5");
    expect(DESIGN).toMatch(new RegExp(`${limit?.[1]} recent services`, "i"));
  });

  // F1-5 --------------------------------------------------------------------
  it("F1-5: both dashboard timestamps are documented, and distinguished", () => {
    expect(DESIGN).toMatch(/serverTimestamp/);
    expect(DESIGN).toMatch(/dataFreshnessTimestamp/);
    // Not merely named — the rule that makes the second one safe to rely on.
    expect(DESIGN).toMatch(/oldest updatedAt/i);
    // And the limit of what either one can claim.
    expect(DESIGN).toMatch(/database freshness/i);

    expect(ROUTES).toMatch(/serverTimestamp/);
    expect(ROUTES).toMatch(/dataFreshnessTimestamp/);
  });

  // F1-6 --------------------------------------------------------------------
  it("F1-6: service-summary fields are documented", () => {
    for (const field of [/location/i, /remainingDays/, /lastSyncedAt/]) {
      expect(DESIGN, `undocumented summary field: ${field}`).toMatch(field);
    }
    // All three remainingDays cases, because "0" is ambiguous without them.
    expect(DESIGN).toMatch(/never expires[^|]*\| null/i);
    expect(DESIGN).toMatch(/already expired[^|]*\| 0/i);
    expect(DESIGN).toMatch(/in the future[^|]*\| rounded up/i);
  });

  // F1-7 --------------------------------------------------------------------
  it("F1-7: bot-return actions are documented, including what they must not do", () => {
    expect(DESIGN).toMatch(/opens the bot|opens the configured bot/i);
    // The two constraints that keep them honest.
    expect(DESIGN).toMatch(/VITE_BOT_USERNAME/);
    expect(DESIGN).toMatch(/no \?start= payload/i);

    // Every action the component offers must be described. The keys are read
    // from the source, so a new action cannot be shipped undocumented.
    const order = /BOT_ACTION_ORDER[^=]*=\s*\[([^\]]*)\]/s.exec(COMPONENTS);
    expect(order, "BOT_ACTION_ORDER not found").not.toBeNull();
    const keys = [...(order?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);

    const described: Record<string, RegExp> = {
      buy: /buying/i,
      charge: /charging the wallet/i,
      renew: /renewing or managing a service/i,
      support: /contacting support/i,
    };
    for (const key of keys) {
      expect(described[key], `bot action "${key}" has no documented description`).toBeDefined();
      expect(DESIGN, `bot action "${key}" is not documented`).toMatch(described[key]);
    }
  });

  // F1-8 --------------------------------------------------------------------
  it("F1-8: Telegram delivery is documented as at-least-once, with the duplicate stated", () => {
    // Pinned to the GUARANTEE TABLE ROW, not to the phrase appearing anywhere.
    // Mutation testing found that gap: weakening the row to "best effort" while
    // an explanatory paragraph further down still said "at-least-once" left a
    // loose `/at-least-once/` assertion perfectly happy. The row is the
    // load-bearing statement, so the row is what is asserted.
    expect(FORCE_JOIN).toMatch(/Telegram send \| At-least-once/i);

    // The window itself, not just the label — a reader has to know WHEN a
    // duplicate happens before they can judge whether it matters.
    expect(FORCE_JOIN).toMatch(
      /after Telegram accepted the message but before the SENT status commits/i,
    );

    // The three weaker-to-stronger guarantees stay distinguished, each pinned
    // to its own row for the same reason.
    expect(FORCE_JOIN).toMatch(/Durable record \| One per committed retirement/i);
    expect(FORCE_JOIN).toMatch(/Job creation \| Idempotent/i);
    expect(FORCE_JOIN).toMatch(/Terminal deliveries \| Never intentionally retried/i);
    // And the sweep's stale-SENDING rule, read from the source so a changed
    // threshold cannot leave the document quietly wrong.
    const stale = /LOG_DELIVERY_SENDING_STALE_MS\s*=\s*(\d+)\s*\*\s*60_000/.exec(SWEEP);
    expect(stale, "LOG_DELIVERY_SENDING_STALE_MS not found").not.toBeNull();
    expect(FORCE_JOIN).toMatch(new RegExp(`${stale?.[1]} minutes`, "i"));
    expect(FORCE_JOIN).toMatch(/updatedAt/);
  });

  // F1-9 --------------------------------------------------------------------
  it("F1-9: nothing claims exactly-once Telegram delivery", () => {
    // Scoped to the delivery documents and the sweep. A blanket repository grep
    // would match unrelated and CORRECT uses — payment settlement really is
    // exactly-once, and the analytics timestamp really is stamped exactly once.
    for (const [name, text] of [
      ["force-join doc", FORCE_JOIN],
      ["design doc", DESIGN],
      ["sweep source", flatten(SWEEP)],
    ] as const) {
      const hits = [...text.matchAll(/exactly[- ]once/gi)].map((h) => h[0]);
      expect(hits, `${name} mentions exactly-once delivery`).toEqual([]);
    }
  });

  // F1-10 -------------------------------------------------------------------
  it("F1-10: source comments do not contradict the shipped UI", () => {
    const screens = flatten(SCREENS);
    // The screens really do render bot-return actions...
    expect(SCREENS).toMatch(/<BotActions/);
    // ...so a comment calling sign-out the only action is false.
    expect(screens).not.toMatch(/the only action in the whole app is signing out/i);
    expect(screens).not.toMatch(/leaving the user hunting for a button that does not exist/i);
    // The read-only claim itself is still true and must stay: no write path
    // exists anywhere in this app.
    expect(screens).toMatch(/read-only/i);
    expect(SCREENS).not.toMatch(/method:\s*"POST"/);
  });
});
