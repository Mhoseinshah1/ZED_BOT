import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FINGERPRINT_SEPARATOR, mutationFingerprint } from "@zedbot/support-tickets";
import { describe, expect, it } from "vitest";

// =============================================================================
// SEP - the fingerprint separator is one NUL at RUNTIME and zero NULs on DISK.
//
// Those are two different requirements and both matter.
//
//   THE RUNTIME VALUE must stay exactly one U+0000. It is the field delimiter
//   inside `mutationFingerprint`, and the fingerprint is what decides whether a
//   replayed `clientRequestId` describes the same mutation. Change the
//   separator and every fingerprint already stored in MiniAppRequestIdempotency
//   stops matching: a user retrying a create after a timeout gets
//   IDEMPOTENCY_CONFLICT on a key that is genuinely theirs. Worse, a separator
//   that CAN occur in the data lets two different mutations collide onto one
//   fingerprint, and a retry then returns an outcome nobody asked for.
//
//   THE SOURCE BYTES must contain no NUL at all. Git decides binary-ness by
//   looking for a NUL near the start of a blob; one literal NUL makes it treat
//   the whole file as binary, and every diff then renders as
//   "Bin 14412 -> 15362 bytes". A reviewer loses the ability to see ANY change
//   to the file - including changes to the validation bounds and the status
//   transitions, which is most of what this file is. The escape `\u0000`
//   compiles to the identical character, so this costs nothing at runtime.
//
// The pair is asserted together on purpose: satisfying either alone is easy and
// useless. Writing the literal back gives the right runtime value and a binary
// file; switching to a printable separator gives a text file and a broken
// idempotency contract.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every domain source that has ever been tempted to hold a raw NUL. */
const DOMAIN_SOURCES = [
  "packages/support-tickets/src/contract.ts",
  "packages/support-tickets/src/tickets.ts",
  "packages/support-tickets/src/notifications.ts",
];

describe("support domain source hygiene", () => {
  // SEP-1 ---------------------------------------------------------------------
  it("SEP-1: the domain sources contain no literal NUL byte", () => {
    for (const relative of DOMAIN_SOURCES) {
      const bytes = readFileSync(path.join(repoRoot, relative));
      const at = bytes.indexOf(0x00);
      expect(
        at,
        `${relative} holds a literal NUL at byte ${at}; Git classifies the file ` +
          `as binary and stops rendering its diffs. Write the escape instead.`,
      ).toBe(-1);
    }
  });

  // SEP-2 ---------------------------------------------------------------------
  it("SEP-2: the separator is written as an escape, not as the character itself", () => {
    const source = readFileSync(
      path.join(repoRoot, "packages/support-tickets/src/contract.ts"),
      "utf8",
    );
    // `String.raw` on purpose: this needle must be the SIX characters
    //   backslash u 0 0 0 0
    // exactly as they appear in the file. An ordinary string literal would be
    // unescaped by the compiler into the very NUL character this test forbids,
    // and the assertion would then hunt for a byte that must not be there.
    expect(source).toContain(String.raw`FINGERPRINT_SEPARATOR = "\u0000"`);
  });

  // SEP-3 ---------------------------------------------------------------------
  it("SEP-3: the RUNTIME separator is still exactly one NUL character", () => {
    expect(FINGERPRINT_SEPARATOR).toHaveLength(1);
    expect(FINGERPRINT_SEPARATOR.codePointAt(0)).toBe(0);
    expect(FINGERPRINT_SEPARATOR).toBe(String.fromCharCode(0));
  });

  // SEP-4 ---------------------------------------------------------------------
  it("SEP-4: mutationFingerprint joins with that one NUL", () => {
    // The expected hash is built here from the documented encoding - fields
    // length-prefixed, joined by a single NUL - rather than by calling the
    // function twice and agreeing with itself.
    const parts = ["SUPPORT_TICKET_CREATE", "OBJECT", "BODY", "ACCOUNT", "MINIAPP"];
    const canonical = parts.map((p) => `${p.length}:${p}`).join(String.fromCharCode(0));
    expect(mutationFingerprint(parts)).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });

  // SEP-5 ---------------------------------------------------------------------
  it("SEP-5: the separator cannot be forged out of field content", () => {
    // A separator that could appear in the data would let two different
    // mutations hash alike. These field splits are distinct inputs and must
    // stay distinct.
    expect(mutationFingerprint(["a", "bc"])).not.toBe(mutationFingerprint(["ab", "c"]));
    // A value that CONTAINS the separator still cannot forge a boundary,
    // because the length prefix disagrees.
    const withSeparator = `a${String.fromCharCode(0)}b`;
    expect(mutationFingerprint([withSeparator])).not.toBe(mutationFingerprint(["a", "b"]));
  });

  // SEP-6 ---------------------------------------------------------------------
  it("SEP-6: a pinned input hashes to a pinned value", () => {
    // A golden vector. If the separator, the length prefix or the hash changes,
    // every fingerprint already stored stops matching and legitimate retries
    // start conflicting. That is a data migration, not a refactor, and this is
    // the tripwire that says so.
    expect(mutationFingerprint(["SUPPORT_TICKET_REPLY", "hello"])).toBe(
      "0bbef0f62c70ba1bd5aa3e8e9e7952bee7b57ff7d618d85b139c4b46e62a4cb1",
    );
  });
});
