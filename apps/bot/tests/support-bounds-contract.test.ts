import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "@zedbot/database";
import {
  createTicket,
  replyToTicket,
  TICKET_MESSAGE_MAX,
  TICKET_MESSAGE_MIN,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
} from "@zedbot/support-tickets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as botService from "../src/services/support-ticket.service.js";

process.env.APP_SECRET ??= "support-bounds-contract-secret";

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

// =============================================================================
// The bounds agreeing is necessary but not sufficient: two surfaces can hold
// the same numbers and still disagree about what they MEAN. Measuring before
// trimming rather than after, using > rather than >=, treating a whitespace-only
// subject as present — each keeps the constants identical and still produces a
// message one surface accepts and the other refuses.
//
// So the agreement is asserted on OUTCOMES, at every boundary, through both
// real entry points. Against a real database, because that is where a value
// that passes validation and then violates a column constraint would show up.
// =============================================================================

const RUN = `s2-${process.pid}-${Date.now()}`;
const users: string[] = [];

async function makeUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(Date.now()) * 1000n + BigInt(users.length + 500),
      firstName: "bounds",
    },
  });
  users.push(user.id);
  return user.id;
}

let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `bnd${RUN.replace(/[^A-Za-z0-9]/g, "")}${requestSeq}`.slice(0, 64).padEnd(16, "0");
}

/** Did the BOT accept this subject? */
async function botAcceptsSubject(userId: string, subject: string): Promise<boolean> {
  const outcome = await botService.createSupportTicket({
    userId,
    subject,
    content: { text: "متن معتبر" },
  });
  return outcome.ok;
}

/** Did the DOMAIN accept this subject? */
async function domainAcceptsSubject(userId: string, subject: string): Promise<boolean> {
  const outcome = await createTicket(userId, {
    subject,
    message: "متن معتبر",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: requestId(),
  });
  return outcome.ok;
}

async function botAcceptsMessage(userId: string, text: string): Promise<boolean> {
  const made = await botService.createSupportTicket({
    userId,
    subject: "موضوع معتبر",
    content: { text: "متن اولیه" },
  });
  if (!made.ok) return false;
  const reply = await botService.addUserTicketReply(userId, {
    ticketId: made.ticket.id,
    content: { text },
  });
  return reply.ok;
}

async function domainAcceptsMessage(userId: string, text: string): Promise<boolean> {
  const made = await createTicket(userId, {
    subject: "موضوع معتبر",
    message: "متن اولیه",
    category: "ACCOUNT",
    origin: "MINIAPP",
    servicePublicId: null,
    clientRequestId: requestId(),
  });
  if (!made.ok) return false;
  const reply = await replyToTicket(userId, {
    ticketPublicId: made.value.ticket.id.slice(0, 8),
    message: text,
    clientRequestId: requestId(),
  });
  return reply.ok;
}

