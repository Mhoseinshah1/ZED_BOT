import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SUPPORT_FAILURE_CODES,
  supportFailureCode,
  supportFailureLog,
} from "../src/miniapp/support-errors.js";

// =============================================================================
// SL — nothing a Support Center route logs can identify a person or a ticket.
//
// The failure this replaces was `errorMessage(err)`. That returns whatever the
// thrower put in `.message`, and on these routes the thrower is Prisma, whose
// messages render the failing operation: the SQL, the model and column names,
// the constraint, the connection host — and, for the errors that matter most,
// the offending VALUE. On this surface a value is a ticket subject, a ticket
// body, a service username or a database uuid.
//
// "It only goes to the server log" is not a defence. Logs are tailed in
// terminals, shipped to aggregators, screenshotted into chats and pasted into
// issues. The redaction has to happen before the string is built, not after.
//
// So these tests assert on the PAYLOAD rather than on the route: the payload is
// where the decision is made, and SL-6 proves the routes cannot bypass it.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every `logger.*(...)` call in a source file, argument list included.
 *
 * Counts parentheses rather than matching up to the first `)`, because a
 * regex that stops early would read `logger.error("x", { id: f() })` as
 * `logger.error("x", { id: f()` and could miss what follows.
 */
function extractLogCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /logger\.(?:error|warn|info|debug)\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let quote = "";
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i += 1) {
      const c = source[i];
      // Brackets inside a string are text, not structure: a message reading
      // "rejected (expired)" would otherwise close the call early.
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(match.index, i + 1));
  }
  return calls;
}

/**
 * The arguments after the message literal, or "" when the call has none.
 *
 * The message literal is excluded on purpose: it is a constant the author
 * wrote, so words inside it ("mini app initData rejected") say nothing about
 * what is logged. Only the arguments carry values.
 */
function payloadOf(call: string): string {
  const open = call.indexOf("(");
  let depth = 0;
  let quote = "";
  for (let i = open; i < call.length; i += 1) {
    const c = call[i];
    // A comma inside the message ("rejected, retrying") is not the argument
    // separator, so strings are skipped here for the same reason as above.
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 1) {
      // String literals inside the payload are constants the author wrote —
      // `supportFailureLog("service-list", err)` names an operation, it does
      // not log a service. Only identifiers can carry a value.
      return call.slice(i + 1, -1).replace(/"[^"]*"|'[^']*'/g, '""');
    }
  }
  return "";
}

/**
 * Bindings that hold a person's data on these routes. A log payload naming one
 * of them is logging the thing the whole feature exists to contain, whether or
 * not an error is involved.
 */
const SENSITIVE_BINDINGS = /\b(body|subject|text|ticket|service|payload|initData|telegramId)\b/;

/** Realistic secrets, of the four kinds that must never appear in a log. */
const TICKET_SUBJECT = "قطع شدن اتصال از دیشب";
const TICKET_BODY = "کاربر عزیز رمز من 1234 است و ایمیلم user@example.com";
const SERVICE_USERNAME = "zed_user_01";
const TICKET_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CONNECTION_STRING = "postgresql://zedbot:s3cr3t@db.internal:5432/zedbot";

/** A Prisma-shaped error with a code, a chatty message and revealing meta. */
function prismaError(code: string): Error & { code: string; meta: unknown; clientVersion: string } {
  const err = new Error(
    `Invalid \`prisma.supportTicket.create()\` invocation:\n` +
      `Unique constraint failed on the fields: (\`subject\`)\n` +
      `  subject: "${TICKET_SUBJECT}"\n` +
      `  body: "${TICKET_BODY}"\n` +
      `  id: "${TICKET_UUID}"\n` +
      `  datasource: "${CONNECTION_STRING}"`,
  ) as Error & { code: string; meta: unknown; clientVersion: string };
  err.code = code;
  err.meta = { target: ["subject", "userId"], service: SERVICE_USERNAME, value: TICKET_BODY };
  err.clientVersion = "6.19.3";
  return err;
}

/** Everything the payload must never contain, whatever the error looked like. */
const FORBIDDEN: Array<[string, string]> = [
  ["a ticket subject", TICKET_SUBJECT],
  ["a ticket body", TICKET_BODY],
  ["a service username", SERVICE_USERNAME],
  ["a database uuid", TICKET_UUID],
  ["a connection string", CONNECTION_STRING],
  ["the SQL/model text", "prisma.supportTicket.create"],
  ["constraint column names", "Unique constraint failed"],
  ["a stack frame", "at Object."],
];

