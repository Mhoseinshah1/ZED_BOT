// =============================================================================
// Classifying a Support Center failure into something safe to write down.
//
// THE PROBLEM WITH LOGGING THE ERROR. `errorMessage(err)` returns whatever the
// thrower put in `.message`, and on these routes the thrower is usually Prisma.
// A Prisma error message is not a summary — it is a rendering of the failing
// operation. Depending on the error it can contain the SQL, the model and
// column names, the constraint that was violated, the connection string's host
// and database, and the offending VALUE. On this surface those values are a
// ticket subject, a ticket body, a service username or a database uuid: the
// four things this whole feature was built to keep out of anywhere they could
// be read by someone who is not the ticket's owner.
//
// A log is not private. It is tailed in a terminal, shipped to an aggregator,
// screenshotted into a chat and pasted into an issue. "It only goes to the
// server log" is the same argument that puts customer data in every incident
// channel eventually.
//
// SO NOTHING FROM THE ERROR IS COPIED. Not the message, not `meta` (which
// carries `target`: the columns of a violated constraint, and for some drivers
// the value that violated it), not the stack, not the cause chain. What is
// logged is a code from a CLOSED SET defined below, plus — for a Prisma known
// error — the bare `Pxxxx` identifier, which is a fixed enum from Prisma's own
// documentation and cannot vary with the data.
//
// THAT IS STILL ENOUGH TO OPERATE ON. The codes distinguish the four failures
// an operator actually responds to differently: the database is unreachable,
// the pool is exhausted or a statement timed out, two writers collided, or
// something unanticipated happened. "Which row" is not an operational question
// on a route that already tells the client nothing; it is answerable from the
// database's own logs, which live inside the trust boundary the ticket text
// does.
//
// USED BY THE WHOLE MINI APP SURFACE, not only the ticket routes. The Support
// Center's Service picker is served by `/services` in routes.ts, so a ticket
// flow that stops leaking ticket text but leaks the service metadata one screen
// earlier has not stopped leaking; the auth, profile, dashboard and wallet
// handlers next to it carry values of the same kinds.
// =============================================================================

/**
 * Every code this module can produce. A closed set on purpose: a log field
 * whose values are unbounded is a log field that can carry anything.
 */
export const SUPPORT_FAILURE_CODES = [
  /** The database could not be reached at all — wrong host, down, refused. */
  "db-unreachable",
  /** A connection could not be obtained in time, or a statement timed out. */
  "db-timeout",
  /** Two writers collided: unique violation, deadlock, serialization failure. */
  "db-conflict",
  /** The database refused the write on its own terms (constraint, missing row). */
  "db-rejected",
  /** Prisma failed for some other reason it has a code for. */
  "db-error",
  /** Anything else. Deliberately last, and deliberately uninformative. */
  "unexpected",
] as const;

export type SupportFailureCode = (typeof SUPPORT_FAILURE_CODES)[number];

/**
 * Read `.code` off an unknown thrown value without ever throwing.
 *
 * The try/catch is not defensive padding. `.code` can be an accessor — proxies,
 * lazily-hydrated ORM errors and instrumentation wrappers all define one — and an
 * accessor can throw. This function runs INSIDE a catch block, on a path whose
 * whole job is to turn a failure into a 503. If it threw, the original error
 * would be replaced by a second one from the error handler itself, the response
 * would become an unhandled rejection instead of a 503, and the real cause would
 * be lost. Nothing read here is ever logged; only its shape is inspected.
 */
function rawCode(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  try {
    return (err as { code?: unknown }).code;
  } catch {
    return undefined;
  }
}

/**
 * A Prisma error code, if this looks like one.
 *
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`. The API and
 * the domain package can end up holding different copies of the Prisma client
 * — different `node_modules` resolutions, a bundled build, a test that mocks the
 * module — and `instanceof` across two copies is false even for the same error.
 * A shape check cannot lie about that, and the pattern is strict enough that a
 * user-controlled string cannot masquerade as one: `Pxxxx`, exactly.
 */
function prismaCode(err: unknown): string | null {
  const code = rawCode(err);
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : null;
}

/**
 * Prisma initialization/connection failures — the database is not there.
 *
 * P1000 authentication failed, P1001 cannot reach the server, P1002 the server
 * was reached but timed out, P1003 the database does not exist, P1010 access
 * denied, P1017 the server closed the connection.
 */
const UNREACHABLE = new Set(["P1000", "P1001", "P1003", "P1010", "P1011", "P1012", "P1017"]);

/** Waiting, not failing: pool exhaustion and statement timeouts. */
const TIMEOUT = new Set(["P1002", "P1008", "P2024"]);

/**
 * Concurrency. P2002 unique violation, P2034 write conflict / deadlock.
 *
 * Worth its own code because it is the ONLY class here that is usually benign:
 * the domain retries or replays, and a burst of these means contention rather
 * than breakage.
 */
const CONFLICT = new Set(["P2002", "P2034"]);

/** The database applied its own rules: FK, required relation, absent row. */
const REJECTED = new Set(["P2003", "P2004", "P2011", "P2014", "P2025"]);

/**
 * A safe code for a failure on a Support Center route.
 *
 * Total: every input maps to one of `SUPPORT_FAILURE_CODES`, including `null`,
 * a string, and an object whose getters throw. Nothing derived from the error's
 * text ever escapes.
 */
export function supportFailureCode(err: unknown): SupportFailureCode {
  const code = prismaCode(err);
  if (code === null) {
    // Not a Prisma error. Serialization failures raised by the driver can
    // surface as a plain error carrying an SQLSTATE, so those two are matched
    // on the STATE — a five-character code from the SQL standard, never data.
    const state = sqlState(err);
    if (state === "40001" || state === "40P01") return "db-conflict";
    if (state === "57014") return "db-timeout";
    return "unexpected";
  }
  if (UNREACHABLE.has(code)) return "db-unreachable";
  if (TIMEOUT.has(code)) return "db-timeout";
  if (CONFLICT.has(code)) return "db-conflict";
  if (REJECTED.has(code)) return "db-rejected";
  return "db-error";
}

/** The driver's SQLSTATE, when one is attached. Five characters, or null. */
function sqlState(err: unknown): string | null {
  const state = rawCode(err);
  return typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) ? state : null;
}

/**
 * The structured fields to log for a Support Center failure.
 *
 * The ONLY place these routes build a log payload, so "what may be logged" is
 * decided once. `prismaCode` is included when present because it is a fixed
 * identifier — `P2002` says "unique violation" and nothing about which row.
 */
export function supportFailureLog(
  operation: string,
  err: unknown,
): { operation: string; code: SupportFailureCode; prismaCode?: string } {
  const code = supportFailureCode(err);
  const prisma = prismaCode(err);
  return prisma === null ? { operation, code } : { operation, code, prismaCode: prisma };
}