describe("support bounds — the two surfaces accept the same input", () => {
  beforeAll(async () => {
    // Nothing to set up beyond users, created per case so one case's tickets
    // cannot make another's counts ambiguous.
  });

  afterAll(async () => {
    if (users.length === 0) return;
    await prisma.miniAppRequestIdempotency.deleteMany({ where: { userId: { in: users } } });
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: { in: users } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);
    if (ids.length > 0) {
      await prisma.supportMessage.deleteMany({ where: { ticketId: { in: ids } } });
      await prisma.supportTicket.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  // S2-5 ----------------------------------------------------------------------
  it("S2-5: subject boundaries — both surfaces draw the line in the same place", async () => {
    const cases: { label: string; subject: string; accepted: boolean }[] = [
      { label: "one below min", subject: "x".repeat(TICKET_SUBJECT_MIN - 1), accepted: false },
      { label: "exactly min", subject: "x".repeat(TICKET_SUBJECT_MIN), accepted: true },
      { label: "exactly max", subject: "x".repeat(TICKET_SUBJECT_MAX), accepted: true },
      { label: "one above max", subject: "x".repeat(TICKET_SUBJECT_MAX + 1), accepted: false },
    ];
    for (const c of cases) {
      const [bot, domain] = [await makeUser(), await makeUser()];
      const botOk = await botAcceptsSubject(bot, c.subject);
      const domainOk = await domainAcceptsSubject(domain, c.subject);
      expect(botOk, `bot / ${c.label}`).toBe(c.accepted);
      expect(domainOk, `domain / ${c.label}`).toBe(c.accepted);
    }
  });

  // S2-6 ----------------------------------------------------------------------
  it("S2-6: message boundaries — both surfaces draw the line in the same place", async () => {
    const cases: { label: string; text: string; accepted: boolean }[] = [
      { label: "empty", text: "", accepted: false },
      { label: "exactly min", text: "y".repeat(TICKET_MESSAGE_MIN), accepted: true },
      { label: "exactly max", text: "y".repeat(TICKET_MESSAGE_MAX), accepted: true },
      { label: "one above max", text: "y".repeat(TICKET_MESSAGE_MAX + 1), accepted: false },
    ];
    for (const c of cases) {
      const [bot, domain] = [await makeUser(), await makeUser()];
      expect(await botAcceptsMessage(bot, c.text), `bot / ${c.label}`).toBe(c.accepted);
      expect(await domainAcceptsMessage(domain, c.text), `domain / ${c.label}`).toBe(c.accepted);
    }
  });

  // S2-7 ----------------------------------------------------------------------
  it("S2-7: both TRIM before measuring, so padding never buys length", async () => {
    // A subject of nothing but spaces is not a subject on either surface, and
    // a subject that only reaches the minimum once its padding is counted is
    // not long enough on either.
    const padded = ` ${"x".repeat(TICKET_SUBJECT_MIN - 1)} `;
    const blank = " ".repeat(TICKET_SUBJECT_MAX);
    for (const subject of [padded, blank]) {
      const [bot, domain] = [await makeUser(), await makeUser()];
      expect(await botAcceptsSubject(bot, subject), "bot refuses").toBe(false);
      expect(await domainAcceptsSubject(domain, subject), "domain refuses").toBe(false);
    }

    // Padded past the maximum but exactly max once trimmed: BOTH must accept.
    // The failure mode is one surface measuring the untrimmed string.
    const overByPadding = `${"x".repeat(TICKET_SUBJECT_MAX)}   `;
    const [bot, domain] = [await makeUser(), await makeUser()];
    expect(await botAcceptsSubject(bot, overByPadding), "bot accepts trimmed-to-max").toBe(true);
    expect(await domainAcceptsSubject(domain, overByPadding), "domain accepts trimmed-to-max").toBe(
      true,
    );

    // And what they STORE is the trimmed value on both. Agreeing about
    // acceptance while storing different strings is still drift: an operator
    // searching for a subject finds it on one surface and not the other.
    const [botStored, domainStored] = await Promise.all([
      prisma.supportTicket.findFirstOrThrow({ where: { userId: bot } }),
      prisma.supportTicket.findFirstOrThrow({ where: { userId: domain } }),
    ]);
    expect(botStored.subject).toBe("x".repeat(TICKET_SUBJECT_MAX));
    expect(domainStored.subject).toBe(botStored.subject);
  });

  // S2-8 ----------------------------------------------------------------------
  it("S2-8: a message at the maximum survives the round trip to the database", async () => {
    // Validation agreeing is not the same as the column accepting: a bound
    // raised past what the schema stores would pass every check above and then
    // throw on write.
    const user = await makeUser();
    const text = "ز".repeat(TICKET_MESSAGE_MAX);
    const made = await createTicket(user, {
      subject: "پیام حداکثری",
      message: text,
      category: "ACCOUNT",
      origin: "MINIAPP",
      servicePublicId: null,
      clientRequestId: requestId(),
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const stored = await prisma.supportMessage.findUniqueOrThrow({
      where: { id: made.value.messageId },
    });
    expect(stored.text, "stored verbatim, not truncated").toBe(text);
  });
});