describe("mini app support failure logging", () => {
  // SL-1 ----------------------------------------------------------------------
  it("SL-1: the payload carries none of the error's text, meta or stack", () => {
    for (const code of ["P2002", "P1001", "P2024", "P2025", "P9999"]) {
      const serialized = JSON.stringify(supportFailureLog("create", prismaError(code)));
      for (const [what, secret] of FORBIDDEN) {
        expect(serialized, `${code} leaked ${what}`).not.toContain(secret);
      }
      // Not even the word "message" — there is no field for one.
      expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(
        ["code", "operation", "prismaCode"].sort(),
      );
    }
  });

  // SL-2 ----------------------------------------------------------------------
  it("SL-2: a raw Error's message never survives, however it is shaped", () => {
    const hostile = [
      new Error(TICKET_BODY),
      new Error(`connect ECONNREFUSED ${CONNECTION_STRING}`),
      Object.assign(new Error("boom"), { cause: new Error(TICKET_SUBJECT) }),
      // A thrown string, a thrown object, and the two nullish cases: a
      // classifier that only handles Error is a classifier that throws inside a
      // catch block and turns a 503 into an unhandled rejection.
      TICKET_UUID,
      { message: TICKET_BODY, stack: "at Object.<anonymous>" },
      null,
      undefined,
    ];
    for (const err of hostile) {
      const serialized = JSON.stringify(supportFailureLog("read", err));
      for (const [what, secret] of FORBIDDEN) {
        expect(serialized, `leaked ${what}`).not.toContain(secret);
      }
    }
  });

  // SL-3 ----------------------------------------------------------------------
  it("SL-3: every code comes from the closed set, for every input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "",
      0,
      [],
      new Error("x"),
      prismaError("P2002"),
      prismaError("P1001"),
      { code: 42 },
      { code: "not-a-prisma-code" },
      // A getter that throws is a real shape: some proxies and ORMs lazily
      // build `.message`. The classifier must not be the thing that explodes.
      Object.defineProperty({}, "code", {
        get() {
          throw new Error("nope");
        },
      }),
    ];
    for (const input of inputs) {
      let code: string;
      try {
        code = supportFailureCode(input);
      } catch {
        code = "THREW";
      }
      expect(SUPPORT_FAILURE_CODES as readonly string[], String(code)).toContain(code);
    }
  });

  // SL-4 ----------------------------------------------------------------------
  it("SL-4: the classes an operator responds to differently are distinguished", () => {
    // The point of classifying at all: these four demand different actions.
    expect(supportFailureCode(prismaError("P1001"))).toBe("db-unreachable");
    expect(supportFailureCode(prismaError("P2024"))).toBe("db-timeout");
    expect(supportFailureCode(prismaError("P2002"))).toBe("db-conflict");
    expect(supportFailureCode(prismaError("P2034"))).toBe("db-conflict");
    expect(supportFailureCode(prismaError("P2025"))).toBe("db-rejected");
    expect(supportFailureCode(prismaError("P7777"))).toBe("db-error");
    expect(supportFailureCode(new Error("something else"))).toBe("unexpected");
    // Driver-level serialization failures arrive as an SQLSTATE, not a Pxxxx.
    expect(supportFailureCode({ code: "40001" })).toBe("db-conflict");
    expect(supportFailureCode({ code: "40P01" })).toBe("db-conflict");
    expect(supportFailureCode({ code: "57014" })).toBe("db-timeout");
  });

  // SL-5 ----------------------------------------------------------------------
  it("SL-5: the Prisma code is the bare identifier and nothing more", () => {
    const payload = supportFailureLog("reply", prismaError("P2002"));
    expect(payload.prismaCode).toBe("P2002");
    // A non-Prisma failure has no such field rather than a placeholder that
    // would have to be filtered downstream.
    expect(supportFailureLog("reply", new Error("x"))).toEqual({
      operation: "reply",
      code: "unexpected",
    });
  });

  // SL-6 ----------------------------------------------------------------------
  it.each([
    "apps/api/src/miniapp/support-routes.ts",
    // routes.ts is on this list because the Support Center's Service picker is
    // fed by its `/services` route. A ticket flow that stops leaking ticket
    // text but still leaks the service metadata one screen earlier has not
    // stopped leaking; the auth, profile, dashboard and wallet handlers in the
    // same file carry the same kinds of value.
    "apps/api/src/miniapp/routes.ts",
  ])("SL-6: %s logs through the classifier and nothing else", (relative) => {
    // The payload can be perfect and still be bypassed by one `logger.error`
    // that formats its own object. This is the assertion that keeps the whole
    // surface honest, so it is made against the source rather than a mock.
    const source = readFileSync(path.join(repoRoot, relative), "utf8");
    const logCalls = extractLogCalls(source);
    expect(logCalls.length, "the routes must still log failures at all").toBeGreaterThan(0);

    let classified = 0;
    for (const call of logCalls) {
      // The rule is about the caught error, because the error is the value
      // that renders arbitrary row content. A call that names `err` at all
      // must hand it to the classifier rather than to the log.
      if (/\berr\b/.test(call)) {
        expect(call, `unclassified error in: ${call}`).toContain("supportFailureLog(");
        classified += 1;
      }
      // Separately: nothing on this surface may log a person's data directly,
      // error or not. `{ reason: validated.reason }` survives because `reason`
      // is a closed union of 13 constants, not because it is in a log call.
      expect(payloadOf(call), `sensitive binding in: ${call}`).not.toMatch(SENSITIVE_BINDINGS);
    }
    expect(classified, "these routes must log at least one classified failure").toBeGreaterThan(0);

    // `errorMessage` is the specific function that produced the leak. Its
    // absence from this file is the regression guard.
    expect(source).not.toContain("errorMessage");
    // And no ad-hoc interpolation of the error into a message string.
    expect(source).not.toMatch(/logger\.\w+\([^)]*\$\{err/);
  });
});
